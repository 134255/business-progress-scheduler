function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function assertRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.getPrototypeOf(record) !== Object.prototype) throw createError('SEARCH_STATE_INVALID')
}

function optionalVersion(record, key, fallback) {
  assertRecord(record)
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor) return fallback
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
    throw createError('SEARCH_STATE_INVALID')
  }
  return descriptor.value
}

function currentSearchVersion(record, { allowMissing = false } = {}) {
  const source = optionalVersion(record, 'searchSourceVersion', allowMissing ? 0 : -1)
  const generated = optionalVersion(record, 'searchGeneratedVersion', allowMissing ? 0 : -1)
  const status = Object.getOwnPropertyDescriptor(record, 'searchIndexStatus')
  if (source < 0 || generated < 0 || generated > source || !status ||
      !Object.prototype.hasOwnProperty.call(status, 'value') ||
      !['pending', 'generated'].includes(status.value) ||
      (status.value === 'generated' && generated !== source)) {
    throw createError('SEARCH_STATE_INVALID')
  }
  return {
    searchSourceVersion: source,
    searchGeneratedVersion: generated,
    searchIndexStatus: status.value
  }
}

function advanceSearchVersion(record) {
  const source = optionalVersion(record, 'searchSourceVersion', 0)
  const generated = optionalVersion(record, 'searchGeneratedVersion', 0)
  if (source === Number.MAX_SAFE_INTEGER || generated > source) throw createError('SEARCH_STATE_INVALID')
  return {
    searchSourceVersion: source + 1,
    searchGeneratedVersion: generated,
    searchIndexStatus: 'pending'
  }
}

function stripSearchEnvelope(result) {
  assertRecord(result)
  const envelope = Object.getOwnPropertyDescriptor(result, 'searchEnvelope')
  if (!envelope) return result
  if (!Object.prototype.hasOwnProperty.call(envelope, 'value')) throw createError('SEARCH_STATE_INVALID')
  const publicResult = Object.getOwnPropertyDescriptor(result, 'publicResult')
  if (!publicResult || !Object.prototype.hasOwnProperty.call(publicResult, 'value')) {
    throw createError('SEARCH_STATE_INVALID')
  }
  return publicResult.value
}

async function synchronizeSearchResult(stored, businessSearchClient) {
  const envelope = stored && Object.getOwnPropertyDescriptor(stored, 'searchEnvelope')
  if (!envelope) return stored
  if (!Object.prototype.hasOwnProperty.call(envelope, 'value')) throw createError('SEARCH_STATE_INVALID')
  const publicResult = stripSearchEnvelope(stored)
  try {
    if (!businessSearchClient || typeof businessSearchClient.ensureIndexed !== 'function') {
      throw new Error('search unavailable')
    }
    await businessSearchClient.ensureIndexed(envelope.value)
    return publicResult
  } catch (_) {
    return Object.assign({}, publicResult, { searchIndexStatus: 'pending' })
  }
}

module.exports = {
  advanceSearchVersion,
  currentSearchVersion,
  stripSearchEnvelope,
  synchronizeSearchResult
}
