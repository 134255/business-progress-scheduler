const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createFeedbackHarness, createOptimisticFeedbackHarness, seed, submission, NOW
} = require('./helpers/feedback-harness')

const STATE_COLLECTIONS = [
  'users', 'business_lines', 'business_nodes', 'node_feedback', 'evidences', 'audit_logs'
]

function stateSnapshot(fake) {
  return Object.fromEntries(STATE_COLLECTIONS.map(name => [name, fake.documents(name)]))
}

test('completion claims more than one transaction of tiny evidence without a count cap', async () => {
  const evidenceIds = Array.from({ length: 105 }, (_, index) => `evidence-${105 - index}`)
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 105 })
  const result = await repository.commitFeedback(submission({ evidenceIds, evidenceTotalBytes: 105 }))

  assert.deepEqual(result, { feedbackId: result.feedbackId, revision: 1, nodeStatus: 'completed', lineStatus: 'active' })
  const [feedback] = fake.documents('node_feedback')
  assert.equal(feedback.publishState, 'published')
  assert.equal(feedback.evidenceCount, 105)
  assert.equal(feedback.evidenceTotalBytes, 105)
  assert.equal(Object.hasOwn(feedback, 'evidenceIds'), false)
  assert.equal(fake.documents('evidences').every(item => item.feedbackId === feedback._id && item.attachmentState === 'attached'), true)
  assert.deepEqual(evidenceIds.map(evidenceId => {
    const evidence = fake.documents('evidences').find(item => item._id === evidenceId)
    return evidence.feedbackEvidenceOrder
  }), Array.from({ length: 105 }, (_, index) => index))
  assert.equal(fake.documents('evidences').every(item => item.orphanExpiresAt === null), true)
  assert.deepEqual(fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence).map(item => item.status), ['completed', 'ready'])
  assert.equal(fake.documents('business_lines')[0].currentNodeId, 'line-1-node-002')
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.transactionQueries.length, 0)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})

test('last-node completion freezes the line and records one authoritative 60-day line deadline', async () => {
  const singleNode = seed({ evidenceCount: 2 })
  singleNode.business_lines[0].nodeCount = 1
  singleNode.business_nodes = [singleNode.business_nodes[0]]
  const { fake, repository } = createFeedbackHarness({ seed: singleNode })
  const result = await repository.commitFeedback(submission({ evidenceIds: ['evidence-1', 'evidence-2'] }))

  assert.equal(result.lineStatus, 'completed')
  const line = fake.documents('business_lines')[0]
  assert.deepEqual(line.completedAt, NOW)
  assert.deepEqual(line.frozenAt, NOW)
  assert.deepEqual(line.retentionStartedAt, NOW)
  const due = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000)
  assert.deepEqual(line.purgeDueAt, due)
  for (const evidence of fake.documents('evidences')) {
    assert.equal(evidence.retentionStartedAt, null)
    assert.equal(evidence.purgeDueAt, null)
  }
})

test('被驳回节点重新提交后恢复下一节点但不刷新其原激活时间和到期时间', async () => {
  const data = seed({ evidenceCount: 0 })
  const originalActivatedAt = new Date('2026-08-06T03:00:00.000Z')
  const originalDueAt = new Date('2026-08-07T11:00:00.000Z')
  Object.assign(data.business_lines[0], {
    currentNodeId: 'node-1', currentNodeIndex: 0, currentNodeName: '执行', version: 9
  })
  Object.assign(data.business_nodes[0], {
    status: 'in_progress', version: 6, rejectionCount: 1,
    lastRejectedAt: new Date('2026-08-07T02:30:00.000Z'),
    latestFeedbackId: 'old-feedback', latestFeedbackRevision: 1,
    completedAt: new Date('2026-08-06T02:00:00.000Z')
  })
  Object.assign(data.business_nodes[1], {
    status: 'waiting', version: 4, activatedAt: originalActivatedAt, dueAt: originalDueAt
  })
  const { fake, repository } = createFeedbackHarness({ seed: data })

  await repository.commitFeedback(submission({
    input: { expectedNodeVersion: 6, requestKey: 'rework-submit-001' }
  }))

  const next = fake.documents('business_nodes').find(item => item._id === 'line-1-node-002')
  assert.equal(next.status, 'ready')
  assert.equal(next.version, 5)
  assert.deepEqual(next.activatedAt, originalActivatedAt)
  assert.deepEqual(next.dueAt, originalDueAt)
  assert.equal(fake.documents('business_lines')[0].currentNodeId, 'line-1-node-002')
})

test('in-progress and blocked submissions append revisions without advancing the flow', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 0 })
  const first = await repository.commitFeedback(submission({ input: { status: 'in_progress', requestKey: 'progress-1' } }))
  const second = await repository.commitFeedback(submission({ input: { status: 'blocked', expectedNodeVersion: 5, requestKey: 'blocked-1' } }))

  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  assert.deepEqual(fake.documents('node_feedback').map(item => item.revision).sort(), [1, 2])
  assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-1').status, 'blocked')
  assert.equal(fake.documents('business_lines')[0].status, 'active')
  assert.equal(fake.documents('audit_logs').length, 2)
})

test('only an active account-ID assignee may submit and mixed schemas never fall back to OpenID', async () => {
  const cases = [
    { actor: { _id: 'manager', status: 'active' }, code: 'FORBIDDEN' },
    { actor: { _id: 'account-a', status: 'disabled' }, code: 'FORBIDDEN' },
    { actor: { _id: 'account-a', status: 'active', openid: 'wx-a' }, node: { assigneeUserIds: null, assigneeIds: ['wx-a'] }, code: 'FORBIDDEN' }
  ]
  for (const item of cases) {
    const seeded = seed({ evidenceCount: 0 })
    if (item.node) Object.assign(seeded.business_nodes[0], item.node)
    if (item.actor.status === 'disabled') seeded.users.find(user => user._id === item.actor._id).status = 'disabled'
    const { repository } = createFeedbackHarness({ seed: seeded })
    await assert.rejects(repository.commitFeedback(submission({ actor: item.actor })), error => error.code === item.code)
  }
})

test('frozen, wrong-line, noncurrent, and stale nodes fail closed', async () => {
  const changes = [
    { mutate: data => { data.business_lines[0].status = 'completed' }, code: 'BUSINESS_FROZEN' },
    { mutate: data => { data.business_nodes[0].businessLineId = 'other' }, code: 'NOT_FOUND' },
    { mutate: data => { data.business_lines[0].currentNodeId = 'line-1-node-002' }, code: 'NODE_NOT_ACTIVE' },
    { mutate: data => { data.business_nodes[0].version = 5 }, code: 'VERSION_CONFLICT' }
  ]
  for (const item of changes) {
    const data = seed({ evidenceCount: 0 })
    item.mutate(data)
    const { repository } = createFeedbackHarness({ seed: data })
    await assert.rejects(repository.commitFeedback(submission()), error => error.code === item.code)
  }
})

test('evidence must be available, unexpired, unattached, same-node, and owned by the submitting actor', async () => {
  const cases = [
    { storageStatus: 'purged' },
    { orphanExpiresAt: NOW },
    { feedbackId: 'other-feedback' },
    { businessLineId: 'other-line' },
    { nodeId: 'line-1-node-002' },
    { uploadedBy: 'account-b' }
  ]
  for (const change of cases) {
    const data = seed({ evidenceCount: 1 })
    Object.assign(data.evidences[0], change)
    const { fake, repository } = createFeedbackHarness({ seed: data })
    await assert.rejects(
      repository.commitFeedback(submission({ evidenceIds: ['evidence-1'] })),
      error => error.code === 'EVIDENCE_NOT_ATTACHABLE'
    )
    assert.equal(fake.documents('node_feedback').every(item => item.publishState !== 'published'), true)
    assert.equal(fake.documents('business_nodes')[0].status, 'ready')
  }
})

test('a partially claimed deterministic reservation resumes and publishes once', async () => {
  const ids = Array.from({ length: 45 }, (_, index) => `evidence-${index + 1}`)
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 45 })
  const value = submission({ evidenceIds: ids, evidenceTotalBytes: 45 })
  const reservation = await repository.beginFeedback(value)
  await repository.claimEvidenceChunk(value, reservation)
  assert.equal(fake.documents('node_feedback')[0].publishState, 'reserved')
  assert.equal(fake.documents('evidences').filter(item => item.feedbackId === reservation.feedbackId).length, 40)

  const result = await repository.commitFeedback(value)
  assert.equal(result.revision, 1)
  assert.equal(fake.documents('node_feedback').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('evidences').every(item => item.attachmentState === 'attached'), true)
})

test('claim failure eagerly aborts the hidden reservation and releases the node lock', async () => {
  const data = seed({ evidenceCount: 1 })
  data.evidences[0].uploadedBy = 'account-b'
  const { fake, repository } = createFeedbackHarness({ seed: data })
  const originalOrphanExpiry = data.evidences[0].orphanExpiresAt
  await assert.rejects(repository.commitFeedback(submission({ evidenceIds: ['evidence-1'] })), error => error.code === 'EVIDENCE_NOT_ATTACHABLE')
  assert.equal(fake.documents('node_feedback')[0].publishState, 'aborted')
  assert.equal(Object.hasOwn(fake.documents('business_nodes')[0], 'feedbackClaimId'), false)
  assert.equal(fake.documents('evidences')[0].feedbackId, null)
  assert.deepEqual(fake.documents('evidences')[0].orphanExpiresAt, originalOrphanExpiry)
})

