const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createCloudFeedbackRepository } = require('../lib/cloud-feedback-repository')

const NOW = new Date('2026-09-10T01:00:00Z')
const ACTOR = { _id: 'perf-user', status: 'active', role: 'user', openid: 'synthetic-binding' }
const turn = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function seedLines(count) {
  return {
    users: [ACTOR],
    business_lines: Array.from({ length: count }, (_, index) => ({
      _id: `line-${String(index).padStart(4, '0')}`, name: 'Synthetic line', status: 'active',
      managerUserIds: [ACTOR._id], memberUserIds: [ACTOR._id], version: 1,
      currentNodeId: `node-${String(index).padStart(4, '0')}`,
      createdAt: NOW, updatedAt: NOW
    })),
    business_nodes: [], node_feedback: [], evidences: []
  }
}

function seedPending(count) {
  const seed = seedLines(count)
  seed.business_nodes = seed.business_lines.map(line => ({
    _id: line.currentNodeId, businessLineId: line._id, workflowMode: 'review',
    status: 'in_progress', processorUserIds: [ACTOR._id], reviewerUserIds: ['perf-reviewer'],
    processingRoundNumber: 1, processingDueAt: NOW, updatedAt: NOW, version: 1,
    name: 'Synthetic node', sequence: 0, processingDueStatus: 'calculated', reviewDueStatus: 'not_started',
    requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
  }))
  return seed
}

function seedHistory(count) {
  const seed = seedPending(1)
  seed.node_feedback = Array.from({ length: count }, (_, index) => ({
    _id: `feedback-${String(index).padStart(4, '0')}`, businessLineId: 'line-0000', nodeId: 'node-0000',
    publishState: 'published', revision: index + 1, processingRoundNumber: 1,
    action: 'save_progress', comment: 'Synthetic', createdAt: NOW
  }))
  return seed
}

// Real repositories + existing fake DB. Each ready I/O batch takes one virtual
// round; no elapsed-time assertion, live SDK, disk writes or cloud access.
function harness(seed, { beforeRead = async () => {}, fakeOptions = {} } = {}) {
  const fake = createFakeCloudDatabase(seed, fakeOptions)
  const reads = []
  let batch = [], scheduled = false, rounds = 0, active = 0, peak = 0
  function read(operation, run) {
    active += 1
    peak = Math.max(peak, active)
    reads.push(operation)
    return new Promise((resolve, reject) => {
      batch.push({ operation, run, resolve, reject })
      if (scheduled) return
      scheduled = true
      setImmediate(() => {
        const jobs = batch
        batch = []
        scheduled = false
        rounds += 1
        for (const job of jobs) {
          job.operation.round = rounds
          Promise.resolve().then(() => beforeRead(job.operation, fake)).then(job.run).then(value => {
            active -= 1
            job.resolve(value)
          }, error => {
            active -= 1
            job.reject(error)
          })
        }
      })
    })
  }
  function query(source, collection, transaction = false, id = null, criteria = null, offset = 0) {
    return new Proxy(source, { get(target, key) {
      if (key === 'get') return () => read({ collection, transaction, id, criteria, offset }, () => target.get())
      if (['set', 'update', 'remove', 'add'].includes(key)) return () => assert.fail('read-only probe attempted a write')
      if (typeof target[key] !== 'function') return target[key]
      return (...args) => query(target[key](...args), collection, transaction,
        key === 'doc' ? args[0] : id, key === 'where' ? args[0] : criteria, key === 'skip' ? args[0] : offset)
    } })
  }
  const db = {
    command: fake.db.command,
    collection: name => query(fake.db.collection(name), name),
    runTransaction: callback => fake.db.runTransaction(transaction => callback({
      collection: name => query(transaction.collection(name), name, true)
    }))
  }
  return {
    fake, reads,
    business: createCloudBusinessRepository({ db, workTimeService: { tryAddWorkMinutes: async () => null } }),
    feedback: createCloudFeedbackRepository({ db }),
    metrics: () => ({ reads: reads.length, rounds, peak, active, transactions: fake.transactionRuns.length,
      transactionPeak: fake.metrics.maxActiveCallbacks }),
    assertReadOnly() { assert.deepEqual(fake.writeCalls, []); assert.deepEqual(fake.transactionQueries, []) }
  }
}

