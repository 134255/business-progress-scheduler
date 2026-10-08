const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeFieldDefinition, validateFieldValues } = require('../lib/field-domain')
const { normalizeTemplateNode, templateDefinitionDigest, version2TemplateDefinitionDigest } = require('../lib/template-domain')
const { resolveConditionalFields } = require('../lib/conditional-field-domain')
const { createTemplateHarness } = require('./helpers/template-harness')

const field = (extra = {}) => ({ fieldKey: 'code', name: 'Code', type: 'short_text', ...extra })
const node = (extra = {}) => ({ nodeKey: 'n', name: 'Collect', sequence: 0, workflowMode: 'review',
  processorUserIds: ['p'], reviewerUserIds: [], fields: [field()], ...extra })

test('absent and false scan flags keep historical normalized fields and frozen legacy digests', () => {
  const expected = { fieldKey: 'code', sequence: 0, name: 'Code', description: '', type: 'short_text', required: false, constraints: {} }
  for (const extra of [{}, { scanEnabled: false }]) {
    assert.deepEqual(normalizeFieldDefinition(field(extra)), expected)
    const source = node({ fields: [field(extra)] })
    assert.equal(templateDefinitionDigest([source]), '4eb6195bc074c7851943b32dc6a2d6d9cab3f7765c7164e1f65f8047a89e7534')
    assert.equal(version2TemplateDefinitionDigest({ flowSchemaVersion: 2, entryNodeKey: 'n', nodes: [{ ...source, next: { mode: 'end' } }] }),
      'b85eb7fce6574b984a44d2872f8f53e2d234d134f343828c21a643ec5e1abf98')
  }
})

test('enabled short text survives normalization and conditions without changing text validation', () => {
  const enabled = field({ scanEnabled: true, constraints: { maxLength: 10 } })
  assert.equal(normalizeFieldDefinition(enabled).scanEnabled, true)
  const disabled = { ...enabled, scanEnabled: false }
  assert.notEqual(templateDefinitionDigest([node({ fields: [enabled] })]), templateDefinitionDigest([node({ fields: [disabled] })]))
  const graph = value => ({ flowSchemaVersion: 2, entryNodeKey: 'n', nodes: [node({ fields: [value], next: { mode: 'end' } })] })
  assert.notEqual(version2TemplateDefinitionDigest(graph(enabled)), version2TemplateDefinitionDigest(graph(disabled)))
  const normalized = normalizeTemplateNode(node({ fields: [
    { fieldKey: 'choice', name: 'Choice', type: 'single_select', constraints: { options: ['Yes', 'No'] } },
    { ...enabled, condition: { parentFieldKey: 'choice', visibleWhen: ['Yes'] } }
  ] })).fields
  const visible = resolveConditionalFields(normalized, [{ fieldKey: 'choice', value: 'Yes' }]).visibleDefinitions
  assert.equal(visible[1].scanEnabled, true)
  assert.equal(resolveConditionalFields(normalized, [{ fieldKey: 'choice', value: 'No' }]).visibleDefinitions.length, 1)
  assert.deepEqual(validateFieldValues([enabled], [{ fieldKey: 'code', value: '00123' }]),
    [{ fieldKey: 'code', name: 'Code', type: 'short_text', value: '00123' }])
  assert.throws(() => validateFieldValues([enabled], [{ fieldKey: 'code', value: '12345678901' }]), { code: 'INVALID_FIELD_VALUE' })
})

test('invalid barcode configuration is rejected without reading accessors or coercing values', () => {
  let accessed = 0
  const getter = field()
  Object.defineProperty(getter, 'scanEnabled', { enumerable: true, get() { accessed++; return true } })
  const inherited = Object.assign(Object.create({ scanEnabled: true }), field())
  const typeGetter = field({ scanEnabled: true })
  Object.defineProperty(typeGetter, 'type', { enumerable: true, get() { accessed++; return 'short_text' } })
  const invalid = [getter, inherited, typeGetter, ...['true', 1, 0, null, undefined, {}, []].map(scanEnabled => field({ scanEnabled })),
    ...['long_text', 'number', 'boolean', 'date', 'single_select', 'multi_select'].map(type => field({
      type, scanEnabled: true, ...(/select/.test(type) ? { constraints: { options: ['A'] } } : {})
    }))]
  for (const value of invalid) {
    assert.throws(() => normalizeFieldDefinition(value), { code: 'INVALID_FIELD_VALUE' })
    assert.throws(() => normalizeTemplateNode(node({ fields: [value] })), { code: 'TEMPLATE_INVALID' })
  }
  assert.equal(accessed, 0)
})

for (const version of [1, 2]) {
  test(`v${version} create, update, copy and old-client preservation retain scan metadata`, async () => {
    const h = createTemplateHarness({ users: [{ _id: 'p', status: 'active' }] })
    const metadata = version === 2 ? { flowSchemaVersion: 2, entryNodeKey: 'n' } : {}
    const created = await h.service.createTemplate({ actor: h.admin, input: { name: 'Sample', ...metadata,
      nodes: [node({ ...(version === 2 ? { next: { mode: 'end' } } : {}), fields: [field({ scanEnabled: true })] })] } })
    assert.equal(created.nodes[0].fields[0].scanEnabled, true)
    const copied = await h.service.copyTemplate({ actor: h.admin, templateId: created.template._id, expectedVersion: 1 })
    assert.equal(copied.nodes[0].fields[0].scanEnabled, true)
    assert.notEqual(copied.nodes[0].fields[0].fieldKey, created.nodes[0].fields[0].fieldKey)
    const input = { name: 'Renamed', ...metadata, nodes: structuredClone(created.nodes) }
    delete input.nodes[0].fields[0].scanEnabled
    const update = (expectedVersion) => h.service.updateTemplate({ actor: h.admin, templateId: created.template._id, expectedVersion, input })
    const bad = structuredClone(input)
    bad.nodes[0].fields = null
    await assert.rejects(h.service.updateTemplate({ actor: h.admin, templateId: created.template._id, expectedVersion: 1, input: bad }), { code: 'TEMPLATE_INVALID' })
    const updated = await update(1)
    assert.equal(updated.nodes[0].fields[0].scanEnabled, true, 'old clients must not silently remove enabled metadata')
    assert.equal(updated.template.definitionDigest, created.template.definitionDigest)
    input.nodes[0].fields[0].type = 'number'
    await assert.rejects(update(2), { code: 'TEMPLATE_INVALID' })
    input.nodes[0].fields[0].scanEnabled = false
    const disabled = await update(2)
    assert.equal(Object.hasOwn(disabled.nodes[0].fields[0], 'scanEnabled'), false)
    assert.equal(disabled.nodes[0].fields[0].type, 'number')
    assert.equal(copied.nodes[0].fields[0].scanEnabled, true)
    input.nodes[0].fields = []
    const removed = await update(3)
    assert.deepEqual(removed.nodes[0].fields, [], 'intentional field removal is not undone')
  })
}
