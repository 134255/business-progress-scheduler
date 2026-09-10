const test = require('node:test')
const assert = require('node:assert/strict')
const { formatCardValue, summarizeNodeFields } = require('../lib/business-card-summary')

const field = (fieldKey, type, extra = {}) => ({
  fieldKey, name: fieldKey, sequence: 0, type, required: false, constraints: {}, ...extra
})

for (const [type, value, want, constraints] of [
  ['short_text', '短文', '短文'], ['long_text', '长文\n内容', '长文 内容'],
  ['number', 0, '0'], ['boolean', false, '否'], ['boolean', true, '是'],
  ['date', '2024-02-29', '2024-02-29'],
  ['single_select', '甲', '甲', { options: ['甲', '乙'] }],
  ['multi_select', ['乙', '甲'], '乙、甲', { options: ['甲', '乙'] }]
]) test(`formats ${type} ${JSON.stringify(value)} without losing falsy values`, () => {
  assert.equal(formatCardValue(field('f', type, { constraints: constraints || {} }), value), want)
})

test('clips at 80 Unicode codepoints including the ellipsis', () => {
  assert.equal(formatCardValue(field('f', 'long_text'), '😀'.repeat(81)), '😀'.repeat(79) + '…')
  assert.equal(formatCardValue(field('f', 'long_text'), '😀'.repeat(80)), '😀'.repeat(80))
})

for (const [type, value, constraints] of [
  ['number', '0'], ['number', Infinity], ['boolean', 'false'], ['date', '2023-02-29'],
  ['date', '2024-2-29'], ['single_select', '丙', { options: ['甲'] }],
  ['multi_select', ['甲', '甲'], { options: ['甲'] }], ['unknown', 'text'],
  ['short_text', { text: 'must not stringify' }]
]) test(`rejects malformed ${type} values`, () => {
  assert.throws(() => formatCardValue(field('f', type, { constraints: constraints || {} }), value))
})

test('distinguishes legitimate empty from absent historical definitions', () => {
  assert.deepEqual(summarizeNodeFields({
    definitions: [field('a', 'number')], values: [],
    selections: [{ fieldKey: 'a', id: 'field-1' }, { fieldKey: 'b', id: 'field-2' }],
    fallbackDefinitions: [field('b', 'short_text', { name: '新增' })]
  }), [
    { id: 'field-1', label: 'a', value: '未填写' },
    { id: 'field-2', label: '新增', value: '历史无此字段' }
  ])
})

test('uses instance labels/types and exact keys, not same-name matching', () => {
  assert.deepEqual(summarizeNodeFields({
    definitions: [field('a', 'number', { name: '同名' }), field('b', 'boolean', { name: '同名', sequence: 1 })],
    values: [{ fieldKey: 'a', name: '旧包装名', type: 'number', value: 0 },
      { fieldKey: 'b', name: '同名', type: 'boolean', value: false }],
    selections: [{ fieldKey: 'b', id: 'field-1' }, { fieldKey: 'a', id: 'field-2' }]
  }), [{ id: 'field-1', label: '同名', value: '否' }, { id: 'field-2', label: '同名', value: '0' }])
})

test('resolves complete current snapshot with unselected parent; never reveals hidden stale children', () => {
  const definitions = [field('parent', 'single_select', { constraints: { options: ['开', '关'] } }),
    field('child', 'short_text', { sequence: 1, condition: { parentFieldKey: 'parent', visibleWhen: ['开'] } })]
  const values = value => [{ fieldKey: 'parent', value }, { fieldKey: 'child', value: '合成内容' }]
  const selections = [{ fieldKey: 'child', id: 'field-1' }]
  assert.deepEqual(summarizeNodeFields({ definitions, values: values('关'), selections }), [])
  assert.deepEqual(summarizeNodeFields({ definitions, values: values('开'), selections }),
    [{ id: 'field-1', label: 'child', value: '合成内容' }])
  assert.throws(() => summarizeNodeFields({ definitions, values: values('坏选项'), selections }))
})

test('never invokes accessors, inherited values or arbitrary conversion methods', () => {
  let calls = 0
  const unsafe = { fieldKey: 'a', get value() { calls++; return 'leak' } }
  assert.throws(() => summarizeNodeFields({ definitions: [field('a', 'short_text')],
    values: [unsafe], selections: [] }))
  const definition = field('a', 'short_text')
  Object.defineProperty(definition, 'name', { get() { calls++; return 'leak' } })
  assert.throws(() => formatCardValue(definition, 'x'))
  assert.throws(() => formatCardValue(field('a', 'short_text'), { toString() { calls++; return 'leak' } }))
  assert.equal(calls, 0)
})

for (const type of ['number', 'boolean', 'date', 'single_select']) test(`empty-string ${type} is not a valid stored value`, () => {
  assert.throws(() => formatCardValue(field('f', type, { constraints: type === 'single_select' ? { options: ['甲'] } : {} }), ''))
})

test('removes non-printing controls from public text', () => {
  assert.equal(formatCardValue(field('f', 'short_text'), '甲\u0000乙\u007f'), '甲 乙')
})
