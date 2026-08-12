'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudReminderRepository } = require('../lib/cloud-reminder-repository')

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

test('处理提醒在事务内对停用账号、业务终态、节点轮次和混合账号关系失败关闭', async () => {
  const cases = [
    data => { data.users[0].status = 'disabled' },
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
    reviewRoundId: 'round-1', reviewerUserId: 'reviewer-a', decision: 'approved'
  }]
  return data
}

test('会签只提醒未投票审核人并按轮次、审核人和小时去重', async () => {
  const { fake, repository } = harness(reviewSeed())
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-a', accumulatedWorkHour: 1
  }), { created: false })
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1
  }), { created: true })
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1
  }), { created: false })
  const note = fake.documents('notifications')[0]
  assert.deepEqual(note.recipientUserIds, ['reviewer-b'])
  assert.match(note._id, /^review-reminder-/)
})

test('或签结束、任一驳回后及换轮次均不再创建审核提醒', async () => {
  for (const data of [reviewSeed({ mode: 'any', status: 'approved' }), reviewSeed({ status: 'rejected' })]) {
    const { fake, repository } = harness(data)
    assert.deepEqual(await repository.createReviewReminder({
      reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1
    }), { created: false })
    assert.equal(fake.documents('notifications').length, 0)
  }
  const changed = reviewSeed()
  changed.business_nodes[0].activeReviewRoundId = 'round-2'
  const { fake, repository } = harness(changed)
  assert.deepEqual(await repository.createReviewReminder({
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1
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
      reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserId: 'reviewer-b', accumulatedWorkHour: 1
    }), { created: false })
    assert.equal(fake.documents('notifications').length, 0)
  }
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
