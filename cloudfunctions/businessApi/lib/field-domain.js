const FIELD_TYPES = Object.freeze([
  'short_text', 'long_text', 'number', 'boolean',
  'date', 'single_select', 'multi_select'
])
const MAX_REGEX_LENGTH = 256
const {
  normalizeConditionInput,
  normalizeConditionalFields,
  resolveConditionalFields
} = require('./conditional-field-domain')

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError('INVALID_FIELD_VALUE')
  return value.trim()
}

function normalizeNonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw createError('INVALID_FIELD_VALUE')
  return value
}

function readCharacterClass(pattern, start) {
  let index = start + 1
  if (index === pattern.length) return -1
  while (index < pattern.length) {
    if (pattern[index] === '\\') {
      index += 2
      continue
    }
    if (pattern[index] === '[') return -1
    if (pattern[index] === ']') return index + 1
    index += 1
  }
  return -1
}

function readQuantifier(pattern, start) {
  if ('*+?'.includes(pattern[start])) return start + 1
  if (pattern[start] !== '{') return start
  const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(pattern.slice(start))
  if (!match) return -1
  if (match[2] && Number(match[2]) < Number(match[1])) return -1
  return start + match[0].length
}

// The supported regex subset is deliberately small: literal and character-class
// atoms, optional anchors, and at most one final simple quantifier. It excludes
// grouping, alternation, backreferences, and overlapping repetitions so a stored
// pattern cannot trigger catastrophic backtracking during feedback validation.
function isSafeRegularExpression(pattern) {
  let start = pattern.startsWith('^') ? 1 : 0
  const end = pattern.endsWith('$') ? pattern.length - 1 : pattern.length
  if (start > end) return false
  let quantified = false
  while (start < end) {
    let next
    const character = pattern[start]
    if (character === '[') {
      next = readCharacterClass(pattern, start)
    } else if (character === '\\') {
      if (start + 1 >= end || /\d/.test(pattern[start + 1])) return false
      next = start + 2
    } else if ('^$()[]{}|*+?.'.includes(character)) {
      return false
    } else {
      next = start + 1
    }
    if (next < 0 || next > end) return false
    const quantifierEnd = readQuantifier(pattern, next)
    if (quantifierEnd < 0) return false
    if (quantifierEnd !== next) {
      if (quantified || quantifierEnd !== end) return false
      quantified = true
      next = quantifierEnd
    }
    start = next
  }
  return true
}

function normalizeConstraints(type, input) {
  if (!isPlainObject(input)) throw createError('INVALID_FIELD_VALUE')
  const constraints = {}
  const allowed = type === 'short_text' || type === 'long_text'
    ? ['minLength', 'maxLength', 'pattern']
    : type === 'number'
      ? ['min', 'max', 'decimalPlaces']
      : type === 'single_select' || type === 'multi_select'
        ? ['options']
        : []

  if (Object.keys(input).some(key => !allowed.includes(key))) throw createError('INVALID_FIELD_VALUE')

  if (hasOwn(input, 'minLength')) constraints.minLength = normalizeNonnegativeInteger(input.minLength)
  if (hasOwn(input, 'maxLength')) constraints.maxLength = normalizeNonnegativeInteger(input.maxLength)
  if (hasOwn(constraints, 'minLength') && hasOwn(constraints, 'maxLength') && constraints.minLength > constraints.maxLength) {
    throw createError('INVALID_FIELD_VALUE')
  }
  if (hasOwn(input, 'pattern')) {
    if (typeof input.pattern !== 'string' || input.pattern.length > MAX_REGEX_LENGTH) throw createError('INVALID_FIELD_VALUE')
    if (!isSafeRegularExpression(input.pattern)) throw createError('INVALID_FIELD_VALUE')
    try {
      new RegExp(input.pattern)
    } catch (error) {
      throw createError('INVALID_FIELD_VALUE')
    }
    constraints.pattern = input.pattern
  }

  if (hasOwn(input, 'min')) {
    if (!Number.isFinite(input.min)) throw createError('INVALID_FIELD_VALUE')
    constraints.min = input.min
  }
  if (hasOwn(input, 'max')) {
    if (!Number.isFinite(input.max)) throw createError('INVALID_FIELD_VALUE')
    constraints.max = input.max
  }
  if (hasOwn(constraints, 'min') && hasOwn(constraints, 'max') && constraints.min > constraints.max) {
    throw createError('INVALID_FIELD_VALUE')
  }
  if (hasOwn(input, 'decimalPlaces')) constraints.decimalPlaces = normalizeNonnegativeInteger(input.decimalPlaces)

  if (hasOwn(input, 'options')) {
    if (!Array.isArray(input.options) || !input.options.length) throw createError('INVALID_FIELD_VALUE')
    const options = input.options.map(requireText)
    if (new Set(options).size !== options.length) throw createError('INVALID_FIELD_VALUE')
    constraints.options = options
  }
  if ((type === 'single_select' || type === 'multi_select') && !hasOwn(constraints, 'options')) {
    throw createError('INVALID_FIELD_VALUE')
  }

  return constraints
}

