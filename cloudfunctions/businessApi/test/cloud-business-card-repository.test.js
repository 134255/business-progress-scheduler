const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { APPLICATION_ERROR_MARKER } = require('../lib/cloud-template-repository')
const { createCloudBusinessCardRepository } = require('../lib/cloud-business-card-repository')

const actor = { _id: 'user-1', status: 'active', role: 'user' }
const definitions = [
  { fieldKey: 'quantity', name: '数量', type: 'number', sequence: 0, required: false, constraints: {} },
  { fieldKey: 'confirmed', name: '确认', type: 'boolean', sequence: 1, required: false, constraints: {} }
]
const values = definitions.map((f, index) => ({ fieldKey: f.fieldKey, name: f.name, type: f.type, value: index ? false : 0 }))
function seed() {
  return structuredClone({
    users: [actor],
    templates: [{ _id: 'template-1', status: 'enabled', version: 1, cardDisplay: { schemaVersion: 1, revision: 1,
      fields: [{ nodeKey: 'node-key', fieldKey: 'quantity' }, { nodeKey: 'node-key', fieldKey: 'confirmed' }] } }],
    template_nodes: [{ _id: 'template-node-1', templateId: 'template-1', nodeKey: 'node-key', fields: definitions }],
    business_lines: [{ _id: 'line-1', status: 'active', version: 3, updatedAt: new Date('2026-09-10T00:00:00Z'),
      sourceTemplateId: 'template-1', nodeCount: 1, managerUserIds: ['user-1'], memberUserIds: ['user-1'], currentNodeId: 'node-1' }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'line-1', sourceTemplateNodeKey: 'node-key', sequence: 0,
      workflowMode: 'review', processorUserIds: ['user-1'], reviewerUserIds: ['reviewer-1'],
      processingRoundNumber: 1, reviewRoundNumber: 0, status: 'in_progress', version: 3,
      fieldDefinitions: definitions, latestFeedbackId: 'feedback-1', latestFeedbackRevision: 1 }],
    node_feedback: [{ _id: 'feedback-1', businessLineId: 'line-1', nodeId: 'node-1', revision: 1,
      publishState: 'published', processingRoundNumber: 1, action: 'save_progress', fieldValues: values }],
    node_review_rounds: []
  })
}
function setup(data = seed(), options) {
  const fake = createFakeCloudDatabase(data, options)
  const businessRepository = createCloudBusinessRepository({ db: fake.db })
  return { fake, businessRepository, repository: createCloudBusinessCardRepository({ db: fake.db, businessRepository }) }
}
const pairs = summary => summary.fields.map(f => [f.label, f.value])
const read = repository => repository.getSummary({ actor, businessLineId: 'line-1' })
function round(data, status) {
  const node = data.business_nodes[0]
  node.status = status === 'pending' ? 'pending_review' : 'completed'
  node.reviewRoundNumber = 1
  node[status === 'pending' ? 'activeReviewRoundId' : 'lastReviewRoundId'] = 'round-1'
  data.node_review_rounds = [{ _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', version: 1,
    processingRoundNumber: 1, reviewRoundNumber: 1, status, finalDecision: status === 'pending' ? null : status,
    feedbackId: 'feedback-1', feedbackRevision: 1, fieldValues: values }]
}