test('expired hidden reservations can be recovered without racing orphan cleanup', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 2 })
  const value = submission({ evidenceIds: ['evidence-1', 'evidence-2'] })
  const reservation = await repository.beginFeedback(value)
  await repository.claimEvidenceChunk(value, reservation)
  fake.replace('node_feedback', reservation.feedbackId, {
    ...fake.documents('node_feedback')[0], claimExpiresAt: new Date(NOW.getTime() - 1)
  })
  await repository.recoverExpiredReservation(reservation.feedbackId)

  assert.equal(fake.documents('node_feedback')[0].publishState, 'aborted')
  assert.equal(fake.documents('evidences').every(item => item.feedbackId === null && item.orphanExpiresAt), true)
  assert.equal(Object.hasOwn(fake.documents('business_nodes')[0], 'feedbackClaimId'), false)
})

test('maintenance recovery is fail-closed for live leases, handles malformed leases, and continues idempotently', async () => {
  const liveHarness = createFeedbackHarness({ evidenceCount: 1 })
  const liveValue = submission({ evidenceIds: ['evidence-1'] })
  const liveReservation = await liveHarness.repository.beginFeedback(liveValue)
  await liveHarness.repository.claimEvidenceChunk(liveValue, liveReservation)
  const liveBefore = stateSnapshot(liveHarness.fake)
  assert.equal(await liveHarness.repository.recoverExpiredReservation(liveReservation.feedbackId), false)
  assert.deepEqual(stateSnapshot(liveHarness.fake), liveBefore)

  const malformedHarness = createFeedbackHarness({ evidenceCount: 1 })
  const malformedValue = submission({ evidenceIds: ['evidence-1'] })
  const malformedReservation = await malformedHarness.repository.beginFeedback(malformedValue)
  await malformedHarness.repository.claimEvidenceChunk(malformedValue, malformedReservation)
  const malformedStored = malformedHarness.fake.documents('node_feedback')
    .find(item => item._id === malformedReservation.feedbackId)
  malformedHarness.fake.replace('node_feedback', malformedReservation.feedbackId, {
    ...malformedStored,
    claimExpiresAt: false
  })
  assert.equal(await malformedHarness.repository.recoverExpiredReservation(malformedReservation.feedbackId), true)
  assert.equal(malformedHarness.fake.documents('node_feedback')[0].publishState, 'aborted')
  assert.equal(malformedHarness.fake.documents('evidences')[0].feedbackId, null)
  assert.equal(Object.hasOwn(malformedHarness.fake.documents('business_nodes')[0], 'feedbackClaimId'), false)
  const continued = stateSnapshot(malformedHarness.fake)
  assert.equal(await malformedHarness.repository.recoverExpiredReservation(malformedReservation.feedbackId), false)
  assert.deepEqual(stateSnapshot(malformedHarness.fake), continued)
})

test('maintenance recovery never clears a replacement node claim', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 1 })
  const value = submission({ evidenceIds: ['evidence-1'] })
  const reservation = await repository.beginFeedback(value)
  await repository.claimEvidenceChunk(value, reservation)
  const stored = fake.documents('node_feedback').find(item => item._id === reservation.feedbackId)
  fake.replace('node_feedback', reservation.feedbackId, {
    ...stored,
    claimExpiresAt: new Date(NOW.getTime() - 1)
  })
  fake.replace('business_nodes', 'node-1', {
    ...fake.documents('business_nodes').find(item => item._id === 'node-1'),
    feedbackClaimId: 'replacement-winner',
    feedbackClaimHash: 'replacement',
    feedbackClaimExpiresAt: new Date(NOW.getTime() + 60_000)
  })

  assert.equal(await repository.recoverExpiredReservation(reservation.feedbackId), true)
  assert.equal(fake.documents('node_feedback').find(item => item._id === reservation.feedbackId).publishState, 'aborted')
  assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-1').feedbackClaimId, 'replacement-winner')
  assert.equal(fake.documents('evidences')[0].feedbackId, null)
})

test('maintenance recovery never clears a claimed node outside the reservation line', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 1 })
  const value = submission({ evidenceIds: ['evidence-1'] })
  const reservation = await repository.beginFeedback(value)
  await repository.claimEvidenceChunk(value, reservation)
  const stored = fake.documents('node_feedback').find(item => item._id === reservation.feedbackId)
  fake.replace('node_feedback', reservation.feedbackId, {
    ...stored,
    businessLineId: 'foreign-line',
    claimExpiresAt: new Date(NOW.getTime() - 1)
  })

  assert.equal(await repository.recoverExpiredReservation(reservation.feedbackId), true)
  assert.equal(fake.documents('node_feedback').find(item => item._id === reservation.feedbackId).publishState, 'aborted')
  assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-1').feedbackClaimId, reservation.feedbackId)
  assert.equal(fake.documents('evidences')[0].feedbackId, null)
})

test('contention recovery rejects an expired claimed reservation from another line or node without writes', async () => {
  for (const mismatch of [
    { businessLineId: 'foreign-line', nodeId: 'node-1' },
    { businessLineId: 'line-1', nodeId: 'foreign-node' }
  ]) {
    const data = seed({ evidenceCount: 1 })
    data.node_feedback = [{
      _id: 'foreign-winner', businessLineId: mismatch.businessLineId, nodeId: mismatch.nodeId,
      publishState: 'reserved', status: 'completed', submittedBy: 'account-a',
      requestHash: 'foreign', inputHash: 'foreign', requestFingerprint: 'f'.repeat(64),
      claimExpiresAt: new Date(NOW.getTime() - 1)
    }]
    Object.assign(data.business_nodes[0], {
      feedbackClaimId: 'foreign-winner', feedbackClaimHash: 'foreign',
      feedbackClaimExpiresAt: new Date(NOW.getTime() - 1)
    })
    Object.assign(data.evidences[0], {
      feedbackId: 'foreign-winner', feedbackRevision: null, attachmentState: 'claiming',
      attachmentClaimExpiresAt: new Date(NOW.getTime() - 1),
      attachmentPreviousOrphanExpiresAt: data.evidences[0].orphanExpiresAt,
      orphanExpiresAt: null
    })
    const { fake, repository } = createFeedbackHarness({ seed: data })
    const before = stateSnapshot(fake)

    await assert.rejects(
      repository.commitFeedback(submission({
        actor: { _id: 'account-b', status: 'active' },
        input: { requestKey: `foreign-${mismatch.businessLineId}-${mismatch.nodeId}` }
      })),
      error => error.code === 'VERSION_CONFLICT'
    )
    assert.deepEqual(stateSnapshot(fake), before)
  }
})

test('same-request recovery rejects a reservation whose stored line or node changed without writes', async () => {
  for (const mismatch of [
    { businessLineId: 'foreign-line', nodeId: 'node-1' },
    { businessLineId: 'line-1', nodeId: 'foreign-node' }
  ]) {
    const { fake, repository } = createFeedbackHarness({ evidenceCount: 1 })
    const value = submission({ evidenceIds: ['evidence-1'] })
    const reservation = await repository.beginFeedback(value)
    await repository.claimEvidenceChunk(value, reservation)
    const stored = fake.documents('node_feedback').find(item => item._id === reservation.feedbackId)
    fake.replace('node_feedback', reservation.feedbackId, {
      ...stored,
      businessLineId: mismatch.businessLineId,
      nodeId: mismatch.nodeId,
      claimExpiresAt: new Date(NOW.getTime() - 1)
    })
    const before = stateSnapshot(fake)

    await assert.rejects(repository.commitFeedback(value), error => error.code === 'VERSION_CONFLICT')
    assert.deepEqual(stateSnapshot(fake), before)
  }
})

test('a new OR signer recovers an expired interrupted winner instead of receiving a false completion', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 0 })
  const interrupted = submission({ input: { requestKey: 'interrupted' } })
  const reservation = await repository.beginFeedback(interrupted)
  const expiredAt = new Date(NOW.getTime() - 1)
  fake.replace('node_feedback', reservation.feedbackId, {
    ...fake.documents('node_feedback')[0], claimExpiresAt: expiredAt
  })
  fake.replace('business_nodes', 'node-1', {
    ...fake.documents('business_nodes').find(item => item._id === 'node-1'),
    feedbackClaimExpiresAt: expiredAt
  })

  const result = await repository.commitFeedback(submission({
    actor: { _id: 'account-b', status: 'active' }, input: { requestKey: 'replacement' }
  }))
  assert.equal(result.nodeStatus, 'completed')
  assert.equal(fake.documents('node_feedback').find(item => item._id === reservation.feedbackId).publishState, 'aborted')
  assert.equal(fake.documents('node_feedback').filter(item => item.publishState === 'published').length, 1)
})

