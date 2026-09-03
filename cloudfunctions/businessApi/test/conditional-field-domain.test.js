const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeConditionalFields,
  resolveConditionalFields,
  clearInvalidConditionalValues,
  conditionalFieldDigestProjection
} = require('../lib/conditional-field-domain')

function field(fieldKey, sequence, type, options, condition) {
  return {
    fieldKey,
    sequence,
    name: fieldKey,
    description: '',
    type,
    required: true,
    constraints: options ? { options } : {},
    ...(condition ? { condition } : {})
  }
}

function assertInvalid(operation) {
  assert.throws(operation, error => error && error.code === 'INVALID_FIELD_VALUE')
}

test('normalizes nested conditional fields and per-parent single-select options', () => {
  const normalized = normalizeConditionalFields([
    field('category', 0, 'single_select', ['换货', '维修']),
    field('reason', 1, 'single_select', ['破损', '错发', '故障'], {
      parentFieldKey: 'category',
      visibleWhen: ['换货', '维修'],
      optionsByParentValue: { 换货: ['破损', '错发'], 维修: ['故障'] }
    }),
    field('detail', 2, 'short_text', null, {
      parentFieldKey: 'reason',
      visibleWhen: ['故障']
    })
  ])

  assert.deepEqual(normalized[1].condition, {
    parentFieldKey: 'category',
    visibleWhen: ['换货', '维修'],
    optionsByParentValue: { 换货: ['破损', '错发'], 维修: ['故障'] }
  })
  assert.deepEqual(normalized[2].condition, {
    parentFieldKey: 'reason',
    visibleWhen: ['故障']
  })
})

test('rejects invalid parents, forward references and unsafe conditional structures', () => {
  const parent = field('category', 0, 'single_select', ['换货', '维修'])
  assertInvalid(() => normalizeConditionalFields([
    field('detail', 0, 'short_text', null, { parentFieldKey: 'later', visibleWhen: ['是'] }),
    field('later', 1, 'single_select', ['是'])
  ]))
  assertInvalid(() => normalizeConditionalFields([
    field('plain', 0, 'short_text'),
    field('detail', 1, 'short_text', null, { parentFieldKey: 'plain', visibleWhen: ['是'] })
  ]))
  assertInvalid(() => normalizeConditionalFields([
    parent,
    field('detail', 1, 'short_text', null, { parentFieldKey: 'category', visibleWhen: ['不存在'] })
  ]))
  assertInvalid(() => normalizeConditionalFields([
    parent,
    field('reason', 1, 'single_select', ['破损'], {
      parentFieldKey: 'category', visibleWhen: ['换货'], optionsByParentValue: { 维修: ['破损'] }
    })
  ]))
  const sparse = [parent, field('detail', 1, 'short_text')]
  delete sparse[1]
  assertInvalid(() => normalizeConditionalFields(sparse))
  const accessor = { parentFieldKey: 'category', visibleWhen: ['换货'] }
  Object.defineProperty(accessor, 'parentFieldKey', { get() { throw new Error('must not run') }, enumerable: true })
  assertInvalid(() => normalizeConditionalFields([parent, field('detail', 1, 'short_text', null, accessor)]))
})

test('resolves only visible fields and applies the current parent option set', () => {
  const fields = [
    field('category', 0, 'single_select', ['换货', '维修']),
    field('reason', 1, 'single_select', ['破损', '错发', '故障'], {
      parentFieldKey: 'category',
      visibleWhen: ['换货', '维修'],
      optionsByParentValue: { 换货: ['破损', '错发'], 维修: ['故障'] }
    }),
    field('detail', 2, 'short_text', null, { parentFieldKey: 'reason', visibleWhen: ['故障'] })
  ]
  const result = resolveConditionalFields(fields, [
    { fieldKey: 'category', value: '维修' },
    { fieldKey: 'reason', value: '故障' },
    { fieldKey: 'detail', value: '无法启动' }
  ])

  assert.deepEqual(result.visibleDefinitions.map(item => item.fieldKey), ['category', 'reason', 'detail'])
  assert.deepEqual(result.visibleDefinitions[1].constraints.options, ['故障'])
  assert.deepEqual(result.normalizedValues, [
    { fieldKey: 'category', value: '维修' },
    { fieldKey: 'reason', value: '故障' },
    { fieldKey: 'detail', value: '无法启动' }
  ])
})

test('rejects hidden field injection and options invalid for the selected parent', () => {
  const fields = [
    field('category', 0, 'single_select', ['换货', '维修']),
    field('reason', 1, 'single_select', ['破损', '故障'], {
      parentFieldKey: 'category',
      visibleWhen: ['换货', '维修'],
      optionsByParentValue: { 换货: ['破损'], 维修: ['故障'] }
    }),
    field('detail', 2, 'short_text', null, { parentFieldKey: 'reason', visibleWhen: ['故障'] })
  ]

  assertInvalid(() => resolveConditionalFields(fields, [
    { fieldKey: 'category', value: '换货' },
    { fieldKey: 'reason', value: '破损' },
    { fieldKey: 'detail', value: 'hidden injection' }
  ]))
  assertInvalid(() => resolveConditionalFields(fields, [
    { fieldKey: 'category', value: '换货' },
    { fieldKey: 'reason', value: '故障' }
  ]))
})

test('clears hidden descendants and invalid dependent selections without mutating evidence-adjacent state', () => {
  const fields = [
    field('category', 0, 'single_select', ['换货', '维修']),
    field('reason', 1, 'single_select', ['破损', '故障'], {
      parentFieldKey: 'category',
      visibleWhen: ['换货', '维修'],
      optionsByParentValue: { 换货: ['破损'], 维修: ['故障'] }
    }),
    field('detail', 2, 'short_text', null, { parentFieldKey: 'reason', visibleWhen: ['故障'] })
  ]
  const submitted = [
    { fieldKey: 'category', value: '换货' },
    { fieldKey: 'reason', value: '故障' },
    { fieldKey: 'detail', value: '旧分支说明' }
  ]

  assert.deepEqual(clearInvalidConditionalValues(fields, submitted), {
    values: [{ fieldKey: 'category', value: '换货' }],
    clearedFieldKeys: ['reason', 'detail']
  })
  assert.equal(submitted.length, 3)
})

test('digest projection is canonical and excludes presentation-only text', () => {
  const projection = conditionalFieldDigestProjection([
    field('category', 0, 'single_select', ['换货', '维修']),
    field('reason', 1, 'single_select', ['破损'], {
      parentFieldKey: 'category', visibleWhen: ['换货'], optionsByParentValue: { 换货: ['破损'] }
    })
  ])
  assert.deepEqual(projection, [
    { fieldKey: 'category', sequence: 0, type: 'single_select', required: true, constraints: { options: ['换货', '维修'] } },
    { fieldKey: 'reason', sequence: 1, type: 'single_select', required: true, constraints: { options: ['破损'] }, condition: { parentFieldKey: 'category', visibleWhen: ['换货'], optionsByParentValue: { 换货: ['破损'] } } }
  ])
})
