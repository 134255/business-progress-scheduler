const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createCloudReviewRepository } = require('../lib/cloud-review-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const NOW = new Date('2026-08-11T03:00:00.000Z')

function seed(overrides = {}) {
  return {
    users: overrides.users || [
      { _id: 'processor-1', status: 'active', displayName: '处理人一' },
      { _id: 'manager-1', status: 'active', displayName: '管理员一' },
      { _id: 'reviewer-1', status: 'active', displayName: '审核人一' },
      { _id: 'reviewer-2', status: 'active', displayName: '审核人二' }
    ],
    business_lines: overrides.lines || [{
      _id: 'line-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerUserIds: ['manager-1'], memberUserIds: ['processor-1', 'reviewer-1', 'reviewer-2'], version: 1
    }],
    business_nodes: overrides.nodes || [{
      _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-20260811-0001-N001',
      name: '资料收集', sequence: 0, status: 'in_progress', version: 4,
      workflowMode: 'review', processorUserIds: ['processor-1'],
      processorAssignmentMode: 'fixed_accounts',
      reviewerUserIds: ['reviewer-1', 'reviewer-2'], reviewMode: 'all',
      processingRoundNumber: 1, reviewRoundNumber: 0,
      processingStartedAt: new Date('2026-08-11T01:00:00.000Z'),
      processingElapsedWorkMinutes: 0,
      processingSlaWorkHours: 22, reviewSlaWorkHours: 8,
      latestFeedbackId: 'feedback-current', latestFeedbackRevision: 2
    }],
    node_feedback: overrides.feedback || [{
      _id: 'feedback-current', businessLineId: 'line-1', nodeId: 'node-1',
      publishState: 'published', revision: 2, processingRoundNumber: 1,
      action: 'save_progress', submittedBy: 'processor-1', comment: '处理说明快照'
    }],
    node_review_rounds: overrides.rounds || [],
    notifications: overrides.notifications || [],
    audit_logs: overrides.audit || []
  }
}

function request(overrides = {}) {
  const requestKeyHash = crypto.createHash('sha256').update('request').digest('hex')
  const inputHash = crypto.createHash('sha256').update('input').digest('hex')
  const draftHash = crypto.createHash('sha256').update('draft').digest('hex')
  return {
    actor: { _id: 'processor-1', status: 'active' },
    input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4,
      requestKey: 'must-not-be-stored'
    },
    draft: {
      feedbackId: 'feedback-current', feedbackRevision: 2, processingRoundNumber: 1,
      processingComment: '处理说明快照',
      fieldSnapshots: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '完成' }],
      evidenceIds: ['evidence-a', 'evidence-b'], evidenceTotalBytes: 1024
    },
    timing: {
      processingTimingStatus: 'calculated', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      processingCalendarVersion: 'calendar-a', reviewStartedAt: NOW,
      processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 120,
      processingRoundCalendarVersion: 'calendar-a',
      processingRoundStartedAt: new Date('2026-08-11T01:00:00.000Z'),
      processingRoundEndedAt: NOW,
      reviewRemainingWorkMinutes: 480, reviewElapsedWorkMinutes: 0,
      reviewOverdueWorkMinutes: 0, reviewDueStatus: 'calculated',
      reviewDueAt: new Date('2026-08-12T06:00:00.000Z'), reviewCalendarVersion: 'calendar-a'
    },
    requestKeyHash,
    inputHash,
    draftHash,
    ...overrides
  }
}

function retryValue(value) {
  const { requestKey: ignoredRequestKey, ...safeInput } = value.input
  const draftHash = crypto.createHash('sha256').update(JSON.stringify([
    value.actor._id, safeInput.businessLineId, safeInput.nodeId, safeInput.expectedNodeVersion,
    value.draft.feedbackId, value.draft.feedbackRevision, value.draft.processingRoundNumber,
    value.draft.processingComment, value.draft.fieldSnapshots,
    value.draft.evidenceIds, value.draft.evidenceTotalBytes
  ])).digest('hex')
  return {
    actor: value.actor, input: safeInput, requestKeyHash: value.requestKeyHash,
    inputHash: value.inputHash, draft: value.draft, draftHash,
    reviewRoundId: `review-${value.draft.feedbackId}`
  }
}

function harness(overrides = {}) {
  const fake = createFakeCloudDatabase(overrides.seed || seed(overrides), {
    transformRead: overrides.transformRead,
    afterTransaction: overrides.afterTransaction
  })
  const repository = createCloudReviewRepository({ db: fake.db, clock: () => new Date(NOW) })
  return { fake, repository }
}

function votingSeed({ mode = 'all', terminal = false } = {}) {
  const data = seed()
  data.business_lines[0] = {
    ...data.business_lines[0],
    nodeCount: terminal ? 1 : 2,
    currentNodeId: 'node-1',
    currentNodeName: '资料收集'
  }
  data.business_nodes[0] = {
    ...data.business_nodes[0],
    status: 'pending_review', version: 5, reviewMode: mode,
    reviewRoundNumber: 1, activeReviewRoundId: 'review-feedback-current',
    processingStartedAt: new Date('2026-08-11T01:00:00.000Z'),
    processingTimingStatus: 'calculated', processingElapsedWorkMinutes: 120,
    processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
    processingCalendarVersion: 'calendar-a',
    reviewStartedAt: NOW, reviewDueStatus: 'calculated',
    reviewDueAt: new Date('2026-08-12T06:00:00.000Z'), reviewCalendarVersion: 'calendar-a'
  }
  if (!terminal) {
    data.business_nodes.push({
      _id: 'line-1-node-002', businessLineId: 'line-1',
      nodeCode: 'BL-20260811-0001-N002', name: '资料审核', sequence: 1,
      status: 'waiting', version: 1, workflowMode: 'review',
      processorUserIds: ['processor-1'], reviewerUserIds: ['reviewer-1'],
      reviewMode: 'any', processingRoundNumber: 1, reviewRoundNumber: 0,
      processingSlaWorkHours: 22, reviewSlaWorkHours: 8
    })
  }
  data.node_review_rounds = [{
    _id: 'review-feedback-current', businessLineId: 'line-1', nodeId: 'node-1',
    nodeCode: 'BL-20260811-0001-N001', nodeName: '资料收集',
    processingRoundNumber: 1, reviewRoundNumber: 1, reviewMode: mode,
    reviewerUserIds: ['reviewer-1', 'reviewer-2'], status: 'pending',
    processorDisplayNames: ['处理人一'], reviewerDisplayNames: ['审核人一', '审核人二'],
    submittedBy: 'processor-1', submittedNodeVersion: 4, lockedNodeVersion: 5,
    feedbackId: 'feedback-current', feedbackRevision: 2,
    processingComment: '处理说明快照',
    fieldValues: [], evidenceIds: [], evidenceTotalBytes: 0,
    processingTimingStatus: 'calculated', processingElapsedWorkMinutes: 120,
    processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
    reviewSlaWorkHours: 8, reviewStartedAt: NOW, reviewDueStatus: 'calculated',
    reviewDueAt: new Date('2026-08-12T06:00:00.000Z'),
    reviewElapsedWorkMinutes: 0, reviewRemainingWorkMinutes: 480,
    reviewOverdueWorkMinutes: 0, reviewCalendarVersion: 'calendar-a',
    approvedVoteCount: 0, voteCount: 0, version: 1
  }]
  data.node_review_votes = []
  return data
}

function voteRequest(actorId, overrides = {}) {
  const input = {
    reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
    decision: 'approve', comment: '', ...overrides.input
  }
  const requestKey = overrides.requestKey || `vote-${actorId}`
  const defaultContext = {
    businessLineId: 'line-1', nodeId: 'node-1', transition: 'next_node',
    nextNodeId: 'line-1-node-002', nextNodeVersion: 1,
    processingWorkMinutes: 1320, nodeVersion: 5, roundVersion: 1,
    reviewStartedAt: NOW, reviewTotalWorkMinutes: 480,
    reviewBaseElapsedWorkMinutes: 0
  }
  const defaultTiming = {
    transitionAt: NOW, processingDueStatus: 'calculated',
    processingDueAt: new Date('2026-08-13T03:00:00.000Z'),
    processingCalendarVersion: 'calendar-a',
    reviewTimingStatus: 'calculated', reviewElapsedWorkMinutes: 120,
    reviewRemainingWorkMinutes: 360, reviewOverdueWorkMinutes: 0,
    reviewCalendarVersion: 'calendar-a',
    reviewResponseTimingStatus: 'calculated', reviewResponseWorkMinutes: 120,
    reviewResponseCalendarVersion: 'calendar-a',
    reviewResponseStartedAt: NOW, reviewResponseEndedAt: NOW
  }
  return {
    actor: { _id: actorId, status: 'active' },
    input,
    context: { ...defaultContext, ...(overrides.context || {}) },
    timing: { ...defaultTiming, ...(overrides.timing || {}) },
    requestKeyHash: crypto.createHash('sha256').update(requestKey).digest('hex'),
    inputHash: crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')
  }
}

