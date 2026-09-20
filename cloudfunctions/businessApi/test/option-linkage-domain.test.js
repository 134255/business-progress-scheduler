const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeOptionLinkageInput, buildOptionLinkageContext, optionLinkageSemanticProjection } = require('../lib/option-linkage-domain')
const { normalizeFieldDefinition, validateFieldValues } = require('../lib/field-domain')
const { resolveConditionalFields, clearInvalidConditionalValues, conditionalFieldDigestProjection } = require('../lib/conditional-field-domain')
const { normalizeTemplateNode } = require('../lib/template-domain')

function fixture() {
  const options = [['椅','桌'], ['牌A','牌B'], ['型号甲','型号乙'], ['红','蓝'], ['小','大'], ['不适用'], ['不适用'], ['软','硬']]
  const fields = options.map((values, index) => ({ fieldKey: `f${index}`, sequence: index, name: `字段${index}`, type: 'single_select', required: true, constraints: { options: values } }))
  fields[0].optionLinkage = { schemaVersion: 1, fieldKeys: fields.map(field => field.fieldKey), rows: [
    [0,0,0,0,0,null,null,0], [0,0,0,1,1,null,null,1], [1,1,1,null,0,null,null,null]
  ] }
  return fields
}
const values = entries => Object.entries(entries).map(([fieldKey, value]) => ({ fieldKey, value }))

test('rule survives normalization and changes its digest without changing legacy projection', () => {
  const fields = fixture()
  assert.deepEqual(normalizeFieldDefinition(fields[0]).optionLinkage, fields[0].optionLinkage)
  assert.deepEqual(conditionalFieldDigestProjection(fields)[0].optionLinkage, fields[0].optionLinkage)
  const plain = fields.map(({ optionLinkage, ...field }) => field)
  assert.equal(Object.hasOwn(conditionalFieldDigestProjection(plain)[0], 'optionLinkage'), false)
})

test('options follow exact prefix, skip gaps and never expose the matrix', () => {
  const fields = fixture()
  let visible = resolveConditionalFields(fields, values({ f0: '椅', f1: '牌A', f2: '型号甲', f3: '红' })).visibleDefinitions
  assert.deepEqual(visible.map(field => field.fieldKey), ['f0','f1','f2','f3','f4'])
  assert.deepEqual(visible.at(-1).constraints.options, ['小'])
  assert.ok(visible.every(field => !Object.hasOwn(field, 'optionLinkage')))
  visible = resolveConditionalFields(fields, values({ f0: '桌', f1: '牌B', f2: '型号乙' })).visibleDefinitions
  assert.deepEqual(visible.map(field => field.fieldKey), ['f0','f1','f2','f4'])
  assert.deepEqual(visible.at(-1).constraints.options, ['小'])
})

test('crossed combinations and hidden injected choices are rejected server-side', () => {
  const fields = fixture()
  assert.throws(() => validateFieldValues(fields, values({ f0:'椅', f1:'牌A', f2:'型号甲', f3:'红', f4:'大', f7:'硬' })), { code:'INVALID_FIELD_VALUE' })
  assert.throws(() => validateFieldValues(fields, values({ f0:'桌', f1:'牌B', f2:'型号乙', f3:'红', f4:'小' })), { code:'INVALID_FIELD_VALUE' })
  assert.equal(validateFieldValues(fields, values({ f0:'桌', f1:'牌B', f2:'型号乙', f4:'小' })).length, 4)
  assert.throws(() => validateFieldValues(fields, values({ f0:'椅', f1:'牌A', f2:'型号甲', f3:'红', f4:'小' })), { code:'INVALID_FIELD_VALUE' })
  assert.doesNotThrow(() => validateFieldValues(fields.map(field => ({ ...field, required: false })), values({ f0:'椅', f1:'牌A' })))
})

test('upstream changes clear invalid descendants while preserving valid and unrelated values', () => {
  const fields = fixture().concat({ fieldKey:'note', sequence:8, type:'short_text', constraints:{} })
  const result = clearInvalidConditionalValues(fields, values({ f0:'桌', f1:'牌A', f2:'型号甲', f3:'红', f4:'小', f7:'软', note:'保留' }))
  assert.deepEqual(result.values, values({ f0:'桌', note:'保留' }))
  const valid = clearInvalidConditionalValues(fields, values({ f0:'椅', f1:'牌A', f2:'型号甲', f3:'红', f4:'小', f7:'软' }))
  assert.deepEqual(valid.clearedFieldKeys, [])
})

test('all members share complete semantic group projection', () => {
  const fields = fixture()
  assert.deepEqual(optionLinkageSemanticProjection(fields, 'f0'), optionLinkageSemanticProjection(fields, 'f7'))
  const before = JSON.stringify(optionLinkageSemanticProjection(fields, 'f4'))
  fields[0].optionLinkage.rows[0][7] = 1
  assert.notEqual(JSON.stringify(optionLinkageSemanticProjection(fields, 'f4')), before)
  assert.equal(optionLinkageSemanticProjection(fields, 'unrelated'), null)
})

