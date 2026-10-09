const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const { summarizeNodeFields } = require('../lib/business-card-summary')

// Count real resolver executions without changing the shared module cache or
// replacing validation/projection with a mock. Repeated identical-prefix work
// is the regression; elapsed wall time is deliberately not a test assertion.
function measuredSummarizer() {
  const filename = require.resolve('../lib/business-card-summary')
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = module.paths
  const normalRequire = loaded.require.bind(loaded)
  let resolutions = 0
  loaded.require = name => {
    const dependency = normalRequire(name)
    return name === './conditional-field-domain' ? {
      ...dependency,
      resolveConditionalFields(...args) {
        resolutions++
        return dependency.resolveConditionalFields(...args)
      }
    } : dependency
  }
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename)
  return { summarize: loaded.exports.summarizeNodeFields, count: () => resolutions }
}

function largeDefinitions() {
  const fields = [1, 6, 500, 2, 1, 1, 1, 1].map((size, i) => ({
    fieldKey: `f${i}`, sequence: i, name: `Field ${i}`, type: 'single_select', required: true,
    constraints: { options: Array.from({ length: size }, (_, j) => `Option ${j}`) }
  }))
  fields[0].optionLinkage = { schemaVersion: 1, fieldKeys: fields.map(field => field.fieldKey),
    rows: Array.from({ length: 2729 }, (_, i) =>
      [0, Math.floor(i / 500), i % 500, i % 2, null, null, null, null]) }
  return [...fields, ...Array.from({ length: 13 }, (_, i) => ({
    fieldKey: `extra${i}`, sequence: i + 8, name: `Extra ${i}`,
    type: 'short_text', required: false, constraints: {}
  }))]
}

test('empty large card resolves the unchanged value prefix once, preserving unfilled and hidden fields', () => {
  const measured = measuredSummarizer()
  assert.deepEqual(measured.summarize({ definitions: largeDefinitions(), values: [], selections: [
    { fieldKey: 'f0', id: 'field-1' }, { fieldKey: 'f1', id: 'field-2' },
    { fieldKey: 'extra0', id: 'field-3' }
  ] }), [
    { id: 'field-1', label: 'Field 0', value: '未填写' },
    { id: 'field-3', label: 'Extra 0', value: '未填写' }
  ])
  assert.equal(measured.count(), 1)
})

test('partially filled large card resolves only changed prefixes, not every empty field', () => {
  const measured = measuredSummarizer()
  assert.deepEqual(measured.summarize({ definitions: largeDefinitions(), values: [
    { fieldKey: 'f0', value: 'Option 0' }, { fieldKey: 'f1', value: 'Option 0' },
    { fieldKey: 'f2', value: 'Option 0' }
  ], selections: [{ fieldKey: 'f2', id: 'field-1' }, { fieldKey: 'f3', id: 'field-2' }] }), [
    { id: 'field-1', label: 'Field 2', value: 'Option 0' },
    { id: 'field-2', label: 'Field 3', value: '未填写' }
  ])
  assert.equal(measured.count(), 4)
})

test('hidden stale values reuse the same resolution without revealing invalid descendants', () => {
  const measured = measuredSummarizer()
  assert.deepEqual(measured.summarize({ definitions: largeDefinitions(),
    values: [1, 2, 3, 4, 5, 6, 7].map(i => ({ fieldKey: `f${i}`, value: 'stale' })),
    selections: [{ fieldKey: 'f1', id: 'field-1' }, { fieldKey: 'f7', id: 'field-2' }]
  }), [])
  assert.equal(measured.count(), 1)
})

function definitions() {
  const dictionaries = [
    ['Chair', 'Desk'], ['ChairBrand', 'DeskBrand'], ['ChairModel', 'DeskModel', 'Other'],
    ['Red', 'Blue'], ['Fabric', 'Leather'], ['Small', 'Large'], ['No', 'Yes'], ['Basic', 'Plus']
  ]
  const fields = dictionaries.map((options, i) => ({
    fieldKey: `f${i}`, sequence: i, name: `Field ${i}`, type: 'single_select', required: true,
    constraints: { options }
  }))
  fields[0].optionLinkage = { schemaVersion: 1, fieldKeys: fields.map(field => field.fieldKey), rows: [
    [0, 0, 0, 0, 0, null, 0, null], [0, 0, 0, 1, 1, null, 0, null],
    [0, 0, 2, null, null, null, null, null],
    [1, 1, 1, null, null, 1, null, 0], [1, 1, 2, null, null, null, null, null]
  ] }
  fields.push({ fieldKey: 'other', sequence: 8, name: 'Other model', type: 'short_text',
    required: true, constraints: {}, condition: { parentFieldKey: 'f2', visibleWhen: ['Other'] } })
  return fields
}
const values = object => Object.entries(object).map(([fieldKey, value]) => ({ fieldKey, value }))
const selections = ['f2', 'f3', 'f5', 'other'].map((fieldKey, i) => ({ fieldKey, id: `field-${i + 1}` }))

