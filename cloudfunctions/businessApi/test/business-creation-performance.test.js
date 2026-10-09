const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createBusinessService } = require('../lib/business-service')
const { version2TemplateDefinitionDigest } = require('../lib/template-domain')
const { createCreationTiming } = require('../lib/creation-timing')

function harness({ dueStatus = 'calculated' } = {}) {
  // Synthetic catalogue: no customer or production template data.
  const fields = [1, 6, 500, 2, 1, 1, 1, 1].map((size, i) => ({
    fieldKey: `f${i}`, sequence: i, name: `Field ${i}`, description: '', type: 'single_select', required: true,
    constraints: { options: Array.from({ length: size }, (_, j) => `Option ${j}`) }
  }))
  fields[0].optionLinkage = {
    schemaVersion: 1, fieldKeys: fields.map(field => field.fieldKey),
    rows: Array.from({ length: 3000 }, (_, i) =>
      [0, Math.floor(i / 500), i % 500, i % 2, null, null, null, null])
  }
  const nodes = Array.from({ length: 10 }, (_, i) => ({
    _id: `source-${i}`, templateId: 'template', nodeKey: `n${i}`, sequence: i,
    name: `Node ${i}`, description: '', workflowMode: 'review', activationMode: 'required',
    processorAssignmentMode: 'fixed_accounts', processorUserIds: [`processor-${i}`],
    reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: [`reviewer-${i}`],
    includeBusinessCreatorAsProcessor: false, reviewMode: 'any',
    processingSlaWorkHours: 8, reviewSlaWorkHours: 4,
    requiresEvidence: false, allowedEvidenceTypes: ['pdf'], fields: i === 0 ? fields : [],
    next: i === 9 ? { mode: 'end' } : { mode: 'default', targetNodeKey: `n${i + 1}` }
  }))
  const template = {
    _id: 'template', name: 'Synthetic template', status: 'enabled', version: 1,
    nodeCount: nodes.length, definitionNodeIds: nodes.map(node => node._id),
    flowSchemaVersion: 2, entryNodeKey: 'n0',
    definitionDigest: version2TemplateDefinitionDigest({ flowSchemaVersion: 2, entryNodeKey: 'n0', nodes })
  }
  const actor = { _id: 'creator', status: 'active', role: 'user' }
  const fake = createFakeCloudDatabase({
    templates: [template], template_nodes: nodes,
    users: [actor, ...nodes.flatMap(node => [...node.processorUserIds, ...node.reviewerUserIds])
      .map(_id => ({ _id, status: 'active', displayName: `Name ${_id}` }))]
  })
  const reads = []
  const db = {
    ...fake.db,
    collection(name) {
      const collection = fake.db.collection(name)
      return { ...collection, doc(id) {
        const doc = collection.doc(id)
        return { ...doc, async get() {
          reads.push({ name, id })
          return doc.get()
        } }
      } }
    },
    async runTransaction(callback) {
      return fake.db.runTransaction(async transaction => {
        // One in-flight command per transaction, including reads and writes.
        // Never make the in-memory fake silently bless same-transaction fan-out.
        let active = false
        const serial = { collection(name) {
          return { doc(id) {
            function wrap(doc) {
              return { field(fields) { return wrap(doc.field(fields)) },
                ...Object.fromEntries(['get', 'set', 'update', 'remove'].map(method => [method, async (...args) => {
              assert.equal(active, false, 'same-transaction commands must stay serial')
              active = true
              try {
                await new Promise(resolve => setImmediate(resolve))
                return await doc[method](...args)
              } finally { active = false }
                }])) }
            }
            return wrap(transaction.collection(name).doc(id))
          } }
        } }
        return callback(serial)
      })
    }
  }
  const clock = () => new Date('2026-10-08T02:00:00Z')
  const workTimeService = { async tryAddWorkMinutes(start, minutes) {
    return dueStatus === 'pending_calendar'
      ? { status: 'pending_calendar', dueAt: null }
      : { status: 'calculated', dueAt: new Date(start.getTime() + minutes * 60000), calendarVersion: 'synthetic' }
  } }
  const repository = createCloudBusinessRepository({ db, clock, workTimeService })
  const service = createBusinessService({ repository, clock, workTimeService,
    businessSearchClient: { async ensureIndexed() {} } })
  const input = { templateId: 'template', description: '', requestKey: 'synthetic-create' }
  return { fake, reads, actor, input, template, nodes, repository, service }
}

