const test = require('node:test')
const assert = require('node:assert/strict')
const { createSearchService } = require('../lib/search-service')
const { createBusinessSearchHandler } = require('../index')
const { SECRET, tick, observe, readySeed, roundSeed, harness, publication,
  ticket, drainWaves, indexWrite, roundRead } = require('./helpers/search-concurrency')

test('generation writes fill four slots, preserve content under reverse completion, and publish only after the last write', async () => {
  const { fake, repository, control } = harness(readySeed(), indexWrite)
  const input = await publication(repository)
  const outcome = observe(repository.publishGeneration(input))
  try {
    await tick()
    assert.equal(control.selected.length, 4)
    assert.equal(fake.transactionRuns.length, 0)
    assert.equal(outcome.settled, false)
    const waves = await drainWaves(control, outcome)
    assert.equal((await outcome.done).error, undefined)
    assert.equal(control.maximum, 4)
    assert.equal(control.active, 0)
    const documents = fake.documents('business_search_documents')
    assert.equal(documents.filter(item => item.documentType === 'entry').length, 4)
    assert.equal(documents.filter(item => item.documentType === 'tokens').length, 7)
    assert.equal(waves, 3)
    for (const entry of input.entries) {
      const actual = documents.find(item => item.documentType === 'entry' && item.entryId === entry.entryId)
      assert.equal(actual.normalizedText, entry.normalizedText)
      for (const chunk of entry.tokenChunks) {
        const stored = documents.find(item => item.documentType === 'tokens' &&
          item.entryId === entry.entryId && item.tokenChunkIndex === chunk.tokenChunkIndex)
        assert.deepEqual(stored.tokenHashes, chunk.tokenHashes)
      }
    }
    assert.equal(fake.documents('business_lines')[0].searchGenerationId, 'audit-generation')
    assert.deepEqual(fake.transactionRuns.map(run => run.operations), [4])
  } finally { control.releaseAll(); await outcome.done }
})

test('a failed index request stops dispatch and does not return even an error while other writes are in flight', async () => {
  const { fake, repository, control } = harness(readySeed(), indexWrite)
  ticket(fake, 'failed-ticket')
  const logs = []
  const handler = createBusinessSearchHandler({
    service: createSearchService({ repository, secret: SECRET }),
    logger: { error: (...args) => logs.push(args) }
  })
  const outcome = observe(handler({ operation: 'index', ticket: 'failed-ticket' }))
  try {
    await tick()
    assert.equal(control.selected.length, 4)
    control.selected[1].reject(new Error('synthetic write failure'))
    await tick()
    assert.equal(control.selected.length, 4)
    assert.equal(control.active, 3)
    assert.equal(outcome.settled, false)
    assert.equal(logs.length, 0)
    assert.equal(fake.transactionRuns.length, 1) // Ticket consumption, not publication.
    control.selected[3].reject(new Error('late second failure'))
    await tick()
    assert.equal(control.active, 2)
    assert.equal(outcome.settled, false)
    assert.equal(logs.length, 0)
    control.releaseAll()
    assert.equal((await outcome.done).error.code, 'BUSINESS_SEARCH_FAILED')
    assert.equal(control.selected.length, 4)
    assert.equal(control.active, 0)
    assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'pending')
    assert.equal(logs.length, 1)
  } finally { control.releaseAll(); await outcome.done }
})

test('late generation validation failure drains started writes and never publishes a partial generation', async () => {
  const { fake, repository, control } = harness(readySeed(), indexWrite)
  const input = await publication(repository)
  input.entries[1].tokenChunks[0].tokenHashes = []
  const outcome = observe(repository.publishGeneration(input))
  try {
    await tick()
    assert.equal(control.selected.length, 4)
    control.selected[0].resolve()
    await tick()
    assert.equal(outcome.settled, false)
    assert.equal(control.selected.length, 4)
    control.releaseAll()
    assert.equal((await outcome.done).error.code, 'SEARCH_SOURCE_INVALID')
    assert.equal(control.active, 0)
    assert.equal(fake.transactionRuns.length, 0)
    assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  } finally { control.releaseAll(); await outcome.done }
})

