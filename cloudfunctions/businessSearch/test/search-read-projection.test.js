const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudSearchRepository } = require('../lib/cloud-search-repository')
const { createSearchService } = require('../lib/search-service')

const SECRET = 'projection-test-secret-at-least-32-characters'
const TOKEN = 'synthetic-ticket'
const NOW = new Date('2026-10-09T02:00:00Z')
const request = { businessLineId: 'line', sourceVersion: 1 }

function fixture({ legacy = false, options = {} } = {}) {
  const state = { searchSourceVersion: 1, searchGeneratedVersion: 0, searchIndexStatus: 'pending' }
  const catalogue = [{ fieldKey: 'model', type: 'single_select', name: 'Model',
    constraints: { options: Array.from({ length: 3000 }, (_, i) => `Synthetic model ${i}`) } }]
  const line = { _id: 'line', name: 'Synthetic line', code: 'BL-TEST', description: '',
    status: 'active', nodeCount: 2, memberUserIds: ['actor'], managerUserIds: ['actor'],
    version: 1, ...(legacy ? {} : { flowSchemaVersion: 2 }), ...state }
  const nodes = [0, 1].map(sequence => ({ _id: `node-${sequence}`, businessLineId: 'line',
    sequence, name: `Node ${sequence}`, nodeCode: `N${sequence}`,
    status: sequence ? 'waiting' : 'ready', version: 1,
    fieldDefinitions: catalogue, sourceTemplateNodeKey: `source-${sequence}`,
    ...(legacy ? { assigneeUserIds: ['actor'] } : { workflowMode: 'review',
      processingRoundNumber: 1, routeState: sequence ? 'dormant' : 'active' }), ...state }))
  const fake = createFakeCloudDatabase({
    business_lines: [line], business_nodes: nodes,
    users: [{ _id: 'actor', status: 'active', role: 'user' }],
    business_search_requests: [{ _id: crypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex'),
      operation: 'index', actorId: 'actor', ...request, status: 'pending',
      createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60000) }]
  }, options)
  const repository = createCloudSearchRepository({ db: fake.db, secret: SECRET, clock: () => NOW })
  const service = createSearchService({ repository, secret: SECRET,
    generationIdFactory: () => 'generation', logger: { info() {} } })
  return { fake, repository, service, nodes, line }
}

test('V2 indexing reads small node headers but retains complete snapshots and actual-route search output', async () => {
  const h = fixture()
  assert.deepEqual(await h.service.indexRequest({ token: TOKEN }), { ...request, indexStatus: 'generated' })
  const reads = h.fake.readCalls.filter(read => read.collection === 'business_nodes')
  assert.equal(reads.length, 6, 'two snapshot reads, two ID reads, two transaction reads')
  assert(reads.every(read => !read.keys.includes('fieldDefinitions')),
    'indexing must not transfer unused catalogue snapshots')
  assert(reads.every(read => read.bytes < 1000))
  const stored = h.fake.documents('business_nodes')
  assert.deepEqual(stored.map(node => node.fieldDefinitions), h.nodes.map(node => node.fieldDefinitions))
  assert.equal(stored[0].searchIndexStatus, 'generated')
  assert.equal(stored[1].searchIndexStatus, 'pending', 'dormant branch must not be published')
  const entries = h.fake.documents('business_search_documents').filter(doc => doc.documentType === 'entry')
  assert.equal(entries.length, 4)
  assert(entries.every(entry => !entry.nodeId || entry.nodeId === 'node-0'))
  assert.equal(h.fake.documents('business_search_requests')[0].status, 'consumed')
})

test('legacy snapshot keeps definition-presence validation but publication only reads node headers', async () => {
  const h = fixture({ legacy: true })
  assert.equal((await h.service.indexRequest({ token: TOKEN })).indexStatus, 'generated')
  const reads = h.fake.readCalls.filter(read => read.collection === 'business_nodes')
  assert(reads.slice(0, 2).every(read => read.keys.includes('fieldDefinitions')))
  assert(reads.slice(2).every(read => !read.keys.includes('fieldDefinitions')),
    'legacy compatibility does not require full definitions during generation publication')
  assert.equal(h.fake.documents('business_search_documents').filter(doc => doc.documentType === 'entry').length, 6)
})

test('legacy missing definitions remains invalid, not silently accepted as modern', async () => {
  const h = fixture({ legacy: true })
  const { fieldDefinitions, ...invalid } = h.nodes[0]
  h.fake.replace('business_nodes', invalid._id, invalid)
  await assert.rejects(h.service.indexRequest({ token: TOKEN }), { code: 'SEARCH_SOURCE_INVALID' })
  assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
})