for (const state of ['progress', 'pending', 'approved', 'reviewerless', 'legacy', 'manual']) {
  test(`reads only effective ${state} source without mutating authoritative line`, async () => {
    const data = seed()
    if (['pending', 'approved', 'manual'].includes(state)) round(data, state === 'pending' ? 'pending' : 'approved')
    if (state === 'reviewerless') {
      data.business_nodes[0].status = 'completed'; data.business_nodes[0].reviewerUserIds = []
      data.node_feedback[0].action = 'complete_node'
    }
    if (state === 'manual') {
      Object.assign(data.business_lines[0], { flowSchemaVersion: 2, traversedNodeIds: ['node-1'], awaitingManualDecision: true })
      Object.assign(data.business_nodes[0], { status: 'awaiting_decision', routeState: 'awaiting_manual_decision' })
    }
    if (state === 'legacy') {
      for (const key of ['workflowMode', 'processorUserIds', 'reviewerUserIds', 'processingRoundNumber', 'reviewRoundNumber']) delete data.business_nodes[0][key]
      data.business_nodes[0].assigneeUserIds = ['user-1']
      delete data.node_feedback[0].action; delete data.node_feedback[0].processingRoundNumber
      data.node_feedback[0].status = 'in_progress'
    }
    const { repository, fake } = setup(data)
    const before = fake.documents('business_lines')[0]
    const summary = await read(repository)
    assert.equal(summary.state, 'ready')
    assert.deepEqual(pairs(summary), [['数量', '0'], ['确认', '否']])
    const after = fake.documents('business_lines')[0]
    assert.deepEqual({ ...after, cardSummary: undefined }, { ...before, cardSummary: undefined })
    assert.deepEqual(Object.keys(after.cardSummary).sort(), ['schemaVersion', 'templateId', 'configRevision', 'lineVersion', 'fields'].sort())
    assert.deepEqual(Object.keys(summary).sort(), ['configRevision', 'fields', 'state'])
    assert.ok(summary.fields.every(f => Object.keys(f).sort().join(',') === 'id,label,value'))
    assert.ok(fake.queryCalls.every(q => ['business_nodes', 'template_nodes'].includes(q.collection)))
    assert.equal(fake.transactionQueries.length, 0)
    assert.ok(fake.transactionRuns.every(t => t.operations <= 100))
  })
}

for (const status of ['ready', 'waiting', 'in_progress']) test(`never-started ${status} has empty values`, async () => {
  const data = seed(); data.business_nodes[0].status = status
  delete data.business_nodes[0].latestFeedbackId; delete data.business_nodes[0].latestFeedbackRevision
  const { repository } = setup(data)
  assert.deepEqual(pairs(await read(repository)), [['数量', '未填写'], ['确认', '未填写']])
})

test('only a verified rejected round permits stale pointer to become empty new round', async () => {
  const data = seed(); round(data, 'rejected')
  Object.assign(data.business_nodes[0], { status: 'in_progress', processingRoundNumber: 2 })
  const { repository, fake } = setup(data)
  assert.deepEqual(pairs(await read(repository)), [['数量', '未填写'], ['确认', '未填写']])
  fake.replace('business_lines', 'line-1', { ...data.business_lines[0], version: 4 })
  fake.replace('node_review_rounds', 'round-1', { ...data.node_review_rounds[0], feedbackId: 'unrelated' })
  assert.deepEqual(await read(repository), { state: 'unavailable', fields: [], configRevision: 1 })
})

for (const corruption of ['foreignFeedback', 'unpublished', 'wrongRevision', 'staleRound', 'wrongRoundNode', 'pendingFinal', 'modernNull', 'badFields']) {
  test(`fails closed for ${corruption}, not as never-filled`, async () => {
    const data = seed()
    if (corruption === 'foreignFeedback') data.node_feedback[0].businessLineId = 'line-2'
    if (corruption === 'unpublished') data.node_feedback[0].publishState = 'reserved'
    if (corruption === 'wrongRevision') data.node_feedback[0].revision = 2
    if (corruption === 'staleRound') data.business_nodes[0].processingRoundNumber = 2
    if (corruption === 'wrongRoundNode') { round(data, 'pending'); data.node_review_rounds[0].nodeId = 'foreign' }
    if (corruption === 'pendingFinal') { round(data, 'pending'); data.node_review_rounds[0].finalDecision = 'approved' }
    if (corruption === 'modernNull') data.business_nodes[0].workflowMode = null
    if (corruption === 'badFields') data.node_feedback[0].fieldValues[0].value = { value: 1 }
    const { repository } = setup(data)
    assert.deepEqual(await read(repository), { state: 'unavailable', fields: [], configRevision: 1 })
  })
}

