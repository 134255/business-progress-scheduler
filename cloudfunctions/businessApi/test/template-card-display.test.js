const test = require('node:test')
const assert = require('node:assert/strict')
const { createTemplateService } = require('../lib/template-service')
const { createCloudTemplateRepository, APPLICATION_ERROR_MARKER } = require('../lib/cloud-template-repository')
const { templateDefinitionDigest, version2TemplateDefinitionDigest } = require('../lib/template-domain')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const admin = { _id: 'admin-1', role: 'super_admin', status: 'active' }
const ref = { nodeKey: 'node-a', fieldKey: 'field-a' }
const display = (fields = [ref], revision = 1) => ({ schemaVersion: 1, revision, fields })
const marked = code => error => error.code === code && error[APPLICATION_ERROR_MARKER] === true

function harness({ count = 2, template = {}, options = {}, version2 = false } = {}) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    _id: `document-${index}`, templateId: 'template-1', version: 3,
    nodeKey: index === 0 ? 'node-a' : `node-${index}`, sequence: index,
    name: `Synthetic node ${index}`, description: '',
    workflowMode: 'review', processorUserIds: ['processor-1'], reviewerUserIds: [], reviewMode: 'any',
    processingSlaWorkHours: 8, reviewSlaWorkHours: 4,
    ...(version2 ? {
      includeBusinessCreatorAsProcessor: false,
      next: index === count - 1 ? { mode: 'end' } : { mode: 'default', targetNodeKey: `node-${index + 1}` }
    } : {}),
    requiresEvidence: false, allowedEvidenceTypes: [],
    fields: [{ fieldKey: index === 0 ? 'field-a' : `field-${index}`, name: 'Synthetic field',
      type: 'short_text', sequence: 0, required: false, constraints: {} }]
  }))
  const header = {
    _id: 'template-1', name: 'Synthetic template', description: '', status: 'enabled', version: 3,
    nodeCount: count, definitionNodeIds: nodes.map(node => node._id),
    ...(version2 ? { flowSchemaVersion: 2, entryNodeKey: 'node-a' } : {}),
    definitionDigest: version2
      ? version2TemplateDefinitionDigest({ flowSchemaVersion: 2, entryNodeKey: 'node-a', nodes })
      : templateDefinitionDigest(nodes),
    updatedAt: new Date('2026-09-01T00:00:00Z'), updatedBy: 'previous-admin', ...template
  }
  const fake = createFakeCloudDatabase({
    users: [admin, { _id: 'processor-1', role: 'user', status: 'active' }],
    templates: [header], template_nodes: nodes,
    business_lines: [{ _id: 'line-1', templateId: 'template-1', version: 9, status: 'completed' }]
  }, options)
  let id = 0
  const repository = createCloudTemplateRepository({ db: fake.db, idFactory: prefix => `${prefix}-${++id}` })
  const service = createTemplateService({ repository, keyFactory: prefix => `${prefix}-${++id}` })
  const save = (input = {}) => service.updateTemplateCardDisplay({
    actor: admin, templateId: 'template-1', expectedRevision: 0, fields: [ref], ...input
  })
  const read = (actor = admin) => service.getTemplateCardDisplay({ actor, templateId: 'template-1' })
  const edit = (replacement = nodes) => service.updateTemplate({
    actor: admin, templateId: 'template-1', expectedVersion: 3,
    input: { name: 'Renamed synthetic template', description: '', nodes: replacement }
  })
  return { fake, repository, service, nodes, header, save, read, edit }
}

test('real service reads the empty default without writes and keeps saved definitions as choices', async () => {
  const h = harness()
  assert.deepEqual(await h.read(), { templateId: 'template-1', revision: 0, fields: [] })
  const choices = await h.service.getTemplate({ actor: admin, templateId: 'template-1' })
  assert.equal(choices.nodes[0].fields[0].fieldKey, 'field-a')
  assert.deepEqual(h.fake.writeCalls, [])
})

