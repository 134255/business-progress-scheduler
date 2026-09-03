const test = require('node:test')
const assert = require('node:assert/strict')

const { createReviewService } = require('../lib/review-service')
const { createWorkTimeService } = require('../lib/work-time-service')

const ACTOR = { _id: 'processor-1', status: 'active' }

function input(overrides = {}) {
  return {
    businessLineId: 'line-1',
    nodeId: 'node-1',
    expectedNodeVersion: 4,
    requestKey: 'review-request-1',
    ...overrides
  }
}

function draft(overrides = {}) {
  return {
    line: { _id: 'line-1', status: 'active' },
    node: {
      _id: 'node-1', businessLineId: 'line-1', version: 4, workflowMode: 'review',
      processingRoundNumber: 1, processingSlaWorkHours: 22, reviewSlaWorkHours: 8,
      processingStartedAt: new Date('2026-08-11T01:00:00.000Z'),
      processingElapsedWorkMinutes: 0
    },
    feedbackId: 'feedback-current',
    feedbackRevision: 2,
    processingComment: '最新处理说明',
    fieldSnapshots: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '最新版' }],
    evidenceIds: ['evidence-a', 'evidence-b'],
    evidenceTotalBytes: 1024,
    ...overrides
  }
}

function realWorkTimeService() {
  return createWorkTimeService({
    calendarRepository: {
      async getDayRule(date) {
        return { date, isWorkday: true, calendarVersion: 'calendar-real-seconds' }
      }
    }
  })
}

function harness(overrides = {}) {
  const calls = []
  const feedbackRepository = {
    async getCurrentProcessingRoundDraft(value) {
      calls.push(['draft', structuredClone(value)])
      return overrides.draft || draft()
    },
    async getLockedProcessingRoundDraft(value) {
      calls.push(['locked-draft', structuredClone(value)])
      return overrides.lockedDraft || overrides.draft || draft()
    }
  }
  const reviewRepository = {
    async inspectReviewRoundRetry(value) {
      calls.push(['inspect-retry', structuredClone(value)])
      return overrides.retry ? { reviewRoundId: overrides.retry.reviewRoundId } : null
    },
    async findReviewRoundRetry(value) {
      calls.push(['confirm-retry', structuredClone(value)])
      return overrides.retry || null
    },
    async createReviewRound(value) {
      calls.push(['create', structuredClone(value)])
      return {
        reviewRoundId: `review-${value.draft.feedbackId}`,
        status: 'pending', nodeStatus: 'pending_review',
        evidenceIds: value.draft.evidenceIds
      }
    },
    async prepareReviewVote(value) {
      calls.push(['prepare-vote', structuredClone(value)])
      return overrides.voteContext || {
        transition: 'next_node',
        processingWorkMinutes: 1320,
        reviewStartedAt: new Date('2026-08-11T01:00:00.000Z'),
        reviewTotalWorkMinutes: 480,
        reviewBaseElapsedWorkMinutes: 0
      }
    },
    async submitReviewVote(value) {
      calls.push(['submit-vote', structuredClone(value)])
      return overrides.voteResult || {
        reviewRoundId: value.input.reviewRoundId,
        status: 'approved',
        nodeStatus: 'completed',
        lineStatus: 'active',
        nextNodeId: 'line-1-node-002'
      }
    },
    async listPendingReviews(value) {
      calls.push(['list-pending', structuredClone(value)])
      return overrides.pendingResult || { items: [], page: value.query.page, pageSize: value.query.pageSize, hasMore: false }
    },
    async getReviewDetail(value) {
      calls.push(['review-detail', structuredClone(value)])
      return overrides.detailResult || { reviewRoundId: value.reviewRoundId }
    },
    async listNotifications(value) {
      calls.push(['list-notifications', structuredClone(value)])
      return overrides.notificationResult || { items: [], page: value.query.page, pageSize: value.query.pageSize, hasMore: false }
    },
    async markNotificationRead(value) {
      calls.push(['mark-notification', structuredClone(value)])
      return { notificationId: value.notificationId, read: true }
    }
  }
  const workTimeService = {
    async workingMinutesBetween(startAt, endAt) {
      calls.push(['work-minutes', { startAt: new Date(startAt), endAt: new Date(endAt) }])
      if (startAt.getTime() === new Date('2026-08-11T01:00:00.000Z').getTime() &&
          endAt.getTime() === new Date('2026-08-11T03:00:00.000Z').getTime() &&
          overrides.reviewElapsed) return overrides.reviewElapsed
      return overrides.processingTime || { status: 'calculated', minutes: 120, calendarVersion: 'calendar-a' }
    },
    async tryAddWorkMinutes() {
      return overrides.reviewDue || {
        status: 'calculated', dueAt: new Date('2026-08-12T06:00:00.000Z'), calendarVersion: 'calendar-a'
      }
    }
  }
  return {
    calls,
    service: createReviewService({
      feedbackRepository,
      reviewRepository: { ...reviewRepository, ...overrides.reviewRepository },
      workTimeService: overrides.workTimeService || workTimeService,
      businessSearchClient: overrides.businessSearchClient,
      clock: overrides.clock || (() => new Date('2026-08-11T03:00:00.000Z'))
    })
  }
}

