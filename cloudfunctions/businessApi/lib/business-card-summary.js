const { normalizeFieldDefinition, FIELD_TYPES } = require('./field-domain')
const { normalizeConditionalFields, resolveConditionalFields } = require('./conditional-field-domain')

function invalidSummary() {
  const error = new Error('CARD_SUMMARY_INVALID')
  error.code = 'CARD_SUMMARY_INVALID'
  return error
}

function isStableId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

// Stored JSON is data, never executable behavior. Check descriptors before
// handing definitions to the existing domain helpers (which use object spread).
function copyOwnData(value, depth = 0, budget = { remaining: 20000, arrayLimit:1000 }) {
  if (depth > 16 || --budget.remaining < 0) throw invalidSummary()
  if (value === null || value === undefined || ['string', 'boolean', 'number'].includes(typeof value)) return value
  if (typeof value !== 'object') throw invalidSummary()
  const array = Array.isArray(value)
  if (array ? Object.getPrototypeOf(value) !== Array.prototype :
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidSummary()
  if (array && (value.length > budget.arrayLimit || Reflect.ownKeys(value).length !== value.length + 1)) throw invalidSummary()
  const result = array ? [] : {}
  const keys = array ? Array.from({ length: value.length }, (_, i) => String(i)) : Reflect.ownKeys(value)
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw invalidSummary()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalidSummary()
    result[key] = copyOwnData(descriptor.value, depth + 1, budget)
  }
  return result
}

function clipText(value) {
  const text = value.replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim()
  const points = Array.from(text)
  return points.length > 80 ? points.slice(0, 79).join('') + '…' : text
}

function formatNormalizedValue(definition, value) {
  if (!FIELD_TYPES.includes(definition.type)) throw invalidSummary()
  if (value === undefined || value === null) return '未填写'
  let text
  switch (definition.type) {
    case 'short_text':
    case 'long_text':
      if (typeof value !== 'string') throw invalidSummary()
      text = value
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidSummary()
      text = String(value)
      break
    case 'boolean':
      if (typeof value !== 'boolean') throw invalidSummary()
      text = value ? '是' : '否'
      break
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidSummary()
      const parsed = new Date(value + 'T00:00:00.000Z')
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalidSummary()
      text = value
      break
    }
    case 'single_select':
      if (typeof value !== 'string' || !definition.constraints.options.includes(value)) throw invalidSummary()
      text = value
      break
    case 'multi_select':
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' ||
          !definition.constraints.options.includes(item)) || new Set(value).size !== value.length) throw invalidSummary()
      if (!value.length) return '未填写'
      text = value.join('、')
      break
  }
  return clipText(text) || '未填写'
}

function formatCardValue(definition, value) {
  return formatNormalizedValue(normalizeFieldDefinition(copyOwnData(definition, 0,
    { remaining:100000, arrayLimit:5000 })), copyOwnData(value))
}

function summarizeNodeFields({ definitions, values, selections, fallbackDefinitions = [] }) {
  const normalized = normalizeConditionalFields(copyOwnData(definitions, 0,
    { remaining:100000, arrayLimit:5000 }).map(normalizeFieldDefinition))
  const byKey = new Map(normalized.map(field => [field.fieldKey, field]))
  const submitted = new Map()
  for (const item of copyOwnData(values)) {
    if (!item || !isStableId(item.fieldKey) || !Object.hasOwn(item, 'value') ||
        !byKey.has(item.fieldKey) || submitted.has(item.fieldKey)) throw invalidSummary()
    submitted.set(item.fieldKey, item.value)
  }
  // The resolver rejects hidden submitted fields. Build its input in dependency
  // order so stale hidden children are suppressed, while invalid VISIBLE values
  // still fail closed (clearInvalidConditionalValues would silently drop them).
  const current = []
  for (const field of normalized) {
    const visible = resolveConditionalFields(normalized, current).visibleDefinitions
      .find(candidate => candidate.fieldKey === field.fieldKey)
    if (!visible || !submitted.has(field.fieldKey)) continue
    const value = submitted.get(field.fieldKey)
    formatNormalizedValue(visible, value)
    if (value !== undefined && value !== null && value !== '') current.push({ fieldKey: field.fieldKey, value })
  }
  const resolved = resolveConditionalFields(normalized, current)
  const visible = new Map(resolved.visibleDefinitions.map(field => [field.fieldKey, field]))
  const fallback = new Map(copyOwnData(fallbackDefinitions, 0, { remaining:100000, arrayLimit:5000 }).map(field => {
    const normalizedField = normalizeFieldDefinition(field)
    return [normalizedField.fieldKey, normalizedField]
  }))
  const result = []
  for (const selection of selections) {
    const field = byKey.get(selection.fieldKey)
    if (field && !visible.has(field.fieldKey)) continue
    const definition = field ? visible.get(field.fieldKey) : fallback.get(selection.fieldKey)
    if (!definition) throw invalidSummary()
    result.push({ id: selection.id, label: clipText(definition.name),
      value: field ? formatNormalizedValue(definition, resolved.valuesByKey.get(field.fieldKey)) : '历史无此字段' })
  }
  return result
}

module.exports = { formatCardValue, summarizeNodeFields, copyOwnData, isStableId, invalidSummary }
