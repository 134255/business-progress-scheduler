const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createOptimisticBusinessDatabase } = require('./helpers/business-harness')

function sourceNode(overrides = {}) {
  return {
    _id: 'template-node-1',
    templateId: 'template-1',
    nodeKey: 'node-a',
    sequence: 0,
    name: '启动',
    description: '启动说明',
    assigneeUserIds: ['user-2'],
    slaWorkHours: 8,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [{
      fieldKey: 'field-a', sequence: 0, name: '摘要', description: '',
      type: 'short_text', required: true, constraints: { maxLength: 100 }
    }],
    ...overrides
  }
}

function seedDefinition(overrides = {}) {
  const nodes = overrides.nodes || [
    sourceNode(),
    sourceNode({
      _id: 'template-node-2', nodeKey: 'node-b', sequence: 1, name: '交付',
      assigneeUserIds: ['user-3'], requiresEvidence: true,
      allowedEvidenceTypes: ['pdf', 'mp4']
    })
  ]
  return {
    users: overrides.users || [
      { _id: 'user-1', status: 'active' },
      { _id: 'user-2', status: 'active' },
      { _id: 'user-3', status: 'active' }
    ],
    templates: [{
      _id: 'template-1', name: '交付模板', status: 'enabled', version: 4,
      nodeCount: nodes.length
    }],
    template_nodes: nodes,
    ...(overrides.extra || {})
  }
}

function createRepositoryHarness(seed = seedDefinition(), options = {}) {
  const fake = createFakeCloudDatabase(seed)
  const repository = createCloudBusinessRepository({
    db: fake.db,
    clock: () => new Date('2026-08-07T02:30:00.000Z'),
    ...options
  })
  return { fake, repository }
}

function input(overrides = {}) {
  return {
    templateId: 'template-1',
    name: '新业务',
    description: '说明',
    plannedStartDate: '2026-08-08',
    plannedEndDate: '2026-08-12',
    requestKey: 'request-001',
    ...overrides
  }
}

async function definition(repository) {
  return repository.getTemplateDefinition('template-1')
}

test('creation allocates a generated code and publishes a complete immutable template snapshot', async () => {
  const { fake, repository } = createRepositoryHarness()
  const source = await definition(repository)
  const result = await repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: source
  })

  assert.deepEqual(result, { id: result.id, code: 'BL-20260807-0001' })
  const [line] = fake.documents('business_lines')
  const nodes = fake.documents('business_nodes').sort((left, right) => left.sequence - right.sequence)
  assert.equal(line._id, result.id)
  assert.equal(line.status, 'active')
  assert.equal(line.sourceTemplateId, 'template-1')
  assert.equal(line.sourceTemplateVersion, 4)
  assert.deepEqual(line.managerUserIds, ['user-1'])
  assert.deepEqual(line.memberUserIds, ['user-1', 'user-2', 'user-3'])
  assert.equal(line.currentNodeId, nodes[0]._id)
  assert.equal(line.currentNodeName, '启动')
  assert.equal(line.nodeCount, 2)
  assert.equal(line.version, 1)
  assert.deepEqual(nodes.map(node => node.nodeCode), [
    'BL-20260807-0001-N001', 'BL-20260807-0001-N002'
  ])
  assert.deepEqual(nodes.map(node => node.status), ['ready', 'waiting'])
  assert.equal(nodes[0].sourceTemplateNodeKey, 'node-a')
  assert.deepEqual(nodes[0].fieldDefinitions, source.nodes[0].fields)
  assert.notEqual(nodes[0].fieldDefinitions, source.nodes[0].fields)
  source.nodes[0].fields[0].name = '后续模板变化'
  assert.equal(fake.documents('business_nodes')[0].fieldDefinitions[0].name, '摘要')
  assert.equal(fake.documents('sequence_counters')[0].sequence, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.deepEqual(fake.transactionQueries, [])
})

