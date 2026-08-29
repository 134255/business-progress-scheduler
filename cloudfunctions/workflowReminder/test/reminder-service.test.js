'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createReminderService } = require('../lib/reminder-service')

const NOW = new Date('2026-08-11T04:30:00.000Z')

function harness({ processing = [], review = [], decision = [], working = true, minutes = 90 } = {}) {
  const calls = { processing: [], review: [], decision: [], cursors: [], limits: [] }
  const reminderRepository = {
    async listDueProcessingReminders({ limit }) { calls.limits.push(limit); return processing.slice(0, limit) },
    async listDueReviewReminders({ limit }) {
      calls.limits.push(limit)
      const items = review.slice(0, limit)
      const lastId = items.length ? items.at(-1).reviewRoundId : null
      return { items, lastScannedRawId: typeof lastId === 'string' ? lastId : null }
    },
    async listDueOptionalTailDecisions({ limit }) {
      calls.limits.push(limit)
      const items = decision.slice(0, limit)
      return { items, lastScannedRawId: items.length ? items.at(-1).nodeId : null }
    },
    async createProcessingReminder(value) { calls.processing.push(value); return { created: true } },
    async createReviewReminder(value) { calls.review.push(value); return { created: true, fulfilled: true } },
    async createOptionalTailDecisionReminder(value) { calls.decision.push(value); return { created: true } },
    async advanceReminderCursor(value) { calls.cursors.push(value) }
  }
  const workTimeService = {
    async isWorkingInstant() { return { status: 'calculated', isWorking: working } },
    async workingMinutesBetween() { return { status: 'calculated', minutes } }
  }
  return { calls, service: createReminderService({ reminderRepository, workTimeService }) }
}

test('每累计一个完整工作小时创建提醒且逾期后继续', async () => {
  const processing = [{
    nodeId: 'node-1', processingRoundNumber: 2,
    processingStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    processingElapsedWorkMinutes: 120, nextReminderWorkHour: 3
  }]
  const { service, calls } = harness({ processing, minutes: 75 })
  assert.deepEqual(await service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 1, reviewCreated: 0, decisionCreated: 0
  })
  assert.equal(calls.processing[0].accumulatedWorkHour, 3)
  assert.equal(calls.cursors[0].kind, 'processing')
})

test('未满下一累计小时或工作时间外均不创建提醒', async () => {
  const candidate = {
    nodeId: 'node-1', processingRoundNumber: 1,
    processingStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    processingElapsedWorkMinutes: 0, nextReminderWorkHour: 2
  }
  const inside = harness({ processing: [candidate], minutes: 119 })
  assert.deepEqual(await inside.service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 0, decisionCreated: 0
  })
  const outside = harness({ processing: [candidate], working: false, minutes: 180 })
  assert.deepEqual(await outside.service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 0, decisionCreated: 0
  })
})

test('秒和毫秒只在完整累计工作小时到达后提醒', async () => {
  const candidate = {
    nodeId: 'node-1', processingRoundNumber: 1,
    processingStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    processingElapsedWorkMinutes: 0, nextReminderWorkHour: 1
  }
  const before = harness({ processing: [candidate], minutes: 59 + 59999 / 60000 })
  assert.deepEqual(await before.service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 0, decisionCreated: 0
  })
  const exact = harness({ processing: [candidate], minutes: 60 })
  assert.deepEqual(await exact.service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 1, reviewCreated: 0, decisionCreated: 0
  })
  const after = harness({ processing: [candidate], minutes: 60.5 })
  assert.deepEqual(await after.service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 1, reviewCreated: 0, decisionCreated: 0
  })
})

test('会签只把未投票审核人交给事务创建并按审核人计数', async () => {
  const review = [{
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserIds: ['reviewer-a', 'reviewer-b'],
    votedReviewerUserIds: ['reviewer-a'], reviewStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    reviewElapsedWorkMinutes: 0, nextReminderWorkHour: 1,
    voteCount: 1, approvedVoteCount: 1
  }]
  const { service, calls } = harness({ review, minutes: 90 })
  assert.deepEqual(await service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 1, decisionCreated: 0
  })
  assert.deepEqual(calls.review.map(item => item.reviewerUserId), ['reviewer-b'])
  assert.equal(calls.review[0].expectedVoteCount, 1)
  assert.equal(calls.review[0].expectedApprovedVoteCount, 1)
  assert.equal(calls.review[0].advanceHour, true)
})