test('list bounds relation and authoritative reads to four and keeps complete pages, counts and tie order', async t => {
  const h = harness(seedLines(100))
  const result = await h.business.listBusinessLines({ actor: ACTOR, query: { page: 2, pageSize: 20 } })
  assert.equal(result.total, 100)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.items.map(item => item._id), Array.from({ length: 20 }, (_, i) => `line-00${i + 20}`))
  assert.equal(h.fake.queryCalls.length, 6) // Two 100-row streams + their empty pages + two empty legacy streams.
  assert.equal(h.reads.filter(read => read.collection === 'business_lines' && read.id).length, 100)
  assert.equal(h.metrics().peak, 4)
  assert.equal(h.metrics().rounds, 29)
  t.diagnostic(JSON.stringify(h.metrics()))
  h.assertReadOnly()
})

test('summary bounds independent pending transactions to four without sharing account or line reads', async t => {
  const h = harness(seedPending(100))
  const result = await h.business.getMyBusinessSummary({ actor: ACTOR })
  assert.deepEqual(result.stats, { active: 100, completed: 0, pendingProcessing: 100 })
  assert.equal(result.complete, true)
  assert.equal(h.metrics().transactionPeak, 4)
  assert.equal(h.metrics().transactions, 100)
  assert.equal(h.reads.filter(read => read.collection === 'users').length, 103)
  assert.equal(h.metrics().reads, 313)
  assert.equal(h.metrics().rounds, 82)
  t.diagnostic(JSON.stringify(h.metrics()))
  h.assertReadOnly()
})

test('history reads all 101 revisions with at most four attachment queries and stable revision order', async t => {
  const h = harness(seedHistory(101))
  const result = await h.feedback.getNodeHistory({ actor: ACTOR, businessLineId: 'line-0000', nodeId: 'node-0000' })
  assert.equal(result.history.length, 101)
  assert.deepEqual(result.history.map(row => row.revision), Array.from({ length: 101 }, (_, i) => 101 - i))
  assert.equal(h.fake.queryCalls.filter(call => call.collection === 'node_feedback').length, 2)
  assert.equal(h.fake.queryCalls.filter(call => call.collection === 'evidences').length, 101)
  assert.equal(h.metrics().peak, 4)
  assert.equal(h.metrics().rounds, 34) // Final actor/line/node reauthorization adds three fixed reads.
  for (const collection of ['users', 'business_lines', 'business_nodes']) {
    assert.equal(h.reads.filter(read => read.collection === collection && read.id).length, 2)
  }
  assert.equal(h.metrics().transactions, 2)
  t.diagnostic(JSON.stringify(h.metrics()))
  h.assertReadOnly()
})

test('list final rereads continue excluding revoked membership and changed status before totals', async () => {
  const h = harness(seedLines(8), { beforeRead(read, fake) {
    if (read.collection !== 'business_lines' || !read.id) return
    const line = fake.documents('business_lines').find(row => row._id === read.id)
    if (read.id === 'line-0000') fake.replace('business_lines', read.id, { ...line, managerUserIds: [], memberUserIds: [] })
    if (read.id === 'line-0001') fake.replace('business_lines', read.id, { ...line, status: 'completed' })
  } })
  const result = await h.business.listBusinessLines({ actor: ACTOR, query: { status: 'active', scope: 'mine', pageSize: 5 } })
  assert.equal(result.total, 6)
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.items.map(row => row._id), ['line-0002', 'line-0003', 'line-0004', 'line-0005', 'line-0006'])
  h.assertReadOnly()
})

