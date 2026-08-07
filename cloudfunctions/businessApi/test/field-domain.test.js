const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeFieldDefinition,
  validateFieldValues,
  MAX_REGEX_LENGTH
} = require('../lib/field-domain')

function assertInvalid(operation) {
  assert.throws(operation, error => error.code === 'INVALID_FIELD_VALUE')
}

test('validates and snapshots typed field values in definition order', () => {
  const definitions = [
    { fieldKey: 'f-text', sequence: 0, name: '说明', type: 'short_text', required: true, constraints: { minLength: 2, maxLength: 20 } },
    { fieldKey: 'f-count', sequence: 1, name: '数量', type: 'number', required: true, constraints: { min: 0, max: 10, decimalPlaces: 0 } }
  ]

  assert.deepEqual(validateFieldValues(definitions, [
    { fieldKey: 'f-count', value: 3 },
    { fieldKey: 'f-text', value: '完成' }
  ]), [
    { fieldKey: 'f-text', name: '说明', type: 'short_text', value: '完成' },
    { fieldKey: 'f-count', name: '数量', type: 'number', value: 3 }
  ])
})

test('normalizes valid definitions for every supported field type', () => {
  const definitions = [
    { fieldKey: 'short', type: 'short_text', name: '短文本', constraints: { minLength: 1, maxLength: 4, pattern: '^[A-Z]+$' } },
    { fieldKey: 'long', type: 'long_text', name: '长文本' },
    { fieldKey: 'number', type: 'number', name: '数字', constraints: { min: -1.5, max: 2.5, decimalPlaces: 1 } },
    { fieldKey: 'boolean', type: 'boolean', name: '布尔' },
    { fieldKey: 'date', type: 'date', name: '日期' },
    { fieldKey: 'single', type: 'single_select', name: '单选', constraints: { options: ['甲', '乙'] } },
    { fieldKey: 'multi', type: 'multi_select', name: '多选', constraints: { options: ['甲', '乙'] } }
  ]

  assert.deepEqual(definitions.map(normalizeFieldDefinition), [
    { fieldKey: 'short', sequence: 0, name: '短文本', description: '', type: 'short_text', required: false, constraints: { minLength: 1, maxLength: 4, pattern: '^[A-Z]+$' } },
    { fieldKey: 'long', sequence: 0, name: '长文本', description: '', type: 'long_text', required: false, constraints: {} },
    { fieldKey: 'number', sequence: 0, name: '数字', description: '', type: 'number', required: false, constraints: { min: -1.5, max: 2.5, decimalPlaces: 1 } },
    { fieldKey: 'boolean', sequence: 0, name: '布尔', description: '', type: 'boolean', required: false, constraints: {} },
    { fieldKey: 'date', sequence: 0, name: '日期', description: '', type: 'date', required: false, constraints: {} },
    { fieldKey: 'single', sequence: 0, name: '单选', description: '', type: 'single_select', required: false, constraints: { options: ['甲', '乙'] } },
    { fieldKey: 'multi', sequence: 0, name: '多选', description: '', type: 'multi_select', required: false, constraints: { options: ['甲', '乙'] } }
  ])
})

test('rejects malformed definitions before they can be persisted', () => {
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: '', name: '名称', type: 'short_text' }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '', type: 'short_text' }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'unsupported' }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'boolean', required: 'true' }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'short_text', constraints: { minLength: 3, maxLength: 2 } }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'short_text', constraints: { pattern: '[' } }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'short_text', constraints: { pattern: 'x'.repeat(MAX_REGEX_LENGTH + 1) } }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'number', constraints: { min: 2, max: 1 } }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'number', constraints: { decimalPlaces: -1 } }))
  assertInvalid(() => normalizeFieldDefinition({ fieldKey: 'f', name: '名称', type: 'single_select', constraints: { options: ['甲', '甲'] } }))
})

test('enforces all type-specific values and required values', () => {
  const definitions = [
    { fieldKey: 'short', sequence: 0, name: '短文本', type: 'short_text', required: true, constraints: { minLength: 2, maxLength: 3, pattern: '^[A-Z]+$' } },
    { fieldKey: 'long', sequence: 1, name: '长文本', type: 'long_text', required: true },
    { fieldKey: 'number', sequence: 2, name: '数字', type: 'number', required: true, constraints: { min: 0, max: 2, decimalPlaces: 1 } },
    { fieldKey: 'boolean', sequence: 3, name: '布尔', type: 'boolean', required: true },
    { fieldKey: 'date', sequence: 4, name: '日期', type: 'date', required: true },
    { fieldKey: 'single', sequence: 5, name: '单选', type: 'single_select', required: true, constraints: { options: ['甲', '乙'] } },
    { fieldKey: 'multi', sequence: 6, name: '多选', type: 'multi_select', required: true, constraints: { options: ['甲', '乙'] } }
  ]
  const validValues = [
    { fieldKey: 'short', value: 'AB' }, { fieldKey: 'long', value: '详细说明' },
    { fieldKey: 'number', value: 1.2 }, { fieldKey: 'boolean', value: false },
    { fieldKey: 'date', value: '2026-08-07' }, { fieldKey: 'single', value: '甲' },
    { fieldKey: 'multi', value: ['甲', '乙'] }
  ]

  assert.equal(validateFieldValues(definitions, validValues).length, 7)
  assertInvalid(() => validateFieldValues(definitions, validValues.filter(item => item.fieldKey !== 'boolean')))
  assertInvalid(() => validateFieldValues(definitions, validValues.map(item => item.fieldKey === 'short' ? { ...item, value: 'A1' } : item)))
  assertInvalid(() => validateFieldValues(definitions, validValues.map(item => item.fieldKey === 'long' ? { ...item, value: '' } : item)))
  assertInvalid(() => validateFieldValues(definitions, validValues.map(item => item.fieldKey === 'number' ? { ...item, value: 1.25 } : item)))
  assertInvalid(() => validateFieldValues(definitions, validValues.map(item => item.fieldKey === 'boolean' ? { ...item, value: 'false' } : item)))
  assertInvalid(() => validateFieldValues(definitions, validValues.map(item => item.fieldKey === 'date' ? { ...item, value: '2026-02-29' } : item)))
  assertInvalid(() => validateFieldValues(definitions, validValues.map(item => item.fieldKey === 'single' ? { ...item, value: '丙' } : item)))
  assertInvalid(() => validateFieldValues(definitions, validValues.map(item => item.fieldKey === 'multi' ? { ...item, value: ['甲', '甲'] } : item)))
})

test('rejects unknown and duplicate submitted field keys', () => {
  const definitions = [{ fieldKey: 'f', sequence: 0, name: '字段', type: 'short_text', required: false }]

  assertInvalid(() => validateFieldValues(definitions, [{ fieldKey: 'unknown', value: 'x' }]))
  assertInvalid(() => validateFieldValues(definitions, [{ fieldKey: 'f', value: 'x' }, { fieldKey: 'f', value: 'y' }]))
})
