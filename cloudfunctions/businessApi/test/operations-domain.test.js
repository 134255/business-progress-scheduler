const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeOperationsQuery,
  normalizeAnalyticsQuery,
  normalizeTimingDetailsQuery,
  safeOperationsRow,
  safeTimingDetail
} = require('../lib/operations-domain')

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

test('个人工时明细查询最多20条且游标绑定上海日期与状态', () => {
  const query = normalizeTimingDetailsQuery({
    startDate: '2026-01-01', endDate: '2026-12-31', status: 'completed', pageSize: 20, cursor: ''
  }, new Date('2026-08-17T02:00:00.000Z'))
  assert.equal(query.pageSize, 20)
  assert.equal(query.startAt.toISOString(), '2025-12-31T16:00:00.000Z')
  assert.throws(() => normalizeTimingDetailsQuery({ pageSize: 21 }, new Date()),
    error => error.code === 'VALIDATION_ERROR')
})

test('个人工时明细只投影不可变显示快照且历史缺失不伪造为零', () => {
  const detail = safeTimingDetail({
    line: { code: 'BL-1', name: '业务一', status: 'completed' },
    node: { nodeCode: 'BL-1-N001', name: '资料处理' },
    round: {
      _id: 'round-1', businessLineId: 'line-secret', nodeId: 'node-secret',
      processingRoundNumber: 2, reviewRoundNumber: 1,
      submittedBy: 'user-secret', submittedByDisplayName: '实际提交人',
      processorAssignmentMode: 'business_creator', reviewStartedAt: new Date('2026-08-17T01:00:00Z'),
      processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 95,
      processingRoundStartedAt: new Date('2026-08-16T01:00:00Z'),
      processingRoundEndedAt: new Date('2026-08-17T01:00:00Z'),
      processingOverdueWorkMinutes: 5, requestKeyHash: 'secret-hash'
    },
    votes: [{
      reviewerUserId: 'reviewer-secret', reviewerDisplayName: '实际投票人', decision: 'approved',
      createdAt: new Date('2026-08-17T02:00:00Z'), reviewResponseTimingStatus: 'calculated',
      reviewResponseWorkMinutes: 60, reviewResponseStartedAt: new Date('2026-08-17T01:00:00Z'),
      reviewResponseEndedAt: new Date('2026-08-17T02:00:00Z'), reviewResponseHash: 'secret-hash'
    }]
  })
  assert.equal(detail.roundId, 'round-1')
  assert.equal(detail.submittedByDisplayName, '实际提交人')
  assert.equal(detail.processorAssignmentMode, 'business_creator')
  assert.equal(detail.processingTiming.recorded, true)
  assert.equal(detail.processingTiming.workMinutes, 95)
  assert.deepEqual(detail.votes.map(vote => vote.reviewerDisplayName), ['实际投票人'])
  assert.equal(detail.votes[0].responseTiming.workMinutes, 60)
  assert.equal(JSON.stringify(detail).includes('user-secret'), false)
  assert.equal(JSON.stringify(detail).includes('secret-hash'), false)
  assert.equal(JSON.stringify(detail).includes('line-secret'), false)

  const legacy = safeTimingDetail({
    line: { code: 'BL-OLD', name: '旧业务', status: 'completed' },
    node: { nodeCode: 'BL-OLD-N001', name: '旧节点' },
    round: { _id: 'round-old', processingRoundNumber: 1, reviewRoundNumber: 1,
      reviewStartedAt: new Date('2026-08-17T01:00:00Z') },
    votes: [{ reviewerDisplayName: '旧审核人', decision: 'approved', createdAt: new Date('2026-08-17T02:00:00Z') }]
  })
  assert.deepEqual(legacy.processingTiming, { recorded: false })
  assert.deepEqual(legacy.votes[0].responseTiming, { recorded: false })
})

test('历史统计查询严格接纳模板、粒度和不透明人员令牌', () => {
  const token = 'a'.repeat(64)
  const query = normalizeAnalyticsQuery({
    startDate: '2026-08-01', endDate: '2026-08-19', grain: 'week',
    templateId: 'template-1', templateVersion: 2, status: 'completed',
    stableNodeId: 'node-key-1', processorToken: token, pageSize: 20
  }, new Date('2026-08-19T02:00:00.000Z'))
  assert.equal(query.grain, 'week')
  assert.equal(query.templateId, 'template-1')
  assert.equal(query.templateVersion, 2)
  assert.equal(query.processorToken, token)
  assert.equal(query.startAt.toISOString(), '2026-07-31T16:00:00.000Z')
  assert.throws(() => normalizeAnalyticsQuery({ templateId: 'template-1', actorId: 'secret' }, new Date()),
    error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => normalizeAnalyticsQuery({ templateId: 'template-1', processorToken: 'user-id' }, new Date()),
    error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => normalizeAnalyticsQuery({ templateId: 'template-1', grain: 'quarter' }, new Date()),
    error => error.code === 'VALIDATION_ERROR')
})
