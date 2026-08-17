const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const SHARE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function normalizeShareToken(value) {
  if (typeof value !== 'string' || !SHARE_TOKEN_PATTERN.test(value)) throw createError('VALIDATION_ERROR')
  return value
}

function normalizeDocumentId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw createError('VALIDATION_ERROR')
  return value
}

function normalizeRequestKey(value) {
  if (typeof value !== 'string' || !REQUEST_KEY.test(value)) throw createError('VALIDATION_ERROR')
  return value
}

function publicSharePath(token) {
  return `/pages/public-node-share/index?token=${normalizeShareToken(token)}`
}

function normalizePublicShareQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some(key => !['token', 'cursor', 'pageSize'].includes(key))) {
    throw createError('VALIDATION_ERROR')
  }
  const cursor = input.cursor === undefined ? '' : input.cursor
  const pageSize = input.pageSize === undefined ? 40 : input.pageSize
  if (typeof cursor !== 'string' || cursor.length > 128 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 40) {
    throw createError('VALIDATION_ERROR')
  }
  return { token: normalizeShareToken(input.token), cursor, pageSize }
}

module.exports = {
  SHARE_LIFETIME_MS,
  normalizeDocumentId,
  normalizePublicShareQuery,
  normalizeRequestKey,
  normalizeShareToken,
  publicSharePath
}