test('new creation checks existing result once, retaining all 3000 catalogue rows and serial transactions', async () => {
  const h = harness()
  const result = await h.service.createFromTemplate({ actor: h.actor, input: h.input })
  assert.equal(result.code, 'BL-20261008-0001')
  assert.equal(h.reads.filter(read => read.name === 'users').length, 1)
  assert.equal(h.reads.filter(read => read.name === 'business_lines').length, 1)
  assert.equal(h.fake.documents('business_lines')[0].status, 'active')
  const stored = h.fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence)
  assert.equal(stored.length, 10)
  assert.deepEqual(stored[0].fieldDefinitions, h.nodes[0].fields)
  assert.equal(stored[0].fieldDefinitions[0].optionLinkage.rows.length, 3000)
  assert.equal(h.fake.documents('audit_logs').length, 1)
  assert(h.fake.transactionRuns.every(run => run.operations <= 100))
  assert.equal(h.reads.length + h.fake.queryCalls.length +
    h.fake.transactionRuns.reduce((sum, run) => sum + run.operations, 0), 66)
})

for (const dueStatus of ['calculated', 'pending_calendar']) {
  test(`creation checks small node headers without rereading catalogue; calendar=${dueStatus}`, async () => {
    const h = harness({ dueStatus })
    const first = await h.service.createFromTemplate({ actor: h.actor, input: h.input })
    assert.deepEqual(await h.service.createFromTemplate({ actor: h.actor, input: h.input }), first)
    const reads = h.fake.readCalls.filter(call => call.collection === 'business_nodes')
    assert(reads.length >= 11)
    assert(reads.every(call => !call.keys.includes('fieldDefinitions')),
      'publication and calendar checks must not transfer full catalogue snapshots')
    assert(reads.every(call => call.bytes < 1000))
    const stored = h.fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence)
    assert.deepEqual(stored[0].fieldDefinitions, h.nodes[0].fields)
    assert.equal(stored.length, 10)
    assert.equal(stored[0].processingDueStatus, dueStatus)
    assert.equal(h.fake.documents('sequence_counters')[0].sequence, 1)
    assert.equal(h.fake.documents('audit_logs').length, 1)
    assert.equal(h.fake.documents('notifications').length, dueStatus === 'pending_calendar' ? 1 : 0)
    assert(h.fake.transactionRuns.every(run => run.operations <= 100))
  })
}

test('creation diagnostics cover the real snapshot path without adding database operations or leaking catalogue values', async () => {
  const h = harness()
  const events = []
  const timing = createCreationTiming({ logger: { info: (_, event) => events.push(event) } })
  const result = await h.service.createFromTemplate({ actor: h.actor, input: h.input, creationTiming: timing })
  timing.finish('OK')
  assert.equal(result.code, 'BL-20261008-0001')
  assert.equal(h.reads.length + h.fake.queryCalls.length +
    h.fake.transactionRuns.reduce((sum, run) => sum + run.operations, 0), 66)
  assert.deepEqual(Object.keys(events[0].stages).sort(), [
    'existing_lookup', 'template_read', 'template_validate', 'calendar_due', 'snapshot_prepare',
    'reservation_transaction', 'reservation_template_read', 'reservation_template_validate',
    'reservation_participants', 'reservation_write', 'publication_transaction', 'calendar_warning', 'search_sync'
  ].sort())
  assert.deepEqual(events[0].counters, { reservation_attempts: 1, publication_attempts: 1, calendar_attempts: 1 })
  assert.equal(Object.values(events[0].stages).every(stage => stage.calls === 1 && stage.failedCalls === 0), true)
  for (const secret of [result.id, result.code, 'Synthetic template', 'Option 499', 'Name processor-0']) {
    assert.equal(JSON.stringify(events).includes(secret), false)
  }
  const retry = createCreationTiming({ logger: { info: (_, event) => events.push(event) } })
  assert.deepEqual(await h.service.createFromTemplate({ actor: h.actor, input: h.input, creationTiming: retry }), result)
  retry.finish('OK')
  assert.deepEqual(Object.keys(events[1].stages).sort(),
    ['existing_lookup', 'publication_transaction', 'calendar_warning', 'search_sync'].sort())
  assert.equal(h.fake.documents('business_lines').length, 1)
  assert.equal(h.fake.documents('business_nodes').length, 10)
})

