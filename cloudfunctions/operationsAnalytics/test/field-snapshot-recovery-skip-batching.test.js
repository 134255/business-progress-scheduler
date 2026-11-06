'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { fieldSource } = require('../../businessApi/test/helpers/field-fixtures')
const { createFieldSnapshotRecovery } = require('../lib/field-snapshot-recovery')

const CURSOR = 'operations-field-snapshot-cursor'
const NOW = new Date('2026-11-02T03:00:00Z')
const OPTIONS = { batchSize: 40, timeBudgetMs: 5000 }
const PROTECTED = ['business_nodes', 'business_lines', 'node_feedback', 'node_review_rounds',
  'node_review_votes', 'notifications']
function skipHarness(count, options = {}) {
  const input = Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, '0')
    return fieldSource({ nodeId: `node-${suffix}`, reviewed: options.reviewed === true,
      line: { _id: `line-${suffix}`, code: `SYNTH-${suffix}` },
      node: options.completed ? {} : { status: 'in_progress', routeState: 'active' } })
  })
  const fake = createFakeCloudDatabase({
    business_nodes: input.map(source => source.node), business_lines: input.map(source => source.line),
    node_feedback: input.map(source => source.feedback),
    node_review_rounds: input.map(source => source.round).filter(Boolean),
    node_review_votes: input.flatMap(source => source.votes), operations_field_snapshots: [],
    notifications: [{ _id: 'old-note', read: false }], system_settings: []
  }, { rejectExplicitIdOnSet: true, ...options.fakeOptions })
  const recovery = createFieldSnapshotRecovery({ db: fake.db, clock: options.clock || (() => NOW) })
  return { fake, recovery, input }
}
function cursor(fake) { return fake.documents('system_settings').find(row => row._id === CURSOR) }
function cursorWrites(fake) { return fake.writeCalls.filter(row => row.collection === 'system_settings' && row.id === CURSOR) }
function protectedState(fake) { return PROTECTED.map(name => fake.documents(name)) }
function complete(fake, source, manual = false) {
  fake.replace('business_nodes', source.node._id, { ...source.node,
    status: manual ? 'awaiting_decision' : 'completed',
    routeState: manual ? 'awaiting_manual_decision' : 'completed' })
}
async function cycleMetrics(fake, recovery) {
  const before = { reads: fake.readCalls.length, queries: fake.queryCalls.length,
    writes: cursorWrites(fake).length, transactions: fake.transactionRuns.length }
  const result = await recovery.runCycle(OPTIONS)
  return { result, reads: fake.readCalls.length - before.reads,
    queries: fake.queryCalls.length - before.queries,
    writes: cursorWrites(fake).length - before.writes,
    transactions: fake.transactionRuns.length - before.transactions }
}

// Catches restoring per-node checkpoint writes or spending savings on more queries.
test('thirty excluded nodes share checkpoints without altering source state', async () => {
  const { fake, recovery } = skipHarness(30)
  await recovery.runCycle(OPTIONS)
  const before = protectedState(fake)
  const sample = await cycleMetrics(fake, recovery)
  assert.deepEqual(sample, { result: { examined: 30, generated: 0, failed: 0, hasMore: false },
    reads: 39, queries: 1, writes: 8, transactions: 8 })
  assert.deepEqual(protectedState(fake), before)
  assert.equal(fake.transactionQueries.length, 0)
  assert.ok(fake.transactionRuns.every(run => run.operations <= 100))
  assert.equal(fake.documents('operations_field_snapshots').length, 0)
})

for (const [count, reads, writes] of [[0, 0, 0], [1, 2, 1], [2, 4, 2]]) {
  test(`${count} excluded candidates keep original costs without a suffix probe`, async () => {
    const { fake, recovery } = skipHarness(count)
    await recovery.runCycle(OPTIONS)
    const sample = await cycleMetrics(fake, recovery)
    assert.equal(sample.reads, reads + (count ? 1 : 0)) // empty DB has no successful cursor read
    assert.equal(sample.writes, writes)
    assert.equal(sample.transactions, writes)
    assert.equal(sample.result.failed, 0)
  })
}

