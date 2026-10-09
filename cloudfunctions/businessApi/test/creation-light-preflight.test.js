const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createBusinessService } = require('../lib/business-service')
const { version2TemplateDefinitionDigest, templateDefinitionDigest } = require('../lib/template-domain')
const { APPLICATION_ERROR_MARKER } = require('../lib/cloud-template-repository')

function fixture(count = 2) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    _id: `source-${i}`, templateId: 'template', nodeKey: `n${i}`, sequence: i,
    name: `Node ${i}`, workflowMode: 'review', activationMode: 'required',
    processorAssignmentMode: 'fixed_accounts', processorUserIds: ['processor'],
    reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: ['reviewer'], reviewMode: 'any',
    processingSlaWorkHours: 8, reviewSlaWorkHours: 4, requiresEvidence: false,
    allowedEvidenceTypes: [], fields: i ? [] : [{ fieldKey: 'serial', sequence: 0,
      name: 'Serial', description: '', type: 'short_text', required: false, constraints: {}, scanEnabled: true }],
    next: i === count - 1 ? { mode: 'end' } : { mode: 'default', targetNodeKey: `n${i + 1}` }
  }))
  const template = { _id: 'template', name: 'Synthetic', status: 'enabled', version: 1,
    nodeCount: count, flowSchemaVersion: 2, entryNodeKey: 'n0', definitionNodeIds: nodes.map(n => n._id) }
  const definition = { template, nodes }
  digest(definition)
  return definition
}

function digest({ template, nodes }) {
  template.definitionDigest = version2TemplateDefinitionDigest({
    flowSchemaVersion: 2, entryNodeKey: template.entryNodeKey, nodes
  })
}

function harness(definition = fixture(), options = {}) {
  const actor = { _id: 'creator', role: 'user', status: 'active', displayName: 'Creator' }
  const ids = [...new Set(definition.nodes.flatMap(n => [...n.processorUserIds, ...n.reviewerUserIds]))]
  const fake = createFakeCloudDatabase({ templates: [definition.template], template_nodes: definition.nodes,
    users: [actor, ...ids.filter(id => id !== actor._id).map(_id => ({ _id, status: 'active', displayName: _id }))] }, options)
  const dueCalls = []
  let onDue = () => {}
  const clock = () => new Date('2026-10-09T02:00:00Z')
  const workTimeService = { async tryAddWorkMinutes(start, minutes) {
    dueCalls.push({ start, minutes })
    onDue()
    return { status: 'calculated', dueAt: new Date(start.getTime() + minutes * 60000), calendarVersion: 'synthetic' }
  } }
  const repository = createCloudBusinessRepository({ db: fake.db, clock, workTimeService })
  const service = createBusinessService({ repository, clock, workTimeService })
  const input = { templateId: 'template', requestKey: 'light-test', description: '' }
  return { fake, actor, definition, dueCalls, clock, workTimeService, repository, input,
    onDue(hook) { onDue = hook }, create(key = input.requestKey) {
      return service.createFromTemplate({ actor, input: { ...input, requestKey: key } })
    } }
}

function noWrites(h) {
  for (const name of ['business_lines', 'business_nodes', 'sequence_counters', 'audit_logs']) {
    assert.equal(h.fake.documents(name).length, 0, name)
  }
  assert.equal(h.fake.writeCalls.length, 0)
}

test('creation pre-read projects only the full lightweight directory, while every source is read in transaction', async () => {
  const h = harness()
  h.onDue(() => {
    const queries = h.fake.queryCalls.filter(q => q.collection === 'template_nodes')
    assert.equal(queries.length, 1)
    assert.deepEqual(queries[0].fields, { _id: true, templateId: true, sequence: true,
      nodeKey: true, workflowMode: true, processingSlaWorkHours: true })
  })
  await h.create()
  assert.deepEqual(h.fake.readCalls.filter(r => r.collection === 'template_nodes' && r.transaction)
    .map(r => [r.id, r.fields]), [['source-0', null], ['source-1', null]])
  assert.deepEqual(h.fake.documents('business_nodes')[0].fieldDefinitions, h.definition.nodes[0].fields)
})

test('light path and full legacy caller path produce identical complete stored snapshots', async () => {
  const h = harness()
  const full = harness()
  await h.create()
  await full.repository.createBusinessSnapshot({ actor: full.actor, input: full.input,
    definition: full.definition })
  for (const name of ['business_lines', 'business_nodes', 'sequence_counters', 'audit_logs']) {
    assert.deepEqual(h.fake.documents(name), full.fake.documents(name), name)
  }
})

test('actual nonfirst entry and fractional work hours determine the only active clock', async () => {
  const d = fixture()
  d.template.entryNodeKey = 'n1'
  d.nodes[0].next = { mode: 'end' }
  d.nodes[1].next = { mode: 'default', targetNodeKey: 'n0' }
  d.nodes[1].processingSlaWorkHours = 1.5
  digest(d)
  const h = harness(d)
  await h.create()
  assert.equal(h.dueCalls[0].minutes, 90)
  const nodes = h.fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence)
  assert.deepEqual(nodes.map(n => n.status), ['waiting', 'ready'])
  assert.equal(nodes[0].processingStartedAt, undefined)
  assert.equal(nodes[1].processingDueAt.toISOString(), '2026-10-09T03:30:00.000Z')
})