test('repository lazy preparation runs only for new requests; retry survives disabled template', async () => {
  const h = harness()
  let prepared = 0
  const create = () => h.repository.createBusinessSnapshot({
    actor: h.actor, input: h.input, prepareSnapshot: async () => {
      prepared += 1
      return { definition: await h.repository.getTemplateDefinition('template') }
    }
  })
  const first = await create()
  h.fake.replace('templates', 'template', { ...h.template, status: 'disabled', version: 2 })
  assert.deepEqual(await create(), first)
  assert.equal(prepared, 1)
  assert.equal(h.fake.documents('business_lines').length, 1)
  assert.equal(h.fake.documents('sequence_counters')[0].sequence, 1)
})

test('a disabled creator after preparation still cannot reserve any records', async () => {
  const h = harness()
  await assert.rejects(h.repository.createBusinessSnapshot({ actor: h.actor, input: h.input,
    prepareSnapshot: async () => {
      const definition = await h.repository.getTemplateDefinition('template')
      h.fake.replace('users', 'creator', { ...h.actor, status: 'disabled' })
      return { definition }
    }
  }), { code: 'FORBIDDEN' })
  assert.equal(h.fake.documents('business_lines').length, 0)
  assert.equal(h.fake.documents('sequence_counters').length, 0)
})

for (const sameKey of [true, false]) {
  test(`service concurrent creation preserves ${sameKey ? 'idempotency' : 'unique numbering'}`, async () => {
    const h = harness()
    const inputs = [h.input, { ...h.input, requestKey: sameKey ? h.input.requestKey : 'second-create' }]
    const events = []
    const results = await Promise.all(inputs.map(async input => {
      const timing = createCreationTiming({ logger: { info: (_, event) => events.push(event) } })
      const result = await h.service.createFromTemplate({ actor: h.actor, input, creationTiming: timing })
      timing.finish('OK')
      return result
    }))
    assert.equal(events.length, 2)
    assert(h.fake.metrics.retries > 0, 'exercise actual optimistic callback replays')
    assert.equal(events.reduce((sum, event) => sum + Object.values(event.counters).reduce((a, b) => a + b, 0), 0),
      h.fake.transactionRuns.reduce((sum, run) => sum + run.callbacks, 0))
    assert(events.every(event => event.stages.existing_lookup.calls === 1 &&
      Object.values(event.stages).every(stage => stage.incompleteCalls === 0)))
    const expected = sameKey ? 1 : 2
    assert.equal(new Set(results.map(result => result.id)).size, expected)
    assert.equal(new Set(results.map(result => result.code)).size, expected)
    assert.equal(h.fake.documents('business_lines').length, expected)
    assert(h.fake.documents('business_lines').every(line => line.status === 'active'))
    assert.equal(h.fake.documents('business_nodes').length, expected * 10)
    assert.equal(h.fake.documents('sequence_counters')[0].sequence, expected)
    assert.equal(h.fake.documents('audit_logs').length, expected)
    await assert.rejects(h.service.createFromTemplate({ actor: h.actor,
      input: { ...h.input, description: 'different-input-same-key' } }), { code: 'VERSION_CONFLICT' })
  })
}

