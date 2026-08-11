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

test('日历仍缺失时以确定性编号补建不含业务内容的管理员告警', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 3,
      processingDueStatus: 'pending_calendar', processingStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingSlaWorkHours: 22, calendarNotificationStatus: 'pending'
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const input = {
    candidate: {
      kind: 'processing', id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 3
    },
    now: new Date('2026-08-11T02:00:00Z')
  }

  assert.equal(await repository.ensurePendingCalendarWarning(input), true)
  assert.equal(await repository.ensurePendingCalendarWarning(input), true)

  const warnings = fake.documents('notifications')
  assert.equal(warnings.length, 1)
  assert.equal(
    warnings[0]._id,
    'work-calendar-missing-2264f7e3fe33a7bafae65ffddae269de41a94741'
  )
  assert.deepEqual(Object.keys(warnings[0]).sort(), [
    '_id', 'audienceRole', 'createdAt', 'status', 'type'
  ])
  assert.equal(warnings[0].type, 'work_calendar_missing')
  assert.equal(warnings[0].audienceRole, 'super_admin')
  assert.equal(warnings[0].status, 'pending')
  assert.equal(fake.documents('business_nodes')[0].calendarNotificationStatus, 'notified')
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

test('待审核节点的处理时长待补算候选按活动轮次有界读取', async () => {
  const fake = createFakeCloudDatabase({
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'pending_review', version: 7,
      activeReviewRoundId: 'round-1', processingTimingStatus: 'pending_calendar',
      processingStartedAt: new Date('2026-08-11T01:00:00Z'), processingElapsedWorkMinutes: 120,
      processingSlaWorkHours: 22
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending', version: 2,
      lockedNodeVersion: 7, reviewDueStatus: 'calculated', processingTimingStatus: 'pending_calendar',
      reviewStartedAt: new Date('2026-08-11T03:00:00Z')
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const candidates = await repository.listPendingDueCandidates({ limit: 40 })

  assert.deepEqual(candidates, [{
    kind: 'review_processing', id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
    status: 'pending', version: 2, nodeVersion: 7,
    startAt: new Date('2026-08-11T01:00:00Z'), endAt: new Date('2026-08-11T03:00:00Z'),
    baseElapsedWorkMinutes: 120, totalWorkMinutes: 1320
  }])
})

test('待审核处理时长补算原子复核活动轮次并同步节点与轮次版本', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'pending_review', version: 7,
      activeReviewRoundId: 'round-1', processingTimingStatus: 'pending_calendar',
      processingStartedAt: new Date('2026-08-11T01:00:00Z'), processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      processingSlaWorkHours: 22
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending', version: 2,
      lockedNodeVersion: 7, reviewStartedAt: new Date('2026-08-11T03:00:00Z'),
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const candidate = {
    kind: 'review_processing', id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
    status: 'pending', version: 2, nodeVersion: 7,
    startAt: new Date('2026-08-11T01:00:00Z'), endAt: new Date('2026-08-11T03:00:00Z'),
    baseElapsedWorkMinutes: 120, totalWorkMinutes: 1320
  }
  assert.equal(await repository.applyDueCalculation({
    candidate,
    calculation: { status: 'calculated', minutes: 180, calendarVersion: 'v1' },
    now: new Date('2026-08-11T04:00:00Z')
  }), true)

  const node = fake.documents('business_nodes')[0]
  const round = fake.documents('node_review_rounds')[0]
  for (const stored of [node, round]) {
    assert.equal(stored.processingTimingStatus, 'calculated')
    assert.equal(stored.processingElapsedWorkMinutes, 300)
    assert.equal(stored.processingRemainingWorkMinutes, 1020)
    assert.equal(stored.processingOverdueWorkMinutes, 0)
    assert.equal(stored.processingCalendarVersion, 'v1')
  }
  assert.equal(node.version, 8)
  assert.equal(round.version, 3)
  assert.equal(round.lockedNodeVersion, 8)
  assert.equal(fake.transactionRuns.at(-1).operations <= 100, true)

  assert.equal(await repository.applyDueCalculation({
    candidate,
    calculation: { status: 'calculated', minutes: 180, calendarVersion: 'v1' },
    now: new Date('2026-08-11T04:00:00Z')
  }), false)
})

test('处理时长候选用持久游标越过40条失效记录并在后续调用安全回绕', async () => {
  const invalid = Array.from({ length: 40 }, (_, index) => ({
    _id: `node-${String(index).padStart(3, '0')}`, businessLineId: 'line-1', status: 'ready', version: 1,
    processingTimingStatus: 'pending_calendar'
  }))
  const valid = {
    _id: 'node-040', businessLineId: 'line-1', status: 'pending_review', version: 7,
    activeReviewRoundId: 'round-1', processingTimingStatus: 'pending_calendar',
    processingStartedAt: new Date('2026-08-11T01:00:00Z'), processingElapsedWorkMinutes: 120,
    processingSlaWorkHours: 22
  }
  const fake = createFakeCloudDatabase({
    business_nodes: [...invalid, valid],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-040', status: 'pending', version: 2,
      lockedNodeVersion: 7, reviewDueStatus: 'calculated', processingTimingStatus: 'pending_calendar',
      reviewStartedAt: new Date('2026-08-11T03:00:00Z')
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  assert.deepEqual(await repository.listPendingDueCandidates({ limit: 40 }), [])
  const second = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(second.length, 1)
  assert.equal(second[0].nodeId, 'node-040')
  assert.deepEqual(await repository.listPendingDueCandidates({ limit: 40 }), [])
  assert.deepEqual(await repository.listPendingDueCandidates({ limit: 40 }), [])
  const fifth = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(fifth[0].nodeId, 'node-040')
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})

test('处理时长候选游标损坏时失败关闭', async () => {
  const fake = createFakeCloudDatabase({ system_settings: [{
    _id: 'calendar-review-processing-cursor', kind: 'review_processing', cursorId: 42, version: 1
  }] })
  const repository = createCloudCalendarRepository({ db: fake.db })
  await assert.rejects(repository.listPendingDueCandidates({ limit: 40 }), /cursor is invalid/)
})

test('已超过总处理时限的待审核节点仍可补算并累加历史与本段逾期分钟', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'pending_review', version: 7,
      activeReviewRoundId: 'round-1', processingTimingStatus: 'pending_calendar',
      processingStartedAt: new Date('2026-08-11T01:00:00Z'), processingElapsedWorkMinutes: 1400,
      processingRemainingWorkMinutes: 0, processingOverdueWorkMinutes: 80, processingSlaWorkHours: 22
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending', version: 2,
      lockedNodeVersion: 7, processingTimingStatus: 'pending_calendar',
      reviewStartedAt: new Date('2026-08-11T03:00:00Z')
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const [candidate] = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(candidate.baseElapsedWorkMinutes, 1400)
  assert.equal(await repository.applyDueCalculation({
    candidate, calculation: { status: 'calculated', minutes: 30, calendarVersion: 'v1' },
    now: new Date('2026-08-11T04:00:00Z')
  }), true)
  const node = fake.documents('business_nodes')[0]
  assert.equal(node.processingRemainingWorkMinutes, 0)
  assert.equal(node.processingOverdueWorkMinutes, 110)
})

test('驳回返工的待补算处理段会原子修正历史分钟与新处理截止时间', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0 }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', sequence: 0, status: 'in_progress', version: 6,
      workflowMode: 'review', processingRoundNumber: 2, reviewRoundNumber: 1,
      processingSlaWorkHours: 22,
      processingStartedAt: new Date('2026-08-11T04:00:00Z'),
      processingDueStatus: 'pending_calendar', processingDueAt: null,
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'rejected', version: 2,
      lockedNodeVersion: 5, processingRoundNumber: 1, reviewRoundNumber: 1,
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      resultNodeStatus: 'in_progress', resultLineStatus: 'active', resultNextNodeId: null,
      processingCarryoverStatus: 'pending',
      processingCarryoverStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingCarryoverEndedAt: new Date('2026-08-11T03:00:00Z'),
      processingCarryoverBaseElapsedWorkMinutes: 120,
      processingCarryoverTotalWorkMinutes: 1320
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const [candidate] = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(candidate.kind, 'review_processing_carryover')
  assert.deepEqual(candidate.resumeAt, new Date('2026-08-11T04:00:00Z'))

  assert.equal(await repository.applyDueCalculation({
    candidate,
    calculation: {
      status: 'calculated', minutes: 180,
      dueAt: new Date('2026-08-13T03:00:00Z'), calendarVersion: 'calendar-a',
      dueCalendarVersion: 'calendar-a'
    },
    now: new Date('2026-08-11T05:00:00Z')
  }), true)
  const node = fake.documents('business_nodes')[0]
  assert.equal(node.processingElapsedWorkMinutes, 300)
  assert.equal(node.processingRemainingWorkMinutes, 1020)
  assert.equal(node.processingDueStatus, 'calculated')
  assert.deepEqual(node.processingDueAt, new Date('2026-08-13T03:00:00Z'))
  const round = fake.documents('node_review_rounds')[0]
  assert.equal(round.processingTimingStatus, 'calculated')
  assert.equal(round.processingElapsedWorkMinutes, 300)
  assert.equal(round.processingCarryoverStatus, 'resolved')
})

test('审核通过后的待补算处理段只修正冻结节点历史而不重新流转', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-2', currentNodeIndex: 1 }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', sequence: 0, status: 'completed', version: 6,
      workflowMode: 'review', processingRoundNumber: 1, reviewRoundNumber: 1,
      processingSlaWorkHours: 22,
      processingStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'approved', version: 2,
      lockedNodeVersion: 5, processingRoundNumber: 1,
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      resultNodeStatus: 'completed', resultLineStatus: 'active', resultNextNodeId: 'node-2',
      processingCarryoverStatus: 'pending',
      processingCarryoverStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingCarryoverEndedAt: new Date('2026-08-11T03:00:00Z'),
      processingCarryoverBaseElapsedWorkMinutes: 120,
      processingCarryoverTotalWorkMinutes: 1320
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const [candidate] = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(candidate.kind, 'review_processing_carryover')
  assert.equal(candidate.resumeAt, null)
  assert.equal(await repository.applyDueCalculation({
    candidate,
    calculation: { status: 'calculated', minutes: 180, calendarVersion: 'calendar-a' },
    now: new Date('2026-08-11T05:00:00Z')
  }), true)
  const node = fake.documents('business_nodes')[0]
  assert.equal(node.status, 'completed')
  assert.equal(node.processingElapsedWorkMinutes, 300)
  assert.equal(fake.documents('node_review_rounds')[0].processingCarryoverStatus, 'resolved')
  assert.equal(fake.documents('business_lines')[0].currentNodeId, 'node-2')
})