test('审核页即使全部过滤也按原始页末编号推进扫描游标', async () => {
  const calls = { cursors: [] }
  const service = createReminderService({
    reminderRepository: {
      async listDueProcessingReminders() { return [] },
      async listDueReviewReminders() { return { items: [], lastScannedRawId: 'round-40' } },
      async listDueOptionalTailDecisions() { return { items: [], lastScannedRawId: null } },
      async createProcessingReminder() { return { created: false } },
      async createReviewReminder() { return { created: false } },
      async createOptionalTailDecisionReminder() { return { created: false } },
      async advanceReminderCursor(value) { calls.cursors.push(value) }
    },
    workTimeService: {
      async isWorkingInstant() { return { status: 'calculated', isWorking: true } },
      async workingMinutesBetween() { return { status: 'calculated', minutes: 60 } }
    }
  })
  assert.deepEqual(await service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 0, decisionCreated: 0
  })
  assert.deepEqual(calls.cursors, [{ kind: 'review', cursorId: 'round-40' }])
})

test('前序审核人失败关闭时最后一人事务不得推进本小时游标', async () => {
  const review = [{
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserIds: ['reviewer-a', 'reviewer-b'],
    votedReviewerUserIds: [], reviewStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    reviewElapsedWorkMinutes: 0, nextReminderWorkHour: 1,
    voteCount: 0, approvedVoteCount: 0
  }]
  const { calls } = harness({ review, minutes: 60 })
  let attempt = 0
  const original = calls.review
  // 夹具仓储通过返回值模拟首名审核账号事务失败关闭。
  const repositoryResults = [{ created: false, fulfilled: false }, { created: true, fulfilled: true }]
  const serviceWithFailure = createReminderService({
    reminderRepository: {
      async listDueProcessingReminders() { return [] },
      async listDueReviewReminders() { return { items: review, lastScannedRawId: 'round-1' } },
      async listDueOptionalTailDecisions() { return { items: [], lastScannedRawId: null } },
      async createProcessingReminder() { return { created: false } },
      async createReviewReminder(value) {
        original.push(value)
        return repositoryResults[attempt++]
      },
      async createOptionalTailDecisionReminder() { return { created: false } },
      async advanceReminderCursor() {}
    },
    workTimeService: {
      async isWorkingInstant() { return { status: 'calculated', isWorking: true } },
      async workingMinutesBetween() { return { status: 'calculated', minutes: 60 } }
    }
  })
  await serviceWithFailure.runReminderCycle({ now: NOW, batchSize: 40 })
  assert.deepEqual(calls.review.map(item => item.advanceHour), [false, false])
})

test('日历待补算候选在编排层失败关闭且每周期总候选不超过 40', async () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    nodeId: `node-${index}`, processingRoundNumber: 1,
    processingStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    processingElapsedWorkMinutes: 0, nextReminderWorkHour: 1
  }))
  const { service, calls } = harness({ processing: candidates, review: candidates, minutes: 60 })
  await service.runReminderCycle({ now: NOW, batchSize: 40 })
  assert.ok(calls.limits.every(limit => limit <= 40))
  assert.ok(calls.processing.length + calls.review.length <= 40)
})

test('可选尾节点每累计一个工作小时提醒仍未作决定的候选处理人', async () => {
  const decision = [{
    nodeId: 'optional-node-1', nodeVersion: 4,
    decisionStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    decisionElapsedWorkMinutes: 0, nextReminderWorkHour: 1
  }]
  const { service, calls } = harness({ decision, minutes: 60 })

  assert.deepEqual(await service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 0, decisionCreated: 1
  })
  assert.deepEqual(calls.decision, [{
    nodeId: 'optional-node-1', expectedVersion: 4, accumulatedWorkHour: 1
  }])
  assert.ok(calls.cursors.some(item => item.kind === 'decision' && item.cursorId === 'optional-node-1'))
})
