const { ownDataValue } = require('./account-relationship-schema')

const STABLE_ID = /^[A-Za-z0-9_-]{1,128}$/

function invalid() {
  const error = new Error('CARD_DISPLAY_INVALID')
  error.code = 'CARD_DISPLAY_INVALID'
  // Resolve at call time: the repository also consumes this domain module.
  error[require('./cloud-template-repository').APPLICATION_ERROR_MARKER] = true
  return error
}

function assertRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid()
}

function readOwn(value, key) {
  const field = ownDataValue(value, key)
  if (!field.valid) throw invalid()
  return field.value
}

function exactRecord(value, keys) {
  assertRecord(value)
  if (Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some(key => !keys.includes(key))) throw invalid()
  return Object.fromEntries(keys.map(key => [key, readOwn(value, key)]))
}

function denseArray(value, maximum = Infinity) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw invalid()
  const result = []
  for (let index = 0; index < value.length; index += 1) result.push(readOwn(value, String(index)))
  return result
}

function stableId(value) {
  if (typeof value !== 'string' || !STABLE_ID.test(value)) throw invalid()
  return value
}

function readReferences(fields) {
  const seen = new Set()
  return denseArray(fields, 4).map(source => {
    const field = exactRecord(source, ['nodeKey', 'fieldKey'])
    const nodeKey = stableId(field.nodeKey)
    const fieldKey = stableId(field.fieldKey)
    const pair = JSON.stringify([nodeKey, fieldKey])
    if (seen.has(pair)) throw invalid()
    seen.add(pair)
    return { nodeKey, fieldKey }
  })
}

function readDisplay(value) {
  const display = exactRecord(value, ['schemaVersion', 'revision', 'fields'])
  if (display.schemaVersion !== 1 || !Number.isSafeInteger(display.revision) || display.revision < 0) {
    throw invalid()
  }
  return { schemaVersion: 1, revision: display.revision, fields: readReferences(display.fields) }
}

function readCardDisplay(template) {
  assertRecord(template)
  const config = ownDataValue(template, 'cardDisplay')
  if (!config.present) {
    if ('cardDisplay' in template) throw invalid()
    return { schemaVersion: 1, revision: 0, fields: [] }
  }
  if (!config.valid) throw invalid()
  return readDisplay(config.value)
}

function normalizeCardDisplayFields(fields, nodes) {
  const references = readReferences(fields)
  const definitions = new Map()
  for (const node of denseArray(nodes, 48)) {
    assertRecord(node)
    const nodeKey = stableId(readOwn(node, 'nodeKey'))
    if (definitions.has(nodeKey)) throw invalid()
    const fieldKeys = new Set()
    for (const field of denseArray(readOwn(node, 'fields'))) {
      assertRecord(field)
      const fieldKey = stableId(readOwn(field, 'fieldKey'))
      if (fieldKeys.has(fieldKey)) throw invalid()
      fieldKeys.add(fieldKey)
    }
    definitions.set(nodeKey, fieldKeys)
  }
  for (const { nodeKey, fieldKey } of references) {
    if (!definitions.has(nodeKey) || !definitions.get(nodeKey).has(fieldKey)) throw invalid()
  }
  return references
}

function assertCardDisplayReferences(display, nodes) {
  normalizeCardDisplayFields(readDisplay(display).fields, nodes)
}

module.exports = { readCardDisplay, normalizeCardDisplayFields, assertCardDisplayReferences }
