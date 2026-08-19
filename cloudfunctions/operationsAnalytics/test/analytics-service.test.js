'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createAnalyticsService } = require('../lib/analytics-service')

test('统计服务固定处理节点和业务两类候选并隔离单项失败', async () => {
  const calls = []
  const repository = {
    async claimNodeCandidates(value) { calls.push(['nodes', value]); return [{ sourceId: 'node-1' }, { sourceId: 'node-2' }] },
    async claimBusinessCandidates(value) { calls.push(['lines', value]); return [{ sourceId: 'line-1' }] },
    async claimPendingFactCandidates(value) { calls.push(['refresh', value]); return [{ sourceType: 'node', sourceId: 'node-3' }] },
    async readNodeSource(value) { if (value.sourceId === 'node-2') throw new Error('broken'); return value },
    async readBusinessSource(value) { return value }
  }
  const service = createAnalyticsService({ analyticsRepository: repository, nodeMaterializer: async () => [] })
  assert.deepEqual(await service.runCycle({ now: new Date('2026-08-19T03:00:00Z'), batchSize: 40 }), {
    nodeExamined: 2, businessExamined: 1, refreshExamined: 1,
    nodeGenerated: 0, businessGenerated: 0, refreshed: 0, failed: 1
  })
  assert.equal(calls.every(([, value]) => value.limit === 40), true)
})

test('统计服务拒绝客户端可控批量和损坏仓储返回', async () => {
  const repository = {
    async claimNodeCandidates() { return null },
    async claimBusinessCandidates() { return [] },
    async claimPendingFactCandidates() { return [] },
    async readNodeSource() {},
    async readBusinessSource() {}
  }
  const service = createAnalyticsService({ analyticsRepository: repository })
  await assert.rejects(service.runCycle({ now: new Date(), batchSize: 41 }), /batchSize/)
  await assert.rejects(service.runCycle({ now: new Date(), batchSize: 40 }), /candidate page/)
})
