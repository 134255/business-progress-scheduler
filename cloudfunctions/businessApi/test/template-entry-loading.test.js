const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudTemplateRepository } = require('../lib/cloud-template-repository')
const { createTemplateService } = require('../lib/template-service')
const { templateDefinitionDigest, version2TemplateDefinitionDigest } = require('../lib/template-domain')

function sourceNode(templateId, processor = 'p', reviewer = 'r') {
  return {
    _id: `${templateId}-node`, templateId, nodeKey: 'entry', sequence: 0,
    name: 'Synthetic entry', workflowMode: 'review', processorUserIds: [processor],
    reviewerUserIds: [reviewer], reviewMode: 'any', fields: []
  }
}

function harness() {
  const nodes = [sourceNode('a'), sourceNode('b', 'p2', 'r2')]
  const readCollections = []
  const fake = createFakeCloudDatabase({
    templates: nodes.map(node => ({
      _id: node.templateId, name: `Template ${node.templateId}`, description: '',
      status: 'enabled', version: 1, nodeCount: 1,
      definitionNodeIds: [node._id], definitionDigest: templateDefinitionDigest([node])
    })),
    template_nodes: nodes,
    users: ['p', 'r', 'p2', 'r2'].map(_id => ({ _id, status: 'active' }))
  }, { transformRead({ collection, data }) { readCollections.push([collection, data._id]); return data } })
  const repository = createCloudTemplateRepository({ db: fake.db })
  const service = createTemplateService({ repository, keyFactory: () => 'unused' })
  const actor = { _id: 'viewer', status: 'active', role: 'user' }
  return { fake, repository, service, actor, readCollections }
}

const availableA = {
  _id: 'a', name: 'Template a', description: '', nodeCount: 1,
  available: true, unavailableReason: ''
}

test('selected preview reads only the selected template, nodes and participants', async () => {
  const h = harness()
  assert.deepEqual(await h.service.listEnabledTemplates({ actor: h.actor, templateId: 'a' }), { items: [availableA] })
  assert.deepEqual(h.readCollections, [['templates', 'a'], ['template_nodes', 'a-node'], ['users', 'p'], ['users', 'r']])
  assert.equal(h.fake.writeCalls.length, 0)
})

test('unfiltered callers retain all enabled templates and their existing projections', async () => {
  const h = harness()
  const result = await h.service.listEnabledTemplates({ actor: h.actor })
  assert.deepEqual(result, { items: [availableA, { ...availableA, _id: 'b', name: 'Template b' }] })
})

for (const status of ['disabled', 'draft', 'deleted', 'missing']) {
  test(`selected ${status} template stays unavailable without reading its nodes`, async () => {
    const h = harness()
    if (status !== 'missing') h.fake.replace('templates', 'a', { status })
    const result = await h.service.listEnabledTemplates({ actor: h.actor, templateId: status === 'missing' ? 'missing' : 'a' })
    assert.deepEqual(result, { items: [] })
    assert.ok(h.readCollections.every(([collection]) => collection === 'templates'))
  })
}

test('selected preview verifies fresh account status and never reuses a prior availability result', async () => {
  const h = harness()
  assert.deepEqual(await h.service.listEnabledTemplates({ actor: h.actor, templateId: 'a' }), { items: [availableA] })
  h.fake.replace('users', 'r', { status: 'disabled' })
  assert.deepEqual(await h.service.listEnabledTemplates({ actor: h.actor, templateId: 'a' }), {
    items: [{ ...availableA, available: false, unavailableReason: 'REVIEWER_INACTIVE' }]
  })
})

test('a template disabled between list and preview is not offered for creation', async () => {
  const h = harness()
  assert.equal((await h.service.listEnabledTemplates({ actor: h.actor })).items.length, 2)
  h.fake.replace('templates', 'a', { ...h.fake.documents('templates')[0], status: 'disabled' })
  assert.deepEqual(await h.service.listEnabledTemplates({ actor: h.actor, templateId: 'a' }), { items: [] })
})

