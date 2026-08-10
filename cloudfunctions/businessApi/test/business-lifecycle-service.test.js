const test = require('node:test')
const assert = require('node:assert/strict')

const { createBusinessLifecycleService } = require('../lib/business-lifecycle-service')

function createHarness() {
  const calls = []
  const repository = {
    async rejectPreviousNode(input) {
      calls.push(input)
      return {
        businessLineId: input.lineId,
        previousNodeId: 'node-1',
        currentNodeId: input.currentNodeId,
        previousVersion: input.expectedPreviousVersion + 1,
        currentVersion: input.expectedCurrentVersion + 1
      }
    },
    async closeBusinessLine(input) {
      calls.push(input)
      return {
        businessLineId: input.lineId,
        status: input.outcome,
        version: input.expectedVersion + 1
      }
    },
    async amendFrozenBusiness(input) {
      calls.push(input)
      return {
        businessLineId: input.lineId,
        amendmentId: 'business-amend-line-1-10',
        version: input.expectedVersion + 1
      }
    }
  }
  return {
    service: createBusinessLifecycleService({ repository }),
    repository,
    calls,
    actor: { _id: 'account-b', status: 'active', role: 'user' }
  }
}

function validClosure(overrides = {}) {
  return {
    businessLineId: 'line-1',
    expectedVersion: 8,
    outcome: 'closed',
    reason: ' 客户主动终止业务 ',
    ...overrides
  }
}

function validAmendment(overrides = {}) {
  return {
    businessLineId: 'line-1',
    expectedVersion: 9,
    reason: ' 审计发现业务名称需要更正 ',
    changes: {
      name: ' 更正后的名称 ',
      description: ' 更正后的说明 ',
      plannedStartDate: '2026-08-01',
      plannedEndDate: '2026-08-08',
      status: 'closed'
    },
    evidenceIds: ['evidence-a', 'evidence-b'],
    ...overrides
  }
}

function validRejection(overrides = {}) {
  return {
    businessLineId: 'line-1',
    currentNodeId: 'node-2',
    expectedCurrentVersion: 3,
    expectedPreviousVersion: 5,
    reason: ' 上一节点资料需要补充 ',
    requestKey: 'reject-20260810-001',
    ...overrides
  }
}

test('驳回服务只向仓储传递规范化后的受控参数', async () => {
  const harness = createHarness()
  const result = await harness.service.rejectPreviousNode({
    actor: harness.actor,
    input: validRejection()
  })

  assert.deepEqual(result, {
    businessLineId: 'line-1',
    previousNodeId: 'node-1',
    currentNodeId: 'node-2',
    previousVersion: 6,
    currentVersion: 4
  })
  assert.deepEqual(harness.calls, [{
    actor: harness.actor,
    lineId: 'line-1',
    currentNodeId: 'node-2',
    expectedCurrentVersion: 3,
    expectedPreviousVersion: 5,
    reason: '上一节点资料需要补充',
    requestKey: 'reject-20260810-001'
  }])
})

test('驳回服务在调用仓储前拒绝失效账号和非法输入', async t => {
  const invalidCases = [
    ['账号缺失', null, validRejection(), 'FORBIDDEN'],
    ['账号停用', { _id: 'account-b', status: 'disabled' }, validRejection(), 'FORBIDDEN'],
    ['业务线编号非法', { _id: 'account-b', status: 'active' }, validRejection({ businessLineId: ' ' }), 'VALIDATION_ERROR'],
    ['当前节点编号非法', { _id: 'account-b', status: 'active' }, validRejection({ currentNodeId: '../node' }), 'VALIDATION_ERROR'],
    ['当前节点版本缺失', { _id: 'account-b', status: 'active' }, validRejection({ expectedCurrentVersion: 0 }), 'VALIDATION_ERROR'],
    ['上一节点版本非法', { _id: 'account-b', status: 'active' }, validRejection({ expectedPreviousVersion: 1.5 }), 'VALIDATION_ERROR'],
    ['原因为空', { _id: 'account-b', status: 'active' }, validRejection({ reason: '  ' }), 'VALIDATION_ERROR'],
    ['原因过长', { _id: 'account-b', status: 'active' }, validRejection({ reason: '原'.repeat(501) }), 'VALIDATION_ERROR'],
    ['请求键非法', { _id: 'account-b', status: 'active' }, validRejection({ requestKey: 'bad key' }), 'VALIDATION_ERROR'],
    ['出现未声明字段', { _id: 'account-b', status: 'active' }, validRejection({ previousNodeId: 'forged' }), 'VALIDATION_ERROR']
  ]

  for (const [name, actor, input, code] of invalidCases) {
    await t.test(name, async () => {
      const harness = createHarness()
      await assert.rejects(
        harness.service.rejectPreviousNode({ actor, input }),
        error => error.code === code
      )
      assert.deepEqual(harness.calls, [])
    })
  }
})

