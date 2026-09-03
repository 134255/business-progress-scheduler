function emptyValueFor(field) {
  if (field.type === 'multi_select') return []
  if (field.type === 'short_text' || field.type === 'long_text') return ''
  return null
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '' &&
    (!Array.isArray(value) || value.length > 0)
}

function deriveConditionalForm(fields, sourceValues) {
  const definitions = Array.isArray(fields)
    ? fields.slice().sort((left, right) => left.sequence - right.sequence)
    : []
  const original = sourceValues && typeof sourceValues === 'object' ? sourceValues : {}
  const fieldValues = { ...original }
  const visibleKeys = new Set()
  const visibleFields = []
  const clearedFieldKeys = []

  const clear = field => {
    const current = fieldValues[field.fieldKey]
    if (hasValue(current)) clearedFieldKeys.push(field.fieldKey)
    fieldValues[field.fieldKey] = emptyValueFor(field)
  }

  for (const field of definitions) {
    const condition = field.condition
    const parentVisible = !condition || visibleKeys.has(condition.parentFieldKey)
    const parentValue = condition ? fieldValues[condition.parentFieldKey] : undefined
    const visible = !condition || parentVisible && Array.isArray(condition.visibleWhen) &&
      condition.visibleWhen.includes(parentValue)
    if (!visible) {
      clear(field)
      continue
    }

    visibleKeys.add(field.fieldKey)
    let constraints = { ...(field.constraints || {}) }
    if (condition && condition.optionsByParentValue &&
        Array.isArray(condition.optionsByParentValue[parentValue])) {
      constraints.options = condition.optionsByParentValue[parentValue].slice()
    }
    const options = Array.isArray(constraints.options) ? constraints.options : []
    const value = fieldValues[field.fieldKey]
    if (field.type === 'single_select' && hasValue(value) && !options.includes(value) ||
        field.type === 'multi_select' && hasValue(value) &&
          (!Array.isArray(value) || value.some(item => !options.includes(item)))) {
      clear(field)
    }
    const selected = Array.isArray(fieldValues[field.fieldKey]) ? fieldValues[field.fieldKey] : []
    visibleFields.push({
      ...field,
      constraints,
      optionItems: options.map(option => ({ value: option, selected: selected.includes(option) }))
    })
  }
  return { visibleFields, fieldValues, clearedFieldKeys }
}

function nonemptyVisibleValues(visibleFields, fieldValues) {
  return visibleFields
    .filter(field => hasValue(fieldValues[field.fieldKey]))
    .map(field => ({ fieldKey: field.fieldKey, value: fieldValues[field.fieldKey] }))
}

module.exports = { deriveConditionalForm, nonemptyVisibleValues }
