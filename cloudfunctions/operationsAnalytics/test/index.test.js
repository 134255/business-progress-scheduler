'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOperationsAnalyticsHandler } = require('../index')

test('运营统计入口只信任平台 Timer 来源并忽略事件中的时间和批量', async () => {
  const calls = []
  const now = new Date('2026-08-19T03:00:00.000Z')
  const service = { async runCycle(value) { calls.push(value); return { nodeExamined: 2, businessExamined: 1, failed: 0, secret: 'hidden' } } }
  for (const [context, source] of [[{ OPENID: 'client' }, 'timer'], [{}, 'Timer'], [{ TRIGGER_SRC: 'timer' }, '']]) {
    const handler = createOperationsAnalyticsHandler({ service, getContext: () => context, getTriggerSource: () => source })
    await assert.rejects(handler({ Type: 'Timer' }), error => error.code === 'FORBIDDEN')
  }
  assert.equal(calls.length, 0)
  const handler = createOperationsAnalyticsHandler({ service, getContext: () => ({}), getTriggerSource: () => 'timer', clock: () => now })
  assert.deepEqual(await handler({ now: '2039-01-01', batchSize: 999 }), {
    nodeExamined: 2, businessExamined: 1, refreshExamined: 0,
    nodeGenerated: 0, businessGenerated: 0, refreshed: 0, failed: 0
  })
  assert.deepEqual(calls, [{ now, batchSize: 40 }])
})

test('运营统计失败只返回稳定中文错误且日志不含底层信息', async () => {
  const logs = []
  const handler = createOperationsAnalyticsHandler({
    service: { async runCycle() { throw new Error('secret index business_nodes') } },
    getContext: () => ({}), getTriggerSource: () => 'timer',
    logger: { error(event, detail) { logs.push([event, detail]) } }
  })
  await assert.rejects(handler({}), error => error.code === 'OPERATIONS_ANALYTICS_FAILED' && !/secret|index/i.test(error.message))
  assert.doesNotMatch(JSON.stringify(logs), /secret|index|business_nodes/i)
})
