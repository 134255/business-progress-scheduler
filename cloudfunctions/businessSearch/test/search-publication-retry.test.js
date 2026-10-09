const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createSearchService } = require('../lib/search-service')
const { createCloudSearchRepository } = require('../lib/cloud-search-repository')
const { createBusinessSearchHandler } = require('../index')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const SECRET = 'publication-test-only-secret-1234567890'
const TOKEN = 'publication-test-only-ticket'
const NOW = new Date('2026-10-09T04:00:00Z')
const REQUEST = { businessLineId: 'line', sourceVersion: 1, generationId: 'generation', entries: [] }

function wrappedConflict(operation = 'update') {
  const message = `document.${operation}:fail -501001 resource system error. database transaction conflict`
  return Object.assign(new Error(message), { errCode: -501001, errMsg: message })
}

function fixture(options = {}) {
  const logs = [], diagnostics = [], delays = []
  const search = { searchSourceVersion: 1, searchGeneratedVersion: 0, searchIndexStatus: 'pending' }
  const fake = createFakeCloudDatabase({
    users: [{ _id: 'actor', role: 'user', status: 'active' }],
    business_lines: [{ _id: 'line', code: 'BL-TEST', name: 'Test line', description: '',
      status: 'active', version: 1, nodeCount: 1, managerUserIds: ['actor'], memberUserIds: ['actor'],
      updatedAt: NOW, ...search }],
    business_nodes: [{ _id: 'node', businessLineId: 'line', sequence: 0, name: 'Test node',
      nodeCode: 'N001', status: 'ready', version: 1, processingRoundNumber: 1, ...search }],
    business_search_requests: [{ _id: crypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex'),
      operation: 'index', actorId: 'actor', businessLineId: 'line', sourceVersion: 1,
      status: 'pending', createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60000) }]
  }, options)
  const repository = createCloudSearchRepository({ db: fake.db, secret: SECRET, clock: () => NOW,
    delay: async ms => { delays.push(ms) } })
  const service = createSearchService({ repository, secret: SECRET,
    logger: { info: (...args) => logs.push(args) }, generationIdFactory: () => 'generation' })
  const handler = createBusinessSearchHandler({ service, logger: { error: (...args) => diagnostics.push(args) } })
  return { fake, repository, service, handler, logs, diagnostics, delays }
}

function assertAuthorityUnchanged(h) {
  const line = h.fake.documents('business_lines')[0]
  assert.equal(line.status, 'active')
  assert.equal(line.version, 1)
  assert.deepEqual(line.updatedAt, NOW)
  assert.equal(h.fake.documents('business_nodes')[0].version, 1)
}

for (const collection of ['business_lines', 'business_nodes']) {
  test(`wrapped write conflict on ${collection} retries publication only, without replaying the ticket or generation`, async () => {
    const h = fixture()
    h.fake.failNextWrite({ collection, operation: 'update', error: wrappedConflict() })
    assert.equal((await h.service.indexRequest({ token: TOKEN })).indexStatus, 'generated')
    const timing = h.logs[0][1]
    assert.equal(timing.counters.publication_attempts, 2)
    assert.equal(timing.counters.ticket_attempts, 1)
    assert.equal(timing.stages.entries_build.calls, 1)
    assert.equal(timing.stages.generation_writes.calls, 1)
    assert.equal(timing.stages.publication_reads.calls, 2)
    assert.equal(timing.stages.publication_writes.failedCalls, 1)
    assert.equal(timing.outcome, 'OK')
    assert.equal(h.delays.length, 1)
    const writes = h.fake.writeCalls.filter(call => call.collection === 'business_search_documents')
    assert.equal(new Set(writes.map(call => call.id)).size, writes.length)
    assert.equal(h.fake.documents('business_lines')[0].searchGenerationId, 'generation')
    assert.equal(h.fake.documents('business_nodes')[0].searchGenerationId, 'generation')
    assertAuthorityUnchanged(h)
    await assert.rejects(h.service.indexRequest({ token: TOKEN }), { code: 'FORBIDDEN' })
  })
}

test('a wrapped transaction read conflict is retried rather than mistaken for a missing node', async () => {
  const h = fixture()
  h.fake.failNextRead({ collection: 'business_nodes', transaction: true, error: wrappedConflict('get') })
  assert.equal((await h.service.indexRequest({ token: TOKEN })).indexStatus, 'generated')
  assert.equal(h.logs[0][1].stages.publication_reads.failedCalls, 1)
  assert.equal(h.logs[0][1].counters.publication_attempts, 2)
})

test('persistent conflicts stop after three publication attempts, preserve atomicity and emit only safe diagnostics', async () => {
  const h = fixture()
  for (let n = 0; n < 4; n++) h.fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error: wrappedConflict() })
  await assert.rejects(h.handler({ operation: 'index', ticket: TOKEN }), { code: 'BUSINESS_SEARCH_FAILED' })
  assert.equal(h.logs[0][1].counters.publication_attempts, 3)
  assert.equal(h.logs[0][1].counters.ticket_attempts, 1)
  assert.equal(h.delays.length, 2)
  assert(h.delays.every(ms => ms > 0 && ms <= 100))
  assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  assert.equal(h.fake.documents('business_nodes')[0].searchIndexStatus, 'pending')
  assert.deepEqual(h.diagnostics, [['[businessSearch]', {
    code: 'BUSINESS_SEARCH_FAILED', causeCode: 'DATABASE_TRANSACTION_CONFLICT',
    phase: 'publish_generation', operation: 'index'
  }]])
  assertAuthorityUnchanged(h)
})