test('驳回后再次提交审核仍可定位旧轮次并原子修正当前活动轮次锁', async () => {
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'line-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0 }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', sequence: 0, status: 'pending_review', version: 9,
      activeReviewRoundId: 'round-2', processingRoundNumber: 2, reviewRoundNumber: 2,
      processingStartedAt: new Date('2026-08-11T04:00:00Z'), processingSlaWorkHours: 22,
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'rejected', version: 2,
      lockedNodeVersion: 5, processingRoundNumber: 1, reviewRoundNumber: 1,
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      resultNodeStatus: 'in_progress', resultLineStatus: 'active', resultNextNodeId: null,
      processingCarryoverStatus: 'pending',
      processingCarryoverStartedAt: new Date('2026-08-11T01:00:00Z'),
      processingCarryoverEndedAt: new Date('2026-08-11T03:00:00Z'),
      processingCarryoverBaseElapsedWorkMinutes: 120, processingCarryoverTotalWorkMinutes: 1320
    }, {
      _id: 'round-2', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending', version: 1,
      lockedNodeVersion: 9, processingRoundNumber: 2, reviewRoundNumber: 2,
      processingTimingStatus: 'pending_calendar', processingElapsedWorkMinutes: 120,
      processingRemainingWorkMinutes: 1200, processingOverdueWorkMinutes: 0,
      reviewStartedAt: new Date('2026-08-11T06:00:00Z')
    }]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  const [candidate] = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(candidate.id, 'round-1')
  assert.equal(candidate.resumeAt, null)
  assert.equal(await repository.applyDueCalculation({
    candidate,
    calculation: { status: 'calculated', minutes: 180, calendarVersion: 'calendar-a' },
    now: new Date('2026-08-11T07:00:00Z')
  }), true)
  const node = fake.documents('business_nodes')[0]
  const active = fake.documents('node_review_rounds').find(round => round._id === 'round-2')
  assert.equal(node.processingElapsedWorkMinutes, 300)
  assert.equal(node.version, 10)
  assert.equal(active.processingElapsedWorkMinutes, 300)
  assert.equal(active.lockedNodeVersion, 10)
  assert.equal(active.version, 2)
})