test('duplicate generation document identities cannot race to publish different content', async () => {
  for (const duplicate of ['entry', 'token']) {
    const { fake, repository } = harness()
    const input = await publication(repository)
    if (duplicate === 'entry') input.entries.push({ ...input.entries[0], normalizedText: 'conflicting duplicate' })
    else input.entries[0].tokenChunks.push({ ...input.entries[0].tokenChunks[0], tokenHashes: ['different-token'] })
    await assert.rejects(repository.publishGeneration(input), { code: 'SEARCH_SOURCE_INVALID' })
    assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  }
})

test('source advancement while writes are blocked still fails the original publication transaction', async () => {
  const { fake, repository, control } = harness(readySeed(), indexWrite)
  const input = await publication(repository)
  const outcome = observe(repository.publishGeneration(input))
  try {
    await tick()
    const line = fake.documents('business_lines')[0]
    fake.replace('business_lines', line._id, { ...line, searchSourceVersion: 2 })
    control.releaseAll()
    assert.equal((await outcome.done).error.code, 'VERSION_CONFLICT')
    assert.equal(control.active, 0)
    assert.equal(fake.documents('business_lines')[0].searchGeneratedVersion, 0)
    assert.equal(fake.documents('business_nodes')[0].searchGeneratedVersion, 0)
  } finally { control.releaseAll(); await outcome.done }
})

test('an older in-flight generation cannot replace a completely published newer source generation', async () => {
  const { fake, repository, control } = harness(readySeed(), operation =>
    indexWrite(operation) && operation.data.generationId === 'old-generation')
  const oldInput = await publication(repository, 'old-generation')
  const old = observe(repository.publishGeneration(oldInput))
  try {
    await tick()
    const line = fake.documents('business_lines')[0]
    fake.replace('business_lines', line._id, { ...line, searchSourceVersion: 2 })
    await repository.publishGeneration(await publication(repository, 'new-generation', 2))
    assert.equal(old.settled, false)
    control.releaseAll()
    assert.equal((await old.done).error.code, 'VERSION_CONFLICT')
    assert.equal(fake.documents('business_lines')[0].searchGenerationId, 'new-generation')
    assert.equal(fake.documents('business_nodes')[0].searchGenerationId, 'new-generation')
    assert.equal(await repository.isGenerationCurrent({ businessLineId: 'audit-line', sourceVersion: 2 }), true)
    assert.equal(await repository.isGenerationCurrent({ businessLineId: 'audit-line', sourceVersion: 1 }), false)
  } finally { control.releaseAll(); await old.done }
})

test('same-source competing publishers retry transactions without exposing an incomplete winning generation', async () => {
  const { fake, repository, control } = harness(readySeed(), operation =>
    operation.transaction && operation.collection === 'business_lines' && operation.method === 'get')
  const leftInput = await publication(repository, 'left-generation')
  const rightInput = await publication(repository, 'right-generation')
  const left = observe(repository.publishGeneration(leftInput))
  const right = observe(repository.publishGeneration(rightInput))
  try {
    await tick()
    assert.equal(control.selected.length, 2)
    assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'pending')
    control.releaseAll()
    assert.equal((await left.done).error, undefined)
    assert.equal((await right.done).error, undefined)
    assert.ok(fake.metrics.conflicts >= 1)
    const generation = fake.documents('business_lines')[0].searchGenerationId
    assert.ok(['left-generation', 'right-generation'].includes(generation))
    assert.equal(fake.documents('business_nodes')[0].searchGenerationId, generation)
    assert.equal(fake.documents('business_search_documents').filter(item => item.generationId === generation).length, 11)
  } finally { control.releaseAll(); await Promise.all([left.done, right.done]) }
})

test('48-node publication retains all fixed-document rechecks and stays within 100 transaction operations', async () => {
  const { fake, repository } = harness(readySeed(48))
  await repository.publishGeneration(await publication(repository))
  assert.deepEqual(fake.transactionRuns.map(run => run.operations), [98])
  assert.equal(fake.transactionQueries.length, 0)
  assert.equal(fake.documents('business_nodes').filter(node => node.searchGeneratedVersion === 1).length, 48)
})

