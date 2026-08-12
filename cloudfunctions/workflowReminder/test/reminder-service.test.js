'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createReminderService } = require('../lib/reminder-service')

const NOW = new Date('2026-08-11T04:30:00.000Z')

function harness({ processing = [], review = [], working = true, minutes = 90 } = {}) {
  const calls = { processing: [], review: [], cursors: [], limits: [] }
  const reminderRepository = {
    async listDueProcessingReminders({ limit }) { calls.limits.push(limit); return processing.slice(0, limit) },
    async listDueReviewReminders({ limit }) { calls.limits.push(limit); return review.slice(0, limit) },
    async createProcessingReminder(value) { calls.processing.push(value); return { created: true } },
    async createReviewReminder(value) { calls.review.push(value); return { created: true } },
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
    processingCreated: 1, reviewCreated: 0
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
    processingCreated: 0, reviewCreated: 0
  })
  const outside = harness({ processing: [candidate], working: false, minutes: 180 })
  assert.deepEqual(await outside.service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 0
  })
})

test('会签只把未投票审核人交给事务创建并按审核人计数', async () => {
  const review = [{
    reviewRoundId: 'round-1', nodeId: 'node-1', reviewerUserIds: ['reviewer-a', 'reviewer-b'],
    votedReviewerUserIds: ['reviewer-a'], reviewStartedAt: new Date('2026-08-11T03:00:00.000Z'),
    reviewElapsedWorkMinutes: 0, nextReminderWorkHour: 1
  }]
  const { service, calls } = harness({ review, minutes: 90 })
  assert.deepEqual(await service.runReminderCycle({ now: NOW, batchSize: 40 }), {
    processingCreated: 0, reviewCreated: 1
  })
  assert.deepEqual(calls.review.map(item => item.reviewerUserId), ['reviewer-b'])
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
