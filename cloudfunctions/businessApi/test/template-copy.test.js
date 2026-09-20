const test = require('node:test')
const assert = require('node:assert/strict')
const { createTemplateService } = require('../lib/template-service')
const { createCloudTemplateRepository } = require('../lib/cloud-template-repository')
const { version2TemplateDefinitionDigest, templateDefinitionDigest } = require('../lib/template-domain')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const admin = { _id: 'admin-copy', role: 'super_admin', status: 'active' }

function branchInput() {
  const base = { processorUserIds: ['processor'], reviewerUserIds: ['reviewer'],
    reviewMode: 'all', processingSlaWorkHours: 11, reviewSlaWorkHours: 3,
    requiresEvidence: true, allowedEvidenceTypes: ['jpg', 'mov'], fields: [] }
  return { name: '测试模板', description: '保留说明', flowSchemaVersion: 2, entryNodeKey: 'entry', nodes: [
    { ...base, nodeKey: 'entry', name: '收集', includeBusinessCreatorAsProcessor: true, fields: [
      { fieldKey: 'brand', name: '品牌', type: 'single_select', required: true, constraints: { options: ['甲', '乙'] } },
      { fieldKey: 'model', name: '型号', type: 'single_select', required: true,
        constraints: { options: ['M1', 'M2'] }, condition: { parentFieldKey: 'brand', visibleWhen: ['甲', '乙'],
          optionsByParentValue: { 甲: ['M1'], 乙: ['M2'] } } },
      { fieldKey: 'sku', name: 'SKU', type: 'single_select', required: false,
        constraints: { options: ['黑', '白', '蓝'] }, condition: { parentFieldKey: 'model', visibleWhen: ['M1', 'M2'],
          optionsByParentValue: { M1: ['黑', '白'], M2: ['蓝'] } } }
    ], next: { mode: 'single_select', fieldKey: 'brand', optionTargets: { 甲: 'manual', 乙: 'finish' } } },
    { ...base, nodeKey: 'manual', name: '决定', next: { mode: 'manual', activateTarget: 'extra', skipTarget: 'finish' } },
    { ...base, nodeKey: 'extra', name: '补充', next: { mode: 'default', targetNodeKey: 'finish' } },
    { ...base, nodeKey: 'finish', name: '结束', reviewerUserIds: [], next: { mode: 'end' } }
  ] }
}

async function harness(input = branchInput()) {
  const fake = createFakeCloudDatabase({ users: [admin,
    { _id: 'processor', status: 'active' }, { _id: 'reviewer', status: 'active' }],
    business_lines: [{ _id: 'history', status: 'completed' }],
    business_nodes: [{ _id: 'history-node', status: 'completed' }] })
  let sequence = 0
  const keyFactory = prefix => `${prefix}-copy-${++sequence}`
  const repository = createCloudTemplateRepository({ db: fake.db, idFactory: keyFactory })
  const service = createTemplateService({ repository, keyFactory })
  const source = await service.createTemplate({ actor: admin, input })
  return { fake, repository, service, source,
    copy: () => service.copyTemplate({ actor: admin, templateId: source.template._id, expectedVersion: source.template.version }) }
}

