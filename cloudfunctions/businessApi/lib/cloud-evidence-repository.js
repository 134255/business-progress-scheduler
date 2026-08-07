const crypto = require('node:crypto')

const { classifyAndValidateFile } = require('./evidence-policy')
const { normalizeCloudFileId } = require('./evidence-service')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const COLLECTIONS = Object.freeze({
  users: 'users',
  lines: 'business_lines',
  nodes: 'business_nodes',
  evidences: 'evidences'
})
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const ACTIVE_NODE_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const FROZEN_BUSINESS_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const ORPHAN_LIFETIME_MS = 24 * 60 * 60 * 1000
const DEFAULT_TEMPORARY_URL_TTL_SECONDS = 300
const MIME_TYPES = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v'
})

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function isMissingDocumentError(error) {
  const codes = [error && error.code, error && error.errCode].map(value => String(value || '').toUpperCase())
  if (codes.includes('DOCUMENT_NOT_FOUND')) return true
  const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
  return text.includes('document.get:fail') && text.includes('document with _id') && text.includes('does not exist')
}

function requireDocumentId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return value
}

function memberships(value) {
  return Array.isArray(value) ? value : []
}

function usesAccountMembership(line) {
  return Object.prototype.hasOwnProperty.call(line, 'managerUserIds') ||
    Object.prototype.hasOwnProperty.call(line, 'memberUserIds')
}

function isMember(line, actor) {
  if (usesAccountMembership(line)) {
    return [...memberships(line.managerUserIds), ...memberships(line.memberUserIds)].includes(actor._id)
  }
  return Boolean(actor.openid) &&
    [...memberships(line.managerIds), ...memberships(line.memberIds)].includes(actor.openid)
}

function isOwner(line, actor) {
  return usesAccountMembership(line)
    ? memberships(line.managerUserIds).includes(actor._id)
    : Boolean(actor.openid) && memberships(line.managerIds).includes(actor.openid)
}

function isAssignee(line, node, actor) {
  return usesAccountMembership(line)
    ? memberships(node.assigneeUserIds).includes(actor._id)
    : Boolean(actor.openid) && memberships(node.assigneeIds).includes(actor.openid)
}

function isCurrentNode(line, node) {
  if (Object.prototype.hasOwnProperty.call(line, 'currentNodeId')) return line.currentNodeId === node._id
  return Number.isSafeInteger(line.currentNodeIndex) && line.currentNodeIndex >= 0 &&
    Number(node.sequence) === line.currentNodeIndex
}

function allowedTypes(line, node) {
  const source = usesAccountMembership(line) || Object.prototype.hasOwnProperty.call(node, 'allowedEvidenceTypes')
    ? node.allowedEvidenceTypes
    : node.evidenceTypes
  return Array.isArray(source) ? source.filter(value => typeof value === 'string') : []
}

function atOrBefore(value, now) {
  if (!value) return false
  const date = value instanceof Date ? value : new Date(value)
  return !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime()
}

function isMalformedDate(value) {
  if (value === null || value === undefined) return false
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime())
}

