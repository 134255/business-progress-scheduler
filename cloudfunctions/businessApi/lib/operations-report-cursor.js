const crypto = require('node:crypto')
const { fieldError } = require('./operations-field-service')
const PURPOSE = 'operations-field-report-v1'
const HEX = /^[a-f0-9]{64}$/
function validBody(body) {
  return body && Object.keys(body).sort().join(',') === 'actorId,expiresAt,offset,queryDigest,reportDigest' &&
    typeof body.actorId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.actorId) &&
    typeof body.queryDigest === 'string' && HEX.test(body.queryDigest) &&
    typeof body.reportDigest === 'string' && HEX.test(body.reportDigest) &&
    Number.isSafeInteger(body.offset) && body.offset >= 0 && Number.isSafeInteger(body.expiresAt)
}
function createOperationsReportCursor({ secret, clock = () => new Date() }) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw fieldError('REPORT_CONFIGURATION_ERROR')
  const key = crypto.createHmac('sha256', secret).update(PURPOSE).digest()
  return {
    encode(body) {
      if (!validBody(body)) throw fieldError('VALIDATION_ERROR')
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(PURPOSE))
      const data = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()])
      return 'of1.' + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')
    },
    decode(token, binding) {
      let body
      try {
        if (typeof token !== 'string' || !/^of1\.[A-Za-z0-9_-]{40,2000}$/.test(token)) throw new Error('format')
        const packed = Buffer.from(token.slice(4), 'base64url')
        if (packed.toString('base64url') !== token.slice(4)) throw new Error('canonical')
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12))
        decipher.setAAD(Buffer.from(PURPOSE))
        decipher.setAuthTag(packed.subarray(12, 28))
        body = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8'))
        if (!validBody(body) || body.actorId !== binding.actorId || body.queryDigest !== binding.queryDigest) throw new Error('binding')
      } catch (_) { throw fieldError('VALIDATION_ERROR') }
      const now = clock().getTime()
      if (!Number.isFinite(now) || body.expiresAt <= now) throw fieldError('REPORT_EXPIRED')
      return body
    }
  }
}
module.exports = { createOperationsReportCursor }
