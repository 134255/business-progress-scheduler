const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudOperationsFieldRepository } = require('../lib/cloud-operations-field-repository')
const { normalizeFieldQuery } = require('../lib/operations-field-query')
const { normalizeAnalysisQuery } = require('../lib/operations-field-analysis-query')
const domain = require('../lib/operations-field-domain')
const { groupNodeReads } = require('../lib/operations-read-batches')
const { NOW, createCapacityFixture } = require('../../../tools/capacity/fixtures.cjs')

function harness({ nodes = 45, lines = 1, snapshots = 'valid', options = {}, mutateSeed } = {}) {
  const fixture = createCapacityFixture({ days: 1, linesPerDay: lines, nodesPerLine: nodes, snapshotMode: snapshots })
  const seed = Object.fromEntries(fixture.collections.map(name => [name, [...fixture.entries(name)]]))
  if (mutateSeed) mutateSeed(seed)
  const fake = createFakeCloudDatabase(seed, options)
  const repository = createCloudOperationsFieldRepository({ db: fake.db,
    secret: 'synthetic-batch-test-secret-'.repeat(3), clock: () => new Date(NOW) })
  const query = { startDate: '2026-09-01', endDate: '2026-09-23', pageSize: 50 }
  return { fake, repository, seed, actors: fixture.actors,
    range: normalizeFieldQuery(query, NOW), analysisRange: normalizeAnalysisQuery({ ...query, analysis: { view: 'catalog' } }, NOW) }
}

function occurrences(summary, label) {
  return summary.groups.flatMap(group => group.options).filter(option => option.label === label)
    .reduce((total, option) => total + option.count, 0)
}

test('cached statistics verify 45 same-line nodes in bounded batches without changing counts', async () => {
  const h = harness()
  const result = await h.repository.getSummary({ actor: h.actors[0], range: h.range })
  assert.equal(result.incomplete, false)
  assert.equal(result.sampledNodeCount, 45)
  assert.equal(occurrences(result, 'A'), 45)
  assert.equal(occurrences(result, 'B'), 0)
  assert.equal(occurrences(result, 'X'), 45)
  assert.equal(occurrences(result, 'Y'), 45)
  assert.ok(h.fake.transactionRuns.length <= 4, `transaction count ${h.fake.transactionRuns.length}`)
  assert.ok(h.fake.transactionRuns.every(run => run.operations <= 22))
  assert.equal(h.fake.readCalls.some(call => call.collection === 'node_feedback'), false)
  assert.equal(h.fake.writeCalls.length, 0)
  assert.equal(h.fake.transactionQueries.length, 0)
  assert.ok(h.fake.metrics.maxActiveCallbacks <= 4)
})