for (const version2 of [false, true]) {
  test(`enabled ${version2 ? 'v2' : 'v1'} template saves only independent display state and value-free audit`, async () => {
    const h = harness({ version2 })
    const before = structuredClone(h.fake.documents('templates')[0])
    const originalLines = h.fake.documents('business_lines')
    const originalNodes = h.fake.documents('template_nodes')
    const result = await h.save()
    assert.deepEqual(result, { templateId: 'template-1', revision: 1, fields: [ref] })
    const stored = h.fake.documents('templates')[0]
    const { cardDisplay, cardDisplayUpdatedAt, cardDisplayUpdatedBy, ...untouched } = stored
    assert.deepEqual(cardDisplay, display())
    assert.equal(cardDisplayUpdatedBy, 'admin-1')
    assert.ok(cardDisplayUpdatedAt.__serverDate)
    assert.deepEqual(untouched, before)
    assert.deepEqual(h.fake.documents('business_lines'), originalLines)
    assert.deepEqual(h.fake.documents('template_nodes'), originalNodes)
    assert.deepEqual(await h.read(), result)
    const audit = h.fake.documents('audit_logs')[0]
    assert.deepEqual(Object.keys(audit).sort(), [
      '_id', 'actorId', 'action', 'resultCode', 'targetType', 'targetId', 'createdAt', 'configRevision'
    ].sort())
    assert.equal(audit.action, 'UPDATE_TEMPLATE_CARD_DISPLAY')
    assert.equal(audit.resultCode, 'TEMPLATE_CARD_DISPLAY_UPDATED')
    assert.equal(audit.configRevision, 1)
    assert.deepEqual(h.fake.transactionQueries, [])
  })
}

test('configuration can be reordered and cleared without changing the definition version', async () => {
  const h = harness()
  const other = { nodeKey: 'node-1', fieldKey: 'field-1' }
  assert.deepEqual((await h.save({ fields: [other, ref] })).fields, [other, ref])
  assert.deepEqual((await h.save({ expectedRevision: 1, fields: [ref, other] })).fields, [ref, other])
  assert.deepEqual(await h.save({ expectedRevision: 2, fields: [] }), {
    templateId: 'template-1', revision: 3, fields: []
  })
  assert.equal(h.fake.documents('templates')[0].version, 3)
})

