'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const {
  createCloudReminderRepository,
  reviewNotificationId,
  optionalTailDecisionNotificationId
} = require('../lib/cloud-reminder-repository')

const START = new Date('2026-08-11T01:00:00.000Z')

function seed(overrides = {}) {
  return {
    users: [
      { _id: 'processor-a', status: 'active', openid: 'must-not-copy' },
      { _id: 'processor-b', status: 'active' },
      { _id: 'reviewer-a', status: 'active' },
      { _id: 'reviewer-b', status: 'active' }
    ],
    business_lines: [{
      _id: 'line-1', status: 'active', managerUserIds: ['processor-a'],
      memberUserIds: ['processor-a', 'processor-b', 'reviewer-a', 'reviewer-b'],
      currentNodeId: 'node-1'
    }],
    business_nodes: [{
      _id: 'node-1', nodeCode: 'BL-N001', businessLineId: 'line-1', workflowMode: 'review',
      status: 'in_progress', processorUserIds: ['processor-a', 'processor-b'],
      reviewerUserIds: ['reviewer-a', 'reviewer-b'], processingRoundNumber: 1,
      processingStartedAt: START, processingElapsedWorkMinutes: 0,
      processingDueStatus: 'calculated', processingDueAt: new Date('2026-08-13T01:00:00.000Z'),
      nextProcessingReminderWorkHour: 1,
      activeReviewRoundId: null
    }],
    node_review_rounds: [], node_review_votes: [], notifications: [], system_settings: [],
    work_calendar_years: [], work_calendar_entries: [],
    ...overrides
  }
}

function harness(documents = seed()) {
  const fake = createFakeCloudDatabase(documents)
  return { fake, repository: createCloudReminderRepository({ db: fake.db }) }
}

test('处理提醒使用节点和工作小时确定性编号并只保存安全字段', async () => {
  const { fake, repository } = harness()
  const value = { nodeId: 'node-1', processingRoundNumber: 1, accumulatedWorkHour: 1 }
  assert.deepEqual(await repository.createProcessingReminder(value), { created: true })
  assert.deepEqual(await repository.createProcessingReminder(value), { created: false })
  const notes = fake.documents('notifications')
  assert.equal(notes.length, 1)
  assert.match(notes[0]._id, /^processing-reminder-/)
  assert.deepEqual(notes[0].recipientUserIds, ['processor-a', 'processor-b'])
  assert.deepEqual(Object.keys(notes[0]).sort(), [
    '_id', 'accumulatedWorkHour', 'businessLineId', 'createdAt', 'nodeId',
    'recipientUserIds', 'reviewRoundId', 'status', 'type'
  ])
  assert.doesNotMatch(JSON.stringify(notes[0]), /openid|field|evidence|credential|request|summary/i)
})

test('处理提醒在事务内对业务终态、节点轮次和混合账号关系失败关闭', async () => {
  const cases = [
    data => { data.business_lines[0].status = 'completed' },
    data => { data.business_nodes[0].processingRoundNumber = 2 },
    data => { data.business_lines[0].currentNodeId = 'node-other' },
    data => { data.business_nodes[0].processingDueAt = null },
    data => { data.business_nodes[0].processorUserIds = null; data.business_nodes[0].assigneeIds = ['must-not-use-openid'] }
  ]
  for (const mutate of cases) {
    const data = seed(); mutate(data)
    const { fake, repository } = harness(data)
    const result = await repository.createProcessingReminder({
      nodeId: 'node-1', processingRoundNumber: 1, accumulatedWorkHour: 1
    })
    assert.deepEqual(result, { created: false })
    assert.equal(fake.documents('notifications').length, 0)
  }
})

