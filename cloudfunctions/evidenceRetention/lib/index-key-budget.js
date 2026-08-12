'use strict'

const MAX_INDEXED_ACCOUNT_IDS = 50
const MAX_INDEXED_ARRAY_BYTES = 768

function indexedStringArrayBytes(values) {
  if (!Array.isArray(values)) return Number.POSITIVE_INFINITY
  return 5 + values.reduce((total, value, index) => typeof value === 'string'
    ? total + 1 + Buffer.byteLength(String(index), 'utf8') + 1 + 4 + Buffer.byteLength(value, 'utf8') + 1
    : Number.POSITIVE_INFINITY, 0)
}

function fitsIndexedAccountArray(values) {
  return Array.isArray(values) && values.length <= MAX_INDEXED_ACCOUNT_IDS &&
    indexedStringArrayBytes(values) <= MAX_INDEXED_ARRAY_BYTES
}

module.exports = { fitsIndexedAccountArray }
