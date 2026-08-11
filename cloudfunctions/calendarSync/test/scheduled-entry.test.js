'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCalendarSyncHandler } = require('../index')

test('客户端直调与伪造计划事件都被拒绝', async () => {
  const calls = []
  const handler = createCalendarSyncHandler({ service: {
    async run(input) { calls.push(input); return { ok: true } }
  }, getContext: () => ({ OPENID: 'client-openid' }) })
  await assert.rejects(handler({ Type: 'Timer', mode: 'scheduled', now: '2039-01-01' }), error => error.code === 'FORBIDDEN')
  assert.equal(calls.length, 0)
})

test('合法计划触发只使用服务端时钟', async () => {
  const calls = []
  const now = new Date('2026-08-11T03:00:00.000Z')
  const handler = createCalendarSyncHandler({
    service: { async run(input) { calls.push(input); return { ok: true } } },
    getContext: () => ({}), clock: () => now
  })
  assert.deepEqual(await handler({ Type: 'Timer', now: '2039-01-01T00:00:00Z' }), { ok: true })
  assert.deepEqual(calls, [{ mode: 'scheduled', now }])
})

test('合法人工票据一次性消费且失败不泄漏数据库细节', async () => {
  const calls = []
  const logs = []
  let consumed = false
  const handler = createCalendarSyncHandler({
    service: { async run(input) { calls.push(input); throw new Error('index business_nodes_processingDueStatus on business_nodes missing') } },
    manualAuthorizer: { async consume(id) { if (id !== 'request-1' || consumed) return false; consumed = true; return true } },
    getContext: () => ({}), clock: () => new Date('2026-08-11T03:00:00.000Z'),
    logger: { error(event, detail) { logs.push([event, detail]) } }
  })
  await assert.rejects(handler({ manualRequestId: 'request-1', now: '2039-01-01' }), error => {
    assert.equal(error.code, 'CALENDAR_SYNC_FAILED')
    assert.match(error.message, /\u540c\u6b65失败/)
    assert.doesNotMatch(error.message, /business_nodes|index/i)
    return true
  })
  assert.equal(calls[0].mode, 'manual')
  assert.equal(logs.length, 1)
  assert.doesNotMatch(JSON.stringify(logs), /business_nodes|index/i)
  await assert.rejects(handler({ manualRequestId: 'request-1' }), error => error.code === 'FORBIDDEN')
})