test('提交审核同步检索索引并剥离内部信封', async () => {
  const publicResult = {
    reviewRoundId: 'review-feedback-current', status: 'pending',
    nodeStatus: 'pending_review', evidenceIds: ['evidence-a', 'evidence-b']
  }
  const envelope = { actorId: 'processor-1', businessLineId: 'line-1', sourceVersion: 2 }
  const indexed = []
  const value = harness({
    reviewRepository: {
      async createReviewRound() { return { publicResult, searchEnvelope: envelope } }
    },
    businessSearchClient: { async ensureIndexed(item) { indexed.push(item) } }
  })
  assert.equal(await value.service.submitNodeForReview({ actor: ACTOR, input: input() }), publicResult)
  assert.deepEqual(indexed, [envelope])
})

test('审核投票同步检索索引且索引失败仍返回权威成功', async () => {
  const publicResult = {
    reviewRoundId: 'review-feedback-current', status: 'approved',
    nodeStatus: 'completed', lineStatus: 'active', nextNodeId: 'line-1-node-002'
  }
  const value = harness({
    reviewRepository: {
      async submitReviewVote() {
        return { publicResult, searchEnvelope: {
          actorId: 'reviewer-1', businessLineId: 'line-1', sourceVersion: 3
        } }
      }
    },
    businessSearchClient: { async ensureIndexed() { throw new Error('timeout') } }
  })
  assert.deepEqual(await value.service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
      decision: 'approve', comment: '', requestKey: 'vote-index-1'
    }
  }), { ...publicResult, searchIndexStatus: 'pending' })
})

test('提交审核采用当前轮最新字段与全部有效凭证并计算双时限快照', async () => {
  const { calls, service } = harness()
  const result = await service.submitNodeForReview({ actor: ACTOR, input: input() })

  assert.deepEqual(result.evidenceIds, ['evidence-a', 'evidence-b'])
  const create = calls.find(call => call[0] === 'create')[1]
  assert.equal(create.timing.processingElapsedWorkMinutes, 120)
  assert.equal(create.timing.processingRemainingWorkMinutes, 1200)
  assert.equal(create.timing.processingRoundTimingStatus, 'calculated')
  assert.equal(create.timing.processingRoundWorkMinutes, 120)
  assert.equal(create.timing.processingRoundCalendarVersion, 'calendar-a')
  assert.deepEqual(create.timing.processingRoundStartedAt, new Date('2026-08-11T01:00:00.000Z'))
  assert.deepEqual(create.timing.processingRoundEndedAt, new Date('2026-08-11T03:00:00.000Z'))
  assert.equal(create.timing.reviewRemainingWorkMinutes, 480)
  assert.equal(create.timing.reviewDueStatus, 'calculated')
  assert.equal(create.requestKeyHash.length, 64)
  assert.equal(create.inputHash.length, 64)
  assert.equal(JSON.stringify(create).includes('review-request-1'), false)
})

