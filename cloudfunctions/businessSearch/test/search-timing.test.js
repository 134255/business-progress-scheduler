const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createSearchService } = require('../lib/search-service')
const { createCloudSearchRepository } = require('../lib/cloud-search-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const SECRET = 'search-timing-test-only-secret-1234567890'
const TOKEN = 'private-test-ticket-never-log'
const NOW = new Date('2026-10-08T10:00:00Z')
const ticketId = crypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex')

function fixture({ current = false, options = {}, logger, timingNow } = {}) {
  const logs = []
  const search = { searchSourceVersion: 1, searchGeneratedVersion: current ? 1 : 0,
    searchIndexStatus: current ? 'generated' : 'pending' }
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'private-line', code: 'BL-TEST', name: 'private-name', description: '',
      status: 'active', nodeCount: 1, ...search,
      ...(current ? { searchSchemaVersion: 2, searchGenerationId: 'private-generation' } : {}) }],
    business_nodes: [{ _id: 'private-node', businessLineId: 'private-line', sequence: 0,
      name: 'private-node-name', nodeCode: 'N001', status: 'ready', processingRoundNumber: 1, ...search }],
    business_search_requests: [{ _id: ticketId, operation: 'index', actorId: 'private-actor',
      businessLineId: 'private-line', sourceVersion: 1, status: 'pending', createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60000) }]
  }, options)
  const repository = createCloudSearchRepository({ db: fake.db, secret: SECRET, clock: () => NOW })
  const service = createSearchService({ repository, secret: SECRET, timingNow,
    logger: logger === undefined ? { info: (...args) => logs.push(args) } : logger,
    generationIdFactory: () => 'private-generation-new' })
  return { fake, repository, service, logs }
}

test('index success reports one value-free stage summary after durable generation publication', async () => {
  const { service, fake, logs } = fixture()
  const result = await service.indexRequest({ token: TOKEN })
  assert.deepEqual(result, { businessLineId: 'private-line', sourceVersion: 1, indexStatus: 'generated' })
  assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'generated')
  assert.equal(fake.documents('business_search_requests')[0].status, 'consumed')
  assert.equal(logs.length, 1, 'one successful index timing summary must be emitted')
  const [tag, event] = logs[0]
  assert.equal(tag, '[businessSearch.indexTiming]')
  assert.deepEqual(Object.keys(event).sort(), ['action', 'counters', 'durationMs', 'outcome', 'schemaVersion', 'stages'])
  assert.equal(event.action, 'index')
  assert.equal(event.outcome, 'OK')
  for (const phase of ['ticket_consume', 'generation_check', 'snapshot_load', 'snapshot_head',
    'snapshot_nodes', 'entries_build', 'generation_publish', 'publish_nodes', 'generation_writes',
    'publication_transaction', 'publication_reads', 'publication_writes']) {
    assert.deepEqual({ ...event.stages[phase], durationMs: 0 },
      { durationMs: 0, calls: 1, failedCalls: 0, incompleteCalls: 0 }, phase)
    assert(Number.isFinite(event.stages[phase].durationMs) && event.stages[phase].durationMs >= 0)
  }
  assert.equal(event.counters.ticket_attempts, 1)
  assert.equal(event.counters.publication_attempts, 1)
  assert.equal(event.counters.entry_write_attempts, 4)
  assert(event.counters.token_write_attempts > 0)
  assert.equal(JSON.stringify(logs).includes('private-'), false)
  assert.equal(JSON.stringify(logs).includes(SECRET), false)
})

test('current-generation short circuit reports only executed stages without duplicate writes', async () => {
  const { service, fake, logs } = fixture({ current: true })
  await service.indexRequest({ token: TOKEN })
  assert.equal(fake.documents('business_search_documents').length, 0)
  assert.equal(fake.writeCalls.length, 1)
  assert.equal(logs.length, 1)
  assert.deepEqual(Object.keys(logs[0][1].stages).sort(), ['generation_check', 'ticket_consume'])
  assert.deepEqual(logs[0][1].counters, { ticket_attempts: 1 })
})

test('failed ticket consumption reports failure without proceeding or leaking original input', async () => {
  const { service, fake, logs } = fixture()
  await assert.rejects(service.indexRequest({ token: 'private-invalid-ticket' }), { code: 'FORBIDDEN' })
  assert.equal(fake.documents('business_search_requests')[0].status, 'pending')
  assert.equal(fake.writeCalls.length, 0)
  assert.equal(logs.length, 1)
  assert.equal(logs[0][1].outcome, 'ERROR')
  assert.equal(logs[0][1].stages.ticket_consume.failedCalls, 1)
  assert.deepEqual(Object.keys(logs[0][1].stages), ['ticket_consume'])
  assert.equal(JSON.stringify(logs).includes('private-'), false)
})

test('failed generation writes preserve the error and never publish a partial generation', async () => {
  const { service, fake, logs } = fixture()
  const failure = new Error('private-storage-failure')
  fake.failNextWrite({ collection: 'business_search_documents', operation: 'set', error: failure })
  await assert.rejects(service.indexRequest({ token: TOKEN }), error => error === failure && error.searchPhase === 'publish_generation')
  assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  assert.equal(logs.length, 1)
  assert.equal(logs[0][1].stages.generation_writes.failedCalls, 1)
  assert.equal(logs[0][1].stages.publication_transaction, undefined)
  assert.equal(logs[0][1].outcome, 'ERROR')
  assert.equal(JSON.stringify(logs).includes('private-'), false)
})

