const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

// Only synthetic data. The optional root also runs this contract against an
// exact downloaded deployment, without changing that deployment or require.cache.
const lib = process.env.LINKAGE_TEST_LIB || path.join(__dirname, '../lib')
function measuredDomains() {
  const counts = { normalizeOptionLinkageInput: 0, ownArray: 0, buildOptionLinkageContext: 0 }
  const cache = new Map()
  function load(filename) {
    filename = require.resolve(filename)
    if (cache.has(filename)) return cache.get(filename).exports
    const loaded = new Module(filename, module)
    loaded.filename = filename
    loaded.paths = module.paths
    cache.set(filename, loaded)
    const normalRequire = loaded.require.bind(loaded)
    loaded.require = name => name === 'test:linkage-counts' ? counts
      : name.startsWith('./') ? load(path.resolve(path.dirname(filename), name)) : normalRequire(name)
    let source = fs.readFileSync(filename, 'utf8')
    if (path.basename(filename) === 'option-linkage-domain.js') {
      source = `const linkageCounts = require('test:linkage-counts')\n${source}`
      for (const name of Object.keys(counts)) {
        const entry = new RegExp(`function ${name}\\([^)]*\\) \\{`)
        assert.match(source, entry, `real helper must remain instrumented: ${name}`)
        source = source.replace(entry, match => `${match}\nlinkageCounts.${name}++`)
      }
    }
    loaded._compile(source, filename)
    return loaded.exports
  }
  return { counts, template: load(path.join(lib, 'template-domain')),
    field: load(path.join(lib, 'field-domain')), conditional: load(path.join(lib, 'conditional-field-domain')),
    routing: load(path.join(lib, 'workflow-routing-domain')) }
}

function fixture({ rows = 3000, branch = false, conditions = false, nodeCount = 10 } = {}) {
  const fields = [1, Math.ceil(rows / 500), 500, 2, 1, 1, 1, 1].map((size, i) => ({
    fieldKey: `f${i}`, sequence: i, name: `Field ${i}`, description: '',
    type: 'single_select', required: true,
    constraints: { options: Array.from({ length: size }, (_, j) => `Option ${j}`) }
  }))
  fields[0].optionLinkage = { schemaVersion: 1, fieldKeys: fields.map(field => field.fieldKey),
    rows: Array.from({ length: rows }, (_, i) =>
      [0, Math.floor(i / 500), i % 500, i % 2, null, null, null, null]) }
  fields.push({ fieldKey: 'serial', sequence: 8, name: 'Serial', description: '',
    type: 'short_text', required: false, constraints: {}, scanEnabled: true })
  if (branch || conditions) fields.push({ fieldKey: 'route', sequence: 9, name: 'Route', description: '',
    type: 'single_select', required: true, constraints: { options: ['Z', 'A'] } })
  if (conditions) fields.push({ fieldKey: 'child', sequence: 10, name: 'Child', description: '',
    type: 'single_select', required: false, constraints: { options: ['z', 'a'] },
    condition: { parentFieldKey: 'route', visibleWhen: ['Z', 'A'], optionsByParentValue: { Z: ['z'], A: ['a'] } } })
  return { flowSchemaVersion: 2, entryNodeKey: 'n0', nodes: Array.from({ length: nodeCount }, (_, i) => ({
    nodeKey: `n${i}`, sequence: i, name: `Node ${i}`, description: '', workflowMode: 'review',
    activationMode: 'required', processorAssignmentMode: 'fixed_accounts', processorUserIds: ['processor'],
    includeBusinessCreatorAsProcessor: false, reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: ['reviewer'],
    reviewMode: 'any', processingSlaWorkHours: 8, reviewSlaWorkHours: 4,
    requiresEvidence: false, allowedEvidenceTypes: ['pdf'], fields: i === 0 ? fields : [],
    next: i === nodeCount - 1 ? { mode: 'end' } : i === 0 && branch
      ? { mode: 'single_select', fieldKey: 'route', optionTargets: { Z: 'n1', A: 'end' } }
      : { mode: 'default', targetNodeKey: `n${i + 1}` }
  })) }
}

