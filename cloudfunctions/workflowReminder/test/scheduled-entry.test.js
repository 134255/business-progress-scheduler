'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorkflowReminderHandler } = require('../index')

test('客户端、匿名调用、伪造事件和伪造微信上下文均不能获得计划权限', async () => {
  for (const context of [{ OPENID: 'client-openid', TRIGGER_SRC: 'timer' }, { TRIGGER_SRC: 'timer' }, {}]) {
    const calls = []
    const handler = createWorkflowReminderHandler({
      service: { async runReminderCycle(input) { calls.push(input); return { processingCreated: 1, reviewCreated: 1 } } },
      getContext: () => context,
      getTriggerSource: () => ''
    })
    await assert.rejects(handler({ Type: 'Timer', now: '2039-01-01' }), error => error.code === 'FORBIDDEN')
    assert.equal(calls.length, 0)
  }
})
test('合法可信 Timer 只使用服务端时钟和固定批量并返回脱敏计数', async () => {
  const calls = []
  const now = new Date('2026-08-11T03:00:00.000Z')
  const handler = createWorkflowReminderHandler({
    service: {
      async runReminderCycle(input) {
        calls.push(input)
        return { processingCreated: 2, reviewCreated: 3, cursorId: 'secret', candidateIds: ['secret'] }
      }
    },
    getContext: () => ({}),
    getTriggerSource: () => 'timer',
    clock: () => now
  })
  assert.deepEqual(await handler({ Type: 'forged', now: '2039-01-01T00:00:00Z', batchSize: 999 }), {
    processingCreated: 2, reviewCreated: 3
  })
  assert.deepEqual(calls, [{ now, batchSize: 40 }])
})

test('运行失败只记录安全分类并返回通用错误', async () => {
  const logs = []
  const handler = createWorkflowReminderHandler({
    service: { async runReminderCycle() { throw new Error('index business_nodes secret missing') } },
    getContext: () => ({}),
    getTriggerSource: () => 'timer',
    logger: { error(event, detail) { logs.push([event, detail]) } }
  })
  await assert.rejects(handler({}), error => {
    assert.equal(error.code, 'WORKFLOW_REMINDER_FAILED')
    assert.doesNotMatch(error.message, /business_nodes|index|secret/i)
    return true
  })
  assert.doesNotMatch(JSON.stringify(logs), /business_nodes|index|secret/i)
})

test('可信 Timer 仍拒绝带客户端身份的调用，错误来源也失败关闭', async () => {
  for (const [context, source] of [[{ OPENID: 'client-openid' }, 'timer'], [{}, 'Timer'], [{}, null]]) {
    let calls = 0
    const handler = createWorkflowReminderHandler({
      service: { async runReminderCycle() { calls += 1; return {} } },
      getContext: () => context,
      getTriggerSource: () => source
    })
    await assert.rejects(handler({ Type: 'Timer' }), error => error.code === 'FORBIDDEN')
    assert.equal(calls, 0)
  }
})
