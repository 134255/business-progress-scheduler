'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorkTimeService } = require('../lib/work-time-service')

function rules(values, versions = {}) {
  return {
    async getDayRule(date) {
      if (!Object.prototype.hasOwnProperty.call(values, date)) return null
      const value = values[date]
      if (value && typeof value === 'object') return value
      return { date, isWorkday: value, calendarVersion: versions[date] || 'calendar-v1' }
    }
  }
}

function allWorkdays() {
  return {
    async getDayRule(date) {
      return { date, isWorkday: true, calendarVersion: 'calendar-v1' }
    }
  }
}

test('15点开始的8个工作小时在次日12点到期', async () => {
  const service = createWorkTimeService({ calendarRepository: allWorkdays() })
  const result = await service.tryAddWorkMinutes(new Date('2026-08-11T15:00:00+08:00'), 8 * 60)
  assert.equal(result.status, 'calculated')
  assert.equal(result.dueAt.toISOString(), '2026-08-12T04:00:00.000Z')
  assert.equal(result.calendarVersion, 'calendar-v1')
})

test('法定休息日不累计工作分钟', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({
    '2026-09-30': true,
    '2026-10-01': false,
    '2026-10-02': false,
    '2026-10-03': true
  }) })
  const result = await service.tryAddWorkMinutes(new Date('2026-09-30T19:00:00+08:00'), 2 * 60)
  assert.equal(result.dueAt.toISOString(), '2026-10-03T02:00:00.000Z')
})

test('日历缺失时返回待补算而不猜测周末', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({}) })
  const result = await service.tryAddWorkMinutes(new Date('2026-08-11T15:00:00+08:00'), 8 * 60)
  assert.deepEqual(result, {
    status: 'pending_calendar',
    dueAt: null,
    missingDate: '2026-08-11'
  })
})

test('09点前从当日09点开始且20点后跳到下一工作日', async () => {
  const service = createWorkTimeService({ calendarRepository: allWorkdays() })
  const before = await service.tryAddWorkMinutes(new Date('2026-08-11T08:30:00+08:00'), 60)
  const after = await service.tryAddWorkMinutes(new Date('2026-08-11T20:00:00+08:00'), 60)
  assert.equal(before.dueAt.toISOString(), '2026-08-11T02:00:00.000Z')
  assert.equal(after.dueAt.toISOString(), '2026-08-12T02:00:00.000Z')
})

test('零分钟保留原始时刻且不要求日历', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({}) })
  const start = new Date('2026-08-11T08:30:25.000+08:00')
  const result = await service.tryAddWorkMinutes(start, 0)
  assert.deepEqual(result, { status: 'calculated', dueAt: new Date(start), calendarVersion: null })
})

test('反向区间被拒绝且工作分钟只累计工作窗口交集', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({
    '2026-08-11': true,
    '2026-08-12': false,
    '2026-08-13': true
  }) })
  await assert.rejects(
    service.workingMinutesBetween(
      new Date('2026-08-12T10:00:00+08:00'),
      new Date('2026-08-11T10:00:00+08:00')
    ),
    /endAt/
  )
  const result = await service.workingMinutesBetween(
    new Date('2026-08-11T19:30:00+08:00'),
    new Date('2026-08-13T09:30:00+08:00')
  )
  assert.deepEqual(result, { status: 'calculated', minutes: 60, calendarVersion: 'calendar-v1' })
})

test('区间所需日期缺失时返回待补算', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({ '2026-08-11': true }) })
  const result = await service.workingMinutesBetween(
    new Date('2026-08-11T19:30:00+08:00'),
    new Date('2026-08-12T09:30:00+08:00')
  )
  assert.deepEqual(result, { status: 'pending_calendar', minutes: null, missingDate: '2026-08-12' })
})

test('nextWorkInstant 跳过休息日并保留所用日历版本', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({
    '2026-08-12': false,
    '2026-08-13': true
  }, { '2026-08-12': 'calendar-v2', '2026-08-13': 'calendar-v2' }) })
  const result = await service.nextWorkInstant(new Date('2026-08-11T20:05:00+08:00'))
  assert.deepEqual(result, {
    status: 'calculated',
    dueAt: new Date('2026-08-13T09:00:00+08:00'),
    calendarVersion: 'calendar-v2'
  })
})

test('工作时长只累计已经完整经过的分钟', async () => {
  const service = createWorkTimeService({ calendarRepository: allWorkdays() })
  const start = new Date('2026-08-13T09:00:00.000+08:00')

  const beforeHour = await service.workingMinutesBetween(
    start,
    new Date('2026-08-13T09:59:59.999+08:00')
  )
  const exactHour = await service.workingMinutesBetween(
    start,
    new Date('2026-08-13T10:00:00.000+08:00')
  )

  assert.equal(beforeHour.minutes, 59)
  assert.equal(exactHour.minutes, 60)
  assert.equal(Number.isSafeInteger(beforeHour.minutes), true)
  assert.equal(Number.isSafeInteger(exactHour.minutes), true)
})

test('跨工作日先累计秒级交集再统一折算完整分钟', async () => {
  const service = createWorkTimeService({ calendarRepository: allWorkdays() })
  const result = await service.workingMinutesBetween(
    new Date('2026-08-13T19:59:29.500+08:00'),
    new Date('2026-08-14T09:00:30.500+08:00')
  )

  assert.equal(result.minutes, 1)
  assert.equal(Number.isSafeInteger(result.minutes), true)
})

test('损坏的日历规则按缺失处理而不抛出节点创建异常', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({
    '2026-08-11': { date: '2026-08-10', isWorkday: true }
  }) })
  const result = await service.tryAddWorkMinutes(new Date('2026-08-11T10:00:00+08:00'), 60)
  assert.deepEqual(result, {
    status: 'pending_calendar',
    dueAt: null,
    missingDate: '2026-08-11'
  })
})
