const test = require('node:test')
const assert = require('node:assert/strict')
const { assertPasswordPolicy, hashPassword, verifyPassword } = require('../lib/password')

test('hashes a valid password without storing plaintext and verifies it', () => {
  const record = hashPassword('Account9', { salt: Buffer.alloc(16, 7) })
  assert.equal(record.algorithm, 'scrypt')
  assert.notEqual(record.hash, 'Account9')
  assert.equal(verifyPassword('Account9', record), true)
  assert.equal(verifyPassword('Wrong999', record), false)
})

test('requires 8-64 characters with an ASCII letter and digit', () => {
  assert.throws(() => assertPasswordPolicy('short1'), error => error.code === 'WEAK_PASSWORD')
  assert.throws(() => assertPasswordPolicy('onlyletters'), error => error.code === 'WEAK_PASSWORD')
  assert.throws(() => assertPasswordPolicy('12345678'), error => error.code === 'WEAK_PASSWORD')
  assert.doesNotThrow(() => assertPasswordPolicy('ValidPass8'))
})