for (const routeState of ['dormant', 'skipped']) test(`excludes ${routeState} route values`, async () => {
  const data = seed(); data.business_lines[0].flowSchemaVersion = 2
  data.business_nodes[0].routeState = routeState
  const { repository } = setup(data)
  assert.deepEqual(await read(repository), { state: 'ready', fields: [], configRevision: 1 })
})

test('historical missing field uses bounded current saved definition; existing field uses instance', async () => {
  const data = seed(); data.business_nodes[0].fieldDefinitions = [definitions[0]]
  data.node_feedback[0].fieldValues = [values[0]]
  data.template_nodes[0].fields[0] = { ...definitions[0], name: '当前改名', type: 'short_text' }
  const { repository, fake } = setup(data)
  assert.deepEqual(pairs(await read(repository)), [['数量', '0'], ['确认', '历史无此字段']])
  assert.equal(fake.queryCalls.filter(q => q.collection === 'template_nodes').length, 1)
})

test('absent config is ready empty; deleted template retained config works; missing template unavailable', async () => {
  const data = seed(); delete data.templates[0].cardDisplay
  const first = setup(data)
  assert.deepEqual(await read(first.repository), { state: 'ready', fields: [], configRevision: 0 })
  assert.equal(first.fake.queryCalls.length, 0)
  const retained = seed(); retained.templates[0].status = 'deleted'
  assert.equal((await read(setup(retained).repository)).state, 'ready')
  const missing = seed(); missing.templates = []
  assert.equal((await read(setup(missing).repository)).state, 'unavailable')
})

test('warm cache reads no node, feedback, round or template-node documents', async () => {
  const reads = []
  const { repository } = setup(seed(), { transformRead: entry => { reads.push(entry.collection); return entry.data } })
  const first = await read(repository); reads.length = 0
  assert.deepEqual(await read(repository), first)
  assert.ok(reads.every(c => ['users', 'business_lines', 'templates'].includes(c)))
})

for (const warm of [false, true]) for (const change of ['membership', 'disabled', 'missing', 'deleted']) {
  test(`${warm ? 'warm' : 'cold'} cache cannot bypass ${change} revocation during build`, async () => {
    const { repository, fake } = setup()
    if (warm) await read(repository)
    fake.beforeNextTransaction(() => {
      if (change === 'disabled') fake.replace('users', actor._id, { ...actor, status: 'disabled' })
      else if (change === 'missing') fake.state.users.delete(actor._id)
      else fake.replace('business_lines', 'line-1', { ...fake.documents('business_lines')[0],
        ...(change === 'deleted' ? { status: 'deleted' } : { managerUserIds: [], memberUserIds: [] }) })
    })
    await assert.rejects(read(repository), e => ['FORBIDDEN', 'NOT_FOUND'].includes(e.code) && e[APPLICATION_ERROR_MARKER] === true)
  })
}

test('current nonmember super-admin retains fixed-card access but no fields, then demotion denies', async () => {
  const data = seed(); data.users[0] = { ...actor, role: 'super_admin' }
  data.business_lines[0].managerUserIds = []; data.business_lines[0].memberUserIds = []
  const { repository, businessRepository, fake } = setup(data)
  assert.equal((await businessRepository.getAuthorizedCardLine({ actor, lineId: 'line-1' })).canReadFields, false)
  assert.equal((await read(repository)).state, 'unavailable')
  assert.deepEqual((await read(repository)).fields, [])
  fake.beforeNextTransaction(() => fake.replace('users', actor._id, actor))
  await assert.rejects(read(repository), { code: 'FORBIDDEN' })
})

test('new config invalidates completed-case cache and corrupt cache rebuilds', async () => {
  const data = seed(); round(data, 'approved')
  const { repository, fake } = setup(data); await read(repository)
  fake.replace('templates', 'template-1', { ...data.templates[0], cardDisplay: { schemaVersion: 1, revision: 2,
    fields: [{ nodeKey: 'node-key', fieldKey: 'confirmed' }] } })
  assert.deepEqual(pairs(await read(repository)), [['确认', '否']])
  const line = fake.documents('business_lines')[0]
  fake.replace('business_lines', 'line-1', { ...line, cardSummary: { ...line.cardSummary, fields: [{ id: 'unsafe', label: 'bad', value: 'bad' }] } })
  assert.deepEqual(pairs(await read(repository)), [['确认', '否']])
})