for (const branch of [false, true]) test(`two fresh V2 passes bound real linkage work (branch=${branch})`, t => {
  const measured = measuredDomains()
  const input = fixture({ branch })
  const before = structuredClone(input)
  const first = measured.template.normalizeVersion2TemplateDefinition(input)
  const second = measured.template.normalizeVersion2TemplateDefinition(input)
  assert.deepEqual(first, before)
  assert.deepEqual(second, before)
  assert.deepEqual(input, before)
  assert.notEqual(first.nodes[0].fields[0].optionLinkage.rows, second.nodes[0].fields[0].optionLinkage.rows)
  t.diagnostic(JSON.stringify(measured.counts))
  // Only the single-field preflight owns an isolated rule that can be reused.
  // Conditional cloning and branch routing must revalidate: unrelated getters
  // can mutate raw rules or dictionaries after initial group inspection.
  assert.equal(measured.counts.normalizeOptionLinkageInput, branch ? 14 : 12)
  assert.ok(measured.counts.ownArray < (branch ? 43000 : 37000))
  assert.equal(measured.counts.buildOptionLinkageContext, branch ? 42 : 40)
})

test('standalone field normalization retains the preflight rule copy without parsing it twice', () => {
  const m = measuredDomains()
  const field = fixture().nodes[0].fields[0]
  const result = m.field.normalizeFieldDefinition(field)
  assert.deepEqual(result, field)
  assert.notEqual(result.optionLinkage, field.optionLinkage)
  assert.equal(m.counts.normalizeOptionLinkageInput, 1)
})

test('standalone conditional normalization preserves preflight and clone validation', () => {
  const m = measuredDomains()
  const fields = fixture().nodes[0].fields
  assert.deepEqual(m.conditional.normalizeConditionalFields(fields), fields)
  assert.equal(m.counts.normalizeOptionLinkageInput, 2)
  assert.equal(m.counts.buildOptionLinkageContext, 1)
})

test('standalone branch graph preserves strict final-field validation', () => {
  const m = measuredDomains()
  const input = fixture({ branch: true, nodeCount: 2 })
  assert.deepEqual(m.routing.normalizeWorkflowGraph(input), input)
  assert.equal(m.counts.normalizeOptionLinkageInput, 3)
  assert.equal(m.counts.buildOptionLinkageContext, 3)
})

const malformed = [
  ['schema', f => { f[0].optionLinkage.schemaVersion = 2 }],
  ['extra rule key', f => { f[0].optionLinkage.extra = true }],
  ['missing rows', f => { delete f[0].optionLinkage.rows }],
  ['empty rows', f => { f[0].optionLinkage.rows = [] }],
  ['duplicate row', f => { f[0].optionLinkage.rows.push(f[0].optionLinkage.rows[0]) }],
  ['negative cell', f => { f[0].optionLinkage.rows[0][0] = -1 }],
  ['fractional cell', f => { f[0].optionLinkage.rows[0][0] = 0.5 }],
  ['null model', f => { f[0].optionLinkage.rows[0][2] = null }],
  ['out of range cell', f => { f[0].optionLinkage.rows[0][2] = 500 }],
  ['sparse row', f => { delete f[0].optionLinkage.rows[0][7] }],
  ['extra row property', f => { f[0].optionLinkage.rows[0].extra = 1 }],
  ['inherited rule', f => { f[0].optionLinkage = Object.create(f[0].optionLinkage) }],
  ['inherited linkage', f => {
    const rule = f[0].optionLinkage; delete f[0].optionLinkage
    Object.setPrototypeOf(f[0], { optionLinkage: rule })
  }],
  ['missing member', f => { f.splice(7, 1) }],
  ['missing dictionary', f => { delete f[7].constraints }],
  ['reordered members', f => { f[0].optionLinkage.fieldKeys.reverse() }],
  ['duplicate member', f => { f.push({ ...f[7] }) }],
  ['extra anchor', f => { f[1].optionLinkage = f[0].optionLinkage }],
  ['member condition', f => { f[1].condition = { parentFieldKey: 'f0', visibleWhen: ['Option 0'] } }],
  ['member type', f => { f[1].type = 'multi_select' }],
  ['inconsistent applicability', f => { f[0].optionLinkage.rows.push([0, 0, 0, null, null, null, null, null]) }],
  ['duplicate option', f => { f[2].constraints.options[1] = 'Option 0' }],
  ['untrimmed dictionary', f => { f[2].constraints.options[1] = ' Option 1 ' }],
  ['inherited dictionary', f => { f[2].constraints = Object.create(f[2].constraints) }],
  ['extra dictionary property', f => { f[2].constraints.options.extra = 1 }],
  ['unsafe sequence', f => { f[2].sequence = { valueOf() { throw new Error('must not coerce') } } }]
]
for (const [name, change] of malformed) test(`raw V2/conditional/graph reject ${name} with original errors`, () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, nodeCount: 2 })
  change(input.nodes[0].fields)
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(input), { code: 'TEMPLATE_INVALID', message: 'TEMPLATE_INVALID' })
  assert.throws(() => m.conditional.normalizeConditionalFields(input.nodes[0].fields), { code: 'INVALID_FIELD_VALUE' })
  assert.throws(() => m.routing.normalizeWorkflowGraph(input), { code: 'TEMPLATE_INVALID' })
})