for (const [label, submitted, want] of [
  ['chair with stale table attributes', { f0: 'Chair', f1: 'ChairBrand', f2: 'ChairModel',
    f3: 'Red', f4: 'Fabric', f6: 'No', f5: 'Large', other: 'stale' }, [
    { id: 'field-1', label: 'Field 2', value: 'ChairModel' },
    { id: 'field-2', label: 'Field 3', value: 'Red' }
  ]],
  ['desk with attribute gaps', { f0: 'Desk', f1: 'DeskBrand', f2: 'DeskModel',
    f3: 'Red', f4: 'Fabric', f5: 'Large', f7: 'Basic' }, [
    { id: 'field-1', label: 'Field 2', value: 'DeskModel' },
    { id: 'field-3', label: 'Field 5', value: 'Large' }
  ]],
  ['other model conditional text', { f0: 'Chair', f1: 'ChairBrand', f2: 'Other',
    f3: 'Blue', f4: 'Fabric', f5: 'Small', other: 'Synthetic model' }, [
    { id: 'field-1', label: 'Field 2', value: 'Other' },
    { id: 'field-4', label: 'Other model', value: 'Synthetic model' }
  ]],
  ['missing parent hides stale branch', { f2: 'Other', other: 'stale' }, []]
]) test(`keeps exact card contents for ${label}`, () => {
  const input = { definitions: definitions(), values: values(submitted), selections }
  const before = structuredClone(input)
  assert.deepEqual(summarizeNodeFields(input), want)
  assert.deepEqual(input, before)
})

for (const [label, submitted] of [
  ['wrong category-brand', { f0: 'Chair', f1: 'DeskBrand' }],
  ['wrong colour-material combination', { f0: 'Chair', f1: 'ChairBrand', f2: 'ChairModel', f3: 'Blue', f4: 'Fabric' }],
  ['empty visible selection', { f0: '' }],
  ['unknown key', { unknown: 'x' }]
]) test(`still rejects ${label} even when no fields are selected for display`, () => {
  assert.throws(() => summarizeNodeFields({ definitions: definitions(), values: values(submitted), selections: [] }),
    { name: 'Error', code: 'CARD_SUMMARY_INVALID', message: 'CARD_SUMMARY_INVALID' })
})

test('explicit empty values reuse the prefix while zero, false and empty arrays still invalidate it', () => {
  const measured = measuredSummarizer()
  const types = ['short_text', 'short_text', 'short_text', 'number', 'boolean', 'multi_select', 'single_select']
  const input = {
    definitions: types.map((type, i) => ({ fieldKey: `e${i}`, name: `Empty ${i}`, sequence: i,
      type, required: false, constraints: type.endsWith('_select') ? { options: ['A'] } : {} })),
    values: [null, undefined, '', 0, false, [], null].map((value, i) => ({ fieldKey: `e${i}`, value })),
    selections: types.map((_, i) => ({ fieldKey: `e${i}`, id: `field-${i + 1}` }))
  }
  const before = structuredClone(input)
  assert.deepEqual(measured.summarize(input), ['未填写', '未填写', '未填写', '0', '否', '未填写', '未填写']
    .map((value, i) => ({ id: `field-${i + 1}`, label: `Empty ${i}`, value })))
  assert.equal(measured.count(), 4)
  assert.deepEqual(input, before)
})

test('empty submissions still reject malformed conditional definitions', () => {
  const broken = definitions()
  broken.at(-1).condition.parentFieldKey = 'missing'
  assert.throws(() => summarizeNodeFields({ definitions: broken, values: [], selections: [] }),
    { name: 'Error', code: 'INVALID_FIELD_VALUE', message: 'INVALID_FIELD_VALUE' })
})

test('legacy multi-level conditions preserve narrowed options and hidden stale descendants', () => {
  const definitions = [
    { fieldKey: 'root', name: 'Root', sequence: 0, type: 'single_select', required: false,
      constraints: { options: ['On', 'Off'] } },
    { fieldKey: 'model', name: 'Model', sequence: 1, type: 'single_select', required: false,
      constraints: { options: ['A', 'B'] }, condition: { parentFieldKey: 'root',
        visibleWhen: ['On'], optionsByParentValue: { On: ['A'] } } },
    { fieldKey: 'note', name: 'Note', sequence: 2, type: 'short_text', required: false,
      constraints: {}, condition: { parentFieldKey: 'model', visibleWhen: ['A'] } }
  ]
  const selections = [{ fieldKey: 'note', id: 'field-1' }]
  assert.deepEqual(summarizeNodeFields({ definitions, selections,
    values: values({ root: 'On', model: 'A', note: 'Synthetic note' }) }),
  [{ id: 'field-1', label: 'Note', value: 'Synthetic note' }])
  assert.deepEqual(summarizeNodeFields({ definitions, selections,
    values: values({ root: 'Off', model: 'B', note: 'stale' }) }), [])
  assert.throws(() => summarizeNodeFields({ definitions, selections,
    values: values({ root: 'On', model: 'B', note: 'stale' }) }),
  { name: 'Error', code: 'CARD_SUMMARY_INVALID', message: 'CARD_SUMMARY_INVALID' })
})

test('does not cache values or template definitions across summaries', () => {
  const input = { definitions: definitions(), values: values({ f0: 'Chair', f1: 'ChairBrand', f2: 'Other', other: 'First' }),
    selections: [{ fieldKey: 'other', id: 'field-1' }] }
  assert.deepEqual(summarizeNodeFields(input), [{ id: 'field-1', label: 'Other model', value: 'First' }])
  input.values.find(item => item.fieldKey === 'other').value = 'Second'
  input.definitions.find(item => item.fieldKey === 'other').name = 'Changed label'
  assert.deepEqual(summarizeNodeFields(input), [{ id: 'field-1', label: 'Changed label', value: 'Second' }])
  input.values.find(item => item.fieldKey === 'f2').value = 'ChairModel'
  assert.deepEqual(summarizeNodeFields(input), [])
})