test('截止时间待补算跳过小时提醒且不改写既有管理员日历告警', async () => {
  const data = seed({
    notifications: [{
      _id: 'calendar-warning', type: 'work_calendar_missing', audienceRole: 'super_admin',
      status: 'pending', createdAt: START
    }]
  })
  data.business_nodes[0].processingDueStatus = 'pending_calendar'
  const { fake, repository } = harness(data)
  assert.deepEqual(await repository.createProcessingReminder({
    nodeId: 'node-1', processingRoundNumber: 1, accumulatedWorkHour: 1
  }), { created: false })
  assert.deepEqual(fake.documents('notifications').map(note => note._id), ['calendar-warning'])
})

function reviewSeed({ mode = 'all', status = 'pending', vote = true } = {}) {
  const data = seed()
  data.business_nodes[0] = {
    ...data.business_nodes[0], status: 'pending_review', activeReviewRoundId: 'round-1',
    reviewMode: mode, reviewRoundNumber: 1, reviewDueStatus: 'calculated',
    reviewDueAt: new Date('2026-08-12T09:00:00.000Z')
  }
  data.node_review_rounds = [{
    _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status,
    reviewMode: mode, reviewerUserIds: ['reviewer-a', 'reviewer-b'],
    processingRoundNumber: 1, reviewRoundNumber: 1, reviewStartedAt: START,
    reviewElapsedWorkMinutes: 0, reviewDueStatus: 'calculated',
    reviewDueAt: new Date('2026-08-12T09:00:00.000Z'), nextReviewReminderWorkHour: 1
  }]
  if (vote) data.node_review_votes = [{
    _id: `review-vote-${crypto.createHash('sha256').update('round-1\0reviewer-a').digest('hex')}`,
    reviewRoundId: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
    reviewerUserId: 'reviewer-a', decision: 'approved'
  }]
  data.node_review_rounds[0].voteCount = data.node_review_votes.length
  data.node_review_rounds[0].approvedVoteCount = data.node_review_votes.filter(item => item.decision === 'approved').length
  return data
}

test('会签只提醒未投票审核人并按轮次、审核人和小时去重', async () => {
  const { fake, repository } = harness(reviewSeed())
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-a', accumulatedWorkHour: 1,
    expectedVoteCount: 1, expectedApprovedVoteCount: 1, advanceHour: false
  }), { created: false })
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1,
    expectedVoteCount: 1, expectedApprovedVoteCount: 1, advanceHour: false
  }), { created: true, fulfilled: true })
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1,
    expectedVoteCount: 1, expectedApprovedVoteCount: 1, advanceHour: false
  }), { created: false, fulfilled: true })
  const note = fake.documents('notifications')[0]
  assert.deepEqual(note.recipientUserIds, ['reviewer-b'])
  assert.match(note._id, /^review-reminder-/)
})

test('发起人唯一审核人快照只在未投票时接收审核提醒', async () => {
  const data = reviewSeed({ mode: 'any', vote: false })
  data.business_nodes[0].reviewerAssignmentMode = 'business_creator'
  data.business_nodes[0].reviewerUserIds = ['reviewer-a']
  data.node_review_rounds[0].reviewerUserIds = ['reviewer-a']
  const { fake, repository } = harness(data)
  const value = {
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-a',
    accumulatedWorkHour: 1, expectedVoteCount: 0, expectedApprovedVoteCount: 0,
    advanceHour: false
  }

  assert.deepEqual(await repository.createReviewReminder(value), { created: true, fulfilled: true })
  assert.deepEqual(fake.documents('notifications')[0].recipientUserIds, ['reviewer-a'])

  fake.replace('node_review_votes', `review-vote-${crypto.createHash('sha256')
    .update('round-1\0reviewer-a').digest('hex')}`, {
    _id: `review-vote-${crypto.createHash('sha256').update('round-1\0reviewer-a').digest('hex')}`,
    reviewRoundId: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
    reviewerUserId: 'reviewer-a', decision: 'approved'
  })
  data.node_review_rounds[0].voteCount = 1
  data.node_review_rounds[0].approvedVoteCount = 1
  fake.replace('node_review_rounds', 'round-1', data.node_review_rounds[0])
  assert.deepEqual(await repository.createReviewReminder({ ...value, accumulatedWorkHour: 2 }), { created: false })
})

