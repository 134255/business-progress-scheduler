'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  factId,
  dailyRollupId,
  summarizeNodeFacts,
  bucketDay,
  aggregateRollups,
  safeAverage
} = require('../lib/analytics-domain')

test('节点样本累计全部处理轮与全部终态审核轮并按实际参与人归属', () => {
  const result = summarizeNodeFacts({
    rounds: [
      { _id: 'round-1', status: 'rejected', submittedByUserId: 'processor-a',
        processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 20 },
      { _id: 'round-2', status: 'approved', submittedByUserId: 'processor-b',
        processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 10 }
    ],
    votes: [
      { _id: 'vote-1', reviewRoundId: 'round-1', reviewerUserId: 'reviewer-a', decision: 'rejected',
        reviewResponseTimingStatus: 'calculated', reviewResponseWorkMinutes: 3 },
      { _id: 'vote-2', reviewRoundId: 'round-2', reviewerUserId: 'reviewer-a', decision: 'approved',
        reviewResponseTimingStatus: 'calculated', reviewResponseWorkMinutes: 2 }
    ],
    reviewMinuteByRoundId: new Map([
      ['round-1', { timingStatus: 'calculated', workMinutes: 8 }],
      ['round-2', { timingStatus: 'calculated', workMinutes: 4 }]
    ])
  })

  assert.deepEqual(result.processing, { timingStatus: 'calculated', workMinutes: 30 })
  assert.deepEqual(result.reviewProcess, { timingStatus: 'calculated', workMinutes: 12 })
  assert.deepEqual(result.processorContributions, [
    { userId: 'processor-a', timingStatus: 'calculated', workMinutes: 20 },
    { userId: 'processor-b', timingStatus: 'calculated', workMinutes: 10 }
  ])
  assert.deepEqual(result.reviewerContributions, [
    { userId: 'reviewer-a', timingStatus: 'calculated', workMinutes: 12 }
  ])
  assert.deepEqual(result.reviewResponses, [
    { voteId: 'vote-1', userId: 'reviewer-a', timingStatus: 'calculated', workMinutes: 3 },
    { voteId: 'vote-2', userId: 'reviewer-a', timingStatus: 'calculated', workMinutes: 2 }
  ])
})

test('待补算不会伪装为零且历史缺失不会被推测', () => {
  const pending = summarizeNodeFacts({
    rounds: [{ _id: 'round-1', status: 'approved', submittedByUserId: 'processor-a',
      processingRoundTimingStatus: 'pending_calendar', processingRoundWorkMinutes: null }],
    votes: [],
    reviewMinuteByRoundId: new Map([['round-1', { timingStatus: 'pending_calendar', workMinutes: null }]])
  })
  assert.equal(pending.processing.timingStatus, 'pending_calendar')
  assert.equal(pending.reviewProcess.timingStatus, 'pending_calendar')

  const historical = summarizeNodeFacts({
    rounds: [{ _id: 'round-old', status: 'approved', submittedByUserId: 'processor-a' }],
    votes: [],
    reviewMinuteByRoundId: new Map()
  })
  assert.equal(historical.processing.timingStatus, 'historical_unrecorded')
  assert.equal(historical.reviewProcess.timingStatus, 'historical_unrecorded')
})

test('零分钟合法且平均值只保留一位小数', () => {
  const result = summarizeNodeFacts({
    rounds: [{ _id: 'round-1', status: 'approved', submittedByUserId: 'processor-a',
      processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 0 }],
    votes: [],
    reviewMinuteByRoundId: new Map([['round-1', { timingStatus: 'calculated', workMinutes: 0 }]])
  })
  assert.equal(result.processing.workMinutes, 0)
  assert.equal(safeAverage(10, 3), 3.3)
  assert.equal(safeAverage(0, 2), 0)
  assert.equal(safeAverage(0, 0), null)
})

test('上海自然日按日、周一和月稳定分桶', () => {
  assert.equal(bucketDay('2026-08-19', 'day'), '2026-08-19')
  assert.equal(bucketDay('2026-08-19', 'week'), '2026-08-17')
  assert.equal(bucketDay('2026-08-19', 'month'), '2026-08')
  assert.throws(() => bucketDay('2026-02-30', 'day'), /VALIDATION_ERROR/)
})

test('每日汇总按粒度组合并保留缺失计数', () => {
  const rows = [
    { day: '2026-08-17', sampleCount: 1, totalMinutes: 10, pendingCount: 0, unrecordedCount: 1 },
    { day: '2026-08-18', sampleCount: 2, totalMinutes: 20, pendingCount: 1, unrecordedCount: 0 }
  ]
  assert.deepEqual(aggregateRollups(rows, 'week'), [{
    bucket: '2026-08-17', sampleCount: 3, totalMinutes: 30, averageMinutes: 10,
    pendingCount: 1, unrecordedCount: 1
  }])
})

test('事实与每日汇总编号确定且区分维度', () => {
  assert.equal(factId('node_completed', ['line-1', 'node-1']), factId('node_completed', ['line-1', 'node-1']))
  assert.notEqual(factId('node_completed', ['line-1', 'node-1']), factId('node_completed', ['line-1', 'node-2']))
  const base = { day: '2026-08-19', templateId: 'template-1', templateVersion: 2,
    stableNodeId: 'node-key-1', metric: 'node_processing', dimensionRole: 'global', dimensionUserId: '' }
  assert.equal(dailyRollupId(base), dailyRollupId(base))
  assert.notEqual(dailyRollupId(base), dailyRollupId({ ...base, dimensionRole: 'processor', dimensionUserId: 'user-1' }))
})