for (const flowSchemaVersion of [1, 2]) {
  test(`schema ${flowSchemaVersion} large linkage preview retains integrity checks and safe projection`, async () => {
    const sizes = [1, 5, 509, 2, 1, 1, 1, 1]
    const fields = sizes.map((size, i) => ({ fieldKey: `f${i}`, sequence: i, name: `Field ${i}`,
      type: 'single_select', required: true, constraints: { options: Array.from({ length: size }, (_, j) => `Choice ${j}`) } }))
    fields[0].optionLinkage = { schemaVersion: 1, fieldKeys: fields.map(f => f.fieldKey),
      rows: Array.from({ length: 2545 }, (_, i) => [0, Math.floor(i / 509), i % 509, i % 2, null, null, null, null]) }
    const nodes = Array.from({ length: 10 }, (_, i) => ({ ...sourceNode('large'),
      _id: `large-${i}`, nodeKey: `n${i}`, sequence: i, fields: i === 0 ? fields : [],
      ...(flowSchemaVersion === 2 ? { next: i === 9 ? { mode: 'end' } : { mode: 'default', targetNodeKey: `n${i + 1}` } } : {}) }))
    const template = { _id: 'large', name: 'Large synthetic', status: 'enabled', nodeCount: 10, version: 1,
      definitionNodeIds: nodes.map(n => n._id), ...(flowSchemaVersion === 2 ? { flowSchemaVersion: 2, entryNodeKey: 'n0' } : {}) }
    template.definitionDigest = flowSchemaVersion === 2
      ? version2TemplateDefinitionDigest({ flowSchemaVersion: 2, entryNodeKey: 'n0', nodes })
      : templateDefinitionDigest(nodes)
    const fake = createFakeCloudDatabase({ templates: [template], template_nodes: nodes,
      users: [{ _id: 'p', status: 'active' }, { _id: 'r', status: 'active' }] })
    const service = createTemplateService({ repository: createCloudTemplateRepository({ db: fake.db }), keyFactory: () => 'unused' })
    const request = { actor: { status: 'active' }, templateId: 'large' }
    assert.deepEqual(await service.listEnabledTemplates(request), { items: [{ _id: 'large', name: 'Large synthetic',
      description: '', nodeCount: 10, available: true, unavailableReason: '' }] })
    fake.replace('users', 'p', { status: 'disabled' })
    assert.equal((await service.listEnabledTemplates(request)).items[0].unavailableReason, 'PROCESSOR_INACTIVE')
    nodes[0].fields[0].optionLinkage.rows[0][2] = 99999
    fake.replace('template_nodes', 'large-0', nodes[0])
    await assert.rejects(service.listEnabledTemplates(request), { code: 'TEMPLATE_INVALID' })
    assert.equal(fake.writeCalls.length, 0)
  })
}

test('selected preview rejects corrupted selected definitions, without scanning unrelated definitions', async () => {
  const h = harness()
  h.fake.replace('template_nodes', 'b-node', { ...sourceNode('b', 'p2', 'r2'), name: 'Changed outside service' })
  assert.deepEqual(await h.service.listEnabledTemplates({ actor: h.actor, templateId: 'a' }), { items: [availableA] })
  await assert.rejects(h.service.listEnabledTemplates({ actor: h.actor, templateId: 'b' }), { code: 'TEMPLATE_INVALID' })
  await assert.rejects(h.service.listEnabledTemplates({ actor: h.actor }), { code: 'TEMPLATE_INVALID' })
})

for (const templateId of ['', '  ', null, 12, {}, ['a']]) {
  test(`invalid selected identity ${JSON.stringify(templateId)} cannot silently request all templates`, async () => {
    const h = harness()
    await assert.rejects(h.service.listEnabledTemplates({ actor: h.actor, templateId }), { code: 'TEMPLATE_INVALID' })
    assert.equal(h.readCollections.length, 0)
  })
}