test('或签结束、任一驳回后及换轮次均不再创建审核提醒', async () => {
  for (const data of [reviewSeed({ mode: 'any', status: 'approved' }), reviewSeed({ status: 'rejected' })]) {
    const { fake, repository } = harness(data)
    assert.deepEqual(await repository.createReviewReminder({
      reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1,
      expectedVoteCount: 1, expectedApprovedVoteCount: 1, advanceHour: true
    }), { created: false })
    assert.equal(fake.documents('notifications').length, 0)
  }
  const changed = reviewSeed()
  changed.business_nodes[0].activeReviewRoundId = 'round-2'
  const { fake, repository } = harness(changed)
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1,
    expectedVoteCount: 1, expectedApprovedVoteCount: 1, advanceHour: true
  }), { created: false })
  assert.equal(fake.documents('notifications').length, 0)
})

test('审核提醒在轮次模式、轮次编号、截止时间或账号关系损坏时失败关闭', async () => {
  const cases = [
    data => { data.node_review_rounds[0].reviewMode = 'any' },
    data => { data.node_review_rounds[0].processingRoundNumber = 2 },
    data => { data.node_review_rounds[0].reviewRoundNumber = 2 },
    data => { data.node_review_rounds[0].reviewDueAt = null },
    data => { data.business_nodes[0].reviewerUserIds = ['reviewer-b', 'reviewer-a'] },
    data => { data.business_lines[0].currentNodeId = 'node-other' }
  ]
  for (const mutate of cases) {
    const data = reviewSeed(); mutate(data)
    const { fake, repository } = harness(data)
    assert.deepEqual(await repository.createReviewReminder({
      reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1,
      expectedVoteCount: 1, expectedApprovedVoteCount: 1, advanceHour: true
    }), { created: false })
    assert.equal(fake.documents('notifications').length, 0)
  }
})

test('或签已有通过票、任一模式已有驳回票及损坏票据均停止提醒', async () => {
  const rejected = reviewSeed({ vote: false })
  rejected.node_review_votes = [{
    _id: `review-vote-${crypto.createHash('sha256').update('round-1\0reviewer-a').digest('hex')}`,
    reviewRoundId: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
    reviewerUserId: 'reviewer-a', decision: 'rejected'
  }]
  rejected.node_review_rounds[0].voteCount = 1
  rejected.node_review_rounds[0].approvedVoteCount = 0
  const anyApproved = reviewSeed({ mode: 'any' })
  const corrupt = reviewSeed()
  corrupt.node_review_votes[0].decision = 'unknown'
  for (const data of [rejected, anyApproved, corrupt]) {
    const { fake, repository } = harness(data)
    const candidates = await repository.listDueReviewReminders({ limit: 40 })
    assert.deepEqual(candidates.items, [])
    const targetReviewer = data === corrupt ? 'reviewer-a' : 'reviewer-b'
    assert.deepEqual(await repository.createReviewReminder({
      reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: targetReviewer,
      accumulatedWorkHour: 1,
      expectedVoteCount: data.node_review_rounds[0].voteCount,
      expectedApprovedVoteCount: data.node_review_rounds[0].approvedVoteCount,
      advanceHour: true
    }), { created: false })
    assert.equal(fake.documents('notifications').length, 0)
  }
})

test('审核票查询用权威总数拒绝超过审核人数的隐藏票', async () => {
  const data = reviewSeed({ vote: false })
  data.node_review_rounds[0].voteCount = 2
  data.node_review_rounds[0].approvedVoteCount = 0
  data.node_review_votes = ['reviewer-a', 'reviewer-b', 'reviewer-extra'].map(reviewerUserId => ({
    _id: `review-vote-${crypto.createHash('sha256').update(`round-1\0${reviewerUserId}`).digest('hex')}`,
    reviewRoundId: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
    reviewerUserId, decision: 'rejected'
  }))
  const { repository } = harness(data)
  const candidates = await repository.listDueReviewReminders({ limit: 40 })
  assert.deepEqual(candidates.items, [])
})

