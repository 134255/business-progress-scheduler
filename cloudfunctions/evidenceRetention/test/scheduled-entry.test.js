const test = require('node:test')
const assert = require('node:assert/strict')

const { createScheduledHandler } = require('../index')

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
  const handler = createScheduledHandler({ service: { async runOnce() { calls += 1; return expected } } })
  assert.deepEqual(await handler({ fileId: 'forged', actorId: 'forged' }), expected)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(expected).includes('forged'), false)
})

test('定时入口要求有效服务', () => {
  assert.throws(() => createScheduledHandler({ service: {} }), /runOnce/)
})
