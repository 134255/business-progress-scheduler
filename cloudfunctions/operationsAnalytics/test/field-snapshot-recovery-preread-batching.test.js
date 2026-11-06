'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { fieldSource } = require('../../businessApi/test/helpers/field-fixtures')
const { createFieldSnapshotRecovery } = require('../lib/field-snapshot-recovery')
const NOW = new Date('2026-11-06T03:00:00Z'), OPTIONS = { batchSize: 40, timeBudgetMs: 5000 }
const PROTECTED = ['business_nodes', 'business_lines', 'node_feedback', 'node_review_rounds', 'node_review_votes', 'notifications']
function harness(count, options = {}) {
  const input = Array.from({ length: count }, (_, i) => fieldSource({ nodeId: `node-${String(i + 1).padStart(3, '0')}`,
    reviewed: options.reviewed === true, line: { _id: `line-${i + 1}`, code: `SYNTH-${i + 1}` },
    node: options.unfinished ? { status: 'in_progress', routeState: 'active' } : {} }))
  const seed = { business_nodes: input.map(s => s.node), business_lines: input.map(s => s.line),
    node_feedback: input.map(s => s.feedback), node_review_rounds: input.map(s => s.round).filter(Boolean),
    node_review_votes: input.flatMap(s => s.votes), operations_field_snapshots: [], system_settings: [],
    notifications: [{ _id: 'old-notice', read: false }] }
  const fake = createFakeCloudDatabase(seed, { rejectExplicitIdOnSet: true, ...options.fakeOptions })
  function wrap(value, collection, isDocument = false, criteria) {
    return new Proxy(value, { get(target, key) {
      if (key === 'get') return async (...args) => {
        if (options.beforeGet) await options.beforeGet({ fake, collection, isDocument, criteria })
        const result = await target.get(...args)
        return options.afterGet ? await options.afterGet({ fake, collection, isDocument, criteria, result }) || result : result
      }
      if (['doc', 'where', 'field', 'orderBy', 'limit', 'skip'].includes(key)) return (...args) =>
        wrap(target[key](...args), collection, isDocument || key === 'doc', key === 'where' ? args[0] : criteria)
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
    } })
  }
  const db = new Proxy(fake.db, { get(target, key) {
    if (key === 'collection') return name => wrap(target.collection(name), name)
    return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
  } })
  const recovery = createFieldSnapshotRecovery({ db, clock: options.clock || (() => NOW), ...options.dependencies })
  const protectedState = () => Object.fromEntries(PROTECTED.map(name => [name, fake.documents(name)]))
  return { input, fake, recovery, protectedState }
}
const contentQueries = fake => fake.queryCalls.filter(c => ['business_lines', 'node_feedback'].includes(c.collection))
const contentGets = (fake, transaction) => fake.readCalls.filter(c =>
  ['business_lines', 'node_feedback'].includes(c.collection) && c.transaction === transaction)

// Removing batching must fail the 8 exact prereads ->2 bounded queries assertion.
test('four completed sources batch only line/feedback prereads and retain all publication reads', async () => {
  const h = harness(4), before = h.protectedState()
  assert.deepEqual(await h.recovery.runCycle(OPTIONS), { examined: 4, generated: 4, failed: 0, hasMore: false })
  assert.equal(contentGets(h.fake, false).length, 0)
  assert.equal(contentQueries(h.fake).length, 2)
  assert.ok(contentQueries(h.fake).every(c => c.limit === 4 && c.criteria._id.__operator === 'in'))
  assert.equal(contentGets(h.fake, true).length, 8)
  assert.deepEqual(h.fake.documents('operations_field_snapshots').map(s => [s.nodeId, s.fields.map(f => f.value)]),
    ['node-001', 'node-002', 'node-003', 'node-004'].map(id => [id, ['A', ['X', 'Y']]]))
  assert.deepEqual(h.protectedState(), before)
  assert.deepEqual(h.fake.transactionQueries, [])
})

test('reviewed preread batching keeps round enumeration and individual transactional votes', async () => {
  const h = harness(4, { reviewed: true })
  assert.equal((await h.recovery.runCycle(OPTIONS)).generated, 4)
  assert.equal(contentQueries(h.fake).length, 2)
  const voteQueries = h.fake.queryCalls.filter(c => c.collection === 'node_review_votes')
  assert.equal(voteQueries.length, 4); assert.ok(voteQueries.every(c => c.limit === 51))
  assert.equal(h.fake.readCalls.filter(c => c.collection === 'node_review_votes' && c.transaction).length, 4)
  assert.equal(h.fake.readCalls.filter(c => c.collection === 'node_review_rounds').length, 8)
})

