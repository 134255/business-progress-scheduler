const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createCloudBusinessCardRepository } = require('../lib/cloud-business-card-repository')
const { createBusinessCardService } = require('../lib/business-card-service')

const actor = { _id: 'user-1', role: 'user', status: 'active' }
function setup() {
  const fake = createFakeCloudDatabase({ users: [actor], templates: [{ _id: 'template-1' },
    { _id: 'template-2', cardDisplay: { schemaVersion: 1, revision: 3, fields: [] } }],
    business_lines: [{ _id: 'line-1', sourceTemplateId: 'template-1', version: 1, status: 'active',
      code: 'SYNTHETIC-1', name: '合成售后一', description: '合成说明一', progress: 25,
      nodeCount: 2, currentNodeId: 'node-1', currentNodeName: '合成节点一',
      updatedAt: new Date('2026-09-10T01:00:00Z'),
      managerUserIds: ['user-1'], memberUserIds: ['user-1'] },
    { _id: 'line-2', sourceTemplateId: 'template-2', version: 2, status: 'completed',
      code: 'SYNTHETIC-2', name: '合成售后二', description: '合成说明二', progress: 100,
      nodeCount: 1, currentNodeId: 'node-2', currentNodeName: '合成节点二',
      updatedAt: new Date('2026-09-10T02:00:00Z'),
      managerUserIds: ['user-1'], memberUserIds: ['user-1'] }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'line-1' }],
    node_review_rounds: [{ _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1' }] })
  const businessRepository = createCloudBusinessRepository({ db: fake.db })
  const repository = createCloudBusinessCardRepository({ db: fake.db, businessRepository })
  return { fake, businessRepository, repository, service: createBusinessCardService({ repository }) }
}

for (const strayId of [false, true]) {
  test(`decorates actual ordinary list _id projections with dedup/order/metadata; stray id=${strayId}`, async () => {
    const { service, businessRepository, repository, fake } = setup()
    const page = await businessRepository.listBusinessLines({ actor, query: { page: 1, pageSize: 5 } })
    assert.deepEqual(page.items.map(item => item._id), ['line-2', 'line-1'])
    assert.ok(page.items.every(item => !Object.hasOwn(item, 'id')))
    const originalPage = structuredClone(page)
    const items = [page.items[0], page.items[1], page.items[0]].map(item => ({ ...item,
      ...(strayId ? { id: item._id === 'line-1' ? 'line-2' : 'line-1' } : {}) }))
    const originalItems = structuredClone(items)
    // Warm with the real repository so the DB transaction count measures
    // duplicate summary reads, not unrelated fake snapshot-write conflicts.
    assert.equal((await repository.getSummary({ actor, businessLineId: 'line-1' })).state, 'ready')
    assert.equal((await repository.getSummary({ actor, businessLineId: 'line-2' })).state, 'ready')
    const before = fake.transactionRuns.length
    const result = await service.decorateItems({ actor, items })
    assert.deepEqual(result.map(item => item._id), ['line-2', 'line-1', 'line-2'])
    assert.deepEqual(result.map(item => item.cardSummary), [3, 0, 3].map(configRevision => ({
      state: 'ready', fields: [], configRevision
    })))
    assert.deepEqual(result.map(({ cardSummary, ...base }) => base), originalItems)
    assert.deepEqual(items, originalItems)
    assert.deepEqual(page, originalPage)
    assert.equal(fake.transactionRuns.length - before, 2)
  })

  test(`decorates real-shaped search _id projections preserving matches; stray id=${strayId}`, async () => {
    const { service, repository, fake } = setup()
    // Exact public safeSearchResult shape: no instance source IDs or id alias.
    const searchItems = [
      { _id: 'line-1', code: 'SYNTHETIC-1', name: '合成售后一', status: 'active', currentNodeName: '合成节点一',
        matches: [{ nodeName: '合成节点一', label: '合成字段', excerpt: '合成命中一' }] },
      { _id: 'line-2', code: 'SYNTHETIC-2', name: '合成售后二', status: 'completed', currentNodeName: '合成节点二',
        matches: [{ nodeName: '合成节点二', label: '合成字段', excerpt: '合成命中二' }] }
    ]
    const items = [searchItems[0], searchItems[1], { ...searchItems[0], matches: [] }].map(item => ({ ...item,
      ...(strayId ? { id: item._id === 'line-1' ? 'line-2' : 'line-1' } : {}) }))
    const original = structuredClone(items)
    await repository.getSummary({ actor, businessLineId: 'line-1' })
    await repository.getSummary({ actor, businessLineId: 'line-2' })
    const before = fake.transactionRuns.length
    const result = await service.decorateItems({ actor, items })
    assert.deepEqual(result.map(item => item._id), ['line-1', 'line-2', 'line-1'])
    assert.deepEqual(result.map(item => item.cardSummary), [0, 3, 0].map(configRevision => ({
      state: 'ready', fields: [], configRevision
    })))
    assert.deepEqual(result.map(({ cardSummary, ...base }) => base), original)
    assert.deepEqual(items, original)
    assert.equal(fake.transactionRuns.length - before, 2)
  })
}

test('missing or invalid _id never falls back to a stray valid id', async () => {
  const { service, fake } = setup()
  for (const item of [{ id: 'line-1' }, { _id: '../line-1', id: 'line-1' }]) {
    await assert.rejects(service.decorateItems({ actor, items: [item] }), { code: 'NOT_FOUND' })
  }
  assert.equal(fake.writeCalls.length, 0)
})

for (const [action, payload, result] of [
  ['createBusinessFromTemplate', {}, { id: 'line-1', code: 'SYNTHETIC-1' }],
  ['updateBusinessMetadata', { businessLineId: 'line-1' }, { id: 'line-1', version: 1 }],
  ['submitFeedback', { businessLineId: 'line-1', nodeId: 'node-1', action: 'save_progress' }, { feedbackId: 'f-1' }],
  ['submitFeedback', { businessLineId: 'line-1', nodeId: 'node-1', action: 'complete_node' }, { feedbackId: 'f-1' }],
  ['submitNodeForReview', { businessLineId: 'line-1', nodeId: 'node-1' }, { reviewRoundId: 'round-1' }],
  ['saveAndSubmitNodeForReview', { businessLineId: 'line-1', nodeId: 'node-1' }, { reviewRoundId: 'round-1' }],
  ['submitReviewVote', { reviewRoundId: 'round-1' }, { reviewRoundId: 'round-1', status: 'approved' }],
  ['rejectPreviousNode', { businessLineId: 'line-1', currentNodeId: 'node-1' }, { businessLineId: 'line-1' }],
  ['closeBusinessLine', { businessLineId: 'line-1' }, { businessLineId: 'line-1' }],
  ['amendFrozenBusiness', { businessLineId: 'line-1' }, { businessLineId: 'line-1' }],
  ['decideOptionalTailNode', { businessLineId: 'line-1', nodeId: 'node-1' }, { businessLineId: 'line-1' }],
  ['decideNodeRoute', { businessLineId: 'line-1', nodeId: 'node-1' }, { businessLineId: 'line-1' }],
  ['submitFeedback', { nodeId: 'node-1' }, { feedbackId: 'f-1' }]
]) test(`refreshes actual ${action} result/payload shape`, async () => {
  const { service, fake } = setup(); const original = structuredClone(result)
  assert.equal(await service.refreshAfterMutation({ actor, action, payload, result }), undefined)
  assert.equal(fake.documents('business_lines')[0].cardSummary.schemaVersion, 1)
  assert.deepEqual(result, original)
})

test('unknown actions, invalid IDs and untrusted vote path cannot trigger unrelated refresh', async () => {
  const { service, fake } = setup()
  for (const input of [
    { action: 'getBusinessLine', payload: { businessLineId: 'line-1' }, result: { businessLineId: 'line-1' } },
    { action: 'updateBusinessMetadata', payload: { businessLineId: '../line-1' }, result: {} },
    { action: 'submitReviewVote', payload: { businessLineId: 'line-1', reviewRoundId: 'missing' }, result: {} }
  ]) await service.refreshAfterMutation({ actor, ...input })
  assert.equal(fake.writeCalls.length, 0)
})

test('derived failures never propagate but list authorization failures do', async () => {
  const { service, fake } = setup()
  fake.replace('users', actor._id, { ...actor, status: 'disabled' })
  await service.refreshBusinessLine({ actor, businessLineId: 'line-1' })
  await service.refreshAfterMutation({ actor, action: 'updateBusinessMetadata', payload: { businessLineId: 'line-1' }, result: { id: 'line-1' } })
  await assert.rejects(service.decorateItems({ actor, items: [{ _id: 'line-1' }] }), { code: 'FORBIDDEN' })
  assert.equal(fake.writeCalls.length, 0)
})
