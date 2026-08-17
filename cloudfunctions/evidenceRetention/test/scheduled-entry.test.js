const test = require('node:test')
const assert = require('node:assert/strict')

const { createScheduledHandler } = require('../index')

test('客户端、匿名调用和伪造事件均不能触发凭证清理', async () => {
  for (const [context, source] of [
    [{ OPENID: 'client-openid' }, 'timer'],
    [{}, ''],
    [{ TRIGGER_SRC: 'timer' }, '']
  ]) {
    let calls = 0
    const handler = createScheduledHandler({
      service: { async runOnce() { calls += 1; return {} } },
      getContext: () => context,
      getTriggerSource: () => source
    })
    await assert.rejects(
      handler({ Type: 'Timer', TRIGGER_SRC: 'timer' }),
      error => error.code === 'FORBIDDEN'
    )
    assert.equal(calls, 0)
  }
})

test('可信 Timer 忽略外部载荷并执行一次清理', async () => {
  const expected = {
    feedbackReservationsRecovered: 1,
    amendmentReservationsRecovered: 2,
    remindersCreated: 3,
    objectsPurged: 4,
    orphansPurged: 5,
    failures: { TRANSIENT: 1 }
  }
  let calls = 0
  const handler = createScheduledHandler({
    service: { async runOnce() { calls += 1; return expected } },
    getContext: () => ({}),
    getTriggerSource: () => 'timer'
  })
  assert.deepEqual(await handler({ fileId: 'forged', actorId: 'forged' }), expected)
  assert.equal(calls, 1)
})

test('定时入口忽略外部载荷并只返回安全汇总', async () => {
  const expected = {
    feedbackReservationsRecovered: 1,
    amendmentReservationsRecovered: 2,
    remindersCreated: 3,
    objectsPurged: 4,
    orphansPurged: 5,
    failures: { TRANSIENT: 1 }
  }
  let calls = 0
  const handler = createScheduledHandler({
    service: { async runOnce() { calls += 1; return expected } },
    getContext: () => ({}),
    getTriggerSource: () => 'timer'
  })
  assert.deepEqual(await handler({ fileId: 'forged', actorId: 'forged' }), expected)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(expected).includes('forged'), false)
})

test('定时入口要求有效服务', () => {
  assert.throws(() => createScheduledHandler({ service: {} }), /runOnce/)
})
