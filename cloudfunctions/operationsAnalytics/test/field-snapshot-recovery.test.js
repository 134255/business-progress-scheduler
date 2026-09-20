'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { fieldSource } = require('../../businessApi/test/helpers/field-fixtures')
const domain = require('../../businessApi/lib/operations-field-domain')
let createFieldSnapshotRecovery
try { ({ createFieldSnapshotRecovery } = require('../lib/field-snapshot-recovery')) }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

const CURSOR = 'operations-field-snapshot-cursor'
const NOW = new Date('2026-09-11T03:00:00.000Z')
const OPTIONS = { batchSize: 40, timeBudgetMs: 5000 }
function sources(count, reviewed = false) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(3, '0')
    return fieldSource({ nodeId: `node-${suffix}`, reviewed,
      line: { _id: `line-${suffix}`, code: `CODE-${suffix}`, managerUserIds: ['root'] },
      node: { nodeCode: `CODE-${suffix}-01`, analyticsSnapshotStatus: 'generated' } })
  })
}
function harness(input = sources(1), options = {}, dependencies = {}) {
  assert.equal(typeof createFieldSnapshotRecovery, 'function', 'bounded recovery must be implemented')
  const fake = createFakeCloudDatabase({
    users: [{ _id: 'root', role: 'super_admin', status: 'active' }],
    business_lines: input.map(source => source.line), business_nodes: input.map(source => source.node),
    node_feedback: input.map(source => source.feedback),
    node_review_rounds: input.map(source => source.round).filter(Boolean),
    node_review_votes: input.flatMap(source => source.votes), operations_field_snapshots: [],
    system_settings: [{ _id: 'operations-analytics-node-cursor', cursorId: 'timing-owned', version: 7 }]
  }, { rejectExplicitIdOnSet: true, ...options })
  const recovery = createFieldSnapshotRecovery({ db: fake.db, clock: () => NOW, ...domain, ...dependencies })
  return { fake, recovery }
}
function snapshots(fake) { return fake.documents('operations_field_snapshots') }
function snapshotWrites(fake) { return fake.writeCalls.filter(write => write.collection === 'operations_field_snapshots') }

test('41 nodes advance under a raw forty-row cap, wrap and do not republish identical snapshots', async () => {
  const { fake, recovery } = harness(sources(41))
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 40, generated: 40, failed: 0, hasMore: true })
  assert.equal(snapshots(fake).some(row => row.nodeId === 'node-041'), false)
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 1, generated: 1, failed: 0, hasMore: false })
  assert.equal(snapshots(fake).filter(row => row.nodeId === 'node-041').length, 1)
  assert.equal(fake.documents('system_settings').find(row => row._id === CURSOR).cursorId, null)
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 0)
  assert.equal(snapshotWrites(fake).length, 41)
  const scans = fake.queryCalls.filter(call => call.collection === 'business_nodes')
  assert.ok(scans.every(call => call.limit === 40 && call.offset === 0))
  assert.deepEqual(scans[1].criteria, { _id: { __operator: 'gt', value: 'node-040' } })
  assert.deepEqual(fake.transactionQueries, [])
})

test('forty corrupt sources cannot starve the forty-first valid node and errors never enter state', async () => {
  const input = sources(41)
  input.slice(0, 40).forEach(source => { source.feedback.revision = -1 })
  const { fake, recovery } = harness(input)
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 40, generated: 0, failed: 40, hasMore: true })
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 1)
  assert.equal(snapshots(fake)[0].nodeId, 'node-041')
  for (const row of fake.documents('system_settings').filter(row => row._id === CURSOR)) {
    assert.deepEqual(Object.keys(row).sort(), ['_id', 'cursorId', 'updatedAt', 'version'])
  }
  assert.equal(fake.writeCalls.some(write => !['system_settings', 'operations_field_snapshots'].includes(write.collection)), false)
  assert.deepEqual(fake.documents('system_settings').find(row => row._id === 'operations-analytics-node-cursor'),
    { _id: 'operations-analytics-node-cursor', cursorId: 'timing-owned', version: 7 })
})

test('dormant, skipped, unfinished and deleted sources advance but never publish; awaiting manual decision counts', async () => {
  const input = sources(5)
  input[0].node.routeState = 'dormant'
  input[1].node.routeState = 'skipped'
  input[2].node.status = 'in_progress'; input[2].node.routeState = 'active'
  input[3].line.status = 'deleted'
  input[4].node.status = 'awaiting_decision'; input[4].node.routeState = 'awaiting_manual_decision'
  const { fake, recovery } = harness(input)
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 5, generated: 1, failed: 0, hasMore: false })
  assert.equal(snapshots(fake)[0].nodeId, 'node-005')
})

