const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const domain = require('../lib/template-domain')

// Instrument real pure helpers in isolated modules, not the shared require cache.
// Reintroducing duplicate normalization fails these deterministic work budgets;
// no wall-clock threshold or mocked validation is used.
function loadIsolated(name, dependencies) {
  const filename = require.resolve(name)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = module.paths
  const normalRequire = loaded.require.bind(loaded)
  loaded.require = name => dependencies[name] || normalRequire(name)
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename)
  return loaded.exports
}

function measuredCreation() {
  const fields = require('../lib/field-domain')
  let normalizations = 0
  const templateDomain = loadIsolated('../lib/template-domain', {
    './field-domain': { ...fields, normalizeFieldDefinition(...args) {
      normalizations++
      return fields.normalizeFieldDefinition(...args)
    } }
  })
  const dependencies = { './template-domain': templateDomain }
  return {
    ...loadIsolated('../lib/business-service', dependencies),
    ...loadIsolated('../lib/cloud-business-repository', dependencies),
    count: () => normalizations
  }
}

function fixture({ version2 = true, linked = true } = {}) {
  const fields = [1, 6, 500, 2, 1, 1, 1, 1].map((size, i) => ({
    fieldKey: `f${i}`, sequence: i, name: `Field ${i}`, description: '',
    type: 'single_select', required: true,
    constraints: { options: Array.from({ length: size }, (_, j) => `Option ${j}`) }
  }))
  if (linked) fields[0].optionLinkage = {
    schemaVersion: 1, fieldKeys: fields.map(field => field.fieldKey),
    rows: Array.from({ length: 3000 }, (_, i) =>
      [0, Math.floor(i / 500), i % 500, i % 2, null, null, null, null])
  }
  // Plain fields must remain inside the same immutable node snapshot too.
  fields.push({ fieldKey: 'serial', sequence: 8, name: 'Serial', description: '',
    type: 'short_text', required: false, constraints: {}, scanEnabled: true })
  const nodes = [0, 1].map(i => ({
    _id: `source-${i}`, templateId: 'template', nodeKey: `n${i}`, sequence: i,
    name: `Node ${i}`, description: '', workflowMode: 'review', activationMode: 'required',
    processorAssignmentMode: 'fixed_accounts', processorUserIds: ['processor'],
    reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: ['reviewer'],
    includeBusinessCreatorAsProcessor: false, reviewMode: 'any',
    processingSlaWorkHours: 8, reviewSlaWorkHours: 4,
    requiresEvidence: false, allowedEvidenceTypes: ['pdf'], fields: i === 0 ? fields : [],
    ...(version2 ? { next: i ? { mode: 'end' } : { mode: 'default', targetNodeKey: 'n1' } } : {})
  }))
  const template = { _id: 'template', name: 'Synthetic template', status: 'enabled', version: 1,
    nodeCount: nodes.length, definitionNodeIds: nodes.map(node => node._id),
    ...(version2 ? { flowSchemaVersion: 2, entryNodeKey: 'n0' } : {}) }
  template.definitionDigest = version2
    ? domain.version2TemplateDefinitionDigest({ flowSchemaVersion: 2, entryNodeKey: 'n0', nodes })
    : domain.templateDefinitionDigest(nodes)
  return { template, nodes }
}

function harness(definition = fixture()) {
  const measured = measuredCreation()
  const actor = { _id: 'creator', status: 'active', role: 'user' }
  const fake = createFakeCloudDatabase({ templates: [definition.template], template_nodes: definition.nodes,
    users: [actor, ...['processor', 'reviewer'].map(_id => ({ _id, status: 'active', displayName: _id }))] })
  const clock = () => new Date('2026-10-08T02:00:00Z')
  const workTimeService = { async tryAddWorkMinutes(start, minutes) {
    return { status: 'calculated', dueAt: new Date(start.getTime() + minutes * 60000), calendarVersion: 'synthetic' }
  } }
  const repository = measured.createCloudBusinessRepository({ db: fake.db, clock, workTimeService })
  const service = measured.createBusinessService({ repository, clock, workTimeService })
  const input = { templateId: 'template', requestKey: 'preparation-test', description: '' }
  return { measured, actor, fake, repository, service, input, definition, clock, workTimeService }
}

