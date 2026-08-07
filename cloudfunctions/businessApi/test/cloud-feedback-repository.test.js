const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createFeedbackHarness, createOptimisticFeedbackHarness, seed, submission, NOW
} = require('./helpers/feedback-harness')

test('completion claims more than one transaction of tiny evidence without a count cap', async () => {
  const evidenceIds = Array.from({ length: 105 }, (_, index) => `evidence-${index + 1}`)
  const { fake, repository } = createFeedbackHarness({ evidenceCount: 105 })
  const result = await repository.commitFeedback(submission({ evidenceIds, evidenceTotalBytes: 105 }))

  assert.deepEqual(result, { feedbackId: result.feedbackId, revision: 1, nodeStatus: 'completed', lineStatus: 'active' })
  const [feedback] = fake.documents('node_feedback')
  assert.equal(feedback.publishState, 'published')
  assert.equal(feedback.evidenceCount, 105)
  assert.equal(feedback.evidenceTotalBytes, 105)
  assert.equal(Object.hasOwn(feedback, 'evidenceIds'), false)
  assert.equal(fake.documents('evidences').every(item => item.feedbackId === feedback._id && item.attachmentState === 'attached'), true)
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

  const finalSeed = seed({ evidenceCount: 0 })
  finalSeed.business_lines[0].nodeCount = 1
  finalSeed.business_nodes = [finalSeed.business_nodes[0]]
  const finalHarness = createFeedbackHarness({ seed: finalSeed })
  const finalValue = submission({ input: { requestKey: 'final-retry' } })
  const finalResult = await finalHarness.repository.commitFeedback(finalValue)
  assert.deepEqual(await finalHarness.repository.findPublishedFeedback(finalValue), finalResult)
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
  }
})

test('new feedback history includes only evidence attached to the exact published revision', async () => {
  const data = seed({ evidenceCount: 4 })
  data.node_feedback = [{
    _id: 'new', businessLineId: 'line-1', nodeId: 'node-1', publishState: 'published',
    revision: 2, status: 'blocked', comment: '', submittedBy: 'account-a', submittedAt: NOW
  }]
  Object.assign(data.evidences[0], { feedbackId: 'new', feedbackRevision: 2, attachmentState: 'attached' })
  Object.assign(data.evidences[1], { feedbackId: 'new', feedbackRevision: 999, attachmentState: 'attached' })
  Object.assign(data.evidences[2], { feedbackId: 'new', attachmentState: 'attached' })
  Object.assign(data.evidences[3], { feedbackId: 'new', feedbackRevision: 1, attachmentState: 'attached' })
  const { repository } = createFeedbackHarness({ seed: data })
  const result = await repository.getNodeHistory({ actor: { _id: 'manager' }, businessLineId: 'line-1', nodeId: 'node-1' })

  assert.deepEqual(result.history[0].evidences.map(item => item.evidenceId), ['evidence-1'])
})
