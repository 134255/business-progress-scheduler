const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudOperationsRepository } = require('../lib/cloud-operations-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

function harness() {
  const fake = createFakeCloudDatabase({
    users: [
      { _id: 'root', role: 'super_admin', status: 'active', displayName: '当前管理员名' },
      { _id: 'user', role: 'user', status: 'active', displayName: '当前处理人名' }
    ],
    business_lines: [
      { _id: 'line-1', code: 'BL-1', name: '业务一', status: 'active', currentNodeId: 'node-1', createdAt: new Date('2026-08-10T00:00:00Z') },
      { _id: 'line-2', code: 'BL-2', name: '业务二', status: 'completed', currentNodeId: 'node-2', createdAt: new Date('2026-08-11T00:00:00Z') },
      { _id: 'line-3', code: 'BL-3', name: '关闭业务', status: 'closed', currentNodeId: 'node-3', createdAt: new Date('2026-08-12T00:00:00Z') },
      { _id: 'line-old', code: 'BL-OLD', name: '旧业务', status: 'completed', createdAt: new Date('2025-01-01T00:00:00Z') }
    ],
    business_nodes: [
      {
        _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-1-N001', sequence: 0,
        name: '处理', status: 'in_progress', workflowMode: 'review', processingDueStatus: 'calculated',
        processorUserIds: ['user'], reviewerUserIds: ['root'], reviewMode: 'any',
        processorDisplayNames: ['创建时处理人'], reviewerDisplayNames: ['创建时审核人'],
        processingRoundNumber: 2, reviewRoundNumber: 1, processingElapsedWorkMinutes: 90,
        processingDueAt: new Date('2026-08-12T00:00:00Z'), processingOverdueWorkMinutes: 5,
        reviewDueStatus: 'not_started'
      },
      {
        _id: 'node-2', businessLineId: 'line-2', nodeCode: 'BL-2-N001', sequence: 0,
        name: '完成', status: 'completed', workflowMode: 'review', processingDueStatus: 'pending_calendar',
        processorUserIds: ['user'], reviewerUserIds: ['root'], reviewMode: 'any',
        processingOverdueWorkMinutes: 0, reviewDueStatus: 'pending_calendar', reviewOverdueWorkMinutes: 2
      }
    ],
    node_review_rounds: [
      {
        _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending',
        reviewDueStatus: 'pending_calendar', reviewOverdueWorkMinutes: 3
      }
    ]
  })
  return { fake, repository: createCloudOperationsRepository({ db: fake.db }) }
}

test('运营仓储统计权威状态并以稳定游标返回脱敏节点行', async () => {
  const { repository } = harness()
  const actor = { _id: 'root', role: 'super_admin', status: 'active' }
  const range = {
    startAt: new Date('2026-08-01T16:00:00Z'), endAt: new Date('2026-08-18T16:00:00Z'),
    cursor: '', pageSize: 1
  }
  const dashboard = await repository.getDashboard({ actor, range })
  assert.deepEqual(dashboard.stats, {
    businesses: 3, active: 1, completed: 1, frozen: 1, pendingProcessing: 1, pendingReview: 1,
    overdueProcessing: 1, overdueReview: 1, pendingCalendar: 2
  })
  const first = await repository.exportRows({ actor, range })
  assert.equal(first.items.length, 1)
  assert.equal(first.hasMore, true)
  assert.equal(JSON.stringify(first).includes('root'), false)
  const second = await repository.exportRows({ actor, range: { ...range, cursor: first.nextCursor } })
  assert.equal(second.items.length, 1)
  assert.notEqual(second.items[0].businessCode, first.items[0].businessCode)
  const activeRow = [...first.items, ...second.items].find(item => item.businessCode === 'BL-1')
  assert.equal(activeRow.processingRoundNumber, 2)
  assert.equal(activeRow.reviewRoundNumber, 1)
  assert.equal(activeRow.processorDisplayNames, '创建时处理人')
  assert.equal(activeRow.reviewerDisplayNames, '创建时审核人')

  const completedOnly = await repository.exportRows({ actor, range: { ...range, status: 'completed', pageSize: 50 } })
  assert.deepEqual(completedOnly.items.map(item => item.businessCode), ['BL-2'])
})

test('运营仓储在查询前后都复核超级管理员状态', async () => {
  const { fake, repository } = harness()
  fake.beforeNextTransaction(() => fake.replace('users', 'root', { role: 'user', status: 'active' }))
  await assert.rejects(
    repository.getDashboard({
      actor: { _id: 'root', role: 'super_admin', status: 'active' },
      range: { startAt: new Date('2026-08-01'), endAt: new Date('2026-09-01'), cursor: '', pageSize: 20 }
    }),
    error => error.code === 'FORBIDDEN'
  )
})