test('驳回输入必须是只包含自有数据属性的普通对象', async () => {
  const inherited = Object.create({ requestKey: 'reject-inherited' })
  Object.assign(inherited, validRejection())
  delete inherited.requestKey
  const harness = createHarness()

  await assert.rejects(
    harness.service.rejectPreviousNode({ actor: harness.actor, input: inherited }),
    error => error.code === 'VALIDATION_ERROR'
  )
  assert.deepEqual(harness.calls, [])
})

test('关闭服务规范化终态和原因后调用仓储', async () => {
  const harness = createHarness()
  const result = await harness.service.closeBusinessLine({
    actor: harness.actor,
    input: validClosure()
  })

  assert.deepEqual(result, { businessLineId: 'line-1', status: 'closed', version: 9 })
  assert.deepEqual(harness.calls, [{
    actor: harness.actor,
    lineId: 'line-1',
    expectedVersion: 8,
    outcome: 'closed',
    reason: '客户主动终止业务'
  }])
})

test('关闭服务拒绝非法终态、空原因、非法版本和额外字段', async () => {
  const actor = { _id: 'account-b', status: 'active' }
  for (const input of [
    validClosure({ outcome: 'completed' }),
    validClosure({ outcome: 'active' }),
    validClosure({ reason: ' ' }),
    validClosure({ reason: '原'.repeat(501) }),
    validClosure({ expectedVersion: 0 }),
    validClosure({ code: 'FORGED' })
  ]) {
    const harness = createHarness()
    await assert.rejects(
      harness.service.closeBusinessLine({ actor, input }),
      error => error.code === 'VALIDATION_ERROR'
    )
    assert.deepEqual(harness.calls, [])
  }
})

test('超级管理员修订服务只接收白名单字段和去重后的修订附件', async () => {
  const harness = createHarness()
  const actor = { _id: 'root', status: 'active', role: 'super_admin' }
  const result = await harness.service.amendFrozenBusiness({ actor, input: validAmendment() })

  assert.deepEqual(result, {
    businessLineId: 'line-1', amendmentId: 'business-amend-line-1-10', version: 10
  })
  assert.deepEqual(harness.calls, [{
    actor,
    lineId: 'line-1',
    expectedVersion: 9,
    reason: '审计发现业务名称需要更正',
    changes: {
      name: '更正后的名称',
      description: '更正后的说明',
      plannedStartDate: '2026-08-01',
      plannedEndDate: '2026-08-08',
      status: 'closed'
    },
    evidenceIds: ['evidence-a', 'evidence-b']
  }])
})

test('修订服务拒绝非超级管理员、可变结构字段和非法附件', async () => {
  const root = { _id: 'root', status: 'active', role: 'super_admin' }
  const cases = [
    [{ _id: 'user', status: 'active', role: 'user' }, validAmendment()],
    [root, validAmendment({ reason: ' ' })],
    [root, validAmendment({ expectedVersion: 0 })],
    [root, validAmendment({ changes: { code: 'FORGED' } })],
    [root, validAmendment({ changes: { managerUserIds: ['root'] } })],
    [root, validAmendment({ changes: { name: ' ' } })],
    [root, validAmendment({ changes: { status: 'active' } })],
    [root, validAmendment({ changes: { plannedStartDate: '2026-02-30' } })],
    [root, validAmendment({ changes: {}, evidenceIds: [] })],
    [root, validAmendment({ evidenceIds: ['evidence-a', 'evidence-a'] })],
    [root, validAmendment({ evidenceIds: ['../evidence'] })],
    [root, { ...validAmendment(), requestKey: 'not-declared' }]
  ]
  for (const [actor, input] of cases) {
    const harness = createHarness()
    await assert.rejects(
      harness.service.amendFrozenBusiness({ actor, input }),
      error => ['FORBIDDEN', 'VALIDATION_ERROR', 'EVIDENCE_NOT_ATTACHABLE'].includes(error.code)
    )
    assert.deepEqual(harness.calls, [])
  }
})