test('历史待补算轮次游标越过40条失效记录并在后续调用安全回绕', async () => {
  const invalid = Array.from({ length: 40 }, (_, index) => ({
    _id: `carry-${String(index).padStart(3, '0')}`,
    businessLineId: 'line-1', nodeId: 'missing-node', status: 'approved', version: 2,
    processingTimingStatus: 'pending_calendar', processingCarryoverStatus: 'pending'
  }))
  const valid = {
    _id: 'carry-040', businessLineId: 'line-1', nodeId: 'node-1', status: 'approved', version: 2,
    processingTimingStatus: 'pending_calendar', processingCarryoverStatus: 'pending',
    processingCarryoverStartedAt: new Date('2026-08-11T01:00:00Z'),
    processingCarryoverEndedAt: new Date('2026-08-11T03:00:00Z'),
    processingCarryoverBaseElapsedWorkMinutes: 120, processingCarryoverTotalWorkMinutes: 1320
  }
  const fake = createFakeCloudDatabase({
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'completed', version: 6,
      reviewRoundNumber: 1, processingTimingStatus: 'pending_calendar',
      processingElapsedWorkMinutes: 120, processingRemainingWorkMinutes: 1200,
      processingOverdueWorkMinutes: 0, processingSlaWorkHours: 22
    }],
    node_review_rounds: [...invalid, valid]
  })
  const repository = createCloudCalendarRepository({ db: fake.db })
  assert.deepEqual(await repository.listPendingDueCandidates({ limit: 40 }), [])
  const second = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(second.length, 1)
  assert.equal(second[0].id, 'carry-040')
  assert.deepEqual(await repository.listPendingDueCandidates({ limit: 40 }), [])
  assert.deepEqual(await repository.listPendingDueCandidates({ limit: 40 }), [])
  const fifth = await repository.listPendingDueCandidates({ limit: 40 })
  assert.equal(fifth[0].id, 'carry-040')
})

test('历史待补算轮次游标损坏时失败关闭', async () => {
  const fake = createFakeCloudDatabase({ system_settings: [{
    _id: 'calendar-review-carryover-cursor', kind: 'review_carryover', cursorId: 42, version: 1
  }] })
  const repository = createCloudCalendarRepository({ db: fake.db })
  await assert.rejects(repository.listPendingDueCandidates({ limit: 40 }), /cursor is invalid/)
})
