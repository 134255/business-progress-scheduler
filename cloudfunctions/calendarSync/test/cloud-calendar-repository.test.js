'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudCalendarRepository } = require('../lib/cloud-calendar-repository')

function yearDays(year) {
  const rows = []
  for (let at = Date.UTC(year, 0, 1); new Date(at).getUTCFullYear() === year; at += 86400000) {
    rows.push({ date: new Date(at).toISOString().slice(0, 10), isWorkday: true })
  }
  return rows
}

test('完整年份按日期幂等写入工作日历记录', async () => {
  const fake = createFakeCloudDatabase()
  const repository = createCloudCalendarRepository({ db: fake.db })
  await repository.replaceYear({
    year: 2026,
    days: yearDays(2026),
    sourceVersion: 'ailcc-v1',
    syncedAt: new Date('2026-08-11T00:00:00.000Z')
  })
  const stored = fake.documents('work_calendar')
  assert.equal(stored.length, 365)
  assert.deepEqual(stored[0], {
    _id: '2026-01-01', date: '2026-01-01', isWorkday: true,
    source: 'ailcc', sourceYear: 2026, sourceVersion: 'ailcc-v1',
    syncedAt: new Date('2026-08-11T00:00:00.000Z')
  })
})

test('不完整或重复年份在写入前失败并保留旧缓存', async () => {
  const fake = createFakeCloudDatabase({ work_calendar: [
    { _id: '2026-01-01', date: '2026-01-01', isWorkday: false, sourceVersion: 'old' }
  ] })
  const repository = createCloudCalendarRepository({ db: fake.db })
  await assert.rejects(repository.replaceYear({
    year: 2026,
    days: [{ date: '2026-01-01', isWorkday: true }, { date: '2026-01-01', isWorkday: true }],
    sourceVersion: 'new', syncedAt: new Date()
  }), /complete year/)
  assert.equal(fake.documents('work_calendar')[0].sourceVersion, 'old')
})

test('同一年并发同步只有一个发布者且活动代际不会混入另一版本', async () => {
  const fake = createFakeCloudDatabase()
  const baseCollection = fake.db.collection.bind(fake.db)
  let heldFirstWrite = false
  let announceFirstWrite
  let releaseFirstWrite
  const firstWriteStarted = new Promise(resolve => { announceFirstWrite = resolve })
  const firstWriteMayContinue = new Promise(resolve => { releaseFirstWrite = resolve })
  fake.db.collection = name => {
    const collection = baseCollection(name)
    if (name !== 'work_calendar') return collection
    return {
      ...collection,
      doc(id) {
        const document = collection.doc(id)
        if (id !== '2026-01-01') return document
        return {
          ...document,
          async set(input) {
            if (!heldFirstWrite) {
              heldFirstWrite = true
              announceFirstWrite()
              await firstWriteMayContinue
            }
            return document.set(input)
          }
        }
      }
    }
  }
  let token = 0
  const repository = createCloudCalendarRepository({
    db: fake.db,
    tokenFactory: () => `token-${++token}`,
    clock: () => new Date('2026-08-11T00:00:00.000Z')
  })
  const input = sourceVersion => ({
    year: 2026, days: yearDays(2026), sourceVersion,
    syncedAt: new Date('2026-08-11T00:00:00.000Z')
  })
  const firstSync = repository.replaceYear(input('version-a'))
  await firstWriteStarted
  const secondSettled = await Promise.allSettled([repository.replaceYear(input('version-b'))])
  releaseFirstWrite()
  const firstSettled = await Promise.allSettled([firstSync])
  const settled = [...firstSettled, ...secondSettled]
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1)
  const rule = await repository.getDayRule('2026-01-01')
  assert.ok(rule, JSON.stringify({
    metadata: fake.documents('work_calendar_years'),
    primary: fake.documents('work_calendar').slice(0, 1),
    shadow: fake.documents('work_calendar_shadow').slice(0, 1)
  }))
  assert.equal(rule.calendarVersion, fake.documents('work_calendar_years')[0].sourceVersion)
})

