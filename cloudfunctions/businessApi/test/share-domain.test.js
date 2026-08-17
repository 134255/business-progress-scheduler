const test = require('node:test')
const assert = require('node:assert/strict')

const { SHARE_LIFETIME_MS, normalizeShareToken, publicSharePath } = require('../lib/share-domain')

test('公开分享令牌固定为32随机字节的base64url并生成只读页面路径', () => {
  const token = Buffer.alloc(32, 7).toString('base64url')
  assert.equal(normalizeShareToken(token), token)
  assert.equal(publicSharePath(token), `/pages/public-node-share/index?token=${token}`)
  assert.equal(SHARE_LIFETIME_MS, 7 * 24 * 60 * 60 * 1000)
  for (const invalid of ['', 'short', `${token}=`, `${token}x`, null]) {
    assert.throws(() => normalizeShareToken(invalid), error => error.code === 'VALIDATION_ERROR')
  }
})
