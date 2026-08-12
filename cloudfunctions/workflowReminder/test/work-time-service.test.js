'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorkTimeService, WORK_START_MINUTE, WORK_END_MINUTE } = require('../lib/work-time-service')

function serviceFor(rules = {}) {
  return createWorkTimeService({ calendarRepository: {
    async getDayRule(date) {
      if (Object.hasOwn(rules, date)) return rules[date]
      return { date, isWorkday: true, calendarVersion: 'v1' }
    }
  } })
}

test('独立提醒包复用 09:00 至 20:00 的上海工作时间向量', async () => {
  const service = serviceFor()
  const result = await service.tryAddWorkMinutes(new Date('2026-08-11T15:00:00+08:00'), 8 * 60)
  assert.equal(WORK_START_MINUTE, 9 * 60)
  assert.equal(WORK_END_MINUTE, 20 * 60)
  assert.equal(result.dueAt.toISOString(), '2026-08-12T04:00:00.000Z')
  assert.equal(result.calendarVersion, 'v1')
})

test('只在有权威日历的工作时段内判定为可提醒', async () => {
  const service = serviceFor({
    '2026-08-12': { date: '2026-08-12', isWorkday: false, calendarVersion: 'v1' },
    '2026-08-13': null
  })
  assert.deepEqual(await service.isWorkingInstant(new Date('2026-08-11T01:00:00.000Z')), {
    status: 'calculated', isWorking: true, calendarVersion: 'v1'
  })
  assert.equal((await service.isWorkingInstant(new Date('2026-08-11T00:59:59.999Z'))).isWorking, false)
  assert.equal((await service.isWorkingInstant(new Date('2026-08-11T12:00:00.000Z'))).isWorking, false)
  assert.equal((await service.isWorkingInstant(new Date('2026-08-12T03:00:00.000Z'))).isWorking, false)
  assert.deepEqual(await service.isWorkingInstant(new Date('2026-08-13T03:00:00.000Z')), {
    status: 'pending_calendar', isWorking: false, missingDate: '2026-08-13'
  })
})

test('累计工作分钟跨非工作日且日历缺失时失败关闭', async () => {
  const service = serviceFor({
    '2026-08-12': { date: '2026-08-12', isWorkday: false, calendarVersion: 'v2' },
    '2026-08-13': undefined
  })
  const skipped = await service.workingMinutesBetween(
    new Date('2026-08-11T11:00:00.000Z'), new Date('2026-08-12T04:00:00.000Z'))
  assert.deepEqual(skipped, { status: 'calculated', minutes: 60, calendarVersion: 'v1|v2' })
  const pending = await service.workingMinutesBetween(
    new Date('2026-08-13T01:00:00.000Z'), new Date('2026-08-13T02:00:00.000Z'))
  assert.deepEqual(pending, { status: 'pending_calendar', minutes: null, missingDate: '2026-08-13' })
})