test('list rechecks active account after relation queries instead of reusing its first authorization', async () => {
  let accountReads = 0
  const h = harness(seedLines(8), { beforeRead(read, fake) {
    if (read.collection === 'users' && ++accountReads === 2) fake.replace('users', ACTOR._id, { ...ACTOR, status: 'disabled' })
  } })
  await assert.rejects(h.business.listBusinessLines({ actor: ACTOR }), { code: 'FORBIDDEN' })
  assert.equal(h.reads.filter(read => read.collection === 'business_lines' && read.id).length, 0)
})

test('pending transactions recheck revocation, disabled account and current-node switches after discovery', async () => {
  for (const change of ['member', 'disabled', 'current-node']) {
    const h = harness(seedPending(8))
    h.fake.beforeNextTransaction(() => {
      if (change === 'disabled') h.fake.replace('users', ACTOR._id, { ...ACTOR, status: 'disabled' })
      else for (const line of h.fake.documents('business_lines')) h.fake.replace('business_lines', line._id,
        change === 'member' ? { ...line, memberUserIds: ['other'], managerUserIds: ['other'] }
          : { ...line, currentNodeId: 'other-node' })
    })
    const result = await h.business.listMyPendingProcessing({ actor: ACTOR })
    assert.deepEqual(result.items, [], change)
    assert.equal(result.total, 0, change)
    h.assertReadOnly()
  }
})

test('summary preserves the 2000-record bound and honest complete flag across full query pages', async () => {
  for (const count of [2000, 2001]) {
    const h = harness(seedLines(count))
    const result = await h.business.getMyBusinessSummary({ actor: ACTOR })
    assert.equal(result.stats.active, 2000)
    assert.equal(result.complete, count === 2000)
    const memberCalls = h.fake.queryCalls.filter(call => call.criteria && call.criteria.memberUserIds)
    assert.equal(memberCalls.length, 21)
    assert.equal(memberCalls[20].offset, 2000)
    assert.equal(memberCalls[20].limit, 1)
    h.assertReadOnly()
  }
})

test('failed list candidate batch stops queued candidates and waits for its active reads', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const failure = new Error('candidate read unavailable')
  const h = harness(seedLines(20), { beforeRead(read) {
    if (read.collection !== 'business_lines' || !read.id) return
    if (read.id === 'line-0000') throw failure
    return gate
  } })
  let settled = false
  const pending = h.business.listBusinessLines({ actor: ACTOR }).then(() => assert.fail('must fail'), error => {
    settled = true
    return error
  })
  for (let i = 0; i < 15; i += 1) await turn()
  assert.equal(settled, false)
  assert.equal(h.reads.filter(read => read.collection === 'business_lines' && read.id).length, 4)
  release()
  assert.equal(await pending, failure)
  assert.equal(h.metrics().active, 0)
  assert.equal(h.reads.filter(read => read.collection === 'business_lines' && read.id).length, 4)
})

test('failed history batch stops queued feedbacks and waits for its active attachment queries', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const failure = new Error('attachment query unavailable')
  const h = harness(seedHistory(20), { beforeRead(read) {
    if (read.collection !== 'evidences') return
    if (read.criteria.feedbackId === 'feedback-0019') throw failure
    return gate
  } })
  let settled = false
  const pending = h.feedback.getNodeHistory({ actor: ACTOR, businessLineId: 'line-0000', nodeId: 'node-0000' })
    .then(() => assert.fail('must fail'), error => { settled = true; return error })
  for (let i = 0; i < 15; i += 1) await turn()
  assert.equal(settled, false)
  assert.equal(h.reads.filter(read => read.collection === 'evidences').length, 4)
  release()
  assert.equal(await pending, failure)
  assert.equal(h.metrics().active, 0)
  assert.equal(h.reads.filter(read => read.collection === 'evidences').length, 4)
})