test('copy enabled template atomically preserves cascades, all route modes, assignments and display while isolating identities', async () => {
  const h = await harness()
  await h.service.updateTemplateCardDisplay({ actor: admin, templateId: h.source.template._id,
    expectedRevision: 0, fields: [{ nodeKey: 'entry', fieldKey: 'sku' }] })
  h.source = await h.service.changeTemplateStatus({ actor: admin, templateId: h.source.template._id,
    expectedVersion: 1, status: 'enabled' })
  const before = await h.repository.getTemplateDefinition(h.source.template._id)
  const originalBusiness = h.fake.documents('business_lines')
  const originalBusinessNodes = h.fake.documents('business_nodes')
  const result = await h.service.copyTemplate({ actor: admin, templateId: before.template._id,
    expectedVersion: before.template.version })
  assert.equal(result.template.name, '测试模板－副本')
  assert.equal(result.template.description, '保留说明')
  assert.equal(result.template.status, 'draft')
  assert.equal(result.template.version, 1)
  assert.notEqual(result.template._id, before.template._id)
  assert.equal(result.template.enabledAt, undefined)
  const [entry, manual, extra, finish] = result.nodes
  assert.equal(result.template.entryNodeKey, entry.nodeKey)
  assert.deepEqual(entry.next, { mode: 'single_select', fieldKey: entry.fields[0].fieldKey,
    optionTargets: { 甲: manual.nodeKey, 乙: finish.nodeKey } })
  assert.deepEqual(manual.next, { mode: 'manual', activateTarget: extra.nodeKey, skipTarget: finish.nodeKey })
  assert.deepEqual(extra.next, { mode: 'default', targetNodeKey: finish.nodeKey })
  assert.deepEqual(finish.next, { mode: 'end' })
  assert.equal(entry.fields[1].condition.parentFieldKey, entry.fields[0].fieldKey)
  assert.equal(entry.fields[2].condition.parentFieldKey, entry.fields[1].fieldKey)
  assert.deepEqual(entry.fields[2].condition.optionsByParentValue, { M1: ['黑', '白'], M2: ['蓝'] })
  assert.deepEqual(entry.fields[2].constraints.options, ['黑', '白', '蓝'])
  assert.equal(entry.includeBusinessCreatorAsProcessor, true)
  assert.deepEqual(entry.processorUserIds, ['processor'])
  assert.deepEqual(entry.reviewerUserIds, ['reviewer'])
  assert.equal(entry.reviewMode, 'all')
  assert.equal(entry.processingSlaWorkHours, 11)
  assert.equal(entry.reviewSlaWorkHours, 3)
  assert.deepEqual(entry.allowedEvidenceTypes, ['jpg', 'mov'])
  assert.equal(entry.requiresEvidence, true)
  assert.deepEqual(finish.reviewerUserIds, [])
  assert.deepEqual(result.template.cardDisplay, { schemaVersion: 1, revision: 1,
    fields: [{ nodeKey: entry.nodeKey, fieldKey: entry.fields[2].fieldKey }] })
  const oldKeys = new Set(before.nodes.flatMap(n => [n._id, n.nodeKey, ...n.fields.map(f => f.fieldKey)]))
  assert.ok(result.nodes.flatMap(n => [n._id, n.nodeKey, ...n.fields.map(f => f.fieldKey)]).every(k => !oldKeys.has(k)))
  assert.ok(result.nodes.every(n => n.templateId === result.template._id && n.version === 1))
  assert.deepEqual(result.template.definitionNodeIds, result.nodes.map(n => n._id))
  assert.equal(result.template.definitionDigest, version2TemplateDefinitionDigest({ flowSchemaVersion: 2,
    entryNodeKey: entry.nodeKey, nodes: result.nodes }))
  assert.deepEqual(await h.repository.getTemplateDefinition(before.template._id), before)
  assert.deepEqual(h.fake.documents('business_lines'), originalBusiness)
  assert.deepEqual(h.fake.documents('business_nodes'), originalBusinessNodes)
  assert.deepEqual(h.fake.transactionQueries, [])
  const audit = h.fake.documents('audit_logs').at(-1)
  assert.equal(audit.action, 'COPY_TEMPLATE')
  assert.equal(audit.targetId, result.template._id)
  assert.equal(audit.sourceTemplateId, before.template._id)
  await h.service.updateTemplate({ actor: admin, templateId: result.template._id, expectedVersion: 1,
    input: { ...result.template, name: '独立修改', nodes: result.nodes } })
  assert.deepEqual(await h.repository.getTemplateDefinition(before.template._id), before)
})

test('copy keeps single-select end target and node-local field keys distinct', async () => {
  const input = branchInput()
  input.nodes[1].fields = [structuredClone(input.nodes[0].fields[0])]
  input.nodes[1].next = { mode: 'manual', activateTarget: 'extra', skipTarget: 'end' }
  input.nodes[0].next.optionTargets.乙 = 'end'
  const h = await harness(input)
  const copy = await h.copy()
  assert.equal(copy.nodes[0].next.optionTargets.乙, 'end')
  assert.equal(copy.nodes[1].next.skipTarget, 'end')
  assert.notEqual(copy.nodes[0].fields[0].fieldKey, copy.nodes[1].fields[0].fieldKey)
})