test('处理说明属于审核草稿摘要且不同说明生成不同摘要', async () => {
  const first = harness({ draft: draft({ processingComment: '说明甲' }) })
  const second = harness({ draft: draft({ processingComment: '说明乙' }) })

  await first.service.submitNodeForReview({ actor: ACTOR, input: input() })
  await second.service.submitNodeForReview({ actor: ACTOR, input: input() })

  const firstCreate = first.calls.find(call => call[0] === 'create')[1]
  const secondCreate = second.calls.find(call => call[0] === 'create')[1]
  assert.equal(firstCreate.draft.processingComment, '说明甲')
  assert.equal(secondCreate.draft.processingComment, '说明乙')
  assert.notEqual(firstCreate.draftHash, secondCreate.draftHash)
})

test('真实秒级处理时长可以提交审核并冻结完整分钟快照', async () => {
  const baseDraft = draft()
  const { calls, service } = harness({
    workTimeService: realWorkTimeService(),
    clock: () => new Date('2026-08-11T11:00:30.000+08:00'),
    draft: draft({
      node: {
        ...baseDraft.node,
        processingStartedAt: new Date('2026-08-11T09:00:00.000+08:00')
      }
    })
  })

  await service.submitNodeForReview({ actor: ACTOR, input: input() })
  const timing = calls.find(call => call[0] === 'create')[1].timing
  assert.equal(timing.processingElapsedWorkMinutes, 120)
  assert.equal(Number.isSafeInteger(timing.processingElapsedWorkMinutes), true)
})

test('服务入口对已锁定审核轮次执行重新授权的同请求幂等预检', async () => {
  const existing = {
    reviewRoundId: 'review-feedback-current', status: 'pending',
    nodeStatus: 'pending_review', evidenceIds: ['evidence-a', 'evidence-b']
  }
  const { calls, service } = harness({ retry: existing })

  assert.deepEqual(await service.submitNodeForReview({ actor: ACTOR, input: input() }), existing)
  assert.deepEqual(calls.map(call => call[0]), ['inspect-retry', 'locked-draft', 'confirm-retry'])
  assert.equal(calls[0][1].requestKeyHash.length, 64)
  assert.equal(calls[0][1].inputHash.length, 64)
  assert.equal(JSON.stringify(calls[0][1]).includes('review-request-1'), false)
})

test('日历缺失不阻断审核轮次创建而是保存待补算截止时间', async () => {
  const { calls, service } = harness({
    processingTime: { status: 'pending_calendar', minutes: null, missingDate: '2026-08-11' },
    reviewDue: { status: 'pending_calendar', dueAt: null, missingDate: '2026-08-12' }
  })

  await service.submitNodeForReview({ actor: ACTOR, input: input() })
  const timing = calls.find(call => call[0] === 'create')[1].timing
  assert.equal(timing.reviewDueStatus, 'pending_calendar')
  assert.equal(timing.reviewDueAt, null)
  assert.equal(timing.processingTimingStatus, 'pending_calendar')
  assert.equal(timing.processingRoundTimingStatus, 'pending_calendar')
  assert.equal(timing.processingRoundWorkMinutes, null)
  assert.equal(timing.processingRoundCalendarVersion, null)
  assert.deepEqual(timing.processingRoundStartedAt, new Date('2026-08-11T01:00:00.000Z'))
  assert.deepEqual(timing.processingRoundEndedAt, new Date('2026-08-11T03:00:00.000Z'))
})

test('提交审核输入和账号必须采用严格自有属性结构', async () => {
  const { service } = harness()
  await assert.rejects(
    service.submitNodeForReview({ actor: { _id: 'processor-1', status: 'disabled' }, input: input() }),
    error => error.code === 'FORBIDDEN'
  )
  const inherited = Object.create(input())
  await assert.rejects(
    service.submitNodeForReview({ actor: ACTOR, input: inherited }),
    error => error.code === 'VALIDATION_ERROR'
  )
})