for (const count of [40, 41]) {
  test(`${count} excluded nodes preserve raw forty-row pages and true-tail wrap`, async () => {
    const { fake, recovery } = skipHarness(count)
    const first = await cycleMetrics(fake, recovery)
    assert.equal(first.result.examined, 40)
    assert.equal(first.result.hasMore, true)
    assert.equal(first.writes, 10)
    assert.equal(first.transactions, 10)
    assert.equal(cursor(fake).cursorId, 'node-040')
    const second = await cycleMetrics(fake, recovery)
    assert.equal(second.result.examined, count - 40)
    assert.equal(second.result.hasMore, false)
    assert.equal(cursor(fake).cursorId, null)
    assert.equal(fake.queryCalls.length, 2)
    assert.ok(fake.queryCalls.every(call => call.limit === 40 && call.offset === 0))
  })
}

test('completed unchanged nodes retain the full authoritative path', async () => {
  const { fake, recovery } = skipHarness(30, { completed: true })
  await recovery.runCycle(OPTIONS)
  const before = fake.documents('operations_field_snapshots')
  const readStart = fake.readCalls.length
  const sample = await cycleMetrics(fake, recovery)
  assert.deepEqual(sample, { result: { examined: 30, generated: 0, failed: 0, hasMore: false },
    reads: 181, queries: 17, writes: 30, transactions: 60 })
  assert.equal(fake.readCalls.slice(readStart).filter(call => call.transaction &&
    ['business_lines', 'business_nodes', 'node_feedback', 'operations_field_snapshots'].includes(call.collection)).length, 120)
  assert.deepEqual(fake.documents('operations_field_snapshots'), before)
})

for (const manual of [false, true]) {
  test(`suffix becoming ${manual ? 'manual decision' : 'completed'} is not skipped`, async () => {
    const { fake, recovery, input } = skipHarness(8)
    fake.beforeNextTransaction(() => fake.beforeNextTransaction(() => complete(fake, input[3], manual)))
    const result = await recovery.runCycle(OPTIONS)
    assert.equal(result.generated, 1)
    assert.equal(result.failed, 0)
    assert.deepEqual(fake.documents('operations_field_snapshots').map(row => row.nodeId), ['node-004'])
    const ids = cursorWrites(fake).map(write => write.data.cursorId)
    assert.ok(ids.indexOf('node-003') < ids.indexOf('node-004'))
    assert.equal(cursor(fake).cursorId, null)
  })
}

test('a competing cursor stops the suffix without rewinding', async () => {
  const { fake, recovery } = skipHarness(8)
  fake.beforeNextTransaction(() => fake.beforeNextTransaction(() =>
    fake.replace('system_settings', CURSOR, { cursorId: 'node-008', version: 7, updatedAt: NOW })))
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.hasMore, true)
  assert.equal(cursor(fake).version, 7)
  assert.equal(cursor(fake).cursorId, 'node-008')
  assert.equal(cursorWrites(fake).length, 1)
  assert.equal(fake.documents('operations_field_snapshots').length, 0)
})

test('a conflict retry rereads the suffix and does not reuse its old prefix', async () => {
  let fake, input, mutated = false
  const built = skipHarness(8, { fakeOptions: { transformRead({ collection, data }) {
    const last = fake && fake.readCalls.at(-1)
    if (!mutated && collection === 'business_nodes' && data._id === 'node-002' && last && last.transaction) {
      mutated = true
      complete(fake, input[3])
    }
    return data
  } } })
  ;({ fake, input } = built)
  const result = await built.recovery.runCycle(OPTIONS)
  assert.equal(result.generated, 1)
  assert.equal(fake.metrics.retries, 1)
  assert.ok(fake.readCalls.filter(row => row.id === 'node-002' && row.transaction).length >= 2)
  assert.deepEqual(fake.documents('operations_field_snapshots').map(row => row.nodeId), ['node-004'])
})

for (const kind of ['getter', 'prototype', 'nonmonotonic']) {
  test(`malformed ${kind} page hint cannot silently fast-forward a node`, async () => {
    let seen = false, getterCalls = 0
    const { fake, recovery } = skipHarness(8, { fakeOptions: { transformRead({ collection, data }) {
      if (!seen && collection === 'business_nodes' && data._id === 'node-003') {
        seen = true
        if (kind === 'getter') Object.defineProperty(data, 'status', { enumerable: true,
          get() { getterCalls++; return 'in_progress' } })
        else if (kind === 'prototype') Object.setPrototypeOf(data, { inherited: true })
        else data._id = 'node-001'
      }
      return data
    } } })
    const result = await recovery.runCycle(OPTIONS)
    assert.equal(getterCalls, 0)
    if (kind !== 'getter') {
      assert.equal(result.failed, 1)
      assert.equal(cursor(fake).cursorId, 'node-002')
    } else {
      assert.equal(result.failed, 0)
      assert.equal(cursor(fake).cursorId, null)
    }
  })
}

