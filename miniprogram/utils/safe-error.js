function safeErrorMessage(error, fallback) {
  const message = error && typeof error.message === 'string' ? error.message.trim() : ''
  return /^[\u3400-\u9fff]/.test(message) ? message : fallback
}

module.exports = { safeErrorMessage }
