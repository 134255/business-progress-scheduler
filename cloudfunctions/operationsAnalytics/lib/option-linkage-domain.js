// Pure CommonJS module, shared byte-for-byte with the client and analytics worker.
const MAX_ROWS = 5000
const MAX_GROUP_BYTES = 256 * 1024
const MAX_NODE_BYTES = 512 * 1024
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function invalid() {
  const error = new Error('INVALID_FIELD_VALUE')
  error.code = 'INVALID_FIELD_VALUE'
  throw error
}

function ownObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const copy = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key) ||
        allowed && !allowed.includes(key)) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !hasOwn(descriptor, 'value')) invalid()
    copy[key] = descriptor.value
  }
  return copy
}

function ownArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid()
  const result = []
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !hasOwn(descriptor, 'value')) invalid()
    result.push(descriptor.value)
  }
  return result
}

function keyText(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
      ['__proto__','constructor','prototype'].includes(value)) invalid()
  return value
}

function jsonByteLength(value) {
  const text = JSON.stringify(value)
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const point = text.codePointAt(i)
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (point > 0xffff) i++
  }
  return bytes
}

function normalizeOptionLinkageInput(value) {
  const input = ownObject(value, ['schemaVersion','fieldKeys','rows'])
  if (input.schemaVersion !== 1) invalid()
  const fieldKeys = ownArray(input.fieldKeys, 8).map(keyText)
  if (fieldKeys.length !== 8 || new Set(fieldKeys).size !== 8) invalid()
  const rows = ownArray(input.rows, MAX_ROWS).map(raw => {
    const row = ownArray(raw, 8)
    if (row.length !== 8 || row.some((cell, column) =>
      !(column >= 3 && cell === null) && (!Number.isSafeInteger(cell) || cell < 0))) invalid()
    return row
  })
  if (!rows.length || new Set(rows.map(row => JSON.stringify(row))).size !== rows.length) invalid()
  const result = { schemaVersion:1, fieldKeys, rows }
  if (jsonByteLength(result) > MAX_GROUP_BYTES) invalid()
  return result
}

function optionDictionary(field) {
  const constraints = ownObject(field.constraints, ['options'])
  const options = ownArray(constraints.options, MAX_GROUP_BYTES)
  if (!options.length || options.some(option => typeof option !== 'string' || !option.trim() || option !== option.trim()) ||
      new Set(options).size !== options.length) invalid()
  return options
}

// Run before any caller normalizes, spreads or sorts raw linked definitions.
// No-rule definitions retain the legacy normalizer's behavior; metadata is not
// whitelisted away from linked definitions, but must remain own data properties.
function inspectOptionLinkageFields(fields) {
  fields = ownArray(fields, Number.MAX_SAFE_INTEGER)
  const anchors = fields.filter(field => {
    if (!field || typeof field !== 'object') invalid()
    if ('optionLinkage' in field && !hasOwn(field, 'optionLinkage')) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(field, 'optionLinkage')
    if (descriptor && !hasOwn(descriptor, 'value')) invalid()
    return !!descriptor
  })
  if (anchors.length > 1) invalid()
  if (!anchors.length) return { fields, rule:null, anchor:null }
  const anchorIndex = fields.indexOf(anchors[0])
  fields = fields.map(field => ownObject(field))
  const anchor = fields[anchorIndex]
  const rule = normalizeOptionLinkageInput(anchor.optionLinkage)
  anchor.optionLinkage = rule
  for (const field of fields) {
    if (hasOwn(field, 'sequence') && (!Number.isSafeInteger(field.sequence) || field.sequence < 0)) invalid()
    const normalizedKey = typeof field.fieldKey === 'string' ? field.fieldKey.trim() : null
    if (field === anchor || rule.fieldKeys.includes(normalizedKey)) {
      field.constraints = { options:optionDictionary(field) }
    }
  }
  return { fields, rule, anchor }
}

function validateOptionLinkageFields(fields) {
  return inspectOptionLinkageFields(fields).fields
}

function buildOptionLinkageContext(fields) {
  const inspected = inspectOptionLinkageFields(fields)
  const { rule, anchor } = inspected
  const members = new Map()
  if (!rule) return { members, project: field => field }
  if (rule.fieldKeys[0] !== anchor.fieldKey) invalid()
  const all = inspected.fields.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
  if (new Set(all.map(field => field.fieldKey)).size !== all.length) invalid()
  const indices = rule.fieldKeys.map(key => all.findIndex(field => field.fieldKey === key))
  if (indices.some((index, column) => index < 0 || column > 0 && index <= indices[column - 1])) invalid()
  const definitions = indices.map(index => all[index])
  const dictionaries = definitions.map(field => {
    if (field.type !== 'single_select' || hasOwn(field, 'condition')) invalid()
    return field.constraints.options
  })
  if (jsonByteLength({ optionLinkage:rule, options:dictionaries }) > MAX_GROUP_BYTES) invalid()
  const applicability = new Map()
  for (const row of rule.rows) {
    if (row.some((value, column) => value !== null && value >= dictionaries[column].length)) invalid()
    const model = JSON.stringify(row.slice(0, 3))
    const mask = row.slice(3).map(value => value !== null).join(',')
    if (applicability.has(model) && applicability.get(model) !== mask) invalid()
    applicability.set(model, mask)
  }
  const group = { rule, dictionaries }
  rule.fieldKeys.forEach((key, column) => members.set(key, { group, column }))

  function project(field, valuesByKey) {
    const member = members.get(field.fieldKey)
    if (!member) return field
    const column = member.column
    let candidates = rule.rows
    for (let previous = 0; previous < column; previous++) {
      // Model-level presence is consistent, so once model is chosen a gap is unambiguous.
      if (previous >= 3 && candidates.every(row => row[previous] === null)) continue
      const selected = valuesByKey.get(rule.fieldKeys[previous])
      const index = dictionaries[previous].indexOf(selected)
      if (index < 0) return null
      candidates = candidates.filter(row => row[previous] === index)
      if (!candidates.length) return null
    }
    const allowed = new Set(candidates.map(row => row[column]).filter(value => value !== null))
    if (!allowed.size) return null
    const { optionLinkage, ...projection } = field
    return { ...projection, constraints: { ...field.constraints, options: dictionaries[column].filter((_, index) => allowed.has(index)) } }
  }
  return { members, project }
}

function optionLinkageSemanticProjection(fields, fieldKey) {
  const member = buildOptionLinkageContext(fields).members.get(fieldKey)
  if (!member) return null
  const { rule, dictionaries } = member.group
  // Canonical indices are determined by actual used values, never their input
  // positions. Keep this dictionary-compressed: repeating a long shared label
  // in every tuple would amplify a bounded input into a huge semantic payload.
  const options = dictionaries.map((dictionary, column) =>
    [...new Set(rule.rows.map(row => row[column]).filter(index => index !== null))]
      .map(index => dictionary[index]).sort())
  const canonicalIndices = options.map(values => new Map(values.map((value, index) => [value, index])))
  const rows = rule.rows.map(row => JSON.stringify(row.map((index, column) =>
    index === null ? null : canonicalIndices[column].get(dictionaries[column][index]))))
    .sort().map(row => JSON.parse(row))
  return { schemaVersion: rule.schemaVersion, fieldKeys: rule.fieldKeys.slice(), options, rows }
}

module.exports = { MAX_ROWS, MAX_GROUP_BYTES, MAX_NODE_BYTES, jsonByteLength,
  normalizeOptionLinkageInput, validateOptionLinkageFields, buildOptionLinkageContext, optionLinkageSemanticProjection }