test('worker set payload is the exact approved selection projection, keyed by node id and with no explicit _id', async () => {
  const input = sources(1, true)
  const { fake, recovery } = harness(input)
  const before = structuredClone(input)
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 1)
  const write = snapshotWrites(fake)[0]
  assert.equal(write.id, 'node-001')
  assert.equal(Object.hasOwn(write.data, '_id'), false)
  assert.deepEqual(write.data, domain.selectionSnapshot(domain.buildFinalFieldResult(input[0])))
  assert.deepEqual(write.data.fields.map(field => [field.fieldKey, field.value]), [['choice', 'A'], ['tags', ['X', 'Y']]])
  assert.doesNotMatch(JSON.stringify(write.data), /完整说明|合成处理说明|submittedBy|reviewerUserId|evidenceIds/)
  assert.deepEqual(input, before)
  assert.deepEqual(fake.transactionQueries, [])
})

test('old worker cannot overwrite a newer source published before its fixed-document recheck', async () => {
  const input = sources(1)
  let fake, armed = true
  const built = harness(input, {}, { buildFinalFieldResult(source) {
    const result = domain.buildFinalFieldResult(source)
    if (armed && result) {
      armed = false
      fake.beforeNextTransaction(() => {
        const newer = structuredClone(input[0])
        newer.feedback.fieldValues[0].value = 'B'
        newer.feedback.revision++; newer.node.latestFeedbackRevision++
        fake.replace('node_feedback', newer.feedback._id, newer.feedback)
        fake.replace('business_nodes', newer.node._id, newer.node)
        fake.replace('operations_field_snapshots', newer.node._id,
          domain.selectionSnapshot(domain.buildFinalFieldResult(newer)))
      })
    }
    return result
  } })
  fake = built.fake
  assert.equal((await built.recovery.runCycle(OPTIONS)).failed, 1)
  assert.equal(snapshots(fake)[0].fields[0].value, 'B')
  assert.equal(snapshotWrites(fake).length, 0)
})

for (const [name, mutate] of [
  ['feedback revision', (fake, source) => fake.replace('node_feedback', source.feedback._id, { ...source.feedback, revision: 99 })],
  ['round final decision', (fake, source) => fake.replace('node_review_rounds', source.round._id, { ...source.round, finalDecision: 'rejected' })],
  ['vote decision', (fake, source) => fake.replace('node_review_votes', source.votes[0]._id, { ...source.votes[0], decision: 'rejected' })],
  ['node final pointer', (fake, source) => fake.replace('business_nodes', source.node._id, { ...source.node, lastReviewRoundId: 'other-round' })],
  ['line eligibility', (fake, source) => fake.replace('business_lines', source.line._id, { ...source.line, status: 'deleted' })]
]) {
  test(`publication atomically rechecks ${name}`, async () => {
    const input = sources(1, true)
    let fake, armed = true
    const built = harness(input, {}, { buildFinalFieldResult(source) {
      const result = domain.buildFinalFieldResult(source)
      if (armed && result) { armed = false; fake.beforeNextTransaction(() => mutate(fake, input[0])) }
      return result
    } })
    fake = built.fake
    assert.equal((await built.recovery.runCycle(OPTIONS)).failed, 1)
    assert.equal(snapshots(fake).length, 0)
    assert.deepEqual(fake.transactionQueries, [])
  })
}

test('calendar-only changes between pre-read and publication preserve source identity', async () => {
  const input = sources(1, true)
  let fake, armed = true
  const built = harness(input, {}, { buildFinalFieldResult(source) {
    const result = domain.buildFinalFieldResult(source)
    if (armed && result) {
      armed = false
      fake.beforeNextTransaction(() => {
        fake.replace('business_nodes', source.node._id, { ...source.node, version: 88, processingElapsedWorkMinutes: 99 })
        fake.replace('node_review_rounds', source.round._id, { ...source.round, version: 99, processingRoundWorkMinutes: 99 })
      })
    }
    return result
  } })
  fake = built.fake
  assert.equal((await built.recovery.runCycle(OPTIONS)).generated, 1)
  assert.equal(snapshots(fake)[0].sourceDigest, domain.buildFinalFieldResult(input[0]).sourceDigest)
})