test('filter discovery batches cached nodes and retains every historical node and business', async () => {
  const h = harness()
  const result = await h.repository.getFilters({ actor: h.actors[0], range: h.range })
  assert.equal(result.incomplete, false)
  assert.equal(result.stableNodes.length, 45)
  assert.equal(result.businesses.length, 1)
  assert.equal(result.templates.length, 1)
  assert.deepEqual(result.templateVersions, [1])
  assert.ok(h.fake.transactionRuns.length <= 4, `transaction count ${h.fake.transactionRuns.length}`)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('analysis verifies all 45 sources at both read boundaries within eight transactions', async () => {
  const h = harness()
  const result = await h.repository.getAnalysis({ actor: h.actors[0], range: h.analysisRange })
  assert.equal(result.incomplete, false)
  assert.equal(result.sampleCount, 45)
  assert.equal(result.items.length, 45)
  assert.equal(result.hasMore, false)
  assert.ok(h.fake.transactionRuns.length <= 8, `transaction count ${h.fake.transactionRuns.length}`)
  assert.ok(h.fake.transactionRuns.every(run => run.operations <= 22))
  assert.equal(h.fake.writeCalls.length, 0)
  assert.equal(h.fake.transactionQueries.length, 0)
})

test('missing snapshots still use authoritative feedback and preserve the existing fallback', async () => {
  const h = harness({ nodes: 5, snapshots: 'missing' })
  const result = await h.repository.getSummary({ actor: h.actors[0], range: h.range })
  assert.equal(result.incomplete, false)
  assert.equal(result.sampledNodeCount, 5)
  assert.equal(occurrences(result, 'A'), 5)
  assert.equal(h.fake.readCalls.filter(call => call.collection === 'node_feedback').length, 10)
  assert.equal(h.fake.transactionRuns.length, 6)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('a missing source remains an explicit gap without dropping other cached nodes', async () => {
  const h = harness({ nodes: 5 })
  const node = h.seed.business_nodes[1]
  h.fake.replace('business_nodes', node._id, { ...node, latestFeedbackId: 'missing-final-feedback' })
  const result = await h.repository.getSummary({ actor: h.actors[0], range: h.range })
  assert.equal(result.incomplete, true)
  assert.equal(result.sampledNodeCount, 4)
  assert.equal(occurrences(result, 'A'), 4)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('a stale but recoverable snapshot falls back without discarding valid batch neighbors', async () => {
  const h = harness({ nodes: 5 })
  const stale = h.seed.operations_field_snapshots[1]
  h.fake.replace('operations_field_snapshots', stale._id, { ...stale, sourceHeader: '0'.repeat(64) })
  const result = await h.repository.getSummary({ actor: h.actors[0], range: h.range })
  assert.equal(result.incomplete, false)
  assert.equal(result.sampledNodeCount, 5)
  assert.equal(occurrences(result, 'A'), 5)
  assert.equal(h.fake.readCalls.filter(call => call.collection === 'node_feedback').length, 2)
})

test('batch validation rejects account suspension after snapshot discovery', async () => {
  const h = harness({ nodes: 5 })
  const actor = h.actors[0]
  h.fake.beforeNextTransaction(() => h.fake.replace('users', actor._id, { ...actor, status: 'disabled' }))
  await assert.rejects(h.repository.getSummary({ actor, range: h.range }), { code: 'FORBIDDEN' })
  assert.equal(h.fake.writeCalls.length, 0)
})

test('final authorization rejects revocation after the batch has been verified', async () => {
  let h, changed = false
  h = harness({ nodes: 5, options: { afterTransaction({ record }) {
    if (!changed && record.operations >= 3) {
      changed = true
      const line = h.seed.business_lines[0]
      h.fake.replace('business_lines', line._id, { ...line, memberUserIds: ['other-member'] })
    }
  } } })
  await assert.rejects(h.repository.getSummary({ actor: h.actors[1], range: h.range }), { code: 'FORBIDDEN' })
  assert.equal(changed, true)
})

test('analysis tail proof rejects a source change after cached batch collection', async () => {
  let h, changed = false
  h = harness({ nodes: 5, options: { afterTransaction({ record }) {
    if (!changed && record.operations === 2) {
      changed = true
      const node = h.seed.business_nodes[1]
      h.fake.replace('business_nodes', node._id, { ...node, latestFeedbackRevision: 99 })
    }
  } } })
  await assert.rejects(h.repository.getAnalysis({ actor: h.actors[0], range: h.analysisRange }), { code: 'REPORT_CHANGED' })
  assert.equal(changed, true)
})

test('unknown document-read failures propagate instead of becoming incomplete success', async () => {
  let nodeReads = 0
  const h = harness({ nodes: 5, options: { transformRead({ collection, data }) {
    if (collection === 'business_nodes' && data._id === 'cap-node-000000-1' && ++nodeReads === 2) {
      throw Object.assign(new Error('synthetic read failure'), { code: 'READ_UNAVAILABLE' })
    }
    return data
  } } })
  await assert.rejects(h.repository.getSummary({ actor: h.actors[0], range: h.range }), { code: 'READ_UNAVAILABLE' })
})

test('batched caches remain isolated for equally sized memberships with different selected values', async () => {
  const h = harness({ nodes: 5, lines: 2, mutateSeed(seed) {
    const line = seed.business_lines[1]
    for (const node of seed.business_nodes.filter(node => node.businessLineId === line._id)) {
      const feedback = seed.node_feedback.find(item => item._id === node.latestFeedbackId)
      feedback.fieldValues.find(field => field.fieldKey === 'choice').value = 'B'
      const snapshot = domain.selectionSnapshot(domain.buildFinalFieldResult({ line, node, feedback, round: null, votes: [] }))
      const index = seed.operations_field_snapshots.findIndex(item => item._id === node._id)
      seed.operations_field_snapshots[index] = { _id: node._id, ...snapshot }
    }
  } })
  const [first, second] = await Promise.all([h.actors[5], h.actors[6]].map(actor => h.repository.getSummary({ actor, range: h.range })))
  assert.equal(first.sampledNodeCount, 5)
  assert.equal(second.sampledNodeCount, 5)
  assert.equal(occurrences(first, 'A'), 5)
  assert.equal(occurrences(first, 'B'), 0)
  assert.equal(occurrences(second, 'A'), 0)
  assert.equal(occurrences(second, 'B'), 5)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('a malformed analysis identity is a per-node gap beside valid cached neighbors', async () => {
  const h = harness({ nodes: 5, mutateSeed(seed) {
    seed.operations_field_snapshots[1].fields[0].compatibilityKey = '0'.repeat(64)
  } })
  const result = await h.repository.getAnalysis({ actor: h.actors[0], range: h.analysisRange })
  assert.equal(result.incomplete, true)
  assert.equal(result.sampleCount, 4)
  assert.equal(result.items.length, 4)
  assert.equal(h.fake.readCalls.some(call => call.collection === 'node_feedback'), false)
  assert.equal(h.fake.writeCalls.length, 0)
  assert.ok(h.fake.transactionRuns.every(run => run.operations <= 22))
})

test('transaction replay discards a soft error from the aborted cache-validation attempt', async () => {
  let h, nodeReads = 0
  h = harness({ nodes: 5, options: { transformRead({ collection, data }) {
    if (collection === 'business_nodes' && data._id === 'cap-node-000000-1' && ++nodeReads === 2) {
      // Simulate another transaction committing without changing the source.
      // The failed attempt sees a transient per-node error; replay must not keep it.
      h.fake.replace('users', h.actors[0]._id, h.actors[0])
      throw Object.assign(new Error('synthetic transient source failure'), { code: 'FIELD_SOURCE_INVALID' })
    }
    return data
  } } })
  const result = await h.repository.getAnalysis({ actor: h.actors[0], range: h.analysisRange })
  assert.equal(result.incomplete, false)
  assert.equal(result.sampleCount, 5)
  assert.equal(result.items.length, 5)
  assert.equal(h.fake.metrics.retries, 1)
  assert.equal(h.fake.transactionRuns[0].callbacks, 2)
  assert.equal(h.fake.writeCalls.length, 0)
  assert.ok(h.fake.transactionRuns.every(run => run.operations <= 22))
})

test('interleaved multi-line input keeps item identity and within-line order across batch boundaries', () => {
  const items = Array.from({ length: 45 }, (_, index) => ['first', 'second', 'third']
    .map(line => ({ line, index }))).flat()
  const batches = groupNodeReads(items, item => item.line)
  assert.equal(batches.length, 9)
  assert.deepEqual(batches.map(batch => batch.length), [20, 20, 5, 20, 20, 5, 20, 20, 5])
  assert.ok(batches.every(batch => batch.every(item => item.line === batch[0].line)))
  for (const line of ['first', 'second', 'third']) {
    const actual = batches.filter(batch => batch[0].line === line).flat()
    const expected = items.filter(item => item.line === line)
    assert.deepEqual(actual, expected)
    actual.forEach((item, index) => assert.equal(item, expected[index]))
  }
  assert.deepEqual(groupNodeReads([], item => item.line), [])
})

test('multi-line batches preserve ordered analysis output regardless of stored document insertion order', async () => {
  const ordered = harness({ nodes: 25, lines: 2 })
  const reversed = harness({ nodes: 25, lines: 2, mutateSeed(seed) {
    for (const name of ['business_nodes', 'business_lines', 'operations_field_snapshots']) seed[name].reverse()
  } })
  const first = await ordered.repository.getAnalysis({ actor: ordered.actors[0], range: ordered.analysisRange })
  const second = await reversed.repository.getAnalysis({ actor: reversed.actors[0], range: reversed.analysisRange })
  assert.deepEqual(second, first)
  assert.equal(first.incomplete, false)
  assert.equal(first.sampleCount, 50)
  for (const h of [ordered, reversed]) {
    assert.ok(h.fake.transactionRuns.every(run => run.operations <= 22))
    assert.ok(h.fake.metrics.maxActiveCallbacks <= 4)
    assert.equal(h.fake.writeCalls.length, 0)
    assert.equal(h.fake.transactionQueries.length, 0)
  }
})
