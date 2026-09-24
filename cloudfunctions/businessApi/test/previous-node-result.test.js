const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { fieldSource } = require('./helpers/field-fixtures')
const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createPreviousNodeResultRepository } = require('../lib/previous-node-result-repository')
const { createCloudFeedbackRepository } = require('../lib/cloud-feedback-repository')

function setup(reviewed = true, options = {}) {
  const source = fieldSource({ reviewed })
  const actor = { _id: 'downstream', role: 'user', status: 'active' }
  source.line.memberUserIds.push(actor._id)
  const anchor = { ...source.node, _id: 'next-node', nodeCode: 'NEXT', status: 'ready', routeState: 'active', sequence: 1 }
  const fake = createFakeCloudDatabase({ users: [actor], business_lines: [source.line], business_nodes: [source.node, anchor],
    node_feedback: [source.feedback], node_review_rounds: source.round ? [source.round] : [], node_review_votes: source.votes }, options)
  const repository = createPreviousNodeResultRepository({ db: fake.db, businessRepository: createCloudBusinessRepository({ db: fake.db }) })
  const input = { actor, businessLineId: source.line._id, nodeId: source.node._id, anchorNodeId: anchor._id }
  return { repository, fake, source, actor, input, anchor }
}

test('a downstream member reads final approved fields/comment/actual submitter and votes without gaining operations', async () => {
  const { repository, input, fake } = setup()
  const result = await repository.getPreviousNodeResult(input)
  assert.equal(result.processingComment, '合成处理说明')
  assert.equal(result.processorDisplayName, '合成处理人二')
  assert.equal(result.fieldValues.find(f => f.fieldKey === 'amount').value, 0)
  assert.equal(result.fieldValues.find(f => f.fieldKey === 'confirmed').value, false)
  assert.equal(result.votes[0].decision, 'approved')
  assert.equal(JSON.stringify(result).includes('processor-2'), false)
  assert.equal(result.canApprove, undefined)
  assert.deepEqual(fake.writeCalls, [])
  assert.equal(fake.transactionQueries.length, 0)
})

test('a direct completion uses final feedback, not a fabricated review', async () => {
  const { repository, input } = setup(false)
  const result = await repository.getPreviousNodeResult(input)
  assert.equal(result.processorDisplayName, '合成处理人一')
  assert.deepEqual(result.votes, [])
  assert.equal(result.reviewRequired, false)
})

for (const change of ['same-node', 'other-line', 'skipped', 'not-completed', 'not-traversed', 'non-member', 'disabled', 'invalid-final']) {
  test(`final result denies ${change}`, async () => {
    const { repository, input, fake, source, actor, anchor } = setup()
    if (change === 'same-node') input.anchorNodeId = input.nodeId
    if (change === 'other-line') fake.replace('business_nodes', anchor._id, { ...anchor, businessLineId: 'elsewhere' })
    if (change === 'skipped') fake.replace('business_nodes', source.node._id, { ...source.node, routeState: 'skipped' })
    if (change === 'not-completed') fake.replace('business_nodes', source.node._id, { ...source.node, status: 'in_progress' })
    if (change === 'not-traversed') fake.replace('business_lines', source.line._id, { ...source.line, traversedNodeIds: [] })
    if (change === 'non-member') fake.replace('business_lines', source.line._id, { ...source.line, memberUserIds: ['processor-1'] })
    if (change === 'disabled') fake.replace('users', actor._id, { ...actor, status: 'disabled' })
    if (change === 'invalid-final') fake.replace('node_review_rounds', source.round._id, { ...source.round, status: 'rejected' })
    await assert.rejects(repository.getPreviousNodeResult(input))
  })
}

test('membership revoked after query reads is rechecked before returning sensitive content', async () => {
  let fake, actor
  const h = setup(true, { transformRead({ collection, data }) {
    if (collection === 'node_review_votes' && fake) fake.replace('users', actor._id, { ...actor, status: 'disabled' })
    return data
  } })
  ;({ fake, actor } = h)
  await assert.rejects(h.repository.getPreviousNodeResult(h.input), { code: 'FORBIDDEN' })
})