test('提交审核在一个事务内创建轮次、锁定节点并写确定性通知和审计', async () => {
  const { fake, repository } = harness()
  const result = await repository.createReviewRound(request())

  assert.deepEqual(result, {
    reviewRoundId: 'review-feedback-current', status: 'pending', nodeStatus: 'pending_review',
    evidenceIds: ['evidence-a', 'evidence-b']
  })
  const [round] = fake.documents('node_review_rounds')
  assert.equal(round._id, 'review-feedback-current')
  assert.equal(round.processingRoundNumber, 1)
  assert.equal(round.reviewRoundNumber, 1)
  assert.deepEqual(round.reviewerUserIds, ['reviewer-1', 'reviewer-2'])
  assert.deepEqual(round.fieldValues, request().draft.fieldSnapshots)
  assert.equal(round.processingComment, '处理说明快照')
  assert.equal(round.requestKeyHash, request().requestKeyHash)
  assert.equal(round.processingTimingStatus, 'calculated')
  assert.equal(round.processingElapsedWorkMinutes, 120)
  assert.equal(round.processingRemainingWorkMinutes, 1200)
  assert.equal(round.processingOverdueWorkMinutes, 0)
  assert.equal(round.processingCalendarVersion, 'calendar-a')
  assert.equal(round.submittedByDisplayName, '处理人一')
  assert.equal(round.processorAssignmentMode, 'fixed_accounts')
  assert.equal(round.processingRoundTimingStatus, 'calculated')
  assert.equal(round.processingRoundWorkMinutes, 120)
  assert.equal(round.processingRoundCalendarVersion, 'calendar-a')
  assert.deepEqual(round.processingRoundStartedAt, new Date('2026-08-11T01:00:00.000Z'))
  assert.deepEqual(round.processingRoundEndedAt, NOW)
  assert.equal(JSON.stringify(round).includes('must-not-be-stored'), false)
  const [node] = fake.documents('business_nodes')
  assert.equal(node.status, 'pending_review')
  assert.equal(node.activeReviewRoundId, round._id)
  assert.equal(node.version, 5)
  assert.equal(fake.documents('notifications').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.transactionRuns.length, 1)
  assert.equal(fake.transactionRuns[0].operations <= 100, true)
})

test('多候选处理节点只把本轮处理时间归属给实际提交人', async () => {
  const data = seed()
  data.users.push({ _id: 'processor-2', status: 'active', displayName: '处理人二' })
  data.business_lines[0].memberUserIds.push('processor-2')
  data.business_nodes[0].processorUserIds = ['processor-1', 'processor-2']
  data.node_feedback[0].submittedBy = 'processor-2'
  const { fake, repository } = harness({ seed: data })
  const value = request({ actor: { _id: 'processor-2', status: 'active' } })

  await repository.createReviewRound(value)

  const [round] = fake.documents('node_review_rounds')
  assert.equal(round.submittedBy, 'processor-2')
  assert.equal(round.submittedByDisplayName, '处理人二')
  assert.deepEqual(round.processorDisplayNames, ['处理人一', '处理人二'])
  assert.equal(round.processingRoundWorkMinutes, 120)
})

test('驳回后的第二轮归属第二次实际提交人且第一轮快照保持不变', async () => {
  const data = seed()
  data.users.push({ _id: 'processor-2', status: 'active', displayName: '处理人二' })
  data.business_lines[0].memberUserIds.push('processor-2')
  data.business_nodes[0] = {
    ...data.business_nodes[0], version: 6, processorUserIds: ['processor-1', 'processor-2'],
    processingRoundNumber: 2, reviewRoundNumber: 1,
    processingStartedAt: new Date('2026-08-11T04:00:00.000Z'),
    processingElapsedWorkMinutes: 120,
    latestFeedbackId: 'feedback-second', latestFeedbackRevision: 1
  }
  data.node_feedback = [{
    _id: 'feedback-second', businessLineId: 'line-1', nodeId: 'node-1',
    publishState: 'published', revision: 1, processingRoundNumber: 2,
    action: 'save_progress', submittedBy: 'processor-2', comment: '第二轮说明'
  }]
  data.node_review_rounds = [{
    _id: 'review-first', businessLineId: 'line-1', nodeId: 'node-1', status: 'rejected',
    submittedBy: 'processor-1', submittedByDisplayName: '处理人一',
    processorAssignmentMode: 'fixed_accounts', processingRoundNumber: 1,
    processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 120,
    processingRoundCalendarVersion: 'calendar-a',
    processingRoundStartedAt: new Date('2026-08-11T01:00:00.000Z'),
    processingRoundEndedAt: new Date('2026-08-11T03:00:00.000Z')
  }]
  const firstRoundBefore = structuredClone(data.node_review_rounds[0])
  const { fake, repository } = harness({ seed: data })
  const value = request({
    actor: { _id: 'processor-2', status: 'active' },
    input: { businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 6 },
    draft: {
      feedbackId: 'feedback-second', feedbackRevision: 1, processingRoundNumber: 2,
      processingComment: '第二轮说明', fieldSnapshots: [], evidenceIds: [], evidenceTotalBytes: 0
    },
    timing: {
      ...request().timing,
      processingElapsedWorkMinutes: 180, processingRemainingWorkMinutes: 1140,
      processingRoundWorkMinutes: 60,
      processingRoundStartedAt: new Date('2026-08-11T04:00:00.000Z'),
      processingRoundEndedAt: new Date('2026-08-11T05:00:00.000Z'),
      reviewStartedAt: new Date('2026-08-11T05:00:00.000Z')
    }
  })

  await repository.createReviewRound(value)

  const rounds = fake.documents('node_review_rounds')
  assert.deepEqual(rounds.find(round => round._id === 'review-first'), firstRoundBefore)
  const secondRound = rounds.find(round => round._id === 'review-feedback-second')
  assert.equal(secondRound.submittedBy, 'processor-2')
  assert.equal(secondRound.submittedByDisplayName, '处理人二')
  assert.equal(secondRound.processingRoundNumber, 2)
  assert.equal(secondRound.processingRoundWorkMinutes, 60)
})

test('待我审核列表只返回当前审核人真实待办并稳定投影已投会签状态', async () => {
  const data = votingSeed({ mode: 'all' })
  data.business_lines[0].code = 'BL-20260811-0001'
  data.business_lines[0].name = '安全测试业务'
  data.node_review_rounds.push({
    ...structuredClone(data.node_review_rounds[0]),
    _id: 'review-foreign', reviewerUserIds: ['reviewer-2'], createdAt: new Date('2026-08-11T04:00:00.000Z')
  })
  data.node_review_rounds[0].createdAt = new Date('2026-08-11T03:00:00.000Z')
  const voteId = `review-vote-${crypto.createHash('sha256')
    .update('review-feedback-current\0reviewer-1').digest('hex')}`
  data.node_review_votes = [{
    _id: voteId, reviewRoundId: 'review-feedback-current', businessLineId: 'line-1',
    nodeId: 'node-1', reviewerUserId: 'reviewer-1', reviewerDisplayName: '审核人一',
    decision: 'approved', comment: '', expectedRoundVersion: 1,
    requestKeyHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), createdAt: NOW
  }]
  const { fake, repository } = harness({ seed: data })

  const result = await repository.listPendingReviews({
    actor: { _id: 'reviewer-1', status: 'active' }, query: { page: 1, pageSize: 20 }
  })

  assert.equal(result.items.length, 1)
  assert.deepEqual(result.items[0], {
    reviewRoundId: 'review-feedback-current', businessLineId: 'line-1',
    businessCode: 'BL-20260811-0001', businessName: '安全测试业务',
    nodeId: 'node-1', nodeCode: 'BL-20260811-0001-N001', nodeName: '资料收集',
    reviewMode: 'all', reviewRoundNumber: 1, status: 'pending',
    reviewDueStatus: 'calculated', reviewDueAt: new Date('2026-08-12T06:00:00.000Z'),
    reviewOverdueWorkMinutes: 0, hasVoted: true, canApprove: false, canReject: false,
    createdAt: new Date('2026-08-11T03:00:00.000Z')
  })
})

test('待办候选初验后撤销成员或审核人关系时最终结果不再返回', async () => {
  for (const field of ['memberUserIds', 'reviewerUserIds']) {
    const data = votingSeed({ mode: 'all' })
    let fake
    let mutated = false
    const built = harness({
      seed: data,
      afterTransaction() {
        if (mutated) return
        mutated = true
        const collection = field === 'memberUserIds' ? 'business_lines' : 'business_nodes'
        const id = field === 'memberUserIds' ? 'line-1' : 'node-1'
        const current = fake.documents(collection).find(item => item._id === id)
        fake.replace(collection, id, { ...current, [field]: current[field].filter(value => value !== 'reviewer-1') })
      }
    })
    fake = built.fake

    const result = await built.repository.listPendingReviews({
      actor: { _id: 'reviewer-1' }, query: { page: 1, pageSize: 20 }
    })

    assert.deepEqual(result.items, [], field)
  }
})

