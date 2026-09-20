const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudSearchRepository } = require('../lib/cloud-search-repository')
const { buildSearchEntries, tokenizeEntry } = require('../lib/search-domain')
const { validateFieldValues } = require('../../businessApi/lib/field-domain')

const SECRET = 'synthetic-snapshot-test-secret-1234567890'
const VERSION = { searchSourceVersion: 2, searchGeneratedVersion: 1, searchIndexStatus: 'pending' }

function seed() {
  return {
    users: [{ _id: 'test-reader', role: 'super_admin', status: 'active' }],
    business_lines: [{ _id: 'test-line', name: 'Synthetic service', code: 'TEST001',
      description: '', status: 'active', nodeCount: 1, currentNodeId: 'test-node',
      flowSchemaVersion: 2, ...VERSION }],
    business_nodes: [{ _id: 'test-node', businessLineId: 'test-line', sequence: 0,
      name: 'Synthetic node', nodeCode: 'TEST001-N001', status: 'in_progress',
      routeState: 'active', workflowMode: 'review', reviewerUserIds: [],
      processingRoundNumber: 1, latestFeedbackId: 'test-feedback', latestFeedbackRevision: 1,
      ...VERSION }],
    node_feedback: [{ _id: 'test-feedback', businessLineId: 'test-line', nodeId: 'test-node',
      processingRoundNumber: 1, revision: 1, publishState: 'published', action: 'save_progress',
      comment: 'comment-sentinel', evidenceCount: 1, claimedCount: 1,
      fieldValues: [{ fieldKey: 'topic', name: 'Topic', type: 'short_text', value: 'field-sentinel' }] }],
    evidences: [{ _id: 'test-evidence', businessLineId: 'test-line', nodeId: 'test-node',
      feedbackId: 'test-feedback', feedbackRevision: 1, processingRoundNumber: 1,
      attachmentState: 'attached', storageStatus: 'available', feedbackEvidenceOrder: 0,
      fileId: 'cloud://synthetic/test.pdf', fileName: 'attachment-sentinel.pdf' }]
  }
}

function harness(data = seed(), options = {}) {
  const fake = createFakeCloudDatabase(data, options)
  return { fake, repository: createCloudSearchRepository({ db: fake.db, secret: SECRET }) }
}

async function publish(repository) {
  const snapshot = await repository.loadAuthoritativeSnapshot({ businessLineId: 'test-line', sourceVersion: 2 })
  await repository.publishGeneration({ businessLineId: 'test-line', sourceVersion: 2,
    generationId: 'test-generation', entries: buildSearchEntries(snapshot).map(entry => ({
      ...entry, tokenChunks: tokenizeEntry(entry, SECRET)
    })) })
  return snapshot
}

async function find(repository, keyword) {
  return repository.queryAuthorized({ actorId: 'test-reader', normalizedKeywords: [keyword],
    digestInput: keyword, pageSize: 20 })
}

test('linked model and attribute selections remain searchable without indexing hidden options or matrices', async () => {
  const data=seed()
  const fields=Array.from({length:8},(_,index)=>({fieldKey:`f${index}`,sequence:index,name:`字段${index}`,
    type:'single_select',required:true,constraints:{options:['selected-sentinel','unused-sentinel']}}))
  fields[0].optionLinkage={schemaVersion:1,fieldKeys:fields.map(field=>field.fieldKey),
    rows:[[0,0,0,0,null,null,null,null],[1,1,1,null,null,null,null,null]]}
  data.business_nodes[0].fieldDefinitions=fields
  data.node_feedback[0].fieldValues=validateFieldValues(fields,[0,1,2,3].map(index=>({fieldKey:`f${index}`,value:'selected-sentinel'})))
  const {repository,fake}=harness(data)
  await publish(repository)
  assert.equal((await find(repository,'selected-sentinel')).items.length,1)
  assert.equal((await find(repository,'unused-sentinel')).items.length,0)
  assert.equal(JSON.stringify(fake.documents('business_search_documents')).includes('optionLinkage'),false)
})

