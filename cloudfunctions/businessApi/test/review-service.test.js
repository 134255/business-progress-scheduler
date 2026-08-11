const test = require('node:test')
const assert = require('node:assert/strict')

const { createReviewService } = require('../lib/review-service')

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
    fieldSnapshots: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '最新版' }],
    evidenceIds: ['evidence-a', 'evidence-b'],
    evidenceTotalBytes: 1024,
    ...overrides
  }
}

function harness(overrides = {}) {
  const calls = []
  const feedbackRepository = {
    async getCurrentProcessingRoundDraft(value) {
      calls.push(['draft', structuredClone(value)])
      return overrides.draft || draft()
    }
  }
  const reviewRepository = {
    async createReviewRound(value) {
      calls.push(['create', structuredClone(value)])
      return {
        reviewRoundId: `review-${value.draft.feedbackId}`,
        status: 'pending', nodeStatus: 'pending_review',
        evidenceIds: value.draft.evidenceIds
      }
    }
  }
  const workTimeService = {
    async workingMinutesBetween() {
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
      reviewRepository,
      workTimeService,
      clock: () => new Date('2026-08-11T03:00:00.000Z')
    })
  }
}

test('提交审核采用当前轮最新字段与全部有效凭证并计算双时限快照', async () => {
  const { calls, service } = harness()
  const result = await service.submitNodeForReview({ actor: ACTOR, input: input() })

  assert.deepEqual(result.evidenceIds, ['evidence-a', 'evidence-b'])
  const create = calls.find(call => call[0] === 'create')[1]
  assert.equal(create.timing.processingElapsedWorkMinutes, 120)
  assert.equal(create.timing.processingRemainingWorkMinutes, 1200)
  assert.equal(create.timing.reviewRemainingWorkMinutes, 480)
  assert.equal(create.timing.reviewDueStatus, 'calculated')
  assert.equal(create.requestKeyHash.length, 64)
  assert.equal(create.inputHash.length, 64)
  assert.equal(JSON.stringify(create).includes('review-request-1'), false)
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