for (const when of ['before pre-read', 'after pre-read']) {
  test(`body corruption ${when} fails as invalid after calendar without creation writes`, async () => {
    const h = harness()
    const corrupt = () => {
      const node = structuredClone(h.definition.nodes[0]); node.fields[0].type = 'bad'
      h.fake.replace('template_nodes', node._id, node)
    }
    if (when === 'before pre-read') corrupt()
    else h.onDue(corrupt)
    await assert.rejects(h.create(), error => error.code === 'TEMPLATE_INVALID' && error[APPLICATION_ERROR_MARKER])
    assert.equal(h.dueCalls.length, 1)
    noWrites(h)
  })
}

for (const [name, mutate] of [
  ['disabled', d => { d.template.status = 'disabled' }],
  ['version', d => { d.template.version++ }],
  ['digest', d => { d.template.definitionDigest = 'a'.repeat(64) }],
  ['entry', d => { d.template.entryNodeKey = 'n1' }],
  ['node list', d => { d.template.definitionNodeIds.reverse() }],
  ['schema', d => { d.template.flowSchemaVersion = 1 }]
]) {
  test(`pinned head ${name} change rejects before writing`, async () => {
    const h = harness()
    h.onDue(() => { const d = structuredClone(h.definition); mutate(d); h.fake.replace('templates', 'template', d.template) })
    await assert.rejects(h.create(), { code: 'TEMPLATE_NOT_ENABLED' })
    noWrites(h)
  })
}

for (const field of ['workflowMode', 'processingSlaWorkHours']) {
  test(`canonical default cannot replace explicit raw entry ${field} after pre-read`, async () => {
    const d = fixture(); d.nodes[0].processingSlaWorkHours = 22; digest(d)
    const h = harness(d)
    h.onDue(() => {
      const node = structuredClone(d.nodes[0]); delete node[field]
      h.fake.replace('template_nodes', node._id, node)
    })
    await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
    noWrites(h)
  })
}

test('calendar failure may precede body corruption and never starts reservation', async () => {
  const h = harness()
  const node = structuredClone(h.definition.nodes[0]); node.fields[0].type = 'bad'
  h.fake.replace('template_nodes', node._id, node)
  h.onDue(() => { throw new Error('synthetic calendar failure') })
  await assert.rejects(h.create(), /synthetic calendar failure/)
  assert.equal(h.dueCalls.length, 1)
  noWrites(h)
})

for (const mode of ['missing workflow', 'missing both']) {
  test(`${mode} stays on full preparation and retains legacy defaults`, async () => {
    const d = fixture(); delete d.nodes[0].workflowMode
    if (mode === 'missing both') delete d.nodes[0].processingSlaWorkHours
    digest(d)
    const h = harness(d)
    await h.create()
    assert.equal(h.dueCalls[0].minutes, (mode === 'missing both' ? 22 : 8) * 60)
    assert(h.fake.queryCalls.some(q => q.collection === 'template_nodes' && !q.fields))
  })
}

test('explicit review missing SLA retains the full-path failure before calendar', async () => {
  const d = fixture(); delete d.nodes[0].processingSlaWorkHours; digest(d)
  const h = harness(d)
  await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
  assert.equal(h.dueCalls.length, 0)
  noWrites(h)
})

for (const kind of ['orphan', 'missing']) {
  test(`pre-existing ${kind} source is detected by full directory scan`, async () => {
    const h = harness()
    if (kind === 'orphan') h.fake.replace('template_nodes', 'orphan', { ...h.definition.nodes[0], _id: 'orphan' })
    else h.fake.replace('template_nodes', 'source-1', { ...h.definition.nodes[1], templateId: 'another' })
    await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
    assert.equal(h.dueCalls.length, 0)
    noWrites(h)
  })
}

test('source moved after pre-read fails invalid, not a template-head-change error', async () => {
  const h = harness()
  h.onDue(() => h.fake.replace('template_nodes', 'source-1', { ...h.definition.nodes[1], templateId: 'another' }))
  await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
  noWrites(h)
})

test('budget rejection occurs before participant reads and before any reservation writes', async () => {
  const h = harness(fixture(47)) // 94 + two participants + six = 102
  await assert.rejects(h.create(), { code: 'TEMPLATE_LIMIT_EXCEEDED' })
  assert.equal(h.fake.readCalls.filter(r => r.transaction && r.collection === 'users' && r.id !== 'creator').length, 0)
  noWrites(h)
})

test('same-key retries after template disable recover without recalculating due or numbering', async () => {
  const h = harness()
  const first = await h.create()
  h.fake.replace('templates', 'template', { ...h.definition.template, status: 'disabled' })
  assert.deepEqual(await h.create(), first)
  assert.equal(h.dueCalls.length, 1)
  assert.equal(h.fake.documents('sequence_counters')[0].sequence, 1)
  assert.equal(h.fake.documents('audit_logs').length, 1)
})

