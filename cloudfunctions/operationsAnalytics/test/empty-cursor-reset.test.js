'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudAnalyticsRepository } = require('../lib/cloud-analytics-repository')

const SPECS = [
  ['node', 'claimNodeCandidates', 'business_nodes', { analyticsSnapshotStatus: 'pending' }],
  ['decision', 'claimDecisionCandidates', 'business_nodes', { decisionAnalyticsSnapshotStatus: 'pending' }],
  ['business', 'claimBusinessCandidates', 'business_lines', { analyticsSnapshotStatus: 'pending' }],
  ['refresh', 'claimPendingFactCandidates', 'operations_analytics_facts', { timingStatus: 'pending_calendar' }]
]
const cursor = (kind, cursorId = 'middle-id', version = 7) => ({
  _id: `operations-analytics-${kind}-cursor`, kind: `operations_analytics_${kind}`, cursorId, version
})
const row = (spec, id) => ({ _id: id, ...spec[3], ...(spec[0] === 'refresh'
  ? { sourceType: 'node', sourceId: `source-${id}` } : {}) })

function harness(spec = SPECS[0], { stored = cursor(spec[0]), seed = {}, hooks = {}, fakeOptions = {} } = {}) {
  const initial = {
    business_nodes: [], business_lines: [], node_review_rounds: [], node_review_votes: [],
    operations_analytics_facts: [], operations_analytics_daily: [],
    users: [{ _id: 'untouched-user', status: 'active' }],
    notifications: [{ _id: 'untouched-notification', status: 'pending' }],
    system_settings: stored ? [stored] : [], ...seed
  }
  const fake = createFakeCloudDatabase(initial, { rejectExplicitIdOnSet: true, ...fakeOptions })
  const counts = { get: 0, query: 0, set: 0, transactions: 0 }
  function wrap(value, collection, transaction = false, id = null) {
    return new Proxy(value, { get(target, key) {
      const method = target[key]
      if (typeof method !== 'function') return method
      return (...args) => {
        const context = { collection, transaction, id, key, counts, fake }
        if (key === 'get') return (async () => {
          counts[id === null ? 'query' : 'get']++
          await hooks.beforeGet?.(context)
          const result = await method.apply(target, args)
          await hooks.afterGet?.({ ...context, result })
          return result
        })()
        if (key === 'set') counts.set++
        const next = method.apply(target, args)
        return next && typeof next === 'object' && typeof next.then !== 'function'
          ? wrap(next, collection, transaction, key === 'doc' ? args[0] : id) : next
      }
    } })
  }
  const db = { ...fake.db, collection: name => wrap(fake.db.collection(name), name),
    runTransaction: callback => {
      counts.transactions++
      return fake.db.runTransaction(tx => callback({ collection: name => wrap(tx.collection(name), name, true) }))
    } }
  const repository = createCloudAnalyticsRepository({ db })
  const protectedNames = Object.keys(initial).filter(name => name !== 'system_settings')
  const protectedState = () => Object.fromEntries(protectedNames.map(name => [name, fake.documents(name)]))
  return { fake, counts, repository, claim: () => repository[spec[1]]({ limit: 40 }),
    saved: () => fake.documents('system_settings').find(value => value._id === cursor(spec[0])._id), protectedState }
}

