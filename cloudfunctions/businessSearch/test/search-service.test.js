const test = require('node:test')
const assert = require('node:assert/strict')

const { createSearchService } = require('../lib/search-service')

const SECRET = 'search-secret-for-tests-only-1234567890'

function entryRepository(overrides = {}) {
  const calls = []
  return {
    calls,
    repository: {
      async consumeRequest(input) {
        calls.push(['consumeRequest', input])
        return input.operation === 'query'
          ? {
              operation: 'query', actorId: 'actor-1', normalizedKeywords: ['故障'], digestInput: '故障',
              pageSize: 20, cursor: ''
            }
          : { operation: 'index', actorId: 'actor-1', businessLineId: 'line-1', sourceVersion: 3 }
      },
      async isGenerationCurrent(input) { calls.push(['isGenerationCurrent', input]); return false },
      async loadAuthoritativeSnapshot(input) {
        calls.push(['loadAuthoritativeSnapshot', input])
        return { businessLineId: 'line-1', name: '售后', code: 'BL-1', description: '', nodes: [] }
      },
      async publishGeneration(input) { calls.push(['publishGeneration', input]); return { generatedVersion: 3 } },
      async queryAuthorized(input) { calls.push(['queryAuthorized', input]); return { items: [], cursor: '' } },
      async claimBackfillPage(input) { calls.push(['claimBackfillPage', input]); return [] },
      async claimRecoveryPage(input) { calls.push(['claimRecoveryPage', input]); return [] },
      async cleanupOldGeneration(input) { calls.push(['cleanupOldGeneration', input]); return { cleaned: 0 } },
      ...overrides
    }
  }
}

test('一次性索引按当前快照生成条目并发布新代', async () => {
  const value = entryRepository()
  const service = createSearchService({
    repository: value.repository, secret: SECRET, generationIdFactory: () => 'generation-3'
  })
  const result = await service.indexRequest({ token: 'ticket' })
  assert.deepEqual(result, { businessLineId: 'line-1', sourceVersion: 3, indexStatus: 'generated' })
  assert.deepEqual(value.calls.map(call => call[0]), [
    'consumeRequest', 'isGenerationCurrent', 'loadAuthoritativeSnapshot', 'publishGeneration'
  ])
  const publish = value.calls.find(call => call[0] === 'publishGeneration')[1]
  assert.equal(publish.generationId, 'generation-3')
  assert.ok(publish.entries.length >= 2)
})

test('当前代际幂等返回且一次性查询只使用票据内安全参数', async () => {
  const current = entryRepository({ async isGenerationCurrent() { return true } })
  const indexService = createSearchService({ repository: current.repository, secret: SECRET })
  assert.deepEqual(await indexService.indexRequest({ token: 'ticket' }), {
    businessLineId: 'line-1', sourceVersion: 3, indexStatus: 'generated'
  })
  assert.equal(current.calls.some(call => call[0] === 'loadAuthoritativeSnapshot'), false)

  const query = entryRepository()
  const queryService = createSearchService({ repository: query.repository, secret: SECRET })
  await queryService.queryRequest({ token: 'query-ticket' })
  const input = query.calls.find(call => call[0] === 'queryAuthorized')[1]
  assert.deepEqual(input, {
    actorId: 'actor-1', normalizedKeywords: ['故障'], digestInput: '故障', pageSize: 20, cursor: '',
    startDate: '', endDate: ''
  })
})

test('可信周期固定四十条并隔离单条回填与恢复失败', async () => {
  const value = entryRepository({
    async claimBackfillPage(input) {
      value.calls.push(['claimBackfillPage', input])
      return [
        { businessLineId: 'line-ok', sourceVersion: 1 },
        { businessLineId: 'line-fail', sourceVersion: 2 }
      ]
    },
    async claimRecoveryPage(input) {
      value.calls.push(['claimRecoveryPage', input])
      return [{ businessLineId: 'line-recovery', sourceVersion: 3 }]
    },
    async loadAuthoritativeSnapshot(input) {
      value.calls.push(['loadAuthoritativeSnapshot', input])
      if (input.businessLineId === 'line-fail') throw Object.assign(new Error('private source'), { code: 'PRIVATE' })
      return { businessLineId: input.businessLineId, name: '售后', code: 'BL', description: '', nodes: [] }
    }
  })
  const service = createSearchService({
    repository: value.repository, secret: SECRET, generationIdFactory: request => `gen-${request.sourceVersion}`
  })
  const result = await service.runCycle({ now: new Date('2026-08-25T12:00:00.000Z'), batchSize: 40 })
  assert.deepEqual(result, { examined: 3, generated: 2, failed: 1, cleaned: 0 })
  assert.equal(value.calls.find(call => call[0] === 'claimBackfillPage')[1].batchSize, 40)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('周期拒绝调用方扩大批量', async () => {
  const value = entryRepository()
  const service = createSearchService({ repository: value.repository, secret: SECRET })
  await assert.rejects(service.runCycle({ now: new Date(), batchSize: 41 }), { code: 'INVALID_SEARCH_CYCLE' })
})
