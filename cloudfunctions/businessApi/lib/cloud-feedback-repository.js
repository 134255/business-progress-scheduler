const crypto = require('node:crypto')

const { FEEDBACK_TOTAL_LIMIT } = require('./evidence-policy')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

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

function parseDeadline(value) {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return date
}

function publicResult(feedback) {
  return {
    feedbackId: feedback._id,
    revision: feedback.revision,
    nodeStatus: feedback.status,
    lineStatus: feedback.lineStatus
  }
}

function evidenceProjection(evidence) {
  return {
    evidenceId: evidence._id,
    fileName: evidence.fileName,
    category: evidence.category,
    extension: evidence.extension,
    size: evidence.size,
    storageStatus: evidence.storageStatus,
    purgeDueAt: evidence.purgeDueAt === undefined ? null : evidence.purgeDueAt,
    purgedAt: evidence.purgedAt === undefined ? null : evidence.purgedAt
  }
}

function feedbackProjection(feedback, evidences) {
  const result = {
    feedbackId: feedback._id,
    businessLineId: feedback.businessLineId,
    nodeId: feedback.nodeId,
    status: feedback.status,
    comment: typeof feedback.comment === 'string' ? feedback.comment : '',
    submittedBy: feedback.submittedBy,
    submittedAt: feedback.submittedAt === undefined ? feedback.createdAt : feedback.submittedAt,
    evidences
  }
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
    const { actor, input, fieldSnapshots, evidenceTotalBytes } = value
    if (!actor || typeof actor._id !== 'string' || !input || !Array.isArray(input.evidenceIds) ||
        new Set(input.evidenceIds).size !== input.evidenceIds.length ||
        !Number.isSafeInteger(evidenceTotalBytes) || evidenceTotalBytes < 0 || evidenceTotalBytes > FEEDBACK_TOTAL_LIMIT) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    const requestHash = hash(`${actor._id}\0${input.nodeId}\0${input.requestKey}`)
    const evidenceDigest = hash(JSON.stringify(input.evidenceIds))
    const inputHash = hash(JSON.stringify([
      actor._id, input.businessLineId, input.nodeId, input.expectedNodeVersion,
      input.status, fieldSnapshots, input.comment, evidenceDigest, input.evidenceIds.length,
      evidenceTotalBytes
    ]))
    return { feedbackId: `feedback-${requestHash}`, requestHash, evidenceDigest, inputHash }
  }

  function assertActiveAccountSubmission(actor, line, node, input, expectedVersion = true) {
    if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
    if (!line || line.status === 'creating') throw createError('NOT_FOUND')
    if (FROZEN_LINE_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
    if (line.status !== 'active') throw createError('NODE_NOT_ACTIVE')
    if (!node || node.businessLineId !== line._id) throw createError('NOT_FOUND')
    if (!accountSchema(line, node) || !isAccountMember(line, actor._id) ||
        !membership(node.assigneeUserIds).includes(actor._id)) {
      throw createError('FORBIDDEN')
    }
    if (!isCurrentNode(line, node) || !ACTIVE_NODE_STATUSES.has(node.status)) {
      if (input.status === 'completed' && node.status === 'completed') throw createError('NODE_ALREADY_COMPLETED')
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
        !membership(node.assigneeUserIds).includes(actor._id)) throw createError('FORBIDDEN')
  }

  async function readSubmissionDocuments(database, actorId, input) {
    const actor = await readDocument(database, COLLECTIONS.users, actorId)
    const line = await readDocument(database, COLLECTIONS.lines, input.businessLineId)
    const node = await readDocument(database, COLLECTIONS.nodes, input.nodeId)
    return { actor, line, node }
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

  async function beginFeedback(value) {
    const id = identity(value)
    const at = now()
    return db.runTransaction(async transaction => {
      const existing = await readDocument(transaction, COLLECTIONS.feedback, id.feedbackId)
      const current = await readSubmissionDocuments(transaction, value.actor._id, value.input)
      if (existing) {
        if (existing.requestHash !== id.requestHash || existing.inputHash !== id.inputHash ||
            existing.submittedBy !== value.actor._id) throw createError('VERSION_CONFLICT')
        if (existing.publishState === 'published') {
          assertPublishedRetry(current.actor, current.line, current.node, existing)
          return { ...id, published: publicResult(existing) }
        }
      }
      if (existing && existing.publishState === 'reserved' && current.node &&
          current.node.feedbackClaimId === id.feedbackId) {
        assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
        return { ...id, cursor: existing.claimedCount }
      }
      assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
      if (value.input.status === 'completed' && current.node.requiresEvidence && !value.input.evidenceIds.length) {
        throw createError('EVIDENCE_NOT_ATTACHABLE')
      }
      if (current.node.feedbackClaimId && current.node.feedbackClaimId !== id.feedbackId) {
        const winner = await readDocument(transaction, COLLECTIONS.feedback, current.node.feedbackClaimId)
        if (winner && winner.publishState === 'published') throw createError('NODE_ALREADY_COMPLETED')
        throw createError('NODE_COMMIT_IN_PROGRESS', { winnerFeedbackId: current.node.feedbackClaimId })
      }
      const claimExpiresAt = new Date(at.getTime() + CLAIM_LIFETIME_MS)
      const plannedRevision = Number(current.node.latestFeedbackRevision || 0) + 1
      if (!Number.isSafeInteger(plannedRevision) || plannedRevision < 1) throw createError('VERSION_CONFLICT')
      const reservation = {
        businessLineId: current.line._id,
        nodeId: current.node._id,
        nodeCode: current.node.nodeCode,
        nodeName: current.node.name,
        submittedBy: current.actor._id,
        status: value.input.status,
        fieldValues: clone(value.fieldSnapshots),
        comment: value.input.comment,
        publishState: 'reserved',
        requestHash: id.requestHash,
        inputHash: id.inputHash,
        evidenceDigest: id.evidenceDigest,
        evidenceCount: value.input.evidenceIds.length,
        evidenceTotalBytes: value.evidenceTotalBytes,
        claimedCount: 0,
        claimedBytes: 0,
        claimedDigest: hash(JSON.stringify([])),
        expectedNodeVersion: value.input.expectedNodeVersion,
        plannedRevision,
        freezesLine: Number(current.node.sequence) + 1 >= Number(current.line.nodeCount),
        transitionAt: at,
        claimExpiresAt,
        recoveryCount: Number(existing && existing.recoveryCount || 0),
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
    if (!Number.isSafeInteger(evidence.size) || evidence.size < 0) throw createError('EVIDENCE_NOT_ATTACHABLE')
  }

  async function claimEvidenceChunk(value, reservationIdentity) {
    if (reservationIdentity.published) return { done: true, published: reservationIdentity.published }
    const id = identity(value)
    if (id.feedbackId !== reservationIdentity.feedbackId) throw createError('VERSION_CONFLICT')
    const at = now()
    return db.runTransaction(async transaction => {
      const current = await readSubmissionDocuments(transaction, value.actor._id, value.input)
      assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, id.feedbackId)
      if (!reservation || reservation.inputHash !== id.inputHash || reservation.requestHash !== id.requestHash) {
        throw createError('VERSION_CONFLICT')
      }
      if (reservation.publishState === 'published') return { done: true, published: publicResult(reservation) }
      if (reservation.publishState !== 'reserved' || current.node.feedbackClaimId !== id.feedbackId ||
          reservation.claimedDigest !== hash(JSON.stringify(value.input.evidenceIds.slice(0, reservation.claimedCount)))) {
        throw createError('VERSION_CONFLICT')
      }
      const ids = value.input.evidenceIds.slice(reservation.claimedCount, reservation.claimedCount + claimChunkSize)
      let claimedBytes = reservation.claimedBytes
      const purgeDueAt = reservation.freezesLine
        ? new Date(new Date(reservation.transitionAt).getTime() + RETENTION_MS)
        : null
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
            retentionStartedAt: reservation.freezesLine ? reservation.transitionAt : null,
            purgeDueAt
          }
        })
      }
      const claimedCount = reservation.claimedCount + ids.length
      const claimExpiresAt = new Date(at.getTime() + CLAIM_LIFETIME_MS)
      await transaction.collection(COLLECTIONS.feedback).doc(id.feedbackId).update({
        data: {
          claimedCount,
          claimedBytes,
          claimedDigest: hash(JSON.stringify(value.input.evidenceIds.slice(0, claimedCount))),
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
    if (reservationIdentity.published) return reservationIdentity.published
    const id = identity(value)
    return db.runTransaction(async transaction => {
      const current = await readSubmissionDocuments(transaction, value.actor._id, value.input)
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, id.feedbackId)
      if (reservation && reservation.publishState === 'published') return publicResult(reservation)
      assertActiveAccountSubmission(current.actor, current.line, current.node, value.input)
      if (!reservation || reservation.publishState !== 'reserved' || reservation.inputHash !== id.inputHash ||
          current.node.feedbackClaimId !== id.feedbackId || reservation.claimedCount !== reservation.evidenceCount ||
          reservation.claimedCount !== value.input.evidenceIds.length ||
          reservation.claimedBytes !== reservation.evidenceTotalBytes ||
          reservation.claimedBytes !== value.evidenceTotalBytes ||
          reservation.claimedDigest !== id.evidenceDigest) {
        throw createError('EVIDENCE_NOT_ATTACHABLE')
      }
      const revision = reservation.plannedRevision
      if (revision !== Number(current.node.latestFeedbackRevision || 0) + 1) throw createError('VERSION_CONFLICT')
      const nodeChanges = {
        status: value.input.status,
        version: current.node.version + 1,
        latestFeedbackRevision: revision,
        latestComment: value.input.comment,
        feedbackClaimId: db.command.remove(),
        feedbackClaimHash: db.command.remove(),
        feedbackClaimExpiresAt: db.command.remove(),
        updatedAt: db.serverDate()
      }
      if (value.input.status === 'completed') nodeChanges.completedAt = reservation.transitionAt
      await transaction.collection(COLLECTIONS.nodes).doc(current.node._id).update({ data: nodeChanges })

      let lineStatus = 'active'
      if (value.input.status === 'completed' && reservation.freezesLine) {
        lineStatus = 'completed'
        await transaction.collection(COLLECTIONS.lines).doc(current.line._id).update({ data: {
          status: 'completed', progress: 100, version: Number(current.line.version || 0) + 1,
          completedAt: reservation.transitionAt, frozenAt: reservation.transitionAt,
          retentionStartedAt: reservation.transitionAt, updatedAt: db.serverDate()
        } })
      } else if (value.input.status === 'completed') {
        const nextId = nextNodeId(current.line._id, current.node.sequence)
        const next = await readDocument(transaction, COLLECTIONS.nodes, nextId)
        if (!next || next.businessLineId !== current.line._id || Number(next.sequence) !== Number(current.node.sequence) + 1 ||
            next.status !== 'waiting') throw createError('NODE_NOT_ACTIVE')
        await transaction.collection(COLLECTIONS.nodes).doc(nextId).update({ data: {
          status: 'ready', version: next.version + 1, activatedAt: reservation.transitionAt, updatedAt: db.serverDate()
        } })
        const progress = Math.floor(((Number(current.node.sequence) + 1) / Number(current.line.nodeCount)) * 100)
        await transaction.collection(COLLECTIONS.lines).doc(current.line._id).update({ data: {
          currentNodeId: nextId, currentNodeIndex: next.sequence, currentNodeName: next.name,
          progress, version: Number(current.line.version || 0) + 1, updatedAt: db.serverDate()
        } })
      } else {
        await transaction.collection(COLLECTIONS.lines).doc(current.line._id).update({ data: {
          version: Number(current.line.version || 0) + 1, updatedAt: db.serverDate()
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

  async function waitForWinner(error, value) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const winner = await readDocument(db, COLLECTIONS.feedback, error.winnerFeedbackId)
      if (winner && winner.publishState === 'published') throw createError('NODE_ALREADY_COMPLETED')
      if (winner && winner.publishState === 'reserved') {
        const expiresAt = parseDeadline(winner.claimExpiresAt)
        if (expiresAt && expiresAt.getTime() <= now().getTime() &&
            await recoverExpiredReservation(error.winnerFeedbackId)) return null
      }
      const node = await readDocument(db, COLLECTIONS.nodes, value.input.nodeId)
      if (!node || node.status === 'completed') throw createError('NODE_ALREADY_COMPLETED')
      if (!node.feedbackClaimId) return null
      await wait(5)
    }
    throw createError('NODE_ALREADY_COMPLETED')
  }

  async function releaseReservation(feedbackId, { onlyExpired = false, reason = 'INTERRUPTED' } = {}) {
    const at = now()
    const marked = await db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, feedbackId)
      if (!reservation || reservation.publishState === 'published' || reservation.publishState === 'aborted') return false
      if (onlyExpired) {
        const expiresAt = parseDeadline(reservation.claimExpiresAt)
        if (!expiresAt || expiresAt.getTime() > at.getTime()) return false
      }
      const node = await readDocument(transaction, COLLECTIONS.nodes, reservation.nodeId)
      await transaction.collection(COLLECTIONS.feedback).doc(feedbackId).update({ data: {
        publishState: 'aborting', recoveryCount: Number(reservation.recoveryCount || 0) + 1,
        recoveryReason: reason, recoveryStartedAt: at, updatedAt: db.serverDate()
      } })
      if (node && node.feedbackClaimId === feedbackId) {
        await transaction.collection(COLLECTIONS.nodes).doc(node._id).update({ data: {
          feedbackClaimId: db.command.remove(),
          feedbackClaimHash: db.command.remove(),
          feedbackClaimExpiresAt: db.command.remove()
        } })
      }
      return true
    })
    if (!marked) return false

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
            retentionStartedAt: null,
            purgeDueAt: null
          } })
        }
      })
    }
    await db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, COLLECTIONS.feedback, feedbackId)
      if (!reservation || reservation.publishState !== 'aborting') return
      await transaction.collection(COLLECTIONS.feedback).doc(feedbackId).update({ data: {
        publishState: 'aborted', abortedAt: at, claimExpiresAt: db.command.remove(), updatedAt: db.serverDate()
      } })
    })
    return true
  }

  async function recoverExpiredReservation(feedbackId) {
    return releaseReservation(feedbackId, { onlyExpired: true, reason: 'CLAIM_EXPIRED' })
  }

  async function commitFeedback(value) {
    let reservation
    try {
      for (;;) {
        try {
          reservation = await beginFeedback(value)
          break
        } catch (error) {
          if (error.code !== 'NODE_COMMIT_IN_PROGRESS') throw error
          const result = await waitForWinner(error, value)
          if (result === null) continue
        }
      }
      if (reservation.published) return reservation.published
      for (;;) {
        const claimed = await claimEvidenceChunk(value, reservation)
        if (claimed.published) return claimed.published
        if (claimed.done) break
      }
      return await finalizeFeedback(value, reservation)
    } catch (error) {
      if (reservation && !reservation.published) {
        try {
          await releaseReservation(reservation.feedbackId, { reason: 'SUBMISSION_FAILED' })
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
      const response = await buildQuery().skip(offset).limit(QUERY_PAGE_SIZE).get()
      const page = response.data || []
      items.push(...page)
      if (page.length < QUERY_PAGE_SIZE) return items
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
      const allowed = accountSchema(line, node) ? isAccountMember(line, currentActor._id) : isLegacyMember(line, actor)
      if (!allowed) throw createError('FORBIDDEN')
      return { line, node, actor: currentActor }
    })
    const stored = await readAll(() => db.collection(COLLECTIONS.feedback)
      .where({ nodeId }).orderBy('submittedAt', 'desc'))
    const visible = stored.filter(item => item.publishState === undefined || item.publishState === 'published')
    const history = []
    for (const feedback of visible) {
      const evidences = await readAll(() => db.collection(COLLECTIONS.evidences)
        .where({ feedbackId: feedback._id }).orderBy('uploadedAt', 'asc'))
      history.push(feedbackProjection(feedback, evidences.map(evidenceProjection)))
    }
    const canSubmit = context.line.status === 'active' && isCurrentNode(context.line, context.node) &&
      ACTIVE_NODE_STATUSES.has(context.node.status) && accountSchema(context.line, context.node) &&
      membership(context.node.assigneeUserIds).includes(context.actor._id)
    return {
      node: { id: context.node._id, name: context.node.name, nodeCode: context.node.nodeCode, status: context.node.status },
      canSubmit,
      history
    }
  }

  return {
    getSubmissionContext,
    beginFeedback,
    claimEvidenceChunk,
    finalizeFeedback,
    recoverExpiredReservation,
    commitFeedback,
    getNodeHistory
  }
}

module.exports = {
  CLAIM_LIFETIME_MS,
  DEFAULT_CHUNK_SIZE,
  RETENTION_MS,
  createCloudFeedbackRepository
}