test('snapshot creation and publication roll back safely and resume through the same reservation', async () => {
  const { fake, repository } = createRepositoryHarness()
  const source = await definition(repository)
  fake.failNextWrite({ collection: 'audit_logs', operation: 'set', error: new Error('audit unavailable') })

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: source
  }), /audit unavailable/)

  assert.equal(fake.documents('business_lines')[0].status, 'creating')
  assert.equal(fake.documents('business_nodes').length, 2)
  assert.equal(fake.documents('audit_logs').length, 0)

  const retried = await repository.findCreationResult({ actorId: 'user-1', input: input() })
  assert.equal(retried.code, 'BL-20260807-0001')
  assert.equal(fake.documents('business_lines')[0].status, 'active')
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('sequence_counters')[0].sequence, 1)
})

test('snapshot transaction revalidates enabled template and active assignees and leaves no partial data', async t => {
  await t.test('template disabled after the service read', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('templates', 'template-1', {
      name: '交付模板', status: 'disabled', version: 5, nodeCount: 2
    }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'TEMPLATE_NOT_ENABLED')
    assert.equal(fake.documents('business_lines').length, 0)
    assert.equal(fake.documents('business_nodes').length, 0)
  })

  await t.test('assignee disabled after the service read', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('users', 'user-2', { status: 'disabled' }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'ASSIGNEE_INACTIVE')
    assert.equal(fake.documents('business_lines').length, 0)
    assert.equal(fake.documents('sequence_counters').length, 0)
  })

  await t.test('creator disabled after route resolution', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('users', 'user-1', { status: 'disabled' }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'FORBIDDEN')
    assert.equal(fake.documents('business_lines').length, 0)
    assert.equal(fake.documents('business_nodes').length, 0)
    assert.equal(fake.documents('sequence_counters').length, 0)
  })
})

test('same-key retries return the existing deterministic reservation', async () => {
  const { fake, repository } = createRepositoryHarness()
  const source = await definition(repository)
  const request = { actor: { _id: 'user-1' }, input: input(), definition: source }
  const first = await repository.createBusinessSnapshot(request)
  const retry = await repository.createBusinessSnapshot(request)
  assert.deepEqual(first, retry)
  assert.equal(fake.documents('business_lines').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('sequence_counters')[0].sequence, 1)
})

test('overlapping snapshot transactions conflict and retry to unique or idempotent results', async () => {
  const optimistic = createOptimisticBusinessDatabase(seedDefinition())
  const repository = createCloudBusinessRepository({
    db: optimistic.db,
    clock: () => new Date('2026-08-07T02:30:00.000Z')
  })
  const source = await definition(repository)
  const actor = { _id: 'user-1' }

  const distinct = await Promise.all([
    repository.createBusinessSnapshot({ actor, input: input({ requestKey: 'request-a' }), definition: source }),
    repository.createBusinessSnapshot({ actor, input: input({ requestKey: 'request-b' }), definition: source })
  ])
  assert.deepEqual(distinct.map(item => item.code).sort(), [
    'BL-20260807-0001', 'BL-20260807-0002'
  ])

  const sameRequest = { actor, input: input({ requestKey: 'request-c' }), definition: source }
  const same = await Promise.all([
    repository.createBusinessSnapshot(sameRequest),
    repository.createBusinessSnapshot(sameRequest)
  ])
  assert.deepEqual(same[0], same[1])
  assert.ok(optimistic.metrics.maxActiveCallbacks >= 2)
  assert.ok(optimistic.metrics.conflicts >= 1)
  assert.ok(optimistic.metrics.retries >= 1)
  assert.equal(optimistic.documents('business_lines').length, 3)
  assert.equal(optimistic.documents('audit_logs').length, 3)
  assert.equal(optimistic.documents('sequence_counters')[0].sequence, 3)
})

test('numbering expands past four digits and retries a stale counter collision without wrapping', async () => {
  const seed = seedDefinition({
    extra: {
      sequence_counters: [{ _id: 'business-line-20260807', sequence: 9998 }],
      business_lines: [{
        _id: 'existing', code: 'BL-20260807-9999', status: 'active',
        createdBy: 'other-user'
      }]
    }
  })
  const { fake, repository } = createRepositoryHarness(seed)
  const result = await repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  })

  assert.equal(result.code, 'BL-20260807-10000')
  assert.equal(fake.documents('sequence_counters')[0].sequence, 10000)
})