for (const error of [new Error('private failure'),
  Object.assign(wrappedConflict(), { code: 'VERSION_CONFLICT' }),
  Object.assign(wrappedConflict(), { code: 'FORBIDDEN' }),
  Object.assign(wrappedConflict(), { errCode: -502003 }),
  Object.assign(new Error('private timeout'), { errCode: -501002 }),
  Object.assign(wrappedConflict(), { errMsg: 'private prefix: database transaction conflict' })]) {
  test(`non-conflict write failure is not retried (${error.code || error.errCode || 'unknown'} / ${error.message})`, async () => {
    const h = fixture()
    h.fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error })
    await assert.rejects(h.service.indexRequest({ token: TOKEN }), actual => actual === error)
    assert.equal(h.logs[0][1].counters.publication_attempts, 1)
    assert.deepEqual(h.delays, [])
    assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  })
}

for (const collection of ['business_lines', 'business_nodes']) {
  test(`a concurrent source change in ${collection} is rechecked before retry publication`, async () => {
    const h = fixture({ afterTransactionError() {
      const current = h.fake.documents(collection)[0]
      h.fake.replace(collection, current._id, { ...current, searchSourceVersion: 2 })
    } })
    h.fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error: wrappedConflict() })
    await assert.rejects(h.service.indexRequest({ token: TOKEN }), { code: 'VERSION_CONFLICT' })
    assert.equal(h.logs[0][1].counters.publication_attempts, 2)
    assert.equal(h.logs[0][1].stages.publication_writes.calls, 1)
    assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
    assert.equal(h.fake.documents(collection)[0].searchSourceVersion, 2)
  })
}

for (const mutation of ['disabled', 'membership', 'role']) {
  test(`query recovery rechecks ${mutation} on the fresh transaction after conflict`, async () => {
    const h = fixture({ afterTransactionError() {
      const actor = h.fake.documents('users')[0]
      const line = h.fake.documents('business_lines')[0]
      if (mutation === 'membership') h.fake.replace('business_lines', 'line', { ...line, managerUserIds: ['other'], memberUserIds: ['other'] })
      else h.fake.replace('users', 'actor', { ...actor, ...(mutation === 'role' ? { role: 'admin' } : { status: 'disabled' }) })
    } })
    h.fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error: wrappedConflict() })
    await assert.rejects(h.repository.publishGeneration({ ...REQUEST,
      recoveryAccess: { actorId: 'actor', role: 'user' } }), { code: 'FORBIDDEN' })
    assert.equal(h.fake.transactionRuns.length, 2)
    assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
    assert.equal(h.fake.documents('business_nodes')[0].searchIndexStatus, 'pending')
  })
}

test('concurrent card update survives search publication commit conflict without changing business fields', async () => {
  let cardWritten = false
  const h = fixture({ transformRead({ collection, data }) {
    if (collection === 'business_lines' && h.fake.metrics.activeCallbacks && !cardWritten) {
      cardWritten = true
      h.fake.replace('business_lines', 'line', { ...data, cardSummary: { schemaVersion: 1, state: 'ready' } })
    }
    return data
  } })
  assert.equal((await h.service.indexRequest({ token: TOKEN })).indexStatus, 'generated')
  assert.deepEqual(h.fake.documents('business_lines')[0].cardSummary, { schemaVersion: 1, state: 'ready' })
  assert.equal(h.logs[0][1].counters.publication_attempts, 2)
  assertAuthorityUnchanged(h)
})

test('persistent commit conflicts cannot multiply the three-attempt budget through SDK retries', async () => {
  const h = fixture({ transformRead({ collection, data }) {
    if (collection === 'business_lines' && h.fake.metrics.activeCallbacks) {
      h.fake.replace('business_lines', 'line', { ...data, cardSummary: { state: 'ready' } })
    }
    return data
  } })
  await assert.rejects(h.handler({ operation: 'index', ticket: TOKEN }), { code: 'BUSINESS_SEARCH_FAILED' })
  assert.equal(h.logs[0][1].counters.publication_attempts, 3)
  assert.equal(h.fake.metrics.retries, 0)
  assert.equal(h.delays.length, 2)
  assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  assert.deepEqual(h.fake.documents('business_lines')[0].cardSummary, { state: 'ready' })
  assert.equal(h.diagnostics[0][1].causeCode, 'DATABASE_TRANSACTION_CONFLICT')
  assertAuthorityUnchanged(h)
})

test('conflicts before publication are not replayed by the publication retry policy', async () => {
  for (const collection of ['business_search_requests', 'business_search_documents']) {
    const h = fixture(), error = wrappedConflict(collection === 'business_search_requests' ? 'update' : 'set')
    h.fake.failNextWrite({ collection, operation: collection === 'business_search_requests' ? 'update' : 'set', error })
    await assert.rejects(h.service.indexRequest({ token: TOKEN }), actual => actual === error)
    assert.deepEqual(h.delays, [])
    assert.equal(h.logs[0][1].counters.publication_attempts, undefined)
    assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  }
})
