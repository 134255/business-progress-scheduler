'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudAnalyticsRepository } = require('../lib/cloud-analytics-repository')

function harness(overrides = {}) {
  const fake = createFakeCloudDatabase({
    business_nodes: [], business_lines: [], node_review_rounds: [], node_review_votes: [],
    system_settings: [], ...overrides
  }, { rejectExplicitIdOnSet: true })
  return { fake, repository: createCloudAnalyticsRepository({ db: fake.db }) }
}

test('节点候选使用持久游标有界扫描，尾部为空后回绕', async () => {
  const nodes = Array.from({ length: 41 }, (_, index) => ({
    _id: `node-${String(index + 1).padStart(2, '0')}`,
    analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1,
    businessLineId: 'line-1'
  }))
  const { repository } = harness({ business_nodes: nodes })
  const first = await repository.claimNodeCandidates({ limit: 40 })
  const second = await repository.claimNodeCandidates({ limit: 40 })
  const third = await repository.claimNodeCandidates({ limit: 40 })
  assert.equal(first.length, 40)
  assert.deepEqual(second.map(item => item.sourceId), ['node-41'])
  assert.equal(third[0].sourceId, 'node-01')
})

test('损坏游标和非法批量失败关闭', async () => {
  const { repository } = harness({ system_settings: [{
    _id: 'operations-analytics-node-cursor', kind: 'operations_analytics_node', cursorId: 42, version: 1
  }] })
  await assert.rejects(repository.claimNodeCandidates({ limit: 40 }), /cursor is invalid/)
  await assert.rejects(repository.claimBusinessCandidates({ limit: 41 }), /limit/)
})