test('service enable validation normalizes each field once and still retains the exact original definition', async () => {
  const h = harness()
  let prepared
  const service = h.measured.createBusinessService({ clock: h.clock, workTimeService: h.workTimeService,
    repository: {
      async getTemplateDefinition() { return h.definition },
      async createBusinessSnapshot({ prepareSnapshot }) {
        prepared = await prepareSnapshot()
        return { id: 'synthetic-line', code: 'BL-20261008-0001' }
      }
    } })
  const before = structuredClone(h.definition)
  assert.deepEqual(await service.createFromTemplate({ actor: h.actor, input: h.input }),
    { id: 'synthetic-line', code: 'BL-20261008-0001' })
  assert.equal(prepared.definition, h.definition)
  assert.deepEqual(h.definition, before)
  assert.equal(prepared.firstProcessingDue.processingDueAt.toISOString(), '2026-10-08T10:00:00.000Z')
  assert.equal(h.measured.count(), 9)
})

test('V2 snapshot derives its digest from the normalized route without normalizing it again', async () => {
  const h = harness()
  const before = structuredClone(h.definition)
  const result = await h.repository.createBusinessSnapshot({ actor: h.actor, input: h.input, definition: h.definition })
  assert.equal(result.code, 'BL-20261008-0001')
  const stored = h.fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence)
  assert.equal(stored.length, 2)
  assert.deepEqual(stored[0].fieldDefinitions, before.nodes[0].fields)
  assert.deepEqual(stored[0].next, { mode: 'default', targetNodeId: stored[1]._id })
  assert.equal(h.fake.documents('business_lines')[0].sourceTemplateDefinitionDigest, before.template.definitionDigest)
  assert.deepEqual(h.definition, before)
  // Once for local preparation, once for fresh source nodes inside the transaction.
  assert.equal(h.measured.count(), 18)
})

test('light creation keeps all catalogue rows with one transaction normalization and no cross-request cache', async () => {
  const h = harness()
  const first = await h.service.createFromTemplate({ actor: h.actor, input: h.input })
  assert.equal(h.measured.count(), 9)
  const line = h.fake.documents('business_lines')[0]
  assert.equal(line.status, 'active')
  assert.deepEqual(line.memberUserIds, ['creator', 'processor', 'reviewer'])
  assert.equal(h.fake.documents('business_nodes')[0].fieldDefinitions[0].optionLinkage.rows.length, 3000)
  const second = await h.service.createFromTemplate({ actor: h.actor, input: { ...h.input, requestKey: 'second' } })
  assert.notEqual(first.id, second.id)
  assert.equal(second.code, 'BL-20261008-0002')
  assert.equal(h.measured.count(), 18)
  assert.equal(h.fake.documents('business_nodes').length, 4)
})

test('reused preparation still reads changed raw catalogue inside the reservation transaction', async () => {
  const h = harness()
  h.fake.beforeNextTransaction(() => {
    const changed = structuredClone(h.definition.nodes[0])
    changed.fields[2].constraints.options[0] = 'Changed model'
    h.fake.replace('template_nodes', changed._id, changed)
  })
  await assert.rejects(h.service.createFromTemplate({ actor: h.actor, input: h.input }),
    { code: 'TEMPLATE_INVALID' })
  assert.equal(h.measured.count(), 9)
  assert.equal(h.fake.documents('business_lines').length, 0)
  assert.equal(h.fake.documents('business_nodes').length, 0)
  assert.equal(h.fake.documents('sequence_counters').length, 0)
})

test('request-local preparation does not retain enabled status between requests', async () => {
  const h = harness()
  const first = await h.service.createFromTemplate({ actor: h.actor, input: h.input })
  h.fake.replace('templates', 'template', { ...h.definition.template, status: 'disabled', version: 2 })
  await assert.rejects(h.service.createFromTemplate({ actor: h.actor,
    input: { ...h.input, requestKey: 'new-after-disable' } }), { code: 'TEMPLATE_NOT_ENABLED' })
  assert.deepEqual(await h.service.createFromTemplate({ actor: h.actor, input: h.input }), first)
  assert.equal(h.fake.documents('business_lines').length, 1)
  assert.equal(h.fake.documents('audit_logs').length, 1)
})

