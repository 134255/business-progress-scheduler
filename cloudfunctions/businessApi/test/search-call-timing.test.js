const test = require('node:test')
const assert = require('node:assert/strict')
const { createCreationTiming } = require('../lib/creation-timing')
const { createBusinessSearchClient } = require('../lib/business-search-client')
const { createBusinessService } = require('../lib/business-service')
const { synchronizeSearchResult } = require('../lib/search-version')

const envelope = { actorId: 'synthetic-actor', businessLineId: 'synthetic-line', sourceVersion: 1 }
const stored = { publicResult: { id: 'synthetic-line', code: 'SYNTHETIC-CODE' }, searchEnvelope: envelope }

function fixture({ saveError, callError, logger, invalidClock = false } = {}) {
  let now = 0
  const logs = [], writes = [], calls = []
  const timing = createCreationTiming({ now: () => invalidClock ? NaN : now,
    logger: logger || { info: (...args) => logs.push(args) } })
  const client = createBusinessSearchClient({ secret: 'synthetic-search-secret-for-tests-12345678',
    clock: () => new Date('2026-10-09T00:00:00Z'), randomBytes: n => Buffer.alloc(n, 3),
    db: { collection(name) { return { doc(id) { return { async set({ data }) {
      now += 11; writes.push({ name, id, data }); if (saveError) throw saveError
    } } } } } },
    callFunction: async input => { now += 37; calls.push(input)
      if (callError) throw callError
      return { result: { indexStatus: 'generated' } }
    }
  })
  return { client, timing, logs, writes, calls }
}

test('real creation service threads request-local timing to ticket save and invocation without payload changes', async () => {
  const h = fixture()
  const service = createBusinessService({ repository: { createBusinessSnapshot: async () => stored },
    workTimeService: { tryAddWorkMinutes() {} }, businessSearchClient: h.client })
  const result = await service.createFromTemplate({ actor: { _id: 'synthetic-actor', status: 'active', role: 'user' },
    input: { templateId: 'synthetic-template', requestKey: 'synthetic-create', description: '' }, creationTiming: h.timing })
  h.timing.finish('OK')
  assert.equal(result, stored.publicResult)
  const stages = h.logs[0][1].stages
  assert.deepEqual(stages.search_ticket_save, { durationMs: 11, calls: 1, failedCalls: 0, incompleteCalls: 0 })
  assert.deepEqual(stages.search_function_call, { durationMs: 37, calls: 1, failedCalls: 0, incompleteCalls: 0 })
  assert.equal(stages.search_sync.durationMs, 48)
  assert.equal(h.writes.length, 1); assert.equal(h.calls.length, 1)
  assert.deepEqual(Object.keys(h.calls[0]).sort(), ['data', 'name'])
  assert.deepEqual(Object.keys(h.calls[0].data).sort(), ['operation', 'ticket'])
  assert.deepEqual(Object.keys(h.writes[0].data).sort(),
    ['actorId', 'businessLineId', 'createdAt', 'expiresAt', 'operation', 'sourceVersion', 'status'])
  const output = JSON.stringify(h.logs)
  for (const value of ['synthetic-', h.calls[0].data.ticket, h.writes[0].id]) assert.equal(output.includes(value), false)
})

for (const phase of ['save', 'call']) {
  test(`failed ${phase} is timed once and keeps pending-index fallback without recreating business data`, async () => {
    const failure = new Error('synthetic-private-error')
    const h = fixture(phase === 'save' ? { saveError: failure } : { callError: failure })
    const result = await synchronizeSearchResult(stored, h.client, h.timing)
    h.timing.finish('OK')
    assert.deepEqual(result, { ...stored.publicResult, searchIndexStatus: 'pending' })
    const stages = h.logs[0][1].stages
    assert.equal(stages.search_ticket_save?.failedCalls, phase === 'save' ? 1 : 0)
    assert.equal(stages.search_function_call?.failedCalls, phase === 'call' ? 1 : undefined)
    assert.equal(h.writes.length, 1); assert.equal(h.calls.length, phase === 'call' ? 1 : 0)
    assert.equal(JSON.stringify(h.logs).includes('synthetic-'), false)
  })
}

test('timing preserves direct client errors and missing-envelope behavior', async () => {
  const failure = new Error('synthetic-db-error')
  const h = fixture({ saveError: failure })
  await assert.rejects(h.client.ensureIndexed(envelope, h.timing), error => error === failure)
  assert.equal(await h.client.ensureIndexed(null, h.timing), null)
  await assert.rejects(h.client.ensureIndexed({}, h.timing), { code: 'SEARCH_STATE_INVALID' })
  h.timing.finish('ERROR')
  assert.equal(h.logs[0][1].stages.search_ticket_save?.failedCalls, 1)
  assert.equal(h.calls.length, 0)
})

test('untimed adapters keep their one-argument contract and ordinary queries do not emit creation diagnostics', async () => {
  await synchronizeSearchResult(stored, { async ensureIndexed(...args) { assert.deepEqual(args, [envelope]) } })
  const h = fixture()
  await h.client.ensureIndexed(envelope)
  await h.client.query({ actorId: 'synthetic-actor', query: { keyword: 'synthetic-keyword' } })
  h.timing.finish('OK')
  assert.deepEqual(h.logs[0][1].stages, {})
  assert.equal(h.writes.length, 2); assert.equal(h.calls.length, 2)
})

test('concurrent calls never overwrite the request-local timing context', async () => {
  const h = fixture()
  const logs = []
  const second = createCreationTiming({ now: () => 0, logger: { info: (_, event) => logs.push(event) } })
  await Promise.all([synchronizeSearchResult(stored, h.client, h.timing), synchronizeSearchResult(stored, h.client, second)])
  h.timing.finish('OK'); second.finish('OK')
  for (const event of [h.logs[0][1], logs[0]]) {
    assert.equal(event.stages.search_ticket_save?.calls, 1)
    assert.equal(event.stages.search_function_call?.calls, 1)
  }
})

test('broken diagnostic clocks and sinks cannot change creation-search result', async () => {
  for (const logger of [{ info() { throw new Error('sink down') } },
    { info() { return Promise.reject(new Error('sink down')) } }]) {
    const h = fixture({ invalidClock: true, logger })
    assert.equal(await synchronizeSearchResult(stored, h.client, h.timing), stored.publicResult)
    h.timing.finish('OK')
    assert.equal(h.writes.length, 1); assert.equal(h.calls.length, 1)
  }
  await new Promise(resolve => setImmediate(resolve))
})