test('审核候选整页损坏仍返回原始页末游标并在有限调用到达第41条', async () => {
  const data = reviewSeed({ vote: false })
  data.business_nodes = Array.from({ length: 41 }, (_, index) => ({
    ...data.business_nodes[0], _id: `node-${String(index).padStart(2, '0')}`,
    nodeCode: `BL-N${index}`, activeReviewRoundId: `round-${String(index).padStart(2, '0')}`
  }))
  data.node_review_rounds = Array.from({ length: 41 }, (_, index) => ({
    ...data.node_review_rounds[0],
    _id: `round-${String(index).padStart(2, '0')}`,
    nodeId: `node-${String(index).padStart(2, '0')}`,
    reviewerUserIds: index < 40 ? null : ['reviewer-a', 'reviewer-b'],
    voteCount: 0, approvedVoteCount: 0
  }))
  data.node_review_votes = []
  const { repository } = harness(data)
  const first = await repository.listDueReviewReminders({ limit: 40 })
  assert.deepEqual(first.items, [])
  assert.equal(first.lastScannedRawId, 'round-39')
  await repository.advanceReminderCursor({ kind: 'review', cursorId: first.lastScannedRawId })
  const second = await repository.listDueReviewReminders({ limit: 40 })
  assert.deepEqual(second.items.map(item => item.reviewRoundId), ['round-40'])
  assert.equal(second.lastScannedRawId, 'round-40')
})

test('损坏审核扫描游标失败关闭', async () => {
  const data = reviewSeed({ vote: false })
  data.system_settings = [{
    _id: 'workflow-reminder-review-cursor', kind: 'workflow_reminder_review', cursorId: '../unsafe'
  }]
  const { repository } = harness(data)
  await assert.rejects(repository.listDueReviewReminders({ limit: 40 }), TypeError)
})

test('索引预算内审核人的单次提醒事务保持不超过100次固定文档操作', async () => {
  const reviewers = Array.from({ length: 10 }, (_, index) => `account-reviewer-${String(index).padStart(2, '0')}`)
  const data = reviewSeed({ vote: false })
  data.users = data.users.filter(user => !user._id.startsWith('reviewer-')).concat(
    reviewers.map(_id => ({ _id, status: 'active' })))
  data.business_lines[0].memberUserIds = ['processor-a', 'processor-b', ...reviewers]
  data.business_nodes[0].reviewerUserIds = reviewers
  data.node_review_rounds[0].reviewerUserIds = reviewers
  data.node_review_rounds[0].voteCount = 0
  data.node_review_rounds[0].approvedVoteCount = 0
  data.notifications = reviewers.slice(1).map(reviewerUserId => ({
    _id: reviewNotificationId('round-1', reviewerUserId, 1),
    type: 'review_reminder', recipientUserIds: [reviewerUserId],
    businessLineId: 'line-1', nodeId: 'node-1', reviewRoundId: 'round-1',
    accumulatedWorkHour: 1, status: 'pending', createdAt: START
  }))
  const { fake, repository } = harness(data)
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: reviewers[0],
    accumulatedWorkHour: 1, expectedVoteCount: 0, expectedApprovedVoteCount: 0,
    advanceHour: false
  }), { created: true, fulfilled: true })
  assert.ok(fake.transactionRuns.at(-1).operations <= 100)
})