for (const kind of ['in_progress', 'blocked', 'pending_review', 'completed', 'awaiting_decision', 'reviewerless']) {
  test(`V2 projection keeps current fields, comments and review results: ${kind}`, async () => {
    const h = fixture()
    const fromFeedback = ['in_progress', 'blocked', 'reviewerless'].includes(kind)
    const final = kind !== 'pending_review'
    const values = [{ fieldKey: 'serial', name: 'Serial', type: 'short_text', value: '000123' }]
    h.fake.replace('business_nodes', 'node-0', { ...h.nodes[0],
      status: kind === 'reviewerless' ? 'completed' : kind, reviewerUserIds: [],
      routeState: kind === 'awaiting_decision' ? 'awaiting_manual_decision' : 'active',
      ...(fromFeedback ? { latestFeedbackId: 'feedback', latestFeedbackRevision: 1 }
        : final ? { lastReviewRoundId: 'round' } : { activeReviewRoundId: 'round' })
    })
    if (fromFeedback) {
      h.fake.replace('node_feedback', 'feedback', { _id: 'feedback', businessLineId: 'line', nodeId: 'node-0',
        processingRoundNumber: 1, revision: 1, publishState: 'published',
        action: kind === 'reviewerless' ? 'complete_node' : kind === 'blocked' ? 'mark_blocked' : 'save_progress',
        fieldValues: values, comment: 'Processing comment', evidenceCount: 0, claimedCount: 0 })
    } else {
      h.fake.replace('node_review_rounds', 'round', { _id: 'round', businessLineId: 'line', nodeId: 'node-0',
        status: final ? 'approved' : 'pending', finalDecision: final ? 'approved' : null,
        processingRoundNumber: 1, fieldValues: values, processingComment: 'Processing comment', evidenceIds: [] })
      h.fake.replace('node_review_votes', 'vote', { _id: 'vote', businessLineId: 'line', nodeId: 'node-0',
        reviewRoundId: 'round', reviewerUserId: 'reviewer', decision: 'approved', comment: 'Review comment' })
    }
    const snapshot = await h.repository.loadAuthoritativeSnapshot(request)
    assert.deepEqual(snapshot.nodes[0], { nodeId: 'node-0', name: 'Node 0', code: 'N0',
      fieldValues: values, processingComment: 'Processing comment',
      reviewComments: fromFeedback ? [] : ['Review comment'], evidenceFileNames: [] })
    assert.equal((await h.service.indexRequest({ token: TOKEN })).indexStatus, 'generated')
    assert(h.fake.readCalls.filter(call => call.collection === 'business_nodes')
      .every(call => !call.keys.includes('fieldDefinitions')))
    assert.deepEqual(h.fake.documents('business_nodes')[0].fieldDefinitions, h.nodes[0].fieldDefinitions)
  })
}

for (const change of [{ businessLineId: 'other' }, { searchSourceVersion: 2 },
  { searchGeneratedVersion: 2 }, { searchIndexStatus: 'broken' }, { routeState: 'broken' }]) {
  test(`publication projection preserves fail-closed source checks: ${Object.keys(change)[0]}`, async () => {
    const h = fixture()
    // Change the source after the ID query, before its publication transaction.
    h.fake.beforeNextTransaction(() => h.fake.replace('business_nodes', 'node-0', { ...h.nodes[0], ...change }))
    await assert.rejects(h.repository.publishGeneration({ ...request, generationId: 'new', entries: [] }))
    assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  })
}

test('V2 query recovery still initializes only missing metadata and retains catalogue', async () => {
  const h = fixture()
  for (const node of h.nodes) {
    const { searchSourceVersion, searchGeneratedVersion, searchIndexStatus, ...missing } = node
    h.fake.replace('business_nodes', node._id, missing)
  }
  const result = await h.repository.loadAuthoritativeSnapshot({
    ...request, recoveryAccess: { actorId: 'actor', role: 'user', startDate: '', endDate: '' }
  })
  assert.equal(result.nodes.length, 1)
  assert.equal(result.nodes[0].name, 'Node 0')
  const stored = h.fake.documents('business_nodes')
  assert.equal(stored[0].searchSourceVersion, 1)
  assert.equal(stored[1].searchSourceVersion, undefined)
  assert.deepEqual(stored.map(node => node.fieldDefinitions), h.nodes.map(node => node.fieldDefinitions))
})
