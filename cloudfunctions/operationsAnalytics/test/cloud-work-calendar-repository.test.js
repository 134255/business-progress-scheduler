'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudWorkCalendarRepository } = require('../lib/cloud-work-calendar-repository')

test('日历仓储只接受活动代际中完全匹配的日期记录', async () => {
  const fake = createFakeCloudDatabase({
    work_calendar_years: [{ _id: '2026', year: 2026, sourceVersion: 'v1', generationId: 'g1' }],
    work_calendar_entries: [{ _id: 'g1_2026-08-19', date: '2026-08-19', sourceYear: 2026,
      sourceVersion: 'v1', generationId: 'g1', isWorkday: true }]
  })
  const repository = createCloudWorkCalendarRepository({ db: fake.db })
  assert.deepEqual(await repository.getDayRule('2026-08-19'), {
    date: '2026-08-19', isWorkday: true, calendarVersion: 'v1'
  })
  assert.equal(await repository.getDayRule('2026-08-20'), null)
})
