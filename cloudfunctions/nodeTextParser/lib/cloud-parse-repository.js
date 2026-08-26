'use strict'

const ID = /^[A-Za-z0-9_-]{20,128}$/
const HASH = /^[a-f0-9]{64}$/

function ticketError() {
  const error = new Error('invalid parse ticket')
  error.code = 'NODE_TEXT_TICKET_INVALID'
  throw error
}

function time(value) {
  if (value instanceof Date) return value.getTime()
  if (value && typeof value.toDate === 'function') return value.toDate().getTime()
  return new Date(value).getTime()
}

function ownValue(object, key) {
  if (!object || typeof object !== 'object') return { valid: false }
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { valid: true, value: descriptor.value }
    : { valid: false }
}

function createCloudParseRepository({ db, clock = () => new Date() } = {}) {
  if (!db || typeof db.runTransaction !== 'function') throw new TypeError('db is required')
  return {
    async consumeParseTicket(input) {
      if (!input || !ID.test(input.ticketId || '') || !HASH.test(input.actorHash || '') || !HASH.test(input.schemaDigest || '') ||
          !HASH.test(input.textDigest || '') || !HASH.test(input.requestKeyHash || '') || !ID.test(input.businessLineId || '') ||
          !ID.test(input.nodeId || '') || !Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 0) ticketError()
      const now = clock()
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) ticketError()
      return db.runTransaction(async transaction => {
        const reference = transaction.collection('node_text_parse_requests').doc(input.ticketId)
        let result
        try { result = await reference.get() } catch (_) { ticketError() }
        const ticket = result && result.data
        const stored = Object.fromEntries([
          'status', 'expiresAt', 'actorHash', 'businessLineId', 'nodeId', 'expectedNodeVersion',
          'schemaDigest', 'textDigest', 'requestKeyHash', 'revision'
        ].map(key => [key, ownValue(ticket, key)]))
        const expiry = stored.expiresAt.valid ? time(stored.expiresAt.value) : Number.NaN
        if (Object.values(stored).some(entry => !entry.valid) || stored.status.value !== 'pending' ||
            !Number.isFinite(expiry) || expiry <= now.getTime() || stored.actorHash.value !== input.actorHash ||
            stored.businessLineId.value !== input.businessLineId || stored.nodeId.value !== input.nodeId ||
            stored.expectedNodeVersion.value !== input.expectedNodeVersion || stored.schemaDigest.value !== input.schemaDigest ||
            stored.textDigest.value !== input.textDigest || stored.requestKeyHash.value !== input.requestKeyHash ||
            !Number.isSafeInteger(stored.revision.value) || stored.revision.value < 0 || stored.revision.value === Number.MAX_SAFE_INTEGER) ticketError()
        await reference.update({ data: { status: 'consumed', consumedAt: now, revision: stored.revision.value + 1 } })
        return { consumed: true }
      })
    },
    async cleanupExpired({ limit = 20 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) return 0
      const result = await db.collection('node_text_parse_requests').where({ expiresAt: db.command.lt(clock()) })
        .orderBy('expiresAt', 'asc').orderBy('_id', 'asc').limit(limit).get()
      for (const item of result.data || []) await db.collection('node_text_parse_requests').doc(item._id).remove()
      return (result.data || []).length
    }
  }
}

module.exports = { createCloudParseRepository }
