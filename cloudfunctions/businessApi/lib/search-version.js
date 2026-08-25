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

module.exports = { advanceSearchVersion, stripSearchEnvelope }