test('failed relation query waits for its other started groups and never reaches authoritative candidates', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const failure = new Error('relationship query unavailable')
  const h = harness(seedLines(8), { beforeRead(read) {
    if (read.collection !== 'business_lines' || read.id) return
    if (read.criteria.memberUserIds) throw failure
    return gate
  } })
  let settled = false
  const pending = h.business.listBusinessLines({ actor: ACTOR })
    .then(() => assert.fail('must fail'), error => { settled = true; return error })
  try {
    for (let i = 0; i < 15; i += 1) await turn()
    assert.equal(settled, false)
    assert.equal(h.reads.filter(read => read.collection === 'business_lines').length, 4)
  } finally { release() }
  assert.equal(await pending, failure)
  assert.equal(h.metrics().active, 0)
  assert.equal(h.reads.filter(read => read.id && read.collection === 'business_lines').length, 0)
})

for (const chain of ['relation', 'history', 'pending']) {
  test(`${chain} failure stops later pages of 250-row groups while draining their first pages`, async () => {
    const seed = chain === 'relation' ? seedLines(250) : chain === 'pending' ? seedPending(250) : seedHistory(8)
    if (chain === 'relation') {
      for (const line of seed.business_lines) {
        line.memberIds = [ACTOR.openid]
        line.managerIds = [ACTOR.openid]
      }
    } else if (chain === 'pending') {
      for (const node of seed.business_nodes) {
        node.manualDecisionProcessorUserIds = [ACTOR._id]
        node.assigneeIds = [ACTOR.openid]
      }
    } else {
      seed.evidences = seed.node_feedback.flatMap(feedback => Array.from({ length: 250 }, (_, index) => ({
        _id: `${feedback._id}-evidence-${String(index).padStart(4, '0')}`,
        businessLineId: 'line-0000', nodeId: 'node-0000', feedbackId: feedback._id,
        feedbackRevision: feedback.revision, attachmentState: 'attached',
        retentionScope: 'business_line', retentionSource: 'node_feedback',
        storageStatus: 'available', size: 10, fileName: 'Synthetic.pdf'
      })))
    }
    const gates = Array.from({ length: chain === 'pending' ? 3 : 4 }, deferred)
    const firstPagesStarted = deferred()
    let firstPages = 0
    const selected = read => chain === 'relation'
      ? read.collection === 'business_lines' && !read.id
      : chain === 'pending' ? read.collection === 'business_nodes' && !read.id : read.collection === 'evidences'
    const h = harness(seed, { beforeRead(read) {
      if (!selected(read) || read.offset !== 0) return
      const gate = gates[firstPages++]
      if (firstPages === gates.length) firstPagesStarted.resolve()
      return gate && gate.promise
    } })
    const failure = new Error(`${chain} first-page failure`)
    let settled = false
    const request = chain === 'relation'
      ? h.business.listBusinessLines({ actor: ACTOR })
      : chain === 'pending' ? h.business.listMyPendingProcessing({ actor: ACTOR })
        : h.feedback.getNodeHistory({ actor: ACTOR, businessLineId: 'line-0000', nodeId: 'node-0000' })
    const pending = request.then(() => assert.fail('must fail'), error => { settled = true; return error })
    try {
      await firstPagesStarted.promise
      gates[0].reject(failure)
      await turn()
      assert.equal(settled, false)
      assert.equal(h.metrics().active, gates.length - 1)
      gates[1].resolve()
      if (gates.length === 4) gates[2].reject(new Error('later failure must not replace the first'))
      await turn()
      assert.equal(settled, false, 'last first-page I/O is still in flight')
      gates[gates.length - 1].resolve()
      assert.equal(await pending, failure)
      assert.equal(h.metrics().active, 0)
      assert.deepEqual(h.reads.filter(selected).map(read => read.offset), chain === 'pending' ? [0, 0, 0] : [0, 0, 0, 0],
        'no offset 100/200 after another group has failed')
      if (chain === 'relation') {
        assert.equal(h.reads.filter(read => read.id && read.collection === 'business_lines').length, 0)
      }
      if (chain === 'pending') assert.equal(h.fake.transactionRuns.length, 0)
      h.assertReadOnly()
    } finally {
      gates.forEach(gate => gate.resolve())
      await pending
    }
  })
}

