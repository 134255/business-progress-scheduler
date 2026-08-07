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
    assigneeUserIds: ['user-1'],
    slaWorkHours: 8,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [{ fieldKey: 'field-1', sequence: 0, name: '说明', type: 'short_text' }],
    ...overrides
  }
}

test('normalizes node fields into contiguous sequence while preserving stable keys', () => {
  const node = normalizeTemplateNode(createNode({
    name: ' 启动 ',
    slaWorkHours: undefined,
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
    assigneeUserIds: ['user-1'],
    slaWorkHours: 22,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [
      { fieldKey: 'field-name', sequence: 0, name: '名称', description: '', type: 'short_text', required: false, constraints: {} },
      { fieldKey: 'field-date', sequence: 1, name: '日期', description: '', type: 'date', required: false, constraints: {} }
    ]
  })
})

test('rejects invalid SLA, evidence rules, and duplicate stable keys in a node', () => {
  assert.deepEqual(normalizeTemplateNode(createNode({
    allowedEvidenceTypes: ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v']
  })).allowedEvidenceTypes, ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])
  assert.throws(() => normalizeTemplateNode(createNode({ slaWorkHours: 0 })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ allowedEvidenceTypes: ['exe'] })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ requiresEvidence: true, allowedEvidenceTypes: [] })), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => normalizeTemplateNode(createNode({ fields: [
    { fieldKey: 'same', name: '甲', type: 'short_text' },
    { fieldKey: 'same', name: '乙', type: 'short_text' }
  ] })), error => error.code === 'TEMPLATE_INVALID')
})

test('requires contiguous unique node keys and active account-document assignees before enable', () => {
  const template = { status: 'draft' }
  const first = createNode({ nodeKey: 'node-first', sequence: 0, assigneeUserIds: ['account-1'] })
  const second = createNode({ nodeKey: 'node-second', sequence: 1, assigneeUserIds: ['account-2'] })

  assert.equal(validateTemplateForEnable(template, [first, second], ['account-1', 'account-2']), true)
  assert.throws(() => validateTemplateForEnable(template, [], ['account-1']), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => validateTemplateForEnable(template, [first, { ...second, nodeKey: 'node-first' }], ['account-1', 'account-2']), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => validateTemplateForEnable(template, [first, { ...second, sequence: 2 }], ['account-1', 'account-2']), error => error.code === 'TEMPLATE_INVALID')
  assert.throws(() => validateTemplateForEnable(template, [{ ...first, assigneeUserIds: [] }], ['account-1']), error => error.code === 'ASSIGNEE_INACTIVE')
  assert.throws(() => validateTemplateForEnable(template, [first], ['another-account']), error => error.code === 'ASSIGNEE_INACTIVE')
})

test('enabled templates are read-only until disabled and deleted templates are unavailable', () => {
  assert.doesNotThrow(() => assertTemplateEditable({ status: 'draft' }))
  assert.doesNotThrow(() => assertTemplateEditable({ status: 'disabled' }))
  assert.throws(() => assertTemplateEditable({ status: 'enabled' }), error => error.code === 'TEMPLATE_NOT_EDITABLE')
  assert.throws(() => assertTemplateEditable({ status: 'deleted' }), error => error.code === 'NOT_FOUND')
})
