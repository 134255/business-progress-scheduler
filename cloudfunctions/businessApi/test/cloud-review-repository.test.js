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
      { _id: 'manager-1', status: 'active' },
      { _id: 'reviewer-1', status: 'active' },
      { _id: 'reviewer-2', status: 'active' }
    ],
    business_lines: overrides.lines || [{
      _id: 'line-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerUserIds: ['manager-1'], memberUserIds: ['processor-1', 'reviewer-1', 'reviewer-2'], version: 1
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
  const draftHash = crypto.createHash('sha256').update('draft').digest('hex')
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
    draftHash,
    ...overrides
  }
}

function retryValue(value) {
  const { requestKey: ignoredRequestKey, ...safeInput } = value.input
  const draftHash = crypto.createHash('sha256').update(JSON.stringify([
    value.actor._id, safeInput.businessLineId, safeInput.nodeId, safeInput.expectedNodeVersion,
    value.draft.feedbackId, value.draft.feedbackRevision, value.draft.processingRoundNumber,
    value.draft.fieldSnapshots, value.draft.evidenceIds, value.draft.evidenceTotalBytes
  ])).digest('hex')
  return {
    actor: value.actor, input: safeInput, requestKeyHash: value.requestKeyHash,
    inputHash: value.inputHash, draft: value.draft, draftHash,
    reviewRoundId: `review-${value.draft.feedbackId}`
  }
}

function harness(overrides = {}) {
  const fake = createFakeCloudDatabase(overrides.seed || seed(overrides), {
    transformRead: overrides.transformRead
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
    submittedBy: 'processor-1', submittedNodeVersion: 4, lockedNodeVersion: 5,
    feedbackId: 'feedback-current', feedbackRevision: 2,
    fieldValues: [], evidenceIds: [], evidenceTotalBytes: 0,
    processingTimingStatus: 'calculated', processingElapsedWorkMinutes: 120,
    processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
    reviewStartedAt: NOW, reviewDueStatus: 'calculated',
    reviewDueAt: new Date('2026-08-12T06:00:00.000Z'),
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
  return {
    actor: { _id: actorId, status: 'active' },
    input,
    context: overrides.context || {
      businessLineId: 'line-1', nodeId: 'node-1', transition: 'next_node',
      nextNodeId: 'line-1-node-002', nextNodeVersion: 1,
      processingWorkMinutes: 1320, nodeVersion: 5, roundVersion: 1
    },
    timing: overrides.timing || {
      transitionAt: NOW, processingDueStatus: 'calculated',
      processingDueAt: new Date('2026-08-13T03:00:00.000Z'),
      processingCalendarVersion: 'calendar-a'
    },
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
  assert.equal(round.requestKeyHash, request().requestKeyHash)
  assert.equal(round.processingTimingStatus, 'calculated')
  assert.equal(round.processingElapsedWorkMinutes, 120)
  assert.equal(round.processingRemainingWorkMinutes, 1200)
  assert.equal(round.processingOverdueWorkMinutes, 0)
  assert.equal(round.processingCalendarVersion, 'calendar-a')
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
  assert.equal(fake.documents('notifications').filter(item => item.type === 'node_processing_started').length, 1)
  assert.equal(fake.documents('audit_logs').filter(item => item.action === 'SUBMIT_REVIEW_VOTE').length, 1)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})

test('会签逐票通过、同票同输入幂等且改票冲突', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'all' }) })
  const firstValue = voteRequest('reviewer-1')
  const first = await repository.submitReviewVote(firstValue)
  assert.deepEqual(first, {
    reviewRoundId: 'review-feedback-current', status: 'pending',
    nodeStatus: 'pending_review', lineStatus: 'active', nextNodeId: null
  })
  assert.deepEqual(await repository.submitReviewVote(firstValue), first)
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
      processingDueAt: null, processingCalendarVersion: null
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

test('通过与驳回真实并发时只产生一个确定终态和一组副作用', async () => {
  const { fake, repository } = harness({ seed: votingSeed({ mode: 'all' }) })
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
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length >= 1, true)
  assert.equal(fake.documents('node_review_rounds')[0].status, 'rejected')
  assert.equal(fake.documents('business_nodes').find(node => node._id === 'node-1').status, 'in_progress')
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