test('history failure stops legacy attachment document reads after in-flight empty relation pages', async () => {
  const seed = seedHistory(8)
  for (const feedback of seed.node_feedback) {
    delete feedback.publishState
    feedback.evidenceIds = [`legacy-${feedback._id}`]
  }
  const gates = Array.from({ length: 4 }, deferred)
  const started = deferred()
  let count = 0
  const h = harness(seed, { beforeRead(read) {
    if (read.collection !== 'evidences' || read.id) return
    const gate = gates[count++]
    if (count === 4) started.resolve()
    return gate && gate.promise
  } })
  const failure = new Error('first legacy relation page failed')
  const pending = h.feedback.getNodeHistory({ actor: ACTOR, businessLineId: 'line-0000', nodeId: 'node-0000' })
    .then(() => assert.fail('must reject'), error => error)
  try {
    await started.promise
    gates[0].reject(failure)
    await turn()
    gates.slice(1).forEach(gate => gate.resolve())
    assert.equal(await pending, failure)
    assert.equal(h.reads.filter(read => read.collection === 'evidences' && read.id).length, 0)
    assert.equal(h.metrics().active, 0)
    h.assertReadOnly()
  } finally {
    gates.forEach(gate => gate.resolve())
    await pending
  }
})

test('failed pending transaction drains other transactions and never starts queued candidates', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const failure = new Error('transactional read unavailable')
  const h = harness(seedPending(20), { beforeRead(read) {
    if (!read.transaction || read.collection !== 'business_lines') return
    if (read.id === 'line-0000') throw failure
    return gate
  } })
  let settled = false
  const pending = h.business.listMyPendingProcessing({ actor: ACTOR })
    .then(() => assert.fail('must fail'), error => { settled = true; return error })
  try {
    for (let i = 0; i < 15; i += 1) await turn()
    assert.equal(settled, false)
    assert.equal(h.fake.transactionRuns.length, 4)
    assert.equal(h.fake.metrics.activeCallbacks, 3)
  } finally { release() }
  assert.equal(await pending, failure)
  assert.equal(h.fake.transactionRuns.length, 4)
  assert.equal(h.fake.metrics.activeCallbacks, 0)
  assert.equal(h.metrics().active, 0)
  h.assertReadOnly()
})

test('pending cursor and list tie order are independent of read completion order', async () => {
  const h = harness(seedPending(8), { async beforeRead(read) {
    if (read.collection === 'business_lines' && read.id === 'line-0000') {
      for (let i = 0; i < 5; i += 1) await turn()
    }
  } })
  const first = await h.business.listMyPendingProcessing({ actor: ACTOR, query: { pageSize: 3 } })
  const second = await h.business.listMyPendingProcessing({ actor: ACTOR, query: { pageSize: 3, cursor: first.cursor } })
  assert.deepEqual(first.items.map(row => row.nodeId), ['node-0000', 'node-0001', 'node-0002'])
  assert.deepEqual(second.items.map(row => row.nodeId), ['node-0003', 'node-0004', 'node-0005'])
  assert.equal(first.total, 8)
  assert.equal(second.total, 8)
  assert.equal(second.hasMore, true)
  const list = await h.business.listBusinessLines({ actor: ACTOR, query: { pageSize: 5 } })
  assert.deepEqual(list.items.map(row => row._id), ['line-0000', 'line-0001', 'line-0002', 'line-0003', 'line-0004'])
  assert.equal(h.metrics().peak, 4)
  h.assertReadOnly()
})