test('valid omitted optional values do not prevent the complete current generation from publishing', async () => {
  const data = seed()
  const types = ['short_text', 'long_text', 'number', 'boolean', 'date', 'single_select', 'multi_select']
  const definitions = types.map((type, sequence) => ({ fieldKey: `optional-${type}`, name: `Optional ${type}`,
    type, sequence, required: false, constraints: type.endsWith('select') ? { options: ['Choice'] } : {} }))
  data.node_feedback[0].fieldValues.push(...validateFieldValues(definitions, []))
  const { repository, fake } = harness(data)
  await publish(repository)
  assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'generated')
  const result = await find(repository, 'field-sentinel')
  assert.equal(result.items.length, 1)
  const entries = fake.documents('business_search_documents').filter(row => row.documentType === 'entry')
  assert.equal(entries.some(row => row.normalizedText === 'null'), false)
  assert.equal(entries.filter(row => row.sourceKind === 'field_value').length, 1)
})

test('published progress indexes the authoritative comment and attached evidence relation', async () => {
  const { repository } = harness()
  await publish(repository)
  for (const keyword of ['field-sentinel', 'comment-sentinel', 'attachment-sentinel']) {
    const result = await find(repository, keyword)
    assert.equal(result.items.length, 1, keyword)
    assert.ok(result.items[0].matches.some(match => match.excerpt.includes(keyword)))
  }
})

test('a later save retains current-round evidence but replaces old fields and comments', async () => {
  const data = seed()
  data.node_feedback.push({ ...data.node_feedback[0], _id: 'test-feedback-2', revision: 2,
    comment: 'replacement-sentinel', evidenceCount: 0, claimedCount: 0,
    fieldValues: [{ fieldKey: 'topic', name: 'Topic', type: 'short_text', value: 'new-value' }] })
  Object.assign(data.business_nodes[0], { latestFeedbackId: 'test-feedback-2', latestFeedbackRevision: 2 })
  const { repository } = harness(data)
  await publish(repository)
  assert.equal((await find(repository, 'attachment-sentinel')).items.length, 1)
  assert.equal((await find(repository, 'replacement-sentinel')).items.length, 1)
  assert.equal((await find(repository, 'comment-sentinel')).items.length, 0)
  assert.equal((await find(repository, 'field-sentinel')).items.length, 0)
})

test('mark-blocked publishes the same current processing snapshot', async () => {
  const data = seed()
  data.business_nodes[0].status = 'blocked'
  data.node_feedback[0].action = 'mark_blocked'
  const { repository } = harness(data)
  await publish(repository)
  assert.equal((await find(repository, 'comment-sentinel')).items.length, 1)
})

for (const reviewed of [false, true]) {
  test(`v2 manual decision keeps the completed ${reviewed ? 'approved round' : 'direct feedback'} searchable`, async () => {
    const data = seed()
    Object.assign(data.business_nodes[0], { status: 'awaiting_decision', routeState: 'awaiting_manual_decision' })
    data.node_feedback[0].action = 'complete_node'
    if (reviewed) {
      data.business_nodes[0].reviewerUserIds = ['test-reviewer']
      data.business_nodes[0].lastReviewRoundId = 'test-round'
      data.node_review_rounds = [{ _id: 'test-round', businessLineId: 'test-line', nodeId: 'test-node',
        status: 'approved', finalDecision: 'approved', processingRoundNumber: 1,
        fieldValues: data.node_feedback[0].fieldValues, processingComment: 'approved-sentinel',
        evidenceIds: ['test-evidence'] }]
    }
    const { repository } = harness(data)
    await publish(repository)
    assert.equal((await find(repository, reviewed ? 'approved-sentinel' : 'comment-sentinel')).items.length, 1)
    assert.equal((await find(repository, 'attachment-sentinel')).items.length, 1)
  })
}

function rejectedSeed() {
  const data = seed()
  Object.assign(data.business_nodes[0], { processingRoundNumber: 2, lastReviewRoundId: 'rejected-round' })
  data.node_review_rounds = [{ _id: 'rejected-round', businessLineId: 'test-line', nodeId: 'test-node',
    status: 'rejected', finalDecision: 'rejected', processingRoundNumber: 1,
    feedbackId: 'test-feedback', feedbackRevision: 1 }]
  return data
}