test('semantic projection uses actual combinations, stable members and applicable nulls, not row or dictionary order', () => {
  const fields = fixture()
  const original = optionLinkageSemanticProjection(fields, 'f0')
  const reordered = fixture()
  reordered.forEach((field, column) => {
    field.constraints.options.reverse()
    reordered[0].optionLinkage.rows.forEach(row => {
      if (row[column] !== null) row[column] = field.constraints.options.length - 1 - row[column]
    })
  })
  reordered[0].optionLinkage.rows.reverse()
  assert.deepEqual(optionLinkageSemanticProjection(reordered, 'f7'), original)
  const renamed = fixture()
  renamed[7].fieldKey = 'other-attribute'
  renamed[0].optionLinkage.fieldKeys[7] = 'other-attribute'
  assert.notDeepEqual(optionLinkageSemanticProjection(renamed, 'f0'), original)
  const changedNull = fixture()
  changedNull[0].optionLinkage.rows[2][7] = 0
  assert.notDeepEqual(optionLinkageSemanticProjection(changedNull, 'f0'), original)
})

test('semantic projection remains bounded when a long option is shared by many combinations', () => {
  const fields = fixture()
  fields[0].constraints.options = ['字'.repeat(1000)]
  fields[2].constraints.options = Array.from({ length:1500 }, (_, index) => `m${index}`)
  fields[0].optionLinkage.rows = fields[2].constraints.options.map((_, index) => [0,0,index,0,0,null,null,0])
  const projection = optionLinkageSemanticProjection(fields, 'f0')
  assert.ok(Buffer.byteLength(JSON.stringify(projection), 'utf8') <= 256 * 1024)
})

test('reject malformed rule shapes, indices, duplicates, applicability, references and conflicting conditions', () => {
  for (const mutate of [
    f => { f[0].optionLinkage.schemaVersion = 2 },
    f => { f[0].optionLinkage.extra = true },
    f => { f[0].optionLinkage.rows[0][0] = null },
    f => { f[0].optionLinkage.rows[0][4] = 10 },
    f => { f[0].optionLinkage.rows[0][4] = -1 },
    f => { f[0].optionLinkage.rows[0][4] = 0.5 },
    f => { f[0].optionLinkage.rows.push(f[0].optionLinkage.rows[0]) },
    f => { f[0].optionLinkage.rows[1][3] = null },
    f => { f[0].optionLinkage.fieldKeys[1] = 'missing' },
    f => { f[0].optionLinkage.fieldKeys.reverse() },
    f => { f[2].condition = {parentFieldKey:'f1',visibleWhen:['牌A']} },
    f => { f[2].type = 'multi_select' },
    f => { f[1].optionLinkage = f[0].optionLinkage },
    f => { delete f[0].optionLinkage.rows[0][7] }
  ]) {
    const fields = fixture(); mutate(fields)
    assert.throws(() => buildOptionLinkageContext(fields), { code:'INVALID_FIELD_VALUE' })
  }
})

test('untrusted accessors/prototypes are rejected without executing getters', () => {
  let called = false
  const rule = fixture()[0].optionLinkage
  Object.defineProperty(rule, 'rows', { get() { called = true; return [] } })
  assert.throws(() => normalizeOptionLinkageInput(rule), { code:'INVALID_FIELD_VALUE' })
  assert.equal(called, false)
  const fields = fixture()
  Object.defineProperty(fields[0], 'optionLinkage', { get() { called = true; return rule } })
  assert.throws(() => buildOptionLinkageContext(fields), { code:'INVALID_FIELD_VALUE' })
  assert.equal(called, false)
  assert.throws(() => normalizeOptionLinkageInput(Object.create(fixture()[0].optionLinkage)), { code:'INVALID_FIELD_VALUE' })
})

const readers = [
  ['context', fields => buildOptionLinkageContext(fields), 'INVALID_FIELD_VALUE'],
  ['resolver', fields => resolveConditionalFields(fields, []), 'INVALID_FIELD_VALUE'],
  ['field values', fields => validateFieldValues(fields, []), 'INVALID_FIELD_VALUE'],
  ['template node', fields => normalizeTemplateNode({ nodeKey:'n', name:'合成', processorUserIds:['p'],
    reviewerUserIds:[], fields }), 'TEMPLATE_INVALID'],
  ['anchor definition', fields => normalizeFieldDefinition(fields[0]), 'INVALID_FIELD_VALUE']
]
const accessorTargets = [
  ['anchor fieldKey', fields => [fields[0], 'fieldKey'], true],
  ['anchor sequence', fields => [fields[0], 'sequence'], true],
  ['optionLinkage', fields => [fields[0], 'optionLinkage'], true],
  ['anchor constraints', fields => [fields[0], 'constraints'], true],
  ['anchor options', fields => [fields[0].constraints, 'options'], true],
  ['anchor option entry', fields => [fields[0].constraints.options, '0'], true],
  ['member fieldKey', fields => [fields[2], 'fieldKey']],
  ['member sequence', fields => [fields[2], 'sequence']],
  ['member constraints', fields => [fields[2], 'constraints']],
  ['member options', fields => [fields[2].constraints, 'options']],
  ['member option entry', fields => [fields[2].constraints.options, '0']],
  ['field array entry', fields => [fields, '2']],
  ['rule field key entry', fields => [fields[0].optionLinkage.fieldKeys, '0'], true],
  ['rule row entry', fields => [fields[0].optionLinkage.rows, '0'], true],
  ['rule cell entry', fields => [fields[0].optionLinkage.rows[0], '0'], true]
]
for (const [readerName, read, code] of readers) for (const [targetName, target, standalone] of accessorTargets) {
  if (readerName === 'anchor definition' && !standalone) continue
  test(`${readerName} rejects ${targetName} accessor before any getter execution`, () => {
    const fields = fixture()
    const [object, key] = target(fields)
    const value = object[key]
    let calls = 0
    Object.defineProperty(object, key, { get() { calls++; return value }, enumerable:true })
    let error
    try { read(fields) } catch (caught) { error = caught }
    assert.equal(calls, 0)
    assert.equal(error && error.code, code)
  })
}