test('retry after final transaction interruption publishes the existing complete reservation once', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 0 })
  const value = submission()
  const reservation = await repository.beginFeedback(value)
  await repository.claimEvidenceChunk(value, reservation)
  fake.failNextWrite({ collection: 'audit_logs', operation: 'set', error: new Error('audit unavailable') })
  await assert.rejects(repository.finalizeFeedback(value, reservation), /audit unavailable/)
  assert.equal(fake.documents('node_feedback')[0].publishState, 'reserved')
  assert.equal(fake.documents('business_nodes')[0].status, 'ready')

  const result = await repository.commitFeedback(value)
  assert.equal(result.revision, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
})

test('corrupt resume cursor digest never skips evidence and is aborted safely', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 2 })
  const value = submission({ evidenceIds: ['evidence-1', 'evidence-2'] })
  const reservation = await repository.beginFeedback(value)
  fake.replace('node_feedback', reservation.feedbackId, {
    ...fake.documents('node_feedback')[0], claimedCount: 1, claimedDigest: 'corrupt'
  })
  await assert.rejects(repository.commitFeedback(value), error => error.code === 'VERSION_CONFLICT')
  assert.equal(fake.documents('node_feedback')[0].publishState, 'aborted')
  assert.equal(fake.documents('evidences').every(item => item.feedbackId === null), true)
})

test('same request is idempotent, changed payload conflicts, and another OR signer loses completion', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 0 })
  const original = submission()
  const first = await repository.commitFeedback(original)
  assert.deepEqual(await repository.commitFeedback(original), first)
  await assert.rejects(
    repository.commitFeedback(submission({ input: { comment: 'different' } })),
    error => error.code === 'VERSION_CONFLICT'
  )
  await assert.rejects(
    repository.commitFeedback(submission({ actor: { _id: 'account-b', status: 'active' }, input: { requestKey: 'other-request' } })),
    error => error.code === 'NODE_ALREADY_COMPLETED'
  )
  assert.equal(fake.documents('node_feedback').filter(item => item.publishState === 'published').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
})

test('an idempotent retry still revalidates the active account and fixed account relationships', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 0 })
  const original = submission()
  await repository.commitFeedback(original)
  fake.replace('users', 'account-a', { _id: 'account-a', status: 'disabled' })
  await assert.rejects(repository.commitFeedback(original), error => error.code === 'FORBIDDEN')
})