test('节点和业务来源仅按固定文档与受限查询读取', async () => {
  const { repository } = harness({
    business_lines: [{ _id: 'line-1', analyticsSnapshotStatus: 'pending' }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'line-1', analyticsSnapshotStatus: 'pending' }],
    node_review_rounds: [{ _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1' }],
    node_review_votes: [{ _id: 'vote-1', businessLineId: 'line-1', nodeId: 'node-1', reviewRoundId: 'round-1' }]
  })
  const node = await repository.readNodeSource({ sourceId: 'node-1' })
  assert.equal(node.line._id, 'line-1')
  assert.deepEqual(node.rounds.map(item => item._id), ['round-1'])
  assert.deepEqual(node.votes.map(item => item._id), ['vote-1'])
  const line = await repository.readBusinessSource({ sourceId: 'line-1' })
  assert.deepEqual(line.nodes.map(item => item._id), ['node-1'])
})

test('确定性事实重复应用不重复累计且生成后原子关闭来源', async () => {
  const { fake, repository } = harness({
    business_lines: [{ _id: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    operations_analytics_facts: [], operations_analytics_daily: []
  })
  const fact = {
    _id: 'analytics-fact-1', sourceType: 'node', sourceId: 'node-1', sourceVersion: 1,
    businessLineId: 'line-1', nodeId: 'node-1', factType: 'node_completed', metric: 'node_processing',
    day: '2026-08-19', templateId: 'template-1', templateVersion: 2, stableNodeId: 'stable-1',
    dimensionRole: 'global', dimensionUserId: '', timingStatus: 'calculated', workMinutes: 90
  }
  assert.deepEqual(await repository.applyFact(fact), { applied: true })
  assert.deepEqual(await repository.applyFact(fact), { applied: false })
  await assert.rejects(repository.applyFact({ ...fact, workMinutes: 91 }), /fact conflict/)
  assert.equal(fake.documents('operations_analytics_daily')[0].sampleCount, 1)
  assert.equal(fake.documents('operations_analytics_daily')[0].totalMinutes, 90)
  assert.equal(fake.documents('operations_analytics_daily')[0].minimumMinutes, 90)
  assert.equal(fake.documents('operations_analytics_daily')[0].maximumMinutes, 90)
  assert.deepEqual(await repository.markSourceGenerated({ sourceType: 'node', sourceId: 'node-1', sourceVersion: 1 }), { generated: true })
  assert.equal(fake.documents('business_nodes')[0].analyticsSnapshotStatus, 'generated')
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})

test('追加节点决定使用独立来源游标且不等待节点终态', async () => {
  const { repository } = harness({
    business_lines: [{ _id: 'line-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'in_progress', decision: 'activate',
      decisionAnalyticsSnapshotStatus: 'pending', decisionAnalyticsSourceVersion: 1
    }]
  })
  assert.deepEqual(await repository.claimDecisionCandidates({ limit: 40 }), [{ sourceId: 'node-1' }])
  const source = await repository.readDecisionSource({ sourceId: 'node-1' })
  assert.equal(source.node.status, 'in_progress')
  assert.equal(source.node.decision, 'activate')
})

test('追加节点决定来源可独立关闭而不改变节点完成统计来源', async () => {
  const { fake, repository } = harness({
    business_lines: [{ _id: 'line-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', decisionAnalyticsSnapshotStatus: 'pending',
      decisionAnalyticsSourceVersion: 1
    }],
    operations_analytics_facts: [], operations_analytics_daily: []
  })
  const event = {
    _id: 'analytics-fact-event', sourceType: 'optional_tail_decision', sourceId: 'node-1', sourceVersion: 1,
    businessLineId: 'line-1', nodeId: 'node-1', day: '2026-08-29', templateId: 'template-1',
    templateVersion: 1, stableNodeId: 'tail-1', nodeName: '追加回访', nodeSequence: 1,
    factType: 'optional_tail_activation', metric: 'optional_tail_activation', dimensionRole: 'global',
    dimensionUserId: '', dimensionFilterToken: '', dimensionDisplayName: '', sampleValue: 1
  }
  assert.deepEqual(await repository.applyFact(event), { applied: true })
  assert.deepEqual(await repository.markSourceGenerated({
    sourceType: 'optional_tail_decision', sourceId: 'node-1', sourceVersion: 1
  }), { generated: true })
  const [node] = fake.documents('business_nodes')
  assert.equal(node.decisionAnalyticsSnapshotStatus, 'generated')
  assert.equal(node.decisionAnalyticsGeneratedVersion, 1)
  assert.equal(Object.hasOwn(node, 'analyticsSnapshotStatus'), false)
})

test('追加节点启用事件按样本值累计而不冒充工时事实', async () => {
  const { fake, repository } = harness({
    business_lines: [{ _id: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    operations_analytics_facts: [], operations_analytics_daily: []
  })
  const event = {
    _id: 'analytics-fact-event', sourceType: 'node', sourceId: 'node-1', sourceVersion: 1,
    businessLineId: 'line-1', nodeId: 'node-1', day: '2026-08-29', templateId: 'template-1',
    templateVersion: 1, stableNodeId: 'tail-1', nodeName: '追加回访', nodeSequence: 1,
    factType: 'optional_tail_activation', metric: 'optional_tail_activation', dimensionRole: 'global',
    dimensionUserId: '', dimensionFilterToken: '', dimensionDisplayName: '', sampleValue: 1
  }
  assert.deepEqual(await repository.applyFact(event), { applied: true })
  assert.deepEqual(await repository.applyFact(event), { applied: false })
  const rollup = fake.documents('operations_analytics_daily')[0]
  assert.equal(rollup.sampleCount, 1)
  assert.equal(rollup.totalMinutes, 1)
  assert.equal(rollup.minimumMinutes, null)
  assert.equal(rollup.maximumMinutes, null)
})

test('通用人工分支决定可应用事实并独立关闭决定来源', async () => {
  const { fake, repository } = harness({
    business_lines: [{ _id: 'line-1' }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', decisionAnalyticsSnapshotStatus: 'pending',
      decisionAnalyticsSourceVersion: 2
    }],
    operations_analytics_facts: [], operations_analytics_daily: []
  })
  const event = {
    _id: 'analytics-fact-manual-event', sourceType: 'manual_route_decision', sourceId: 'node-1', sourceVersion: 2,
    businessLineId: 'line-1', nodeId: 'node-1', day: '2026-09-03', templateId: 'template-1',
    templateVersion: 4, stableNodeId: 'branch-1', nodeName: '分流', nodeSequence: 1,
    factType: 'manual_route_activation', metric: 'manual_route_activation', dimensionRole: 'global',
    dimensionUserId: '', dimensionFilterToken: '', dimensionDisplayName: '', sampleValue: 0
  }
  assert.deepEqual(await repository.applyFact(event), { applied: true })
  assert.deepEqual(await repository.markSourceGenerated({
    sourceType: 'manual_route_decision', sourceId: 'node-1', sourceVersion: 2
  }), { generated: true })
  assert.equal(fake.documents('operations_analytics_daily')[0].totalMinutes, 0)
  assert.equal(fake.documents('business_nodes')[0].decisionAnalyticsGeneratedVersion, 2)
})

test('待补算和历史未记录只增加各自缺失计数', async () => {
  const { fake, repository } = harness({
    business_lines: [{ _id: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    operations_analytics_facts: [], operations_analytics_daily: []
  })
  const base = {
    sourceType: 'node', sourceId: 'node-1', sourceVersion: 1, businessLineId: 'line-1', nodeId: 'node-1',
    factType: 'node_completed', metric: 'node_processing', day: '2026-08-19', templateId: 'template-1',
    templateVersion: 2, stableNodeId: 'stable-1', dimensionRole: 'global', dimensionUserId: '', workMinutes: null
  }
  await repository.applyFact({ ...base, _id: 'analytics-fact-pending', timingStatus: 'pending_calendar' })
  await repository.applyFact({ ...base, _id: 'analytics-fact-old', factType: 'review_process', metric: 'node_review', timingStatus: 'historical_unrecorded' })
  const rows = fake.documents('operations_analytics_daily')
  assert.equal(rows.find(item => item.metric === 'node_processing').pendingCount, 1)
  assert.equal(rows.find(item => item.metric === 'node_review').unrecordedCount, 1)
})

test('待补算事实由独立游标签发并只单向转换一次到有效样本', async () => {
  const { fake, repository } = harness({
    business_lines: [{ _id: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'line-1', analyticsSnapshotStatus: 'pending', analyticsSourceVersion: 1 }],
    operations_analytics_facts: [], operations_analytics_daily: []
  })
  const pending = {
    _id: 'analytics-fact-refresh', sourceType: 'node', sourceId: 'node-1', sourceVersion: 1,
    businessLineId: 'line-1', nodeId: 'node-1', factType: 'node_completed', metric: 'node_processing',
    day: '2026-08-19', templateId: 'template-1', templateVersion: 2, stableNodeId: 'stable-1',
    dimensionRole: 'global', dimensionUserId: '', timingStatus: 'pending_calendar', workMinutes: null
  }
  await repository.applyFact(pending)
  await repository.markSourceGenerated({ sourceType: 'node', sourceId: 'node-1', sourceVersion: 1 })

  assert.deepEqual(await repository.claimPendingFactCandidates({ limit: 40 }), [
    { sourceType: 'node', sourceId: 'node-1' }
  ])
  const calculated = { ...pending, timingStatus: 'calculated', workMinutes: 75 }
  assert.deepEqual(await repository.applyFact(calculated), { applied: true })
  assert.deepEqual(await repository.applyFact(calculated), { applied: false })
  assert.deepEqual(await repository.claimPendingFactCandidates({ limit: 40 }), [])

  const fact = fake.documents('operations_analytics_facts').find(item => item._id === pending._id)
  const rollup = fake.documents('operations_analytics_daily')[0]
  assert.equal(fact.timingStatus, 'calculated')
  assert.equal(fact.workMinutes, 75)
  assert.equal(rollup.pendingCount, 0)
  assert.equal(rollup.sampleCount, 1)
  assert.equal(rollup.totalMinutes, 75)
  assert.equal(rollup.minimumMinutes, 75)
  assert.equal(rollup.maximumMinutes, 75)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
})