test('inactive caller cannot use selected preview to bypass authorization', async () => {
  const h = harness()
  await assert.rejects(h.service.listEnabledTemplates({ actor: { ...h.actor, status: 'disabled' }, templateId: 'a' }), { code: 'FORBIDDEN' })
  assert.equal(h.readCollections.length, 0)
})

function accountReadProbe(failingId) {
  const ids = Array.from({ length: 11 }, (_, i) => `user-${String(i).padStart(2, '0')}`)
  const fake = createFakeCloudDatabase({ users: ids.slice(0, 10).map((_id, i) => ({ _id, status: i === 5 ? 'disabled' : 'active' })) })
  let active = 0, maximum = 0
  const reads = []
  const db = { ...fake.db, collection(name) {
    const query = fake.db.collection(name)
    return { ...query, doc(id) {
      const doc = query.doc(id)
      return { ...doc, async get() {
        reads.push(id)
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise(resolve => setImmediate(resolve))
        try {
          if (id === failingId) throw Object.assign(new Error('Read unavailable'), { code: 'DB_UNAVAILABLE' })
          return await doc.get()
        } finally { active -= 1 }
      } }
    } }
  } }
  return { ids, reads, fake, repository: createCloudTemplateRepository({ db }), maximum: () => maximum }
}

test('participant reads use bounded concurrency, deduplicate identities and preserve sorted active results', async () => {
  const h = accountReadProbe()
  const result = await h.repository.listActiveUserIds([...h.ids].reverse().concat(h.ids[0]))
  assert.deepEqual(result, ['user-00', 'user-01', 'user-02', 'user-03', 'user-04', 'user-06', 'user-07', 'user-08', 'user-09'])
  assert.ok(h.maximum() > 1 && h.maximum() <= 4, `expected bounded parallel reads, got ${h.maximum()}`)
  assert.deepEqual(h.reads, h.ids)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('account read failure rejects the entire availability check without starting later batches', async () => {
  const h = accountReadProbe('user-00')
  await assert.rejects(h.repository.listActiveUserIds(h.ids), { code: 'DB_UNAVAILABLE' })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(h.reads.length <= 4)
  assert.equal(h.fake.writeCalls.length, 0)
})

test('availability reuses normalized nodes within one request, but checks current accounts each request', async () => {
  let sourceInspections = 0, inspectionsAtAccountRead = 0, accountReads = 0
  const field = new Proxy({ fieldKey: 'note', name: 'Note', type: 'short_text', sequence: 0 }, {
    ownKeys(target) { sourceInspections += 1; return Reflect.ownKeys(target) }
  })
  const node = { ...sourceNode('a'), fields: [field] }
  const service = createTemplateService({
    keyFactory: () => 'unused',
    repository: {
      async listTemplateDefinitions() { return [{ template: { _id: 'a', name: 'Template a', nodeCount: 1 }, nodes: [node] }] },
      async listActiveUserIds() {
        inspectionsAtAccountRead = sourceInspections
        accountReads += 1
        return accountReads === 1 ? ['p', 'r'] : ['p']
      }
    }
  })
  const actor = { status: 'active' }
  assert.deepEqual(await service.listEnabledTemplates({ actor }), { items: [availableA] })
  assert.ok(inspectionsAtAccountRead > 0)
  assert.equal(sourceInspections, inspectionsAtAccountRead, 'validation must not normalize the same raw fields again after account lookup')
  const firstInspections = sourceInspections
  assert.deepEqual(await service.listEnabledTemplates({ actor }), { items: [{ ...availableA, available: false, unavailableReason: 'REVIEWER_INACTIVE' }] })
  assert.ok(sourceInspections > firstInspections, 'another request must reread and normalize its own source')
  assert.equal(sourceInspections, inspectionsAtAccountRead)
  assert.equal(accountReads, 2)
})