test('failed snapshot write is atomic, advances fairly and retries on the next wrap', async () => {
  const { fake, recovery } = harness(sources(2))
  fake.failNextWrite({ collection: 'operations_field_snapshots', operation: 'set', error: new Error('private upstream failure') })
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 2, generated: 1, failed: 1, hasMore: false })
  assert.equal(snapshots(fake)[0].nodeId, 'node-002')
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 1)
  assert.equal(snapshots(fake).length, 2)
  assert.doesNotMatch(JSON.stringify(fake.documents('system_settings')), /private|failure/)
})

test('cursor CAS cannot rewind a competing worker or publish candidates it did not claim', async () => {
  const { fake, recovery } = harness(sources(41))
  fake.beforeNextTransaction(() => fake.replace('system_settings', CURSOR,
    { cursorId: 'node-040', version: 7, updatedAt: NOW }))
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.generated, 0)
  assert.equal(result.hasMore, true)
  assert.equal(fake.documents('system_settings').find(row => row._id === CURSOR).version, 7)
  assert.equal(snapshots(fake).length, 0)
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 1)
  assert.equal(snapshots(fake)[0].nodeId, 'node-041')
})

test('partial time budget progress is checkpointed so later nodes are not starved', async () => {
  let milliseconds = NOW.getTime()
  const { fake, recovery } = harness(sources(3), {
    afterTransaction({ result }) { if (result === true) milliseconds += 3000 }
  }, { clock: () => new Date(milliseconds) })
  const first = await recovery.runCycle(OPTIONS)
  assert.ok(first.generated > 0 && first.generated < 3)
  assert.equal(first.hasMore, true)
  for (let cycle = 0; cycle < 3; cycle++) await recovery.runCycle(OPTIONS)
  assert.equal(snapshots(fake).some(row => row.nodeId === 'node-003'), true)
})

test('expiry before fixed recheck cannot publish a late snapshot', async () => {
  let milliseconds = NOW.getTime()
  const { fake, recovery } = harness(sources(1), {}, {
    clock: () => new Date(milliseconds), buildFinalFieldResult(source) {
      const result = domain.buildFinalFieldResult(source)
      milliseconds += 5000
      return result
    }
  })
  const result = await recovery.runCycle(OPTIONS)
  assert.equal(result.generated, 0)
  assert.equal(result.hasMore, true)
  assert.equal(snapshots(fake).length, 0)
})

test('zero budget makes no database calls and unsafe batch or time budgets are rejected', async () => {
  const { fake, recovery } = harness()
  assert.deepEqual(await recovery.runCycle({ batchSize: 40, timeBudgetMs: 0 }),
    { examined: 0, generated: 0, failed: 0, hasMore: true })
  assert.equal(fake.queryCalls.length, 0)
  assert.equal(fake.transactionRuns.length, 0)
  for (const settings of [{ batchSize: 41, timeBudgetMs: 5000 }, { batchSize: 40, timeBudgetMs: 5001 }]) {
    await assert.rejects(recovery.runCycle(settings), TypeError)
  }
})

test('missing collections and corrupt cursors return safe counts instead of exposing errors or overwriting state', async () => {
  const { fake } = harness()
  const unavailableDb = { ...fake.db, collection(name) {
    if (name === 'business_nodes') throw new Error('collection.get:fail collection does not exist; sensitive')
    return fake.db.collection(name)
  } }
  const recovery = createFieldSnapshotRecovery({ db: unavailableDb, clock: () => NOW, ...domain })
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 0, generated: 0, failed: 1, hasMore: true })
  fake.replace('system_settings', CURSOR, { cursorId: null, version: 'corrupt' })
  const invalid = createFieldSnapshotRecovery({ db: fake.db, clock: () => NOW, ...domain })
  assert.equal((await invalid.runCycle(OPTIONS)).failed, 1)
  assert.equal(fake.documents('system_settings').find(row => row._id === CURSOR).version, 'corrupt')
})