for (const [name, mutate] of [
  ['inherited rule', fields => { fields[0].optionLinkage = Object.create(fields[0].optionLinkage) }],
  ['inherited optionLinkage', fields => {
    const rule = fields[0].optionLinkage; delete fields[0].optionLinkage
    Object.setPrototypeOf(fields[0], { optionLinkage:rule })
  }],
  ['inherited constraints', fields => {
    const constraints = fields[0].constraints; delete fields[0].constraints
    Object.setPrototypeOf(fields[0], { constraints })
  }],
  ['inherited options', fields => { fields[0].constraints = Object.create(fields[0].constraints) }],
  ['sparse options', fields => { delete fields[0].constraints.options[0] }],
  ['extra options key', fields => { fields[0].constraints.options.extra = true }],
  ['extra constraints key', fields => { fields[0].constraints.extra = true }],
  ['duplicate option', fields => { fields[0].constraints.options[1] = fields[0].constraints.options[0] }],
  ['sparse rule row', fields => { delete fields[0].optionLinkage.rows[0][0] }],
  ['extra rule row key', fields => { fields[0].optionLinkage.rows[0].extra = true }],
  ['duplicate row', fields => { fields[0].optionLinkage.rows.push(fields[0].optionLinkage.rows[0]) }],
  ['extra rule key', fields => { fields[0].optionLinkage.extra = true }]
]) for (const [readerName, read, code] of readers) {
  test(`${readerName} rejects linked ${name} without normalization hiding it`, () => {
    const fields = fixture(); mutate(fields)
    assert.throws(() => read(fields), { code })
  })
}

test('linked definitions reject duplicate members and unsafe sequence coercion before sorting', () => {
  const duplicate = fixture()
  duplicate.push({ ...duplicate[2], sequence:8 })
  assert.throws(() => buildOptionLinkageContext(duplicate), { code:'INVALID_FIELD_VALUE' })
  const fields = fixture()
  let calls = 0
  fields[2].sequence = { valueOf() { calls++; return 2 } }
  assert.throws(() => buildOptionLinkageContext(fields), { code:'INVALID_FIELD_VALUE' })
  assert.equal(calls, 0)
})

test('descriptor preflight preserves own metadata projections and unrelated legacy normalization', () => {
  const fields = fixture()
  fields[0].clientFieldKey = 'draft-category'
  fields[0].displayHint = { source:'synthetic' }
  const visible = resolveConditionalFields(fields, []).visibleDefinitions[0]
  assert.equal(visible.clientFieldKey, 'draft-category')
  assert.deepEqual(visible.displayHint, { source:'synthetic' })
  const legacy = { fieldKey:'old', name:'旧字段', type:'single_select', constraints:{ options:[' A ', ' B '] } }
  assert.deepEqual(normalizeFieldDefinition(legacy).constraints.options, ['A', 'B'])
  assert.equal(Object.hasOwn(normalizeFieldDefinition(legacy), 'optionLinkage'), false)
})

for (const [readerName, read, code] of readers.filter(([name]) => ['field values', 'template node'].includes(name))) {
  test(`${readerName} validates raw member options before field-key whitespace normalization`, () => {
    const fields = fixture()
    fields[2].fieldKey = ' f2 '
    let calls = 0
    Object.defineProperty(fields[2].constraints, 'options', { get() { calls++; return ['型号甲', '型号乙'] } })
    let error
    try { read(fields) } catch (caught) { error = caught }
    assert.equal(calls, 0)
    assert.equal(error && error.code, code)
  })
}

test('row and UTF-8 byte budgets reject oversized rule groups', () => {
  const fields = fixture()
  fields[0].optionLinkage.rows = Array.from({ length:5001 }, () => fields[0].optionLinkage.rows[0])
  assert.throws(() => buildOptionLinkageContext(fields), { code:'INVALID_FIELD_VALUE' })
  const large = fixture()
  large[7].constraints.options[0] = '字'.repeat(90000)
  assert.throws(() => buildOptionLinkageContext(large), { code:'INVALID_FIELD_VALUE' })
})

module.exports = { fixture }