test('snapshot creation rejects creator-aware operation budget overflow before starting a transaction', async () => {
  const nodes = Array.from({ length: 48 }, (_, index) => sourceNode({
    _id: `template-node-${index}`,
    nodeKey: `node-${index}`,
    sequence: index,
    assigneeUserIds: [`assignee-${index % 47}`]
  }))
  const users = [{ _id: 'user-1', status: 'active' }].concat(nodes.map((node, index) => ({
    _id: `assignee-${index}`, status: 'active'
  })))
  const { fake, repository } = createRepositoryHarness(seedDefinition({ nodes, users }))

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }), error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' &&
    /snapshot transaction operation budget/i.test(error.message) &&
    !/at most 48 nodes/i.test(error.message))
  assert.equal(fake.transactionRuns.length, 0)
})

test('failed snapshot writes roll back the counter, line, nodes, and audit together', async () => {
  const { fake, repository } = createRepositoryHarness()
  fake.failNextWrite({ collection: 'business_nodes', operation: 'set', error: new Error('node write failed') })

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }), /node write failed/)
  assert.equal(fake.documents('sequence_counters').length, 0)
  assert.equal(fake.documents('business_lines').length, 0)
  assert.equal(fake.documents('business_nodes').length, 0)
  assert.equal(fake.documents('audit_logs').length, 0)
})

test('reusing a request key with different validated input fails closed', async () => {
  const { repository } = createRepositoryHarness()
  const request = { actor: { _id: 'user-1' }, input: input(), definition: await definition(repository) }
  await repository.createBusinessSnapshot(request)

  await assert.rejects(
    repository.findCreationResult({ actorId: 'user-1', input: input({ name: '另一个业务' }) }),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('business list and detail reads support account-id snapshots and legacy OpenID records', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        {
          _id: 'new-active', code: 'BL-20260807-0001', name: '新业务', status: 'active',
          managerUserIds: ['user-1'], memberUserIds: ['user-1', 'user-2'], updatedAt: 4
        },
        {
          _id: 'new-creating', code: 'BL-20260807-0002', name: '半成品', status: 'creating',
          managerUserIds: ['user-1'], memberUserIds: ['user-1'], updatedAt: 5
        },
        {
          _id: 'legacy-active', code: 'LEGACY-1', name: '旧业务', status: 'active',
          managerIds: ['wx-user-1'], memberIds: ['wx-user-1'], updatedAt: 3
        },
        {
          _id: 'foreign', code: 'BL-20260807-0003', name: '无权业务', status: 'active',
          managerUserIds: ['user-3'], memberUserIds: ['user-3'], updatedAt: 2
        },
        {
          _id: 'hybrid-foreign', code: 'BL-20260807-0004', name: '混合字段无权业务', status: 'active',
          managerUserIds: ['user-3'], memberUserIds: ['user-3'], memberIds: ['wx-user-1'], updatedAt: 1
        }
      ],
      business_nodes: [
        {
          _id: 'new-node', businessLineId: 'new-active', sequence: 0, name: '新节点',
          status: 'ready', assigneeUserIds: ['user-2']
        },
        {
          _id: 'legacy-node', businessLineId: 'legacy-active', sequence: 0, name: '旧节点',
          status: 'ready', assigneeIds: ['wx-user-1'], assigneeNames: ['旧用户']
        }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  const listed = await repository.listBusinessLines({ actor, query: { page: 1, pageSize: 20 } })
  assert.deepEqual(listed.items.map(line => line._id), ['new-active', 'legacy-active'])

  const current = await repository.getBusinessLine({ actor, lineId: 'new-active' })
  assert.equal(current.line._id, 'new-active')
  assert.equal(current.nodes[0]._id, 'new-node')
  assert.equal(current.canManage, true)
  assert.equal(current.canEditNodes, false)

  const legacy = await repository.getBusinessLine({ actor, lineId: 'legacy-active' })
  assert.equal(legacy.line._id, 'legacy-active')
  assert.equal(legacy.nodes[0].canFeedback, true)
  assert.equal(legacy.nodes[0].assigneeNamesText, '旧用户')
})

test('business detail reads hide creating reservations and deny non-members in both schemas', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        { _id: 'new-creating', status: 'creating', memberUserIds: ['user-1'] },
        { _id: 'new-foreign', status: 'active', memberUserIds: ['user-2'] },
        { _id: 'legacy-foreign', status: 'active', memberIds: ['wx-user-2'] }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  await assert.rejects(
    repository.getBusinessLine({ actor, lineId: 'new-creating' }),
    error => error.code === 'NOT_FOUND'
  )
  for (const lineId of ['new-foreign', 'legacy-foreign']) {
    await assert.rejects(
      repository.getBusinessLine({ actor, lineId }),
      error => error.code === 'FORBIDDEN'
    )
  }
})

test('present malformed account membership fields never inherit legacy OpenID access', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        {
          _id: 'null-member', status: 'active', memberUserIds: null,
          memberIds: ['wx-user-1'], updatedAt: 3
        },
        {
          _id: 'object-manager', status: 'active', managerUserIds: { user: 'user-1' },
          managerIds: ['wx-user-1'], updatedAt: 2
        },
        {
          _id: 'null-manager-account-member', status: 'active', managerUserIds: null,
          memberUserIds: ['user-1'], managerIds: ['wx-user-1'], updatedAt: 1
        }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  const listed = await repository.listBusinessLines({ actor, query: { page: 1, pageSize: 20 } })
  assert.deepEqual(listed.items.map(line => line._id), ['null-manager-account-member'])

  for (const lineId of ['null-member', 'object-manager']) {
    await assert.rejects(
      repository.getBusinessLine({ actor, lineId }),
      error => error.code === 'FORBIDDEN'
    )
  }

  const accountMember = await repository.getBusinessLine({
    actor,
    lineId: 'null-manager-account-member'
  })
  assert.equal(accountMember.canManage, false)
})

