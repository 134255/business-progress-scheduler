const crypto = require('node:crypto')

function createError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw createError('WEAK_PASSWORD', '密码需为8-64位，且至少包含一个字母和一个数字')
  }
}

function hashPassword(password, options = {}) {
  assertPasswordPolicy(password)
  const saltBuffer = options.salt || crypto.randomBytes(16)
  const keyLength = 64
  const hashBuffer = crypto.scryptSync(password, saltBuffer, keyLength)
  return {
    algorithm: 'scrypt',
    salt: saltBuffer.toString('base64'),
    hash: hashBuffer.toString('base64'),
    keyLength
  }
}

function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'scrypt') return false
  const actual = crypto.scryptSync(password, Buffer.from(record.salt, 'base64'), Number(record.keyLength || 64))
  const expected = Buffer.from(record.hash, 'base64')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

module.exports = { assertPasswordPolicy, hashPassword, verifyPassword }
