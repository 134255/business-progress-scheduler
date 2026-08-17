const test = require('node:test')
const assert = require('node:assert/strict')

const { createOperationsService } = require('../lib/operations-service')

test('运营服务仅允许活动超级管理员并传递规范化日期范围', async () => {
  const calls = []
  const service = createOperationsService({
    repository: {
      async getDashboard(input) { calls.push(['dashboard', input]); return { stats: {} } },
      async exportRows(input) { calls.push(['export', input]); return { items: [] } }
    },
    clock: () => new Date('2026-08-17T02:00:00.000Z')
  })
  const actor = { _id: 'root', role: 'super_admin', status: 'active' }
  await service.getDashboard({ actor, query: { startDate: '2026-08-01', endDate: '2026-08-17' } })
  await service.exportRows({ actor, query: { startDate: '2026-08-01', endDate: '2026-08-17', pageSize: 20 } })
  assert.equal(calls.length, 2)
  assert.equal(calls[0][1].range.startAt.toISOString(), '2026-07-31T16:00:00.000Z')
  await assert.rejects(
    service.getDashboard({ actor: { _id: 'user', role: 'user', status: 'active' }, query: {} }),
    error => error.code === 'FORBIDDEN'
  )
})