const accessorTargets = [
  ['anchor', f => [f[0], 'optionLinkage']], ['field key', f => [f[0], 'fieldKey']],
  ['member dictionary', f => [f[2].constraints, 'options']], ['dictionary item', f => [f[2].constraints.options, '0']],
  ['rule rows', f => [f[0].optionLinkage, 'rows']], ['rule field key', f => [f[0].optionLinkage.fieldKeys, '0']],
  ['rule row', f => [f[0].optionLinkage.rows, '0']], ['rule cell', f => [f[0].optionLinkage.rows[0], '0']],
  ['field array', f => [f, '0']], ['condition', f => [f[10].condition, 'visibleWhen']]
]
for (const [name, locate] of accessorTargets) test(`accessor ${name} is rejected without executing it`, () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, conditions: true, nodeCount: 2 })
  const [object, key] = locate(input.nodes[0].fields)
  const value = object[key]
  let calls = 0
  Object.defineProperty(object, key, { enumerable: true, get() { calls++; return value } })
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(input), { code: 'TEMPLATE_INVALID' })
  assert.throws(() => m.conditional.normalizeConditionalFields(input.nodes[0].fields), { code: 'INVALID_FIELD_VALUE' })
  assert.throws(() => m.routing.normalizeWorkflowGraph(input), { code: 'TEMPLATE_INVALID' })
  assert.equal(calls, 0)
})

test('conditions, dictionary order, row order and creator-independent digest keep the original encoding', () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, branch: true, conditions: true, nodeCount: 2 })
  const expected = structuredClone(input)
  // Conditional dictionary keys are canonically sorted; option and row order are not.
  expected.nodes[0].fields[10].condition.optionsByParentValue = { A: ['a'], Z: ['z'] }
  input.nodes[0].name = ' Node 0 '
  input.nodes[0].fields[0].fieldKey = ' f0 '
  input.nodes[0].fields[2].fieldKey = ' f2 '
  input.nodes[0].processorAssignmentMode = 'business_creator'
  input.nodes[0].processorUserIds = []
  expected.nodes[0].processorUserIds = []
  expected.nodes[0].includeBusinessCreatorAsProcessor = true
  const digest = crypto.createHash('sha256').update(JSON.stringify(expected)).digest('hex')
  assert.deepEqual(m.template.normalizeVersion2TemplateDefinition(input), expected)
  assert.equal(m.template.version2TemplateDefinitionDigest(input), digest)
  const prepared = m.template.prepareVersion2TemplateCreation(input)
  assert.equal(prepared.digest, digest)
  assert.deepEqual(prepared.route, expected)
  assert.equal(prepared.validateForEnable(), true)
  input.nodes[0].fields[0].optionLinkage.rows.reverse()
  assert.notEqual(m.template.version2TemplateDefinitionDigest(input), digest)
  const reordered = structuredClone(expected)
  reordered.nodes[0].fields[3].constraints.options.reverse()
  reordered.nodes[0].fields[0].optionLinkage.rows.forEach(row => { row[3] = 1 - row[3] })
  assert.deepEqual(m.template.normalizeVersion2TemplateDefinition(reordered), reordered)
  assert.notEqual(m.template.version2TemplateDefinitionDigest(reordered), digest)
})