for (const spec of SPECS) {
  test(`${spec[0]} drained cursor resets once and the next cycle queries only the fresh head`, async () => {
    const h = harness(spec), protectedBefore = h.protectedState()
    assert.deepEqual(await h.claim(), [])
    assert.equal(h.saved().cursorId, null)
    assert.equal(h.saved().version, 8)
    assert.deepEqual(h.counts, { get: 2, query: 2, set: 1, transactions: 1 })
    assert.deepEqual(await h.claim(), [])
    assert.deepEqual(h.counts, { get: 3, query: 3, set: 1, transactions: 1 })
    assert.deepEqual(h.protectedState(), protectedBefore)
    assert.deepEqual(Object.keys(h.saved()).sort(), ['_id', 'cursorId', 'kind', 'updatedAt', 'version'])
  })

  test(`${spec[0]} missing and already-null cursors stay write-free`, async () => {
    for (const stored of [null, cursor(spec[0], null)]) {
      const h = harness(spec, { stored })
      assert.deepEqual(await h.claim(), [])
      assert.deepEqual(await h.claim(), [])
      assert.deepEqual(h.counts, { get: 2, query: 2, set: 0, transactions: 0 })
      assert.deepEqual(h.saved(), stored || undefined)
    }
  })

  test(`${spec[0]} a nonempty head after an empty tail retains normal claim and wrap behavior`, async () => {
    const h = harness(spec, { seed: { [spec[2]]: [row(spec, 'aaa-new')] } })
    const result = await h.claim()
    assert.deepEqual(result, spec[0] === 'refresh'
      ? [{ sourceType: 'node', sourceId: 'source-aaa-new' }] : [{ sourceId: 'aaa-new' }])
    assert.equal(h.saved().cursorId, 'aaa-new')
    assert.equal(h.saved().version, 8)
    assert.deepEqual(h.counts, { get: 2, query: 2, set: 1, transactions: 1 })
  })

  test(`${spec[0]} low and high IDs inserted after both empty observations are found next cycle`, async () => {
    let inserted = false
    const h = harness(spec, { hooks: { afterGet({ id, counts, fake }) {
      if (id === null && counts.query === 2 && !inserted) {
        inserted = true
        for (const id of ['aaa-new', 'zzz-new']) fake.replace(spec[2], id, row(spec, id))
      }
    } } })
    assert.deepEqual(await h.claim(), [])
    assert.equal(h.saved().cursorId, null)
    const result = await h.claim()
    assert.deepEqual(result, spec[0] === 'refresh'
      ? [{ sourceType: 'node', sourceId: 'source-aaa-new' }, { sourceType: 'node', sourceId: 'source-zzz-new' }]
      : [{ sourceId: 'aaa-new' }, { sourceId: 'zzz-new' }])
    assert.equal(h.saved().cursorId, 'zzz-new')
  })
}

test('a competing claimant advancing the cursor cannot be rewound by stale empty observations', async () => {
  let competitor
  let entered = false
  const spec = SPECS[0]
  const h = harness(spec, { hooks: { async afterGet({ id, counts, fake }) {
    if (id === null && counts.query === 2 && !entered) {
      entered = true
      fake.replace('business_nodes', 'zzz-new', row(spec, 'zzz-new'))
      competitor = await h.claim()
    }
  } } })
  assert.deepEqual(await h.claim(), [])
  assert.deepEqual(competitor, [{ sourceId: 'zzz-new' }])
  assert.equal(h.saved().cursorId, 'zzz-new')
  assert.equal(h.saved().version, 8)
  assert.equal(h.fake.writeCalls.length, 1)
})

test('two concurrent resets commit one version increment', async () => {
  const h = harness()
  assert.deepEqual(await Promise.all([h.claim(), h.claim()]), [[], []])
  assert.equal(h.saved().cursorId, null)
  assert.equal(h.saved().version, 8)
  assert.equal(h.fake.writeCalls.length, 1)
  assert.ok(h.fake.metrics.retries >= 1)
})

