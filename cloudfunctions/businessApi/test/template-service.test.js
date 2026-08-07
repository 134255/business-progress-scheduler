const test = require('node:test')
const assert = require('node:assert/strict')

const { createTemplateHarness } = require('./helpers/template-harness')

function validDefinition(overrides = {}) {
  return {
    name: '交付模板',
    description: '用于项目交付',
    nodes: [{
      name: '启动',
      description: '',
      assigneeUserIds: ['account-1'],
      slaWorkHours: 8,
      requiresEvidence: false,
      allowedEvidenceTypes: ['pdf'],
      fields: [{ name: '说明', type: 'short_text', required: true, constraints: { maxLength: 80 } }]
    }],
    ...overrides
  }
}

function storedNode(templateId = 't1', overrides = {}) {
  return {
    _id: `${templateId}-node-1`,
    templateId,
    nodeKey: 'node-existing',
    sequence: 0,
    name: '启动',
    description: '',
    assigneeUserIds: ['account-1'],
    slaWorkHours: 8,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [{
      fieldKey: 'field-existing',
      sequence: 0,
      name: '说明',
      description: '',
      type: 'short_text',
      required: true,
      constraints: { maxLength: 80 }
    }],
    version: 1,
    ...overrides
  }
}

test('ordinary users cannot mutate template definitions', async () => {
  const harness = createTemplateHarness()
  await assert.rejects(
    harness.service.createTemplate({ actor: harness.user, input: validDefinition() }),
    error => error.code === 'FORBIDDEN'
  )
})

test('template creation assigns stable keys and creates a draft', async () => {
  const harness = createTemplateHarness({ users: [{ _id: 'account-1', status: 'active' }] })
  const created = await harness.service.createTemplate({ actor: harness.admin, input: validDefinition() })

  assert.equal(created.template.status, 'draft')
  assert.equal(created.template.version, 1)
  assert.equal(created.template.nodeCount, 1)
  assert.equal(created.nodes[0].nodeKey, 'node-1')
  assert.equal(created.nodes[0].fields[0].fieldKey, 'field-2')
  assert.equal(created.nodes[0].assigneeUserIds[0], 'account-1')
  assert.equal(harness.audits[0].action, 'CREATE_TEMPLATE')
})

test('inactive assignees block template creation', async () => {
  const harness = createTemplateHarness({ users: [{ _id: 'account-1', status: 'disabled' }] })
  await assert.rejects(
    harness.service.createTemplate({ actor: harness.admin, input: validDefinition() }),
    error => error.code === 'ASSIGNEE_INACTIVE'
  )
})

test('definition size is rejected before it can exceed the transaction operation budget', async () => {
  const nodes = Array.from({ length: 49 }, (_, index) => ({
    ...validDefinition().nodes[0],
    name: `节点 ${index + 1}`
  }))
  const harness = createTemplateHarness({ users: [{ _id: 'account-1', status: 'active' }] })
  await assert.rejects(
    harness.service.createTemplate({ actor: harness.admin, input: validDefinition({ nodes }) }),
    error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' && /at most 48 nodes/.test(error.message)
  )
  assert.equal(harness.definitions.size, 0)
})

test('enabled templates must be disabled before definition updates', async () => {
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '旧模板', status: 'enabled', version: 4 }],
    nodes: [storedNode()]
  })
  await assert.rejects(
    harness.service.updateTemplate({
      actor: harness.admin,
      templateId: 't1',
      expectedVersion: 4,
      input: validDefinition({ nodes: [storedNode()] })
    }),
    error => error.code === 'TEMPLATE_NOT_EDITABLE'
  )
})

test('a template can be disabled, edited with stable keys, and re-enabled', async () => {
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '旧模板', description: '', status: 'enabled', version: 4, nodeCount: 1 }],
    nodes: [storedNode()],
    users: [{ _id: 'account-1', status: 'active' }]
  })

  const disabled = await harness.service.changeTemplateStatus({
    actor: harness.admin, templateId: 't1', expectedVersion: 4, status: 'disabled'
  })
  const edited = await harness.service.updateTemplate({
    actor: harness.admin,
    templateId: 't1',
    expectedVersion: disabled.template.version,
    input: validDefinition({ name: '新版模板', nodes: [storedNode()] })
  })
  const enabled = await harness.service.changeTemplateStatus({
    actor: harness.admin,
    templateId: 't1',
    expectedVersion: edited.template.version,
    status: 'enabled'
  })

  assert.equal(disabled.template.status, 'disabled')
  assert.equal(edited.template.name, '新版模板')
  assert.equal(edited.nodes[0].nodeKey, 'node-existing')
  assert.equal(edited.nodes[0].fields[0].fieldKey, 'field-existing')
  assert.equal(enabled.template.status, 'enabled')
  assert.deepEqual(harness.audits.map(item => item.action), [
    'DISABLE_TEMPLATE', 'UPDATE_TEMPLATE', 'ENABLE_TEMPLATE'
  ])
})