test('concurrent feedback retries once and old build cannot overwrite newer cache', async () => {
  const { repository, fake } = setup()
  fake.beforeNextTransaction(async () => {
    fake.replace('business_lines', 'line-1', { ...fake.documents('business_lines')[0], version: 4 })
    fake.replace('business_nodes', 'node-1', { ...fake.documents('business_nodes')[0], version: 4, latestFeedbackRevision: 2 })
    fake.replace('node_feedback', 'feedback-1', { ...fake.documents('node_feedback')[0], revision: 2,
      fieldValues: [{ ...values[0], value: 7 }, values[1]] })
    assert.deepEqual(pairs(await read(repository)), [['数量', '7'], ['确认', '否']])
  })
  assert.deepEqual(pairs(await read(repository)), [['数量', '7'], ['确认', '否']])
  assert.equal(fake.documents('business_lines')[0].cardSummary.lineVersion, 4)
})

test('repeated conflicts stop after one rebuild with no stale values', async () => {
  const { repository, fake } = setup()
  const conflict = () => fake.replace('business_lines', 'line-1', { ...fake.documents('business_lines')[0],
    version: fake.documents('business_lines')[0].version + 1 })
  fake.beforeNextTransaction(conflict); fake.beforeNextTransaction(conflict)
  assert.equal((await read(repository)).state, 'unavailable')
  assert.equal(fake.queryCalls.filter(q => q.collection === 'business_nodes').length, 2)
})

test('cache-write failure returns freshly revalidated values, never stale cache on source failure', async () => {
  const { repository, fake } = setup()
  fake.failNextWrite({ collection: 'business_lines', operation: 'update', error: new Error('synthetic cache failure') })
  assert.deepEqual(pairs(await read(repository)), [['数量', '0'], ['确认', '否']])
  await read(repository)
  fake.replace('business_lines', 'line-1', { ...fake.documents('business_lines')[0], version: 4 })
  fake.replace('node_feedback', 'feedback-1', { ...fake.documents('node_feedback')[0], publishState: 'reserved' })
  assert.deepEqual(await read(repository), { state: 'unavailable', fields: [], configRevision: 1 })
})

test('current round cannot be completed using a stale last-round pointer when an invalid active pointer exists', async () => {
  const data = seed(); round(data, 'approved'); data.business_nodes[0].activeReviewRoundId = ''
  assert.equal((await read(setup(data).repository)).state, 'unavailable')
})

test('malformed processing review-round counter is unavailable, not silently modern-compatible', async () => {
  const data = seed(); data.business_nodes[0].reviewRoundNumber = null
  assert.equal((await read(setup(data).repository)).state, 'unavailable')
})

test('final source revalidation detects changed feedback even without line version change', async () => {
  const { repository, fake } = setup()
  fake.beforeNextTransaction(() => fake.replace('node_feedback', 'feedback-1', { ...fake.documents('node_feedback')[0],
    fieldValues: [{ ...values[0], value: 8 }, values[1]] }))
  assert.deepEqual(pairs(await read(repository)), [['数量', '8'], ['确认', '否']])
  assert.equal(fake.queryCalls.filter(q => q.collection === 'business_nodes').length, 2)
})

test('config change during source build retries with new selected field order', async () => {
  const { repository, fake } = setup()
  fake.beforeNextTransaction(() => fake.replace('templates', 'template-1', { ...fake.documents('templates')[0],
    cardDisplay: { schemaVersion: 1, revision: 2, fields: [{ nodeKey: 'node-key', fieldKey: 'confirmed' }] } }))
  assert.deepEqual(pairs(await read(repository)), [['确认', '否']])
  assert.equal(fake.documents('business_lines')[0].cardSummary.configRevision, 2)
})