test('copy supports empty and sequential draft templates without display settings', async () => {
  for (const nodes of [[], [{ name: '普通节点', processorUserIds: ['processor'], reviewerUserIds: [], fields: [] }]]) {
    const h = await harness({ name: '草稿', nodes })
    const result = await h.copy()
    assert.equal(result.nodes.length, nodes.length)
    assert.equal(result.template.status, 'draft')
    assert.deepEqual(result.template.cardDisplay.fields, [])
    assert.equal(result.template.definitionDigest, templateDefinitionDigest(result.nodes))
  }
})

test('copy preserves legacy assignment semantics without upgrading workflow', async () => {
  const h = await harness({ name: '旧模板', nodes: [] })
  const legacy = { _id: 'legacy-node', templateId: h.source.template._id, nodeKey: 'legacy', sequence: 0,
    name: '旧节点', assigneeUserIds: ['processor'], slaWorkHours: 9,
    requiresEvidence: false, allowedEvidenceTypes: [], fields: [] }
  h.fake.replace('template_nodes', legacy._id, legacy)
  h.fake.replace('templates', h.source.template._id, { ...h.source.template, nodeCount: 1,
    definitionNodeIds: [legacy._id], definitionDigest: templateDefinitionDigest([legacy]) })
  const result = await h.copy()
  assert.deepEqual(result.nodes[0].assigneeUserIds, ['processor'])
  assert.equal(result.nodes[0].slaWorkHours, 9)
  assert.equal(result.nodes[0].workflowMode, undefined)
  assert.equal(result.template.flowSchemaVersion, undefined)
})

test('copy rejects missing/deleted sources, stale versions and non-admin actors without writes', async () => {
  const h = await harness()
  const params = { actor: admin, templateId: h.source.template._id, expectedVersion: 1 }
  const writes = h.fake.writeCalls.length
  for (const [overrides, code] of [
    [{ actor: { ...admin, role: 'user' } }, 'FORBIDDEN'],
    [{ actor: { ...admin, status: 'disabled' } }, 'FORBIDDEN'],
    [{ templateId: 'missing' }, 'NOT_FOUND'], [{ expectedVersion: 99 }, 'VERSION_CONFLICT'],
    [{ expectedVersion: undefined }, 'VERSION_CONFLICT']
  ]) await assert.rejects(h.service.copyTemplate({ ...params, ...overrides }), e => e.code === code)
  assert.equal(h.fake.writeCalls.length, writes)
  h.fake.replace('templates', h.source.template._id, { ...h.source.template, status: 'deleted' })
  await assert.rejects(h.service.copyTemplate(params), e => e.code === 'NOT_FOUND')
  assert.equal(h.fake.writeCalls.length, writes)
})

test('copy rejects inactive participants before creation', async () => {
  const h = await harness()
  h.fake.replace('users', 'processor', { status: 'disabled' })
  const writes = h.fake.writeCalls.length
  await assert.rejects(h.copy(), e => e.code === 'PROCESSOR_INACTIVE')
  assert.equal(h.fake.writeCalls.length, writes)
})

for (const mutation of ['actor', 'participant', 'version', 'deleted', 'node', 'card']) {
  test(`copy transaction rechecks ${mutation} and leaves no partial draft`, async () => {
    const h = await harness()
    const writes = h.fake.writeCalls.length
    h.fake.beforeNextTransaction(() => {
      if (mutation === 'actor') h.fake.replace('users', admin._id, { ...admin, role: 'user' })
      if (mutation === 'participant') h.fake.replace('users', 'reviewer', { status: 'disabled' })
      if (mutation === 'version') h.fake.replace('templates', h.source.template._id, { ...h.source.template, version: 2 })
      if (mutation === 'deleted') h.fake.replace('templates', h.source.template._id, { ...h.source.template, status: 'deleted' })
      if (mutation === 'node') h.fake.replace('template_nodes', h.source.nodes[0]._id, { ...h.source.nodes[0], name: '并发更新' })
      if (mutation === 'card') h.fake.replace('templates', h.source.template._id, { ...h.source.template,
        cardDisplay: { schemaVersion: 1, revision: 1, fields: [{ nodeKey: 'entry', fieldKey: 'sku' }] } })
    })
    const expected = { actor: 'FORBIDDEN', participant: 'PARTICIPANT_INACTIVE', deleted: 'NOT_FOUND' }[mutation] || 'VERSION_CONFLICT'
    await assert.rejects(h.copy(), e => e.code === expected)
    assert.equal(h.fake.documents('templates').length, 1)
    assert.equal(h.fake.writeCalls.length, writes)
  })
}

