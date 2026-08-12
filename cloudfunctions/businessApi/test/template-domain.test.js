const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeTemplateNode,
  validateTemplateForEnable,
  assertTemplateEditable
} = require('../lib/template-domain')

function createNode(overrides = {}) {
  return {
    nodeKey: 'node-1',
    sequence: 0,
    name: '启动',
    description: '',
    processorUserIds: ['user-1'],
    reviewerUserIds: ['reviewer-1'],
    reviewMode: 'any',
    processingSlaWorkHours: 8,
    reviewSlaWorkHours: 4,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [{ fieldKey: 'field-1', sequence: 0, name: '说明', type: 'short_text' }],
    ...overrides
  }
}

test('规范化新版节点的处理人、审核人、审核模式和双 SLA，并保留稳定字段键', () => {
  const node = normalizeTemplateNode(createNode({
    name: ' 启动 ',
    processingSlaWorkHours: undefined,
    reviewSlaWorkHours: undefined,
    fields: [
      { fieldKey: 'field-name', sequence: 9, name: '名称', type: 'short_text' },
      { fieldKey: 'field-date', sequence: 2, name: '日期', type: 'date' }
    ]
  }))

  assert.deepEqual(node, {
    nodeKey: 'node-1',
    sequence: 0,
    name: '启动',
    description: '',
    workflowMode: 'review',
    processorUserIds: ['user-1'],
    reviewerUserIds: ['reviewer-1'],
    reviewMode: 'any',
    processingSlaWorkHours: 22,
    reviewSlaWorkHours: 8,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [
      { fieldKey: 'field-name', sequence: 0, name: '名称', description: '', type: 'short_text', required: false, constraints: {} },
      { fieldKey: 'field-date', sequence: 1, name: '日期', description: '', type: 'date', required: false, constraints: {} }
    ]
  })
})

test('拒绝无效双 SLA、审核配置、凭证规则和重复稳定键', () => {
  assert.deepEqual(normalizeTemplateNode(createNode({
    allowedEvidenceTypes: ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v']
  })).allowedEvidenceTypes, ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])
  assert.throws(() => normalizeTemplateNode(createNode({ processingSlaWorkHours: 0 })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ reviewSlaWorkHours: 0 })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ processingSlaWorkHours: 0.333 })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ reviewSlaWorkHours: Number.MAX_SAFE_INTEGER })), error => error.code === 'TEMPLATE_INVALID')
  assert.equal(normalizeTemplateNode(createNode({ processingSlaWorkHours: 0.1 })).processingSlaWorkHours, 0.1)
  assert.throws(() => normalizeTemplateNode(createNode({ reviewMode: 'majority' })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ allowedEvidenceTypes: ['exe'] })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ requiresEvidence: true, allowedEvidenceTypes: [] })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ fields: [
    { fieldKey: 'same', name: '甲', type: 'short_text' },
    { fieldKey: 'same', name: '乙', type: 'short_text' }
  ] })), error => error.code === 'TEMPLATE_INVALID')
})

test('启用前要求连续唯一节点键、启用处理人和审核人、且角色严格分离', () => {
  const template = { status: 'draft' }
  const first = createNode({ nodeKey: 'node-first', sequence: 0, processorUserIds: ['account-1'], reviewerUserIds: ['account-3'] })
  const second = createNode({ nodeKey: 'node-second', sequence: 1, processorUserIds: ['account-2'], reviewerUserIds: ['account-4'] })

  assert.equal(validateTemplateForEnable(template, [first, second], ['account-1', 'account-2', 'account-3', 'account-4']), true)
  assert.throws(() => validateTemplateForEnable(template, [], ['account-1']), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => validateTemplateForEnable(template, [first, { ...second, nodeKey: 'node-first' }], ['account-1', 'account-2', 'account-3', 'account-4']), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => validateTemplateForEnable(template, [first, { ...second, sequence: 2 }], ['account-1', 'account-2', 'account-3', 'account-4']), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => validateTemplateForEnable(template, [{ ...first, processorUserIds: [] }], ['account-1', 'account-3']), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => validateTemplateForEnable(template, [first], ['another-account', 'account-3']), error => error.code === 'PROCESSOR_INACTIVE')
  assert.throws(() => validateTemplateForEnable(template, [first], ['account-1']), error => error.code === 'REVIEWER_INACTIVE')
  assert.throws(() => validateTemplateForEnable(template, [{ ...first, reviewerUserIds: ['account-1'] }], ['account-1']), error => error.code === 'ROLE_OVERLAP')
  assert.throws(() => validateTemplateForEnable(template, [{ ...first, reviewerUserIds: [] }], ['account-1']), error => error.code === 'TEMPLATE_INVALID')
})

test('模板拒绝会进入必需索引的超预算账号数组并接受保守边界', () => {
  const ids = count => Array.from({ length: count }, (_, index) =>
    `acct-${String(index).padStart(2, '0')}-12345678901234567890123456789012`)
  const within = createNode({
    processorUserIds: ids(5),
    reviewerUserIds: ids(5).map(id => id.replace('acct-', 'rvwr-'))
  })
  const active = [...within.processorUserIds, ...within.reviewerUserIds]

  assert.equal(validateTemplateForEnable({ status: 'draft' }, [within], active), true)

  const over = createNode({
    processorUserIds: ids(15),
    reviewerUserIds: ids(15).map(id => id.replace('acct-', 'rvwr-'))
  })
  assert.throws(
    () => validateTemplateForEnable(
      { status: 'draft' },
      [over],
      [...over.processorUserIds, ...over.reviewerUserIds]
    ),
    error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' && /索引账号数组/.test(error.message)
  )
})

test('enabled templates are read-only until disabled and deleted templates are unavailable', () => {
  assert.doesNotThrow(() => assertTemplateEditable({ status: 'draft' }))
  assert.doesNotThrow(() => assertTemplateEditable({ status: 'disabled' }))
  assert.throws(() => assertTemplateEditable({ status: 'enabled' }), error => error.code === 'TEMPLATE_NOT_EDITABLE')
  assert.throws(() => assertTemplateEditable({ status: 'deleted' }), error => error.code === 'NOT_FOUND')
})