test('one source and an unfinished page do not introduce content batch queries', async () => {
  const single = harness(1)
  assert.equal((await single.recovery.runCycle(OPTIONS)).generated, 1)
  assert.equal(contentQueries(single.fake).length, 0); assert.equal(contentGets(single.fake, false).length, 2)
  const unfinished = harness(30, { unfinished: true })
  assert.equal((await unfinished.recovery.runCycle(OPTIONS)).generated, 0)
  assert.equal(contentQueries(unfinished.fake).length, 0); assert.equal(contentGets(unfinished.fake, false).length, 0)
})

test('nine sources use bounded groups without prefetching past the current page', async () => {
  const h = harness(9)
  assert.equal((await h.recovery.runCycle(OPTIONS)).generated, 9)
  assert.equal(contentQueries(h.fake).length, 4)
  assert.ok(contentQueries(h.fake).every(c => c.limit <= 4 && c.criteria._id.values.length <= 4))
  assert.equal(contentGets(h.fake, false).length, 2)
})

test('out of order batch rows are mapped to the right source, not array positions', async () => {
  const h = harness(4, { afterGet({ collection, isDocument, result }) {
    if (!isDocument && ['business_lines', 'node_feedback'].includes(collection)) return { data: result.data.reverse() }
  } })
  assert.equal((await h.recovery.runCycle(OPTIONS)).generated, 4)
  assert.equal(contentQueries(h.fake).length, 2)
  assert.deepEqual(h.fake.documents('operations_field_snapshots').map(s => [s.nodeId, s.businessCode]),
    [['node-001', 'SYNTH-1'], ['node-002', 'SYNTH-2'], ['node-003', 'SYNTH-3'], ['node-004', 'SYNTH-4']])
})

for (const mode of ['duplicate', 'outside', 'non-array', 'accessor-index']) {
  test(`malformed ${mode} batch response stops without exact-read replay or publication`, async () => {
    let getterCalls = 0
    const h = harness(4, { afterGet({ collection, isDocument, result }) {
      if (isDocument || collection !== 'business_lines') return
      if (mode === 'duplicate') return { data: [result.data[0], result.data[0]] }
      if (mode === 'outside') return { data: [{ ...result.data[0], _id: 'not-requested' }] }
      if (mode === 'non-array') return { data: {} }
      const rows = []
      Object.defineProperty(rows, '0', { get() { getterCalls++; return result.data[0] } })
      return { data: rows }
    } })
    const result = await h.recovery.runCycle(OPTIONS)
    assert.equal(result.generated, 0); assert.equal(result.failed, 1)
    assert.equal(contentQueries(h.fake).length, 1)
    assert.equal(contentGets(h.fake, false).length, 0)
    assert.equal(h.fake.documents('operations_field_snapshots').length, 0)
    assert.equal(getterCalls, 0)
    assert.equal(h.fake.documents('system_settings')[0].cursorId, 'node-001')
  })
}

test('an unknown batch transport result never falls back to singles or another group', async () => {
  const h = harness(4, { afterGet({ collection, isDocument }) {
    if (!isDocument && collection === 'node_feedback') throw Error('synthetic response lost')
  } })
  const result = await h.recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 1); assert.equal(result.generated, 0)
  assert.equal(contentQueries(h.fake).length, 2)
  assert.equal(contentGets(h.fake, false).length, 0)
  assert.equal(h.fake.transactionRuns.length, 1)
})

test('a legitimately missing future line fails only its visit and healthy successors complete', async () => {
  const h = harness(4, { afterGet({ collection, isDocument, result }) {
    if (!isDocument && collection === 'business_lines') return { data: result.data.filter(r => r._id !== 'line-2') }
  } })
  const result = await h.recovery.runCycle(OPTIONS)
  assert.equal(result.generated, 3); assert.equal(result.failed, 1)
  assert.deepEqual(h.fake.documents('operations_field_snapshots').map(s => s.nodeId), ['node-001', 'node-003', 'node-004'])
  assert.equal(h.fake.documents('system_settings')[0].cursorId, null)
})

test('future content accessors remain inert and cannot block the healthy claimed prefix', async () => {
  let executed = 0
  const h = harness(4, { afterGet({ collection, isDocument, result }) {
    if (!isDocument && collection === 'node_feedback') for (const row of result.data) if (row._id === 'feedback-node-002') {
      Object.defineProperty(row, 'fieldValues', { enumerable: true, get() { executed++; throw Error('must not execute') } })
    }
  } })
  const result = await h.recovery.runCycle(OPTIONS)
  assert.equal(result.generated, 3); assert.equal(result.failed, 1); assert.equal(executed, 0)
  assert.equal(h.fake.documents('operations_field_snapshots')[0].nodeId, 'node-001')
})

