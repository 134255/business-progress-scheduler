const crypto = require('node:crypto')

const FIELD_TYPES = new Set([
  'short_text', 'long_text', 'number', 'boolean', 'date', 'single_select', 'multi_select'
])
const SOURCE_KINDS = new Set([
  'line_name', 'line_code', 'line_description', 'node_name', 'node_code',
  'field_name', 'field_value', 'processing_comment', 'review_comment', 'evidence_file_name'
])
const TOKEN_INDEX_BUDGET = 768
const MAX_EXCERPT_POINTS = 160

function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createError('SEARCH_SOURCE_INVALID')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw createError('SEARCH_SOURCE_INVALID')
  }
  return value
}

function ownData(object, key) {
  assertPlainObject(object)
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw createError('SEARCH_SOURCE_INVALID')
  }
  return descriptor.value
}

function exactKeys(object, allowed) {
  assertPlainObject(object)
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw createError('SEARCH_SOURCE_INVALID')
  }
}

function denseArray(value) {
  if (!Array.isArray(value)) throw createError('SEARCH_SOURCE_INVALID')
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw createError('SEARCH_SOURCE_INVALID')
    }
  }
  return value
}

function requiredText(value) {
  if (typeof value !== 'string' || value.length === 0) throw createError('SEARCH_SOURCE_INVALID')
  return value
}

function optionalText(value) {
  if (typeof value !== 'string') throw createError('SEARCH_SOURCE_INVALID')
  return value
}

function normalizeText(value) {
  if (typeof value !== 'string') throw createError('SEARCH_SOURCE_INVALID')
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

function normalizeSearchQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createError('INVALID_SEARCH_QUERY')
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, 'keyword')
  if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw createError('INVALID_SEARCH_QUERY')
  }
  const keyword = descriptor ? descriptor.value : ''
  if (typeof keyword !== 'string') throw createError('INVALID_SEARCH_QUERY')
  let normalized
  try {
    normalized = normalizeText(keyword)
  } catch {
    throw createError('INVALID_SEARCH_QUERY')
  }
  const normalizedKeywords = normalized === '' ? [] : normalized.split(' ')
  const total = normalizedKeywords.reduce((sum, item) => sum + Array.from(item).length, 0)
  if (normalizedKeywords.length > 5 || total > 100) throw createError('INVALID_SEARCH_QUERY')
  return {
    keywords: normalizedKeywords.slice(),
    normalizedKeywords,
    digestInput: normalizedKeywords.join('\u0000')
  }
}

function formatFieldValue(field) {
  exactKeys(field, new Set(['fieldKey', 'name', 'type', 'value']))
  requiredText(ownData(field, 'fieldKey'))
  const name = requiredText(ownData(field, 'name'))
  const type = ownData(field, 'type')
  const value = ownData(field, 'value')
  if (!FIELD_TYPES.has(type)) throw createError('SEARCH_SOURCE_INVALID')

  if (type === 'short_text' || type === 'long_text' || type === 'single_select') {
    return { name, text: optionalText(value) }
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw createError('SEARCH_SOURCE_INVALID')
    return { name, text: String(value) }
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw createError('SEARCH_SOURCE_INVALID')
    return { name, text: value ? '是' : '否' }
  }
  if (type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw createError('SEARCH_SOURCE_INVALID')
    }
    const parsed = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw createError('SEARCH_SOURCE_INVALID')
    }
    return { name, text: value }
  }

  const options = denseArray(value)
  const seen = new Set()
  const labels = options.map(item => {
    const label = requiredText(item)
    if (seen.has(label)) throw createError('SEARCH_SOURCE_INVALID')
    seen.add(label)
    return label
  })
  return { name, text: labels.join(' ') }
}

function segmentText(text, size = 2048, overlap = 99) {
  if (typeof text !== 'string' || !Number.isSafeInteger(size) || !Number.isSafeInteger(overlap) ||
      size < 1 || overlap < 0 || overlap >= size) {
    throw createError('SEARCH_SOURCE_INVALID')
  }
  const points = Array.from(text)
  const result = []
  for (let start = 0; start < points.length; start += size - overlap) {
    result.push(points.slice(start, start + size).join(''))
    if (start + size >= points.length) break
  }
  return result
}

function safeSearchExcerpt(entry, normalizedKeywords = []) {
  const text = normalizeText(ownData(assertPlainObject(entry), 'normalizedText'))
  const points = Array.from(text)
  if (points.length <= MAX_EXCERPT_POINTS) return text
  let matchPoint = 0
  for (const keyword of denseArray(normalizedKeywords)) {
    if (typeof keyword !== 'string' || keyword.length === 0) throw createError('SEARCH_SOURCE_INVALID')
    const index = text.indexOf(keyword)
    if (index >= 0) {
      matchPoint = Array.from(text.slice(0, index)).length
      break
    }
  }
  const start = Math.max(0, Math.min(points.length - MAX_EXCERPT_POINTS, matchPoint - 60))
  return points.slice(start, start + MAX_EXCERPT_POINTS).join('')
}

function addTextEntries(target, { businessLineId, nodeId, sourceKind, label, text, entryOrdinal }) {
  if (!SOURCE_KINDS.has(sourceKind)) throw createError('SEARCH_SOURCE_INVALID')
  const normalized = normalizeText(text)
  if (normalized === '') return
  const segments = segmentText(normalized)
  segments.forEach((normalizedText, segmentIndex) => {
    const base = {
      businessLineId,
      nodeId,
      sourceKind,
      label,
      normalizedText,
      segmentIndex,
      entryId: `${nodeId || 'line'}:${entryOrdinal}:${segmentIndex}`
    }
    target.push({ ...base, safeExcerpt: safeSearchExcerpt({ normalizedText }, []) })
  })
}