test('a rejected round publishes metadata before the new round has feedback without leaking the rejected content', async () => {
  const { repository } = harness(rejectedSeed())
  const snapshot = await publish(repository)
  assert.deepEqual(snapshot.nodes[0].fieldValues, [])
  assert.equal(snapshot.nodes[0].processingComment, '')
  assert.deepEqual(snapshot.nodes[0].evidenceFileNames, [])
  assert.equal((await find(repository, 'synthetic')).items.length, 1)
  for (const keyword of ['field-sentinel', 'comment-sentinel', 'attachment-sentinel']) {
    assert.equal((await find(repository, keyword)).items.length, 0)
  }
})

test('mismatched feedback rounds and unverified rejection pointers still fail closed', async () => {
  for (const mutate of [
    data => { delete data.business_nodes[0].lastReviewRoundId },
    data => { data.node_review_rounds[0].finalDecision = 'approved' },
    data => { data.node_review_rounds[0].businessLineId = 'other-line' },
    data => { data.node_review_rounds[0].feedbackId = 'other-feedback' },
    data => { data.business_nodes[0].processingRoundNumber = 3 },
    data => { data.node_feedback[0].processingRoundNumber = 3 }
  ]) {
    const data = rejectedSeed()
    mutate(data)
    await assert.rejects(harness(data).repository.loadAuthoritativeSnapshot({
      businessLineId: 'test-line', sourceVersion: 2
    }), { code: 'SEARCH_SOURCE_INVALID' })
  }
})

test('progress evidence corruption is not silently omitted', async () => {
  for (const mutate of [
    data => { data.evidences[0].businessLineId = 'other-line' },
    data => { data.evidences[0].processingRoundNumber = 2 },
    data => { data.evidences[0].feedbackRevision = 2 },
    data => { data.evidences[0].attachmentState = 'reserved' },
    data => { data.evidences[0].feedbackEvidenceOrder = 1 },
    data => { data.evidences = [] }
  ]) {
    const data = seed()
    mutate(data)
    await assert.rejects(harness(data).repository.loadAuthoritativeSnapshot({
      businessLineId: 'test-line', sourceVersion: 2
    }), { code: 'SEARCH_SOURCE_INVALID' })
  }
})

test('current-round attachment history uses bounded revision keysets across more than one page', async () => {
  const data = seed()
  for (let revision = 2; revision <= 101; revision += 1) {
    data.node_feedback.push({ ...data.node_feedback[0], _id: `test-feedback-${revision}`, revision,
      comment: 'latest-sentinel', evidenceCount: 0, claimedCount: 0 })
  }
  Object.assign(data.business_nodes[0], { latestFeedbackId: 'test-feedback-101', latestFeedbackRevision: 101 })
  const { repository, fake } = harness(data)
  await publish(repository)
  assert.equal((await find(repository, 'attachment-sentinel')).items.length, 1)
  const queries = fake.queryCalls.filter(call => call.collection === 'node_feedback')
  assert.equal(queries.length, 2)
  assert.equal(queries.every(call => call.limit === 100 && call.offset === 0), true)
  assert.equal(queries[0].criteria.revision.__operator, 'lte')
  assert.equal(queries[0].criteria.revision.value, 101)
  assert.equal(queries[1].criteria.revision.__operator, 'lt')
  assert.equal(queries[1].criteria.revision.value, 2)
})

test('a new saved round excludes old-round evidence even when its feedback remains in history', async () => {
  const data = rejectedSeed()
  data.node_feedback.push({ ...data.node_feedback[0], _id: 'new-round-feedback', revision: 2,
    processingRoundNumber: 2, comment: 'new-round-sentinel', evidenceCount: 0, claimedCount: 0,
    fieldValues: [] })
  Object.assign(data.business_nodes[0], { latestFeedbackId: 'new-round-feedback', latestFeedbackRevision: 2 })
  const { repository } = harness(data)
  await publish(repository)
  assert.equal((await find(repository, 'new-round-sentinel')).items.length, 1)
  assert.equal((await find(repository, 'attachment-sentinel')).items.length, 0)
})

