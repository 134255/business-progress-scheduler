'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorkflowReminderHandler } = require('../index')

test('客户端、匿名调用和伪造 event.Type 均不能获得计划权限', async () => {
  for (const context of [{ OPENID: 'client-openid', TRIGGER_SRC: 'timer' }, {}]) {
    const calls = []
    const handler = createWorkflowReminderHandler({
      service: { async runReminderCycle(input) { calls.push(input); return { processingCreated: 1, reviewCreated: 1 } } },
      getContext: () => context
    })
    await assert.rejects(handler({ Type: 'Timer', now: '2039-01-01' }), error => error.code === 'FORBIDDEN')
    assert.equal(calls.length, 0)
  }
})

test('合法计划触发只使用服务端时钟和固定批量并返回脱敏计数', async () => {
  const calls = []
  const now = new Date('2026-08-11T03:00:00.000Z')
  const handler = createWorkflowReminderHandler({
    service: {
      async runReminderCycle(input) {
        calls.push(input)
        return { processingCreated: 2, reviewCreated: 3, cursorId: 'secret', candidateIds: ['secret'] }
      }
    },
    getContext: () => ({ TRIGGER_SRC: 'timer' }), clock: () => now
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
    getContext: () => ({ TRIGGER_SRC: 'timer' }),
    logger: { error(event, detail) { logs.push([event, detail]) } }
  })
  await assert.rejects(handler({}), error => {
    assert.equal(error.code, 'WORKFLOW_REMINDER_FAILED')
    assert.doesNotMatch(error.message, /business_nodes|index|secret/i)
    return true
  })
  assert.doesNotMatch(JSON.stringify(logs), /business_nodes|index|secret/i)
})