test('三十个真实长度审核账号超过索引预算时不写通知', async () => {
  const reviewers = Array.from({ length: 30 }, (_, index) =>
    `account-reviewer-${String(index).padStart(2, '0')}-1234567890abcdef`)
  const data = reviewSeed({ vote: false })
  data.users = data.users.filter(user => !user._id.startsWith('reviewer-')).concat(
    reviewers.map(_id => ({ _id, status: 'active' })))
  data.business_lines[0].memberUserIds = ['processor-a', 'processor-b', ...reviewers]
  data.business_nodes[0].reviewerUserIds = reviewers
  data.node_review_rounds[0].reviewerUserIds = reviewers
  data.node_review_rounds[0].voteCount = 0
  data.node_review_rounds[0].approvedVoteCount = 0
  const { fake, repository } = harness(data)
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: reviewers[0],
    accumulatedWorkHour: 1, expectedVoteCount: 0, expectedApprovedVoteCount: 0,
    advanceHour: false
  }), { created: false })
  assert.equal(fake.documents('notifications').length, 0)
})

test('候选读取与扫描游标均受 40 条硬上限约束', async () => {
  const data = seed()
  data.business_nodes = Array.from({ length: 45 }, (_, index) => ({
    ...data.business_nodes[0], _id: `node-${String(index).padStart(2, '0')}`,
    nodeCode: `BL-N${index}`, nextProcessingReminderWorkHour: 1
  }))
  const { repository } = harness(data)
  await assert.rejects(repository.listDueProcessingReminders({ limit: 41 }), TypeError)
  const first = await repository.listDueProcessingReminders({ limit: 40 })
  assert.equal(first.length, 40)
  await repository.advanceReminderCursor({ kind: 'processing', cursorId: first.at(-1).nodeId })
  const second = await repository.listDueProcessingReminders({ limit: 40 })
  assert.equal(second[0].nodeId, 'node-40')
})

test('扫描游标之后仍保留工作流和截止状态筛选', async () => {
  const data = seed()
  data.business_nodes.push({
    ...data.business_nodes[0], _id: 'node-2', nodeCode: 'BL-N002', workflowMode: 'legacy'
  }, {
    ...data.business_nodes[0], _id: 'node-3', nodeCode: 'BL-N003', processingDueStatus: 'pending_calendar'
  }, {
    ...data.business_nodes[0], _id: 'node-4', nodeCode: 'BL-N004'
  })
  const { repository } = harness(data)
  await repository.advanceReminderCursor({ kind: 'processing', cursorId: 'node-1' })
  assert.deepEqual((await repository.listDueProcessingReminders({ limit: 40 })).map(item => item.nodeId), ['node-4'])
})

test('旧记录首次提醒后初始化小时游标且过期候选不能重复推进', async () => {
  const data = seed()
  delete data.business_nodes[0].nextProcessingReminderWorkHour
  const { fake, repository } = harness(data)
  assert.deepEqual(await repository.createProcessingReminder({
    nodeId: 'node-1', processingRoundNumber: 1, accumulatedWorkHour: 1
  }), { created: true })
  assert.equal(fake.documents('business_nodes')[0].nextProcessingReminderWorkHour, 2)
  assert.deepEqual(await repository.createProcessingReminder({
    nodeId: 'node-1', processingRoundNumber: 1, accumulatedWorkHour: 1
  }), { created: false })
  assert.equal(fake.documents('business_nodes')[0].nextProcessingReminderWorkHour, 2)
})

test('旧记录已有累计耗时时以当前累计小时原子初始化游标', async () => {
  const data = seed()
  data.business_nodes[0].processingElapsedWorkMinutes = 120
  delete data.business_nodes[0].nextProcessingReminderWorkHour
  const { fake, repository } = harness(data)
  assert.deepEqual(await repository.createProcessingReminder({
    nodeId: 'node-1', processingRoundNumber: 1, accumulatedWorkHour: 3
  }), { created: true })
  assert.equal(fake.documents('business_nodes')[0].nextProcessingReminderWorkHour, 4)
})

