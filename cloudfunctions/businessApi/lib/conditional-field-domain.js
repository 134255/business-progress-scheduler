const CONDITION_KEYS = new Set(['parentFieldKey', 'visibleWhen', 'optionsByParentValue'])

function createError() {
  const error = new Error('INVALID_FIELD_VALUE')
  error.code = 'INVALID_FIELD_VALUE'
  return error
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isPlainOwnObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownDataObject(value, allowedKeys = null) {
  if (!isPlainOwnObject(value)) throw createError()
  const result = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw createError()
    }
    if (allowedKeys && !allowedKeys.has(key)) throw createError()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !hasOwn(descriptor, 'value')) throw createError()
    result[key] = descriptor.value
  }
  return result
}

function ownArrayValues(value) {
  if (!Array.isArray(value)) throw createError()
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !hasOwn(descriptor, 'value')) throw createError()
    result.push(descriptor.value)
  }
  return result
}

function nonemptyText(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError()
  return value.trim()
}

function uniqueTextArray(value) {
  const normalized = ownArrayValues(value).map(nonemptyText)
  if (!normalized.length || new Set(normalized).size !== normalized.length) throw createError()
  return normalized
}

function normalizeConditionInput(value) {
  const input = ownDataObject(value, CONDITION_KEYS)
  if (!hasOwn(input, 'parentFieldKey') || !hasOwn(input, 'visibleWhen')) throw createError()
  const condition = {
    parentFieldKey: nonemptyText(input.parentFieldKey),
    visibleWhen: uniqueTextArray(input.visibleWhen)
  }
  if (hasOwn(input, 'optionsByParentValue')) {
    const source = ownDataObject(input.optionsByParentValue)
    const optionsByParentValue = {}
    for (const key of Object.keys(source).sort()) optionsByParentValue[nonemptyText(key)] = uniqueTextArray(source[key])
    condition.optionsByParentValue = optionsByParentValue
  }
  return condition
}

function cloneDefinition(field) {
  const result = { ...field, constraints: { ...(field.constraints || {}) } }
  if (field.condition !== undefined) result.condition = normalizeConditionInput(field.condition)
  return result
}

function normalizeConditionalFields(fields) {
  const values = ownArrayValues(fields).map(value => {
    if (!isPlainOwnObject(value)) throw createError()
    return cloneDefinition(value)
  })
  const ordered = values.slice().sort((left, right) => left.sequence - right.sequence)
  if (new Set(ordered.map(field => field.fieldKey)).size !== ordered.length) throw createError()
  const byKey = new Map()
  for (const field of ordered) {
    if (typeof field.fieldKey !== 'string' || !field.fieldKey || !Number.isSafeInteger(field.sequence) || field.sequence < 0) {
      throw createError()
    }
    if (field.condition) {
      const parent = byKey.get(field.condition.parentFieldKey)
      const parentOptions = parent && parent.type === 'single_select' && parent.constraints && parent.constraints.options
      if (!parent || !Array.isArray(parentOptions)) throw createError()
      if (field.condition.visibleWhen.some(option => !parentOptions.includes(option))) throw createError()
      if (field.condition.optionsByParentValue) {
        if (field.type !== 'single_select' || !field.constraints || !Array.isArray(field.constraints.options)) throw createError()
        const keys = Object.keys(field.condition.optionsByParentValue)
        if (keys.length !== field.condition.visibleWhen.length ||
            keys.some(key => !field.condition.visibleWhen.includes(key)) ||
            Object.values(field.condition.optionsByParentValue).some(options =>
              options.some(option => !field.constraints.options.includes(option)))) throw createError()
      }
    }
    byKey.set(field.fieldKey, field)
  }
  return ordered
}

function indexSubmitted(submitted) {
  const values = new Map()
  for (const raw of ownArrayValues(submitted)) {
    const item = ownDataObject(raw, new Set(['fieldKey', 'value']))
    if (!hasOwn(item, 'fieldKey') || !hasOwn(item, 'value')) throw createError()
    const fieldKey = nonemptyText(item.fieldKey)
    if (values.has(fieldKey)) throw createError()
    values.set(fieldKey, item.value)
  }
  return values
}

function visibleDefinition(field, valuesByKey, visibleKeys) {
  if (!field.condition) return cloneDefinition(field)
  if (!visibleKeys.has(field.condition.parentFieldKey)) return null
  const parentValue = valuesByKey.get(field.condition.parentFieldKey)
  if (!field.condition.visibleWhen.includes(parentValue)) return null
  const result = cloneDefinition(field)
  if (field.condition.optionsByParentValue) {
    result.constraints.options = field.condition.optionsByParentValue[parentValue].slice()
  }
  return result
}

function resolveConditionalFields(fields, submitted) {
  const normalizedFields = normalizeConditionalFields(fields)
  const valuesByKey = indexSubmitted(submitted)
  const knownKeys = new Set(normalizedFields.map(field => field.fieldKey))
  for (const fieldKey of valuesByKey.keys()) if (!knownKeys.has(fieldKey)) throw createError()

  const visibleKeys = new Set()
  const visibleDefinitions = []
  for (const field of normalizedFields) {
    const visible = visibleDefinition(field, valuesByKey, visibleKeys)
    if (!visible) continue
    visibleKeys.add(field.fieldKey)
    if (visible.type === 'single_select' && valuesByKey.has(field.fieldKey) &&
        !visible.constraints.options.includes(valuesByKey.get(field.fieldKey))) throw createError()
    visibleDefinitions.push(visible)
  }
  for (const fieldKey of valuesByKey.keys()) if (!visibleKeys.has(fieldKey)) throw createError()
  return {
    visibleDefinitions,
    valuesByKey,
    normalizedValues: visibleDefinitions
      .filter(field => valuesByKey.has(field.fieldKey))
      .map(field => ({ fieldKey: field.fieldKey, value: valuesByKey.get(field.fieldKey) }))
  }
}

function clearInvalidConditionalValues(fields, submitted) {
  const normalizedFields = normalizeConditionalFields(fields)
  const valuesByKey = indexSubmitted(submitted)
  const originalKeys = [...valuesByKey.keys()]
  const visibleKeys = new Set()
  for (const field of normalizedFields) {
    const visible = visibleDefinition(field, valuesByKey, visibleKeys)
    if (!visible) {
      valuesByKey.delete(field.fieldKey)
      continue
    }
    visibleKeys.add(field.fieldKey)
    if (visible.type === 'single_select' && valuesByKey.has(field.fieldKey) &&
        !visible.constraints.options.includes(valuesByKey.get(field.fieldKey))) {
      valuesByKey.delete(field.fieldKey)
    }
  }
  const values = normalizedFields
    .filter(field => valuesByKey.has(field.fieldKey))
    .map(field => ({ fieldKey: field.fieldKey, value: valuesByKey.get(field.fieldKey) }))
  const kept = new Set(values.map(item => item.fieldKey))
  return { values, clearedFieldKeys: originalKeys.filter(key => !kept.has(key)) }
}

function conditionalFieldDigestProjection(fields) {
  return normalizeConditionalFields(fields).map(field => ({
    fieldKey: field.fieldKey,
    sequence: field.sequence,
    type: field.type,
    required: field.required,
    constraints: { ...field.constraints },
    ...(field.condition ? { condition: normalizeConditionInput(field.condition) } : {})
  }))
}

module.exports = {
  normalizeConditionInput,
  normalizeConditionalFields,
  resolveConditionalFields,
  clearInvalidConditionalValues,
  conditionalFieldDigestProjection
}
