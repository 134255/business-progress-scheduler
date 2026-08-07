const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudTemplateRepository } = require('../lib/cloud-template-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

function createRepositoryHarness(seed = {}) {
  const fake = createFakeCloudDatabase(seed)
  let sequence = 0
  const repository = createCloudTemplateRepository({
    db: fake.db,
    idFactory: prefix => `${prefix}-${++sequence}`
  })
  return { fake, repository }
}

function node(overrides = {}) {
  return {
    nodeKey: 'node-a',
    sequence: 0,
    name: '启动',
    description: '',
    assigneeUserIds: ['account-1'],
    slaWorkHours: 8,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [],
    ...overrides
  }
}

test('creation atomically writes metadata, nodes, server dates, and one audit record', async () => {
  const { fake, repository } = createRepositoryHarness()
  const result = await repository.createTemplateDefinition({
    actor: { _id: 'admin-1' },
    definition: {
      template: {
        name: '交付模板', description: '', status: 'draft', nodeCount: 2,
        createdBy: 'admin-1', createdAt: new Date(0), updatedBy: 'admin-1', updatedAt: new Date(0)
      },
      nodes: [node({ nodeKey: 'node-b', sequence: 1 }), node()]
    },
    audit: { action: 'CREATE_TEMPLATE', resultCode: 'TEMPLATE_CREATED' }
  })

  assert.equal(fake.transactionRuns.length, 1)
  assert.equal(fake.transactionRuns[0].callbacks, 1)
  assert.equal(fake.documents('templates').length, 1)
  assert.equal(fake.documents('template_nodes').length, 2)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(result.template.version, 1)
  assert.equal(result.nodes[0].sequence, 0)
  assert.equal(result.nodes[1].sequence, 1)
  assert.deepEqual(result.template.createdAt, { __serverDate: 1 })
  assert.deepEqual(result.template.updatedAt, { __serverDate: 2 })
  assert.ok(result.nodes.every(item => item.createdAt.__serverDate && item.updatedAt.__serverDate))
  assert.deepEqual(fake.documents('audit_logs')[0], {
    _id: 'audit-4',
    actorId: 'admin-1',
    action: 'CREATE_TEMPLATE',
    resultCode: 'TEMPLATE_CREATED',
    targetType: 'template',
    targetId: result.template._id,
    createdAt: { __serverDate: 7 }
  })
  assert.deepEqual(fake.transactionQueries, [])
})

test('filtered definition lists and node records use deterministic ordering', async () => {
  const { repository } = createRepositoryHarness({
    templates: [
      { _id: 't2', name: '乙', status: 'enabled', version: 1 },
      { _id: 't1', name: '甲', status: 'enabled', version: 1 },
      { _id: 't3', name: '丙', status: 'disabled', version: 1 }
    ],
    template_nodes: [
      { _id: 'n2', templateId: 't1', nodeKey: 'second', sequence: 1 },
      { _id: 'n1-z', templateId: 't1', nodeKey: 'z', sequence: 0 },
      { _id: 'n1-a', templateId: 't1', nodeKey: 'a', sequence: 0 }
    ]
  })

  const result = await repository.listTemplateDefinitions({ status: 'enabled' })
  assert.deepEqual(result.map(item => item.template._id), ['t1', 't2'])
  assert.deepEqual(result[0].nodes.map(item => item._id), ['n1-a', 'n1-z', 'n2'])
})

test('definition reads paginate beyond the CloudBase one-hundred-document query window', async () => {
  const templates = Array.from({ length: 101 }, (_, index) => ({
    _id: `t-${String(index).padStart(3, '0')}`,
    name: `模板 ${index}`,
    status: 'enabled',
    version: 1
  }))
  const templateNodes = Array.from({ length: 101 }, (_, index) => ({
    _id: `n-${String(index).padStart(3, '0')}`,
    templateId: 't-000',
    nodeKey: `node-${index}`,
    sequence: index
  }))
  const { repository } = createRepositoryHarness({ templates, template_nodes: templateNodes })

  const listed = await repository.listTemplateDefinitions({ status: 'enabled' })
  const fetched = await repository.getTemplateDefinition('t-000')
  assert.equal(listed.length, 101)
  assert.equal(fetched.nodes.length, 101)
  assert.equal(fetched.nodes.at(-1)._id, 'n-100')
})

test('active assignee reads use account document ids and return only active users', async () => {
  const { fake, repository } = createRepositoryHarness({
    users: [
      { _id: 'account-1', status: 'active', openid: 'must-not-be-required' },
      { _id: 'account-2', status: 'disabled' }
    ]
  })
  const result = await repository.listActiveUserIds(['account-2', 'missing', 'account-1'])
  assert.deepEqual(result, ['account-1'])
  assert.deepEqual(fake.transactionQueries, [])
})

test('mutation revalidates version and rolls back all writes on a later failure', async () => {
  const { fake, repository } = createRepositoryHarness({
    templates: [{ _id: 't1', name: '旧模板', status: 'disabled', version: 2, nodeCount: 1 }],
    template_nodes: [{ _id: 'n1', templateId: 't1', ...node(), version: 2 }]
  })
  fake.failNextWrite({ collection: 'audit_logs', operation: 'set', error: new Error('audit unavailable') })

  await assert.rejects(repository.mutateTemplateDefinition({
    actor: { _id: 'admin-1' },
    templateId: 't1',
    expectedVersion: 2,
    expectedStatus: 'disabled',
    definition: {
      template: { name: '新版模板', updatedBy: 'admin-1', updatedAt: new Date(0) },
      nodes: [node({ _id: 'n1', name: '新版节点' })]
    },
    audit: { action: 'UPDATE_TEMPLATE', resultCode: 'TEMPLATE_UPDATED' }
  }), /audit unavailable/)

  assert.equal(fake.documents('templates')[0].name, '旧模板')
  assert.equal(fake.documents('templates')[0].version, 2)
  assert.equal(fake.documents('template_nodes')[0].name, '启动')
  assert.equal(fake.documents('audit_logs').length, 0)
})

test('a forty-nine-to-forty-nine replacement is rejected before its transaction exceeds one hundred operations', async () => {
  const existingNodes = Array.from({ length: 49 }, (_, index) => ({
    _id: `n-${index}`,
    templateId: 't1',
    ...node({ nodeKey: `node-${index}`, sequence: index }),
    version: 1
  }))
  const replacementNodes = existingNodes.map(item => ({
    ...item,
    name: `新版 ${item.sequence}`
  }))
  const { fake, repository } = createRepositoryHarness({
    templates: [{ _id: 't1', name: '模板', status: 'disabled', version: 1, nodeCount: 49 }],
    template_nodes: existingNodes
  })

  await assert.rejects(repository.mutateTemplateDefinition({
    actor: { _id: 'admin-1' },
    templateId: 't1',
    expectedVersion: 1,
    expectedStatus: 'disabled',
    definition: { template: { name: '新版' }, nodes: replacementNodes },
    audit: { action: 'UPDATE_TEMPLATE', resultCode: 'TEMPLATE_UPDATED' }
  }), error => error.code === 'TEMPLATE_INVALID')

  assert.equal(fake.transactionRuns.length, 0)
  assert.equal(fake.documents('template_nodes').length, 49)
})

test('a stale version or status fails before node replacement', async () => {
  const { fake, repository } = createRepositoryHarness({
    templates: [{ _id: 't1', name: '模板', status: 'enabled', version: 3 }],
    template_nodes: [{ _id: 'n1', templateId: 't1', ...node(), version: 3 }]
  })

  for (const input of [
    { expectedVersion: 2, expectedStatus: 'enabled' },
    { expectedVersion: 3, expectedStatus: 'disabled' }
  ]) {
    await assert.rejects(repository.mutateTemplateDefinition({
      actor: { _id: 'admin-1' },
      templateId: 't1',
      ...input,
      definition: { template: { name: '不应保存' }, nodes: [] },
      audit: { action: 'UPDATE_TEMPLATE', resultCode: 'TEMPLATE_UPDATED' }
    }), error => error.code === 'VERSION_CONFLICT')
  }

  assert.equal(fake.documents('template_nodes').length, 1)
  assert.equal(fake.documents('audit_logs').length, 0)
})

test('mutation rejects version overflow without persisting an unsafe version', async () => {
  const { fake, repository } = createRepositoryHarness({
    templates: [{
      _id: 't1', name: '模板', status: 'disabled', version: Number.MAX_SAFE_INTEGER
    }]
  })

  await assert.rejects(repository.mutateTemplateDefinition({
    actor: { _id: 'admin-1' },
    templateId: 't1',
    expectedVersion: Number.MAX_SAFE_INTEGER,
    expectedStatus: 'disabled',
    definition: { template: { name: '不应保存' } },
    audit: { action: 'UPDATE_TEMPLATE', resultCode: 'TEMPLATE_UPDATED' }
  }), error => error.code === 'VERSION_CONFLICT')

  assert.equal(fake.documents('templates')[0].version, Number.MAX_SAFE_INTEGER)
  assert.equal(fake.documents('audit_logs').length, 0)
})

test('mutation fails closed if the fixed template document disappears before transaction revalidation', async () => {
  const { fake, repository } = createRepositoryHarness({
    templates: [{ _id: 't1', name: '模板', status: 'disabled', version: 1 }],
    template_nodes: [{ _id: 'n1', templateId: 't1', ...node(), version: 1 }]
  })
  fake.beforeNextTransaction(() => fake.db.collection('templates').doc('t1').remove())

  await assert.rejects(repository.mutateTemplateDefinition({
    actor: { _id: 'admin-1' },
    templateId: 't1',
    expectedVersion: 1,
    expectedStatus: 'disabled',
    definition: { template: { name: '不应保存' }, nodes: [] },
    audit: { action: 'UPDATE_TEMPLATE', resultCode: 'TEMPLATE_UPDATED' }
  }), error => error.code === 'NOT_FOUND')

  assert.equal(fake.documents('template_nodes').length, 1)
  assert.equal(fake.documents('audit_logs').length, 0)
})
