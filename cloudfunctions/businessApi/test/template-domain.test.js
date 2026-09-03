const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ACTIVATION_MODE,
  REVIEWER_ASSIGNMENT_MODE,
  normalizeTemplateNode,
  normalizeVersion2TemplateDefinition,
  version2TemplateDefinitionDigest,
  templateDefinitionDigest,
  collectTemplateParticipantUserIds,
  validateTemplateForEnable,
  assertTemplateEditable
} = require('../lib/template-domain')

const { classifyCompletedNodeTransition } = require('../lib/optional-tail-domain')

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
    activationMode: 'required',
    processorAssignmentMode: 'fixed_accounts',
    processorUserIds: ['user-1'],
    reviewerAssignmentMode: 'fixed_accounts',
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

test('审核人来源按节点独立规范化，旧节点默认固定账号且发起人模式不保留固定审核人', () => {
  const legacyShape = normalizeTemplateNode(createNode())
  const creatorAssigned = normalizeTemplateNode(createNode({
    reviewerAssignmentMode: 'business_creator',
    reviewerUserIds: []
  }))

  assert.equal(REVIEWER_ASSIGNMENT_MODE.FIXED_ACCOUNTS, 'fixed_accounts')
  assert.equal(REVIEWER_ASSIGNMENT_MODE.BUSINESS_CREATOR, 'business_creator')
  assert.equal(legacyShape.reviewerAssignmentMode, 'fixed_accounts')
  assert.deepEqual(legacyShape.reviewerUserIds, ['reviewer-1'])
  assert.equal(creatorAssigned.reviewerAssignmentMode, 'business_creator')
  assert.deepEqual(creatorAssigned.reviewerUserIds, [])
  assert.deepEqual(
    collectTemplateParticipantUserIds([creatorAssigned]),
    ['user-1'],
    '未来业务发起人不能使用模板伪账号占位'
  )
  assert.equal(validateTemplateForEnable(
    { status: 'draft' },
    [creatorAssigned],
    ['user-1']
  ), true)

  assert.throws(
    () => normalizeTemplateNode(createNode({
      reviewerAssignmentMode: 'business_creator',
      reviewerUserIds: ['reviewer-1']
    })),
    error => error.code === 'TEMPLATE_INVALID'
  )
  assert.throws(
    () => normalizeTemplateNode(createNode({ reviewerAssignmentMode: 'round_robin' })),
    error => error.code === 'TEMPLATE_INVALID'
  )
})

test('审核人来源只接受自有数据属性，访问器、继承值和稀疏审核人数组失败关闭', () => {
  let getterCalls = 0
  const accessorNode = createNode()
  Object.defineProperty(accessorNode, 'reviewerAssignmentMode', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'business_creator'
    }
  })
  assert.throws(() => normalizeTemplateNode(accessorNode), error => error.code === 'TEMPLATE_INVALID')
  assert.equal(getterCalls, 0)

  const inheritedNode = Object.assign(
    Object.create({ reviewerAssignmentMode: 'business_creator' }),
    createNode({ reviewerUserIds: [] })
  )
  assert.throws(() => normalizeTemplateNode(inheritedNode), error => error.code === 'TEMPLATE_INVALID')

  const sparseReviewers = []
  sparseReviewers.length = 1
  assert.throws(
    () => normalizeTemplateNode(createNode({ reviewerUserIds: sparseReviewers })),
    error => error.code === 'TEMPLATE_INVALID'
  )

  const accessorReviewers = createNode()
  Object.defineProperty(accessorReviewers, 'reviewerUserIds', {
    enumerable: true,
    get() {
      getterCalls += 1
      return ['reviewer-1']
    }
  })
  assert.throws(() => normalizeTemplateNode(accessorReviewers), error => error.code === 'TEMPLATE_INVALID')
  assert.equal(getterCalls, 0)

  const inheritedReviewers = createNode()
  delete inheritedReviewers.reviewerUserIds
  Object.setPrototypeOf(inheritedReviewers, { reviewerUserIds: ['reviewer-1'] })
  assert.throws(() => normalizeTemplateNode(inheritedReviewers), error => error.code === 'TEMPLATE_INVALID')

  const accessorArray = []
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'reviewer-1'
    }
  })
  accessorArray.length = 1
  assert.throws(
    () => normalizeTemplateNode(createNode({ reviewerUserIds: accessorArray })),
    error => error.code === 'TEMPLATE_INVALID'
  )
  assert.equal(getterCalls, 0)

  assert.throws(
    () => normalizeTemplateNode(createNode({ assigneeUserIds: ['legacy-account'] })),
    error => error.code === 'TEMPLATE_INVALID'
  )
})

