const crypto = require('node:crypto')

const { FEEDBACK_TOTAL_LIMIT } = require('./evidence-policy')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { classifyEvidenceRetention } = require('./evidence-retention')

const COLLECTIONS = Object.freeze({
  users: 'users', lines: 'business_lines', nodes: 'business_nodes',
  feedback: 'node_feedback', evidences: 'evidences', audit: 'audit_logs'
})
const ACTIVE_NODE_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const FROZEN_LINE_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const CLAIM_LIFETIME_MS = 15 * 60 * 1000
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const DEFAULT_CHUNK_SIZE = 40
const QUERY_PAGE_SIZE = 100

function createError(code, extra = {}) {
  const error = new Error(code)
  error.code = code
  Object.assign(error, extra)
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function clone(value) {
  if (value instanceof Date) return new Date(value)
  if (Array.isArray(value)) return value.map(clone)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
}

function isMissingDocumentError(error) {
  const codes = [error && error.code, error && error.errCode].map(value => String(value || '').toUpperCase())
  if (codes.includes('DOCUMENT_NOT_FOUND')) return true
  const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
  return text.includes('document.get:fail') && text.includes('document with _id') && text.includes('does not exist')
}

function membership(value) {
  return Array.isArray(value) ? value : []
}

function hasAccountRelationship(value) {
  return Boolean(value && typeof value === 'object' && Object.getOwnPropertyNames(value)
    .some(key => /UserIds?$/.test(key)))
}

function accountSchema(line, node) {
  return hasAccountRelationship(line) || hasAccountRelationship(node)
}

function isAccountMember(line, actorId) {
  return [...membership(line.managerUserIds), ...membership(line.memberUserIds)].includes(actorId)
}

function isLegacyMember(line, actor) {
  return Boolean(actor.openid) && [...membership(line.managerIds), ...membership(line.memberIds)].includes(actor.openid)
}

function isCurrentNode(line, node) {
  if (Object.prototype.hasOwnProperty.call(line, 'currentNodeId')) return line.currentNodeId === node._id
  return Number.isSafeInteger(line.currentNodeIndex) && Number(node.sequence) === line.currentNodeIndex
}

function processorIds(node) {
  return node && node.workflowMode === 'review'
    ? membership(node.processorUserIds)
    : membership(node && node.assigneeUserIds)
}

function parseDeadline(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw createError('EVIDENCE_NOT_ATTACHABLE')
    return new Date(value)
  }
  if (typeof value !== 'string' ||
      !/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value)) {
    throw createError('EVIDENCE_NOT_ATTACHABLE')
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return date
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function increment(value) {
  if (!safeInteger(value) || value === Number.MAX_SAFE_INTEGER) throw createError('VERSION_CONFLICT')
  return value + 1
}

function publicResult(feedback) {
  return {
    feedbackId: feedback._id,
    revision: feedback.revision,
    nodeStatus: feedback.status,
    lineStatus: feedback.lineStatus
  }
}

function evidenceProjection(evidence, retention) {
  return {
    evidenceId: evidence._id,
    fileName: evidence.fileName,
    category: evidence.category,
    extension: evidence.extension,
    size: evidence.size,
    storageStatus: evidence.storageStatus,
    purgeDueAt: retention.effectivePurgeDueAt,
    purgedAt: evidence.purgedAt === undefined ? null : evidence.purgedAt
  }
}

function feedbackProjection(feedback, evidences) {
  const legacy = feedback.publishState === undefined
  const result = {
    feedbackId: feedback._id,
    businessLineId: feedback.businessLineId,
    nodeId: feedback.nodeId,
    status: feedback.status,
    comment: typeof feedback.comment === 'string' ? feedback.comment : '',
    submittedBy: legacy ? null : feedback.submittedBy,
    submittedAt: feedback.submittedAt === undefined ? feedback.createdAt : feedback.submittedAt,
    evidences
  }
  if (legacy) result.submittedByLabel = '历史用户'
  for (const key of ['revision', 'nodeCode', 'nodeName', 'fieldValues']) {
    if (Object.prototype.hasOwnProperty.call(feedback, key)) result[key] = clone(feedback[key])
  }
  return result
}

function createCloudFeedbackRepository({
  db,
  clock = () => new Date(),
  claimChunkSize = DEFAULT_CHUNK_SIZE,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}) {
  if (!db) throw new TypeError('db is required')
  if (!Number.isSafeInteger(claimChunkSize) || claimChunkSize < 1 || claimChunkSize > 40) {
    throw new TypeError('claimChunkSize must be between 1 and 40')
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

  function now() {
    const value = clock()
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('clock must return a Date')
    return value
  }

  function identity(value) {
    const { actor, input, fieldSnapshots, evidenceTotalBytes, requestFingerprint } = value
    if (!actor || typeof actor._id !== 'string' || !input || !Array.isArray(input.evidenceIds) ||
        new Set(input.evidenceIds).size !== input.evidenceIds.length ||
        typeof requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(requestFingerprint) ||
        !Number.isSafeInteger(evidenceTotalBytes) || evidenceTotalBytes < 0 || evidenceTotalBytes > FEEDBACK_TOTAL_LIMIT) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    const requestHash = hash(`${actor._id}\0${input.nodeId}\0${input.requestKey}`)
    const evidenceDigest = hash(JSON.stringify(input.evidenceIds))
    const inputIdentity = [
      actor._id, input.businessLineId, input.nodeId, input.expectedNodeVersion,
      input.status, fieldSnapshots, input.comment, evidenceDigest, input.evidenceIds.length,
      evidenceTotalBytes, requestFingerprint
    ]
    if (input.action) inputIdentity.splice(5, 0, input.action)
    const inputHash = hash(JSON.stringify(inputIdentity))
    return { feedbackId: `feedback-${requestHash}`, requestHash, evidenceDigest, inputHash, requestFingerprint }
  }

  function assertActiveAccountSubmission(actor, line, node, input, expectedVersion = true) {
    if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
    if (!line || line.status === 'creating') throw createError('NOT_FOUND')
    if (FROZEN_LINE_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
    if (line.status !== 'active') throw createError('NODE_NOT_ACTIVE')
    if (!node || node.businessLineId !== line._id) throw createError('NOT_FOUND')
    if (!accountSchema(line, node) || !isAccountMember(line, actor._id) ||
        !processorIds(node).includes(actor._id)) {
      throw createError('FORBIDDEN')
    }
    if (!isCurrentNode(line, node) || !ACTIVE_NODE_STATUSES.has(node.status)) {
      if (input.status === 'completed' && node.status === 'completed') throw createError('VERSION_CONFLICT')
      throw createError('NODE_NOT_ACTIVE')
    }
    if (expectedVersion && node.version !== input.expectedNodeVersion) throw createError('VERSION_CONFLICT')
  }

  function assertPublishedRetry(actor, line, node, reservation) {
    if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
    if (!line || line.status === 'creating' || !node || node.businessLineId !== line._id ||
        reservation.businessLineId !== line._id || reservation.nodeId !== node._id) {
      throw createError('NOT_FOUND')
    }
    if (!accountSchema(line, node) || !isAccountMember(line, actor._id) ||
        !processorIds(node).includes(actor._id)) throw createError('FORBIDDEN')
  }

  function assertCurrentActorAuthorization(actor, line, node) {
    if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
    if (!line || line.status === 'creating' || !node || node.businessLineId !== line._id) {
      throw createError('NOT_FOUND')
    }
    if (!accountSchema(line, node) || !isAccountMember(line, actor._id) ||
        !processorIds(node).includes(actor._id)) throw createError('FORBIDDEN')
  }

  function assertContentionPollAuthorization(actor, line, node) {
    if (!actor || actor.status !== 'active' || !line || line.status === 'creating' || !node ||
        node.businessLineId !== line._id || !accountSchema(line, node) ||
        !isAccountMember(line, actor._id) || !processorIds(node).includes(actor._id)) {
      throw createError('FORBIDDEN')
    }
  }

  function assertExactReservationRelationship(reservation, { feedbackId, businessLineId, nodeId }) {
    if (!reservation || reservation._id !== feedbackId ||
        reservation.businessLineId !== businessLineId || reservation.nodeId !== nodeId) {
      throw createError('VERSION_CONFLICT')
    }
  }

  function assertExactPublishedRetry(current, reservation, id, value) {
    assertPublishedRetry(current.actor, current.line, current.node, reservation)
    if (!reservation || reservation.publishState !== 'published' || reservation._id !== id.feedbackId ||
        reservation.requestHash !== id.requestHash || reservation.inputHash !== id.inputHash ||
        reservation.requestFingerprint !== id.requestFingerprint || reservation.submittedBy !== value.actor._id) {
      throw createError('VERSION_CONFLICT')
    }
  }

  async function readSubmissionDocuments(database, actorId, input) {
    const actor = await readDocument(database, COLLECTIONS.users, actorId)
    const line = await readDocument(database, COLLECTIONS.lines, input.businessLineId)
    const node = await readDocument(database, COLLECTIONS.nodes, input.nodeId)
    return { actor, line, node }
  }

  function leaseExpiredOrMalformed(value, at) {
    try {
      const expiresAt = parseDeadline(value)
      return !expiresAt || expiresAt.getTime() <= at.getTime()
    } catch (error) {
      return true
    }
  }

  async function markReservationAborting(transaction, { reservation, node, reason, at }) {
    if (!reservation || reservation.publishState !== 'reserved') return false
    await transaction.collection(COLLECTIONS.feedback).doc(reservation._id).update({ data: {
      publishState: 'aborting',
      recoveryCount: increment(reservation.recoveryCount === undefined ? 0 : reservation.recoveryCount),
      recoveryReason: reason,
      recoveryStartedAt: at,
      updatedAt: db.serverDate()
    } })
    if (node && node.feedbackClaimId === reservation._id) {
      await transaction.collection(COLLECTIONS.nodes).doc(node._id).update({ data: {
        feedbackClaimId: db.command.remove(),
        feedbackClaimHash: db.command.remove(),
        feedbackClaimExpiresAt: db.command.remove()
      } })
    }
    return true
  }

  async function getSubmissionContext({ actor, businessLineId, nodeId, evidenceIds }) {
    const input = { businessLineId, nodeId, status: 'in_progress' }
    const context = await db.runTransaction(async transaction => {
      const documents = await readSubmissionDocuments(transaction, actor && actor._id, input)
      assertActiveAccountSubmission(documents.actor, documents.line, documents.node, input, false)
      return documents
    })
    const evidences = []
    for (const evidenceId of evidenceIds) {
      const evidence = await readDocument(db, COLLECTIONS.evidences, evidenceId)
      if (!evidence) throw createError('EVIDENCE_NOT_ATTACHABLE')
      evidences.push(evidence)
    }
    return { line: context.line, node: context.node, evidences }
  }

  async function findPublishedFeedback(value) {
    const { actor, input, requestFingerprint } = value
    if (!actor || typeof actor._id !== 'string' || !input || typeof input.nodeId !== 'string' ||
        typeof input.requestKey !== 'string' || typeof requestFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(requestFingerprint)) throw createError('VERSION_CONFLICT')
    const requestHash = hash(`${actor._id}\0${input.nodeId}\0${input.requestKey}`)
    const feedbackId = `feedback-${requestHash}`
    return db.runTransaction(async transaction => {
      const current = await readSubmissionDocuments(transaction, actor._id, input)
      assertCurrentActorAuthorization(current.actor, current.line, current.node)
      if (value.legacyOnly === true && current.node.workflowMode === 'review') {
        throw createError('NODE_PENDING_REVIEW')
      }
      const existing = await readDocument(transaction, COLLECTIONS.feedback, feedbackId)
      if (!existing || existing.publishState !== 'published') return null
      assertPublishedRetry(current.actor, current.line, current.node, existing)
      if (existing.requestHash !== requestHash || existing.requestFingerprint !== requestFingerprint ||
          existing.submittedBy !== actor._id) {
        throw createError('VERSION_CONFLICT')
      }
      return publicResult(existing)
    })
  }

  async function beginFeedback(value) {
    const id = identity(value)
    const at = now()
    return db.runTransaction(async transaction => {
      const current = await readSubmissionDocuments(transaction, value.actor._id, value.input)
      assertCurrentActorAuthorization(current.actor, current.line, current.node)
      const existing = await readDocument(transaction, COLLECTIONS.feedback, id.feedbackId)
      if (existing) {
        assertExactReservationRelationship(existing, {
          feedbackId: id.feedbackId,
          businessLineId: value.input.businessLineId,
          nodeId: value.input.nodeId
        })
        if (existing.publishState === 'published') {
          assertPublishedRetry(current.actor, current.line, current.node, existing)
        }
        if (existing.requestHash !== id.requestHash || existing.inputHash !== id.inputHash ||
            existing.requestFingerprint !== id.requestFingerprint ||
            existing.submittedBy !== value.actor._id) throw createError('VERSION_CONFLICT')
        if (existing.publishState === 'published') {
          return { ...id, published: publicResult(existing) }
        }
      }
      if (existing && existing.publishState === 'reserved' && current.node &&
          current.node.feedbackClaimId === id.feedbackId) {
        assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
        if (leaseExpiredOrMalformed(existing.claimExpiresAt, at)) {
          const recoveryRequired = await markReservationAborting(transaction, {
            reservation: existing,
            node: current.node,
            reason: 'CLAIM_EXPIRED',
            at
          })
          return { ...id, recoveryRequired, recoveryAt: at }
        }
        return { ...id, cursor: existing.claimedCount }
      }
      if (existing && existing.publishState === 'aborting') {
        assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
        return { ...id, recoveryRequired: true, recoveryAt: existing.recoveryStartedAt || at }
      }
      if (value.input.status === 'completed' && current.node && current.node.status === 'completed') {
        const winnerId = current.node.latestFeedbackId || current.node.feedbackClaimId
        const winner = winnerId ? await readDocument(transaction, COLLECTIONS.feedback, winnerId) : null
        const completedFlow = winner && winner.publishState === 'published' && winner.status === 'completed' &&
          winner.businessLineId === value.input.businessLineId && winner.nodeId === value.input.nodeId &&
          current.line && (current.line.status === 'completed' || !isCurrentNode(current.line, current.node))
        if (completedFlow) throw createError('NODE_ALREADY_COMPLETED')
      }
      assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
      if (current.node.workflowMode === 'review' &&
          (!['save_progress', 'mark_blocked'].includes(value.input.action) ||
            !safeInteger(current.node.processingRoundNumber, { minimum: 1 }))) {
        throw createError('VALIDATION_ERROR')
      }
      if (value.input.status === 'completed' && current.node.requiresEvidence && !value.input.evidenceIds.length) {
        throw createError('EVIDENCE_NOT_ATTACHABLE')
      }
      if (current.node.feedbackClaimId && current.node.feedbackClaimId !== id.feedbackId) {
        const winner = await readDocument(transaction, COLLECTIONS.feedback, current.node.feedbackClaimId)
        if (winner && winner.publishState === 'published') {
          if (winner.status === 'completed' && current.node.status === 'completed') {
            throw createError('NODE_ALREADY_COMPLETED')
          }
          throw createError('VERSION_CONFLICT')
        }
        throw createError('NODE_COMMIT_IN_PROGRESS', { winnerFeedbackId: current.node.feedbackClaimId })
      }
      const claimExpiresAt = new Date(at.getTime() + CLAIM_LIFETIME_MS)
      const currentRevision = current.node.latestFeedbackRevision === undefined ? 0 : current.node.latestFeedbackRevision
      const plannedRevision = increment(currentRevision)
      const reservation = {
        businessLineId: current.line._id,
        nodeId: current.node._id,
        nodeCode: current.node.nodeCode,
        nodeName: current.node.name,
        submittedBy: current.actor._id,
        status: value.input.status,
        ...(current.node.workflowMode === 'review'
          ? {
              action: value.input.action,
              processingRoundNumber: current.node.processingRoundNumber,
              blockedReason: value.input.action === 'mark_blocked' ? value.input.comment : ''
            }
          : {}),
        fieldValues: clone(value.fieldSnapshots),
        comment: value.input.comment,
        publishState: 'reserved',
        requestHash: id.requestHash,
        requestFingerprint: id.requestFingerprint,
        inputHash: id.inputHash,
        evidenceDigest: id.evidenceDigest,
        evidenceCount: value.input.evidenceIds.length,
        evidenceTotalBytes: value.evidenceTotalBytes,
        claimedCount: 0,
        claimedBytes: 0,
        claimedDigest: hash(JSON.stringify([])),
        claimedStateDigest: hash(JSON.stringify([0, 0, hash(JSON.stringify([]))])),
        expectedNodeVersion: value.input.expectedNodeVersion,
        plannedRevision,
        freezesLine: value.input.status === 'completed' && Number(current.node.sequence) + 1 >= Number(current.line.nodeCount),
        transitionAt: at,
        claimExpiresAt,
        recoveryCount: existing && existing.recoveryCount !== undefined ? existing.recoveryCount : 0,
        createdAt: existing ? existing.createdAt : db.serverDate(),
        updatedAt: db.serverDate()
      }
      await transaction.collection(COLLECTIONS.feedback).doc(id.feedbackId).set({ data: reservation })
      await transaction.collection(COLLECTIONS.nodes).doc(current.node._id).update({
        data: { feedbackClaimId: id.feedbackId, feedbackClaimHash: id.requestHash, feedbackClaimExpiresAt: claimExpiresAt }
      })
      return { ...id, cursor: 0 }
    })
  }

  function validateEvidence(evidence, value, reservation, at) {
    if (!evidence || evidence.businessLineId !== value.input.businessLineId ||
        evidence.nodeId !== value.input.nodeId || evidence.uploadedBy !== value.actor._id ||
        evidence.storageStatus !== 'available' || evidence.purgedAt !== null && evidence.purgedAt !== undefined) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    if (evidence.feedbackId !== null && evidence.feedbackId !== undefined && evidence.feedbackId !== reservation._id) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    const orphan = parseDeadline(evidence.orphanExpiresAt)
    const purge = parseDeadline(evidence.purgeDueAt)
    if ((orphan && orphan.getTime() <= at.getTime() && evidence.feedbackId !== reservation._id) ||
        (purge && purge.getTime() <= at.getTime())) throw createError('EVIDENCE_NOT_ATTACHABLE')
    if (!Number.isSafeInteger(evidence.size) || evidence.size <= 0) throw createError('EVIDENCE_NOT_ATTACHABLE')
  }

  async function claimEvidenceChunk(value, reservationIdentity) {
    const id = identity(value)
    const at = now()
    return db.runTransaction(async transaction => {
      const current = await readSubmissionDocuments(transaction, value.actor._id, value.input)
      assertCurrentActorAuthorization(current.actor, current.line, current.node)
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, id.feedbackId)
      if (id.feedbackId !== reservationIdentity.feedbackId) {
        throw createError('VERSION_CONFLICT')
      }
      if (reservation && reservation.publishState === 'published') {
        assertExactPublishedRetry(current, reservation, id, value)
        return { done: true, published: publicResult(reservation) }
      }
      assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
      if (!reservation || reservation.inputHash !== id.inputHash || reservation.requestHash !== id.requestHash) {
        throw createError('VERSION_CONFLICT')
      }
      const cursorValid = safeInteger(reservation.evidenceCount, { maximum: value.input.evidenceIds.length }) &&
        reservation.evidenceCount === value.input.evidenceIds.length &&
        safeInteger(reservation.claimedCount, { maximum: reservation.evidenceCount }) &&
        safeInteger(reservation.claimedBytes, { maximum: reservation.evidenceTotalBytes }) &&
        safeInteger(reservation.evidenceTotalBytes, { maximum: FEEDBACK_TOTAL_LIMIT }) &&
        reservation.evidenceTotalBytes === value.evidenceTotalBytes &&
        reservation.claimedStateDigest === hash(JSON.stringify([
          reservation.claimedCount, reservation.claimedBytes, reservation.claimedDigest
        ]))
      if (reservation.publishState !== 'reserved' || current.node.feedbackClaimId !== id.feedbackId || !cursorValid ||
          reservation.claimedDigest !== hash(JSON.stringify(value.input.evidenceIds.slice(0, reservation.claimedCount)))) {
        throw createError('VERSION_CONFLICT')
      }
      const ids = value.input.evidenceIds.slice(reservation.claimedCount, reservation.claimedCount + claimChunkSize)
      if (reservation.claimedCount < reservation.evidenceCount && ids.length === 0) throw createError('VERSION_CONFLICT')
      let claimedBytes = reservation.claimedBytes
      for (const evidenceId of ids) {
        const evidence = await readDocument(transaction, COLLECTIONS.evidences, evidenceId)
        validateEvidence(evidence, value, reservation, at)
        if (evidence.feedbackId !== id.feedbackId) {
          if (evidence.size > FEEDBACK_TOTAL_LIMIT - claimedBytes) throw createError('FEEDBACK_TOTAL_TOO_LARGE')
          claimedBytes += evidence.size
        } else {
          claimedBytes += evidence.size
        }
        await transaction.collection(COLLECTIONS.evidences).doc(evidenceId).update({
          data: {
            feedbackId: id.feedbackId,
            feedbackRevision: reservation.plannedRevision,
            attachmentState: 'attached',
            attachmentClaimExpiresAt: reservation.claimExpiresAt,
            attachmentPreviousOrphanExpiresAt: evidence.feedbackId === id.feedbackId
              ? evidence.attachmentPreviousOrphanExpiresAt
              : evidence.orphanExpiresAt,
            orphanExpiresAt: null,
            retentionStartedAt: null,
            purgeDueAt: null,
            retentionScope: 'business_line',
            retentionSource: 'node_feedback',
            ...(reservation.processingRoundNumber === undefined
              ? {}
              : { processingRoundNumber: reservation.processingRoundNumber })
          }
        })
      }
      const claimedCount = reservation.claimedCount + ids.length
      if (!safeInteger(claimedCount, { maximum: reservation.evidenceCount }) ||
          !safeInteger(claimedBytes, { maximum: reservation.evidenceTotalBytes })) throw createError('VERSION_CONFLICT')
      const claimExpiresAt = new Date(at.getTime() + CLAIM_LIFETIME_MS)
      await transaction.collection(COLLECTIONS.feedback).doc(id.feedbackId).update({
        data: {
          claimedCount,
          claimedBytes,
          claimedDigest: hash(JSON.stringify(value.input.evidenceIds.slice(0, claimedCount))),
          claimedStateDigest: hash(JSON.stringify([
            claimedCount, claimedBytes, hash(JSON.stringify(value.input.evidenceIds.slice(0, claimedCount)))
          ])),
          claimExpiresAt,
          updatedAt: db.serverDate()
        }
      })
      await transaction.collection(COLLECTIONS.nodes).doc(value.input.nodeId).update({
        data: { feedbackClaimExpiresAt: claimExpiresAt }
      })
      return { done: claimedCount === value.input.evidenceIds.length, cursor: claimedCount }
    })
  }

  function nextNodeId(lineId, sequence) {
    return `${lineId}-node-${String(sequence + 2).padStart(3, '0')}`
  }

  async function finalizeFeedback(value, reservationIdentity) {
    const id = identity(value)
    return db.runTransaction(async transaction => {
      const current = await readSubmissionDocuments(transaction, value.actor._id, value.input)
      assertCurrentActorAuthorization(current.actor, current.line, current.node)
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, id.feedbackId)
      if (reservation && reservation.publishState === 'published') {
        assertExactPublishedRetry(current, reservation, id, value)
        return publicResult(reservation)
      }
      assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
      const cursorValid = reservation && reservation.publishState === 'reserved' &&
        reservation.inputHash === id.inputHash && reservation.requestFingerprint === id.requestFingerprint &&
        current.node.feedbackClaimId === id.feedbackId &&
        safeInteger(reservation.evidenceCount, { maximum: value.input.evidenceIds.length }) &&
        safeInteger(reservation.claimedCount, { maximum: reservation.evidenceCount }) &&
        safeInteger(reservation.evidenceTotalBytes, { maximum: FEEDBACK_TOTAL_LIMIT }) &&
        safeInteger(reservation.claimedBytes, { maximum: reservation.evidenceTotalBytes }) &&
        reservation.claimedStateDigest === hash(JSON.stringify([
          reservation.claimedCount, reservation.claimedBytes, reservation.claimedDigest
        ])) &&
        reservation.claimedCount === reservation.evidenceCount &&
        reservation.claimedCount === value.input.evidenceIds.length &&
        reservation.claimedBytes === reservation.evidenceTotalBytes &&
        reservation.claimedBytes === value.evidenceTotalBytes && reservation.claimedDigest === id.evidenceDigest
      if (!cursorValid) throw createError('VERSION_CONFLICT')
      const revision = reservation.plannedRevision
      const latestRevision = current.node.latestFeedbackRevision === undefined ? 0 : current.node.latestFeedbackRevision
      if (!safeInteger(revision, { minimum: 1 }) || revision !== increment(latestRevision)) throw createError('VERSION_CONFLICT')
      const nodeChanges = {
        status: value.input.status,
        version: increment(current.node.version),
        latestFeedbackRevision: revision,
        latestFeedbackId: id.feedbackId,
        latestComment: value.input.comment,
        feedbackClaimId: db.command.remove(),
        feedbackClaimHash: db.command.remove(),
        feedbackClaimExpiresAt: db.command.remove(),
        updatedAt: db.serverDate()
      }
      if (current.node.workflowMode === 'review') {
        if (!['save_progress', 'mark_blocked'].includes(value.input.action) ||
            !safeInteger(current.node.processingRoundNumber, { minimum: 1 }) ||
            reservation.processingRoundNumber !== current.node.processingRoundNumber) {
          throw createError('VERSION_CONFLICT')
        }
        nodeChanges.blockedReason = value.input.action === 'mark_blocked' ? value.input.comment : ''
      }
      if (value.input.status === 'completed') nodeChanges.completedAt = reservation.transitionAt
      await transaction.collection(COLLECTIONS.nodes).doc(current.node._id).update({ data: nodeChanges })

      let lineStatus = 'active'
      if (value.input.status === 'completed' && reservation.freezesLine) {
        lineStatus = 'completed'
        const purgeDueAt = new Date(new Date(reservation.transitionAt).getTime() + RETENTION_MS)
        await transaction.collection(COLLECTIONS.lines).doc(current.line._id).update({ data: {
          status: 'completed', progress: 100, version: increment(current.line.version),
          completedAt: reservation.transitionAt, frozenAt: reservation.transitionAt,
          retentionStartedAt: reservation.transitionAt, purgeDueAt, updatedAt: db.serverDate()
        } })
      } else if (value.input.status === 'completed') {
        const nextId = nextNodeId(current.line._id, current.node.sequence)
        const next = await readDocument(transaction, COLLECTIONS.nodes, nextId)
        if (!next || next.businessLineId !== current.line._id || Number(next.sequence) !== Number(current.node.sequence) + 1 ||
            next.status !== 'waiting') throw createError('NODE_NOT_ACTIVE')
        const nextChanges = {
          status: 'ready', version: increment(next.version), updatedAt: db.serverDate()
        }
        if (next.activatedAt === undefined || next.activatedAt === null) {
          nextChanges.activatedAt = reservation.transitionAt
        }
        await transaction.collection(COLLECTIONS.nodes).doc(nextId).update({ data: nextChanges })
        const progress = Math.floor(((Number(current.node.sequence) + 1) / Number(current.line.nodeCount)) * 100)
        await transaction.collection(COLLECTIONS.lines).doc(current.line._id).update({ data: {
          currentNodeId: nextId, currentNodeIndex: next.sequence, currentNodeName: next.name,
          progress, version: increment(current.line.version), updatedAt: db.serverDate()
        } })
      } else {
        await transaction.collection(COLLECTIONS.lines).doc(current.line._id).update({ data: {
          version: increment(current.line.version), updatedAt: db.serverDate()
        } })
      }
      await transaction.collection(COLLECTIONS.feedback).doc(id.feedbackId).update({ data: {
        publishState: 'published', revision, lineStatus, submittedAt: reservation.transitionAt,
        claimExpiresAt: db.command.remove(), updatedAt: db.serverDate()
      } })
      await transaction.collection(COLLECTIONS.audit).doc(`${id.feedbackId}-submitted`).set({ data: {
        actorId: current.actor._id, action: 'SUBMIT_NODE_FEEDBACK', targetType: 'business_node',
        targetId: current.node._id, feedbackId: id.feedbackId, revision,
        resultStatus: value.input.status, evidenceCount: reservation.evidenceCount,
        createdAt: db.serverDate()
      } })
      return { feedbackId: id.feedbackId, revision, nodeStatus: value.input.status, lineStatus }
    })
  }

  async function waitForWinner(error, { actorId, businessLineId, nodeId }) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const at = now()
      const outcome = await db.runTransaction(async transaction => {
        const current = await readSubmissionDocuments(transaction, actorId, { businessLineId, nodeId })
        assertContentionPollAuthorization(current.actor, current.line, current.node)
        const winner = await readDocument(transaction, COLLECTIONS.feedback, error.winnerFeedbackId)
        if (current.node.feedbackClaimId !== error.winnerFeedbackId) return { type: 'retry' }
        if (winner) {
          assertExactReservationRelationship(winner, {
            feedbackId: error.winnerFeedbackId,
            businessLineId,
            nodeId
          })
        }
        if (winner && winner.publishState === 'published') {
          const completedFlow = winner.businessLineId === businessLineId && winner.nodeId === nodeId &&
            winner.status === 'completed' && current.node.status === 'completed' &&
            (current.line.status === 'completed' || !isCurrentNode(current.line, current.node))
          return { type: 'error', code: completedFlow ? 'NODE_ALREADY_COMPLETED' : 'VERSION_CONFLICT' }
        }
        if (winner && winner.publishState === 'aborted') {
          if (current.node.feedbackClaimId === error.winnerFeedbackId) {
            await transaction.collection(COLLECTIONS.nodes).doc(current.node._id).update({ data: {
              feedbackClaimId: db.command.remove(), feedbackClaimHash: db.command.remove(),
              feedbackClaimExpiresAt: db.command.remove()
            } })
          }
          return { type: 'retry' }
        }
        if (winner && winner.publishState === 'reserved') {
          if (leaseExpiredOrMalformed(winner.claimExpiresAt, at)) {
            const recoveryRequired = await markReservationAborting(transaction, {
              reservation: winner,
              node: current.node,
              reason: 'CLAIM_EXPIRED',
              at
            })
            return recoveryRequired
              ? { type: 'recover', feedbackId: winner._id }
              : { type: 'wait' }
          }
          return { type: 'reserved' }
        }
        if (winner && winner.publishState === 'aborting') {
          return { type: 'recover', feedbackId: winner._id }
        }
        if (current.node.status === 'completed') return { type: 'error', code: 'VERSION_CONFLICT' }
        if (!current.node.feedbackClaimId) return { type: 'retry' }
        return { type: 'wait' }
      })
      if (outcome.type === 'error') throw createError(outcome.code)
      if (outcome.type === 'retry') return null
      if (outcome.type === 'recover') {
        await continueReservationRollback(outcome.feedbackId, at)
        return null
      }
      await wait(5)
    }
    throw createError('FEEDBACK_COMMIT_IN_PROGRESS')
  }

  async function continueReservationRollback(feedbackId, at = now()) {
    const current = await readDocument(db, COLLECTIONS.feedback, feedbackId)
    if (!current || current.publishState !== 'aborting') return false
    const claimed = await readAll(() => db.collection(COLLECTIONS.evidences)
      .where({ feedbackId }).orderBy('uploadedAt', 'asc'))
    for (let offset = 0; offset < claimed.length; offset += claimChunkSize) {
      const chunk = claimed.slice(offset, offset + claimChunkSize)
      await db.runTransaction(async transaction => {
        const reservation = await readDocument(transaction, COLLECTIONS.feedback, feedbackId)
        if (!reservation || reservation.publishState !== 'aborting') return
        for (const item of chunk) {
          const evidence = await readDocument(transaction, COLLECTIONS.evidences, item._id)
          if (!evidence || evidence.feedbackId !== feedbackId) continue
          await transaction.collection(COLLECTIONS.evidences).doc(item._id).update({ data: {
            feedbackId: null,
            feedbackRevision: null,
            attachmentState: db.command.remove(),
            attachmentClaimExpiresAt: db.command.remove(),
            orphanExpiresAt: evidence.attachmentPreviousOrphanExpiresAt,
            attachmentPreviousOrphanExpiresAt: db.command.remove(),
            retentionStartedAt: evidence.retentionStartedAt === undefined ? null : evidence.retentionStartedAt,
            purgeDueAt: evidence.purgeDueAt === undefined ? null : evidence.purgeDueAt,
            retentionScope: null,
            retentionSource: null
          } })
        }
      })
    }
    return db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, feedbackId)
      if (!reservation || reservation.publishState !== 'aborting') {
        return Boolean(reservation && reservation.publishState === 'aborted')
      }
      await transaction.collection(COLLECTIONS.feedback).doc(feedbackId).update({ data: {
        publishState: 'aborted', abortedAt: at, claimExpiresAt: db.command.remove(), updatedAt: db.serverDate()
      } })
      return true
    })
  }

  async function startAuthorizedReservationRecovery(value, feedbackId, reason) {
    const id = identity(value)
    if (id.feedbackId !== feedbackId) throw createError('VERSION_CONFLICT')
    const at = now()
    const recoveryRequired = await db.runTransaction(async transaction => {
      const current = await readSubmissionDocuments(transaction, value.actor._id, value.input)
      assertCurrentActorAuthorization(current.actor, current.line, current.node)
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, feedbackId)
      if (!reservation || reservation.publishState === 'published' || reservation.publishState === 'aborted') return false
      if (reservation.businessLineId !== value.input.businessLineId || reservation.nodeId !== value.input.nodeId ||
          reservation.submittedBy !== value.actor._id || reservation.requestHash !== id.requestHash ||
          reservation.inputHash !== id.inputHash) throw createError('VERSION_CONFLICT')
      if (reservation.publishState === 'aborting') return true
      return markReservationAborting(transaction, {
        reservation,
        node: current.node,
        reason,
        at
      })
    })
    if (!recoveryRequired) return false
    return continueReservationRollback(feedbackId, at)
  }

  async function recoverExpiredReservation(feedbackId) {
    const at = now()
    const recoveryRequired = await db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, feedbackId)
      if (!reservation || reservation.publishState === 'published' || reservation.publishState === 'aborted') return false
      if (reservation.publishState === 'aborting') return true
      if (!leaseExpiredOrMalformed(reservation.claimExpiresAt, at)) return false
      const node = await readDocument(transaction, COLLECTIONS.nodes, reservation.nodeId)
      return markReservationAborting(transaction, {
        reservation,
        node: node && node.businessLineId === reservation.businessLineId ? node : null,
        reason: 'CLAIM_EXPIRED',
        at
      })
    })
    if (!recoveryRequired) return false
    return continueReservationRollback(feedbackId, at)
  }

  async function commitFeedback(value) {
    let reservation
    try {
      for (;;) {
        try {
          reservation = await beginFeedback(value)
          if (reservation.recoveryRequired) {
            await continueReservationRollback(reservation.feedbackId, reservation.recoveryAt || now())
            reservation = undefined
            continue
          }
          break
        } catch (error) {
          if (error.code !== 'NODE_COMMIT_IN_PROGRESS') throw error
          const result = await waitForWinner(error, {
            actorId: value.actor._id,
            businessLineId: value.input.businessLineId,
            nodeId: value.input.nodeId
          })
          if (result === null) continue
        }
      }
      if (reservation.published) return reservation.published
      const maximumClaims = Math.ceil(value.input.evidenceIds.length / claimChunkSize) + 1
      for (let attempt = 0; ; attempt += 1) {
        if (attempt >= maximumClaims) throw createError('VERSION_CONFLICT')
        const claimed = await claimEvidenceChunk(value, reservation)
        if (claimed.published) return claimed.published
        if (claimed.done) break
      }
      return await finalizeFeedback(value, reservation)
    } catch (error) {
      if (reservation && !reservation.published) {
        try {
          await startAuthorizedReservationRecovery(value, reservation.feedbackId, 'SUBMISSION_FAILED')
        } catch (cleanupError) {
          // The hidden reservation remains lease-protected and Task 11 recovery can finish cleanup.
        }
      }
      throw error
    }
  }

  async function readAll(buildQuery) {
    const items = []
    for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
      const response = await buildQuery().orderBy('_id', 'asc').skip(offset).limit(QUERY_PAGE_SIZE).get()
      const page = response.data || []
      items.push(...page)
      if (page.length < QUERY_PAGE_SIZE) return items
    }
  }

  async function getCurrentProcessingRoundDraft({ actor, businessLineId, nodeId, expectedNodeVersion }) {
    const input = { businessLineId, nodeId, expectedNodeVersion, status: 'in_progress' }
    const context = await db.runTransaction(async transaction => {
      const documents = await readSubmissionDocuments(transaction, actor && actor._id, input)
      assertActiveAccountSubmission(documents.actor, documents.line, documents.node, input)
      if (documents.node.workflowMode !== 'review' ||
          !safeInteger(documents.node.processingRoundNumber, { minimum: 1 })) {
        throw createError('VALIDATION_ERROR')
      }
      return documents
    })
    const processingRoundNumber = context.node.processingRoundNumber
    const stored = await readAll(() => db.collection(COLLECTIONS.feedback).where({ nodeId }))
    const feedback = stored.filter(item =>
      item && item.businessLineId === businessLineId && item.nodeId === nodeId &&
      item.publishState === 'published' && item.processingRoundNumber === processingRoundNumber &&
      ['save_progress', 'mark_blocked'].includes(item.action) &&
      safeInteger(item.revision, { minimum: 1 }))
    feedback.sort((left, right) => left.revision - right.revision || String(left._id).localeCompare(String(right._id)))
    if (feedback.some((item, index) => index > 0 && feedback[index - 1].revision === item.revision)) {
      throw createError('VERSION_CONFLICT')
    }
    const latest = feedback.at(-1)
    if (!latest || context.node.latestFeedbackId !== latest._id ||
        context.node.latestFeedbackRevision !== latest.revision || !Array.isArray(latest.fieldValues)) {
      throw createError('VERSION_CONFLICT')
    }
    const feedbackById = new Map(feedback.map(item => [item._id, item]))
    const evidenceRows = await readAll(() => db.collection(COLLECTIONS.evidences).where({ nodeId }))
    const at = now().getTime()
    const accepted = []
    for (const evidence of evidenceRows) {
      const ownerFeedback = feedbackById.get(evidence && evidence.feedbackId)
      if (!ownerFeedback) continue
      if (evidence.businessLineId !== businessLineId || evidence.nodeId !== nodeId ||
          evidence.processingRoundNumber !== processingRoundNumber ||
          evidence.feedbackRevision !== ownerFeedback.revision) {
        throw createError('EVIDENCE_NOT_ATTACHABLE')
      }
      if (evidence.attachmentState !== 'attached' || evidence.storageStatus !== 'available' ||
          evidence.purgedAt !== null && evidence.purgedAt !== undefined) continue
      const retention = classifyEvidenceRetention(evidence, context.line)
      if (!retention || !safeInteger(evidence.size, { minimum: 1 })) {
        throw createError('EVIDENCE_NOT_ATTACHABLE')
      }
      if (retention.effectivePurgeDueAt && retention.effectivePurgeDueAt.getTime() <= at) continue
      accepted.push({ evidence, revision: ownerFeedback.revision })
    }
    accepted.sort((left, right) => left.revision - right.revision ||
      String(left.evidence._id).localeCompare(String(right.evidence._id)))
    const evidenceIds = []
    const seen = new Set()
    let evidenceTotalBytes = 0
    for (const { evidence } of accepted) {
      if (seen.has(evidence._id)) continue
      seen.add(evidence._id)
      if (evidence.size > FEEDBACK_TOTAL_LIMIT - evidenceTotalBytes) {
        throw createError('FEEDBACK_TOTAL_TOO_LARGE')
      }
      evidenceTotalBytes += evidence.size
      evidenceIds.push(evidence._id)
    }
    if (context.node.requiresEvidence && evidenceIds.length === 0) throw createError('EVIDENCE_NOT_ATTACHABLE')
    return {
      line: clone(context.line),
      node: clone(context.node),
      feedbackId: latest._id,
      feedbackRevision: latest.revision,
      processingRoundNumber,
      fieldSnapshots: clone(latest.fieldValues),
      evidenceIds,
      evidenceTotalBytes
    }
  }

  async function getNodeHistory({ actor, businessLineId, nodeId }) {
    const context = await db.runTransaction(async transaction => {
      const currentActor = await readDocument(transaction, COLLECTIONS.users, actor && actor._id)
      if (!currentActor || currentActor.status !== 'active') throw createError('FORBIDDEN')
      const line = await readDocument(transaction, COLLECTIONS.lines, businessLineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      const node = await readDocument(transaction, COLLECTIONS.nodes, nodeId)
      if (!node || node.businessLineId !== line._id) throw createError('NOT_FOUND')
      const allowed = accountSchema(line, node) ? isAccountMember(line, currentActor._id) : isLegacyMember(line, currentActor)
      if (!allowed) throw createError('FORBIDDEN')
      return { line, node, actor: currentActor }
    })
    const stored = await readAll(() => db.collection(COLLECTIONS.feedback).where({ nodeId }))
    const visible = stored.filter(item =>
      item.businessLineId === businessLineId && item.nodeId === nodeId &&
      (item.publishState === undefined || item.publishState === 'published'))
    function timestamp(item) {
      const value = item.submittedAt === undefined ? item.createdAt : item.submittedAt
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime()
      if (typeof value === 'string') {
        const parsed = new Date(value)
        if (!Number.isNaN(parsed.getTime())) return parsed.getTime()
      }
      return Number.NEGATIVE_INFINITY
    }
    visible.sort((left, right) => {
      const time = timestamp(right) - timestamp(left)
      if (time) return time
      const revision = (safeInteger(right.revision) ? right.revision : -1) -
        (safeInteger(left.revision) ? left.revision : -1)
      if (revision) return revision
      return String(left._id).localeCompare(String(right._id))
    })
    const history = []
    for (const feedback of visible) {
      const associated = await readAll(() => db.collection(COLLECTIONS.evidences).where({ feedbackId: feedback._id }))
      const evidenceById = new Map()
      for (const evidence of associated) {
        const retention = classifyEvidenceRetention(evidence, context.line)
        if (evidence.feedbackId === feedback._id && evidence.attachmentState === 'attached' &&
            evidence.businessLineId === businessLineId && evidence.nodeId === nodeId &&
            safeInteger(feedback.revision, { minimum: 1 }) &&
            safeInteger(evidence.feedbackRevision, { minimum: 1 }) &&
            evidence.feedbackRevision === feedback.revision && retention) {
          evidenceById.set(evidence._id, { evidence, retention })
        }
      }
      if (feedback.publishState === undefined && Array.isArray(feedback.evidenceIds)) {
        for (const evidenceId of [...new Set(feedback.evidenceIds)]) {
          if (typeof evidenceId !== 'string' || !evidenceId) continue
          const evidence = await readDocument(db, COLLECTIONS.evidences, evidenceId)
          const retention = classifyEvidenceRetention(evidence, context.line, { allowLegacy: true })
          if (evidence && evidence._id === evidenceId && evidence.businessLineId === businessLineId &&
              evidence.nodeId === nodeId && (evidence.feedbackId === null || evidence.feedbackId === undefined ||
                evidence.feedbackId === feedback._id) && retention) evidenceById.set(evidenceId, { evidence, retention })
        }
      }
      const evidences = [...evidenceById.values()].sort((left, right) =>
        String(left.evidence._id).localeCompare(String(right.evidence._id)))
      history.push(feedbackProjection(feedback, evidences.map(item => evidenceProjection(item.evidence, item.retention))))
    }
    const canSubmit = context.line.status === 'active' && isCurrentNode(context.line, context.node) &&
      ACTIVE_NODE_STATUSES.has(context.node.status) && accountSchema(context.line, context.node) &&
      processorIds(context.node).includes(context.actor._id)
    return {
      node: { id: context.node._id, name: context.node.name, nodeCode: context.node.nodeCode, status: context.node.status },
      canSubmit,
      history
    }
  }

  return {
    findPublishedFeedback,
    getSubmissionContext,
    beginFeedback,
    claimEvidenceChunk,
    finalizeFeedback,
    recoverExpiredReservation,
    commitFeedback,
    getNodeHistory,
    getCurrentProcessingRoundDraft
  }
}

module.exports = {
  CLAIM_LIFETIME_MS,
  DEFAULT_CHUNK_SIZE,
  RETENTION_MS,
  createCloudFeedbackRepository
}