test('审核投票只接受 approve/reject 且驳回原因必填', async () => {
  const { service } = harness()
  const base = {
    reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
    decision: 'reject', comment: '   ', requestKey: 'vote-request-1'
  }
  await assert.rejects(
    service.submitReviewVote({ actor: { _id: 'reviewer-1', status: 'active' }, input: base }),
    error => error.code === 'REVIEW_COMMENT_REQUIRED'
  )
  await assert.rejects(
    service.submitReviewVote({
      actor: { _id: 'reviewer-1', status: 'active' },
      input: { ...base, decision: 'approved', comment: '完整' }
    }),
    error => error.code === 'VOTE_DECISION_INVALID'
  )
})

test('审核通过为下一节点计算处理截止且请求键只传递摘要', async () => {
  const { calls, service } = harness({
    reviewElapsed: { status: 'calculated', minutes: 180, calendarVersion: 'calendar-review' }
  })
  const result = await service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
      decision: 'approve', comment: '确认', requestKey: 'vote-request-1'
    }
  })

  assert.equal(result.status, 'approved')
  assert.deepEqual(calls.map(call => call[0]).slice(-3), [
    'prepare-vote', 'work-minutes', 'submit-vote'
  ])
  const submitted = calls.at(-1)[1]
  assert.equal(submitted.timing.processingDueStatus, 'calculated')
  assert.equal(submitted.timing.processingDueAt.toISOString(), '2026-08-12T06:00:00.000Z')
  assert.equal(submitted.timing.reviewTimingStatus, 'calculated')
  assert.equal(submitted.timing.reviewElapsedWorkMinutes, 180)
  assert.equal(submitted.timing.reviewRemainingWorkMinutes, 300)
  assert.equal(submitted.timing.reviewOverdueWorkMinutes, 0)
  assert.equal(submitted.timing.reviewCalendarVersion, 'calendar-review')
  assert.equal(submitted.timing.reviewResponseTimingStatus, 'calculated')
  assert.equal(submitted.timing.reviewResponseWorkMinutes, 180)
  assert.equal(submitted.timing.reviewResponseCalendarVersion, 'calendar-review')
  assert.deepEqual(submitted.timing.reviewResponseStartedAt,
    new Date('2026-08-11T01:00:00.000Z'))
  assert.deepEqual(submitted.timing.reviewResponseEndedAt,
    new Date('2026-08-11T03:00:00.000Z'))
  assert.equal(submitted.requestKeyHash.length, 64)
  assert.equal(submitted.inputHash.length, 64)
  assert.equal(JSON.stringify(submitted).includes('vote-request-1'), false)
})

test('审核通过进入追加节点待决定时不计算处理截止', async () => {
  let dueCalls = 0
  const value = harness({
    voteContext: {
      transition: 'await_optional_decision',
      processingWorkMinutes: null,
      reviewStartedAt: new Date('2026-08-11T01:00:00.000Z'),
      reviewTotalWorkMinutes: 480,
      reviewBaseElapsedWorkMinutes: 0
    },
    workTimeService: {
      async workingMinutesBetween() {
        return { status: 'calculated', minutes: 120, calendarVersion: 'calendar-a' }
      },
      async tryAddWorkMinutes() {
        dueCalls += 1
        throw new Error('追加节点待决定时不应计算处理截止')
      }
    },
    voteResult: {
      reviewRoundId: 'review-feedback-current', status: 'approved',
      nodeStatus: 'completed', lineStatus: 'active',
      nextNodeId: 'line-1-node-002', optionalTailState: 'pending'
    }
  })

  const result = await value.service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
      decision: 'approve', comment: '', requestKey: 'vote-optional-tail'
    }
  })

  assert.equal(result.optionalTailState, 'pending')
  assert.equal(dueCalls, 0)
  const submitted = value.calls.at(-1)[1]
  assert.equal(Object.hasOwn(submitted.timing, 'processingDueStatus'), false)
})

