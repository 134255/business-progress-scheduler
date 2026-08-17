const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeOperationsQuery, safeOperationsRow } = require('../lib/operations-domain')

test('运营查询采用上海自然日、最多366天并严格限制输入', () => {
  const result = normalizeOperationsQuery({
    startDate: '2026-01-01', endDate: '2026-12-31', status: 'completed', pageSize: 50, cursor: ''
  }, new Date('2026-08-17T02:00:00.000Z'))
  assert.equal(result.startAt.toISOString(), '2025-12-31T16:00:00.000Z')
  assert.equal(result.endAt.toISOString(), '2026-12-31T16:00:00.000Z')
  assert.equal(result.pageSize, 50)
  assert.equal(result.status, 'completed')
  assert.throws(() => normalizeOperationsQuery({ startDate: '2025-01-01', endDate: '2026-12-31' }, new Date()),
    error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => normalizeOperationsQuery({ startDate: '2026-01-01', endDate: '2026-01-02', actorId: 'x' }, new Date()),
    error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => normalizeOperationsQuery({ status: 'creating' }, new Date()),
    error => error.code === 'VALIDATION_ERROR')
})

test('运营导出行只保留安全业务与节点字段', () => {
  const row = safeOperationsRow({
    line: { _id: 'secret-line-id', code: 'BL-1', name: '=公式', status: 'active', createdAt: new Date('2026-08-17T00:00:00Z') },
    node: {
      _id: 'secret-node-id', nodeCode: 'BL-1-N001', name: '资料处理', status: 'in_progress',
      workflowMode: 'review', processingDueStatus: 'calculated', processingDueAt: new Date('2026-08-18T00:00:00Z'),
      processingOverdueWorkMinutes: 2, processingElapsedWorkMinutes: 60, processingRoundNumber: 2,
      reviewRoundNumber: 1, reviewMode: 'all', reviewDueStatus: 'not_started', reviewerUserIds: ['secret-user']
    },
    processorDisplayNames: ['处理人甲'], reviewerDisplayNames: ['审核人乙']
  })
  assert.equal(row.businessCode, 'BL-1')
  assert.equal(row.nodeCode, 'BL-1-N001')
  assert.equal(JSON.stringify(row).includes('secret-'), false)
  assert.equal(Object.hasOwn(row, 'reviewerUserIds'), false)
  assert.equal(row.processorDisplayNames, '处理人甲')
  assert.equal(row.reviewerDisplayNames, '审核人乙')
  assert.equal(row.processingRoundNumber, 2)
  assert.equal(row.reviewMode, 'all')
})