test('a fresh retry ticket recovers failed indexing, then a generated retry performs no generation writes', async () => {
  const { fake, repository } = harness()
  let generations = 0
  const service = createSearchService({ repository, secret: SECRET,
    generationIdFactory: () => `retry-generation-${++generations}` })
  ticket(fake, 'first-ticket')
  fake.failNextWrite({ collection: 'business_search_documents', operation: 'set', error: new Error('failed') })
  await assert.rejects(service.indexRequest({ token: 'first-ticket' }))
  assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  await assert.rejects(service.indexRequest({ token: 'first-ticket' }), { code: 'FORBIDDEN' })
  ticket(fake, 'second-ticket')
  assert.equal((await service.indexRequest({ token: 'second-ticket' })).indexStatus, 'generated')
  const count = fake.documents('business_search_documents').length
  ticket(fake, 'third-ticket')
  assert.equal((await service.indexRequest({ token: 'third-ticket' })).indexStatus, 'generated')
  assert.equal(fake.documents('business_search_documents').length, count)
  assert.equal(generations, 2)
  assert.equal(fake.documents('business_lines').length, 1)
  assert.equal(fake.documents('business_nodes').length, 1)
  assert.equal(fake.documents('node_feedback').length, 0)
  assert.equal(fake.documents('audit_logs').length, 0)
})

test('review votes and evidence share four slots and preserve declared evidence order under reverse completion', async () => {
  const seed = roundSeed()
  seed.node_review_rounds[0].evidenceIds = ['evidence-0-4', 'evidence-0-1', 'evidence-0-5',
    'evidence-0-0', 'evidence-0-3', 'evidence-0-2']
  const { repository, control } = harness(seed, roundRead)
  const outcome = observe(repository.loadAuthoritativeSnapshot({ businessLineId: 'audit-line', sourceVersion: 1 }))
  try {
    await tick()
    assert.equal(control.selected.length, 4)
    assert.equal(control.selected.filter(item => item.collection === 'node_review_votes').length, 1)
    assert.equal(await drainWaves(control, outcome), 2)
    const { value, error } = await outcome.done
    assert.equal(error, undefined)
    assert.deepEqual(value.nodes[0].reviewComments, ['current vote'])
    assert.deepEqual(value.nodes[0].evidenceFileNames, ['evidence-0-4.pdf', 'evidence-0-1.pdf',
      'evidence-0-5.pdf', 'evidence-0-0.pdf', 'evidence-0-3.pdf', 'evidence-0-2.pdf'])
    assert.equal(control.maximum, 4)
    assert.equal(control.active, 0)
  } finally { control.releaseAll(); await outcome.done }
})

for (const failure of ['evidence', 'vote']) {
  test(`invalid ${failure} stops further snapshot reads and drains the other in-flight branch`, async () => {
    const seed = roundSeed()
    if (failure === 'evidence') seed.evidences[0].businessLineId = 'wrong-line'
    else seed.node_review_votes[0].nodeId = 'wrong-node'
    const { repository, control } = harness(seed, roundRead)
    const outcome = observe(repository.loadAuthoritativeSnapshot({ businessLineId: 'audit-line', sourceVersion: 1 }))
    try {
      await tick()
      assert.equal(control.selected.length, 4)
      const failed = control.selected.find(item => item.collection ===
        (failure === 'evidence' ? 'evidences' : 'node_review_votes'))
      failed.resolve()
      await tick()
      assert.equal(outcome.settled, false)
      assert.equal(control.selected.length, 4)
      assert.equal(control.active, 3)
      control.releaseAll()
      assert.equal((await outcome.done).error.code, 'SEARCH_SOURCE_INVALID')
      assert.equal(control.selected.length, 4)
      assert.equal(control.active, 0)
    } finally { control.releaseAll(); await outcome.done }
  })
}

test('wrong processing round is rejected before any vote or attachment reads', async () => {
  const seed = roundSeed()
  seed.node_review_rounds[0].processingRoundNumber = 2
  const { repository, control } = harness(seed, roundRead)
  await assert.rejects(repository.loadAuthoritativeSnapshot({ businessLineId: 'audit-line', sourceVersion: 1 }),
    { code: 'SEARCH_SOURCE_INVALID' })
  assert.equal(control.selected.length, 0)
})

test('three round nodes with four attachments keep 20 reads but need only 11 synthetic dependency waves', async () => {
  const { repository, control } = harness(roundSeed(3, 4), operation => operation.method === 'get')
  const outcome = observe(repository.loadAuthoritativeSnapshot({ businessLineId: 'audit-line', sourceVersion: 1 }))
  try {
    const waves = await drainWaves(control, outcome)
    assert.equal((await outcome.done).value.nodes.length, 3)
    assert.equal(control.selected.length, 20)
    assert.equal(waves, 11)
    assert.equal(control.maximum, 4)
  } finally { control.releaseAll(); await outcome.done }
})