test('enabling validates node rules and active assignees', async () => {
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '模板', status: 'draft', version: 1 }],
    nodes: [storedNode()],
    users: [{ _id: 'account-1', status: 'disabled' }]
  })
  await assert.rejects(
    harness.service.changeTemplateStatus({
      actor: harness.admin, templateId: 't1', expectedVersion: 1, status: 'enabled'
    }),
    error => error.code === 'ASSIGNEE_INACTIVE'
  )
})

test('enablement rejects legacy definitions above the documented node maximum', async () => {
  const nodes = Array.from({ length: 49 }, (_, index) => storedNode('t1', {
    _id: `t1-node-${index}`,
    nodeKey: `node-${index}`,
    sequence: index
  }))
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '模板', status: 'disabled', version: 1, nodeCount: 49 }],
    nodes,
    users: [{ _id: 'account-1', status: 'active' }]
  })

  await assert.rejects(harness.service.changeTemplateStatus({
    actor: harness.admin,
    templateId: 't1',
    expectedVersion: 1,
    status: 'enabled'
  }), error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' && /at most 48 nodes/.test(error.message))
  assert.equal(harness.audits.length, 0)
})

test('enablement rejects definitions that cannot fit the business snapshot transaction budget', async () => {
  const nodes = Array.from({ length: 48 }, (_, index) => storedNode('t1', {
    _id: `t1-node-${index}`,
    nodeKey: `node-${index}`,
    sequence: index,
    assigneeUserIds: [`account-${index}`]
  }))
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '模板', status: 'disabled', version: 1, nodeCount: 48 }],
    nodes,
    users: nodes.map((node, index) => ({ _id: `account-${index}`, status: 'active' }))
  })

  await assert.rejects(harness.service.changeTemplateStatus({
    actor: harness.admin,
    templateId: 't1',
    expectedVersion: 1,
    status: 'enabled'
  }), error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' &&
    /snapshot transaction operation budget/i.test(error.message) &&
    !/at most 48 nodes/i.test(error.message))
  assert.equal(harness.audits.length, 0)
})

test('logical deletion requires a disabled definition and hides it from administrators', async () => {
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '模板', status: 'disabled', version: 2 }],
    nodes: [storedNode()]
  })
  const removed = await harness.service.deleteTemplate({
    actor: harness.admin, templateId: 't1', expectedVersion: 2
  })

  assert.equal(removed.template.status, 'deleted')
  assert.equal((await harness.service.listTemplates({ actor: harness.admin, query: {} })).items.length, 0)
  await assert.rejects(
    harness.service.getTemplate({ actor: harness.admin, templateId: 't1' }),
    error => error.code === 'NOT_FOUND'
  )
})

test('stale versions fail instead of overwriting a newer administrator change', async () => {
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '模板', status: 'disabled', version: 3 }],
    nodes: [storedNode()]
  })
  await assert.rejects(
    harness.service.updateTemplate({
      actor: harness.admin,
      templateId: 't1',
      expectedVersion: 2,
      input: validDefinition({ nodes: [storedNode()] })
    }),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('ordinary template listings expose safe availability projections only', async () => {
  const harness = createTemplateHarness({
    templates: [{
      _id: 't1', name: '可用模板', description: '说明', status: 'enabled', version: 3,
      nodeCount: 1, createdBy: 'admin-1', deletedBy: ''
    }],
    nodes: [storedNode()],
    users: [{ _id: 'account-1', status: 'disabled' }]
  })
  const result = await harness.service.listEnabledTemplates({ actor: harness.user })

  assert.deepEqual(result, {
    items: [{
      _id: 't1', name: '可用模板', description: '说明', nodeCount: 1,
      available: false, unavailableReason: 'ASSIGNEE_INACTIVE'
    }]
  })
})

test('ordinary listings do not advertise enabled templates that exceed the snapshot operation budget', async () => {
  const nodes = Array.from({ length: 48 }, (_, index) => storedNode('t1', {
    _id: `t1-node-${index}`,
    nodeKey: `node-${index}`,
    sequence: index,
    assigneeUserIds: [`account-${index}`]
  }))
  const harness = createTemplateHarness({
    templates: [{
      _id: 't1', name: '旧版超预算模板', description: '', status: 'enabled', version: 3,
      nodeCount: 48
    }],
    nodes,
    users: nodes.map((node, index) => ({ _id: `account-${index}`, status: 'active' }))
  })

  const result = await harness.service.listEnabledTemplates({ actor: harness.user })
  assert.equal(result.items[0].available, false)
  assert.equal(result.items[0].unavailableReason, 'TEMPLATE_LIMIT_EXCEEDED')
})

test('definition updates reject duplicate supplied stable keys', async () => {
  const harness = createTemplateHarness({
    templates: [{ _id: 't1', name: '模板', status: 'disabled', version: 1 }],
    nodes: [storedNode()]
  })
  await assert.rejects(
    harness.service.updateTemplate({
      actor: harness.admin,
      templateId: 't1',
      expectedVersion: 1,
      input: validDefinition({ nodes: [storedNode(), { ...storedNode(), _id: undefined, sequence: 1 }] })
    }),
    error => error.code === 'TEMPLATE_INVALID'
  )
})