test('clock/logger failures do not change the real persisted result or original rejection', async () => {
  for (const logger of [null, { info() { throw new Error('logger down') } },
    { info() { return Promise.reject(new Error('logger down')) } },
    Object.defineProperty({}, 'info', { get() { throw new Error('logger getter') } })]) {
    const { service, fake } = fixture({ logger, timingNow() { throw new Error('clock down') } })
    assert.equal((await service.indexRequest({ token: TOKEN })).indexStatus, 'generated')
    assert.equal(fake.documents('business_lines')[0].searchGeneratedVersion, 1)
    await assert.rejects(service.indexRequest({ token: TOKEN }), { code: 'FORBIDDEN' })
  }
  await new Promise(resolve => setImmediate(resolve))
})

test('unavailable diagnostic clock produces unknown times rather than claiming zero latency', async () => {
  const { service, logs } = fixture({ timingNow: () => NaN })
  await service.indexRequest({ token: TOKEN })
  assert.equal(logs.length, 1)
  assert.equal(logs[0][1].durationMs, null)
  assert.equal(logs[0][1].stages.snapshot_load.durationMs, null)
})

test('transaction retries increment attempt/read/write counts without duplicate summaries or generations', async () => {
  let ticketConflict = false
  let publicationConflict = false
  const { service, fake, logs } = fixture({ options: {
    transformRead({ collection, data }) {
      if (!fake.metrics.activeCallbacks) return data
      if (collection === 'business_search_requests' && !ticketConflict) {
        ticketConflict = true
        fake.replace(collection, data._id, data)
      } else if (collection === 'business_lines' && !publicationConflict) {
        publicationConflict = true
        fake.replace(collection, data._id, data)
      }
      return data
    }
  } })
  await service.indexRequest({ token: TOKEN })
  assert.equal(fake.metrics.conflicts, 2)
  assert.equal(fake.metrics.retries, 1, 'ticket keeps SDK retries; publication owns its bounded retry budget')
  assert.equal(logs.length, 1)
  const event = logs[0][1]
  assert.equal(event.counters.ticket_attempts, 2)
  assert.equal(event.counters.publication_attempts, 2)
  assert.equal(event.stages.publication_transaction.calls, 1)
  assert.equal(event.stages.publication_reads.calls, 2)
  assert.equal(event.stages.publication_writes.calls, 2)
  // Successful callbacks can be retried at commit; failedCalls is not a retry count.
  assert.equal(event.stages.publication_writes.failedCalls, 0)
  assert.equal(event.counters.entry_write_attempts, 4)
  assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'generated')
})

test('transaction read/write failures report their phase and preserve atomic publication', async () => {
  for (const phase of ['publication_reads', 'publication_writes']) {
    const { service, fake, logs } = fixture()
    const failure = new Error('private-database-failure')
    if (phase === 'publication_reads') {
      fake.failNextRead({ collection: 'business_nodes', transaction: true, error: failure })
    } else {
      fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error: failure })
    }
    await assert.rejects(service.indexRequest({ token: TOKEN }), error =>
      error.searchPhase === 'publish_generation' &&
      (phase === 'publication_reads' ? error.code === 'VERSION_CONFLICT' : error === failure))
    assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'pending')
    assert.equal(fake.documents('business_nodes')[0].searchIndexStatus, 'pending')
    assert.equal(logs.length, 1)
    assert.equal(logs[0][1].stages[phase].failedCalls, 1)
    assert.equal(logs[0][1].stages.publication_transaction.failedCalls, 1)
    assert.equal(logs[0][1].outcome, 'ERROR')
  }
})

test('concurrent invocations on the same service never merge their diagnostic state', async () => {
  const { service, logs } = fixture()
  const results = await Promise.allSettled([
    service.indexRequest({ token: TOKEN }), service.indexRequest({ token: 'private-bad-ticket' })
  ])
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected'])
  assert.equal(logs.length, 2)
  const ok = logs.find(([, event]) => event.outcome === 'OK')[1]
  const failed = logs.find(([, event]) => event.outcome === 'ERROR')[1]
  assert.notEqual(ok.stages, failed.stages)
  assert.equal(ok.stages.entries_build.calls, 1)
  assert.equal(ok.stages.ticket_consume.failedCalls, 0)
  assert.deepEqual(Object.keys(failed.stages), ['ticket_consume'])
  assert.equal(failed.stages.ticket_consume.failedCalls, 1)
})

test('query recovery and timer rebuilds keep their existing results without index-request summaries', async () => {
  const { repository, logs } = fixture({ current: true })
  const request = { businessLineId: 'private-line', sourceVersion: 1 }
  let recovered = 0
  const queryResult = { items: [], cursor: '', hasMore: false }
  const service = createSearchService({ secret: SECRET, logger: { info: (...args) => logs.push(args) },
    repository: { ...repository,
      consumeRequest: async () => ({ actorId: 'private-actor', normalizedKeywords: ['test'],
        digestInput: 'test', pageSize: 20, cursor: '' }),
      recoverForQuery: async (_input, rebuild) => {
        assert.equal((await rebuild(request)).indexStatus, 'generated')
        recovered++
        return { done: true }
      },
      queryAuthorized: async () => queryResult,
      claimBackfillPage: async () => ({ scanned: 1, items: [request] }),
      claimRecoveryPage: async () => ({ scanned: 0, items: [] }),
      cleanupOldGeneration: async () => ({ scanned: 0, cleaned: 0 })
    } })
  assert.deepEqual(await service.queryRequest({ token: TOKEN }), queryResult)
  assert.equal(recovered, 1)
  assert.deepEqual(await service.runCycle({ now: NOW, batchSize: 40 }),
    { examined: 1, generated: 1, failed: 0, cleaned: 0 })
  assert.deepEqual(logs, [])
})