test('copy rolls back template, nodes, display and audit together on storage failure', async () => {
  const h = await harness()
  const before = ['templates', 'template_nodes', 'audit_logs'].map(c => h.fake.documents(c))
  h.fake.failNextWrite({ collection: 'audit_logs', operation: 'set', error: new Error('storage failed') })
  await assert.rejects(h.copy(), /storage failed/)
  assert.deepEqual(['templates', 'template_nodes', 'audit_logs'].map(c => h.fake.documents(c)), before)
})

test('copy enforces the 100-operation budget including source reads before any write', async () => {
  const input = branchInput()
  input.nodes = Array.from({ length: 48 }, (_, i) => ({ ...input.nodes[3], nodeKey: `n${i}`,
    next: i === 47 ? { mode: 'end' } : { mode: 'default', targetNodeKey: `n${i + 1}` } }))
  input.entryNodeKey = 'n0'
  const h = await harness(input)
  const writes = h.fake.writeCalls.length
  await assert.rejects(h.copy(), e => e.code === 'TEMPLATE_LIMIT_EXCEEDED')
  assert.equal(h.fake.writeCalls.length, writes)
})

test('copy round-trips 141 model mappings and 1494 synthetic SKU associations without truncation', async () => {
  const input = branchInput()
  const models = Array.from({ length: 141 }, (_, i) => `Model-${i}`)
  const mappings = Object.fromEntries(models.map((model, i) => [model,
    Array.from({ length: i < 84 ? 11 : 10 }, (_, j) => `${model}-SKU-${j}`)]))
  const fields = input.nodes[0].fields
  fields[1].constraints.options = models
  fields[1].condition.optionsByParentValue = { 甲: models.slice(0, 70), 乙: models.slice(70) }
  fields[2].constraints.options = Object.values(mappings).flat()
  fields[2].condition.visibleWhen = models
  fields[2].condition.optionsByParentValue = mappings
  const h = await harness(input)
  const copy = await h.copy()
  const persisted = await h.repository.getTemplateDefinition(copy.template._id)
  const sku = persisted.nodes[0].fields[2]
  assert.equal(sku.constraints.options.length, 1494)
  assert.equal(Object.keys(sku.condition.optionsByParentValue).length, 141)
  assert.deepEqual(sku.condition.optionsByParentValue, mappings)
  assert.deepEqual(sku.constraints.options, fields[2].constraints.options)
  assert.deepEqual(persisted.nodes[0].fields[1].constraints.options, models)
})

test('copy can use exactly 100 fixed document operations without any transaction query', async () => {
  const input = branchInput()
  input.nodes = Array.from({ length: 48 }, (_, i) => ({ ...input.nodes[3], nodeKey: `n${i}`,
    processorUserIds: [], reviewerUserIds: [], includeBusinessCreatorAsProcessor: true,
    next: i === 47 ? { mode: 'end' } : { mode: 'default', targetNodeKey: `n${i + 1}` } }))
  input.entryNodeKey = 'n0'
  const h = await harness(input)
  const result = await h.copy()
  assert.equal(result.nodes.length, 48)
  assert.equal(h.fake.transactionRuns.at(-1).operations, 100)
  assert.deepEqual(h.fake.transactionQueries, [])
})

test('copy rejects stale or invalid card references instead of silently omitting display fields', async () => {
  const h = await harness()
  h.fake.replace('templates', h.source.template._id, { ...h.source.template,
    cardDisplay: { schemaVersion: 1, revision: 3, fields: [{ nodeKey: 'entry', fieldKey: 'missing' }] } })
  const writes = h.fake.writeCalls.length
  await assert.rejects(h.copy(), e => e.code === 'CARD_DISPLAY_INVALID')
  assert.equal(h.fake.writeCalls.length, writes)
})
