const test = require('node:test')
const assert = require('node:assert/strict')
const { createCreationTiming, measureCreationStage, startCreationStage, countCreationAttempt } = require('../lib/creation-timing')

test('creation timing emits one bounded, value-free summary with overlapping stages kept separate', async () => {
  let now = 10
  const logs = []
  const timing = createCreationTiming({ now: () => now, logger: { info: (...args) => logs.push(args) } })
  const endSearch = startCreationStage(timing, 'search_sync')
  now = 20
  const endCard = startCreationStage(timing, 'card_refresh')
  now = 40; endSearch(); endSearch()
  now = 50; endCard()
  countCreationAttempt(timing, 'reservation_attempts')
  countCreationAttempt(timing, 'reservation_attempts')
  startCreationStage(timing, 'private-customer-value')()
  countCreationAttempt(timing, 'private-id')
  timing.finish('OK'); timing.finish('ERROR')
  assert.equal(logs.length, 1)
  assert.deepEqual(logs[0], ['[businessApi.creationTiming]', {
    schemaVersion: 1, action: 'createBusinessFromTemplate', outcome: 'OK', durationMs: 40,
    stages: {
      search_sync: { durationMs: 30, calls: 1, failedCalls: 0, incompleteCalls: 0 },
      card_refresh: { durationMs: 30, calls: 1, failedCalls: 0, incompleteCalls: 0 }
    }, counters: { reservation_attempts: 2 }
  }])
})

test('timed operation preserves return identity and the original error without logging either', async () => {
  const logs = []
  const timing = createCreationTiming({ logger: { info: (...args) => logs.push(args) } })
  const value = { customer: 'DO-NOT-LOG', token: 'DO-NOT-LOG' }
  const error = new Error('DO-NOT-LOG')
  assert.equal(await measureCreationStage(timing, 'authorize', () => value), value)
  await assert.rejects(measureCreationStage(timing, 'reservation_transaction', () => { throw error }), e => e === error)
  timing.finish('ERROR')
  assert.equal(logs[0][1].stages.reservation_transaction.failedCalls, 1)
  assert.equal(JSON.stringify(logs).includes('DO-NOT-LOG'), false)
})

test('unfinished synchronous preparation is reported without fabricating successful completion', () => {
  let now = 0
  const logs = []
  const timing = createCreationTiming({ now: () => now, logger: { info: (_, event) => logs.push(event) } })
  startCreationStage(timing, 'snapshot_prepare')
  now = 7; timing.finish('ERROR')
  assert.deepEqual(logs[0].stages.snapshot_prepare,
    { durationMs: 7, calls: 1, failedCalls: 0, incompleteCalls: 1 })
})

test('clock and logger failures never replace the business result or rejection', async () => {
  for (const logger of [undefined, { info() { throw new Error('logger down') } },
    { info() { return Promise.reject(new Error('logger down')) } },
    Object.defineProperty({}, 'info', { get() { throw new Error('logger getter') } })]) {
    const timing = createCreationTiming({ now() { throw new Error('clock down') }, logger })
    let calls = 0
    assert.equal(await measureCreationStage(timing, 'authorize', () => { calls++; return 42 }), 42)
    assert.equal(calls, 1)
    const failure = new Error('business failure')
    await assert.rejects(measureCreationStage(timing, 'authorize', () => { throw failure }), e => e === failure)
    assert.doesNotThrow(() => timing.finish('ERROR'))
  }
  await new Promise(resolve => setImmediate(resolve))
})

test('invalid clocks remain unknown rather than false zero timings; counters saturate', () => {
  const logs = []
  const timing = createCreationTiming({ now: () => NaN, logger: { info: (_, event) => logs.push(event) } })
  startCreationStage(timing, 'authorize')()
  for (let i = 0; i < 1010; i++) countCreationAttempt(timing, 'reservation_attempts')
  timing.finish('private error message')
  assert.equal(logs[0].durationMs, null)
  assert.equal(logs[0].stages.authorize.durationMs, null)
  assert.equal(logs[0].counters.reservation_attempts, 1000)
  assert.equal(logs[0].outcome, 'ERROR')
  assert.equal(JSON.stringify(logs).includes('private error'), false)
})

test('absent diagnostic context leaves operations untouched', async () => {
  startCreationStage(undefined, 'authorize')()
  countCreationAttempt(undefined, 'reservation_attempts')
  assert.equal(await measureCreationStage(undefined, 'authorize', () => 5), 5)
})