test('valid account arrays take precedence over differing legacy arrays while pure legacy remains compatible', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        {
          _id: 'new-manager-only', status: 'active', managerUserIds: ['user-1'],
          memberUserIds: [], managerIds: ['wx-other'], memberIds: ['wx-other'], updatedAt: 4
        },
        {
          _id: 'hybrid-account-member', status: 'active', managerUserIds: ['user-2'],
          memberUserIds: ['user-1'], managerIds: ['wx-user-1'], memberIds: ['wx-other'], updatedAt: 3
        },
        {
          _id: 'hybrid-legacy-only', status: 'active', managerUserIds: ['user-2'],
          memberUserIds: ['user-2'], managerIds: ['wx-user-1'], memberIds: ['wx-user-1'], updatedAt: 2
        },
        {
          _id: 'legacy-manager-only', status: 'active', managerIds: ['wx-user-1'],
          memberIds: [], updatedAt: 1
        }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  const listed = await repository.listBusinessLines({ actor, query: { page: 1, pageSize: 20 } })
  assert.deepEqual(listed.items.map(line => line._id), [
    'new-manager-only', 'hybrid-account-member', 'legacy-manager-only'
  ])

  assert.equal((await repository.getBusinessLine({
    actor,
    lineId: 'new-manager-only'
  })).canManage, true)
  assert.equal((await repository.getBusinessLine({
    actor,
    lineId: 'hybrid-account-member'
  })).canManage, false)
  assert.equal((await repository.getBusinessLine({
    actor,
    lineId: 'legacy-manager-only'
  })).canManage, true)
  await assert.rejects(
    repository.getBusinessLine({ actor, lineId: 'hybrid-legacy-only' }),
    error => error.code === 'FORBIDDEN'
  )
})