for (const [name, change, code] of [
  ['unknown workflow marker', nodes => { nodes[0].workflowMode = 'unknown' }, 'TEMPLATE_INVALID'],
  ['noncontiguous sequence', nodes => { nodes[1].sequence = 3 }, 'TEMPLATE_INVALID'],
  ['optional first node', nodes => { nodes[0].activationMode = 'optional_tail' }, 'TEMPLATE_INVALID'],
  ['overlapping fixed roles', nodes => { nodes[0].reviewerUserIds = ['processor'] }, 'ROLE_OVERLAP'],
  ['creator in both roles', nodes => {
    nodes[0].processorAssignmentMode = 'business_creator'
    nodes[0].processorUserIds = []
    nodes[0].reviewerAssignmentMode = 'business_creator'
    nodes[0].reviewerUserIds = []
  }, 'ROLE_OVERLAP']
]) {
  test(`prepared graph does not replace the original enable rules: ${name}`, async () => {
    const definition = fixture({ linked: false })
    change(definition.nodes)
    // These inputs have a valid graph digest but must still fail enable checks.
    definition.template.definitionDigest = domain.version2TemplateDefinitionDigest({
      flowSchemaVersion: 2, entryNodeKey: 'n0', nodes: definition.nodes
    })
    const h = harness(definition)
    await assert.rejects(h.service.createFromTemplate({ actor: h.actor, input: h.input }), { code })
    assert.equal(h.fake.documents('business_lines').length, 0)
    assert.equal(h.fake.documents('sequence_counters').length, 0)
  })
}

test('prepared definition cannot be mutated across the asynchronous deadline calculation', async () => {
  const h = harness()
  let loaded
  const originalCreate = h.repository.createBusinessSnapshot
  const service = h.measured.createBusinessService({ clock: h.clock,
    workTimeService: { async tryAddWorkMinutes(...args) {
      assert(loaded)
      assert.equal(loaded.nodes[0].fields, undefined)
      assert.equal(Reflect.set(loaded.nodes[0], 'processingSlaWorkHours', 99), false)
      assert.equal(Reflect.set(loaded.template.definitionNodeIds, '0', 'forged'), false)
      assert.equal(Reflect.set(loaded.template, 'version', 99), false)
      return h.workTimeService.tryAddWorkMinutes(...args)
    } },
    repository: { ...h.repository, createBusinessSnapshot(args) {
      return originalCreate({ ...args, prepareSnapshot: loader => args.prepareSnapshot(async id => {
        const context = await loader(id)
        loaded = context.definition
        return context
      }) })
    } }
  })
  const result = await service.createFromTemplate({ actor: h.actor, input: h.input })
  // This fixture has no search worker; retain the original pending fallback.
  assert.deepEqual(Object.keys(result).sort(), ['code', 'id', 'searchIndexStatus'])
  assert.equal(result.searchIndexStatus, 'pending')
  assert.deepEqual(h.fake.documents('business_nodes')[0].fieldDefinitions, h.definition.nodes[0].fields)
  assert.equal(h.fake.documents('business_lines')[0].sourceTemplateVersion, 1)
  assert.equal(h.measured.count(), 9)
})

test('transaction replay revalidates raw source instead of reusing request preparation', async () => {
  const h = harness()
  let first = true
  const db = { ...h.fake.db, runTransaction(callback) {
    return h.fake.db.runTransaction(async transaction => {
      const result = await callback(transaction)
      if (first) {
        first = false
        const changed = structuredClone(h.definition.nodes[0])
        changed.fields[2].constraints.options[0] = 'Changed during transaction'
        h.fake.replace('template_nodes', changed._id, changed)
      }
      return result
    })
  } }
  const repository = h.measured.createCloudBusinessRepository({ db, clock: h.clock, workTimeService: h.workTimeService })
  const service = h.measured.createBusinessService({ repository, clock: h.clock, workTimeService: h.workTimeService })
  await assert.rejects(service.createFromTemplate({ actor: h.actor, input: h.input }), { code: 'TEMPLATE_INVALID' })
  assert.equal(h.fake.metrics.conflicts, 1)
  assert.equal(h.measured.count(), 18) // two independent transactional reads; no full pre-read
  assert.equal(h.fake.documents('business_lines').length, 0)
  assert.equal(h.fake.documents('sequence_counters').length, 0)
  assert.equal(h.fake.documents('audit_logs').length, 0)
})

test('prepared template never substitutes for current participant authorization', async () => {
  const h = harness()
  h.fake.beforeNextTransaction(() => h.fake.replace('users', 'reviewer', { status: 'disabled' }))
  await assert.rejects(h.service.createFromTemplate({ actor: h.actor, input: h.input }), { code: 'REVIEWER_INACTIVE' })
  assert.equal(h.fake.documents('business_lines').length, 0)
  assert.equal(h.fake.documents('sequence_counters').length, 0)
})