test('审核通过进入通用人工分支待决定时不计算候选节点截止', async () => {
  let dueCalls = 0
  const value = harness({
    voteContext: {
      transition: 'await_manual_decision',
      routeTransition: { kind: 'await_manual_decision' },
      processingWorkMinutes: null,
      reviewStartedAt: new Date('2026-08-11T01:00:00.000Z'),
      reviewTotalWorkMinutes: 480,
      reviewBaseElapsedWorkMinutes: 0
    },
    workTimeService: {
      async workingMinutesBetween() {
        return { status: 'calculated', minutes: 120, calendarVersion: 'calendar-a' }
      },
      async tryAddWorkMinutes() {
        dueCalls += 1
        throw new Error('人工分支待决定时不应计算候选节点截止')
      }
    },
    voteResult: {
      reviewRoundId: 'review-feedback-current', status: 'approved',
      nodeStatus: 'awaiting_decision', lineStatus: 'active', nextNodeId: null,
      routeTransition: { kind: 'await_manual_decision' }
    }
  })

  const result = await value.service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
      decision: 'approve', comment: '', requestKey: 'vote-manual-route'
    }
  })

  assert.equal(result.nodeStatus, 'awaiting_decision')
  assert.equal(dueCalls, 0)
  assert.equal(Object.hasOwn(value.calls.at(-1)[1].timing, 'processingDueStatus'), false)
})

test('真实秒级审核时长只结算完整分钟', async () => {
  const { calls, service } = harness({
    workTimeService: realWorkTimeService(),
    clock: () => new Date('2026-08-11T11:00:30.000+08:00'),
    voteContext: {
      transition: 'next_node',
      processingWorkMinutes: 1320,
      reviewStartedAt: new Date('2026-08-11T09:00:00.000+08:00'),
      reviewTotalWorkMinutes: 480,
      reviewBaseElapsedWorkMinutes: 0
    }
  })

  await service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current',
      expectedRoundVersion: 1,
      decision: 'approve',
      comment: '确认',
      requestKey: 'vote-seconds-1'
    }
  })

  const timing = calls.at(-1)[1].timing
  assert.equal(timing.reviewElapsedWorkMinutes, 120)
  assert.equal(timing.reviewRemainingWorkMinutes, 360)
  assert.equal(timing.reviewOverdueWorkMinutes, 0)
  assert.equal(Number.isSafeInteger(timing.reviewElapsedWorkMinutes), true)
})

test('驳回返工继承剩余处理分钟且日历缺失不阻断投票', async () => {
  const { calls, service } = harness({
    voteContext: {
      transition: 'rework', processingWorkMinutes: 1200,
      reviewStartedAt: new Date('2026-08-11T01:00:00.000Z'),
      reviewTotalWorkMinutes: 480, reviewBaseElapsedWorkMinutes: 0
    },
    reviewElapsed: { status: 'pending_calendar', minutes: null, missingDate: '2026-08-11' },
    reviewDue: { status: 'pending_calendar', dueAt: null, missingDate: '2026-08-12' },
    voteResult: {
      reviewRoundId: 'review-feedback-current', status: 'rejected',
      nodeStatus: 'in_progress', lineStatus: 'active', nextNodeId: null
    }
  })
  const result = await service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
      decision: 'reject', comment: '字段不完整', requestKey: 'vote-reject-1'
    }
  })

  assert.equal(result.status, 'rejected')
  const submitted = calls.at(-1)[1]
  assert.equal(submitted.timing.processingDueStatus, 'pending_calendar')
  assert.equal(submitted.timing.processingDueAt, null)
  assert.equal(submitted.timing.reviewTimingStatus, 'pending_calendar')
  assert.equal(submitted.timing.reviewElapsedWorkMinutes, 0)
  assert.equal(submitted.timing.reviewRemainingWorkMinutes, 480)
  assert.equal(submitted.timing.reviewResponseTimingStatus, 'pending_calendar')
  assert.equal(submitted.timing.reviewResponseWorkMinutes, null)
  assert.equal(submitted.timing.reviewResponseCalendarVersion, null)
  assert.deepEqual(submitted.timing.reviewResponseStartedAt,
    new Date('2026-08-11T01:00:00.000Z'))
  assert.deepEqual(submitted.timing.reviewResponseEndedAt,
    new Date('2026-08-11T03:00:00.000Z'))
})