test('模板定义摘要绑定规范化节点内容并忽略存储元数据', () => {
  const original = createNode({ reviewerAssignmentMode: 'business_creator', reviewerUserIds: [] })
  const stored = { ...original, _id: 'stored-node', templateId: 'template-1', version: 7 }
  assert.equal(templateDefinitionDigest([original]), templateDefinitionDigest([stored]))
  assert.notEqual(
    templateDefinitionDigest([original]),
    templateDefinitionDigest([{ ...original, reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: ['reviewer-1'] }])
  )
})

test('流程版本二定义把入口、节点路由和条件字段纳入规范化摘要', () => {
  const entry = createNode({
    nodeKey: 'entry',
    fields: [
      { fieldKey: 'kind', sequence: 0, name: '类型', type: 'single_select', required: true, constraints: { options: ['简单', '复杂'] } },
      { fieldKey: 'detail', sequence: 1, name: '详情', type: 'short_text', condition: { parentFieldKey: 'kind', visibleWhen: ['复杂'] } }
    ],
    next: { mode: 'single_select', fieldKey: 'kind', optionTargets: { 简单: 'end', 复杂: 'detail-node' } }
  })
  const detail = createNode({ nodeKey: 'detail-node', sequence: 1, next: { mode: 'end' } })
  const input = { flowSchemaVersion: 2, entryNodeKey: 'entry', nodes: [entry, detail] }
  const definition = normalizeVersion2TemplateDefinition(input)

  assert.equal(definition.flowSchemaVersion, 2)
  assert.equal(definition.entryNodeKey, 'entry')
  assert.deepEqual(definition.nodes[0].fields[1].condition, {
    parentFieldKey: 'kind', visibleWhen: ['复杂']
  })
  assert.deepEqual(definition.nodes[0].next.optionTargets, { 简单: 'end', 复杂: 'detail-node' })
  assert.notEqual(
    version2TemplateDefinitionDigest(input),
    version2TemplateDefinitionDigest({
      ...input,
      nodes: [{ ...entry, next: { mode: 'single_select', fieldKey: 'kind', optionTargets: { 简单: 'detail-node', 复杂: 'detail-node' } } }, detail]
    })
  )
  assert.throws(
    () => version2TemplateDefinitionDigest({ ...input, entryNodeKey: 'detail-node' }),
    error => error.code === 'TEMPLATE_INVALID'
  )
})

test('负责人来源按节点独立规范化，旧节点默认固定账号且发起人模式不保留占位处理人', () => {
  const legacyShape = normalizeTemplateNode(createNode())
  const creatorAssigned = normalizeTemplateNode(createNode({
    processorAssignmentMode: 'business_creator',
    processorUserIds: []
  }))

  assert.equal(legacyShape.processorAssignmentMode, 'fixed_accounts')
  assert.deepEqual(legacyShape.processorUserIds, ['user-1'])
  assert.equal(creatorAssigned.processorAssignmentMode, 'business_creator')
  assert.deepEqual(creatorAssigned.processorUserIds, [])
  assert.deepEqual(
    collectTemplateParticipantUserIds([creatorAssigned]),
    ['reviewer-1'],
    '未来发起人不能使用伪账号占位，也不能进入模板固定参与人索引'
  )
  assert.equal(validateTemplateForEnable(
    { status: 'draft' },
    [creatorAssigned],
    ['reviewer-1']
  ), true)

  assert.throws(
    () => normalizeTemplateNode(createNode({
      processorAssignmentMode: 'business_creator',
      processorUserIds: ['user-1']
    })),
    error => error.code === 'TEMPLATE_INVALID'
  )
  assert.throws(
    () => normalizeTemplateNode(createNode({ processorAssignmentMode: 'round_robin' })),
    error => error.code === 'TEMPLATE_INVALID'
  )
})

test('负责人来源只接受自有数据属性，访问器或继承值不得执行或降级兼容', () => {
  let getterCalls = 0
  const accessorNode = createNode()
  Object.defineProperty(accessorNode, 'processorAssignmentMode', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'business_creator'
    }
  })
  assert.throws(() => normalizeTemplateNode(accessorNode), error => error.code === 'TEMPLATE_INVALID')
  assert.equal(getterCalls, 0)

  const inheritedNode = Object.assign(
    Object.create({ processorAssignmentMode: 'business_creator' }),
    createNode({ processorUserIds: [] })
  )
  assert.throws(() => normalizeTemplateNode(inheritedNode), error => error.code === 'TEMPLATE_INVALID')
})

