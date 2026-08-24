'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  factId,
  dailyRollupId,
  summarizeNodeFacts,
  bucketDay,
  aggregateRollups,
  safeAverage,
  materializeNodeSource,
  materializeBusinessSource
} = require('../lib/analytics-domain')

test('节点样本累计全部处理轮与全部终态审核轮并按实际参与人归属', () => {
  const result = summarizeNodeFacts({
    rounds: [
      { _id: 'round-1', status: 'rejected', submittedBy: 'processor-a',
        processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 20 },
      { _id: 'round-2', status: 'approved', submittedBy: 'processor-b',
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

test('发起人审核快照只有实际投票后才生成个人响应工时', () => {
  const round = {
    _id: 'round-creator', status: 'approved', reviewerAssignmentMode: 'business_creator',
    reviewerUserIds: ['creator-1'], submittedBy: 'processor-a',
    processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 10
  }
  const withoutVote = summarizeNodeFacts({
    rounds: [round], votes: [],
    reviewMinuteByRoundId: new Map([['round-creator', { timingStatus: 'calculated', workMinutes: 5 }]])
  })
  assert.deepEqual(withoutVote.reviewResponses, [])

  const withVote = summarizeNodeFacts({
    rounds: [round],
    votes: [{
      _id: 'vote-creator', reviewRoundId: 'round-creator', reviewerUserId: 'creator-1',
      decision: 'approved', reviewResponseTimingStatus: 'calculated', reviewResponseWorkMinutes: 3
    }],
    reviewMinuteByRoundId: new Map([['round-creator', { timingStatus: 'calculated', workMinutes: 5 }]])
  })
  assert.deepEqual(withVote.reviewResponses, [{
    voteId: 'vote-creator', userId: 'creator-1', timingStatus: 'calculated', workMinutes: 3
  }])
})

test('待补算不会伪装为零且历史缺失不会被推测', () => {
  const pending = summarizeNodeFacts({
    rounds: [{ _id: 'round-1', status: 'approved', submittedBy: 'processor-a',
      processingRoundTimingStatus: 'pending_calendar', processingRoundWorkMinutes: null }],
    votes: [],
    reviewMinuteByRoundId: new Map([['round-1', { timingStatus: 'pending_calendar', workMinutes: null }]])
  })
  assert.equal(pending.processing.timingStatus, 'pending_calendar')
  assert.equal(pending.reviewProcess.timingStatus, 'pending_calendar')

  const historical = summarizeNodeFacts({
    rounds: [{ _id: 'round-old', status: 'approved', submittedBy: 'processor-a' }],
    votes: [],
    reviewMinuteByRoundId: new Map()
  })
  assert.equal(historical.processing.timingStatus, 'historical_unrecorded')
  assert.equal(historical.reviewProcess.timingStatus, 'historical_unrecorded')
})

test('零分钟合法且平均值只保留一位小数', () => {
  const result = summarizeNodeFacts({
    rounds: [{ _id: 'round-1', status: 'approved', submittedBy: 'processor-a',
      processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 0 }],
    votes: [],
    reviewMinuteByRoundId: new Map([['round-1', { timingStatus: 'calculated', workMinutes: 0 }]])
  })
  assert.equal(result.processing.workMinutes, 0)
  assert.equal(safeAverage(10, 3), 3.3)
  assert.equal(safeAverage(0, 2), 0)
  assert.equal(safeAverage(0, 0), null)
})

test('节点来源生成处理、审核、参与人和投票响应事实并按稳定节点键归组', () => {
  const source = {
    line: { _id: 'line-1', sourceTemplateId: 'template-1', sourceTemplateVersion: 2 },
    node: {
      _id: 'node-1', businessLineId: 'line-1', sourceTemplateNodeKey: 'stable-node-1',
      name: '资料审核', sequence: 0, analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1,
      analyticsCompletedAt: new Date('2026-08-19T08:00:00.000Z')
    },
    rounds: [{
      _id: 'round-1', status: 'approved', submittedBy: 'processor-a', submittedByDisplayName: '处理人甲',
      processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 90,
      reviewTimingStatus: 'calculated', reviewElapsedWorkMinutes: 30
    }],
    votes: [{
      _id: 'vote-1', reviewRoundId: 'round-1', reviewerUserId: 'reviewer-a', reviewerDisplayName: '审核人甲',
      decision: 'approved', reviewResponseTimingStatus: 'calculated', reviewResponseWorkMinutes: 12
    }]
  }
  const facts = materializeNodeSource(source)
  assert.deepEqual(facts.map(item => [item.factType, item.metric, item.dimensionRole, item.workMinutes]), [
    ['node_completed', 'node_processing', 'global', 90],
    ['processor_contribution', 'node_processing', 'processor', 90],
    ['review_process', 'node_review', 'global', 30],
    ['reviewer_process_contribution', 'node_review', 'reviewer', 30],
    ['review_response', 'review_response', 'reviewer', 12]
  ])
  assert.equal(facts.every(item => item.stableNodeId === 'stable-node-1' && item.day === '2026-08-19'), true)
  assert.equal(facts.every(item => item.nodeName === '资料审核' && item.nodeSequence === 0), true)
  const processor = facts.find(item => item.dimensionRole === 'processor')
  assert.match(processor.dimensionFilterToken, /^[a-f0-9]{64}$/)
  assert.notEqual(processor.dimensionFilterToken, 'processor-a')
  assert.equal(facts.find(item => item.dimensionRole === 'global').dimensionFilterToken, '')
})

test('业务来源生成业务完成和每业务节点累计指标，日历缺失不伪装为零', async () => {
  const source = {
    line: {
      _id: 'line-1', sourceTemplateId: 'template-1', sourceTemplateVersion: 2,
      createdAt: new Date('2026-08-18T01:00:00Z'), analyticsCompletedAt: new Date('2026-08-19T08:00:00Z'),
      analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1
    },
    nodes: [
      { _id: 'node-1', businessLineId: 'line-1', sourceTemplateNodeKey: 'stable-node-1',
        analyticsSnapshotStatus: 'generated', analyticsSourceVersion: 1, analyticsGeneratedVersion: 1 }
    ],
    nodeFacts: [
      { sourceType: 'node', sourceId: 'node-1', sourceVersion: 1, businessLineId: 'line-1', nodeId: 'node-1',
        templateId: 'template-1', templateVersion: 2, stableNodeId: 'stable-node-1',
        metric: 'node_processing', dimensionRole: 'global', timingStatus: 'calculated', workMinutes: 90 },
      { sourceType: 'node', sourceId: 'node-1', sourceVersion: 1, businessLineId: 'line-1', nodeId: 'node-1',
        templateId: 'template-1', templateVersion: 2, stableNodeId: 'stable-node-1',
        metric: 'node_review', dimensionRole: 'global', timingStatus: 'calculated', workMinutes: 30 }
    ]
  }
  const facts = await materializeBusinessSource(source, {
    async workingMinutesBetween() { return { status: 'pending_calendar', minutes: null } }
  })
  assert.deepEqual(facts.map(item => [item.metric, item.timingStatus, item.workMinutes]), [
    ['business_completion', 'pending_calendar', null],
    ['business_node_processing_total', 'calculated', 90],
    ['business_review_total', 'calculated', 30]
  ])
})

test('业务汇总在任一节点统计尚未生成时失败关闭', async () => {
  await assert.rejects(materializeBusinessSource({
    line: {
      _id: 'line-1', sourceTemplateId: 'template-1', sourceTemplateVersion: 1,
      createdAt: new Date('2026-08-18T01:00:00Z'), analyticsCompletedAt: new Date('2026-08-19T08:00:00Z'),
      analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1
    },
    nodes: [{ _id: 'node-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    nodeFacts: []
  }, { async workingMinutesBetween() { return { status: 'calculated', minutes: 1 } } }), /VALIDATION_ERROR/)
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

test('业务汇总必须完整绑定每个节点的处理与审核全局事实', async () => {
  const line = {
    _id: 'line-1', sourceTemplateId: 'template-1', sourceTemplateVersion: 1,
    createdAt: new Date('2026-08-18T01:00:00Z'), analyticsCompletedAt: new Date('2026-08-19T08:00:00Z'),
    analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1
  }
  const node = {
    _id: 'node-1', businessLineId: 'line-1', sourceTemplateNodeKey: 'stable-1', name: '节点一', sequence: 0,
    analyticsSnapshotStatus: 'generated', analyticsSourceVersion: 2, analyticsGeneratedVersion: 2
  }
  const validFacts = ['node_processing', 'node_review'].map(metric => ({
    _id: `fact-${metric}`, sourceType: 'node', sourceId: 'node-1', sourceVersion: 2,
    businessLineId: 'line-1', nodeId: 'node-1', templateId: 'template-1', templateVersion: 1,
    stableNodeId: 'stable-1', nodeName: '节点一', nodeSequence: 0, metric,
    dimensionRole: 'global', timingStatus: 'calculated', workMinutes: 1
  }))
  const service = { async workingMinutesBetween() { return { status: 'calculated', minutes: 1 } } }
  for (const nodeFacts of [
    validFacts.slice(0, 1),
    [...validFacts, validFacts[0]],
    validFacts.map(fact => fact.metric === 'node_review' ? { ...fact, sourceVersion: 1 } : fact),
    validFacts.map(fact => fact.metric === 'node_review' ? { ...fact, businessLineId: 'line-other' } : fact)
  ]) {
    await assert.rejects(materializeBusinessSource({ line, nodes: [node], nodeFacts }, service), /VALIDATION_ERROR/)
  }
  const facts = await materializeBusinessSource({ line, nodes: [node], nodeFacts: validFacts }, service)
  assert.equal(facts.length, 3)
})
