const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { MAX_SINGLE_FILE_SIZE, SUPPORTED_EVIDENCE_EXTENSIONS } = require('./evidence-policy')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/
const SESSION_LIFETIME_MS = 15 * 60 * 1000
const ORPHAN_LIFETIME_MS = 24 * 60 * 60 * 1000

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function documentId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return value
}

function fileName(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 255 ||
      /[\0-\x1f\x7f\\/]/.test(value)) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return value
}

function extensionOf(value) {
  const match = /\.([^.]+)$/.exec(value)
  const extension = match ? match[1].toLowerCase() : ''
  if (!SUPPORTED_EVIDENCE_EXTENSIONS.includes(extension)) throw createError('UNSUPPORTED_FILE_TYPE')
  return extension
}

function validActor(actor) {
  return Boolean(actor && typeof actor === 'object' && typeof actor._id === 'string' &&
    DOCUMENT_ID.test(actor._id) && actor.status === 'active')
}

function exactTemporaryCredentials(value) {
  if (!value || typeof value !== 'object' || value.secretId || value.secretKey) return null
  const credentials = value.credentials
  if (!credentials || typeof credentials !== 'object' ||
      typeof credentials.tmpSecretId !== 'string' || !credentials.tmpSecretId ||
      typeof credentials.tmpSecretKey !== 'string' || !credentials.tmpSecretKey ||
      typeof credentials.sessionToken !== 'string' || !credentials.sessionToken ||
      !Number.isSafeInteger(value.startTime) || !Number.isSafeInteger(value.expiredTime) ||
      value.expiredTime <= value.startTime) return null
  return {
    credentials: {
      tmpSecretId: credentials.tmpSecretId,
      tmpSecretKey: credentials.tmpSecretKey,
      sessionToken: credentials.sessionToken
    },
    startTime: value.startTime,
    expiredTime: value.expiredTime
  }
}

function createEvidenceUploadService({
  repository,
  credentialProvider,
  bucket,
  region,
  clock = () => new Date(),
  randomBytes = crypto.randomBytes,
  sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex')
}) {
  if (!repository || !credentialProvider || typeof credentialProvider.issue !== 'function') {
    throw new TypeError('repository and credentialProvider are required')
  }
  if (typeof bucket !== 'string' || !bucket || typeof region !== 'string' || !region) {
    throw new TypeError('bucket and region are required')
  }

  async function beginEvidenceUpload({ actor, input }) {
    if (!validActor(actor) || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    const businessLineId = documentId(input.businessLineId)
    const nodeId = documentId(input.nodeId)
    const expectedNodeVersion = input.expectedNodeVersion
    const normalizedFileName = fileName(input.fileName)
    const extension = extensionOf(normalizedFileName)
    const declaredSize = input.declaredSize
    if (!Number.isSafeInteger(expectedNodeVersion) || expectedNodeVersion < 1 ||
        !Number.isSafeInteger(declaredSize) || declaredSize < 1) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    if (declaredSize > MAX_SINGLE_FILE_SIZE) throw createError('FILE_TOO_LARGE')
    const timestamp = clock()
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) throw new TypeError('clock must return a Date')
    const evidenceId = `evidence-${randomBytes(32).toString('hex')}`
    const uploadSessionToken = randomBytes(32).toString('base64url')
    const uploadSessionExpiresAt = new Date(timestamp.getTime() + SESSION_LIFETIME_MS)
    const orphanExpiresAt = new Date(timestamp.getTime() + ORPHAN_LIFETIME_MS)
    const objectKey = `evidence-uploads/${businessLineId}/${nodeId}/${evidenceId}.${extension}`
    const reservation = {
      evidenceId,
      actorId: actor._id,
      businessLineId,
      nodeId,
      expectedNodeVersion,
      fileName: normalizedFileName,
      extension,
      declaredSize,
      objectKey,
      uploadSessionTokenHash: sha256(uploadSessionToken),
      uploadSessionExpiresAt,
      orphanExpiresAt
    }
    await repository.reserveUpload({ actor, reservation })
    let issued
    try {
      issued = exactTemporaryCredentials(await credentialProvider.issue({ objectKey, expiresAt: uploadSessionExpiresAt }))
    } catch (error) {
      throw createError('EVIDENCE_UPLOAD_UNAVAILABLE')
    }
    if (!issued) throw createError('EVIDENCE_UPLOAD_UNAVAILABLE')
    return {
      evidenceId,
      uploadSessionToken,
      bucket,
      region,
      objectKey,
      credentials: issued.credentials,
      startTime: issued.startTime,
      expiredTime: issued.expiredTime,
      expiresAt: uploadSessionExpiresAt
    }
  }

  async function finalizeEvidenceUpload({ actor, input }) {
    if (!validActor(actor) || !input || typeof input !== 'object' || Array.isArray(input) ||
        typeof input.uploadSessionToken !== 'string' || !SESSION_TOKEN.test(input.uploadSessionToken) ||
        !Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 1) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    return repository.finalizeUpload({
      actor,
      evidenceId: documentId(input.evidenceId),
      uploadSessionTokenHash: sha256(input.uploadSessionToken),
      expectedNodeVersion: input.expectedNodeVersion
    })
  }

  return { beginEvidenceUpload, finalizeEvidenceUpload }
}

module.exports = {
  SESSION_LIFETIME_MS,
  ORPHAN_LIFETIME_MS,
  createEvidenceUploadService
}