test('history retains full attachment pagination and exact revision retention under out-of-order reads', async () => {
  const seed = seedHistory(5)
  seed.evidences = Array.from({ length: 101 }, (_, index) => ({
    _id: `evidence-${String(index).padStart(4, '0')}`, businessLineId: 'line-0000', nodeId: 'node-0000',
    feedbackId: 'feedback-0004', feedbackRevision: 5, attachmentState: 'attached',
    retentionScope: 'business_line', retentionSource: 'node_feedback',
    storageStatus: 'available', size: 10, fileName: 'Synthetic.pdf'
  }))
  seed.evidences.push({ ...seed.evidences[0], _id: 'wrong-revision', feedbackRevision: 4 })
  const h = harness(seed, { async beforeRead(read) {
    if (read.collection === 'evidences' && read.criteria.feedbackId === 'feedback-0004') await turn()
  } })
  const result = await h.feedback.getNodeHistory({ actor: ACTOR, businessLineId: 'line-0000', nodeId: 'node-0000' })
  assert.deepEqual(result.history.map(row => row.revision), [5, 4, 3, 2, 1])
  assert.equal(result.history[0].evidences.length, 101)
  assert.equal(result.history[0].evidences[0].evidenceId, 'evidence-0000')
  assert.equal(result.history[0].evidences[100].evidenceId, 'evidence-0100')
  assert.deepEqual(h.fake.queryCalls.filter(call => call.collection === 'evidences' &&
    call.criteria.feedbackId === 'feedback-0004').map(call => call.offset), [0, 100])
  assert.equal(h.metrics().peak, 4)
  h.assertReadOnly()
})

test('pending raw scan stops at 2000 authorizations with honest incompleteness even when every candidate is invalid', async () => {
  const seed = seedLines(0)
  seed.business_nodes = Array.from({ length: 2001 }, (_, index) => ({
    _id: `raw-${index}`, businessLineId: 'missing-line', status: 'ready',
    processorUserIds: [ACTOR._id], manualDecisionProcessorUserIds: [ACTOR._id], updatedAt: NOW
  }))
  const h = harness(seed)
  const result = await h.business.listMyPendingProcessing({ actor: ACTOR })
  assert.deepEqual(result.items, [])
  assert.equal(result.total, 0)
  assert.equal(result.complete, false)
  assert.equal(result.hasMore, false)
  assert.equal(h.fake.transactionRuns.length, 2000)
  assert.equal(h.metrics().transactionPeak, 4)
  const calls = h.fake.queryCalls.filter(call => call.criteria.processorUserIds)
  assert.equal(calls.length, 21)
  assert.equal(calls[20].offset, 2000)
  assert.equal(calls[20].limit, 1)
  h.assertReadOnly()
})

test('independent requests never reuse another account or a previously authorized account state', async () => {
  const seed = seedLines(8)
  const other = { _id: 'other-user', status: 'active', role: 'user' }
  seed.users.push(other)
  const h = harness(seed)
  const [mine, theirs] = await Promise.all([
    h.business.listBusinessLines({ actor: ACTOR }), h.business.listBusinessLines({ actor: other })
  ])
  assert.equal(mine.total, 8)
  assert.deepEqual(theirs.items, [])
  h.fake.replace('users', ACTOR._id, { ...ACTOR, status: 'disabled' })
  await assert.rejects(h.business.listBusinessLines({ actor: ACTOR }), { code: 'FORBIDDEN' })
  h.assertReadOnly()
})

test('detail keeps its final fixed-node transaction serial and still rejects a late node-version change', async t => {
  const seed = seedPending(1)
  seed.business_nodes = Array.from({ length: 20 }, (_, index) => ({
    ...seed.business_nodes[0], _id: `node-${String(index).padStart(4, '0')}`, sequence: index,
    status: index === 0 ? 'in_progress' : 'waiting'
  }))
  const h = harness(seed)
  const result = await h.business.getBusinessLine({ actor: ACTOR, lineId: 'line-0000' })
  assert.equal(result.nodes.length, 20)
  assert.equal(h.metrics().reads, 25)
  assert.equal(h.metrics().rounds, 25)
  assert.equal(h.metrics().peak, 1)
  assert.equal(h.fake.transactionRuns[0].operations, 22)
  t.diagnostic(JSON.stringify(h.metrics()))
  h.fake.beforeNextTransaction(() => {
    const node = h.fake.documents('business_nodes')[19]
    h.fake.replace('business_nodes', node._id, { ...node, version: 2 })
  })
  await assert.rejects(h.business.getBusinessLine({ actor: ACTOR, lineId: 'line-0000' }), { code: 'VERSION_CONFLICT' })
  h.assertReadOnly()
})
