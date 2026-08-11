const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createCloudReviewRepository } = require('../lib/cloud-review-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const NOW = new Date('2026-08-11T03:00:00.000Z')

function seed(overrides = {}) {
  return {
    users: overrides.users || [
      { _id: 'processor-1', status: 'active' },
      { _id: 'reviewer-1', status: 'active' },
      { _id: 'reviewer-2', status: 'active' }
    ],
    business_lines: overrides.lines || [{
      _id: 'line-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerUserIds: [], memberUserIds: ['processor-1', 'reviewer-1', 'reviewer-2'], version: 1
    }],
    business_nodes: overrides.nodes || [{
      _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-20260811-0001-N001',
      name: '资料收集', sequence: 0, status: 'in_progress', version: 4,
      workflowMode: 'review', processorUserIds: ['processor-1'],
      reviewerUserIds: ['reviewer-1', 'reviewer-2'], reviewMode: 'all',
      processingRoundNumber: 1, reviewRoundNumber: 0,
      processingSlaWorkHours: 22, reviewSlaWorkHours: 8,
      latestFeedbackId: 'feedback-current', latestFeedbackRevision: 2
    }],
    node_feedback: overrides.feedback || [{
      _id: 'feedback-current', businessLineId: 'line-1', nodeId: 'node-1',
      publishState: 'published', revision: 2, processingRoundNumber: 1,
      action: 'save_progress', submittedBy: 'processor-1'
    }],
    node_review_rounds: overrides.rounds || [],
    notifications: overrides.notifications || [],
    audit_logs: overrides.audit || []
  }
}

function request(overrides = {}) {
  const requestKeyHash = crypto.createHash('sha256').update('request').digest('hex')
  const inputHash = crypto.createHash('sha256').update('input').digest('hex')
  return {
    actor: { _id: 'processor-1', status: 'active' },
    input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4,
      requestKey: 'must-not-be-stored'
    },
    draft: {
      feedbackId: 'feedback-current', feedbackRevision: 2, processingRoundNumber: 1,
      fieldSnapshots: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '完成' }],
      evidenceIds: ['evidence-a', 'evidence-b'], evidenceTotalBytes: 1024
    },
    timing: {
      processingTimingStatus: 'calculated', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      processingCalendarVersion: 'calendar-a', reviewStartedAt: NOW,
      reviewRemainingWorkMinutes: 480, reviewElapsedWorkMinutes: 0,
      reviewOverdueWorkMinutes: 0, reviewDueStatus: 'calculated',
      reviewDueAt: new Date('2026-08-12T06:00:00.000Z'), reviewCalendarVersion: 'calendar-a'
    },
    requestKeyHash,
    inputHash,
    ...overrides
  }
}

function harness(overrides = {}) {
  const fake = createFakeCloudDatabase(overrides.seed || seed(overrides))
  const repository = createCloudReviewRepository({ db: fake.db, clock: () => new Date(NOW) })
  return { fake, repository }
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
  assert.equal(round.requestKeyHash, request().requestKeyHash)
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
