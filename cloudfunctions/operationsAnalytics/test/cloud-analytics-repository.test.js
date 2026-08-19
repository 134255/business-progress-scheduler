'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudAnalyticsRepository } = require('../lib/cloud-analytics-repository')

function harness(overrides = {}) {
  const fake = createFakeCloudDatabase({
    business_nodes: [], business_lines: [], node_review_rounds: [], node_review_votes: [],
    system_settings: [], ...overrides
  })
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
