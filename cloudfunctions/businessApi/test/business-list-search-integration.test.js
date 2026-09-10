const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createBusinessService } = require('../lib/business-service')
const { createBusinessSearchClient } = require('../lib/business-search-client')
const { createCloudSearchRepository } = require('../../businessSearch/lib/cloud-search-repository')
const { createSearchService } = require('../../businessSearch/lib/search-service')

test('real list service signs and consumes status-scoped search tickets end to end across cursor pages', async () => {
  const secret = 'integration-only-search-secret-1234567890'
  const now = new Date('2026-09-09T01:00:00Z')
  const hash = crypto.createHmac('sha256', secret).update('售后').digest('base64url').slice(0, 22)
  const actor = { _id: 'root', status: 'active', role: 'super_admin' }
  const lines = [
    ['line-0', 'active', ['other']], ['line-1', 'active', ['root']],
    ['line-2', 'completed', ['root']], ['line-3', 'active', ['root']],
    ['line-4', 'completed', ['other']]
  ].map(([id, status, members]) => ({
    _id: id, code: id, name: '售后联调', status, currentNodeId: '', createdAt: now,
    managerUserIds: ['other'], memberUserIds: members,
    searchIndexStatus: 'generated', searchSourceVersion: 1, searchGeneratedVersion: 1,
    searchGenerationId: 'generation-1', searchSchemaVersion: 2
  }))
  const fake = createFakeCloudDatabase({
    users: [actor], business_lines: lines,
    business_search_documents: lines.flatMap(line => [
      { _id: `${line._id}-tokens`, documentType: 'tokens', businessLineId: line._id,
        generationId: 'generation-1', entryId: 'name', tokenHashes: [hash] },
      { _id: `${line._id}-entry`, documentType: 'entry', businessLineId: line._id,
        generationId: 'generation-1', entryId: 'name', normalizedText: '售后联调',
        sourceKind: 'business_name', label: '售后名称', safeExcerpt: '售后联调', nodeName: '' }
    ])
  })
  const searchRepository = createCloudSearchRepository({ db: fake.db, clock: () => now, secret })
  const searchService = createSearchService({ repository: searchRepository, secret })
  let ticketSequence = 0
  const client = createBusinessSearchClient({ db: fake.db, secret, clock: () => now,
    randomBytes: size => Buffer.alloc(size, ++ticketSequence),
    async callFunction(input) {
      assert.equal(input.name, 'businessSearch')
      assert.equal(input.data.operation, 'query')
      assert.deepEqual(Object.keys(input.data).sort(), ['operation', 'ticket'])
      return { result: await searchService.queryRequest({ token: input.data.ticket }) }
    }
  })
  const service = createBusinessService({ repository: {},
    workTimeService: { async tryAddWorkMinutes() {} }, businessSearchClient: client })
  const activeQuery = { keyword: '售后', status: 'active', scope: 'mine', pageSize: 1 }
  const first = await service.listBusinessLines({ actor, query: activeQuery })
  assert.deepEqual(first.items.map(item => item._id), ['line-1'])
  assert.equal(first.total, null)
  assert.equal(first.hasMore, true)
  const second = await service.listBusinessLines({ actor, query: { ...activeQuery, cursor: first.cursor } })
  assert.deepEqual(second.items.map(item => item._id), ['line-3'])
  const completed = await service.listBusinessLines({ actor,
    query: { keyword: '售后', status: 'completed', scope: 'mine' } })
  assert.deepEqual(completed.items.map(item => item._id), ['line-2'])
  const global = await service.listBusinessLines({ actor, query: { keyword: '售后' } })
  assert.deepEqual(global.items.map(item => item._id), ['line-0', 'line-1', 'line-2', 'line-3', 'line-4'])
  const tickets = fake.documents('business_search_requests')
  assert.ok(tickets.every(ticket => ticket.status === 'consumed'))
  assert.deepEqual(tickets.slice(0, 3).map(ticket => [ticket.businessStatus, ticket.scope]),
    [['active', 'mine'], ['active', 'mine'], ['completed', 'mine']])
  assert.equal(Object.hasOwn(tickets[3], 'businessStatus'), false)
  assert.equal(Object.hasOwn(tickets[3], 'scope'), false)
})