test('终态投票同请求重试不再计算截止时间并只向仓储传递摘要', async () => {
  const { calls, service } = harness({
    voteContext: { transition: 'finalized_retry' },
    reviewDue: null,
    voteResult: {
      reviewRoundId: 'review-feedback-current', status: 'approved',
      nodeStatus: 'completed', lineStatus: 'active', nextNodeId: 'line-1-node-002'
    }
  })
  const result = await service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current', expectedRoundVersion: 1,
      decision: 'approve', comment: '', requestKey: 'vote-final-retry'
    }
  })

  assert.equal(result.status, 'approved')
  const prepared = calls.find(call => call[0] === 'prepare-vote')[1]
  assert.equal(prepared.requestKeyHash.length, 64)
  assert.equal(prepared.inputHash.length, 64)
  const submitted = calls.at(-1)[1]
  assert.deepEqual(Object.keys(submitted.timing), ['transitionAt'])
  assert.equal(JSON.stringify([prepared, submitted]).includes('vote-final-retry'), false)
})

test('审核查询与通知服务严格校验当前账号、分页和文档编号', async () => {
  const { calls, service } = harness()
  const actor = { _id: 'reviewer-1', status: 'active' }

  await service.listMyPendingReviews({ actor, query: { page: 2, pageSize: 10 } })
  await service.getReviewDetail({ actor, reviewRoundId: 'review-feedback-current' })
  await service.listMyNotifications({ actor, query: {} })
  await service.markNotificationRead({ actor, notificationId: 'notification-1' })

  assert.deepEqual(calls.slice(-4), [
    ['list-pending', { actor, query: { page: 2, pageSize: 10 } }],
    ['review-detail', { actor, reviewRoundId: 'review-feedback-current' }],
    ['list-notifications', { actor, query: { page: 1, pageSize: 20 } }],
    ['mark-notification', { actor, notificationId: 'notification-1' }]
  ])

  for (const operation of [
    () => service.listMyPendingReviews({ actor, query: { page: 6, pageSize: 20 } }),
    () => service.listMyNotifications({ actor, query: { pageSize: 51 } }),
    () => service.getReviewDetail({ actor, reviewRoundId: '../round' }),
    () => service.markNotificationRead({ actor: { _id: 'reviewer-1', status: 'disabled' }, notificationId: 'notification-1' })
  ]) {
    await assert.rejects(operation(), error => ['FORBIDDEN', 'INVALID_PAGINATION', 'VALIDATION_ERROR'].includes(error.code))
  }
})

test('通知已读入口只额外接受严格的凭证保留提醒编号', async () => {
  const { calls, service } = harness()
  const actor = { _id: 'reviewer-1', status: 'active' }

  for (const days of [1, 7, 15]) {
    const notificationId = `evidence-retention:business-1:${days}`
    const result = await service.markNotificationRead({ actor, notificationId })
    assert.deepEqual(result, { notificationId, read: true })
    assert.deepEqual(calls.at(-1), ['mark-notification', { actor, notificationId }])
  }

  for (const notificationId of [
    'evidence_retention:business-1:15',
    'evidence-retention::15',
    'evidence-retention:business-1:0',
    'evidence-retention:business-1:2',
    'evidence-retention:business-1:16',
    'evidence-retention:../business-1:15',
    'evidence-retention:business-1:15:extra',
    `evidence-retention:${'a'.repeat(129)}:15`
  ]) {
    await assert.rejects(
      service.markNotificationRead({ actor, notificationId }),
      error => error && error.code === 'VALIDATION_ERROR'
    )
  }
})
