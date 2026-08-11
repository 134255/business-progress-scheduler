const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

const ACCOUNT_RELATIONSHIP_FIELDS = Object.freeze([
  'managerUserIds',
  'memberUserIds',
  'processorUserIds',
  'reviewerUserIds',
  'assigneeUserIds'
])

function ownDataValue(value, key) {
  if (!value || typeof value !== 'object') return { present: false, valid: false, value: undefined }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return { present: false, valid: false, value: undefined }
  return {
    present: true,
    valid: Object.prototype.hasOwnProperty.call(descriptor, 'value'),
    value: descriptor.value
  }
}

function hasAccountRelationshipMarker(value) {
  if (!value || typeof value !== 'object') return false
  const visited = new Set()
  let current = value
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    if (ACCOUNT_RELATIONSHIP_FIELDS.some(key => Object.getOwnPropertyDescriptor(current, key))) return true
    current = Object.getPrototypeOf(current)
  }
  return false
}

function exactAccountIds(value, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || nonEmpty && value.length === 0 ||
      value.some(id => typeof id !== 'string' || !DOCUMENT_ID.test(id)) ||
      new Set(value).size !== value.length) return null
  return value
}

function ownExactAccountIds(value, key, options) {
  const field = ownDataValue(value, key)
  return field.valid ? exactAccountIds(field.value, options) : null
}

module.exports = {
  ACCOUNT_RELATIONSHIP_FIELDS,
  exactAccountIds,
  hasAccountRelationshipMarker,
  ownDataValue,
  ownExactAccountIds
}
