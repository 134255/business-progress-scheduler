'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCalendarSyncService } = require('../lib/calendar-sync-service')

test('同步上海当前年和下一年并分别记录结果', async () => {
  const fetched = []
  const replaced = []
  const service = createCalendarSyncService({
    holidayClient: {
      async fetchYear(year) {
        fetched.push(year)
        return { year, sourceVersion: `v${year}`, days: [{ date: `${year}-01-01`, isWorkday: true }] }
      }
    },
    calendarRepository: {
      async replaceYear(input) { replaced.push(input) },
      async listPendingDueCandidates() { return [] },
      async applyDueCalculation() { throw new Error('unexpected') },
      async ensurePendingCalendarWarning() { throw new Error('unexpected') }
    },
    workTimeService: {
      async tryAddWorkMinutes() { throw new Error('unexpected') },
      async workingMinutesBetween() { throw new Error('unexpected') }
    }
  })
  const result = await service.run({ mode: 'manual', now: new Date('2026-12-31T16:30:00.000Z') })
  assert.deepEqual(fetched, [2027, 2028])
  assert.deepEqual(replaced.map(item => item.year), [2027, 2028])
  assert.deepEqual(result.years, [
    { year: 2027, status: 'synced', sourceVersion: 'v2027', dayCount: 1 },
    { year: 2028, status: 'synced', sourceVersion: 'v2028', dayCount: 1 }
  ])
})

test('单年网络失败保留旧缓存并不阻断下一年同步和补算', async () => {
  const oldCache = new Map([[2026, 'old-v2026']])
  const service = createCalendarSyncService({
    holidayClient: {
      async fetchYear(year) {
        if (year === 2026) throw new Error('offline')
        return { year, sourceVersion: 'new-v2027', days: [{ date: '2027-01-01', isWorkday: true }] }
      }
    },
    calendarRepository: {
      async replaceYear(input) { oldCache.set(input.year, input.sourceVersion) },
      async listPendingDueCandidates({ limit }) {
        assert.equal(limit, 40)
        return []
      },
      async applyDueCalculation() { throw new Error('unexpected') },
      async ensurePendingCalendarWarning() { throw new Error('unexpected') }
    },
    workTimeService: {
      async tryAddWorkMinutes() { throw new Error('unexpected') },
      async workingMinutesBetween() { throw new Error('unexpected') }
    }
  })
  const result = await service.run({ mode: 'scheduled', now: new Date('2026-08-11T00:00:00.000Z') })
  assert.equal(oldCache.get(2026), 'old-v2026')
  assert.equal(oldCache.get(2027), 'new-v2027')
  assert.deepEqual(result.years.map(item => item.status), ['failed', 'synced'])
})

test('每批最多补算40个并仅提交可计算结果', async () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    kind: 'processing', id: `node-${index}`, version: 1,
    startAt: new Date('2026-08-11T09:00:00+08:00'), minutes: 60
  }))
  const applied = []
  const warned = []
  let calculations = 0
  const service = createCalendarSyncService({
    holidayClient: { async fetchYear(year) { return { year, sourceVersion: `v${year}`, days: [] } } },
    calendarRepository: {
      async replaceYear() {},
      async listPendingDueCandidates({ limit }) { assert.equal(limit, 40); return candidates },
      async applyDueCalculation(value) { applied.push(value); return true },
      async ensurePendingCalendarWarning(value) { warned.push(value); return true }
    },
    workTimeService: {
      async tryAddWorkMinutes(startAt, minutes) {
        assert.equal(minutes, 60)
        calculations += 1
        if (calculations === 1) return { status: 'pending_calendar', dueAt: null, missingDate: '2026-08-11' }
        return { status: 'calculated', dueAt: new Date(startAt.getTime() + 3600000), calendarVersion: 'v2026' }
      }
      ,
      async workingMinutesBetween() { throw new Error('unexpected') }
    }
  })
  const result = await service.run({ now: new Date('2026-08-11T00:00:00.000Z') })
  assert.equal(applied.length, 39)
  assert.equal(warned.length, 1)
  assert.equal(warned[0].candidate.id, 'node-0')
  assert.equal(result.recalculation.pending, 1)
  assert.equal(result.recalculation.updated, 39)
})

test('待审核处理时长使用区间工作分钟补算且缺日历时保持待补算', async () => {
  const candidate = {
    kind: 'review_processing', id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
    startAt: new Date('2026-08-11T01:00:00Z'), endAt: new Date('2026-08-11T03:00:00Z')
  }
  const applied = []
  const warned = []
  let attempts = 0
  const service = createCalendarSyncService({
    holidayClient: { async fetchYear(year) { return { year, sourceVersion: `v${year}`, days: [] } } },
    calendarRepository: {
      async replaceYear() {},
      async listPendingDueCandidates() { return [candidate, candidate] },
      async applyDueCalculation(value) { applied.push(value); return true },
      async ensurePendingCalendarWarning(value) { warned.push(value); return true }
    },
    workTimeService: {
      async tryAddWorkMinutes() { throw new Error('unexpected') },
      async workingMinutesBetween(startAt, endAt) {
        assert.deepEqual([startAt, endAt], [candidate.startAt, candidate.endAt])
        attempts += 1
        return attempts === 1
          ? { status: 'pending_calendar', minutes: null, missingDate: '2026-08-11' }
          : { status: 'calculated', minutes: 180, calendarVersion: 'v2026' }
      }
    }
  })

  const result = await service.run({ now: new Date('2026-08-11T04:00:00Z') })
  assert.equal(warned.length, 1)
  assert.equal(applied.length, 1)
  assert.equal(applied[0].calculation.minutes, 180)
  assert.deepEqual(result.recalculation, { examined: 2, updated: 1, skipped: 0, pending: 1, failed: 0 })
})