test('a transaction retry rereads a competing cursor rather than replaying the original reset', async () => {
  let changed = false
  const h = harness(SPECS[0], { hooks: { afterGet({ id, transaction, fake }) {
    if (transaction && id && !changed) {
      changed = true
      fake.replace('system_settings', id, cursor('node', 'zzz-competitor', 8))
    }
  } } })
  assert.deepEqual(await h.claim(), [])
  assert.equal(h.saved().cursorId, 'zzz-competitor')
  assert.equal(h.saved().version, 8)
  assert.equal(h.fake.metrics.retries, 1)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('a cursor changed to malformed data before reset fails closed', async () => {
  const h = harness()
  h.fake.beforeNextTransaction(() => h.fake.replace('system_settings', cursor('node')._id,
    { ...cursor('node'), kind: 'wrong-kind' }))
  await assert.rejects(h.claim, /cursor is invalid/)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('last safe cursor version can reset but maximum version cannot overflow', async () => {
  const last = harness(SPECS[0], { stored: cursor('node', 'middle-id', Number.MAX_SAFE_INTEGER - 1) })
  assert.deepEqual(await last.claim(), [])
  assert.equal(last.saved().version, Number.MAX_SAFE_INTEGER)
  assert.equal(last.saved().cursorId, null)
  assert.deepEqual(await last.claim(), [])
  assert.equal(last.fake.writeCalls.length, 1)
  const overflow = harness(SPECS[0], { stored: cursor('node', 'middle-id', Number.MAX_SAFE_INTEGER) })
  await assert.rejects(overflow.claim, /cursor is invalid/)
  assert.equal(overflow.saved().cursorId, 'middle-id')
  assert.equal(overflow.fake.writeCalls.length, 0)
})

for (const failAt of [1, 2]) test(`candidate query ${failAt} failure cannot reset or replay`, async () => {
  const h = harness(SPECS[0], { hooks: { beforeGet({ id, counts }) {
    if (id === null && counts.query === failAt) throw new Error('QUERY_UNKNOWN')
  } } })
  await assert.rejects(h.claim, /QUERY_UNKNOWN/)
  assert.equal(h.counts.query, failAt)
  assert.equal(h.counts.transactions, 0)
  assert.equal(h.fake.writeCalls.length, 0)
  assert.equal(h.saved().cursorId, 'middle-id')
})

for (const data of [undefined, null, {}, 'not-an-array']) test(`malformed candidate data ${String(data)} is not an empty observation`, async () => {
  const h = harness(SPECS[0], { hooks: { afterGet({ id, result }) { if (id === null) result.data = data } } })
  await assert.rejects(h.claim, /candidate.*invalid/)
  assert.equal(h.counts.query, 1)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('transactional cursor read failure stops without an extra reset attempt', async () => {
  const h = harness(SPECS[0], { hooks: { beforeGet({ transaction }) {
    if (transaction) throw new Error('READ_UNKNOWN')
  } } })
  await assert.rejects(h.claim, /READ_UNKNOWN/)
  assert.equal(h.counts.transactions, 1)
  assert.equal(h.counts.set, 0)
  assert.equal(h.saved().cursorId, 'middle-id')
})

test('a failed reset write rolls back and is not retried within the call', async () => {
  const h = harness()
  h.fake.failNextWrite({ collection: 'system_settings', operation: 'set', error: new Error('WRITE_FAILED') })
  await assert.rejects(h.claim, /WRITE_FAILED/)
  assert.equal(h.counts.transactions, 1)
  assert.equal(h.counts.set, 1)
  assert.equal(h.saved().cursorId, 'middle-id')
  assert.equal(h.saved().version, 7)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('unknown commit is reported without replay, and a later fresh call observes the committed reset', async () => {
  let once = true
  const h = harness(SPECS[0], { fakeOptions: { afterTransaction() {
    if (once) { once = false; throw new Error('COMMIT_UNKNOWN') }
  } } })
  await assert.rejects(h.claim, /COMMIT_UNKNOWN/)
  assert.equal(h.saved().cursorId, null)
  assert.equal(h.saved().version, 8)
  assert.equal(h.counts.transactions, 1)
  assert.equal(h.fake.writeCalls.length, 1)
  assert.deepEqual(await h.claim(), [])
  assert.equal(h.counts.transactions, 1)
  assert.equal(h.fake.writeCalls.length, 1)
})
