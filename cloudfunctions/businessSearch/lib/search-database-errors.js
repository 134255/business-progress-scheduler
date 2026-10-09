// Fixed categories only: raw SDK messages can contain customer data. The
// wrapped-conflict shape is specific to the pinned wx-server-sdk 4.0.2.
const NATIVE_CAUSES = new Set([
  'DATABASE_TRANSACTION_CONFLICT', 'DATABASE_PERMISSION_DENIED', 'DATABASE_REQUEST_FAILED'
])
const SDK_CAUSES = new Map([
  [-501001, 'DATABASE_SYSTEM_ERROR'], [-501002, 'DATABASE_TIMEOUT'],
  [-502001, 'DATABASE_REQUEST_FAILED'], [-502003, 'DATABASE_PERMISSION_DENIED']
])
const WRAPPED_CONFLICT = /^document\.(?:get|update|set):fail -501001 resource system error\. database transaction conflict\.?$/i

function databaseErrorCause(error) {
  try {
    if (!error || typeof error !== 'object') return 'UNKNOWN'
    const own = key => Object.getOwnPropertyDescriptor(error, key)
    const value = descriptor => descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    const code = own('code')
    // A business rejection or an unknown explicit code must never become a
    // retryable conflict just because its message happens to mention one.
    if (code) return NATIVE_CAUSES.has(value(code)) ? value(code) : 'UNKNOWN'
    const sdkCode = value(own('errCode'))
    const message = value(own('errMsg') || own('message'))
    if (sdkCode === -501001 && typeof message === 'string' && message.length <= 200 &&
        WRAPPED_CONFLICT.test(message)) return 'DATABASE_TRANSACTION_CONFLICT'
    return SDK_CAUSES.get(sdkCode) || 'UNKNOWN'
  } catch (_) {
    return 'UNKNOWN'
  }
}

function isDatabaseTransactionConflict(error) {
  return databaseErrorCause(error) === 'DATABASE_TRANSACTION_CONFLICT'
}

module.exports = { databaseErrorCause, isDatabaseTransactionConflict }
