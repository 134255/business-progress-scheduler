'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createWorkTimeService } = require('../lib/work-time-service')

test('独立部署包使用同一上海工作时间向量', async () => {
  const service = createWorkTimeService({ calendarRepository: {
    async getDayRule(date) { return { date, isWorkday: true, calendarVersion: 'v1' } }
  } })
  const result = await service.tryAddWorkMinutes(new Date('2026-08-11T15:00:00+08:00'), 8 * 60)
  assert.equal(result.dueAt.toISOString(), '2026-08-12T04:00:00.000Z')
  assert.equal(result.calendarVersion, 'v1')
})