test('a concurrent same-key commit is recovered before the now-disabled template is checked', async () => {
  const h = harness()
  const winner = await h.create()
  // Return no result only for the outer pre-check to reproduce the other
  // request committing between that check and this reservation callback.
  const collection = h.fake.db.collection.bind(h.fake.db)
  let hideLine = true
  h.fake.db.collection = name => {
    const c = collection(name)
    return { ...c, doc(id) {
      const doc = c.doc(id)
      return { ...doc, async get() {
        if (name === 'business_lines' && hideLine) {
          hideLine = false
          return { data: null }
        }
        return doc.get()
      } }
    } }
  }
  h.onDue(() => h.fake.replace('templates', 'template', { ...h.definition.template, status: 'disabled' }))
  assert.deepEqual(await h.create(), winner)
  assert.equal(h.fake.documents('sequence_counters')[0].sequence, 1)
  assert.equal(h.fake.documents('audit_logs').length, 1)
})

test('SDK conflict replay rebuilds participant display names and publishes only the successful attempt', async () => {
  const h = harness()
  const run = h.fake.db.runTransaction.bind(h.fake.db)
  let conflict = true
  h.fake.db.runTransaction = callback => run(async transaction => {
    const result = await callback(transaction)
    if (conflict) {
      conflict = false
      h.fake.replace('users', 'reviewer', { _id: 'reviewer', status: 'active', displayName: 'New name' })
    }
    return result
  })
  await h.create()
  assert.equal(h.fake.metrics.conflicts, 1)
  assert(h.fake.documents('business_nodes').every(n => n.reviewerDisplayNames[0] === 'New name'))
  assert.equal(h.fake.documents('sequence_counters')[0].sequence, 1)
  assert.equal(h.fake.documents('audit_logs').length, 1)
})

test('outer duplicate-number retry rereads source and rejects corruption rather than reusing the failed preparation', async () => {
  const h = harness()
  const run = h.fake.db.runTransaction.bind(h.fake.db)
  let duplicate = true
  h.fake.db.runTransaction = callback => run(async transaction => {
    const result = await callback(transaction)
    if (duplicate) {
      duplicate = false
      const node = structuredClone(h.definition.nodes[0]); node.fields[0].type = 'bad'
      h.fake.replace('template_nodes', node._id, node)
      const error = new Error('duplicate key business code'); error.errCode = -502005
      throw error
    }
    return result
  })
  await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
  assert.equal(h.fake.transactionRuns.length, 2)
  assert.equal(h.fake.documents('business_lines').length, 0)
  assert.equal(h.fake.documents('sequence_counters').length, 0)
})

test('light projection is not a transferable proof that can authorize caller-modified snapshots', async () => {
  const h = harness()
  await assert.rejects(h.repository.createBusinessSnapshot({ actor: h.actor, input: h.input,
    prepareSnapshot: async loader => {
      const loaded = await loader('template')
      return { definition: structuredClone(loaded.definition), lightPreflight: true,
        preparation: { route: h.definition, validateForEnable() {} } }
    }
  }), { code: 'TEMPLATE_INVALID' })
  noWrites(h)
})

test('a new orphan added after pre-read cannot enter the authoritative snapshot', async () => {
  const h = harness()
  h.onDue(() => h.fake.replace('template_nodes', 'orphan', { ...h.definition.nodes[0], _id: 'orphan' }))
  await h.create()
  assert.equal(h.fake.documents('business_nodes').length, 2)
  assert.deepEqual(h.fake.documents('business_nodes').map(n => n.nodeKey), ['n0', 'n1'])
})

for (const value of ['8', null, undefined, 0, Infinity, 1 / 7]) {
  test(`invalid explicit entry SLA ${String(value)} cannot be made valid by light preflight`, async () => {
    const h = harness()
    h.fake.replace('template_nodes', 'source-0', { ...h.definition.nodes[0], processingSlaWorkHours: value })
    await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
    assert.equal(h.dueCalls.length, 0)
    noWrites(h)
  })
}

test('unknown database errors are not mislabeled as template validation errors', async () => {
  const h = harness()
  const failure = new Error('synthetic database unavailable')
  h.fake.beforeNextTransaction(() => { throw failure })
  await assert.rejects(h.create(), error => error === failure)
  noWrites(h)
})

test('legacy full-definition caller may supply unsorted nodes without changing the canonical snapshot order', async () => {
  const source = fixture()
  delete source.template.flowSchemaVersion
  delete source.template.entryNodeKey
  source.nodes.forEach(node => { delete node.next })
  source.template.definitionDigest = templateDefinitionDigest(source.nodes)
  const h = harness(source)
  const definition = structuredClone(h.definition)
  definition.nodes.reverse()
  await h.repository.createBusinessSnapshot({ actor: h.actor, input: h.input, definition })
  assert.deepEqual(h.fake.documents('business_nodes').map(n => n.name), ['Node 0', 'Node 1'])
})