function createCloudEvidenceRepository({
  db,
  cloud,
  clock = () => new Date(),
  idFactory = () => `evidence-${crypto.randomUUID()}`,
  temporaryUrlTtlSeconds = DEFAULT_TEMPORARY_URL_TTL_SECONDS
}) {
  if (!db) throw new TypeError('db is required')
  if (!cloud || typeof cloud.downloadFile !== 'function' || typeof cloud.getTempFileURL !== 'function') {
    throw new TypeError('cloud storage adapter is required')
  }
  if (!Number.isSafeInteger(temporaryUrlTtlSeconds) || temporaryUrlTtlSeconds < 60 ||
      temporaryUrlTtlSeconds > 3600) {
    throw new TypeError('temporaryUrlTtlSeconds must be between 60 and 3600')
  }

  async function readDocument(database, collectionName, id) {
    try {
      const result = await database.collection(collectionName).doc(id).get()
      return result && result.data ? result.data : null
    } catch (error) {
      if (isMissingDocumentError(error)) return null
      throw error
    }
  }

  async function authorizeRegistration(database, actorId, businessLineId, nodeId) {
    const actor = await readDocument(database, COLLECTIONS.users, actorId)
    if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
    const line = await readDocument(database, COLLECTIONS.lines, businessLineId)
    if (!line || line.status === 'creating') throw createError('NOT_FOUND')
    if (FROZEN_BUSINESS_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
    if (line.status !== 'active') throw createError('NODE_NOT_ACTIVE')
    if (!isMember(line, actor)) throw createError('FORBIDDEN')
    const node = await readDocument(database, COLLECTIONS.nodes, nodeId)
    if (!node || node.businessLineId !== line._id) throw createError('NOT_FOUND')
    if (!isCurrentNode(line, node) || !ACTIVE_NODE_STATUSES.has(node.status)) {
      throw createError('NODE_NOT_ACTIVE')
    }
    if (!isOwner(line, actor) && !isAssignee(line, node, actor)) throw createError('FORBIDDEN')
    return { actor, line, node, allowedTypes: allowedTypes(line, node) }
  }

  function validateRegistrationInput(actor, input) {
    const actorId = requireDocumentId(actor && actor._id)
    const businessLineId = requireDocumentId(input && input.businessLineId)
    const nodeId = requireDocumentId(input && input.nodeId)
    let fileId
    try {
      fileId = normalizeCloudFileId(input && input.fileId)
    } catch (error) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    if (typeof input.fileName !== 'string' || !input.fileName ||
        !Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    return { actorId, businessLineId, nodeId, fileId }
  }

  async function registerUpload({ actor, input }) {
    const validated = validateRegistrationInput(actor, input)
    const authorized = await db.runTransaction(transaction => authorizeRegistration(
      transaction,
      validated.actorId,
      validated.businessLineId,
      validated.nodeId
    ))
    const downloaded = await cloud.downloadFile({ fileID: validated.fileId })
    const bytes = downloaded && downloaded.fileContent
    const file = classifyAndValidateFile({
      fileName: input.fileName,
      declaredSize: input.declaredSize,
      bytes,
      allowedTypes: authorized.allowedTypes
    })
    const timestamp = clock()
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) throw new TypeError('clock must return a Date')
    const orphanExpiresAt = new Date(timestamp.getTime() + ORPHAN_LIFETIME_MS)
    const evidenceId = requireDocumentId(idFactory())

    await db.runTransaction(async transaction => {
      const current = await authorizeRegistration(
        transaction,
        validated.actorId,
        validated.businessLineId,
        validated.nodeId
      )
      if (!current.allowedTypes.map(value => value.toLowerCase()).includes(file.extension)) {
        throw createError('UNSUPPORTED_FILE_TYPE')
      }
      if (await readDocument(transaction, COLLECTIONS.evidences, evidenceId)) {
        throw createError('EVIDENCE_NOT_ATTACHABLE')
      }
      await transaction.collection(COLLECTIONS.evidences).doc(evidenceId).set({
        data: {
          businessLineId: validated.businessLineId,
          nodeId: validated.nodeId,
          feedbackId: null,
          fileId: validated.fileId,
          fileName: input.fileName,
          category: file.category,
          extension: file.extension,
          mimeType: MIME_TYPES[file.extension],
          size: file.size,
          sha256: file.sha256,
          uploadedBy: validated.actorId,
          uploadedAt: db.serverDate(),
          storageStatus: 'available',
          orphanExpiresAt,
          retentionStartedAt: null,
          purgeDueAt: null,
          purgedAt: null,
          purgeFailureCount: 0,
          lastPurgeError: ''
        }
      })
    })

    return {
      evidenceId,
      metadata: {
        fileName: input.fileName,
        category: file.category,
        extension: file.extension,
        size: file.size,
        storageStatus: 'available',
        orphanExpiresAt
      }
    }
  }

  async function getAccessGrant({ actor, evidenceId }) {
    const actorId = requireDocumentId(actor && actor._id)
    const normalizedEvidenceId = requireDocumentId(evidenceId)
    const now = clock()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('clock must return a Date')

    const evidence = await db.runTransaction(async transaction => {
      const currentActor = await readDocument(transaction, COLLECTIONS.users, actorId)
      if (!currentActor || currentActor.status !== 'active') throw createError('FORBIDDEN')
      const currentEvidence = await readDocument(transaction, COLLECTIONS.evidences, normalizedEvidenceId)
      if (!currentEvidence) throw createError('NOT_FOUND')
      const line = await readDocument(transaction, COLLECTIONS.lines, currentEvidence.businessLineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      if (!isMember(line, currentActor)) throw createError('FORBIDDEN')
      if (currentEvidence.storageStatus !== 'available' || currentEvidence.purgedAt ||
          isMalformedDate(currentEvidence.orphanExpiresAt) || isMalformedDate(currentEvidence.purgeDueAt) ||
          atOrBefore(currentEvidence.orphanExpiresAt, now) || atOrBefore(currentEvidence.purgeDueAt, now)) {
        throw createError('EVIDENCE_EXPIRED')
      }
      if (typeof currentEvidence.fileName !== 'string' || !currentEvidence.fileName ||
          !['image', 'pdf', 'video'].includes(currentEvidence.category)) {
        throw createError('EVIDENCE_EXPIRED')
      }
      try {
        normalizeCloudFileId(currentEvidence.fileId)
      } catch (error) {
        throw createError('EVIDENCE_EXPIRED')
      }
      return currentEvidence
    })

    const response = await cloud.getTempFileURL({
      fileList: [{ fileID: evidence.fileId, maxAge: temporaryUrlTtlSeconds }]
    })
    const item = response && Array.isArray(response.fileList) ? response.fileList[0] : null
    if (!item || item.status !== 0 || item.fileID !== evidence.fileId ||
        typeof item.tempFileURL !== 'string' || !item.tempFileURL.startsWith('https://')) {
      throw new Error('temporary evidence URL unavailable')
    }
    return {
      url: item.tempFileURL,
      fileName: evidence.fileName,
      category: evidence.category,
      expiresAt: new Date(now.getTime() + temporaryUrlTtlSeconds * 1000)
    }
  }

  return { registerUpload, getAccessGrant }
}

module.exports = {
  COLLECTIONS,
  ORPHAN_LIFETIME_MS,
  createCloudEvidenceRepository
}
