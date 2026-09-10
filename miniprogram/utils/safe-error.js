function safeErrorMessage(error, fallback) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : ''
  return /^[\u3400-\u9fff]/.test(message) ? message : fallback
}

function isAccountAccessError(error) {
  // Keep session denials aligned with businessApi/index.js resolveActor.
  return Boolean(error && [
    'FORBIDDEN', 'UNAUTHORIZED', 'ACCOUNT_DISABLED', 'ACCOUNT_LOCKED',
    'PASSWORD_CHANGE_REQUIRED', 'ACCOUNT_STATE_INVALID'
  ].includes(error.code))
}

module.exports = { safeErrorMessage, isAccountAccessError }
