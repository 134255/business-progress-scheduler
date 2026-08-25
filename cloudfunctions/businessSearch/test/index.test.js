const test = require('node:test')
const assert = require('node:assert/strict')

const { createBusinessSearchHandler } = require('../index')

function service() {
  const calls = []
  return {
    calls,
    value: {
      async indexRequest(input) { calls.push(['indexRequest', input]); return { indexStatus: 'generated' } },
      async queryRequest(input) { calls.push(['queryRequest', input]); return { items: [] } },
      async runCycle(input) { calls.push(['runCycle', input]); return { examined: 0, generated: 0, failed: 0, cleaned: 0 } }
    }
  }
}

test('客户端身份、伪造事件定时器和错误大小写来源均被拒绝', async () => {
  for (const value of [
    { context: { OPENID: 'client' }, source: 'timer', event: {} },
    { context: {}, source: '', event: { Type: 'Timer' } },
    { context: {}, source: 'Timer', event: {} }
  ]) {
    const target = service()
    const handler = createBusinessSearchHandler({
      service: target.value, getContext: () => value.context, getTriggerSource: () => value.source
    })
    await assert.rejects(handler(value.event), { code: 'FORBIDDEN' })
    assert.equal(target.calls.length, 0)
  }
})

test('一次性票据选择索引或查询且不接受事件时钟与批量参数', async () => {
  const target = service()
  const handler = createBusinessSearchHandler({
    service: target.value, getContext: () => ({}), getTriggerSource: () => ''
  })
  await handler({ operation: 'index', ticket: 'index-ticket', now: 'forged', batchSize: 999 })
  await handler({ operation: 'query', ticket: 'query-ticket', now: 'forged', batchSize: 999 })
  assert.deepEqual(target.calls, [
    ['indexRequest', { token: 'index-ticket' }],
    ['queryRequest', { token: 'query-ticket' }]
  ])
})

test('可信平台 Timer 只使用服务端时间和固定四十条', async () => {
  const target = service()
  const now = new Date('2026-08-25T12:00:00.000Z')
  const handler = createBusinessSearchHandler({
    service: target.value, getContext: () => ({}), getTriggerSource: () => 'timer', clock: () => now
  })
  const result = await handler({ Type: 'Timer', now: 'forged', batchSize: 999 })
  assert.deepEqual(target.calls, [['runCycle', { now, batchSize: 40 }]])
  assert.deepEqual(result, { examined: 0, generated: 0, failed: 0, cleaned: 0 })
})

test('内部错误只记录稳定码并返回固定中文错误', async () => {
  const logs = []
  const handler = createBusinessSearchHandler({
    service: {
      async indexRequest() { throw new Error('cloud://private secret keyword') },
      async queryRequest() {},
      async runCycle() {}
    },
    getContext: () => ({}), getTriggerSource: () => '', logger: { error(...args) { logs.push(args) } }
  })
  await assert.rejects(handler({ operation: 'index', ticket: 'ticket' }), error =>
    error.code === 'BUSINESS_SEARCH_FAILED' && error.message === '售后检索服务暂时不可用，请稍后重试')
  assert.equal(JSON.stringify(logs).includes('cloud://'), false)
  assert.equal(JSON.stringify(logs).includes('keyword'), false)
  assert.equal(JSON.stringify(logs).includes('BUSINESS_SEARCH_FAILED'), true)
})