test('cache-write failure cannot return values revoked before read-only fallback', async () => {
  const { repository, fake } = setup()
  fake.failNextWrite({ collection: 'business_lines', operation: 'update', error: new Error('synthetic') })
  fake.beforeNextTransaction(() => {})
  fake.beforeNextTransaction(() => fake.replace('users', actor._id, { ...actor, status: 'disabled' }))
  await assert.rejects(read(repository), { code: 'FORBIDDEN' })
})

test('warm cache held by a former member is not exposed to current global admin nonmember', async () => {
  const { repository, fake } = setup(); await read(repository)
  fake.replace('users', actor._id, { ...actor, role: 'super_admin' })
  fake.replace('business_lines', 'line-1', { ...fake.documents('business_lines')[0], memberUserIds: [], managerUserIds: [] })
  assert.deepEqual((await read(repository)).fields, [])
  fake.beforeNextTransaction(() => fake.replace('users', actor._id, actor))
  await assert.rejects(read(repository), { code: 'FORBIDDEN' })
})

test('unmappable line and oversized node count are unavailable without guessing fields', async () => {
  const data = seed(); delete data.business_nodes[0].sourceTemplateNodeKey
  assert.equal((await read(setup(data).repository)).state, 'unavailable')
  const large = seed(); large.business_lines[0].nodeCount = 49
  const { repository, fake } = setup(large)
  assert.equal((await read(repository)).state, 'unavailable')
  assert.equal(fake.queryCalls.length, 0)
})

// Instrument only the real fake-DB boundary. Serialize its global-snapshot
// transactions so unrelated card writes do not create artificial conflicts.
function measured(data, beforeRead = async () => {}) {
  const fake = createFakeCloudDatabase(data)
  let active = 0, peak = 0, transactionTail = Promise.resolve()
  const reads = []
  function wrap(target, collection, transaction = false, id = null) {
    return new Proxy(target, { get(object, key) {
      if (key === 'get') return async () => {
        active++; peak = Math.max(peak, active)
        const entry = { collection, transaction, id }; reads.push(entry)
        try {
          await beforeRead(entry)
          await new Promise(resolve => setImmediate(resolve))
          return await object.get()
        } finally { active-- }
      }
      if (typeof object[key] !== 'function') return object[key]
      if (['set', 'update', 'remove', 'add'].includes(key)) return object[key].bind(object)
      return (...args) => wrap(object[key](...args), collection, transaction, key === 'doc' ? args[0] : id)
    } })
  }
  const db = { command: fake.db.command, collection: name => wrap(fake.db.collection(name), name),
    runTransaction(callback) {
      const operation = transactionTail.then(() => fake.db.runTransaction(tx => callback({
        collection: name => wrap(tx.collection(name), name, true)
      })))
      transactionTail = operation.catch(() => {})
      return operation
    } }
  const businessRepository = createCloudBusinessRepository({ db })
  const repository = createCloudBusinessCardRepository({ db, businessRepository })
  return { fake, repository, reads, metrics: () => ({ active, peak }) }
}

function multipleCards(count, nodeCount = 4) {
  const data = seed(), baseLine = data.business_lines[0], baseNode = data.business_nodes[0], baseFeedback = data.node_feedback[0]
  data.business_lines = []; data.business_nodes = []; data.node_feedback = []
  data.templates[0].cardDisplay.fields = Array.from({ length: 4 }, (_, i) => ({ nodeKey: `key-${i}`, fieldKey: 'quantity' }))
  for (let card = 0; card < count; card++) {
    const businessLineId = `line-${card}`
    data.business_lines.push({ ...baseLine, _id: businessLineId, currentNodeId: `node-${card}-0`, nodeCount })
    for (let index = 0; index < nodeCount; index++) {
      const nodeId = `node-${card}-${index}`, feedbackId = `feedback-${card}-${index}`
      data.business_nodes.push({ ...baseNode, _id: nodeId, businessLineId, sequence: index,
        sourceTemplateNodeKey: `key-${index}`, latestFeedbackId: feedbackId })
      data.node_feedback.push({ ...baseFeedback, _id: feedbackId, nodeId, businessLineId })
    }
  }
  return data
}