for (const [name, mutate] of [
  ['linked routing member', x => { x.nodes[0].next = { mode: 'single_select', fieldKey: 'f0', optionTargets: { 'Option 0': 'n1' } } }],
  ['missing branch option', x => { delete x.nodes[0].next.optionTargets.A }],
  ['conditional routing field', x => { x.nodes[0].fields[9].condition = { parentFieldKey: 'f0', visibleWhen: ['Option 0'] } }],
  ['missing condition parent', x => { x.nodes[0].fields[10].condition.parentFieldKey = 'missing' }],
  ['condition outside dictionary', x => { x.nodes[0].fields[10].condition.visibleWhen = ['missing'] }],
  ['cycle', x => { x.nodes[1].next = { mode: 'default', targetNodeKey: 'n0' } }],
  ['missing route target', x => { x.nodes[0].next.optionTargets.Z = 'missing' }]
]) test(`conditional/route semantics still reject ${name}`, () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, branch: true, conditions: true, nodeCount: 2 })
  mutate(input)
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(input), { code: 'TEMPLATE_INVALID' })
  assert.throws(() => m.routing.normalizeWorkflowGraph(input), { code: 'TEMPLATE_INVALID' })
})

test('5000 rows accepted intact; 5001 rows and both UTF-8 byte budgets rejected', () => {
  const m = measuredDomains()
  const input = fixture({ rows: 5000, nodeCount: 2 })
  assert.deepEqual(m.template.normalizeVersion2TemplateDefinition(input), input)
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(fixture({ rows: 5001 })), { code: 'TEMPLATE_INVALID' })
  const group = fixture({ rows: 3 })
  group.nodes[0].fields[7].constraints.options[0] = '字'.repeat(90000)
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(group), { code: 'TEMPLATE_INVALID' })
  const node = fixture({ rows: 3 })
  node.nodes[0].description = '字'.repeat(180000)
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(node), { code: 'TEMPLATE_INVALID' })
})

test('later source or result mutation never inherits a previous validation or mutates another snapshot', () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, nodeCount: 2 })
  const original = structuredClone(input)
  const first = m.template.normalizeVersion2TemplateDefinition(input)
  const second = m.template.normalizeVersion2TemplateDefinition(input)
  first.nodes[0].fields[0].optionLinkage.rows[0][0] = 1
  first.nodes[0].fields[2].constraints.options[0] = 'Changed'
  assert.deepEqual(input, original)
  assert.deepEqual(second, original)
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(first), { code: 'TEMPLATE_INVALID' })
  input.nodes[0].fields[0].optionLinkage.rows[0][2] = 500
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(input), { code: 'TEMPLATE_INVALID' })
  assert.deepEqual(second, original)
})

test('ordinary entries ignore forged skip/context arguments and revalidate reused objects', () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, nodeCount: 2 })
  const fields = input.nodes[0].fields
  m.field.normalizeFieldDefinition(fields[0])
  m.conditional.normalizeConditionalFields(fields)
  m.routing.normalizeWorkflowGraph(input)
  fields[0].optionLinkage.rows.push(fields[0].optionLinkage.rows[0])
  const forged = { skipValidation: true, trusted: true, members: new Map(), fields }
  assert.throws(() => m.field.normalizeFieldDefinition(fields[0], forged), { code: 'INVALID_FIELD_VALUE' })
  assert.throws(() => m.conditional.normalizeConditionalFields(fields, forged), { code: 'INVALID_FIELD_VALUE' })
  assert.throws(() => m.routing.normalizeWorkflowGraph(input, forged), { code: 'TEMPLATE_INVALID' })
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(input, forged), { code: 'TEMPLATE_INVALID' })
})