test('final evidence comes from the entire approved snapshot, including earlier saves in that round', async () => {
  const { repository, input, fake, source } = setup()
  const earlier = { ...source.feedback, _id: 'earlier-feedback', revision: 1 }
  fake.replace('node_feedback', earlier._id, earlier)
  fake.replace('node_review_rounds', source.round._id, { ...source.round, evidenceIds: ['old-evidence', 'new-evidence'] })
  for (const [id, feedback] of [['old-evidence', earlier], ['new-evidence', source.feedback]]) {
    fake.replace('evidences', id, { _id: id, businessLineId: source.line._id, nodeId: source.node._id,
      feedbackId: feedback._id, feedbackRevision: feedback.revision, attachmentState: 'attached',
      fileName: `${id}.jpg`, category: 'image', extension: 'jpg', size: 100,
      storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'node_feedback',
      retentionStartedAt: new Date('2026-09-10'), purgeDueAt: new Date('2026-11-09') })
  }
  const result = await repository.getPreviousNodeResult(input)
  assert.deepEqual(result.evidences.map(e => e.evidenceId), ['old-evidence', 'new-evidence'])
})

test('unrelated super administrator cannot use global card visibility to read private final fields', async () => {
  const { repository, input, fake, source, actor } = setup()
  fake.replace('users', actor._id, { ...actor, role: 'super_admin' })
  fake.replace('business_lines', source.line._id, { ...source.line, memberUserIds: ['processor-1'] })
  await assert.rejects(repository.getPreviousNodeResult(input), { code: 'FORBIDDEN' })
})

test('a node whose template sequence is later can still precede the current node on the actual route', async () => {
  const { repository, input, fake, source } = setup()
  fake.replace('business_nodes', source.node._id, { ...source.node, sequence: 30 })
  assert.equal((await repository.getPreviousNodeResult(input)).nodeId, source.node._id)
})

test('votes with invalid stored comments are not silently presented as valid approval content', async () => {
  const { repository, input, fake, source } = setup()
  fake.replace('node_review_votes', source.votes[0]._id, { ...source.votes[0], comment: { private: 'invalid' } })
  await assert.rejects(repository.getPreviousNodeResult(input), { code: 'NODE_RESULT_UNAVAILABLE' })
})

test('a damaged processing comment is not silently replaced with an empty final result', async () => {
  const { repository, input, fake, source } = setup()
  fake.replace('node_review_rounds', source.round._id, { ...source.round, processingComment: { invalid: true } })
  await assert.rejects(repository.getPreviousNodeResult(input), { code: 'NODE_RESULT_UNAVAILABLE' })
})

test('historical feedback is reauthorized after its slow queries finish', async () => {
  let fake, actor
  const h = setup(true, { transformRead({ collection, data }) {
    if (collection === 'node_feedback' && fake) fake.replace('users', actor._id, { ...actor, status: 'disabled' })
    return data
  } })
  ;({ fake, actor } = h)
  const feedback = createCloudFeedbackRepository({ db: fake.db })
  await assert.rejects(feedback.getNodeHistory(h.input), { code: 'FORBIDDEN' })
})

test('historical save author uses the immutable node assignment snapshot, not a current account lookup', async () => {
  const { fake, input } = setup()
  const result = await createCloudFeedbackRepository({ db: fake.db }).getNodeHistory(input)
  assert.equal(result.history[0].submittedByLabel, '合成处理人一')
})

for (const count of [94, 1001]) test(`final evidence reads ${count} files without a business count cap or transactions over 100 operations`, async () => {
  const { repository, input, fake, source } = setup()
  const earlier = { ...source.feedback, _id: 'earlier-feedback', revision: 1 }
  fake.replace('node_feedback', earlier._id, earlier)
  const evidenceIds = Array.from({ length: count }, (_, i) => `e-${i}`)
  // 94 files use distinct owners (worst transaction budget); 1001 share one.
  const finalRevision = count === 94 ? 95 : source.feedback.revision
  fake.replace('business_nodes', source.node._id, { ...source.node, latestFeedbackRevision: finalRevision })
  fake.replace('node_feedback', source.feedback._id, { ...source.feedback, revision: finalRevision })
  fake.replace('node_review_rounds', source.round._id, { ...source.round, evidenceIds, feedbackRevision: finalRevision })
  for (const [index, id] of evidenceIds.entries()) {
    const owner = count === 94 ? { ...earlier, _id: `owner-${index}`, revision: index + 1 } : earlier
    if (count === 94) fake.replace('node_feedback', owner._id, owner)
    fake.replace('evidences', id, {
    _id: id, businessLineId: source.line._id, nodeId: source.node._id, feedbackId: owner._id, feedbackRevision: owner.revision,
    attachmentState: 'attached', storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'node_feedback',
    category: 'image', fileName: 'synthetic.jpg', size: 100
  })
  }
  const result = await repository.getPreviousNodeResult(input)
  assert.equal(result.evidences.length, count)
  assert.ok(fake.transactionRuns.every(run => run.operations <= 100), Math.max(...fake.transactionRuns.map(run => run.operations)))
  assert.deepEqual(fake.writeCalls, [])
})