test('a known changed feedback pointer reads the new fixed ID rather than the old prepared record', async () => {
  let changed = false
  const h = harness(4, { beforeGet({ fake, collection, isDocument }) {
    if (changed || !isDocument || collection !== 'business_nodes' || contentQueries(fake).length < 2) return
    changed = true
    const node = fake.documents('business_nodes').find(n => n._id === 'node-002')
    const feedback = fake.documents('node_feedback').find(f => f._id === node.latestFeedbackId)
    const next = structuredClone(feedback); next._id = 'new-feedback-002'; next.fieldValues[0].value = 'B'
    fake.replace('node_feedback', next._id, next)
    fake.replace('business_nodes', node._id, { ...node, latestFeedbackId: next._id })
  } })
  const result = await h.recovery.runCycle(OPTIONS)
  assert.equal(result.generated, 4); assert.equal(result.failed, 0)
  assert.equal(h.fake.documents('operations_field_snapshots').find(s => s.nodeId === 'node-002').fields[0].value, 'B')
  assert.equal(h.fake.readCalls.filter(r => !r.transaction && r.id === 'new-feedback-002').length, 1)
})

test('same-ID same-revision content changed after preread is still refused by the full digest comparison', async () => {
  let armed = true
  const h = harness(4, { afterGet({ fake, collection, isDocument }) {
    if (armed && !isDocument && collection === 'node_feedback') {
      armed = false
      fake.beforeNextTransaction(() => {
        const feedback = fake.documents('node_feedback').find(f => f._id === 'feedback-node-001')
        feedback.fieldValues[0].value = 'B'; fake.replace('node_feedback', feedback._id, feedback)
      })
    }
  } })
  const result = await h.recovery.runCycle(OPTIONS)
  assert.equal(result.failed, 1); assert.equal(result.generated, 3)
  assert.equal(h.fake.documents('operations_field_snapshots').some(s => s.nodeId === 'node-001'), false)
})

test('a batch crossing the budget cannot trigger a feedback request or a late publication', async () => {
  let milliseconds = NOW.getTime(), first = true
  const h = harness(4, { clock: () => new Date(milliseconds), afterGet({ collection, isDocument }) {
    if (first && !isDocument && collection === 'business_lines') { first = false; milliseconds += 5000 }
  } })
  assert.equal((await h.recovery.runCycle(OPTIONS)).generated, 0)
  assert.equal(contentQueries(h.fake).length, 1)
  assert.equal(h.fake.documents('operations_field_snapshots').length, 0)
  assert.equal(h.fake.documents('system_settings')[0].cursorId, 'node-001')
  const later = await h.recovery.runCycle(OPTIONS)
  assert.equal(later.generated, 3)
  assert.deepEqual(h.fake.documents('operations_field_snapshots').map(s => s.nodeId), ['node-002', 'node-003', 'node-004'])
})

test('future eligibility loss discards hints without treating the page as authority', async () => {
  let changed = false
  const h = harness(4, { beforeGet({ fake, collection, isDocument }) {
    if (changed || !isDocument || collection !== 'business_nodes' || contentQueries(fake).length < 2) return
    changed = true
    const node = fake.documents('business_nodes').find(n => n._id === 'node-002')
    fake.replace('business_nodes', node._id, { ...node, status: 'in_progress', routeState: 'active' })
  } })
  const result = await h.recovery.runCycle(OPTIONS)
  assert.equal(result.generated, 3); assert.equal(result.failed, 0)
  assert.equal(h.fake.documents('operations_field_snapshots').some(s => s.nodeId === 'node-002'), false)
})

// Copying must preserve corruption, not normalize it into a valid source.
for (const prototypeKind of ['null', 'custom']) for (const nodeNumber of ['001', '002']) {
  test(`${prototypeKind} array prototype at node-${nodeNumber} is rejected at its own visit`, async () => {
    const h = harness(4, { afterGet({ collection, isDocument, result }) {
      if (!isDocument && collection === 'node_feedback') for (const row of result.data)
        if (row._id === `feedback-node-${nodeNumber}`)
          Object.setPrototypeOf(row.fieldValues, prototypeKind === 'null' ? null : Object.create(Array.prototype))
    } })
    const result = await h.recovery.runCycle(OPTIONS)
    assert.equal(result.generated, 3); assert.equal(result.failed, 1)
    assert.equal(h.fake.documents('operations_field_snapshots').some(s => s.nodeId === `node-${nodeNumber}`), false)
    if (nodeNumber === '002') assert.equal(h.fake.documents('operations_field_snapshots')[0].nodeId, 'node-001')
  })
}