function decisionSeed() {
  const data = seed()
  Object.assign(data.business_lines[0], {
    optionalTailNodeId: 'node-1', optionalTailState: 'pending'
  })
  Object.assign(data.business_nodes[0], {
    status: 'awaiting_decision', activationMode: 'optional_tail', version: 4,
    reviewerUserIds: [], decisionStartedAt: START, decisionReminderStatus: 'pending',
    nextDecisionReminderWorkHour: 1
  })
  delete data.business_nodes[0].processingDueAt
  delete data.business_nodes[0].processingStartedAt
  delete data.business_nodes[0].nextProcessingReminderWorkHour
  return data
}

test('可选尾节点决定候选分页并用确定性编号向全部活动候选处理人提醒', async () => {
  const { fake, repository } = harness(decisionSeed())
  const candidates = await repository.listDueOptionalTailDecisions({ limit: 40 })
  assert.deepEqual(candidates, {
    items: [{
      nodeId: 'node-1', nodeVersion: 4, decisionStartedAt: START,
      decisionElapsedWorkMinutes: 0, nextReminderWorkHour: 1
    }],
    lastScannedRawId: 'node-1'
  })

  const input = { nodeId: 'node-1', expectedVersion: 4, accumulatedWorkHour: 1 }
  assert.deepEqual(await repository.createOptionalTailDecisionReminder(input), { created: true })
  assert.deepEqual(await repository.createOptionalTailDecisionReminder(input), { created: false })
  const notification = fake.documents('notifications')[0]
  assert.equal(notification._id, optionalTailDecisionNotificationId('node-1', 1))
  assert.equal(notification.type, 'optional_tail_decision_reminder')
  assert.deepEqual(notification.recipientUserIds, ['processor-a', 'processor-b'])
  assert.equal(notification.reviewRoundId, null)
  assert.equal(fake.documents('business_nodes')[0].nextDecisionReminderWorkHour, 2)
})

test('带审核人的可选尾节点在待决定阶段仍向候选处理人发送小时提醒', async () => {
  const data = decisionSeed()
  data.business_nodes[0].reviewerUserIds = ['reviewer-a']
  const { fake, repository } = harness(data)

  assert.deepEqual(await repository.createOptionalTailDecisionReminder({
    nodeId: 'node-1', expectedVersion: 4, accumulatedWorkHour: 1
  }), { created: true })
  assert.deepEqual(fake.documents('notifications')[0].recipientUserIds,
    ['processor-a', 'processor-b'])
})

test('通用人工分支提醒只发送给开启目标节点的活动处理人', async () => {
  const data = seed()
  Object.assign(data.business_lines[0], {
    flowSchemaVersion: 2, awaitingManualDecision: true, currentNodeId: 'node-1'
  })
  Object.assign(data.business_nodes[0], {
    status: 'awaiting_decision', routeState: 'awaiting_manual_decision', version: 4,
    next: { mode: 'manual', activateTargetNodeId: 'node-target', skipTargetNodeId: 'end' },
    decisionStartedAt: START, decisionElapsedWorkMinutes: 0,
    decisionReminderStatus: 'pending', nextDecisionReminderWorkHour: 1
  })
  delete data.business_nodes[0].processingDueAt
  delete data.business_nodes[0].processingStartedAt
  data.business_nodes.push({
    _id: 'node-target', businessLineId: 'line-1', status: 'waiting', routeState: 'dormant',
    processorUserIds: ['processor-b'], reviewerUserIds: [], processingSlaWorkHours: 8,
    processingDueStatus: 'not_started', processingDueAt: null, version: 1
  })
  const { fake, repository } = harness(data)
  const candidates = await repository.listDueOptionalTailDecisions({ limit: 40 })
  assert.deepEqual(candidates.items.map(item => item.nodeId), ['node-1'])
  assert.deepEqual(await repository.createOptionalTailDecisionReminder({
    nodeId: 'node-1', expectedVersion: 4, accumulatedWorkHour: 1
  }), { created: true })
  const notification = fake.documents('notifications')[0]
  assert.equal(notification.type, 'node_route_decision_reminder')
  assert.deepEqual(notification.recipientUserIds, ['processor-b'])
})