function buildSearchEntries(snapshot) {
  exactKeys(snapshot, new Set(['businessLineId', 'name', 'code', 'description', 'nodes']))
  const businessLineId = requiredText(ownData(snapshot, 'businessLineId'))
  const entries = []
  let ordinal = 0
  const add = values => addTextEntries(entries, { businessLineId, entryOrdinal: ordinal++, ...values })
  add({ nodeId: null, sourceKind: 'line_name', label: '售后名称', text: requiredText(ownData(snapshot, 'name')) })
  add({ nodeId: null, sourceKind: 'line_code', label: '售后编号', text: requiredText(ownData(snapshot, 'code')) })
  add({ nodeId: null, sourceKind: 'line_description', label: '售后说明', text: optionalText(ownData(snapshot, 'description')) })

  const nodes = denseArray(ownData(snapshot, 'nodes'))
  for (const node of nodes) {
    exactKeys(node, new Set([
      'nodeId', 'name', 'code', 'fieldValues', 'processingComment', 'reviewComments', 'evidenceFileNames'
    ]))
    const nodeId = requiredText(ownData(node, 'nodeId'))
    add({ nodeId, sourceKind: 'node_name', label: '节点名称', text: requiredText(ownData(node, 'name')) })
    add({ nodeId, sourceKind: 'node_code', label: '节点编号', text: requiredText(ownData(node, 'code')) })

    const fields = denseArray(ownData(node, 'fieldValues'))
    const fieldKeys = new Set()
    for (const field of fields) {
      const fieldKey = ownData(assertPlainObject(field), 'fieldKey')
      if (typeof fieldKey !== 'string' || fieldKey.length === 0 || fieldKeys.has(fieldKey)) {
        throw createError('SEARCH_SOURCE_INVALID')
      }
      fieldKeys.add(fieldKey)
      const formatted = formatFieldValue(field)
      add({ nodeId, sourceKind: 'field_name', label: formatted.name, text: formatted.name })
      add({ nodeId, sourceKind: 'field_value', label: formatted.name, text: formatted.text })
    }

    add({ nodeId, sourceKind: 'processing_comment', label: '处理说明', text: optionalText(ownData(node, 'processingComment')) })
    for (const comment of denseArray(ownData(node, 'reviewComments'))) {
      add({ nodeId, sourceKind: 'review_comment', label: '审核意见', text: optionalText(comment) })
    }
    for (const fileName of denseArray(ownData(node, 'evidenceFileNames'))) {
      add({ nodeId, sourceKind: 'evidence_file_name', label: '凭证文件名', text: requiredText(fileName) })
    }
  }
  return entries
}

function ngrams(text) {
  const points = Array.from(text)
  const values = []
  for (const size of [1, 2, 3]) {
    if (points.length < size) continue
    for (let index = 0; index <= points.length - size; index += 1) {
      values.push({ gram: points.slice(index, index + size).join(''), size })
    }
  }
  return values
}

function hashToken(secret, gram) {
  if (typeof secret !== 'string' || Array.from(secret).length < 32) throw createError('SEARCH_SECRET_INVALID')
  return crypto.createHmac('sha256', secret).update(gram, 'utf8').digest('base64url').slice(0, 22)
}

function estimateTokenIndexBytes(tokenHashes) {
  denseArray(tokenHashes)
  if (tokenHashes.some(item => typeof item !== 'string')) throw createError('SEARCH_SOURCE_INVALID')
  return Buffer.byteLength(JSON.stringify({ tokenHashes }), 'utf8') + 64
}

function tokenizeEntry(entry, secret) {
  assertPlainObject(entry)
  const normalizedText = normalizeText(ownData(entry, 'normalizedText'))
  const unique = new Map()
  for (const item of ngrams(normalizedText)) {
    const tokenHash = hashToken(secret, item.gram)
    if (!unique.has(tokenHash)) unique.set(tokenHash, item.size)
  }
  const chunks = []
  let tokenHashes = []
  let gramSizes = []
  for (const [tokenHash, gramSize] of unique.entries()) {
    const candidate = [...tokenHashes, tokenHash]
    if (tokenHashes.length > 0 && estimateTokenIndexBytes(candidate) > TOKEN_INDEX_BUDGET) {
      chunks.push({ tokenChunkIndex: chunks.length, tokenHashes, gramSizes })
      tokenHashes = []
      gramSizes = []
    }
    tokenHashes.push(tokenHash)
    gramSizes.push(gramSize)
  }
  if (tokenHashes.length > 0) chunks.push({ tokenChunkIndex: chunks.length, tokenHashes, gramSizes })
  return chunks
}

function entryMatchesKeywords(entry, normalizedKeywords) {
  assertPlainObject(entry)
  const text = normalizeText(ownData(entry, 'normalizedText'))
  return denseArray(normalizedKeywords).every(keyword => {
    if (typeof keyword !== 'string' || keyword.length === 0) throw createError('SEARCH_SOURCE_INVALID')
    return text.includes(keyword)
  })
}

module.exports = {
  normalizeText,
  normalizeSearchQuery,
  buildSearchEntries,
  segmentText,
  tokenizeEntry,
  entryMatchesKeywords,
  safeSearchExcerpt,
  estimateTokenIndexBytes
}