test('request shares template pre-read and max4 pool across 8 cards, reads only 4 of 48 node sources', async () => {
  const harness = measured(multipleCards(8, 48))
  const session = harness.repository.createRequestSession({ actor })
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => session.getSummary({ businessLineId: `line-${i}` })))
  assert.ok(results.every(summary => summary.state === 'ready' && summary.fields.length === 4))
  assert.equal(harness.reads.filter(r => r.collection === 'templates' && !r.transaction).length, 1)
  assert.equal(harness.reads.filter(r => r.collection === 'node_feedback' && !r.transaction).length, 32)
  assert.equal(harness.reads.filter(r => r.collection === 'business_nodes' && r.transaction).length, 32)
  assert.equal(harness.fake.queryCalls.length, 8)
  assert.ok(harness.fake.queryCalls.every(q => q.limit === 48))
  assert.ok(harness.fake.transactionRuns.every(t => t.operations <= 12))
  assert.equal(harness.metrics().peak, 4)
  assert.equal(harness.metrics().active, 0)
})

test('duplicate selected fields share one source and final source read', async () => {
  const harness = measured(seed())
  assert.deepEqual(pairs(await read(harness.repository)), [['数量', '0'], ['确认', '否']])
  assert.equal(harness.reads.filter(r => r.collection === 'node_feedback').length, 2)
})

test('source failure drains every in-flight task before returning unavailable', async () => {
  let release
  const held = new Promise(resolve => { release = resolve })
  let started = 0, settled = false
  const harness = measured(multipleCards(1), async entry => {
    if (entry.collection !== 'node_feedback' || entry.transaction) return
    started++
    if (entry.id === 'feedback-0-0') throw new Error('synthetic source failure')
    await held
  })
  const result = harness.repository.getSummary({ actor, businessLineId: 'line-0' }).then(value => { settled = true; return value })
  while (started < 4) await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  release()
  assert.equal((await result).state, 'unavailable')
  assert.equal(harness.metrics().active, 0)
})

test('historical-label definition query is deduplicated across a request, with fixed-doc revalidation', async () => {
  const data = multipleCards(4)
  data.template_nodes = Array.from({ length: 4 }, (_, index) => ({
    _id: `template-node-${index}`, templateId: 'template-1', nodeKey: `key-${index}`, fields: definitions
  }))
  data.templates[0].definitionNodeIds = data.template_nodes.map(node => node._id)
  data.business_nodes.forEach(node => { node.fieldDefinitions = [] })
  data.node_feedback.forEach(feedback => { feedback.fieldValues = [] })
  const harness = measured(data), session = harness.repository.createRequestSession({ actor })
  const summaries = await Promise.all(Array.from({ length: 4 }, (_, i) => session.getSummary({ businessLineId: `line-${i}` })))
  assert.ok(summaries.every(summary => summary.state === 'ready' && summary.fields.length === 4 &&
    summary.fields.every(field => field.value === '历史无此字段')))
  assert.equal(harness.fake.queryCalls.filter(query => query.collection === 'template_nodes').length, 1)
  assert.equal(harness.reads.filter(read => read.collection === 'template_nodes' && read.transaction).length, 16)
  assert.ok(harness.fake.transactionRuns.every(run => run.operations <= 16))
})

test('same-named nodes/fields map by exact stable keys and configured order', async () => {
  const data = multipleCards(1, 4)
  data.node_feedback.forEach((feedback, i) => { feedback.fieldValues = [{ ...values[0], value: i + 1 }, values[1]] })
  data.templates[0].cardDisplay.fields.reverse()
  assert.deepEqual(pairs(await setup(data).repository.getSummary({ actor, businessLineId: 'line-0' })),
    [['数量', '4'], ['数量', '3'], ['数量', '2'], ['数量', '1']])
})