test('missing suffix node retains the original no-generation meaning', async () => {
  const { fake, recovery } = skipHarness(8)
  fake.beforeNextTransaction(() => fake.beforeNextTransaction(() => fake.state.business_nodes.delete('node-003')))
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 0)
  assert.equal(result.generated, 0)
  assert.equal(cursor(fake).cursorId, null)
  assert.equal(cursorWrites(fake).length, 2)
})

test('cursor version boundary does not overflow during a suffix commit', async () => {
  const { fake, recovery } = skipHarness(8)
  fake.replace('system_settings', CURSOR, { cursorId: null, version: Number.MAX_SAFE_INTEGER - 2 })
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 1)
  assert.equal(cursor(fake).version, Number.MAX_SAFE_INTEGER - 1)
  assert.equal(cursor(fake).cursorId, 'node-001')
  assert.equal(cursorWrites(fake).length, 1)
})

test('suffix transport read failure stops without replaying single candidates', async () => {
  let fake
  const built = skipHarness(8, { fakeOptions: { transformRead({ collection, data }) {
    const last = fake && fake.readCalls.at(-1)
    if (collection === 'business_nodes' && data._id === 'node-003' && last && last.transaction) {
      throw new Error('synthetic unavailable transport')
    }
    return data
  } } })
  fake = built.fake
  const result = await built.recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 1)
  assert.equal(result.hasMore, true)
  assert.equal(cursor(fake).cursorId, 'node-001')
  assert.equal(fake.transactionRuns.length, 2)
  assert.equal(fake.readCalls.some(row => row.id === 'node-004'), false)
})

test('suffix cursor write failure preserves the anchor and rolls back the batch', async () => {
  const { fake, recovery } = skipHarness(8)
  fake.beforeNextTransaction(() => fake.beforeNextTransaction(() => fake.failNextWrite({
    collection: 'system_settings', operation: 'set', error: new Error('synthetic write unavailable')
  })))
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 1)
  assert.equal(cursor(fake).cursorId, 'node-001')
  assert.equal(cursorWrites(fake).length, 1)
  assert.equal(fake.transactionRuns.length, 2)
})

test('unknown commit stops even when the suffix checkpoint was committed', async () => {
  let commits = 0
  const { fake, recovery } = skipHarness(10, { fakeOptions: { afterTransaction() {
    if (++commits === 2) throw new Error('synthetic unknown commit')
  } } })
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 1)
  assert.equal(result.hasMore, true)
  assert.equal(cursor(fake).cursorId, 'node-008')
  assert.equal(fake.transactionRuns.length, 2)
  assert.equal(fake.readCalls.some(row => row.id === 'node-009'), false)
})

test('repeated suffix timeouts still reach later nodes through anchor checkpoints', async () => {
  let milliseconds = NOW.getTime(), fake
  const built = skipHarness(12, { clock: () => new Date(milliseconds), fakeOptions: {
    transformRead({ collection, data }) {
      const last = fake && fake.readCalls.at(-1)
      if (collection === 'business_nodes' && data.status === 'in_progress' && last && last.transaction) milliseconds += 5000
      return data
    }
  } })
  fake = built.fake
  complete(fake, built.input[11])
  for (let cycle = 0; cycle < 12 && !fake.documents('operations_field_snapshots').length; cycle++) {
    const start = milliseconds, before = cursorWrites(fake).length
    const result = await built.recovery.runCycle(OPTIONS)
    assert.equal(result.failed, 0)
    const writes = cursorWrites(fake).slice(before)
    assert.ok(writes.length > 0)
    assert.ok(writes.every(write => write.data.updatedAt.getTime() < start + 5000))
    milliseconds += 10000
  }
  assert.deepEqual(fake.documents('operations_field_snapshots').map(row => row.nodeId), ['node-012'])
})

test('mixed candidates keep normal snapshots and do not write business or old notifications', async () => {
  const { fake, recovery, input } = skipHarness(15, { reviewed: true })
  complete(fake, input[8]); complete(fake, input[12], true)
  const before = protectedState(fake)
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 0)
  assert.equal(result.generated, 2)
  assert.deepEqual(fake.documents('operations_field_snapshots').map(row => row.nodeId).sort(), ['node-009', 'node-013'])
  assert.deepEqual(protectedState(fake), before)
  assert.ok(fake.writeCalls.every(write => ['system_settings', 'operations_field_snapshots'].includes(write.collection)))
  assert.equal(fake.transactionQueries.length, 0)
})
