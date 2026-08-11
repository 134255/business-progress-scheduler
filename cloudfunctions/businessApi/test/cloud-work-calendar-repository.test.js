'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudWorkCalendarRepository } = require('../lib/cloud-work-calendar-repository')

test('只返回编号和日期一致且工作日标记为严格布尔值的规则', async () => {
  const fake = createFakeCloudDatabase({
    work_calendar: [
      { _id: '2026-08-11', date: '2026-08-11', isWorkday: true, sourceVersion: 'ailcc-v1' },
      { _id: '2026-08-12', date: '2026-08-10', isWorkday: true, sourceVersion: 'ailcc-v1' },
      { _id: '2026-08-13', date: '2026-08-13', isWorkday: 1, sourceVersion: 'ailcc-v1' }
    ]
  })
  const repository = createCloudWorkCalendarRepository({ db: fake.db })
  assert.deepEqual(await repository.getDayRule('2026-08-11'), {
    date: '2026-08-11', isWorkday: true, calendarVersion: 'ailcc-v1'
  })
  assert.equal(await repository.getDayRule('2026-08-12'), null)
  assert.equal(await repository.getDayRule('2026-08-13'), null)
  assert.equal(await repository.getDayRule('2026-08-14'), null)
})

test('拒绝无效日期键且数据库读取错误不会伪装成缺失', async () => {
  const fake = createFakeCloudDatabase()
  const repository = createCloudWorkCalendarRepository({ db: fake.db })
  await assert.rejects(repository.getDayRule('2026-02-30'), /dateKey/)
  const original = fake.db.collection
  fake.db.collection = () => ({ doc: () => ({ get: async () => { throw new Error('database unavailable') } }) })
  await assert.rejects(repository.getDayRule('2026-08-11'), /database unavailable/)
  fake.db.collection = original
})

test('年份元数据激活影子代际时只读取已完整发布的日历', async () => {
  const fake = createFakeCloudDatabase({
    work_calendar: [
      { _id: '2026-08-11', date: '2026-08-11', isWorkday: false, source: 'ailcc', sourceYear: 2026, sourceVersion: 'old' }
    ],
    work_calendar_shadow: [
      { _id: '2026-08-11', date: '2026-08-11', isWorkday: true, source: 'ailcc', sourceYear: 2026, sourceVersion: 'new' }
    ],
    work_calendar_years: [
      { _id: '2026', year: 2026, activeSlot: 'shadow', sourceVersion: 'new' }
    ]
  })
  const repository = createCloudWorkCalendarRepository({ db: fake.db })
  assert.deepEqual(await repository.getDayRule('2026-08-11'), {
    date: '2026-08-11', isWorkday: true, calendarVersion: 'new'
  })
})