test('real service deduplicates repeated cards without reordering or mutating items', async () => {
  const { createBusinessCardService } = require('../lib/business-card-service')
  const harness = measured(seed()), service = createBusinessCardService({ repository: harness.repository })
  const items = [{ _id: 'line-1', code: 'SYNTHETIC-1' }, { _id: 'line-1', code: 'SYNTHETIC-1' }]
  const result = await service.decorateItems({ actor, items })
  assert.equal(result.length, 2)
  assert.deepEqual(pairs(result[0].cardSummary), [['数量', '0'], ['确认', '否']])
  assert.deepEqual(result[1].cardSummary, result[0].cardSummary)
  assert.equal(harness.fake.queryCalls.length, 1)
  assert.ok(items.every(item => !Object.hasOwn(item, 'cardSummary')))
})

test('real service drains authorized in-flight cards before propagating an authorization failure', async () => {
  const { createBusinessCardService } = require('../lib/business-card-service')
  let release, started = 0, settled = false
  const held = new Promise(resolve => { release = resolve })
  const harness = measured(multipleCards(2), async entry => {
    if (entry.collection === 'node_feedback' && !entry.transaction) { started++; await held }
  })
  const service = createBusinessCardService({ repository: harness.repository })
  const result = service.decorateItems({ actor, items: [{ _id: 'line-0' }, { _id: 'missing' }] })
  const rejection = assert.rejects(result, { code: 'NOT_FOUND' }).then(() => { settled = true })
  while (!started) await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  release(); await rejection
  assert.equal(harness.metrics().active, 0)
})

test('raw authorization seam uses fixed transaction documents and preserves strict detail access', async () => {
  const data = seed(); data.users[0].role = 'super_admin'
  data.business_lines[0].managerUserIds = []; data.business_lines[0].memberUserIds = []
  const { businessRepository, fake } = setup(data)
  const result = await fake.db.runTransaction(database => businessRepository.getAuthorizedCardLine({ actor, lineId: 'line-1', database }))
  assert.equal(result.actor.role, 'super_admin')
  assert.equal(result.canReadFields, false)
  assert.equal(fake.transactionRuns[0].operations, 2)
  await assert.rejects(businessRepository.getBusinessLine({ actor, lineId: 'line-1' }), { code: 'FORBIDDEN' })
  for (const status of ['creating', 'deleted']) {
    fake.replace('business_lines', 'line-1', { ...data.business_lines[0], status })
    await assert.rejects(businessRepository.getAuthorizedCardLine({ actor, lineId: 'line-1' }),
      error => error.code === 'NOT_FOUND' && error[APPLICATION_ERROR_MARKER] === true)
  }
})

test('legacy membership is reused but never used as fallback for account-schema lines', async () => {
  const data = seed(), legacyActor = { ...actor, openid: 'synthetic-legacy-identity' }
  delete data.business_lines[0].managerUserIds; delete data.business_lines[0].memberUserIds
  data.business_lines[0].memberIds = [legacyActor.openid]
  const { businessRepository, fake } = setup(data)
  assert.equal((await businessRepository.getAuthorizedCardLine({ actor: legacyActor, lineId: 'line-1' })).canReadFields, true)
  fake.replace('business_lines', 'line-1', { ...data.business_lines[0], managerUserIds: [], memberUserIds: [] })
  await assert.rejects(businessRepository.getAuthorizedCardLine({ actor: legacyActor, lineId: 'line-1' }), { code: 'FORBIDDEN' })
})

test('final snapshot equality distinguishes an absent legacy marker from present undefined', async () => {
  const data = seed()
  for (const key of ['workflowMode', 'processorUserIds', 'reviewerUserIds', 'processingRoundNumber', 'reviewRoundNumber']) delete data.business_nodes[0][key]
  data.business_nodes[0].assigneeUserIds = ['user-1']
  delete data.node_feedback[0].action; delete data.node_feedback[0].processingRoundNumber
  data.node_feedback[0].status = 'in_progress'
  const { repository, fake } = setup(data)
  fake.beforeNextTransaction(() => fake.replace('business_nodes', 'node-1', {
    ...fake.documents('business_nodes')[0], workflowMode: undefined
  }))
  assert.deepEqual(await read(repository), { state: 'unavailable', fields: [], configRevision: 1 })
  assert.equal(fake.writeCalls.length, 0)
})
