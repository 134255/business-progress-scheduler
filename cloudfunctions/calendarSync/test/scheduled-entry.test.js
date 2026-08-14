'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCalendarSyncHandler } = require('../index')

test('客户端直调与伪造计划事件都被拒绝', async () => {
  const calls = []
  const handler = createCalendarSyncHandler({
    service: { async run(input) { calls.push(input); return { ok: true } } },
    getContext: () => ({ OPENID: 'client-openid' }),
    getTriggerSource: () => 'timer'
  })
  await assert.rejects(handler({ Type: 'Timer', mode: 'scheduled', now: '2039-01-01' }), error => error.code === 'FORBIDDEN')
  assert.equal(calls.length, 0)
})
test('匿名或服务端调用伪造事件和微信上下文不能获得计划权限', async () => {
  const calls = []
  const handler = createCalendarSyncHandler({
    service: { async run(input) { calls.push(input); return { ok: true } }, },
    getContext: () => ({ TRIGGER_SRC: 'timer' }),
    getTriggerSource: () => ''
  })
  await assert.rejects(handler({ Type: 'Timer' }), error => error.code === 'FORBIDDEN')
  assert.equal(calls.length, 0)
})

test('合法可信 Timer 只使用服务端时钟', async () => {
  const calls = []
  const now = new Date('2026-08-11T03:00:00.000Z')
  const handler = createCalendarSyncHandler({
    service: { async run(input) { calls.push(input); return { ok: true } } },
    getContext: () => ({}),
    getTriggerSource: () => 'timer',
    clock: () => now
  })
  assert.deepEqual(await handler({ Type: 'forged-client-data', now: '2039-01-01T00:00:00Z' }), { ok: true })
  assert.deepEqual(calls, [{ mode: 'scheduled', now }])
})

test('合法人工票据一次性消费且失败不泄漏数据库细节', async () => {
  const calls = []
  const logs = []
  let consumed = false
  const handler = createCalendarSyncHandler({
    service: { async run(input) { calls.push(input); throw new Error('index business_nodes_processingDueStatus on business_nodes missing') } },
    manualAuthorizer: { async consume(id) { if (id !== 'request-1' || consumed) return false; consumed = true; return true } },
    getContext: () => ({}),
    getTriggerSource: () => '',
    clock: () => new Date('2026-08-11T03:00:00.000Z'),
    logger: { error(event, detail) { logs.push([event, detail]) } }
  })
  await assert.rejects(handler({ manualRequestId: 'request-1', now: '2039-01-01' }), error => {
    assert.equal(error.code, 'CALENDAR_SYNC_FAILED')
    assert.match(error.message, /同步失败/)
    assert.doesNotMatch(error.message, /business_nodes|index/i)
    return true
  })
  assert.equal(calls[0].mode, 'manual')
  assert.equal(logs.length, 1)
  assert.doesNotMatch(JSON.stringify(logs), /business_nodes|index/i)
  await assert.rejects(handler({ manualRequestId: 'request-1' }), error => error.code === 'FORBIDDEN')
})

test('可信 Timer 不能绕过人工票据，错误来源失败关闭', async () => {
  for (const source of ['Timer', null]) {
    let calls = 0
    const handler = createCalendarSyncHandler({
      service: { async run() { calls += 1; return {} } },
      getContext: () => ({}),
      getTriggerSource: () => source
    })
    await assert.rejects(handler({ Type: 'Timer' }), error => error.code === 'FORBIDDEN')
    assert.equal(calls, 0)
  }

  let consumed = 0
  const handler = createCalendarSyncHandler({
    service: { async run() { return { ok: true } } },
    manualAuthorizer: { async consume() { consumed += 1; return true } },
    getContext: () => ({}),
    getTriggerSource: () => 'timer'
  })
  assert.deepEqual(await handler({ manualRequestId: 'manual-request' }), { ok: true })
  assert.equal(consumed, 1)
})