test('审核详情只允许当前审核人、业务管理员或超级管理员并返回最小安全投影', async () => {
  const data = votingSeed({ mode: 'all' })
  data.users.push({ _id: 'root-1', status: 'active', role: 'super_admin', displayName: '总管理员' })
  data.business_lines[0].code = 'BL-20260811-0001'
  data.business_lines[0].name = '安全测试业务'
  data.node_review_rounds[0].fieldValues = [{
    fieldKey: 'summary', name: '摘要', type: 'short_text', value: '仅业务内容',
    constraints: { maxLength: 100 }, internalHash: 'field-secret'
  }]
  data.node_review_rounds[0].evidenceIds = ['evidence-a']
  data.evidences = [{
    _id: 'evidence-a', businessLineId: 'line-1', nodeId: 'node-1',
    fileId: 'cloud://secret', sha256: 'secret-hash', size: 999, reservationId: 'secret-reservation'
  }]
  data.node_review_votes = [{
    _id: 'vote-a', reviewRoundId: 'review-feedback-current', businessLineId: 'line-1',
    nodeId: 'node-1', reviewerUserId: 'reviewer-2', reviewerDisplayName: '审核人二',
    decision: 'approved', comment: '同意', requestKeyHash: 'secret-request', inputHash: 'secret-input',
    createdAt: NOW
  }]
  const { repository } = harness({ seed: data })

  const detail = await repository.getReviewDetail({
    actor: { _id: 'reviewer-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  })
  assert.deepEqual(detail.fieldValues, [{
    fieldKey: 'summary', name: '摘要', type: 'short_text', value: '仅业务内容'
  }])
  assert.equal(detail.processingComment, '处理说明快照')
  assert.deepEqual(detail.evidences, [{ evidenceId: 'evidence-a' }])
  assert.deepEqual(detail.votes, [{
    reviewerDisplayName: '审核人二', decision: 'approved', createdAt: NOW
  }])
  assert.equal(detail.canApprove, true)
  assert.equal(detail.canReject, true)
  assert.equal(detail.version, 1, '客户端提交投票必须使用服务端审核轮次版本')
  assert.equal(detail.submittedAt.toISOString(), NOW.toISOString(), '审核详情必须显示服务端提交审核时间')
  assert.deepEqual(detail.processorDisplayNames, ['处理人一'])
  assert.deepEqual(detail.reviewerDisplayNames, ['审核人一', '审核人二'])
  assert.doesNotMatch(JSON.stringify(detail), /cloud:\/\/|secret-hash|secret-request|reservation|999/)

  await assert.rejects(repository.getReviewDetail({
    actor: { _id: 'processor-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  }), error => error.code === 'FORBIDDEN')
  assert.equal((await repository.getReviewDetail({
    actor: { _id: 'manager-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  })).reviewRoundId, 'review-feedback-current')
  const rootDetail = await repository.getReviewDetail({
    actor: { _id: 'root-1', status: 'active', role: 'super_admin' }, reviewRoundId: 'review-feedback-current'
  })
  assert.equal(rootDetail.reviewRoundId, 'review-feedback-current')
  assert.deepEqual(rootDetail.processorDisplayNames, ['处理人一'])
  assert.deepEqual(rootDetail.reviewerDisplayNames, ['审核人一', '审核人二'])
  await assert.rejects(repository.getReviewDetail({
    actor: { _id: 'reviewer-1', status: 'active' }, reviewRoundId: 'missing-round'
  }), error => error.code === 'FORBIDDEN')
})

test('审核详情只对完全缺失的旧轮次兼容空处理说明并拒绝非法结构', async () => {
  const legacy = votingSeed({ mode: 'all' })
  delete legacy.node_review_rounds[0].processingComment
  const legacyRepository = harness({ seed: legacy }).repository
  const legacyDetail = await legacyRepository.getReviewDetail({
    actor: { _id: 'reviewer-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  })
  assert.equal(legacyDetail.processingComment, '')

  let getterCalls = 0
  const cases = [
    {
      name: '数字',
      transformRead({ collection, data }) {
        if (collection === 'node_review_rounds') data.processingComment = 7
        return data
      }
    },
    {
      name: '超长字符串',
      transformRead({ collection, data }) {
        if (collection === 'node_review_rounds') data.processingComment = 'x'.repeat(1001)
        return data
      }
    },
    {
      name: '访问器',
      transformRead({ collection, data }) {
        if (collection === 'node_review_rounds') {
          delete data.processingComment
          Object.defineProperty(data, 'processingComment', {
            get() { getterCalls += 1; return '不得读取' }
          })
        }
        return data
      }
    },
    {
      name: '继承属性',
      transformRead({ collection, data }) {
        if (collection === 'node_review_rounds') {
          delete data.processingComment
          Object.setPrototypeOf(data, { processingComment: '不得继承' })
        }
        return data
      }
    }
  ]
  for (const item of cases) {
    const { repository } = harness({ seed: votingSeed({ mode: 'all' }), transformRead: item.transformRead })
    await assert.rejects(repository.getReviewDetail({
      actor: { _id: 'reviewer-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
    }), error => error.code === 'FORBIDDEN', item.name)
  }
  assert.equal(getterCalls, 0)
})

test('审核轮次固化参与人显示名，历史参与人停用或改名不改变详情', async () => {
  const data = votingSeed({ mode: 'all' })
  data.business_lines[0].code = 'BL-20260811-0001'
  data.business_lines[0].name = '历史快照'
  data.node_review_rounds[0].processorDisplayNames = ['处理人一']
  data.node_review_rounds[0].reviewerDisplayNames = ['审核人一', '审核人二']
  data.users = data.users.map(user => user._id === 'reviewer-2'
    ? { ...user, status: 'disabled', displayName: '改名后的停用账号' }
    : user._id === 'processor-1'
      ? { ...user, displayName: '改名后的处理人' }
      : user)
  const { repository } = harness({ seed: data })

  const detail = await repository.getReviewDetail({
    actor: { _id: 'reviewer-1' }, reviewRoundId: 'review-feedback-current'
  })
  assert.deepEqual(detail.processorDisplayNames, ['处理人一'])
  assert.deepEqual(detail.reviewerDisplayNames, ['审核人一', '审核人二'])
})

test('旧审核轮次缺少显示名快照时使用固定安全占位且不泄漏账号编号', async () => {
  const data = votingSeed({ mode: 'all' })
  data.business_lines[0].code = 'BL-20260811-0001'
  data.business_lines[0].name = '旧轮次兼容'
  data.users = data.users.filter(user => user._id !== 'reviewer-2')
  delete data.node_review_rounds[0].processorDisplayNames
  delete data.node_review_rounds[0].reviewerDisplayNames
  const { repository } = harness({ seed: data })

  const detail = await repository.getReviewDetail({
    actor: { _id: 'reviewer-1' }, reviewRoundId: 'review-feedback-current'
  })
  assert.deepEqual(detail.processorDisplayNames, ['历史处理人'])
  assert.deepEqual(detail.reviewerDisplayNames, ['历史审核人', '历史审核人'])
  assert.doesNotMatch(JSON.stringify(detail), /processor-1|reviewer-1|reviewer-2/)
})

test('新审核轮次创建时固化处理人和审核人显示名', async () => {
  const { fake, repository } = harness()
  await repository.createReviewRound(request())
  const round = fake.documents('node_review_rounds')[0]

  assert.deepEqual(round.processorDisplayNames, ['处理人一'])
  assert.deepEqual(round.reviewerDisplayNames, ['审核人一', '审核人二'])
})

test('审核查询投影不泄漏凭据、OpenID、云文件编号、哈希、租约或请求摘要', async () => {
  const data = votingSeed({ mode: 'all' })
  data.business_lines[0].code = 'BL-20260811-0001'
  data.business_lines[0].name = '脱敏查询'
  Object.assign(data.node_review_rounds[0], {
    requestKeyHash: 'request-summary-secret', inputHash: 'input-summary-secret', draftHash: 'draft-summary-secret',
    reviewLeaseToken: 'review-lease-secret', reviewerOpenid: 'wx-review-secret'
  })
  data.node_review_rounds[0].evidenceIds = ['evidence-private']
  data.evidences = [{
    _id: 'evidence-private', businessLineId: 'line-1', nodeId: 'node-1',
    fileId: 'cloud://private-file-number', sha256: 'evidence-hash-secret',
    reservationLeaseToken: 'evidence-lease-secret', requestSummary: 'evidence-request-secret'
  }]
  data.node_review_votes = [{
    _id: 'vote-private', reviewRoundId: 'review-feedback-current', businessLineId: 'line-1', nodeId: 'node-1',
    reviewerUserId: 'reviewer-2', reviewerDisplayName: '审核人二', decision: 'approved', comment: '',
    requestKeyHash: 'vote-request-secret', inputHash: 'vote-input-secret', reviewerOpenid: 'wx-vote-secret', createdAt: NOW
  }]
  data.users = data.users.map(user => user._id === 'reviewer-1'
    ? { ...user, credentialHash: 'credential-secret', openid: 'wx-account-secret' }
    : user)
  const { repository } = harness({ seed: data })
  const detail = await repository.getReviewDetail({
    actor: { _id: 'reviewer-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  })
  const serialized = JSON.stringify(detail)
  for (const secret of [
    'credential-secret', 'wx-account-secret', 'wx-review-secret', 'wx-vote-secret', 'cloud://private-file-number',
    'evidence-hash-secret', 'review-lease-secret', 'evidence-lease-secret', 'request-summary-secret',
    'input-summary-secret', 'draft-summary-secret', 'evidence-request-secret', 'vote-request-secret', 'vote-input-secret'
  ]) assert.equal(serialized.includes(secret), false, secret)
})

test('审核详情按凭证编号投影全部合法凭证且不引入文件数量上限', async () => {
  const data = votingSeed({ mode: 'all' })
  data.business_lines[0].code = 'BL-20260811-0001'
  data.business_lines[0].name = '多凭证测试'
  data.node_review_rounds[0].evidenceIds = Array.from(
    { length: 101 }, (_, index) => `evidence-${String(index + 1).padStart(3, '0')}`
  )
  const { repository } = harness({ seed: data })

  const detail = await repository.getReviewDetail({
    actor: { _id: 'reviewer-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  })
  assert.equal(detail.evidences.length, 101)
  assert.deepEqual(detail.evidences[100], { evidenceId: 'evidence-101' })
})

test('通知查询和已读只作用于当前活动账号并隔离角色告警', async () => {
  const data = votingSeed({ mode: 'all' })
  data.users.push(
    { _id: 'root-1', status: 'active', role: 'super_admin' },
    { _id: 'member-1', status: 'active', role: 'user' }
  )
  data.notifications = [
    {
      _id: 'direct-reviewer', type: 'review_started', recipientUserIds: ['reviewer-1'],
      businessLineId: 'line-1', nodeId: 'node-1', reviewRoundId: 'review-feedback-current',
      status: 'unread', createdAt: new Date('2026-08-11T03:00:00.000Z'), secretBody: '不得返回'
    },
    {
      _id: 'direct-other', type: 'review_started', recipientUserIds: ['reviewer-2'],
      businessLineId: 'line-1', nodeId: 'node-1', reviewRoundId: 'review-feedback-current',
      status: 'unread', createdAt: new Date('2026-08-11T04:00:00.000Z')
    },
    {
      _id: 'role-warning', type: 'work_calendar_missing', audienceRole: 'super_admin',
      status: 'pending', createdAt: new Date('2026-08-11T05:00:00.000Z')
    }
  ]
  const { fake, repository } = harness({ seed: data })

  const reviewer = await repository.listNotifications({
    actor: { _id: 'reviewer-1', status: 'active', role: 'user' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(reviewer.items.map(item => item.notificationId), ['direct-reviewer'])
  assert.doesNotMatch(JSON.stringify(reviewer), /不得返回|recipientUserIds|audienceRole/)

  const root = await repository.listNotifications({
    actor: { _id: 'root-1', status: 'active', role: 'super_admin' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(root.items.map(item => item.notificationId), ['role-warning'])

  assert.deepEqual(await repository.markNotificationRead({
    actor: { _id: 'reviewer-1', status: 'active' }, notificationId: 'direct-reviewer'
  }), { notificationId: 'direct-reviewer', read: true })
  assert.equal(fake.documents('notifications').some(item =>
    item.type === 'notification_read_marker' && item.parentNotificationId === 'direct-reviewer' &&
    item.userId === 'reviewer-1'), true)
  await assert.rejects(repository.markNotificationRead({
    actor: { _id: 'reviewer-1', status: 'active' }, notificationId: 'direct-other'
  }), error => error.code === 'FORBIDDEN')
  await assert.rejects(repository.markNotificationRead({
    actor: { _id: 'member-1', status: 'active', role: 'user' }, notificationId: 'role-warning'
  }), error => error.code === 'FORBIDDEN')
})

test('处理与审核提醒按受众可见且未知通知类型保持隐藏', async () => {
  const data = votingSeed({ mode: 'all' })
  data.users.push(
    { _id: 'root-1', status: 'active', role: 'super_admin' },
    { _id: 'member-1', status: 'active', role: 'user' }
  )
  data.notifications = [
    {
      _id: 'processing-reminder', type: 'processing_reminder', recipientUserIds: ['processor-1'],
      businessLineId: 'line-1', nodeId: 'node-1', createdAt: new Date('2026-08-11T03:00:00.000Z')
    },
    {
      _id: 'review-reminder', type: 'review_reminder', recipientUserIds: ['reviewer-1'],
      businessLineId: 'line-1', nodeId: 'node-1', reviewRoundId: 'review-feedback-current',
      createdAt: new Date('2026-08-11T04:00:00.000Z')
    },
    {
      _id: 'role-review-reminder', type: 'review_reminder', audienceRole: 'super_admin',
      createdAt: new Date('2026-08-11T05:00:00.000Z')
    },
    {
      _id: 'unknown-reminder', type: 'credential_rotation', recipientUserIds: ['reviewer-1'],
      createdAt: new Date('2026-08-11T06:00:00.000Z')
    }
  ]
  const { repository } = harness({ seed: data })

  const processor = await repository.listNotifications({
    actor: { _id: 'processor-1' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(processor.items.map(item => item.notificationId), ['processing-reminder'])
  const reviewer = await repository.listNotifications({
    actor: { _id: 'reviewer-1' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(reviewer.items.map(item => item.notificationId), ['review-reminder'])
  const member = await repository.listNotifications({
    actor: { _id: 'member-1' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(member.items, [])
  const root = await repository.listNotifications({
    actor: { _id: 'root-1' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(root.items.map(item => item.notificationId), ['role-review-reminder'])
})

test('通知候选初验后撤销定向受众或超级管理员角色时最终结果不再返回', async () => {
  for (const variant of ['direct', 'role']) {
    const data = votingSeed({ mode: 'all' })
    const actorId = variant === 'direct' ? 'reviewer-1' : 'root-1'
    if (variant === 'role') data.users.push({ _id: actorId, status: 'active', role: 'super_admin' })
    data.notifications = [variant === 'direct'
      ? {
          _id: 'revoked-note', type: 'review_started', recipientUserIds: [actorId],
          createdAt: NOW
        }
      : {
          _id: 'revoked-note', type: 'work_calendar_missing', audienceRole: 'super_admin',
          createdAt: NOW
        }]
    let fake
    let mutated = false
    const built = harness({
      seed: data,
      afterTransaction() {
        if (mutated) return
        mutated = true
        if (variant === 'direct') {
          const note = fake.documents('notifications').find(item => item._id === 'revoked-note')
          fake.replace('notifications', 'revoked-note', { ...note, recipientUserIds: ['reviewer-2'] })
        } else {
          const account = fake.documents('users').find(item => item._id === actorId)
          fake.replace('users', actorId, { ...account, role: 'user' })
        }
      }
    })
    fake = built.fake

    const result = await built.repository.listNotifications({
      actor: { _id: actorId }, query: { page: 1, pageSize: 20 }
    })

    assert.deepEqual(result.items, [], variant)
  }
})

test('角色通知使用每账号确定性已读回执且第51个管理员仍可正常标记', async () => {
  const data = votingSeed({ mode: 'all' })
  data.users.push(...Array.from({ length: 51 }, (_, index) => ({
    _id: `root-${index + 1}`, status: 'active', role: 'super_admin'
  })))
  data.notifications = [{
    _id: 'role-warning', type: 'work_calendar_missing', audienceRole: 'super_admin',
    status: 'pending', createdAt: NOW
  }]
  const { fake, repository } = harness({ seed: data })

  for (let index = 1; index <= 51; index += 1) {
    assert.deepEqual(await repository.markNotificationRead({
      actor: { _id: `root-${index}`, status: 'active' }, notificationId: 'role-warning'
    }), { notificationId: 'role-warning', read: true })
  }
  assert.equal(fake.documents('notifications').filter(item =>
    item.type === 'notification_read_marker').length, 51)
  const last = await repository.listNotifications({
    actor: { _id: 'root-51', status: 'active' }, query: { page: 1, pageSize: 20 }
  })
  assert.equal(last.items[0].read, true)
})

test('伪造或跨账号的确定性已读回执不能标记、泄露或覆盖当前账号状态', async () => {
  const markerId = `notification-read-${crypto.createHash('sha256')
    .update('direct-reviewer\0reviewer-1').digest('hex').slice(0, 48)}`
  const data = votingSeed({ mode: 'all' })
  data.notifications = [
    {
      _id: 'direct-reviewer', type: 'review_started', recipientUserIds: ['reviewer-1'],
      businessLineId: 'line-1', nodeId: 'node-1', reviewRoundId: 'review-feedback-current',
      status: 'unread', createdAt: NOW
    },
    {
      _id: markerId, type: 'notification_read_marker', parentNotificationId: 'direct-reviewer',
      userId: 'reviewer-2', createdAt: NOW
    }
  ]
  const { repository } = harness({ seed: data })

  const hidden = await repository.listNotifications({
    actor: { _id: 'reviewer-1', status: 'active' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(hidden.items, [])
  await assert.rejects(repository.markNotificationRead({
    actor: { _id: 'reviewer-1', status: 'active' }, notificationId: 'direct-reviewer'
  }), error => error.code === 'FORBIDDEN')
  await assert.rejects(repository.markNotificationRead({
    actor: { _id: 'reviewer-2', status: 'active' }, notificationId: 'direct-reviewer'
  }), error => error.code === 'FORBIDDEN')
})

test('超级管理员合并定向与角色通知后再执行稳定窗口截取', async () => {
  const data = votingSeed({ mode: 'all' })
  data.users.push({ _id: 'root-1', status: 'active', role: 'super_admin' })
  data.notifications = [
    ...Array.from({ length: 100 }, (_, index) => ({
      _id: `direct-root-${String(index + 1).padStart(3, '0')}`,
      type: 'review_started', recipientUserIds: ['root-1'], createdAt: new Date(index)
    })),
    {
      _id: 'role-latest', type: 'work_calendar_missing', audienceRole: 'super_admin',
      createdAt: NOW
    }
  ]
  const { repository } = harness({ seed: data })

  const result = await repository.listNotifications({
    actor: { _id: 'root-1', status: 'active' }, query: { page: 1, pageSize: 20 }
  })
  assert.equal(result.items[0].notificationId, 'role-latest')
  assert.equal(result.items.length, 20)
  assert.equal(result.hasMore, true)
})

test('超级管理员可见纯旧业务安全降级的凭证保留通知', async () => {
  const data = votingSeed({ mode: 'all' })
  data.users.push({ _id: 'root-1', status: 'active', role: 'super_admin' })
  data.notifications = [{
    _id: 'legacy-retention', type: 'evidence_retention', audienceRole: 'super_admin',
    businessLineId: 'legacy-line', daysRemaining: 15, status: 'pending', createdAt: NOW
  }]
  const { repository } = harness({ seed: data })

  const result = await repository.listNotifications({
    actor: { _id: 'root-1' }, query: { page: 1, pageSize: 20 }
  })
  assert.equal(result.items[0].notificationId, 'legacy-retention')
})

test('凭证保留提醒严格编号可见可幂等已读且其他冒号编号失败关闭', async () => {
  const data = votingSeed({ mode: 'all' })
  const validIds = [
    'evidence-retention:line-1:1',
    'evidence-retention:line-1:7',
    'evidence-retention:line-1:15'
  ]
  const invalidIds = [
    'evidence_retention:line-1:15',
    'evidence-retention::15',
    'evidence-retention:line-1:2',
    'evidence-retention:../line-1:15',
    'evidence-retention:line-1:15:extra',
    'other-prefix:line-1:15'
  ]
  data.notifications = [...validIds, ...invalidIds].map((notificationId, index) => ({
    _id: notificationId,
    type: 'evidence_retention',
    recipientUserIds: ['reviewer-1'],
    businessLineId: 'line-1',
    status: 'pending',
    createdAt: new Date(NOW.getTime() + index)
  }))
  const { fake, repository } = harness({ seed: data })

  const listed = await repository.listNotifications({
    actor: { _id: 'reviewer-1', status: 'active' }, query: { page: 1, pageSize: 20 }
  })
  assert.deepEqual(new Set(listed.items.map(item => item.notificationId)), new Set(validIds))

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await repository.markNotificationRead({
      actor: { _id: 'reviewer-1', status: 'active' }, notificationId: validIds[2]
    }), { notificationId: validIds[2], read: true })
  }
  assert.equal(fake.documents('notifications').filter(item =>
    item.type === 'notification_read_marker' && item.parentNotificationId === validIds[2] &&
    item.userId === 'reviewer-1').length, 1)

  for (const notificationId of invalidIds) {
    await assert.rejects(repository.markNotificationRead({
      actor: { _id: 'reviewer-1', status: 'active' }, notificationId
    }), error => error && error.code === 'FORBIDDEN')
  }
})

test('驳回后审核人仍可读取已固化轮次但处理人不能借历史轮次越权', async () => {
  const data = votingSeed({ mode: 'all' })
  data.business_lines[0].code = 'BL-20260811-0001'
  data.business_lines[0].name = '驳回详情测试'
  const { fake, repository } = harness({ seed: data })
  await repository.submitReviewVote(voteRequest('reviewer-1', {
    input: { decision: 'reject', comment: '字段需返工' },
    context: {
      businessLineId: 'line-1', nodeId: 'node-1', transition: 'rework',
      processingWorkMinutes: 1200, nodeVersion: 5, roundVersion: 1
    }
  }))
  const vote = fake.documents('node_review_votes')[0]
  fake.replace('node_review_votes', vote._id, { ...vote, createdAt: NOW })

  const detail = await repository.getReviewDetail({
    actor: { _id: 'reviewer-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  })
  assert.equal(detail.status, 'rejected')
  assert.equal(detail.canApprove, false)
  await assert.rejects(repository.getReviewDetail({
    actor: { _id: 'processor-1', status: 'active' }, reviewRoundId: 'review-feedback-current'
  }), error => error.code === 'FORBIDDEN')
})

test('审核仓储逐字段拒绝账号关系的访问器和继承数组', async () => {
  for (const kind of ['accessor', 'prototype']) {
    const { repository } = harness({
      transformRead({ collection, data }) {
        if (collection !== 'business_nodes') return data
        delete data.reviewerUserIds
        if (kind === 'accessor') {
          Object.defineProperty(data, 'reviewerUserIds', { get: () => ['reviewer-1'] })
        } else {
          Object.setPrototypeOf(data, { reviewerUserIds: ['reviewer-1'] })
        }
        return data
      }
    })
    await assert.rejects(repository.createReviewRound(request()), error => error.code === 'FORBIDDEN')
  }
})

for (const [label, mutate] of [
  ['管理人数组为空', line => { line.managerUserIds = [] }],
  ['成员数组为空', line => {
      line.managerUserIds = ['processor-1']
      line.memberUserIds = []
    }]
]) {
  test(`${label}时审核创建、预检和最终重试均失败关闭`, async () => {
    const invalidSeed = seed()
    mutate(invalidSeed.business_lines[0])
    await assert.rejects(
      harness({ seed: invalidSeed }).repository.createReviewRound(request()),
      error => error.code === 'FORBIDDEN'
    )

    const { fake, repository } = harness()
    const value = request()
    value.draftHash = retryValue(value).draftHash
    await repository.createReviewRound(value)
    const line = fake.documents('business_lines')[0]
    mutate(line)
    fake.replace('business_lines', line._id, line)
    const retryInput = retryValue(value)
    await assert.rejects(repository.inspectReviewRoundRetry(retryInput), error =>
      error.code === 'FORBIDDEN')
    await assert.rejects(repository.findReviewRoundRetry(retryInput), error =>
      error.code === 'FORBIDDEN')
  })
}

test('同请求同输入幂等，不同输入冲突且不会重复写通知和审计', async () => {
  const { fake, repository } = harness()
  const first = await repository.createReviewRound(request())
  const second = await repository.createReviewRound(request())
  assert.deepEqual(second, first)
  assert.equal(fake.documents('node_review_rounds').length, 1)
  assert.equal(fake.documents('notifications').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)

  await assert.rejects(
    repository.createReviewRound(request({ inputHash: 'f'.repeat(64) })),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('服务入口重试预检在返回审核轮次前重新授权并比较请求摘要', async () => {
  const { fake, repository } = harness()
  const value = request()
  value.draftHash = retryValue(value).draftHash
  const first = await repository.createReviewRound(value)
  const retryInput = retryValue(value)

  assert.deepEqual(await repository.inspectReviewRoundRetry(retryInput), {
    reviewRoundId: 'review-feedback-current'
  })
  assert.deepEqual(await repository.findReviewRoundRetry(retryInput), first)
  await assert.rejects(
    repository.findReviewRoundRetry({ ...retryInput, inputHash: 'f'.repeat(64) }),
    error => error.code === 'VERSION_CONFLICT'
  )

  fake.replace('users', 'processor-1', { _id: 'processor-1', status: 'disabled' })
  await assert.rejects(repository.findReviewRoundRetry(retryInput), error => error.code === 'FORBIDDEN')
  fake.replace('users', 'processor-1', { _id: 'processor-1', status: 'active' })
  fake.replace('business_lines', 'line-1', {
    ...fake.documents('business_lines')[0], status: 'cancelled'
  })
  await assert.rejects(repository.findReviewRoundRetry(retryInput), error => error.code === 'BUSINESS_FROZEN')
  fake.replace('business_lines', 'line-1', {
    ...fake.documents('business_lines')[0], status: 'active'
  })
  fake.replace('business_nodes', 'node-1', {
    ...fake.documents('business_nodes')[0], processorUserIds: ['processor-other']
  })
  await assert.rejects(repository.findReviewRoundRetry(retryInput), error => error.code === 'FORBIDDEN')
})

test('日历补算同步提升节点与审核轮锁版本后，同一提交仍可幂等重试', async () => {
  const { fake, repository } = harness()
  const value = request()
  value.draftHash = retryValue(value).draftHash
  const first = await repository.createReviewRound(value)
  const node = fake.documents('business_nodes')[0]
  const round = fake.documents('node_review_rounds')[0]
  fake.replace('business_nodes', node._id, { ...node, version: 6 })
  fake.replace('node_review_rounds', round._id, { ...round, version: 2, lockedNodeVersion: 6 })

  const retryInput = retryValue(value)
  assert.deepEqual(await repository.inspectReviewRoundRetry(retryInput), {
    reviewRoundId: 'review-feedback-current'
  })
  assert.deepEqual(await repository.findReviewRoundRetry(retryInput), first)
})

test('审核幂等重试拒绝任一侧锁版本、提交版本或活动轮次被单独篡改', async () => {
  const mutations = [
    ({ node }) => ({ node: { ...node, version: 6 } }),
    ({ round }) => ({ round: { ...round, lockedNodeVersion: 6 } }),
    ({ round }) => ({ round: { ...round, submittedNodeVersion: 3 } }),
    ({ node }) => ({ node: { ...node, activeReviewRoundId: 'review-other' } })
  ]
  for (const mutate of mutations) {
    const { fake, repository } = harness()
    const value = request()
    value.draftHash = retryValue(value).draftHash
    await repository.createReviewRound(value)
    const node = fake.documents('business_nodes')[0]
    const round = fake.documents('node_review_rounds')[0]
    const changed = mutate({ node, round })
    if (changed.node) fake.replace('business_nodes', node._id, changed.node)
    if (changed.round) fake.replace('node_review_rounds', round._id, changed.round)
    const retryInput = retryValue(value)
    await assert.rejects(repository.inspectReviewRoundRetry(retryInput), error =>
      error.code === 'VERSION_CONFLICT')
    await assert.rejects(repository.findReviewRoundRetry(retryInput), error =>
      error.code === 'VERSION_CONFLICT')
  }
})

test('幂等重试必须用重新构建的完整草稿拒绝审核轮次摘要篡改', async () => {
  for (const mutate of [
    round => { round.draftHash = 'f'.repeat(64) },
    round => { round.feedbackId = 'feedback-other' },
    round => { round.feedbackRevision = 3 },
    round => { round.processingComment = '被篡改的处理说明' },
    round => { round.fieldValues = [{ fieldKey: 'summary', value: '篡改' }] },
    round => { round.evidenceIds = ['evidence-b', 'evidence-a'] },
    round => { round.evidenceTotalBytes = 2048 }
  ]) {
    const { fake, repository } = harness()
    const value = request()
    value.draftHash = retryValue(value).draftHash
    await repository.createReviewRound(value)
    const round = fake.documents('node_review_rounds')[0]
    mutate(round)
    fake.replace('node_review_rounds', round._id, round)
    await assert.rejects(repository.findReviewRoundRetry(retryValue(value)), error =>
      error.code === 'VERSION_CONFLICT')
  }
})

test('幂等重试拒绝实际提交人处理工时快照缺失或被篡改', async () => {
  for (const mutate of [
    round => { delete round.submittedByDisplayName },
    round => { round.submittedByDisplayName = '被篡改的提交人' },
    round => { round.processorAssignmentMode = 'business_creator' },
    round => { round.processingRoundTimingStatus = 'pending_calendar' },
    round => { round.processingRoundWorkMinutes = 121 },
    round => { round.processingRoundCalendarVersion = 'calendar-other' },
    round => { round.processingRoundStartedAt = new Date('2026-08-11T01:01:00.000Z') },
    round => { round.processingRoundEndedAt = new Date('2026-08-11T03:01:00.000Z') }
  ]) {
    const { fake, repository } = harness()
    const value = request()
    value.draftHash = retryValue(value).draftHash
    await repository.createReviewRound(value)
    const round = fake.documents('node_review_rounds')[0]
    mutate(round)
    fake.replace('node_review_rounds', round._id, round)
    await assert.rejects(repository.findReviewRoundRetry(retryValue(value)), error =>
      error.code === 'VERSION_CONFLICT')
  }
})

test('审核轮次创建与幂等确认都拒绝草稿说明和原反馈说明不一致', async () => {
  const data = seed()
  data.node_feedback[0].comment = '原反馈已变化'
  const { repository } = harness({ seed: data })
  const value = request()
  value.draftHash = retryValue(value).draftHash

  await assert.rejects(repository.createReviewRound(value), error => error.code === 'VERSION_CONFLICT')

  const created = harness()
  const valid = request()
  valid.draftHash = retryValue(valid).draftHash
  await created.repository.createReviewRound(valid)
  created.fake.replace('node_feedback', 'feedback-current', {
    ...created.fake.documents('node_feedback')[0], comment: '响应丢失后反馈被篡改'
  })
  await assert.rejects(
    created.repository.findReviewRoundRetry(retryValue(valid)),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('事务内重新校验账号、处理角色、节点版本、当前节点和活动轮次完整性', async () => {
  const cases = [
    { seed: seed({ users: [{ _id: 'processor-1', status: 'disabled' }] }), code: 'FORBIDDEN' },
    { seed: seed({ nodes: [{ ...seed().business_nodes[0], processorUserIds: ['other'] }] }), code: 'FORBIDDEN' },
    { value: request({ input: { ...request().input, expectedNodeVersion: 3 } }), code: 'VERSION_CONFLICT' },
    { seed: seed({ lines: [{ ...seed().business_lines[0], currentNodeId: 'node-other' }] }), code: 'NODE_NOT_ACTIVE' },
    { seed: seed({ nodes: [{ ...seed().business_nodes[0], activeReviewRoundId: 'review-corrupt' }] }), code: 'VERSION_CONFLICT' }
  ]
  for (const item of cases) {
    const { repository } = harness({ seed: item.seed || seed() })
    await assert.rejects(repository.createReviewRound(item.value || request()), error => error.code === item.code)
  }
})

test('日历缺失时仍创建审核轮次并保持待补算截止时间', async () => {
  const { fake, repository } = harness()
  const value = request({
    timing: {
      ...request().timing,
      reviewDueStatus: 'pending_calendar', reviewDueAt: null,
      reviewCalendarVersion: null
    }
  })

  await repository.createReviewRound(value)
  const [round] = fake.documents('node_review_rounds')
  assert.equal(round.reviewDueStatus, 'pending_calendar')
  assert.equal(round.reviewDueAt, null)
  assert.equal(round.calendarNotificationStatus, 'pending')
})

test('事务拒绝与节点双时限快照不一致的预计算结果', async () => {
  const { repository } = harness()
  await assert.rejects(
    repository.createReviewRound(request({
      timing: { ...request().timing, processingRemainingWorkMinutes: 1199 }
    })),
    error => error.code === 'VERSION_CONFLICT'
  )
  await assert.rejects(
    repository.createReviewRound(request({
      timing: { ...request().timing, reviewRemainingWorkMinutes: 479 }
    })),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('并发提交或活动轮次文档腐败只能得到一个锁定结果', async () => {
  const { fake, repository } = harness()
  const results = await Promise.all([
    repository.createReviewRound(request()),
    repository.createReviewRound(request())
  ])
  assert.deepEqual(results[0], results[1])
  assert.equal(fake.documents('node_review_rounds').length, 1)

  fake.replace('node_review_rounds', 'review-feedback-current', {
    ...fake.documents('node_review_rounds')[0], businessLineId: 'line-other'
  })
  await assert.rejects(repository.createReviewRound(request()), error => error.code === 'VERSION_CONFLICT')
})

test('不同请求并发提交时只有首个请求可以锁定待审核轮次', async () => {
  const { fake, repository } = harness()
  const results = await Promise.allSettled([
    repository.createReviewRound(request()),
    repository.createReviewRound(request({
      requestKeyHash: crypto.createHash('sha256').update('different-request').digest('hex'),
      inputHash: crypto.createHash('sha256').update('different-input').digest('hex')
    }))
  ])

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'VERSION_CONFLICT')
  assert.equal(fake.documents('node_review_rounds').length, 1)
  assert.equal(fake.documents('notifications').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
})

test('或签两个通过事务真实重叠、发生冲突重试且只流转一次', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any' }) })
  const results = await Promise.allSettled([
    repository.submitReviewVote(voteRequest('reviewer-1')),
    repository.submitReviewVote(voteRequest('reviewer-2'))
  ])

  assert.equal(fake.metrics.maxActiveCallbacks >= 2, true)
  assert.equal(fake.metrics.conflicts >= 1, true)
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(fake.documents('business_nodes').filter(node => node.status === 'ready').length, 1)
  assert.equal(fake.documents('node_review_votes').length, 1)
  assert.equal(fake.documents('node_review_votes')[0].decision, 'approved')
  assert.equal(fake.documents('node_review_votes')[0].reviewerDisplayName, '审核人一')
  assert.equal(fake.documents('notifications').filter(item => item.type === 'node_processing_started').length, 1)
  assert.equal(fake.documents('audit_logs').filter(item => item.action === 'SUBMIT_REVIEW_VOTE').length, 1)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})

test('驳回投票持久化为 rejected 并保存事务内审核人显示名快照', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any' }) })
  await repository.submitReviewVote(voteRequest('reviewer-1', {
    input: { decision: 'reject', comment: '需要返工' },
    context: {
      businessLineId: 'line-1', nodeId: 'node-1', transition: 'rework',
      processingWorkMinutes: 1200, processingCarryoverPending: false,
      nodeVersion: 5, roundVersion: 1,
      reviewStartedAt: NOW, reviewTotalWorkMinutes: 480,
      reviewBaseElapsedWorkMinutes: 0
    }
  }))
  const [vote] = fake.documents('node_review_votes')
  assert.equal(vote.decision, 'rejected')
  assert.equal(vote.reviewerDisplayName, '审核人一')
  assert.equal(vote.reviewResponseTimingStatus, 'calculated')
  assert.equal(vote.reviewResponseWorkMinutes, 120)
  assert.equal(vote.reviewResponseCalendarVersion, 'calendar-a')
  assert.deepEqual(vote.reviewResponseStartedAt, NOW)
  assert.deepEqual(vote.reviewResponseEndedAt, NOW)
  assert.equal(fake.documents('node_review_rounds')[0].finalDecision, 'rejected')
  assert.equal(fake.documents('audit_logs')[0].decision, 'rejected')
})

test('投票同请求按规范决策幂等，旧持久语义不能混作新语义', async () => {
  const data = votingSeed({ mode: 'all' })
  const value = voteRequest('reviewer-1')
  const voteId = `review-vote-${crypto.createHash('sha256')
    .update(`review-feedback-current\0reviewer-1`).digest('hex')}`
  data.node_review_votes = [{
    _id: voteId, reviewRoundId: 'review-feedback-current', businessLineId: 'line-1',
    nodeId: 'node-1', reviewerUserId: 'reviewer-1', reviewerDisplayName: '审核人一',
    decision: 'approve', comment: '', expectedRoundVersion: 1,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  }]
  const { repository } = harness({ seed: data })
  await assert.rejects(repository.submitReviewVote(value), error => error.code === 'VOTE_CONFLICT')
})

test('损坏的审核人显示名与用户名在写票前失败关闭', async () => {
  const data = votingSeed({ mode: 'any' })
  data.users = data.users.map(user => user._id === 'reviewer-1'
    ? { ...user, displayName: 'x'.repeat(101), username: '\n' }
    : user)
  const { fake, repository } = harness({ seed: data })
  await assert.rejects(repository.submitReviewVote(voteRequest('reviewer-1')), error =>
    error.code === 'VERSION_CONFLICT')
  assert.equal(fake.documents('node_review_votes').length, 0)
})

test('审核人显示名为空时只回退到事务内合法用户名快照', async () => {
  const data = votingSeed({ mode: 'any' })
  data.users = data.users.map(user => user._id === 'reviewer-1'
    ? { ...user, displayName: '   ', username: 'reviewer01' }
    : user)
  const { fake, repository } = harness({ seed: data })

  await repository.submitReviewVote(voteRequest('reviewer-1'))

  assert.equal(fake.documents('node_review_votes')[0].reviewerDisplayName, 'reviewer01')
})

test('审核人显示名访问器不能执行且只回退到自有用户名', async () => {
  let getterCalls = 0
  const { fake, repository } = harness({
    seed: votingSeed({ mode: 'any' }),
    transformRead({ collection, data }) {
      if (collection !== 'users' || data._id !== 'reviewer-1') return data
      data.username = 'reviewer01'
      delete data.displayName
      Object.defineProperty(data, 'displayName', {
        get() {
          getterCalls += 1
          return '客户端伪造姓名'
        }
      })
      return data
    }
  })

  await repository.submitReviewVote(voteRequest('reviewer-1'))

  assert.equal(getterCalls, 0)
  assert.equal(fake.documents('node_review_votes')[0].reviewerDisplayName, 'reviewer01')
})

test('会签逐票通过、同票同输入幂等且改票冲突', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'all' }) })
  const firstValue = voteRequest('reviewer-1')
  const first = await repository.submitReviewVote(firstValue)
  assert.deepEqual(first, {
    reviewRoundId: 'review-feedback-current', status: 'pending',
    nodeStatus: 'pending_review', lineStatus: 'active', nextNodeId: null
  })
  const [firstStoredVote] = fake.documents('node_review_votes')
  assert.equal(firstStoredVote.reviewerUserId, 'reviewer-1')
  assert.equal(firstStoredVote.reviewResponseWorkMinutes, 120)
  assert.equal(fake.documents('node_review_votes').some(vote => vote.reviewerUserId === 'reviewer-2'), false)
  assert.deepEqual(await repository.submitReviewVote(firstValue), first)
  assert.deepEqual(fake.documents('node_review_votes')[0], firstStoredVote)
  await assert.rejects(
    repository.submitReviewVote(voteRequest('reviewer-1', {
      requestKey: 'vote-reviewer-1-change',
      input: { decision: 'reject', comment: '改票' }
    })),
    error => error.code === 'VOTE_CONFLICT'
  )

  const result = await repository.submitReviewVote(voteRequest('reviewer-2'))
  assert.equal(result.status, 'approved')
  assert.equal(fake.documents('node_review_votes').length, 2)
  for (const vote of fake.documents('node_review_votes')) {
    assert.equal(vote.reviewResponseTimingStatus, 'calculated')
    assert.equal(vote.reviewResponseWorkMinutes, 120)
  }
  assert.equal(fake.documents('node_review_rounds')[0].approvedVoteCount, 2)
  assert.equal(fake.documents('business_nodes').find(node => node._id === 'node-1').status, 'completed')
})

test('最终投票响应丢失后仍先重新授权再按同一摘要幂等返回', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any' }) })
  const value = voteRequest('reviewer-1')
  const first = await repository.submitReviewVote(value)
  const context = await repository.prepareReviewVote({
    actor: value.actor,
    input: value.input,
    requestKeyHash: value.requestKeyHash,
    inputHash: value.inputHash
  })
  const retry = await repository.submitReviewVote({ ...value, context, timing: { transitionAt: NOW } })

  assert.deepEqual(retry, first)
  assert.equal(fake.documents('node_review_votes').length, 1)
  assert.equal(fake.documents('notifications').filter(item => item.type === 'node_processing_started').length, 1)
  assert.equal(fake.documents('audit_logs').filter(item => item.action === 'SUBMIT_REVIEW_VOTE').length, 1)

  fake.replace('users', 'reviewer-1', {
    ...fake.documents('users').find(user => user._id === 'reviewer-1'), status: 'disabled'
  })
  await assert.rejects(repository.prepareReviewVote({
    actor: value.actor, input: value.input,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  }), error => error.code === 'FORBIDDEN')
})

test('终态重试只接受固化的最终版本链并拒绝同时抬高版本或篡改轮次语义', async () => {
  for (const mutate of [
    ({ node, round }) => { node.version += 2; round.version += 2 },
    ({ round }) => { round.lockedNodeVersion -= 1 },
    ({ round }) => { round.reviewMode = 'all' },
    ({ round }) => { round.processingRoundNumber += 1 },
    ({ round }) => { round.reviewRoundNumber += 1 }
  ]) {
    const { fake, repository } = harness({ seed: votingSeed({ mode: 'any' }) })
    const value = voteRequest('reviewer-1')
    await repository.submitReviewVote(value)
    const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
    const round = fake.documents('node_review_rounds')[0]
    mutate({ node, round })
    fake.replace('business_nodes', node._id, node)
    fake.replace('node_review_rounds', round._id, round)
    await assert.rejects(repository.prepareReviewVote({
      actor: value.actor, input: value.input,
      requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
    }), error => error.code === 'VERSION_CONFLICT')
  }
})

test('终态重试接受该轮待补算处理段被明确解决后的唯一一次锁版本提升', async () => {
  const data = votingSeed({ mode: 'any' })
  Object.assign(data.business_nodes[0], {
    processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
    processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
    processingCalendarVersion: null
  })
  Object.assign(data.node_review_rounds[0], {
    processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
    processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
    processingCalendarVersion: null
  })
  const { fake, repository } = harness({ seed: data })
  const value = voteRequest('reviewer-1')
  const first = await repository.submitReviewVote(value)
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  const round = fake.documents('node_review_rounds')[0]
  fake.replace('business_nodes', node._id, {
    ...node, version: 7, processingTimingStatus: 'calculated',
    processingElapsedWorkMinutes: 300, processingRemainingWorkMinutes: 1020,
    processingCalendarVersion: 'calendar-a'
  })
  fake.replace('node_review_rounds', round._id, {
    ...round, version: 3, processingTimingStatus: 'calculated',
    processingElapsedWorkMinutes: 300, processingRemainingWorkMinutes: 1020,
    processingCalendarVersion: 'calendar-a', processingCarryoverStatus: 'resolved',
    processingCarryoverResolvedAt: new Date('2026-08-11T04:00:00Z')
  })
  const context = await repository.prepareReviewVote({
    actor: value.actor, input: value.input,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  })
  assert.deepEqual(await repository.submitReviewVote({
    ...value, context, timing: { transitionAt: NOW }
  }), first)
})

test('终态重试版本链严格等于处理与审核两类已解决补算数', async () => {
  const data = votingSeed({ mode: 'any' })
  for (const target of [data.business_nodes[0], data.node_review_rounds[0]]) {
    Object.assign(target, {
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      processingCalendarVersion: null
    })
  }
  const { fake, repository } = harness({ seed: data })
  const value = voteRequest('reviewer-1', {
    timing: {
      transitionAt: NOW, processingDueStatus: 'calculated',
      processingDueAt: new Date('2026-08-13T03:00:00Z'), processingCalendarVersion: 'calendar-a',
      reviewTimingStatus: 'pending_calendar', reviewElapsedWorkMinutes: 0,
      reviewRemainingWorkMinutes: 480, reviewOverdueWorkMinutes: 0, reviewCalendarVersion: null,
      reviewResponseTimingStatus: 'pending_calendar', reviewResponseWorkMinutes: null,
      reviewResponseCalendarVersion: null, reviewResponseStartedAt: NOW,
      reviewResponseEndedAt: NOW
    }
  })
  const first = await repository.submitReviewVote(value)
  const round = fake.documents('node_review_rounds')[0]
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  fake.replace('node_review_rounds', round._id, {
    ...round,
    processingCarryoverStatus: 'resolved',
    processingCarryoverResolvedAt: new Date('2026-08-11T04:00:00.000Z'),
    processingTimingStatus: 'calculated', processingElapsedWorkMinutes: 300,
    processingRemainingWorkMinutes: 1020, processingOverdueWorkMinutes: 0,
    processingCalendarVersion: 'calendar-processing',
    reviewTimingCarryoverStatus: 'resolved',
    reviewTimingCarryoverResolvedAt: new Date('2026-08-11T04:00:01.000Z'),
    reviewTimingStatus: 'calculated', reviewElapsedWorkMinutes: 60,
    reviewRemainingWorkMinutes: 420, reviewOverdueWorkMinutes: 0,
    reviewCalendarVersion: 'calendar-review',
    version: round.resultRoundVersion + 2
  })
  fake.replace('business_nodes', node._id, { ...node, version: round.resultNodeVersion + 2 })
  const context = await repository.prepareReviewVote({
    actor: value.actor, input: value.input,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  })
  assert.deepEqual(await repository.submitReviewVote({
    ...value, context, timing: { transitionAt: NOW }
  }), first)
  fake.replace('business_nodes', node._id, {
    ...fake.documents('business_nodes').find(item => item._id === node._id),
    version: round.resultNodeVersion + 1
  })
  await assert.rejects(repository.prepareReviewVote({
    actor: value.actor, input: value.input,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  }), error => error.code === 'VERSION_CONFLICT')
})

test('终态重试拒绝待补算审核段不可变边界被篡改', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any' }) })
  const value = voteRequest('reviewer-1', {
    timing: {
      reviewTimingStatus: 'pending_calendar', reviewElapsedWorkMinutes: 0,
      reviewRemainingWorkMinutes: 480, reviewOverdueWorkMinutes: 0,
      reviewCalendarVersion: null,
      reviewResponseTimingStatus: 'pending_calendar', reviewResponseWorkMinutes: null,
      reviewResponseCalendarVersion: null, reviewResponseStartedAt: NOW,
      reviewResponseEndedAt: NOW
    }
  })
  await repository.submitReviewVote(value)
  const round = fake.documents('node_review_rounds')[0]
  fake.replace('node_review_rounds', round._id, {
    ...round,
    reviewTimingCarryoverStartedAt: new Date('2026-08-11T02:59:59.000Z')
  })

  await assert.rejects(repository.prepareReviewVote({
    actor: value.actor, input: value.input,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  }), error => error.code === 'VERSION_CONFLICT')
})

test('会签任一驳回立即进入新处理轮且原因必填由服务契约保证', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'all' }) })
  const value = voteRequest('reviewer-1', {
    input: { decision: 'reject', comment: '字段不完整' },
    context: {
      businessLineId: 'line-1', nodeId: 'node-1', transition: 'rework',
      processingWorkMinutes: 1200, nodeVersion: 5, roundVersion: 1
    }
  })
  const result = await repository.submitReviewVote(value)

  assert.equal(result.status, 'rejected')
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  assert.equal(node.status, 'in_progress')
  assert.equal(node.processingRoundNumber, 2)
  assert.equal(node.processingRemainingWorkMinutes, 1200)
  assert.equal(node.activeReviewRoundId, undefined)
  assert.equal(fake.documents('node_review_rounds')[0].status, 'rejected')
  const context = await repository.prepareReviewVote({
    actor: value.actor, input: value.input,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  })
  assert.deepEqual(await repository.submitReviewVote({
    ...value, context, timing: { transitionAt: NOW }
  }), result)
})

test('处理时长待补算时驳回会保留旧处理段边界供日历恢复后修正', async () => {
  const data = votingSeed({ mode: 'all' })
  Object.assign(data.business_nodes[0], {
    processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
    processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
    processingCalendarVersion: null
  })
  Object.assign(data.node_review_rounds[0], {
    processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
    processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
    processingCalendarVersion: null
  })
  const { fake, repository } = harness({ seed: data })
  await repository.submitReviewVote(voteRequest('reviewer-1', {
    input: { decision: 'reject', comment: '返工' },
    context: {
      businessLineId: 'line-1', nodeId: 'node-1', transition: 'rework',
      processingWorkMinutes: 1200, processingCarryoverPending: true,
      nodeVersion: 5, roundVersion: 1
    },
    timing: {
      transitionAt: NOW, processingDueStatus: 'pending_calendar',
      processingDueAt: null, processingCalendarVersion: null,
      reviewTimingStatus: 'pending_calendar', reviewElapsedWorkMinutes: 0,
      reviewRemainingWorkMinutes: 480, reviewOverdueWorkMinutes: 0,
      reviewCalendarVersion: null,
      reviewResponseTimingStatus: 'pending_calendar', reviewResponseWorkMinutes: null,
      reviewResponseCalendarVersion: null, reviewResponseStartedAt: NOW,
      reviewResponseEndedAt: NOW
    }
  }))

  const round = fake.documents('node_review_rounds')[0]
  assert.equal(round.processingCarryoverStatus, 'pending')
  assert.deepEqual(round.processingCarryoverStartedAt, new Date('2026-08-11T01:00:00.000Z'))
  assert.deepEqual(round.processingCarryoverEndedAt, NOW)
  assert.equal(round.processingCarryoverBaseElapsedWorkMinutes, 120)
  assert.equal(round.processingCarryoverTotalWorkMinutes, 1320)
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  assert.equal(node.processingCarryoverReviewRoundId, undefined)
  assert.equal(round.reviewTimingStatus, 'pending_calendar')
  assert.equal(round.reviewTimingCarryoverStatus, 'pending')
  assert.deepEqual(round.reviewTimingCarryoverStartedAt, NOW)
  assert.deepEqual(round.reviewTimingCarryoverEndedAt, NOW)
  assert.equal(round.reviewTimingCarryoverBaseElapsedWorkMinutes, 0)
  assert.equal(round.reviewTimingCarryoverTotalWorkMinutes, 480)
})

test('终态审核段即时结算剩余与逾期工作分钟', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any' }) })
  await repository.submitReviewVote(voteRequest('reviewer-1', {
    timing: {
      transitionAt: NOW, processingDueStatus: 'calculated',
      processingDueAt: new Date('2026-08-13T03:00:00.000Z'),
      processingCalendarVersion: 'calendar-a',
      reviewTimingStatus: 'calculated', reviewElapsedWorkMinutes: 600,
      reviewRemainingWorkMinutes: 0, reviewOverdueWorkMinutes: 120,
      reviewCalendarVersion: 'calendar-review',
      reviewResponseTimingStatus: 'calculated', reviewResponseWorkMinutes: 600,
      reviewResponseCalendarVersion: 'calendar-review', reviewResponseStartedAt: NOW,
      reviewResponseEndedAt: NOW
    }
  }))
  const round = fake.documents('node_review_rounds')[0]
  assert.equal(round.reviewTimingStatus, 'calculated')
  assert.equal(round.reviewElapsedWorkMinutes, 600)
  assert.equal(round.reviewRemainingWorkMinutes, 0)
  assert.equal(round.reviewOverdueWorkMinutes, 120)
  assert.equal(round.reviewCalendarVersion, 'calendar-review')
  assert.equal(round.reviewTimingCarryoverStatus, undefined)
})

test('末节点审核段缺少日历仍完成业务并写一条确定性脱敏告警', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any', terminal: true }) })
  const request = voteRequest('reviewer-1', {
    context: { transition: 'complete_line', nextNodeId: undefined, nextNodeVersion: undefined,
      processingWorkMinutes: null },
    timing: {
      reviewTimingStatus: 'pending_calendar', reviewElapsedWorkMinutes: 0,
      reviewRemainingWorkMinutes: 480, reviewOverdueWorkMinutes: 0,
      reviewCalendarVersion: null,
      reviewResponseTimingStatus: 'pending_calendar', reviewResponseWorkMinutes: null,
      reviewResponseCalendarVersion: null, reviewResponseStartedAt: NOW,
      reviewResponseEndedAt: NOW
    }
  })

  const result = await repository.submitReviewVote(request)

  assert.equal(result.lineStatus, 'completed')
  const warnings = fake.documents('notifications').filter(item => item.type === 'work_calendar_missing')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].audienceRole, 'super_admin')
  assert.equal(JSON.stringify(warnings[0]).includes('资料'), false)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})

test('投票早返之前重新校验账号、审核关系、业务、双向轮次锁与期望版本', async () => {
  const mutations = [
    { code: 'FORBIDDEN', mutate: data => { data.users.find(user => user._id === 'reviewer-1').status = 'disabled' } },
    { code: 'FORBIDDEN', mutate: data => { data.business_nodes[0].reviewerUserIds = ['reviewer-2'] } },
    { code: 'BUSINESS_FROZEN', mutate: data => { data.business_lines[0].status = 'closed' } },
    { code: 'NODE_NOT_ACTIVE', mutate: data => { data.business_lines[0].currentNodeId = 'other' } },
    { code: 'VERSION_CONFLICT', mutate: data => { data.business_nodes[0].version = 6 } },
    { code: 'VERSION_CONFLICT', mutate: data => { data.business_nodes[0].activeReviewRoundId = 'review-other' } },
    { code: 'VERSION_CONFLICT', mutate: data => { data.node_review_rounds[0].lockedNodeVersion = 6 } }
  ]
  for (const item of mutations) {
    const data = votingSeed({ mode: 'all' })
    item.mutate(data)
    const { repository } = harness({ seed: data })
    await assert.rejects(repository.submitReviewVote(voteRequest('reviewer-1')), error =>
      error.code === item.code)
  }
  const { repository } = harness({ seed: votingSeed({ mode: 'all' }) })
  await assert.rejects(
    repository.submitReviewVote(voteRequest('reviewer-1', {
      input: { expectedRoundVersion: 2 }
    })),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('真正或签的通过与驳回真实重叠时只提交一个终态', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any' }) })
  const outcomes = await Promise.allSettled([
    repository.submitReviewVote(voteRequest('reviewer-1')),
    repository.submitReviewVote(voteRequest('reviewer-2', {
      input: { decision: 'reject', comment: '需要返工' },
      context: {
        businessLineId: 'line-1', nodeId: 'node-1', transition: 'rework',
        processingWorkMinutes: 1200, nodeVersion: 5, roundVersion: 1
      }
    }))
  ])

  assert.equal(fake.metrics.maxActiveCallbacks >= 2, true)
  assert.equal(fake.metrics.conflicts >= 1, true)
  assert.equal(fake.metrics.retries >= 1, true)
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1)
  const finalStatus = fake.documents('node_review_rounds')[0].status
  assert.equal(['approved', 'rejected'].includes(finalStatus), true)
  assert.equal(fake.documents('node_review_votes').length, 1)
  assert.equal(fake.documents('audit_logs').filter(item => item.action === 'SUBMIT_REVIEW_VOTE').length, 1)
  assert.equal(fake.documents('notifications').filter(item =>
    ['node_review_rejected', 'node_processing_started'].includes(item.type)).length, 1)
})

test('末节点通过完成业务并只在业务线上建立统一60天凭证保留期', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'any', terminal: true }) })
  const value = voteRequest('reviewer-1', {
    context: {
      businessLineId: 'line-1', nodeId: 'node-1', transition: 'complete_line',
      processingWorkMinutes: null, nodeVersion: 5, roundVersion: 1
    },
    timing: { transitionAt: NOW }
  })
  const result = await repository.submitReviewVote(value)

  assert.equal(result.lineStatus, 'completed')
  const line = fake.documents('business_lines')[0]
  assert.deepEqual(line.retentionStartedAt, NOW)
  assert.deepEqual(line.purgeDueAt, new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000))
  assert.equal(line.progress, 100)
  assert.equal(line.analyticsSnapshotStatus, 'pending')
  assert.equal(line.analyticsSourceVersion, 1)
  assert.deepEqual(line.analyticsCompletedAt, NOW)
  const node = fake.documents('business_nodes').find(item => item._id === 'node-1')
  assert.equal(node.analyticsSnapshotStatus, 'pending')
  assert.equal(node.analyticsSourceVersion, 1)
  assert.deepEqual(node.analyticsCompletedAt, NOW)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
  const context = await repository.prepareReviewVote({
    actor: value.actor, input: value.input,
    requestKeyHash: value.requestKeyHash, inputHash: value.inputHash
  })
  assert.deepEqual(await repository.submitReviewVote({
    ...value, context, timing: { transitionAt: NOW }
  }), result)
})

test('返工和下一节点激活在日历缺失时仍流转并安全告警', async () => {
  for (const item of [
    { mode: 'all', decision: 'reject', comment: '返工', transition: 'rework', expected: 'in_progress' },
    { mode: 'any', decision: 'approve', comment: '', transition: 'next_node', expected: 'completed' }
  ]) {
    const { fake, repository } = harness({ seed: votingSeed({ mode: item.mode }) })
    const result = await repository.submitReviewVote(voteRequest('reviewer-1', {
      input: { decision: item.decision, comment: item.comment },
      context: {
        businessLineId: 'line-1', nodeId: 'node-1', transition: item.transition,
        ...(item.transition === 'next_node'
          ? { nextNodeId: 'line-1-node-002', nextNodeVersion: 1 }
          : {}),
        processingWorkMinutes: item.transition === 'rework' ? 1200 : 1320,
        nodeVersion: 5, roundVersion: 1
      },
      timing: {
        transitionAt: NOW, processingDueStatus: 'pending_calendar',
        processingDueAt: null, processingCalendarVersion: null
      }
    }))
    assert.equal(result.status, item.decision === 'reject' ? 'rejected' : 'approved')
    const dueNode = item.transition === 'rework'
      ? fake.documents('business_nodes').find(node => node._id === 'node-1')
      : fake.documents('business_nodes').find(node => node._id === 'line-1-node-002')
    assert.equal(dueNode.processingDueStatus, 'pending_calendar')
    assert.equal(dueNode.processingDueAt, null)
    assert.equal(fake.documents('notifications').some(note => note.type === 'work_calendar_missing'), true)
  }
})
