'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCalendarAdminService } = require('../lib/calendar-admin-service')

test('仅活动超级管理员可签发短效一次性票据并由服务端调用', async () => {
  const fake = createFakeCloudDatabase()
  const calls = []
  const service = createCalendarAdminService({
    db: fake.db, clock: () => new Date('2026-08-11T00:00:00Z'), requestIdFactory: () => 'a'.repeat(48),
    invokeCalendarSync: async data => { calls.push(data); return { result: { synced: true } } }
  })
  await assert.rejects(service.sync({ actor: { _id: 'user', role: 'admin', status: 'active' } }), error => error.code === 'FORBIDDEN')
  assert.deepEqual(await service.sync({ actor: { _id: 'root', role: 'super_admin', status: 'active' } }), { synced: true })
  assert.deepEqual(calls, [{ manualRequestId: 'a'.repeat(48) }])
  const ticket = fake.documents('calendar_sync_requests')[0]
  assert.equal(ticket.requestedByAccountId, 'root')
  assert.equal(ticket.expiresAt.toISOString(), '2026-08-11T00:05:00.000Z')
})