test('produced worker snapshot is accepted by main summary cache without feedback or review content reads', async () => {
  let forbidContent = false
  const { fake, recovery } = harness(sources(1, true), { transformRead({ collection, data }) {
    if (forbidContent && ['node_feedback', 'node_review_rounds', 'node_review_votes'].includes(collection)) {
      throw new Error('unexpected immutable content read')
    }
    return data
  } })
  await recovery.runCycle(OPTIONS)
  forbidContent = true
  const { createCloudOperationsFieldRepository } = require('../../businessApi/lib/cloud-operations-field-repository')
  const { normalizeFieldQuery } = require('../../businessApi/lib/operations-field-service')
  const repository = createCloudOperationsFieldRepository({ db: fake.db, clock: () => NOW,
    operationsRepository: { async exportRows() { throw new Error('summary must not export') } } })
  const result = await repository.getSummary({ actor: { _id: 'root' },
    range: normalizeFieldQuery({ startDate: '2026-09-01', endDate: '2026-09-11' }, NOW) })
  assert.equal(result.incomplete, false)
  assert.equal(result.sampledNodeCount, 1)
  assert.deepEqual(result.groups[0].options, [{ label: 'A', count: 1 }, { label: 'B', count: 0 }])
})

test('same-source cache with nonselection content is replaced, not accepted as idempotent', async () => {
  const input = sources(1)
  const { fake, recovery } = harness(input)
  fake.replace('operations_field_snapshots', input[0].node._id, domain.buildFinalFieldResult(input[0]))
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 1)
  assert.deepEqual(snapshots(fake)[0].fields.map(field => field.fieldKey), ['choice', 'tags'])
  assert.doesNotMatch(JSON.stringify(snapshots(fake)), /完整说明/)
})

test('cursor write failure publishes nothing and leaves the same candidate recoverable', async () => {
  const { fake, recovery } = harness()
  fake.failNextWrite({ collection: 'system_settings', operation: 'set', error: new Error('private cursor write error') })
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 1, generated: 0, failed: 1, hasMore: true })
  assert.equal(fake.documents('system_settings').some(row => row._id === CURSOR), false)
  assert.equal(snapshots(fake).length, 0)
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 1)
})

test('exactly full terminal page resets on an empty next scan and remains idempotent', async () => {
  const { fake, recovery } = harness(sources(40))
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 40)
  assert.deepEqual(await recovery.runCycle(OPTIONS), { examined: 0, generated: 0, failed: 0, hasMore: false })
  assert.equal(fake.documents('system_settings').find(row => row._id === CURSOR).cursorId, null)
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 0)
  assert.equal(snapshotWrites(fake).length, 40)
})

test('fifty ALL votes fit the fixed-document transaction budget; an extra raw vote fails closed', async () => {
  const input = sources(1, true), source = input[0]
  const reviewers = Array.from({ length: 50 }, (_, index) => `reviewer-${index + 1}`)
  source.node.reviewMode = 'all'; source.node.reviewerUserIds = reviewers
  source.round.reviewMode = 'all'; source.round.reviewerUserIds = reviewers
  source.round.voteCount = 50; source.round.approvedVoteCount = 50
  source.votes = reviewers.map((reviewerUserId, index) => ({ ...source.votes[0], _id: `vote-${index}`, reviewerUserId }))
  const { fake, recovery } = harness(input)
  assert.equal((await recovery.runCycle(OPTIONS)).generated, 1)
  assert.equal(snapshots(fake)[0].reviewerTokens.length, 50)
  assert.ok(fake.transactionRuns.every(run => run.operations <= 56))
  assert.deepEqual(fake.transactionQueries, [])
  const extra = { ...source.votes[0], _id: 'vote-extra', reviewerUserId: 'reviewer-extra' }
  const blocked = harness([{ ...source, votes: [...source.votes, extra] }])
  assert.equal((await blocked.recovery.runCycle(OPTIONS)).failed, 1)
  assert.equal(snapshots(blocked.fake).length, 0)
  assert.equal(blocked.fake.queryCalls.find(call => call.collection === 'node_review_votes').limit, 51)
})

test('vote enumeration must agree with finalized round counters at publication', async () => {
  const input = sources(1, true)
  let fake, armed = true
  const built = harness(input, {}, { buildFinalFieldResult(source) {
    const result = domain.buildFinalFieldResult(source)
    if (armed && result) {
      armed = false
      fake.beforeNextTransaction(() => fake.replace('node_review_rounds', source.round._id,
        { ...source.round, voteCount: 2, approvedVoteCount: 2 }))
    }
    return result
  } })
  fake = built.fake
  assert.equal((await built.recovery.runCycle(OPTIONS)).failed, 1)
  assert.equal(snapshots(fake).length, 0)
})
