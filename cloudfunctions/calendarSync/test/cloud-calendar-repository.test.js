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
  const stored = fake.documents('work_calendar_entries')
  assert.equal(stored.length, 365)
  assert.deepEqual(stored[0], {
    _id: fake.documents('work_calendar_years')[0].generationId + '_2026-01-01', date: '2026-01-01', isWorkday: true,
    source: 'ailcc', sourceYear: 2026, generationId: fake.documents('work_calendar_years')[0].generationId, sourceVersion: 'ailcc-v1',
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
    if (name !== 'work_calendar_entries') return collection
    return {
      ...collection,
      doc(id) {
        const document = collection.doc(id)
        if (!id.endsWith('_2026-01-01')) return document
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
  let clockNow = new Date('2026-08-11T00:00:00.000Z')
  const repository = createCloudCalendarRepository({
    db: fake.db,
    tokenFactory: () => `token-${++token}`,
    clock: () => new Date(clockNow)
  })
  const input = sourceVersion => ({
    year: 2026, days: yearDays(2026), sourceVersion,
    syncedAt: new Date('2026-08-11T00:00:00.000Z')
  })
  const firstSync = repository.replaceYear(input('version-a'))
  await firstWriteStarted
  clockNow = new Date('2026-08-11T00:11:00.000Z')
  const secondSettled = await Promise.allSettled([repository.replaceYear(input('version-b'))])
  releaseFirstWrite()
  const firstSettled = await Promise.allSettled([firstSync])
  const settled = [...firstSettled, ...secondSettled]
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1)
  const rule = await repository.getDayRule('2026-01-01')
  assert.ok(rule, JSON.stringify({
    metadata: fake.documents('work_calendar_years'),
    entries: fake.documents('work_calendar_entries').slice(0, 2)
  }))
  assert.equal(rule.calendarVersion, fake.documents('work_calendar_years')[0].sourceVersion)
  assert.equal(rule.calendarVersion, 'version-b')
})

test('同版本活动代际缺日或坏记录时安全重建', async () => {
  const fake = createFakeCloudDatabase()
  let token = 0
  const repository = createCloudCalendarRepository({ db: fake.db, tokenFactory: () => `repair-${++token}` })
  const input = { year: 2026, days: yearDays(2026), sourceVersion: 'same', syncedAt: new Date() }
  await repository.replaceYear(input)
  const metadata = fake.documents('work_calendar_years')[0]
  await fake.db.collection('work_calendar_entries').doc(`${metadata.generationId}_2026-12-31`).remove()
  const result = await repository.replaceYear(input)
  assert.equal(result.changed, true)
  assert.notEqual(result.generationId, metadata.generationId)
  assert.equal((await repository.getDayRule('2026-12-31')).calendarVersion, 'same')
  const repaired = fake.documents('work_calendar_years')[0]
  fake.replace('work_calendar_entries', `${repaired.generationId}_2026-06-01`, {
    date: '2026-06-01', isWorkday: 1, sourceYear: 2026,
    generationId: repaired.generationId, sourceVersion: 'same'
  })
  const rebuilt = await repository.replaceYear(input)
  assert.equal(rebuilt.changed, true)
  assert.notEqual(rebuilt.generationId, repaired.generationId)
})

test('同版本活动代际工作日值被篡改时按真实全年输入重建修复', async () => {
  const fake = createFakeCloudDatabase()
  let token = 0
  const repository = createCloudCalendarRepository({ db: fake.db, tokenFactory: () => `value-${++token}` })
  const days = yearDays(2026)
  days.find(day => day.date === '2026-08-11').isWorkday = false
  const input = { year: 2026, days, sourceVersion: 'same-values', syncedAt: new Date() }
  await repository.replaceYear(input)
  const before = fake.documents('work_calendar_years')[0]
  fake.replace('work_calendar_entries', `${before.generationId}_2026-08-11`, {
    date: '2026-08-11', isWorkday: true, source: 'ailcc', sourceYear: 2026,
    generationId: before.generationId, sourceVersion: 'same-values', syncedAt: new Date()
  })
  const rebuilt = await repository.replaceYear(input)
  assert.equal(rebuilt.changed, true)
  assert.notEqual(rebuilt.generationId, before.generationId)
  assert.equal((await repository.getDayRule('2026-08-11')).isWorkday, false)
})

test('两年同版本 no-op 用有界分页校验而不逐日远程读取', async () => {
  const fake = createFakeCloudDatabase()
  let token = 0
  const repository = createCloudCalendarRepository({ db: fake.db, tokenFactory: () => `bounded-${++token}` })
  for (const year of [2026, 2027]) {
    await repository.replaceYear({ year, days: yearDays(year), sourceVersion: `v-${year}`, syncedAt: new Date() })
  }
  const baseCollection = fake.db.collection.bind(fake.db)
  let entryDocumentReads = 0
  let entryQueryReads = 0
  fake.db.collection = name => {
    const collection = baseCollection(name)
    if (name !== 'work_calendar_entries') return collection
    return {
      ...collection,
      doc(id) {
        const document = collection.doc(id)
        return { ...document, async get() { entryDocumentReads += 1; return document.get() } }
      },
      where(criteria) {
        const query = collection.where(criteria)
        function wrap(current) {
          return {
            ...current,
            orderBy(field, direction) { return wrap(current.orderBy(field, direction)) },
            skip(offset) { return wrap(current.skip(offset)) },
            limit(limit) { return wrap(current.limit(limit)) },
            async get() { entryQueryReads += 1; return current.get() }
          }
        }
        return wrap(query)
      }
    }
  }
  for (const year of [2026, 2027]) {
    const result = await repository.replaceYear({ year, days: yearDays(year), sourceVersion: `v-${year}`, syncedAt: new Date() })
    assert.equal(result.changed, false)
  }
  assert.equal(entryDocumentReads, 0)
  assert.ok(entryQueryReads > 0 && entryQueryReads <= 8, `entryQueryReads=${entryQueryReads}`)
})

test('代际年份或来源版本损坏时严格拒绝读取', async () => {
  const fake = createFakeCloudDatabase()
  const repository = createCloudCalendarRepository({ db: fake.db, tokenFactory: () => 'metadata' })
  await repository.replaceYear({ year: 2026, days: yearDays(2026), sourceVersion: 'v1', syncedAt: new Date() })
  fake.replace('work_calendar_years', '2026', { ...fake.documents('work_calendar_years')[0], year: 2025 })
  assert.equal(await repository.getDayRule('2026-01-01'), null)
  fake.replace('work_calendar_years', '2026', { ...fake.documents('work_calendar_years')[0], year: 2026, sourceVersion: '' })
  assert.equal(await repository.getDayRule('2026-01-01'), null)
})

test('版本达到 MAX_SAFE_INTEGER 时不溢出写回', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-max', status: 'active', currentNodeId: 'node-max' }],
    business_nodes: [{ _id: 'node-max', businessLineId: 'line-max', status: 'ready', version: Number.MAX_SAFE_INTEGER, processingDueStatus: 'pending_calendar' }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  assert.equal(await repository.applyDueCalculation({
    candidate: { kind: 'processing', id: 'node-max', businessLineId: 'line-max', status: 'ready', version: Number.MAX_SAFE_INTEGER },
    calculation: { status: 'calculated', dueAt: new Date(), calendarVersion: 'v1' }, now: new Date()
  }), false)
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