test('two overlapping OR-sign completions publish one revision, one activation, and one audit', async () => {
  const { fake, repository } = createOptimisticFeedbackHarness({ evidenceCount: 0 })
  const results = await Promise.allSettled([
    repository.commitFeedback(submission({ actor: { _id: 'account-a', status: 'active' }, input: { requestKey: 'race-a' } })),
    repository.commitFeedback(submission({ actor: { _id: 'account-b', status: 'active' }, input: { requestKey: 'race-b' } }))
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter(item => item.status === 'rejected' && item.reason.code === 'NODE_ALREADY_COMPLETED').length, 1)
  assert.equal(fake.documents('node_feedback').filter(item => item.publishState === 'published').length, 1)
  assert.equal(fake.documents('business_nodes').filter(item => item.status === 'ready').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.ok(fake.metrics.maxActiveCallbacks > 1)
  assert.ok(fake.metrics.conflicts > 0)
})

test('history hides reservations, authorizes members with schema precedence, and safely projects legacy feedback', async () => {
  const data = seed({ evidenceCount: 1 })
  data.node_feedback = [
    { _id: 'hidden', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'reserved', comment: 'hidden' },
    { _id: 'new', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published', revision: 2, nodeCode: 'CODE', nodeName: '执行', status: 'blocked', fieldValues: [], comment: 'new', submittedBy: 'account-a', submittedAt: NOW },
    { _id: 'legacy', businessLineId: 'line-1', nodeId: 'node-1', status: 'in_progress', comment: 'legacy', submittedBy: 'wx-old', createdAt: NOW }
  ]
  data.evidences[0].feedbackId = 'new'
  data.evidences[0].feedbackRevision = 2
  data.evidences[0].attachmentState = 'attached'
  data.evidences[0].retentionScope = 'business_line'
  data.evidences[0].retentionSource = 'node_feedback'
  const { repository } = createFeedbackHarness({ seed: data })
  const result = await repository.getNodeHistory({ actor: { _id: 'manager', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1' })

  assert.equal(result.history.length, 2)
  assert.equal(result.history.some(item => item.feedbackId === 'hidden'), false)
  const legacy = result.history.find(item => item.feedbackId === 'legacy')
  assert.equal(Object.hasOwn(legacy, 'revision'), false)
  assert.equal(Object.hasOwn(legacy, 'nodeCode'), false)
  const current = result.history.find(item => item.feedbackId === 'new')
  assert.deepEqual(current.evidences, [{
    evidenceId: 'evidence-1', fileName: 'file-1.pdf', category: 'pdf', extension: 'pdf',
    size: 1, storageStatus: 'available', purgeDueAt: null, purgedAt: null
  }])
  assert.equal(Object.hasOwn(current.evidences[0], 'fileId'), false)
})

test('published lookup is exact and revalidates the current active account before returning a frozen result', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 0 })
  const value = submission()
  const published = await repository.commitFeedback(value)
  assert.deepEqual(await repository.findPublishedFeedback(value), published)

  await assert.rejects(
    repository.findPublishedFeedback({ ...value, requestFingerprint: '0'.repeat(64) }),
    error => error.code === 'VERSION_CONFLICT'
  )
  fake.replace('users', 'account-a', { _id: 'account-a', status: 'disabled' })
  await assert.rejects(repository.findPublishedFeedback(value), error => error.code === 'FORBIDDEN')
  await assert.rejects(
    repository.findPublishedFeedback(submission({ input: { comment: 'changed' } })),
    error => error.code === 'FORBIDDEN'
  )
  await assert.rejects(
    repository.commitFeedback(submission({ input: { comment: 'changed' } })),
    error => error.code === 'FORBIDDEN'
  )

  const finalSeed = seed({ evidenceCount: 0 })
  finalSeed.business_lines[0].nodeCount = 1
  finalSeed.business_nodes = [finalSeed.business_nodes[0]]
  const finalHarness = createFeedbackHarness({ seed: finalSeed })
  const finalValue = submission({ input: { requestKey: 'final-retry' } })
  const finalResult = await finalHarness.repository.commitFeedback(finalValue)
  assert.deepEqual(await finalHarness.repository.findPublishedFeedback(finalValue), finalResult)
})

test('旧提交入口的精确重试也不能绕过新版审核节点', async () => {
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 0 })
  const value = submission()
  await repository.commitFeedback(value)
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  fake.replace('business_nodes', 'node-1', {
    ...node,
    workflowMode: 'review',
    processorUserIds: ['account-a'],
    reviewerUserIds: ['manager'],
    processingRoundNumber: 1
  })

  await assert.rejects(
    repository.findPublishedFeedback({ ...value, legacyOnly: true }),
    error => error.code === 'NODE_PENDING_REVIEW'
  )
})

test('disabled actors cannot distinguish feedback reservation existence, status, or payload across actor-facing entrypoints', async () => {
  async function prepare(state, suffix) {
    const harness = createFeedbackHarness({ evidenceCount: 0 })
    const exact = submission({ input: { requestKey: `actor-order-${suffix}` } })
    let identity = { feedbackId: 'missing-reservation' }
    if (state === 'reserved' || state === 'published') {
      identity = await harness.repository.beginFeedback(exact)
    }
    if (state === 'published') {
      await harness.repository.claimEvidenceChunk(exact, identity)
      await harness.repository.finalizeFeedback(exact, identity)
    }
    harness.fake.replace('users', 'account-a', { _id: 'account-a', status: 'disabled' })
    return { ...harness, exact, identity }
  }

  function payload(exact, mode) {
    if (mode === 'exact') return exact
    if (mode === 'changed') {
      return submission({ input: { requestKey: exact.input.requestKey, comment: 'changed' } })
    }
    return submission({ input: { requestKey: `${exact.input.requestKey}-missing` } })
  }

  const failures = []
  for (const entrypoint of ['findPublishedFeedback', 'beginFeedback', 'claimEvidenceChunk', 'finalizeFeedback']) {
    for (const state of ['missing', 'reserved', 'published']) {
      for (const mode of ['exact', 'changed', 'missing']) {
        const prepared = await prepare(state, `${entrypoint}-${state}-${mode}`)
        try {
          const value = payload(prepared.exact, mode)
          if (entrypoint === 'claimEvidenceChunk' || entrypoint === 'finalizeFeedback') {
            await prepared.repository[entrypoint](value, prepared.identity)
          } else {
            await prepared.repository[entrypoint](value)
          }
          failures.push(`${entrypoint}/${state}/${mode}:RETURNED`)
        } catch (error) {
          if (error.code !== 'FORBIDDEN') failures.push(`${entrypoint}/${state}/${mode}:${error.code}`)
        }
      }
    }
  }

  for (const state of ['missing', 'reserved', 'published']) {
    const prepared = await prepare(state, `history-${state}`)
    try {
      await prepared.repository.getNodeHistory({
        actor: { _id: 'account-a' }, businessLineId: 'line-1', nodeId: 'node-1'
      })
      failures.push(`getNodeHistory/${state}:RETURNED`)
    } catch (error) {
      if (error.code !== 'FORBIDDEN') failures.push(`getNodeHistory/${state}:${error.code}`)
    }
  }

  assert.deepEqual(failures, [])
})

test('a published non-completion winner conflicts and a live reservation times out retryably', async () => {
  const progressSeed = seed({ evidenceCount: 0 })
  const firstHarness = createFeedbackHarness({ seed: progressSeed })
  await firstHarness.repository.commitFeedback(submission({ input: { status: 'in_progress', requestKey: 'progress-winner' } }))
  const winner = firstHarness.fake.documents('node_feedback')[0]
  firstHarness.fake.replace('business_nodes', 'node-1', {
    ...firstHarness.fake.documents('business_nodes').find(item => item._id === 'node-1'),
    feedbackClaimId: winner._id,
    feedbackClaimExpiresAt: new Date(NOW.getTime() + 60_000)
  })
  await assert.rejects(
    firstHarness.repository.commitFeedback(submission({ actor: { _id: 'account-b', status: 'active' }, input: { requestKey: 'loser', expectedNodeVersion: 5 } })),
    error => error.code === 'VERSION_CONFLICT'
  )

  const live = createOptimisticFeedbackHarness({ evidenceCount: 0, wait: () => Promise.resolve() })
  const held = await live.repository.beginFeedback(submission({ input: { requestKey: 'held' } }))
  await assert.rejects(
    live.repository.commitFeedback(submission({ actor: { _id: 'account-b', status: 'active' }, input: { requestKey: 'waiting' } })),
    error => error.code === 'FEEDBACK_COMMIT_IN_PROGRESS'
  )
  assert.equal(live.fake.documents('node_feedback').find(item => item._id === held.feedbackId).publishState, 'reserved')

  const orphaned = seed({ evidenceCount: 0 })
  orphaned.business_nodes[0].status = 'completed'
  const orphanedHarness = createFeedbackHarness({ seed: orphaned })
  await assert.rejects(
    orphanedHarness.repository.commitFeedback(submission()),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('revocation between contention authorization and recovery start cannot mutate the winner claim', async () => {
  const data = seed({ evidenceCount: 0 })
  data.node_feedback = [{
    _id: 'expired-winner', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'reserved',
    status: 'completed', submittedBy: 'account-a', requestHash: 'old', inputHash: 'old',
    claimExpiresAt: new Date(NOW.getTime() - 1)
  }]
  Object.assign(data.business_nodes[0], {
    feedbackClaimId: 'expired-winner', feedbackClaimHash: 'old',
    feedbackClaimExpiresAt: new Date(NOW.getTime() - 1)
  })

  let fake
  let revocationInjected = false
  const harness = createFeedbackHarness({
    seed: data,
    afterTransaction: async ({ result }) => {
      if (revocationInjected || !result || result.type !== 'reserved' || !result.winner) return
      revocationInjected = true
      fake.replace('users', 'account-b', { _id: 'account-b', status: 'disabled' })
    }
  })
  fake = harness.fake

  const outcome = await harness.repository.commitFeedback(submission({
    actor: { _id: 'account-b', status: 'active' },
    input: { requestKey: 'contender-expired-window' }
  })).then(result => ({ code: 'FULFILLED', result }), error => ({ code: error.code }))

  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  const winner = fake.documents('node_feedback').find(item => item._id === 'expired-winner')
  const failures = []
  if (revocationInjected) {
    failures.push('expired winner escaped the authorization transaction before recovery start')
    if (outcome.code !== 'FORBIDDEN') failures.push(`unexpected result after revocation: ${outcome.code}`)
    if (node.feedbackClaimId !== 'expired-winner') failures.push('claim changed after revocation')
    if (!winner || winner.publishState !== 'reserved') failures.push(`winner changed after revocation: ${winner && winner.publishState}`)
  } else if (outcome.code !== 'FULFILLED') {
    failures.push(`atomic authorized recovery did not retry successfully: ${outcome.code}`)
  }
  assert.deepEqual(failures, [])
})

test('every account and relationship revocation has no post-authorization recovery window', async () => {
  const mutations = {
    disabled(fake) {
      fake.replace('users', 'account-b', { _id: 'account-b', status: 'disabled' })
    },
    missing_user(fake) {
      fake.state.users.delete('account-b')
    },
    removed_member(fake) {
      const line = fake.documents('business_lines').find(item => item._id === 'line-1')
      fake.replace('business_lines', 'line-1', { ...line, memberUserIds: ['account-a', 'manager'] })
    },
    removed_assignee(fake) {
      const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
      fake.replace('business_nodes', 'node-1', { ...node, assigneeUserIds: ['account-a'] })
    },
    moved_node(fake) {
      const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
      fake.replace('business_nodes', 'node-1', { ...node, businessLineId: 'other-line' })
    },
    changed_schema(fake) {
      const line = fake.documents('business_lines').find(item => item._id === 'line-1')
      const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
      delete line.managerUserIds
      delete line.memberUserIds
      delete node.assigneeUserIds
      fake.replace('business_lines', 'line-1', { ...line, managerIds: ['legacy'], memberIds: ['legacy'] })
      fake.replace('business_nodes', 'node-1', { ...node, assigneeIds: ['legacy'] })
    }
  }
  const failures = []
  for (const [name, mutate] of Object.entries(mutations)) {
    const data = seed({ evidenceCount: 0 })
    data.node_feedback = [{
      _id: `expired-${name}`, businessLineId: 'line-1', nodeId: 'node-1', publishState: 'reserved',
      status: 'completed', submittedBy: 'account-a', requestHash: 'old', inputHash: 'old',
      claimExpiresAt: new Date(NOW.getTime() - 1)
    }]
    Object.assign(data.business_nodes[0], {
      feedbackClaimId: `expired-${name}`, feedbackClaimHash: 'old',
      feedbackClaimExpiresAt: new Date(NOW.getTime() - 1)
    })
    let fake
    let injected = false
    let stateAfterRevocation
    const harness = createFeedbackHarness({
      seed: data,
      afterTransaction: async ({ result }) => {
        if (injected || !result || result.type !== 'reserved' || !result.winner) return
        injected = true
        mutate(fake)
        stateAfterRevocation = stateSnapshot(fake)
      }
    })
    fake = harness.fake
    const outcome = await harness.repository.commitFeedback(submission({
      actor: { _id: 'account-b', status: 'active' },
      input: { requestKey: `matrix-${name}` }
    })).then(() => 'FULFILLED', error => error.code)
    if (injected) {
      failures.push(`${name}:post-authorization-window:${outcome}`)
      try {
        assert.deepEqual(stateSnapshot(fake), stateAfterRevocation)
      } catch (error) {
        failures.push(`${name}:state-mutated-after-revocation`)
      }
    }
    if (!injected && outcome !== 'FULFILLED') failures.push(`${name}:atomic-recovery:${outcome}`)
  }
  assert.deepEqual(failures, [])
})

test('same-request recovery cannot start after authorization is revoked', async () => {
  let fake
  let revocationInjected = false
  const harness = createFeedbackHarness({
    evidenceCount: 0,
    afterTransactionError: async ({ error }) => {
      if (revocationInjected || error.code !== 'RESERVATION_RECOVERY_REQUIRED') return
      revocationInjected = true
      fake.replace('users', 'account-a', { _id: 'account-a', status: 'disabled' })
    }
  })
  fake = harness.fake
  const value = submission()
  const reservation = await harness.repository.beginFeedback(value)
  fake.replace('node_feedback', reservation.feedbackId, {
    ...fake.documents('node_feedback')[0], claimExpiresAt: new Date(NOW.getTime() - 1)
  })

  const outcome = await harness.repository.commitFeedback(value)
    .then(result => ({ code: 'FULFILLED', result }), error => ({ code: error.code }))
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  const stored = fake.documents('node_feedback').find(item => item._id === reservation.feedbackId)
  const failures = []
  if (revocationInjected) {
    failures.push('same-request expiry escaped the authorization transaction before recovery start')
    if (outcome.code !== 'FORBIDDEN') failures.push(`unexpected result after revocation: ${outcome.code}`)
    if (node.feedbackClaimId !== reservation.feedbackId) failures.push('same-request claim changed after revocation')
    if (!stored || stored.publishState !== 'reserved') failures.push(`same-request winner changed: ${stored && stored.publishState}`)
  } else if (outcome.code !== 'FULFILLED') {
    failures.push(`atomic same-request recovery did not retry successfully: ${outcome.code}`)
  }
  assert.deepEqual(failures, [])
})

test('submission failure compensation reauthorizes before starting rollback', async () => {
  const data = seed({ evidenceCount: 1 })
  data.evidences[0].uploadedBy = 'account-b'
  let fake
  let reservationId
  let revocationInjected = false
  const harness = createFeedbackHarness({
    seed: data,
    afterTransaction: async ({ result }) => {
      if (result && result.feedbackId && result.cursor === 0) reservationId = result.feedbackId
    },
    afterTransactionError: async ({ error }) => {
      if (revocationInjected || error.code !== 'EVIDENCE_NOT_ATTACHABLE') return
      revocationInjected = true
      fake.replace('users', 'account-a', { _id: 'account-a', status: 'disabled' })
    }
  })
  fake = harness.fake

  const outcome = await harness.repository.commitFeedback(submission({ evidenceIds: ['evidence-1'] }))
    .then(result => ({ code: 'FULFILLED', result }), error => ({ code: error.code }))
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  const stored = fake.documents('node_feedback').find(item => item._id === reservationId)
  assert.equal(revocationInjected, true)
  assert.equal(outcome.code, 'EVIDENCE_NOT_ATTACHABLE')
  assert.equal(node.feedbackClaimId, reservationId)
  assert.equal(stored.publishState, 'reserved')
  assert.equal(fake.documents('evidences')[0].feedbackId, null)
  assert.equal(fake.documents('audit_logs').length, 0)
})

test('contention recovery never aborts a winner after the node claim changes', async () => {
  const data = seed({ evidenceCount: 0 })
  data.node_feedback = [{
    _id: 'old-winner', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'reserved',
    status: 'completed', submittedBy: 'account-a', requestHash: 'old', inputHash: 'old',
    claimExpiresAt: new Date(NOW.getTime() - 1)
  }]
  Object.assign(data.business_nodes[0], {
    feedbackClaimId: 'old-winner', feedbackClaimHash: 'old',
    feedbackClaimExpiresAt: new Date(NOW.getTime() - 1)
  })
  let fake
  let claimChanged = false
  const harness = createFeedbackHarness({
    seed: data,
    wait: async () => {},
    afterTransactionError: async ({ error }) => {
      if (claimChanged || error.code !== 'NODE_COMMIT_IN_PROGRESS') return
      claimChanged = true
      fake.replace('node_feedback', 'replacement-winner', {
        _id: 'replacement-winner', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'reserved',
        status: 'completed', submittedBy: 'account-a', requestHash: 'replacement', inputHash: 'replacement',
        claimExpiresAt: new Date(NOW.getTime() + 60_000)
      })
      fake.replace('business_nodes', 'node-1', {
        ...fake.documents('business_nodes').find(item => item._id === 'node-1'),
        feedbackClaimId: 'replacement-winner', feedbackClaimHash: 'replacement',
        feedbackClaimExpiresAt: new Date(NOW.getTime() + 60_000)
      })
    }
  })
  fake = harness.fake

  await assert.rejects(
    harness.repository.commitFeedback(submission({
      actor: { _id: 'account-b', status: 'active' },
      input: { requestKey: 'changed-claim-contender' }
    })),
    error => error.code === 'FEEDBACK_COMMIT_IN_PROGRESS'
  )
  const oldWinner = fake.documents('node_feedback').find(item => item._id === 'old-winner')
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  assert.equal(oldWinner.publishState, 'reserved')
  assert.equal(node.feedbackClaimId, 'replacement-winner')
})

test('contention polling reauthorizes before revealing or acting on every winner state', async () => {
  async function poll({ actorMutation, winnerState, winnerStatus = 'completed' }) {
    const data = seed({ evidenceCount: 0 })
    data.node_feedback = [{
      _id: 'winner', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'reserved',
      status: 'completed', submittedBy: 'account-a', claimExpiresAt: new Date(NOW.getTime() + 60_000)
    }]
    Object.assign(data.business_nodes[0], {
      feedbackClaimId: 'winner', feedbackClaimHash: 'winner-hash',
      feedbackClaimExpiresAt: new Date(NOW.getTime() + 60_000)
    })
    let fake
    let crossedBarrier = false
    const harness = createFeedbackHarness({
      seed: data,
      wait: async () => {
        if (crossedBarrier) return
        crossedBarrier = true
        if (actorMutation) actorMutation(fake)
        if (winnerState === 'missing') {
          fake.state.node_feedback.delete('winner')
        } else if (winnerState !== 'reserved') {
          const winner = fake.documents('node_feedback').find(item => item._id === 'winner')
          fake.replace('node_feedback', 'winner', { ...winner, publishState: winnerState, status: winnerStatus })
        }
        if (winnerState === 'published' && winnerStatus === 'completed') {
          const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
          const line = fake.documents('business_lines').find(item => item._id === 'line-1')
          fake.replace('business_nodes', 'node-1', { ...node, status: 'completed', latestFeedbackId: 'winner' })
          fake.replace('business_lines', 'line-1', { ...line, currentNodeId: 'line-1-node-002' })
        }
      }
    })
    fake = harness.fake
    try {
      const result = await harness.repository.commitFeedback(submission({
        actor: { _id: 'account-b', status: 'active' },
        input: { requestKey: `contender-${winnerState}-${winnerStatus}` }
      }))
      return { code: 'FULFILLED', result, fake }
    } catch (error) {
      return { code: error.code, fake }
    }
  }

  const actorMutations = {
    disabled(fake) {
      fake.replace('users', 'account-b', { _id: 'account-b', status: 'disabled' })
    },
    missing_user(fake) {
      fake.state.users.delete('account-b')
    },
    removed_member(fake) {
      const line = fake.documents('business_lines').find(item => item._id === 'line-1')
      fake.replace('business_lines', 'line-1', { ...line, memberUserIds: ['account-a', 'manager'] })
    },
    removed_assignee(fake) {
      const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
      fake.replace('business_nodes', 'node-1', { ...node, assigneeUserIds: ['account-a'] })
    },
    moved_node(fake) {
      const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
      fake.replace('business_nodes', 'node-1', { ...node, businessLineId: 'other-line' })
    },
    changed_schema(fake) {
      const line = fake.documents('business_lines').find(item => item._id === 'line-1')
      const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
      delete line.managerUserIds
      delete line.memberUserIds
      delete node.assigneeUserIds
      fake.replace('business_lines', 'line-1', { ...line, managerIds: ['legacy'], memberIds: ['legacy'] })
      fake.replace('business_nodes', 'node-1', { ...node, assigneeIds: ['legacy'] })
    }
  }
  const unauthorizedFailures = []
  for (const [mutationName, actorMutation] of Object.entries(actorMutations)) {
    for (const winnerState of ['published', 'aborted', 'missing']) {
      const outcome = await poll({ actorMutation, winnerState })
      const node = outcome.fake.documents('business_nodes').find(item => item._id === 'node-1')
      if (outcome.code !== 'FORBIDDEN') unauthorizedFailures.push(`${mutationName}/${winnerState}:${outcome.code}`)
      if (node.feedbackClaimId !== 'winner') unauthorizedFailures.push(`${mutationName}/${winnerState}:CLAIM_CHANGED`)
    }
  }
  assert.deepEqual(unauthorizedFailures, [])

  const activeCases = [
    { winnerState: 'published', winnerStatus: 'completed', code: 'NODE_ALREADY_COMPLETED' },
    { winnerState: 'published', winnerStatus: 'blocked', code: 'VERSION_CONFLICT' },
    { winnerState: 'reserved', code: 'FEEDBACK_COMMIT_IN_PROGRESS' },
    { winnerState: 'missing', code: 'FEEDBACK_COMMIT_IN_PROGRESS' },
    { winnerState: 'aborted', code: 'FULFILLED' }
  ]
  const activeFailures = []
  for (const item of activeCases) {
    const outcome = await poll(item)
    if (outcome.code !== item.code) activeFailures.push(`${item.winnerState}/${item.winnerStatus || ''}:${outcome.code}`)
  }
  assert.deepEqual(activeFailures, [])
})

test('only final completion starts line retention and history inherits one authoritative deadline', async () => {
  const data = seed({ evidenceCount: 2 })
  data.business_lines[0].nodeCount = 1
  data.business_nodes = [data.business_nodes[0]]
  const { fake, repository } = createFeedbackHarness({ seed: data })
  await repository.commitFeedback(submission({
    evidenceIds: ['evidence-1'], evidenceTotalBytes: 1,
    input: { status: 'blocked', requestKey: 'blocked-final' }
  }))
  assert.equal(fake.documents('business_lines')[0].retentionStartedAt, undefined)
  assert.equal(fake.documents('evidences').find(item => item._id === 'evidence-1').purgeDueAt, null)

  await repository.commitFeedback(submission({
    evidenceIds: ['evidence-2'], evidenceTotalBytes: 1,
    input: { status: 'completed', expectedNodeVersion: 5, requestKey: 'completed-final' }
  }))
  const due = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000)
  assert.deepEqual(fake.documents('business_lines')[0].purgeDueAt, due)
  assert.equal(fake.documents('evidences').every(item => item.purgeDueAt === null), true)

  const history = await repository.getNodeHistory({ actor: { _id: 'manager' }, businessLineId: 'line-1', nodeId: 'node-1' })
  assert.equal(history.history.length, 2)
  assert.equal(history.history.every(item => item.evidences.every(evidence => evidence.purgeDueAt.getTime() === due.getTime())), true)
})

test('expired or malformed same-request leases are replaced with a fresh transition timestamp', async () => {
  for (const malformed of [false, true]) {
    let current = new Date(NOW)
    const data = seed({ evidenceCount: 0 })
    data.business_lines[0].nodeCount = 1
    data.business_nodes = [data.business_nodes[0]]
    const { fake, repository } = createFeedbackHarness({ seed: data, clock: () => new Date(current) })
    const value = submission()
    const reservation = await repository.beginFeedback(value)
    current = new Date(NOW.getTime() + 61 * 24 * 60 * 60 * 1000)
    fake.replace('node_feedback', reservation.feedbackId, {
      ...fake.documents('node_feedback')[0], claimExpiresAt: malformed ? '2026-13-40T00:00:00.000Z' : new Date(NOW.getTime() - 1)
    })
    const result = await repository.commitFeedback(value)
    assert.equal(result.lineStatus, 'completed')
    assert.deepEqual(fake.documents('business_nodes')[0].completedAt, current)
    assert.equal(fake.documents('node_feedback')[0].recoveryCount, 1)
  }
})

test('history uses current legacy identity, deduplicates legacy evidence IDs, filters associations, and sorts deterministically', async () => {
  const data = seed({ evidenceCount: 3 })
  data.users.find(item => item._id === 'manager').openid = 'wx-current'
  delete data.business_lines[0].managerUserIds
  delete data.business_lines[0].memberUserIds
  data.business_lines[0].managerIds = ['wx-current']
  delete data.business_nodes[0].assigneeUserIds
  data.business_nodes[0].assigneeIds = ['wx-current']
  data.node_feedback = [
    { _id: 'wrong-line', businessLineId: 'line-x', nodeId: 'node-1', status: 'blocked', submittedBy: 'wx-secret', createdAt: NOW },
    { _id: 'legacy-b', businessLineId: 'line-1', nodeId: 'node-1', status: 'blocked', submittedBy: 'wx-secret', createdAt: NOW, evidenceIds: ['evidence-1', 'evidence-2'] },
    { _id: 'legacy-a', businessLineId: 'line-1', nodeId: 'node-1', status: 'in_progress', submittedBy: 'wx-secret', createdAt: NOW, evidenceIds: ['evidence-1'] }
  ]
  Object.assign(data.evidences[0], { feedbackId: 'legacy-b', attachmentState: 'attached' })
  Object.assign(data.evidences[1], { feedbackId: null, attachmentState: undefined })
  Object.assign(data.evidences[2], { businessLineId: 'line-x', feedbackId: 'legacy-b', attachmentState: 'attached' })
  const { fake, repository } = createFeedbackHarness({ seed: data })
  const result = await repository.getNodeHistory({ actor: { _id: 'manager', openid: 'wx-stale' }, businessLineId: 'line-1', nodeId: 'node-1' })
  assert.deepEqual(result.history.map(item => item.feedbackId), ['legacy-a', 'legacy-b'])
  assert.equal(result.history.every(item => item.submittedBy === null && item.submittedByLabel === '历史用户'), true)
  assert.deepEqual(result.history.find(item => item.feedbackId === 'legacy-b').evidences.map(item => item.evidenceId), ['evidence-1', 'evidence-2'])
  assert.equal(JSON.stringify(result).includes('wx-secret'), false)
  fake.replace('users', 'manager', { _id: 'manager', status: 'active', openid: 'wx-rebound' })
  await assert.rejects(
    repository.getNodeHistory({ actor: { _id: 'manager', openid: 'wx-current' }, businessLineId: 'line-1', nodeId: 'node-1' }),
    error => error.code === 'FORBIDDEN'
  )
})

test('corrupt cursors, zero-byte evidence, unsafe counters, and permissive dates fail closed', async () => {
  for (const corrupt of [
    { claimedCount: -1 }, { claimedCount: 1.5 }, { claimedCount: 3 },
    { claimedBytes: -1 }, { claimedBytes: 1.5 }, { claimedBytes: 3 },
    { evidenceCount: 3 }
  ]) {
    const { fake, repository } = createFeedbackHarness({ evidenceCount: 2 })
    const value = submission({ evidenceIds: ['evidence-1', 'evidence-2'] })
    const reservation = await repository.beginFeedback(value)
    fake.replace('node_feedback', reservation.feedbackId, { ...fake.documents('node_feedback')[0], ...corrupt })
    await assert.rejects(repository.commitFeedback(value), error => error.code === 'VERSION_CONFLICT')
  }

  const zeroData = seed({ evidenceCount: 1 })
  zeroData.evidences[0].size = 0
  await assert.rejects(
    createFeedbackHarness({ seed: zeroData }).repository.commitFeedback(submission({ evidenceIds: ['evidence-1'], evidenceTotalBytes: 0 })),
    error => error.code === 'EVIDENCE_NOT_ATTACHABLE'
  )

  const overflow = seed({ evidenceCount: 0 })
  overflow.business_nodes[0].version = Number.MAX_SAFE_INTEGER
  await assert.rejects(
    createFeedbackHarness({ seed: overflow }).repository.commitFeedback(submission({ input: { expectedNodeVersion: Number.MAX_SAFE_INTEGER } })),
    error => error.code === 'VERSION_CONFLICT'
  )

  for (const invalid of ['2026-13-40T00:00:00.000Z', '2026-08-07', '2026-08-07T03:00:00Z']) {
    const invalidData = seed({ evidenceCount: 1 })
    invalidData.evidences[0].orphanExpiresAt = invalid
    await assert.rejects(
      createFeedbackHarness({ seed: invalidData }).repository.commitFeedback(submission({ evidenceIds: ['evidence-1'] })),
      error => error.code === 'EVIDENCE_NOT_ATTACHABLE'
    )
  }
})

test('an aborted winner releases its stale claim and permits a fresh OR signer', async () => {
  const data = seed({ evidenceCount: 0 })
  data.node_feedback = [{
    _id: 'aborted-winner', businessLineId: 'line-1', nodeId: 'node-1', status: 'completed',
    publishState: 'aborted', submittedBy: 'account-a', requestHash: 'old', inputHash: 'old'
  }]
  Object.assign(data.business_nodes[0], {
    feedbackClaimId: 'aborted-winner', feedbackClaimHash: 'old', feedbackClaimExpiresAt: new Date(NOW.getTime() - 1)
  })
  const { fake, repository } = createFeedbackHarness({ seed: data })
  const result = await repository.commitFeedback(submission({
    actor: { _id: 'account-b', status: 'active' }, input: { requestKey: 'fresh-after-abort' }
  }))
  assert.equal(result.nodeStatus, 'completed')
  assert.equal(fake.documents('node_feedback').filter(item => item.publishState === 'published').length, 1)
})

test('history paginates all revisions and orders mixed timestamps, revisions, and IDs deterministically', async () => {
  const data = seed({ evidenceCount: 0 })
  data.node_feedback = Array.from({ length: 103 }, (_, index) => ({
    _id: `legacy-${String(index).padStart(3, '0')}`,
    businessLineId: 'line-1', nodeId: 'node-1', status: 'in_progress', submittedBy: 'wx-old',
    createdAt: new Date(NOW.getTime() - index * 1000)
  }))
  data.node_feedback.push(
    { _id: 'tie-b', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published', revision: 3, status: 'blocked', submittedBy: 'account-a', submittedAt: new Date(NOW.getTime() + 1000) },
    { _id: 'tie-a', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published', revision: 3, status: 'blocked', submittedBy: 'account-a', submittedAt: new Date(NOW.getTime() + 1000) },
    { _id: 'tie-z', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published', revision: 2, status: 'blocked', submittedBy: 'account-a', submittedAt: new Date(NOW.getTime() + 1000) }
  )
  const { repository } = createFeedbackHarness({ seed: data })
  const result = await repository.getNodeHistory({ actor: { _id: 'manager' }, businessLineId: 'line-1', nodeId: 'node-1' })
  assert.equal(result.history.length, 106)
  assert.deepEqual(result.history.slice(0, 3).map(item => item.feedbackId), ['tie-a', 'tie-b', 'tie-z'])
  assert.equal(result.history.at(-1).feedbackId, 'legacy-102')
})

test('every persisted counter increment rejects unsafe integers without publishing', async () => {
  const cases = [
    data => { data.business_lines[0].version = Number.MAX_SAFE_INTEGER },
    data => { data.business_nodes[1].version = Number.MAX_SAFE_INTEGER },
    data => { data.business_nodes[0].latestFeedbackRevision = Number.MAX_SAFE_INTEGER },
    data => {
      data.node_feedback = [{
        _id: 'old-reserved', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'reserved',
        recoveryCount: Number.MAX_SAFE_INTEGER, claimExpiresAt: new Date(NOW.getTime() - 1)
      }]
      Object.assign(data.business_nodes[0], { feedbackClaimId: 'old-reserved', feedbackClaimExpiresAt: new Date(NOW.getTime() - 1) })
    }
  ]
  for (const [index, mutate] of cases.entries()) {
    const data = seed({ evidenceCount: 0 })
    mutate(data)
    const { fake, repository } = createFeedbackHarness({ seed: data })
    const actor = index === 3 ? { _id: 'account-b', status: 'active' } : undefined
    await assert.rejects(repository.commitFeedback(submission({ actor, input: { requestKey: `overflow-${index}` } })), error => error.code === 'VERSION_CONFLICT')
    assert.equal(fake.documents('node_feedback').every(item => item.publishState !== 'published'), true)
  }
})

test('concurrent exact retries both resolve the same published result after next-node and final-line completion', async () => {
  for (const finalLine of [false, true]) {
    const data = seed({ evidenceCount: 0 })
    if (finalLine) {
      data.business_lines[0].nodeCount = 1
      data.business_nodes = [data.business_nodes[0]]
    }
    const { repository } = createOptimisticFeedbackHarness({ seed: data })
    const value = submission({ input: { requestKey: finalLine ? 'same-final' : 'same-next' } })
    const results = await Promise.all([repository.commitFeedback(value), repository.commitFeedback(value)])
    assert.deepEqual(results[1], results[0])
    assert.equal(results[0].lineStatus, finalLine ? 'completed' : 'active')
  }
})

test('late claim and finalize paths return only an exact active-actor published retry', async () => {
  for (const finalLine of [false, true]) {
    const data = seed({ evidenceCount: 0 })
    if (finalLine) {
      data.business_lines[0].nodeCount = 1
      data.business_nodes = [data.business_nodes[0]]
    }
    const { fake, repository } = createFeedbackHarness({ seed: data })
    const value = submission({ input: { requestKey: finalLine ? 'late-final' : 'late-next' } })
    const reservation = await repository.beginFeedback(value)
    await repository.claimEvidenceChunk(value, reservation)
    const published = await repository.finalizeFeedback(value, reservation)

    assert.deepEqual(await repository.claimEvidenceChunk(value, reservation), { done: true, published })
    assert.deepEqual(await repository.finalizeFeedback(value, reservation), published)
    await assert.rejects(
      repository.claimEvidenceChunk(submission({ input: { requestKey: value.input.requestKey, comment: 'changed' } }), reservation),
      error => error.code === 'VERSION_CONFLICT'
    )

    fake.replace('users', 'account-a', { _id: 'account-a', status: 'disabled' })
    await assert.rejects(repository.claimEvidenceChunk(value, reservation), error => error.code === 'FORBIDDEN')
    await assert.rejects(repository.finalizeFeedback(value, reservation), error => error.code === 'FORBIDDEN')
    const publishedIdentity = { ...reservation, published }
    await assert.rejects(repository.claimEvidenceChunk(value, publishedIdentity), error => error.code === 'FORBIDDEN')
    await assert.rejects(repository.finalizeFeedback(value, publishedIdentity), error => error.code === 'FORBIDDEN')
    const changed = submission({ input: { requestKey: value.input.requestKey, comment: 'changed' } })
    await assert.rejects(repository.claimEvidenceChunk(changed, reservation), error => error.code === 'FORBIDDEN')
    await assert.rejects(repository.finalizeFeedback(changed, reservation), error => error.code === 'FORBIDDEN')
    const changedRequest = submission({ input: { requestKey: `${value.input.requestKey}-changed` } })
    await assert.rejects(repository.claimEvidenceChunk(changedRequest, reservation), error => error.code === 'FORBIDDEN')
    await assert.rejects(repository.finalizeFeedback(changedRequest, reservation), error => error.code === 'FORBIDDEN')
  }
})

test('new feedback history includes only evidence attached to the exact published revision', async () => {
  const data = seed({ evidenceCount: 7 })
  data.node_feedback = [{
    _id: 'new', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published',
    revision: 2, status: 'blocked', comment: '', submittedBy: 'account-a', submittedAt: NOW
  }]
  const ordinary = { retentionScope: 'business_line', retentionSource: 'node_feedback' }
  Object.assign(data.evidences[0], { feedbackId: 'new', feedbackRevision: 2, attachmentState: 'attached', ...ordinary })
  Object.assign(data.evidences[1], { feedbackId: 'new', feedbackRevision: 999, attachmentState: 'attached', ...ordinary })
  Object.assign(data.evidences[2], { feedbackId: 'new', attachmentState: 'attached', ...ordinary })
  Object.assign(data.evidences[3], { feedbackId: 'new', feedbackRevision: 1, attachmentState: 'attached', ...ordinary })
  Object.assign(data.evidences[4], { feedbackId: 'new', feedbackRevision: 2, attachmentState: 'attached' })
  Object.assign(data.evidences[5], { feedbackId: 'new', feedbackRevision: 2, attachmentState: 'attached', retentionScope: 'business_line', retentionSource: 'audit_amendment' })
  Object.assign(data.evidences[6], {
    feedbackId: 'new', feedbackRevision: 2, attachmentState: 'attached',
    retentionScope: 'evidence', retentionSource: 'audit_amendment', purgeDueAt: new Date(NOW.getTime() + 1)
  })
  const { repository } = createFeedbackHarness({ seed: data })
  const result = await repository.getNodeHistory({ actor: { _id: 'manager' }, businessLineId: 'line-1', nodeId: 'node-1' })

  assert.deepEqual(result.history[0].evidences.map(item => item.evidenceId), ['evidence-1', 'evidence-7'])
  assert.deepEqual(result.history[0].evidences.map(item => item.purgeDueAt), [null, new Date(NOW.getTime() + 1)])
})

test('terminal history excludes ordinary evidence without a strict line deadline but keeps valid explicit amendments', async () => {
  const data = seed({ evidenceCount: 3 })
  Object.assign(data.business_lines[0], { status: 'completed', purgeDueAt: null })
  data.node_feedback = [
    {
      _id: 'new', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published',
      revision: 1, status: 'completed', comment: '', submittedBy: 'account-a', submittedAt: NOW
    },
    {
      _id: 'legacy', businessLineId: 'line-1', nodeId: 'node-1', status: 'completed',
      submittedBy: 'legacy', createdAt: new Date(NOW.getTime() - 1), evidenceIds: ['evidence-3']
    }
  ]
  Object.assign(data.evidences[0], {
    feedbackId: 'new', feedbackRevision: 1, attachmentState: 'attached',
    retentionScope: 'business_line', retentionSource: 'node_feedback'
  })
  Object.assign(data.evidences[1], {
    feedbackId: 'new', feedbackRevision: 1, attachmentState: 'attached',
    retentionScope: 'evidence', retentionSource: 'audit_amendment', purgeDueAt: new Date(NOW.getTime() + 1)
  })
  Object.assign(data.evidences[2], { feedbackId: null, attachmentState: undefined })
  const { repository } = createFeedbackHarness({ seed: data })
  const result = await repository.getNodeHistory({ actor: { _id: 'manager' }, businessLineId: 'line-1', nodeId: 'node-1' })
  assert.deepEqual(result.history[0].evidences.map(item => item.evidenceId), ['evidence-2'])
  assert.deepEqual(result.history[1].evidences, [])
})

function reviewWorkflowSeed() {
  const data = seed({ evidenceCount: 3 })
  data.business_nodes[0] = {
    ...data.business_nodes[0],
    workflowMode: 'review',
    processorUserIds: ['account-a', 'account-b'],
    reviewerUserIds: ['manager'],
    reviewMode: 'any',
    processingRoundNumber: 1,
    processingSlaWorkHours: 22,
    reviewSlaWorkHours: 8,
    processingStartedAt: new Date('2026-08-07T01:00:00.000Z')
  }
  delete data.business_nodes[0].assigneeUserIds
  return data
}

test('新版节点保存进度复用分块预约并持久化处理动作与轮次', async () => {
  const data = reviewWorkflowSeed()
  const { fake, repository } = createFeedbackHarness({ seed: data })
  const value = submission({
    evidenceIds: ['evidence-1'],
    input: { status: 'in_progress', action: 'save_progress' },
    fieldSnapshots: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '第一版' }],
    evidenceTotalBytes: 1
  })

  const result = await repository.commitFeedback(value)

  assert.equal(result.nodeStatus, 'in_progress')
  const [feedback] = fake.documents('node_feedback')
  assert.equal(feedback.action, 'save_progress')
  assert.equal(feedback.processingRoundNumber, 1)
  assert.equal(feedback.blockedReason, '')
  assert.equal(fake.documents('evidences')[0].processingRoundNumber, 1)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})

test('新版进度的已发布早返回和迟到路径必须仍匹配当前处理语义', async () => {
  const data = reviewWorkflowSeed()
  data.evidences = []
  const { fake, repository } = createFeedbackHarness({ seed: data })
  const value = submission({
    evidenceIds: [],
    input: { status: 'in_progress', action: 'save_progress', requestKey: 'review-progress-retry' },
    evidenceTotalBytes: 0
  })
  const reservation = await repository.beginFeedback(value)
  await repository.claimEvidenceChunk(value, reservation)
  await repository.finalizeFeedback(value, reservation)
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  fake.replace('business_nodes', 'node-1', {
    ...node, status: 'pending_review', activeReviewRoundId: 'review-round-1'
  })

  for (const operation of [
    () => repository.findPublishedFeedback(value),
    () => repository.beginFeedback(value),
    () => repository.claimEvidenceChunk(value, reservation),
    () => repository.finalizeFeedback(value, reservation)
  ]) {
    await assert.rejects(operation(), error => error.code === 'NODE_NOT_ACTIVE')
  }
})

test('新版进度精确重试拒绝过期节点版本、处理轮次和最新反馈关系', async () => {
  for (const mutate of [
    node => ({ ...node, version: node.version + 1 }),
    node => ({ ...node, processingRoundNumber: 2 }),
    node => ({ ...node, latestFeedbackId: 'feedback-later', latestFeedbackRevision: node.latestFeedbackRevision + 1 })
  ]) {
    const data = reviewWorkflowSeed()
    data.evidences = []
    const { fake, repository } = createFeedbackHarness({ seed: data })
    const value = submission({
      evidenceIds: [],
      input: { status: 'in_progress', action: 'save_progress', requestKey: 'stale-review-progress' },
      evidenceTotalBytes: 0
    })
    await repository.commitFeedback(value)
    const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
    fake.replace('business_nodes', 'node-1', mutate(node))
    await assert.rejects(repository.findPublishedFeedback(value), error => error.code === 'VERSION_CONFLICT')
  }
})

test('新版处理竞争等待期间进入待审核后立即停止解释旧预约', async () => {
  const data = reviewWorkflowSeed()
  data.evidences = []
  data.node_feedback = [{
    _id: 'held-review-progress', businessLineId: 'line-1', nodeId: 'node-1',
    publishState: 'reserved', status: 'in_progress', action: 'save_progress',
    processingRoundNumber: 1, submittedBy: 'account-a',
    claimExpiresAt: new Date(NOW.getTime() + 60_000)
  }]
  Object.assign(data.business_nodes[0], {
    feedbackClaimId: 'held-review-progress', feedbackClaimExpiresAt: new Date(NOW.getTime() + 60_000)
  })
  let fake
  let changed = false
  const harness = createFeedbackHarness({
    seed: data,
    wait: async () => {
      if (changed) return
      changed = true
      const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
      fake.replace('business_nodes', 'node-1', {
        ...node, status: 'pending_review', activeReviewRoundId: 'review-held'
      })
    }
  })
  fake = harness.fake

  await assert.rejects(
    harness.repository.commitFeedback(submission({
      actor: { _id: 'account-b', status: 'active' }, evidenceIds: [],
      input: { status: 'in_progress', action: 'save_progress', requestKey: 'waiting-review-progress' },
      evidenceTotalBytes: 0
    })),
    error => error.code === 'NODE_NOT_ACTIVE'
  )
})

test('新版账号关系数组含空值、非法编号、重复值或混合旧字段时完整拒绝', async () => {
  const mutations = [
    data => { data.business_lines[0].memberUserIds = ['account-a', null] },
    data => { data.business_lines[0].memberUserIds = ['account-a', 'account-a'] },
    data => { data.business_lines[0].managerUserIds = ['manager', 'bad id'] },
    data => { data.business_nodes[0].processorUserIds = ['account-a', null] },
    data => { data.business_nodes[0].processorUserIds = ['account-a', 'account-a'] },
    data => {
      data.business_lines[0].memberUserIds = null
      data.business_lines[0].memberIds = ['wx-a']
      data.business_nodes[0].assigneeIds = ['wx-a']
      data.users.find(item => item._id === 'account-a').openid = 'wx-a'
    }
  ]
  for (const [index, mutate] of mutations.entries()) {
    const data = reviewWorkflowSeed()
    data.evidences = []
    mutate(data)
    const { fake, repository } = createFeedbackHarness({ seed: data })
    await assert.rejects(
      repository.commitFeedback(submission({
        actor: { _id: 'account-a', status: 'active', openid: 'wx-a' }, evidenceIds: [],
        input: {
          status: 'in_progress', action: 'save_progress',
          requestKey: `strict-account-schema-${index}`
        },
        evidenceTotalBytes: 0
      })),
      error => error.code === 'FORBIDDEN'
    )
    assert.equal(fake.documents('node_feedback').length, 0)
  }
})

test('当前处理轮草稿分页采用最新字段并按首次版本顺序聚合全部有效凭证', async () => {
  const data = reviewWorkflowSeed()
  data.node_feedback = []
  data.evidences = []
  for (let revision = 1; revision <= 101; revision += 1) {
    const feedbackId = `feedback-${String(revision).padStart(3, '0')}`
    const evidenceId = `evidence-${String(revision).padStart(3, '0')}`
    data.node_feedback.push({
      _id: feedbackId, businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published',
      revision, status: 'in_progress', action: 'save_progress', processingRoundNumber: 1,
      submittedBy: 'account-a', submittedAt: new Date(NOW.getTime() + revision),
      fieldValues: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: `版本-${revision}` }]
    })
    data.evidences.push({
      _id: evidenceId, businessLineId: 'line-1', nodeId: 'node-1', feedbackId,
      feedbackRevision: revision, processingRoundNumber: 1, attachmentState: 'attached',
      retentionScope: 'business_line', retentionSource: 'node_feedback', storageStatus: 'available',
      fileName: `${revision}.pdf`, category: 'pdf', extension: 'pdf', size: 1,
      purgedAt: null, purgeDueAt: null
    })
  }
  data.business_nodes[0].latestFeedbackId = 'feedback-101'
  data.business_nodes[0].latestFeedbackRevision = 101
  const { repository } = createFeedbackHarness({ seed: data })

  const result = await repository.getCurrentProcessingRoundDraft({
    actor: { _id: 'account-a', status: 'active' },
    businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4
  })

  assert.equal(result.feedbackId, 'feedback-101')
  assert.equal(result.feedbackRevision, 101)
  assert.equal(result.fieldSnapshots[0].value, '版本-101')
  assert.equal(result.evidenceIds.length, 101)
  assert.deepEqual(result.evidenceIds.slice(0, 2), ['evidence-001', 'evidence-002'])
  assert.equal(result.evidenceTotalBytes, 101)
})

test('当前处理轮草稿保留同一反馈内凭证的首次选择顺序', async () => {
  const data = reviewWorkflowSeed()
  data.node_feedback = [{
    _id: 'feedback-current', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published',
    revision: 1, status: 'in_progress', action: 'save_progress', processingRoundNumber: 1,
    submittedBy: 'account-a', submittedAt: NOW, fieldValues: []
  }]
  data.business_nodes[0].latestFeedbackId = 'feedback-current'
  data.business_nodes[0].latestFeedbackRevision = 1
  const common = {
    businessLineId: 'line-1', nodeId: 'node-1', feedbackId: 'feedback-current',
    feedbackRevision: 1, processingRoundNumber: 1, attachmentState: 'attached',
    retentionScope: 'business_line', retentionSource: 'node_feedback', storageStatus: 'available',
    size: 1, purgedAt: null, purgeDueAt: null
  }
  data.evidences = [
    { _id: 'evidence-a', ...common, feedbackEvidenceOrder: 1 },
    { _id: 'evidence-b', ...common, feedbackEvidenceOrder: 0 }
  ]
  const { repository } = createFeedbackHarness({ seed: data })

  const result = await repository.getCurrentProcessingRoundDraft({
    actor: { _id: 'account-a', status: 'active' },
    businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4
  })

  assert.deepEqual(result.evidenceIds, ['evidence-b', 'evidence-a'])
})

test('当前处理轮草稿拒绝跨轮次、错误归属和超过20MB的凭证集合', async () => {
  const data = reviewWorkflowSeed()
  data.node_feedback = [{
    _id: 'feedback-current', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published',
    revision: 1, status: 'in_progress', action: 'save_progress', processingRoundNumber: 1,
    submittedBy: 'account-a', submittedAt: NOW, fieldValues: []
  }]
  data.business_nodes[0].latestFeedbackId = 'feedback-current'
  data.business_nodes[0].latestFeedbackRevision = 1
  data.evidences = [{
    _id: 'evidence-large', businessLineId: 'line-1', nodeId: 'node-1', feedbackId: 'feedback-current',
    feedbackRevision: 1, processingRoundNumber: 1, attachmentState: 'attached',
    retentionScope: 'business_line', retentionSource: 'node_feedback', storageStatus: 'available',
    size: 20 * 1024 * 1024 + 1, purgedAt: null, purgeDueAt: null
  }, {
    _id: 'evidence-wrong-round', businessLineId: 'line-1', nodeId: 'node-1', feedbackId: 'feedback-current',
    feedbackRevision: 1, processingRoundNumber: 2, attachmentState: 'attached',
    retentionScope: 'business_line', retentionSource: 'node_feedback', storageStatus: 'available',
    size: 1, purgedAt: null, purgeDueAt: null
  }]
  const { repository } = createFeedbackHarness({ seed: data })

  await assert.rejects(
    repository.getCurrentProcessingRoundDraft({
      actor: { _id: 'account-a', status: 'active' },
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4
    }),
    error => error.code === 'EVIDENCE_NOT_ATTACHABLE'
  )

  data.evidences = [data.evidences[0]]
  const overLimit = createFeedbackHarness({ seed: data }).repository
  await assert.rejects(
    overLimit.getCurrentProcessingRoundDraft({
      actor: { _id: 'account-a', status: 'active' },
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4
    }),
    error => error.code === 'FEEDBACK_TOTAL_TOO_LARGE'
  )
})
