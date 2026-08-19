'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorkTimeService } = require('../lib/work-time-service')

test('业务完成时长只累计上海工作日09点到20点的完整分钟', async () => {
  const service = createWorkTimeService({ calendarRepository: {
    async getDayRule(date) { return { date, isWorkday: date !== '2026-08-20', calendarVersion: 'v1' } }
  } })
  const result = await service.workingMinutesBetween(
    new Date('2026-08-19T10:30:30.000Z'),
    new Date('2026-08-21T02:00:59.000Z')
  )
  assert.equal(result.status, 'calculated')
  assert.equal(result.minutes, 150)
})

test('权威日历缺失时返回待补算', async () => {
  const service = createWorkTimeService({ calendarRepository: { async getDayRule() { return null } } })
  assert.deepEqual(await service.workingMinutesBetween(
    new Date('2026-08-19T01:00:00Z'), new Date('2026-08-19T02:00:00Z')
  ), { status: 'pending_calendar', minutes: null, missingDate: '2026-08-19' })
})