test('exact group and final routed-node byte limits accept the boundary and reject one extra byte', () => {
  const m = measuredDomains()
  const group = fixture({ rows: 3, nodeCount: 2 })
  const fields = group.nodes[0].fields
  const bytes = Buffer.byteLength(JSON.stringify({ optionLinkage: fields[0].optionLinkage,
    options: fields.slice(0, 8).map(field => field.constraints.options) }))
  fields[0].constraints.options[0] += 'x'.repeat(256 * 1024 - bytes)
  assert.deepEqual(m.template.normalizeVersion2TemplateDefinition(group), group)
  fields[0].constraints.options[0] += 'x'
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(group), { code: 'TEMPLATE_INVALID' })
  const input = fixture({ rows: 3, nodeCount: 2 })
  input.nodes[0].description = 'x'.repeat(512 * 1024 - Buffer.byteLength(JSON.stringify(input.nodes[0])))
  assert.deepEqual(m.template.normalizeVersion2TemplateDefinition(input), input)
  input.nodes[0].description += 'x'
  assert.throws(() => m.template.normalizeVersion2TemplateDefinition(input), { code: 'TEMPLATE_INVALID' })
})

test('rule-only byte budget rejects large safe integer rows before dictionary interpretation', () => {
  const m = measuredDomains()
  const anchor = fixture({ rows: 3 }).nodes[0].fields[0]
  anchor.optionLinkage.rows = Array.from({ length: 5000 }, (_, i) =>
    [Number.MAX_SAFE_INTEGER - i, ...Array(7).fill(Number.MAX_SAFE_INTEGER)])
  assert.throws(() => m.field.normalizeFieldDefinition(anchor), { code: 'INVALID_FIELD_VALUE' })
})

test('frozen raw definitions remain intact through normalization and preparation', () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, branch: true, conditions: true, nodeCount: 2 })
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  const before = JSON.stringify(input)
  freeze(input)
  const prepared = m.template.prepareVersion2TemplateCreation(input)
  assert.equal(prepared.route.nodes[0].fields[0].optionLinkage.rows.length, 3)
  assert.equal(JSON.stringify(input), before)
  assert.equal(prepared.validateForEnable(), true)
})

test('standalone branch revalidates final linked fields after spread drops non-enumerable type', () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, branch: true, nodeCount: 2 })
  Object.defineProperty(input.nodes[0].fields[1], 'type', { value: 'single_select', enumerable: false })
  assert.throws(() => m.routing.normalizeWorkflowGraph(input), {
    code: 'INVALID_FIELD_VALUE', message: 'INVALID_FIELD_VALUE'
  })
})

for (const [name, mutate] of [
  ['sparse dictionary', options => { delete options[0] }],
  ['duplicate dictionary', options => { options.push(options[0]) }],
  ['untrimmed dictionary', options => { options[0] = ` ${options[0]} ` }]
]) test(`standalone branch revalidates final linked fields after getter creates ${name}`, () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, branch: true, nodeCount: 2 })
  const fields = input.nodes[0].fields
  let calls = 0
  Object.defineProperty(fields[9].constraints, 'options', { enumerable: true, get() {
    calls++
    mutate(fields[1].constraints.options)
    return ['Z', 'A']
  } })
  assert.throws(() => m.routing.normalizeWorkflowGraph(input), {
    code: 'INVALID_FIELD_VALUE', message: 'INVALID_FIELD_VALUE'
  })
  assert.equal(calls, 1)
})

for (const [entry, read, code] of [
  ['conditional', (m, input) => m.conditional.normalizeConditionalFields(input.nodes[0].fields), 'INVALID_FIELD_VALUE'],
  ['routing', (m, input) => m.routing.normalizeWorkflowGraph(input), 'TEMPLATE_INVALID']
]) test(`${entry} rejects rule mutation by a preceding unrelated field getter during cloning`, () => {
  const m = measuredDomains()
  const input = fixture({ rows: 3, branch: true, nodeCount: 2 })
  const fields = input.nodes[0].fields
  const anchor = fields[0]
  const route = fields.pop()
  // Preserve sequence values but visit the unrelated field before the anchor
  // during cloning. Initial group preflight sees a valid rule; this getter
  // runs later while spreading route.constraints, before the anchor is cloned.
  fields.unshift(route)
  let calls = 0
  Object.defineProperty(route.constraints, 'options', { enumerable: true, get() {
    calls++
    anchor.optionLinkage.rows[0][2] = -1
    return ['Z', 'A']
  } })
  assert.throws(() => read(m, input), { code, message: code })
  assert.equal(calls, 1)
})
