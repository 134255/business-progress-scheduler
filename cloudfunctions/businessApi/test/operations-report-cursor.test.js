const test = require('node:test')
const assert = require('node:assert/strict')
let createOperationsReportCursor
try { ({ createOperationsReportCursor } = require('../lib/operations-report-cursor')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
const body = { actorId: 'synthetic-admin', queryDigest: 'a'.repeat(64), reportDigest: 'b'.repeat(64), offset: 50, expiresAt: Date.parse('2026-09-11T00:20:00Z') }
function harness(secret = 'synthetic-only-secret-material'.repeat(2)) {
  assert.equal(typeof createOperationsReportCursor, 'function', 'report continuation must be authenticated and confidential')
  return createOperationsReportCursor({ secret, clock: () => new Date('2026-09-11T00:00:00Z') })
}
test('report cursor preserves bound continuation without readable actor identity', () => {
  const codec = harness(), token = codec.encode(body)
  assert.deepEqual(codec.decode(token, body), body)
  assert.equal(token.includes(body.actorId), false)
  assert.equal(Buffer.from(token.split('.')[1], 'base64url').toString().includes(body.actorId), false)
})
test('report cursor rejects tampering, another actor, another query, wrong key and expiry', () => {
  const codec = harness(), token = codec.encode(body)
  for (const [value, binding] of [[token.slice(0,-4)+'abcd', body], [token,{...body,actorId:'other'}], [token,{...body,queryDigest:'c'.repeat(64)}], ['bad',body]]) {
    assert.throws(() => codec.decode(value,binding), { code: 'VALIDATION_ERROR' })
  }
  assert.throws(() => harness('different-synthetic-key'.repeat(3)).decode(token,body), { code: 'VALIDATION_ERROR' })
  const expired = createOperationsReportCursor({ secret:'synthetic-only-secret-material'.repeat(2),clock:()=>new Date('2026-09-11T00:20:00Z') })
  assert.throws(() => expired.decode(token,body), { code: 'REPORT_EXPIRED' })
})
test('report cursor does not replace a missing or weak server key with an unsafe fallback', () => {
  for (const secret of [undefined, '', 'weak']) assert.throws(() => harness(secret === undefined ? null : secret), { code: 'REPORT_CONFIGURATION_ERROR' })
})