test('both service and repository reject unauthorized actors, including current demotion on reads and writes', async () => {
  for (const actor of [null, { ...admin, status: 'disabled' }, { ...admin, role: 'user' }]) {
    const h = harness()
    await assert.rejects(h.save({ actor }), marked('FORBIDDEN'))
    await assert.rejects(h.read(actor), marked('FORBIDDEN'))
    await assert.rejects(h.repository.updateTemplateCardDisplay({ actor, templateId: 'template-1', expectedRevision: 0, fields: [ref] }), marked('FORBIDDEN'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
  for (const user of [{ ...admin, role: 'user' }, { ...admin, status: 'disabled' }, null]) {
    for (const operation of ['read', 'save']) {
      const h = harness()
      h.fake.beforeNextTransaction(async () => {
        if (user) h.fake.replace('users', 'admin-1', user)
        else await h.fake.db.collection('users').doc('admin-1').remove()
      })
      await assert.rejects(h[operation](), marked('FORBIDDEN'))
      assert.equal(h.fake.documents('templates')[0].cardDisplay, undefined)
      assert.deepEqual(h.fake.documents('audit_logs'), [])
    }
  }
})

test('invalid references and unsafe or stale expected revisions never partially save', async () => {
  for (const input of [
    { fields: [ref, ref] }, { fields: Array(5).fill(ref) }, { fields: [{ ...ref, value: 'synthetic' }] },
    { fields: [{ nodeKey: 'node-1', fieldKey: 'field-a' }] },
    { fields: [{ ...ref, fieldKey: 'missing' }] }, { fields: new Array(1) }
  ]) {
    const h = harness()
    await assert.rejects(h.save(input), marked('CARD_DISPLAY_INVALID'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
  for (const expectedRevision of [undefined, -1, 0.5, '0', 1, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness()
    await assert.rejects(h.save({ expectedRevision }), marked('VERSION_CONFLICT'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
  const h = harness({ template: { cardDisplay: display([], Number.MAX_SAFE_INTEGER) } })
  await assert.rejects(h.save({ expectedRevision: Number.MAX_SAFE_INTEGER }), marked('VERSION_CONFLICT'))
  assert.deepEqual(h.fake.writeCalls, [])
})

test('missing or deleted templates reject display edits and reads, including deletion after pre-read', async () => {
  for (const status of ['missing', 'deleted']) {
    for (const race of [false, true]) {
      const h = harness()
      const remove = async () => status === 'missing'
        ? h.fake.db.collection('templates').doc('template-1').remove()
        : h.fake.replace('templates', 'template-1', { ...h.header, status: 'deleted' })
      if (race) h.fake.beforeNextTransaction(remove)
      else await remove()
      await assert.rejects(h.save(), marked('NOT_FOUND'))
      await assert.rejects(h.read(), marked('NOT_FOUND'))
      assert.deepEqual(h.fake.documents('audit_logs'), [])
    }
  }
})

test('display revision is rechecked in the transaction and concurrent editors have a single winner', async () => {
  const h = harness()
  h.fake.beforeNextTransaction(() => h.fake.replace('templates', 'template-1', { ...h.header, cardDisplay: display([], 1) }))
  await assert.rejects(h.save(), marked('VERSION_CONFLICT'))
  assert.deepEqual(h.fake.documents('templates')[0].cardDisplay, display([], 1))
  assert.deepEqual(h.fake.documents('audit_logs'), [])
  const parallel = harness()
  const results = await Promise.allSettled([parallel.save(), parallel.save({ fields: [] })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT')
  assert.equal(parallel.fake.documents('audit_logs').length, 1)
})

test('definition version, digest and authoritative node list changes invalidate pre-read display saves', async () => {
  for (const patch of [
    { version: 4 }, { definitionDigest: 'a'.repeat(64) }, { definitionNodeIds: ['replacement', 'document-1'] }
  ]) {
    const h = harness()
    h.fake.beforeNextTransaction(() => h.fake.replace('templates', 'template-1', { ...h.header, ...patch }))
    await assert.rejects(h.save(), marked('VERSION_CONFLICT'))
    assert.equal(h.fake.documents('templates')[0].cardDisplay, undefined)
    assert.deepEqual(h.fake.documents('audit_logs'), [])
  }
})

test('fixed referenced node reads catch deletion, moved ownership and out-of-band field mutation', async () => {
  for (const change of ['missing', 'owner', 'field']) {
    const h = harness()
    h.fake.beforeNextTransaction(async () => {
      if (change === 'missing') await h.fake.db.collection('template_nodes').doc('document-0').remove()
      else h.fake.replace('template_nodes', 'document-0', {
        ...h.nodes[0], ...(change === 'owner' ? { templateId: 'other-template' } : { fields: [] })
      })
    })
    await assert.rejects(h.save(), marked('VERSION_CONFLICT'))
    assert.equal(h.fake.documents('templates')[0].cardDisplay, undefined)
    assert.deepEqual(h.fake.documents('audit_logs'), [])
  }
})

test('audit failure rolls back display state completely', async () => {
  const h = harness()
  h.fake.failNextWrite({ collection: 'audit_logs', operation: 'set', error: new Error('synthetic audit failure') })
  await assert.rejects(h.save(), /synthetic audit failure/)
  assert.deepEqual(h.fake.documents('templates')[0], h.header)
  assert.deepEqual(h.fake.documents('audit_logs'), [])
})

test('enabled definition edits remain rejected while display edits work', async () => {
  const h = harness()
  await h.save()
  await assert.rejects(h.edit(), marked('TEMPLATE_NOT_EDITABLE'))
  assert.equal(h.fake.documents('templates')[0].version, 3)
})

test('definition mutation guards current display references and permits retained-ID renames', async () => {
  const h = harness({ template: { status: 'disabled', cardDisplay: display() } })
  await assert.rejects(h.edit(h.nodes.map(node => ({ ...node, fields: [] }))), marked('CARD_DISPLAY_INVALID'))
  assert.deepEqual(h.fake.documents('templates')[0], h.header)
  const result = await h.edit(h.nodes.map(node => ({ ...node, name: 'renamed' })))
  assert.equal(result.template.version, 4)
  assert.deepEqual(result.template.cardDisplay, display())
})

test('a display saved after definition pre-read still prevents selected-field deletion', async () => {
  const h = harness({ template: { status: 'disabled' } })
  h.fake.beforeNextTransaction(() => h.fake.replace('templates', 'template-1', { ...h.header, cardDisplay: display() }))
  await assert.rejects(h.edit(h.nodes.map(node => ({ ...node, fields: [] }))), marked('CARD_DISPLAY_INVALID'))
  assert.equal(h.fake.documents('templates')[0].version, 3)
  assert.deepEqual(h.fake.documents('template_nodes'), h.nodes)
  assert.deepEqual(h.fake.documents('audit_logs'), [])
})

test('concurrent real definition deletion and config save cannot both succeed', async () => {
  const h = harness({ template: { status: 'disabled' } })
  const results = await Promise.allSettled([h.save(), h.edit(h.nodes.map(node => ({ ...node, fields: [] })))])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.ok(['VERSION_CONFLICT', 'CARD_DISPLAY_INVALID'].includes(results.find(result => result.status === 'rejected').reason.code))
  assert.equal(h.fake.documents('audit_logs').length, 1)
})

test('status-only deletion retains valid config for historical readers', async () => {
  const h = harness({ template: { status: 'disabled', cardDisplay: display() } })
  await h.service.deleteTemplate({ actor: admin, templateId: 'template-1', expectedVersion: 3 })
  const stored = h.fake.documents('templates')[0]
  assert.equal(stored.status, 'deleted')
  assert.deepEqual(require('../lib/business-card-display').readCardDisplay(stored), display())
})

test('forty-eight nodes and four selected references stay bounded and use only fixed transaction reads', async () => {
  const h = harness({ count: 48 })
  const fields = [ref, ...[1, 2, 47].map(index => ({ nodeKey: `node-${index}`, fieldKey: `field-${index}` }))]
  assert.deepEqual((await h.save({ fields })).fields, fields)
  assert.ok(h.fake.transactionRuns.every(run => run.operations <= 8))
  assert.deepEqual(h.fake.transactionQueries, [])
  assert.ok(h.fake.queryCalls.every(call => call.collection === 'template_nodes'))
})

test('configuration reads and writes reject damaged definition digests and node lists', async () => {
  for (const patch of [
    { definitionDigest: 'f'.repeat(64) }, { definitionNodeIds: ['document-1', 'document-0'] },
    { definitionNodeIds: Object.assign(['document-0', 'document-1'], { extra: true }) }
  ]) {
    for (const operation of ['read', 'save']) {
      const h = harness({ template: patch })
      await assert.rejects(h[operation](), marked('TEMPLATE_INVALID'))
      assert.deepEqual(h.fake.writeCalls, [])
    }
  }
})

test('configuration reads validate currently selected references, including a lost field after pre-read', async () => {
  const bad = harness({ template: { cardDisplay: display([{ ...ref, fieldKey: 'unknown' }]) } })
  await assert.rejects(bad.read(), marked('CARD_DISPLAY_INVALID'))
  const raced = harness({ template: { cardDisplay: display() } })
  raced.fake.beforeNextTransaction(() => raced.fake.replace('template_nodes', 'document-0', { ...raced.nodes[0], fields: [] }))
  await assert.rejects(raced.read(), marked('VERSION_CONFLICT'))
  assert.deepEqual(raced.fake.documents('audit_logs'), [])
})

test('stored config corruption cannot be repaired silently by an update or bypassed on read', async () => {
  for (const cardDisplay of [null, { ...display(), revision: '1' }, { ...display(), extra: true }]) {
    const h = harness({ template: { cardDisplay } })
    await assert.rejects(h.save(), marked('CARD_DISPLAY_INVALID'))
    await assert.rejects(h.read(), marked('CARD_DISPLAY_INVALID'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
})

test('database accessor and inherited config structures fail without running application getters', async () => {
  for (const malformed of ['getter', 'inherited', 'reference']) {
    const h = harness({ options: { transformRead({ collection, data }) {
      if (collection !== 'templates') return data
      if (malformed === 'getter') return Object.defineProperty(data, 'cardDisplay', {
        get() { assert.fail('stored getter executed') }
      })
      if (malformed === 'inherited') return Object.assign(Object.create({ cardDisplay: display() }), data)
      data.cardDisplay = display([Object.create(ref)])
      return data
    } } })
    await assert.rejects(h.read(), marked('CARD_DISPLAY_INVALID'))
    await assert.rejects(h.save(), marked('CARD_DISPLAY_INVALID'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
})

test('unsafe workflow versions and accessor digest values never authorize a display update', async () => {
  for (const version of [0, '3', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness({ template: { version } })
    await assert.rejects(h.save(), marked('VERSION_CONFLICT'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
  const h = harness({ options: { transformRead({ collection, data }) {
    if (collection === 'templates') Object.defineProperty(data, 'definitionDigest', {
      get() { assert.fail('stored digest getter executed') }
    })
    return data
  } } })
  await assert.rejects(h.save(), marked('TEMPLATE_INVALID'))
  assert.deepEqual(h.fake.writeCalls, [])
})

test('definition mutation reads the transaction config after it was cleared and can then remove the field', async () => {
  const h = harness({ template: { status: 'disabled', cardDisplay: display() } })
  h.fake.beforeNextTransaction(() => h.fake.replace('templates', 'template-1', { ...h.header, cardDisplay: display([], 2) }))
  const result = await h.edit(h.nodes.map(node => ({ ...node, fields: [] })))
  assert.deepEqual(result.template.cardDisplay, display([], 2))
  assert.equal(result.template.version, 4)
})

test('transaction header accessors and malformed status never execute or authorize a save', async () => {
  for (const property of ['status', 'definitionNodeIds']) {
    let inTransaction = false
    const h = harness({ options: { transformRead({ collection, data }) {
      if (!inTransaction || collection !== 'templates') return data
      const target = property === 'status' ? data : data.definitionNodeIds
      Object.defineProperty(target, property === 'status' ? 'status' : '0', {
        enumerable: true, get() { assert.fail('transaction header getter executed') }
      })
      return data
    } } })
    h.fake.beforeNextTransaction(() => { inTransaction = true })
    await assert.rejects(h.save(), marked('TEMPLATE_INVALID'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
  for (const status of [undefined, 'unknown', null]) {
    const h = harness({ template: { status } })
    await assert.rejects(h.save(), marked('TEMPLATE_INVALID'))
    assert.deepEqual(h.fake.writeCalls, [])
  }
})