function normalizeFieldDefinition(input) {
  if (!isPlainObject(input)) throw createError('INVALID_FIELD_VALUE')
  if (!FIELD_TYPES.includes(input.type)) throw createError('INVALID_FIELD_VALUE')
  const sequence = hasOwn(input, 'sequence') ? normalizeNonnegativeInteger(input.sequence) : 0
  const required = hasOwn(input, 'required') ? input.required : false
  if (typeof required !== 'boolean') throw createError('INVALID_FIELD_VALUE')

  return {
    fieldKey: requireText(input.fieldKey),
    sequence,
    name: requireText(input.name),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    type: input.type,
    required,
    constraints: normalizeConstraints(input.type, hasOwn(input, 'constraints') ? input.constraints : {}),
    ...(hasOwn(input, 'condition') ? { condition: normalizeConditionInput(input.condition) } : {})
  }
}

function bySequence(left, right) {
  return left.sequence - right.sequence
}

function isRequiredValueMissing(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function respectsDecimalPlaces(value, decimalPlaces) {
  if (decimalPlaces === undefined) return true
  const scaled = value * (10 ** decimalPlaces)
  return Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8
}

function validateOneValue(definition, value) {
  if (value === undefined || value === null) {
    if (definition.required) throw createError('INVALID_FIELD_VALUE')
    return null
  }
  if (definition.required && isRequiredValueMissing(value)) throw createError('INVALID_FIELD_VALUE')

  const { constraints } = definition
  if (definition.type === 'short_text' || definition.type === 'long_text') {
    if (typeof value !== 'string') throw createError('INVALID_FIELD_VALUE')
    if (constraints.minLength !== undefined && value.length < constraints.minLength) throw createError('INVALID_FIELD_VALUE')
    if (constraints.maxLength !== undefined && value.length > constraints.maxLength) throw createError('INVALID_FIELD_VALUE')
    if (constraints.pattern !== undefined && !(new RegExp(constraints.pattern)).test(value)) throw createError('INVALID_FIELD_VALUE')
    return value
  }
  if (definition.type === 'number') {
    if (!Number.isFinite(value)) throw createError('INVALID_FIELD_VALUE')
    if (constraints.min !== undefined && value < constraints.min) throw createError('INVALID_FIELD_VALUE')
    if (constraints.max !== undefined && value > constraints.max) throw createError('INVALID_FIELD_VALUE')
    if (!respectsDecimalPlaces(value, constraints.decimalPlaces)) throw createError('INVALID_FIELD_VALUE')
    return value
  }
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') throw createError('INVALID_FIELD_VALUE')
    return value
  }
  if (definition.type === 'date') {
    if (!isValidDate(value)) throw createError('INVALID_FIELD_VALUE')
    return value
  }
  if (definition.type === 'single_select') {
    if (typeof value !== 'string' || !constraints.options.includes(value)) throw createError('INVALID_FIELD_VALUE')
    return value
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !constraints.options.includes(item))) {
    throw createError('INVALID_FIELD_VALUE')
  }
  if (new Set(value).size !== value.length) throw createError('INVALID_FIELD_VALUE')
  return value.slice()
}

function indexSubmittedValues(submitted) {
  if (!Array.isArray(submitted)) throw createError('INVALID_FIELD_VALUE')
  const valuesByKey = new Map()
  for (const item of submitted) {
    if (!isPlainObject(item)) throw createError('INVALID_FIELD_VALUE')
    const fieldKey = requireText(item.fieldKey)
    if (valuesByKey.has(fieldKey)) throw createError('INVALID_FIELD_VALUE')
    valuesByKey.set(fieldKey, item.value)
  }
  return valuesByKey
}

function normalizeDefinitions(definitions) {
  if (!Array.isArray(definitions)) throw createError('INVALID_FIELD_VALUE')
  const normalized = normalizeConditionalFields(definitions.map(normalizeFieldDefinition))
  if (new Set(normalized.map(definition => definition.fieldKey)).size !== normalized.length) throw createError('INVALID_FIELD_VALUE')
  return normalized
}

function rejectUnknownKeys(definitions, valuesByKey) {
  const knownKeys = new Set(definitions.map(definition => definition.fieldKey))
  for (const fieldKey of valuesByKey.keys()) {
    if (!knownKeys.has(fieldKey)) throw createError('INVALID_FIELD_VALUE')
  }
}

function validateFieldValues(definitions, submitted) {
  const normalizedDefinitions = normalizeDefinitions(definitions)
  const resolved = resolveConditionalFields(normalizedDefinitions, submitted)
  const valuesByKey = resolved.valuesByKey
  rejectUnknownKeys(resolved.visibleDefinitions, valuesByKey)
  return resolved.visibleDefinitions.slice().sort(bySequence).map(definition => ({
    fieldKey: definition.fieldKey,
    name: definition.name,
    type: definition.type,
    value: validateOneValue(definition, valuesByKey.get(definition.fieldKey))
  }))
}

module.exports = {
  FIELD_TYPES,
  MAX_REGEX_LENGTH,
  isSafeRegularExpression,
  normalizeFieldDefinition,
  validateFieldValues
}
