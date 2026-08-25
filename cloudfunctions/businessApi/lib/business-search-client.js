const crypto = require('node:crypto')

function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function normalizeKeyword(keyword) {
  if (typeof keyword !== 'string') throw createError('INVALID_SEARCH_QUERY')
  const normalized = keyword.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
  const normalizedKeywords = normalized === '' ? [] : normalized.split(' ')
  const total = normalizedKeywords.reduce((sum, value) => sum + Array.from(value).length, 0)
  if (normalizedKeywords.length < 1 || normalizedKeywords.length > 5 || total > 100) {
    throw createError('INVALID_SEARCH_QUERY')
  }
  return { normalizedKeywords, digestInput: normalizedKeywords.join('\u0000') }
}

function safePageSize(value) {
  const pageSize = value === undefined ? 20 : value
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 20) {
    throw createError('INVALID_SEARCH_QUERY')
  }
  return pageSize
}

function safeCursor(value) {
  const cursor = value === undefined ? '' : value
  if (typeof cursor !== 'string' || cursor.length > 2048) throw createError('INVALID_SEARCH_QUERY')
  return cursor
}

function createBusinessSearchClient({ db, callFunction, secret, clock = () => new Date(), randomBytes }) {
  if (!db || typeof db.collection !== 'function' || typeof callFunction !== 'function' ||
      typeof secret !== 'string' || Array.from(secret).length < 32 || typeof clock !== 'function' ||
      typeof randomBytes !== 'function') throw createError('SEARCH_CONFIGURATION_INVALID')

  async function storeRequest(operation, data) {
    const now = clock()
    const random = randomBytes(32)
    if (!(now instanceof Date) || Number.isNaN(now.getTime()) || !Buffer.isBuffer(random) || random.length < 24) {
      throw createError('SEARCH_CONFIGURATION_INVALID')
    }
    const ticket = random.toString('base64url')
    const requestId = crypto.createHmac('sha256', secret).update(ticket, 'utf8').digest('hex')
    await db.collection('business_search_requests').doc(requestId).set({ data: {
      operation,
      ...data,
      status: 'pending',
      createdAt: new Date(now),
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000)
    } })
    return ticket
  }

  async function invoke(operation, ticket) {
    try {
      const response = await callFunction({ name: 'businessSearch', data: { operation, ticket } })
      return response && response.result !== undefined ? response.result : response
    } catch (_) {
      throw createError('BUSINESS_SEARCH_UNAVAILABLE')
    }
  }

  async function ensureIndexed(envelope) {
    if (envelope === null || envelope === undefined) return null
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        typeof envelope.actorId !== 'string' || !envelope.actorId ||
        typeof envelope.businessLineId !== 'string' || !envelope.businessLineId ||
        !Number.isSafeInteger(envelope.sourceVersion) || envelope.sourceVersion < 0) {
      throw createError('SEARCH_STATE_INVALID')
    }
    const ticket = await storeRequest('index', {
      actorId: envelope.actorId,
      businessLineId: envelope.businessLineId,
      sourceVersion: envelope.sourceVersion
    })
    return invoke('index', ticket)
  }

  async function query({ actorId, query: input = {} }) {
    if (typeof actorId !== 'string' || !actorId || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw createError('INVALID_SEARCH_QUERY')
    }
    const normalized = normalizeKeyword(input.keyword)
    const pageSize = safePageSize(input.pageSize)
    const cursor = safeCursor(input.cursor)
    const ticket = await storeRequest('query', {
      actorId,
      normalizedKeywords: normalized.normalizedKeywords,
      digestInput: normalized.digestInput,
      pageSize,
      cursor
    })
    return invoke('query', ticket)
  }

  return { ensureIndexed, query }
}

module.exports = { createBusinessSearchClient }
