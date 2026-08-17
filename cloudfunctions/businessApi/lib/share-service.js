const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const {
  SHARE_LIFETIME_MS,
  normalizeDocumentId,
  normalizePublicShareQuery,
  normalizeRequestKey,
  normalizeShareToken,
  publicSharePath
} = require('./share-domain')

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function deriveShareToken(secret, { actorId, businessLineId, nodeId, requestKey }) {
  if (typeof secret !== 'string' || secret.length < 32) throw createError('INTERNAL_ERROR')
  return crypto.createHmac('sha256', secret)
    .update(`${actorId}\0${businessLineId}\0${nodeId}\0${requestKey}`)
    .digest('base64url')
}

function defaultTokenFactory(context) {
  return deriveShareToken(process.env.PUBLIC_NODE_SHARE_HMAC_SECRET, context)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function validNow(clock) {
  const now = clock()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('clock must return a Date')
  return now
}

function createShareService({ repository, tokenFactory = defaultTokenFactory, clock = () => new Date() }) {
  if (!repository) throw new TypeError('repository is required')
  return {
    async createNodeShareSnapshot({ actor, input = {} }) {
      if (!actor || actor.status !== 'active' || !input || typeof input !== 'object' || Array.isArray(input) ||
          Reflect.ownKeys(input).some(key => !['businessLineId', 'nodeId', 'requestKey'].includes(key))) {
        throw createError('FORBIDDEN')
      }
      const businessLineId = normalizeDocumentId(input.businessLineId)
      const nodeId = normalizeDocumentId(input.nodeId)
      const requestKey = normalizeRequestKey(input.requestKey)
      const token = normalizeShareToken(tokenFactory({ actorId: actor._id, businessLineId, nodeId, requestKey }))
      const requestKeyHash = sha256(`${actor._id}\0${nodeId}\0${requestKey}`)
      const inputHash = sha256(`${actor._id}\0${businessLineId}\0${nodeId}`)
      const createdAt = validNow(clock)
      const expiresAt = new Date(createdAt.getTime() + SHARE_LIFETIME_MS)
      const result = await repository.createSnapshot({
        actor, businessLineId, nodeId, token, createdAt, expiresAt, requestKeyHash, inputHash
      })
      return { token, path: publicSharePath(token), expiresAt: result.expiresAt || expiresAt }
    },

    async getPublicNodeShare({ input }) {
      return repository.getPublicSnapshot(normalizePublicShareQuery(input))
    }
  }
}

module.exports = { createShareService, deriveShareToken }
