const test = require('node:test')
const assert = require('node:assert/strict')
const { createIndexTiming, measureIndexStage, countIndexOperation } = require('../lib/index-timing')

function fixture(now) {
  const events = []
  return { events, timing: createIndexTiming({ now, logger: { info: (_, event) => events.push(event) } }) }
}

test('parent and overlapping child stages retain separate elapsed times in a single fixed summary', () => {
  let now = 0
  const { events, timing } = fixture(() => now)
  const parent = timing.start('generation_publish')
  now = 10
  const child = timing.start('generation_writes')
  now = 30; child(); child('ERROR')
  now = 50; parent()
  countIndexOperation(timing, 'entry_write_attempts')
  timing.finish('OK'); timing.finish('ERROR')
  assert.deepEqual(events, [{ schemaVersion: 1, action: 'index', outcome: 'OK', durationMs: 50,
    stages: {
      generation_publish: { durationMs: 50, calls: 1, failedCalls: 0, incompleteCalls: 0 },
      generation_writes: { durationMs: 20, calls: 1, failedCalls: 0, incompleteCalls: 0 }
    }, counters: { entry_write_attempts: 1 } }])
})

test('phase and counter whitelists discard unknown names without coercing values', () => {
  const { events, timing } = fixture(() => 0)
  for (const value of ['private-id', '__proto__', 'constructor', null, { toString() { throw new Error('unsafe') } }]) {
    timing.start(value)(); countIndexOperation(timing, value)
  }
  timing.finish('private-error')
  assert.deepEqual(events[0].stages, {})
  assert.deepEqual(events[0].counters, {})
  assert.equal(events[0].outcome, 'ERROR')
  assert.equal(JSON.stringify(events).includes('private-'), false)
})

test('a finished summary is immutable to late closure, stage and counter calls', () => {
  let now = 0
  const { events, timing } = fixture(() => now)
  const pending = timing.start('publication_reads')
  now = 7; timing.finish('ERROR')
  assert.deepEqual(events[0].stages.publication_reads,
    { durationMs: 7, calls: 1, failedCalls: 0, incompleteCalls: 1 })
  const before = JSON.stringify(events)
  pending(); timing.start('entries_build')(); timing.count('ticket_attempts')
  assert.equal(JSON.stringify(events), before)
})

test('repeated calls and counters saturate and total/stage durations stay bounded', () => {
  let now = 0
  const { events, timing } = fixture(() => now)
  for (let i = 0; i < 1010; i++) {
    const end = timing.start('publication_reads')
    now += 4000000; end('ERROR')
  }
  for (let i = 0; i < 100010; i++) timing.count('token_write_attempts')
  timing.finish('ERROR')
  assert.deepEqual(events[0].stages.publication_reads,
    { durationMs: 3600000, calls: 1000, failedCalls: 1000, incompleteCalls: 0 })
  assert.equal(events[0].durationMs, 3600000)
  assert.equal(events[0].counters.token_write_attempts, 100000)
})

test('unavailable or backwards clocks are unknown, including repeated stage accumulation', () => {
  for (const invalid of [NaN, Infinity, -1]) {
    let now = 0
    const { events, timing } = fixture(() => now)
    const end = timing.start('snapshot_load')
    now = invalid; end()
    now = 0; timing.start('snapshot_load')()
    now = invalid; timing.finish('OK')
    assert.equal(events[0].durationMs, null)
    assert.equal(events[0].stages.snapshot_load.durationMs, null)
    assert.equal(events[0].stages.snapshot_load.calls, 2)
  }
})

test('measurement preserves values and original errors without logging their content', async () => {
  const { events, timing } = fixture()
  const value = { secret: 'private-result' }
  const error = new Error('private-error')
  assert.equal(await measureIndexStage(timing, 'entries_build', () => value), value)
  await assert.rejects(measureIndexStage(timing, 'entries_build', () => { throw error }), e => e === error)
  timing.finish('ERROR')
  assert.equal(events[0].stages.entries_build.calls, 2)
  assert.equal(events[0].stages.entries_build.failedCalls, 1)
  assert.equal(JSON.stringify(events).includes('private-'), false)
})

test('absent timing context preserves operation call count and return/error identity', async () => {
  const value = {}
  const error = new Error('original')
  let calls = 0
  countIndexOperation(undefined, 'ticket_attempts')
  assert.equal(await measureIndexStage(undefined, 'snapshot_load', () => { calls++; return value }), value)
  await assert.rejects(measureIndexStage(undefined, 'snapshot_load', () => { calls++; throw error }), e => e === error)
  assert.equal(calls, 2)
})