test('failed snapshot write rolls back; retry publishes one full snapshot and preserves calendar warning', async () => {
  const h = harness({ dueStatus: 'pending_calendar' })
  h.fake.failNextWrite({ collection: 'business_nodes', operation: 'set', error: new Error('synthetic failure') })
  const events = []
  const timing = createCreationTiming({ logger: { info: (_, event) => events.push(event) } })
  await assert.rejects(h.service.createFromTemplate({ actor: h.actor, input: h.input, creationTiming: timing }), /synthetic failure/)
  timing.finish('ERROR')
  assert.equal(events[0].stages.reservation_write.failedCalls, 1)
  assert.equal(events[0].stages.reservation_write.incompleteCalls, 0)
  assert.equal(h.fake.documents('business_lines').length, 0)
  assert.equal(h.fake.documents('business_nodes').length, 0)
  assert.equal(h.fake.documents('sequence_counters').length, 0)
  const first = await h.service.createFromTemplate({ actor: h.actor, input: h.input })
  assert.deepEqual(await h.service.createFromTemplate({ actor: h.actor, input: h.input }), first)
  assert.equal(h.fake.documents('business_nodes').length, 10)
  assert.equal(h.fake.documents('sequence_counters')[0].sequence, 1)
  assert.equal(h.fake.documents('notifications').length, 1)
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

for (const first of ['search', 'card']) {
  test(`real search/card publication conflict replays safely (${first} commits first)`, async () => {
    const { createCloudBusinessCardRepository } = require('../lib/cloud-business-card-repository')
    const { createCloudSearchRepository } = require('../../businessSearch/lib/cloud-search-repository')
    const h = harness()
    h.fake.replace('templates', 'template', { ...h.template, cardDisplay: {
      schemaVersion: 1, revision: 1, fields: [{ nodeKey: 'n0', fieldKey: 'f0' }]
    } })
    const created = await h.service.createFromTemplate({ actor: h.actor, input: h.input })
    const before = h.fake.documents('business_lines')[0]
    const nodesBefore = h.fake.documents('business_nodes')
    const ready = { search: deferred(), card: deferred() }
    const release = { search: deferred(), card: deferred() }
    const completed = { search: deferred(), card: deferred() }
    const dbFor = kind => ({ ...h.fake.db, async runTransaction(callback) {
      let firstAttempt = true
      const result = await h.fake.db.runTransaction(async transaction => {
        const value = await callback(transaction)
        if (firstAttempt) {
          firstAttempt = false
          ready[kind].resolve()
          await release[kind].promise
        }
        return value
      })
      completed[kind].resolve()
      return result
    } })
    const cards = createCloudBusinessCardRepository({ db: dbFor('card'), businessRepository: h.repository })
    const search = createCloudSearchRepository({ db: dbFor('search'), clock: () => new Date('2026-10-08T03:00:00Z'),
      secret: 'synthetic-creation-search-secret-1234567890' })
    const cardResult = cards.getSummary({ actor: h.actor, businessLineId: created.id })
    const searchResult = search.publishGeneration({ businessLineId: created.id, sourceVersion: 1,
      generationId: 'synthetic-generation', entries: [] })
    await Promise.all([ready.card.promise, ready.search.promise])
    release[first].resolve()
    await completed[first].promise
    release[first === 'search' ? 'card' : 'search'].resolve()
    const [summary, indexed] = await Promise.all([cardResult, searchResult])
    assert.equal(summary.state, 'ready')
    assert.equal(summary.fields.length, 1)
    assert.equal(indexed.generatedVersion, 1)
    assert(h.fake.metrics.conflicts >= 1, 'exercise real optimistic retry, not two serial writes')
    const after = h.fake.documents('business_lines')[0]
    assert.deepEqual(after.cardSummary.fields, summary.fields)
    assert.equal(after.searchIndexStatus, 'generated')
    assert.equal(after.searchGeneratedVersion, 1)
    const withoutDerived = ({ cardSummary, searchGeneratedVersion, searchIndexStatus, searchGenerationId,
      searchSchemaVersion, searchGeneratedAt, ...record }) => record
    assert.deepEqual(withoutDerived(after), withoutDerived(before))
    assert.deepEqual(h.fake.documents('business_nodes').map(withoutDerived), nodesBefore.map(withoutDerived))
  })
}