test('progress comment must be an own string and never uses obsolete projection aliases', async () => {
  for (const kind of ['missing', 'null', 'getter', 'inherited']) {
    let getterCalls = 0
    const { repository } = harness(seed(), { transformRead({ collection, data }) {
      if (collection !== 'node_feedback' || data._id !== 'test-feedback') return data
      delete data.comment
      data.processingComment = 'obsolete-alias'
      if (kind === 'null') data.comment = null
      if (kind === 'getter') Object.defineProperty(data, 'comment', {
        get() { getterCalls += 1; return 'accessor-value' }
      })
      if (kind === 'inherited') Object.setPrototypeOf(data, { comment: 'inherited-value' })
      return data
    } })
    await assert.rejects(repository.loadAuthoritativeSnapshot({
      businessLineId: 'test-line', sourceVersion: 2
    }), { code: 'SEARCH_SOURCE_INVALID' })
    assert.equal(getterCalls, 0)
  }
})

test('nullable values do not allow unknown field types or missing/accessor values', () => {
  for (const kind of ['unknown', 'missing', 'getter']) {
    let getterCalls = 0
    const field = { fieldKey: 'optional', name: 'Optional', type: 'short_text', value: null }
    if (kind === 'unknown') field.type = 'file'
    if (kind === 'missing') delete field.value
    if (kind === 'getter') Object.defineProperty(field, 'value', {
      get() { getterCalls += 1; return null }
    })
    assert.throws(() => buildSearchEntries({ businessLineId: 'test-line', name: 'Synthetic', code: 'TEST001',
      description: '', nodes: [{ nodeId: 'test-node', name: 'Synthetic node', code: 'N001',
        fieldValues: [field], processingComment: '', reviewComments: [], evidenceFileNames: [] }] }),
    { code: 'SEARCH_SOURCE_INVALID' })
    assert.equal(getterCalls, 0)
  }
})

for (const manual of [false, true]) {
  test(`reviewerless ${manual ? 'manual decision' : 'completion'} keeps prior current-round attachments`, async () => {
    const data = seed()
    data.node_feedback.push({ ...data.node_feedback[0], _id: 'completion-feedback', revision: 2,
      action: 'complete_node', evidenceCount: 0, claimedCount: 0, comment: 'completed-sentinel' })
    Object.assign(data.business_nodes[0], { latestFeedbackId: 'completion-feedback', latestFeedbackRevision: 2,
      status: manual ? 'awaiting_decision' : 'completed',
      routeState: manual ? 'awaiting_manual_decision' : 'completed' })
    const { repository } = harness(data)
    await publish(repository)
    assert.equal((await find(repository, 'completed-sentinel')).items.length, 1)
    assert.equal((await find(repository, 'attachment-sentinel')).items.length, 1)
  })
}

test('historical attached evidence without an order remains searchable with deterministic ID ordering', async () => {
  const data = seed()
  delete data.evidences[0].feedbackEvidenceOrder
  const { repository } = harness(data)
  await publish(repository)
  assert.equal((await find(repository, 'attachment-sentinel')).items.length, 1)
})

test('historical order compatibility never executes or inherits an order property', async () => {
  for (const kind of ['getter', 'inherited']) {
    let getterCalls = 0
    const { repository } = harness(seed(), { transformRead({ collection, data }) {
      if (collection !== 'evidences') return data
      delete data.feedbackEvidenceOrder
      if (kind === 'getter') Object.defineProperty(data, 'feedbackEvidenceOrder', {
        get() { getterCalls += 1; return 0 }
      })
      else Object.setPrototypeOf(data, { feedbackEvidenceOrder: 0 })
      return data
    } })
    await assert.rejects(repository.loadAuthoritativeSnapshot({
      businessLineId: 'test-line', sourceVersion: 2
    }), { code: 'SEARCH_SOURCE_INVALID' })
    assert.equal(getterCalls, 0)
  }
})