test('拒绝无效双 SLA、审核配置、凭证规则和重复稳定键', () => {
  assert.deepEqual(normalizeTemplateNode(createNode({
    allowedEvidenceTypes: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'mov', 'm4v']
  })).allowedEvidenceTypes, ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'mov', 'm4v'])
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

test('启用前要求连续唯一节点键、启用处理人且角色严格分离', () => {
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
  assert.equal(validateTemplateForEnable(template, [{ ...first, reviewerUserIds: [] }], ['account-1']), true)
  assert.throws(() => validateTemplateForEnable(template, [{
    ...first,
    processorAssignmentMode: 'business_creator',
    processorUserIds: [],
    reviewerAssignmentMode: 'business_creator',
    reviewerUserIds: []
  }], []), error => error.code === 'ROLE_OVERLAP')
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

test('可选尾节点定义参与摘要且只能唯一位于模板末尾', () => {
  const required = normalizeTemplateNode(createNode())
  const optionalTail = normalizeTemplateNode(createNode({
    activationMode: 'optional_tail',
    reviewerUserIds: []
  }))

  assert.equal(ACTIVATION_MODE.REQUIRED, 'required')
  assert.equal(ACTIVATION_MODE.OPTIONAL_TAIL, 'optional_tail')
  assert.equal(required.activationMode, 'required')
  assert.equal(optionalTail.activationMode, 'optional_tail')
  assert.notEqual(templateDefinitionDigest([required]), templateDefinitionDigest([optionalTail]))

  assert.throws(() => validateTemplateForEnable(
    { status: 'draft' },
    [optionalTail],
    ['user-1']
  ), error => error.code === 'TEMPLATE_INVALID')

  assert.equal(validateTemplateForEnable(
    { status: 'draft' },
    [required, { ...optionalTail, nodeKey: 'second', sequence: 1 }],
    ['user-1', 'reviewer-1']
  ), true)

  assert.throws(() => validateTemplateForEnable({ status: 'draft' }, [
    { ...optionalTail, sequence: 0 },
    { ...required, nodeKey: 'second', sequence: 1 }
  ], ['user-1', 'reviewer-1']), error => error.code === 'TEMPLATE_INVALID')

  assert.throws(() => validateTemplateForEnable({ status: 'draft' }, [
    { ...optionalTail, sequence: 0 },
    { ...optionalTail, nodeKey: 'second', sequence: 1 }
  ], ['user-1']), error => error.code === 'TEMPLATE_INVALID')
})

test('activationMode 对未知值、访问器和继承属性失败关闭', () => {
  assert.throws(
    () => normalizeTemplateNode(createNode({ activationMode: 'sometimes' })),
    error => error.code === 'TEMPLATE_INVALID'
  )

  let getterCalls = 0
  const accessorNode = createNode()
  Object.defineProperty(accessorNode, 'activationMode', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'optional_tail'
    }
  })
  assert.throws(() => normalizeTemplateNode(accessorNode), error => error.code === 'TEMPLATE_INVALID')
  assert.equal(getterCalls, 0)

  const inheritedNode = Object.assign(Object.create({ activationMode: 'optional_tail' }), createNode())
  assert.throws(() => normalizeTemplateNode(inheritedNode), error => error.code === 'TEMPLATE_INVALID')
})

test('空固定审核人合法但处理人仍必需且角色交叉继续失败', () => {
  const reviewerless = createNode({ reviewerUserIds: [] })
  assert.equal(validateTemplateForEnable(
    { status: 'draft' },
    [reviewerless],
    ['user-1']
  ), true)

  assert.throws(() => validateTemplateForEnable(
    { status: 'draft' },
    [createNode({ processorUserIds: [], reviewerUserIds: [] })],
    []
  ), error => error.code === 'TEMPLATE_INVALID')

  assert.throws(() => validateTemplateForEnable(
    { status: 'draft' },
    [createNode({ reviewerUserIds: ['user-1'] })],
    ['user-1']
  ), error => error.code === 'ROLE_OVERLAP')
})

test('已完成节点转移分类区分普通下一节点、可选决定和真实终态', () => {
  const line = { nodeCount: 3 }
  assert.equal(classifyCompletedNodeTransition({
    line,
    node: { sequence: 0 },
    nextNode: { activationMode: 'required' }
  }), 'next_node')
  assert.equal(classifyCompletedNodeTransition({
    line,
    node: { sequence: 1 },
    nextNode: { activationMode: 'optional_tail' }
  }), 'await_optional_decision')
  assert.equal(classifyCompletedNodeTransition({
    line,
    node: { sequence: 2 },
    nextNode: null
  }), 'complete_line')
})