test('可选尾节点决定提醒只发送给当前活动候选处理人', async () => {
  const data = decisionSeed()
  data.users[0].status = 'disabled'
  const { fake, repository } = harness(data)

  assert.deepEqual(await repository.createOptionalTailDecisionReminder({
    nodeId: 'node-1', expectedVersion: 4, accumulatedWorkHour: 1
  }), { created: true })
  assert.deepEqual(fake.documents('notifications')[0].recipientUserIds, ['processor-b'])
  assert.equal(fake.documents('business_nodes')[0].nextDecisionReminderWorkHour, 2)
})

test('可选尾节点决定提醒在状态、版本、成员或账号变化时失败关闭', async () => {
  const cases = [
    data => { data.business_lines[0].optionalTailState = 'skipped' },
    data => { data.business_nodes[0].status = 'ready' },
    data => { data.business_nodes[0].activationMode = 'required' },
    data => { data.business_nodes[0].version = 5 },
    data => { data.business_lines[0].memberUserIds = ['processor-a'] }
  ]
  for (const mutate of cases) {
    const data = decisionSeed(); mutate(data)
    const { fake, repository } = harness(data)
    assert.deepEqual(await repository.createOptionalTailDecisionReminder({
      nodeId: 'node-1', expectedVersion: 4, accumulatedWorkHour: 1
    }), { created: false })
    assert.equal(fake.documents('notifications').length, 0)
  }
})

test('可选尾节点决定扫描查询与部署索引契约一致', async () => {
  const { fake, repository } = harness(decisionSeed())
  await repository.listDueOptionalTailDecisions({ limit: 40 })

  const query = fake.queryCalls.find(call => call.collection === 'business_nodes' &&
    call.criteria.status === 'awaiting_decision' && call.criteria.activationMode === 'optional_tail')
  assert.equal(query.criteria.decisionReminderStatus, 'pending')
  assert.deepEqual(query.order, [['_id', 'asc']])
  const routeQuery = fake.queryCalls.find(call => call.collection === 'business_nodes' &&
    call.criteria.status === 'awaiting_decision' && call.criteria.routeState === 'awaiting_manual_decision')
  assert.equal(routeQuery.criteria.decisionReminderStatus, 'pending')
  assert.deepEqual(routeQuery.order, [['_id', 'asc']])

  const manual = fs.readFileSync(path.resolve(__dirname,
    '../../../docs/deployment/template-node-fields-setup.md'), 'utf8')
  assert.match(manual,
    /`business_nodes` \| `status` 升序、`activationMode` 升序、`decisionReminderStatus` 升序、`_id` 升序 \| 否 \| 可选追加节点待决定提醒有界扫描/)
  const branchManual = fs.readFileSync(path.resolve(__dirname,
    '../../../docs/deployment/branch-workflow-v2.md'), 'utf8')
  assert.match(branchManual,
    /`business_nodes` \| `status ASC`, `routeState ASC`, `decisionReminderStatus ASC`, `_id ASC` \| 通用人工路由待决定提醒有界扫描/)
})

test('处理提醒只发送给当前活动候选处理人且不被其他停用候选人阻断', async () => {
  const data = seed()
  data.users[0].status = 'disabled'
  const { fake, repository } = harness(data)

  assert.deepEqual(await repository.createProcessingReminder({
    nodeId: 'node-1', processingRoundNumber: 1, accumulatedWorkHour: 1
  }), { created: true })
  assert.deepEqual(fake.documents('notifications')[0].recipientUserIds, ['processor-b'])
  assert.equal(fake.documents('business_nodes')[0].nextProcessingReminderWorkHour, 2)
})