test('候选读取合计不超过40条', async () => {
  const fake = createFakeCloudDatabase({
    business_nodes: [...Array.from({ length: 30 }, (_, index) => ({
      _id: `node-${String(index).padStart(2, '0')}`, businessLineId: 'line-1', status: 'ready', version: 1,
      processingDueStatus: 'pending_calendar', processingStartedAt: new Date(), processingSlaWorkHours: 22
    })), ...Array.from({ length: 30 }, (_, index) => ({
      _id: `active-node-${String(index).padStart(2, '0')}`, businessLineId: 'line-1',
      status: 'pending_review', version: 4, activeReviewRoundId: `round-${String(index).padStart(2, '0')}`
    }))],
    node_review_rounds: Array.from({ length: 30 }, (_, index) => ({
      _id: `round-${String(index).padStart(2, '0')}`, businessLineId: 'line-1',
      nodeId: `active-node-${String(index).padStart(2, '0')}`,
      status: 'pending', version: 1, reviewDueStatus: 'pending_calendar',
      reviewStartedAt: new Date(), reviewSlaWorkHours: 8
    }))
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const candidates = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(candidates.length, 40)
  assert.equal(candidates.filter(item => item.kind === 'processing').length, 30)
  assert.equal(candidates.filter(item => item.kind === 'review').length, 10)
})

test('补算事务发现节点版本变化时不覆盖', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 2,
      processingDueStatus: 'pending_calendar', processingStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingSlaWorkHours: 22
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const changed = await repository.applyDueCalculation({
    candidate: { kind: 'processing', id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 1 },
    calculation: { status: 'calculated', dueAt: new Date('2026-08-12T01:00:00Z'), calendarVersion: 'v1' },
    now: new Date('2026-08-11T02:00:00Z')
  })
  assert.equal(changed, false)
  assert.equal(fake.documents('business_nodes')[0].processingDueAt, undefined)
})

test('补算事务仅更新仍活动且版本匹配的处理节点', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 3,
      processingDueStatus: 'pending_calendar', processingStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingSlaWorkHours: 22, calendarNotificationStatus: 'pending'
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const changed = await repository.applyDueCalculation({
    candidate: { kind: 'processing', id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 3 },
    calculation: { status: 'calculated', dueAt: new Date('2026-08-12T01:00:00Z'), calendarVersion: 'v1' },
    now: new Date('2026-08-11T02:00:00Z')
  })
  assert.equal(changed, true)
  const stored = fake.documents('business_nodes')[0]
  assert.equal(stored.processingDueStatus, 'calculated')
  assert.equal(stored.processingCalendarVersion, 'v1')
  assert.equal(stored.calendarNotificationStatus, 'resolved')
  assert.equal(stored.version, 4)
})

test('剩余零分钟可写回不依赖日历版本的已计算截止时间', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 1,
      processingDueStatus: 'pending_calendar', processingStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingRemainingWorkMinutes: 0
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const changed = await repository.applyDueCalculation({
    candidate: { kind: 'processing', id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 1 },
    calculation: { status: 'calculated', dueAt: new Date('2026-08-11T01:00:00Z'), calendarVersion: null },
    now: new Date('2026-08-11T02:00:00Z')
  })
  assert.equal(changed, true)
  assert.equal(fake.documents('business_nodes')[0].processingCalendarVersion, null)
})

test('审核补算逐条复核业务节点轮次和版本后写回轮次', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'pending_review', version: 7,
      activeReviewRoundId: 'round-1'
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending', version: 2,
      reviewDueStatus: 'pending_calendar', calendarNotificationStatus: 'pending'
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const input = {
    candidate: {
      kind: 'review', id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
      status: 'pending', version: 2, nodeVersion: 7
    },
    calculation: {
      status: 'calculated', dueAt: new Date('2026-08-12T01:00:00Z'), calendarVersion: 'v1'
    },
    now: new Date('2026-08-11T02:00:00Z')
  }
  assert.equal(await repository.applyDueCalculation(input), true)
  const stored = fake.documents('node_review_rounds')[0]
  assert.equal(stored.reviewDueStatus, 'calculated')
  assert.equal(stored.reviewCalendarVersion, 'v1')
  assert.equal(stored.calendarNotificationStatus, 'resolved')
  assert.equal(stored.version, 3)

  fake.replace('node_review_rounds', 'round-1', {
    businessLineId: 'line-1', nodeId: 'node-1', status: 'pending', version: 3,
    reviewDueStatus: 'pending_calendar'
  })
  assert.equal(await repository.applyDueCalculation(input), false)
  assert.equal(fake.documents('node_review_rounds')[0].reviewDueAt, undefined)
})

test('审核补算发现业务当前节点已变化时不覆盖旧活动轮次', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-2' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'pending_review', version: 7,
      activeReviewRoundId: 'round-1'
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending', version: 2,
      reviewDueStatus: 'pending_calendar'
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const changed = await repository.applyDueCalculation({
    candidate: {
      kind: 'review', id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
      status: 'pending', version: 2, nodeVersion: 7
    },
    calculation: {
      status: 'calculated', dueAt: new Date('2026-08-12T01:00:00Z'), calendarVersion: 'v1'
    },
    now: new Date('2026-08-11T02:00:00Z')
  })
  assert.equal(changed, false)
  assert.equal(fake.documents('node_review_rounds')[0].reviewDueAt, undefined)
})