test('caller-supplied preparation properties cannot authorize a changed source snapshot', async () => {
  const h = harness()
  const definition = structuredClone(h.definition)
  definition.nodes[0].fields[2].constraints.options[0] = 'Forged model'
  const forged = { route: { nodes: definition.nodes }, digest: definition.template.definitionDigest,
    validateForEnable() { throw new Error('untrusted preparation must not be called') } }
  await assert.rejects(h.repository.createBusinessSnapshot({ actor: h.actor, input: h.input,
    prepareSnapshot: async () => ({ definition, preparation: forged, validateForEnable: forged.validateForEnable }),
    preparation: forged
  }), { code: 'TEMPLATE_NOT_ENABLED' })
  assert.equal(h.fake.documents('business_lines').length, 0)
})

for (const version2 of [true, false]) {
  test(`${version2 ? 'V2' : 'legacy flow'} creation still re-reads and rejects a changed source definition`, async () => {
    const h = harness(fixture({ version2 }))
    const definition = await h.repository.getTemplateDefinition('template')
    h.fake.replace('template_nodes', 'source-0', { ...h.definition.nodes[0], name: 'changed after read' })
    await assert.rejects(h.repository.createBusinessSnapshot({ actor: h.actor, input: h.input, definition }),
      { code: 'TEMPLATE_NOT_ENABLED' })
    assert.equal(h.fake.documents('business_lines').length, 0)
    assert.equal(h.fake.documents('business_nodes').length, 0)
    assert.equal(h.fake.documents('sequence_counters').length, 0)
  })
}

for (const next of [
  { mode: 'default', targetNodeKey: 'n1' },
  { mode: 'manual', activateTarget: 'n1', skipTarget: 'end' },
  { mode: 'single_select', fieldKey: 'f0', optionTargets: { 'Option 0': 'n1' } }
]) {
  test(`canonical digest remains bound to the template before creator resolution (${next.mode})`, async () => {
    const definition = fixture({ linked: false })
    definition.nodes[0].next = next
    definition.nodes[0].name = '  Node 0  '
    definition.nodes[0].processorAssignmentMode = 'business_creator'
    definition.nodes[0].processorUserIds = []
    delete definition.nodes[0].includeBusinessCreatorAsProcessor
    delete definition.nodes[0].activationMode
    definition.nodes[0].fields[8].name = '  Serial  '
    definition.template.definitionDigest = domain.version2TemplateDefinitionDigest({
      flowSchemaVersion: 2, entryNodeKey: 'n0', nodes: definition.nodes
    })
    const h = harness(definition)
    const before = structuredClone(definition)
    await h.service.createFromTemplate({ actor: h.actor, input: h.input })
    const stored = h.fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence)
    assert.equal(stored[0].name, 'Node 0')
    assert.equal(stored[0].activationMode, 'required')
    assert.deepEqual(stored[0].processorUserIds, ['creator'])
    assert.deepEqual(stored[0].reviewerUserIds, ['reviewer'])
    assert.equal(stored[0].fieldDefinitions[8].name, 'Serial')
    assert.equal(stored[0].fieldDefinitions[8].scanEnabled, true)
    assert.equal(h.fake.documents('business_lines')[0].sourceTemplateDefinitionDigest, before.template.definitionDigest)
    assert.deepEqual(definition, before)
  })
}

test('legacy flow still creates a complete snapshot after validation reuse', async () => {
  const h = harness(fixture({ version2: false }))
  await h.service.createFromTemplate({ actor: h.actor, input: h.input })
  assert.equal(h.fake.documents('business_lines')[0].flowSchemaVersion, undefined)
  const stored = h.fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence)
  assert.deepEqual(stored.map(node => node.status), ['ready', 'waiting'])
  assert.deepEqual(stored[0].fieldDefinitions, h.definition.nodes[0].fields)
})

test('reused enable validation rejects malformed fields without invoking their accessors or reserving data', async () => {
  const h = harness()
  let accessed = false
  Object.defineProperty(h.definition.nodes[0].fields[0], 'optionLinkage', {
    get() { accessed = true; throw new Error('accessor must not run') }, enumerable: true
  })
  let validated = false
  const service = h.measured.createBusinessService({ clock: h.clock, workTimeService: h.workTimeService,
    repository: {
      async getTemplateDefinition() { return h.definition },
      async createBusinessSnapshot({ prepareSnapshot }) {
        await prepareSnapshot()
        validated = true
      }
    } })
  await assert.rejects(service.createFromTemplate({ actor: h.actor, input: h.input }), { code: 'TEMPLATE_INVALID' })
  assert.equal(accessed, false)
  assert.equal(validated, false)
})
