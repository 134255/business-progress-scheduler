const crypto = require('node:crypto')

const { FEEDBACK_TOTAL_LIMIT } = require('./evidence-policy')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const ACTIVE_NODE_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const FROZEN_LINE_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const REVIEW_MODES = new Set(['any', 'all'])
const HASH = /^[a-f0-9]{64}$/
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

function createError(code) {
  const error = new Error(code)
  error.code = code
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

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function increment(value) {
  if (!safeInteger(value) || value === Number.MAX_SAFE_INTEGER) throw createError('VERSION_CONFLICT')
  return value + 1
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function exactAccountIds(value) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !DOCUMENT_ID.test(id)) ||
      new Set(value).size !== value.length) return null
  return value
}

function lineMember(line, actorId) {
  const managers = exactAccountIds(line && line.managerUserIds)
  const members = exactAccountIds(line && line.memberUserIds)
  return Boolean(managers && members && (managers.includes(actorId) || members.includes(actorId)))
}

function isCurrentNode(line, node) {
  return line && node && line.currentNodeId === node._id &&
    safeInteger(line.currentNodeIndex) && Number(node.sequence) === line.currentNodeIndex
}

function publicResult(round) {
  return {
    reviewRoundId: round._id,
    status: round.status,
    nodeStatus: 'pending_review',
    evidenceIds: clone(round.evidenceIds)
  }
}

function createCloudReviewRepository({ db, clock = () => new Date() }) {
  if (!db) throw new TypeError('db is required')

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
    if (!validDate(value)) throw new TypeError('clock must return a Date')
    return new Date(value)
  }

  function assertBaseAuthorization(actor, line, node) {
    if (!actor || actor.status !== 'active' || typeof actor._id !== 'string') throw createError('FORBIDDEN')
    if (!line || line.status === 'creating' || !node || node.businessLineId !== line._id) throw createError('NOT_FOUND')
    if (FROZEN_LINE_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
    if (line.status !== 'active') throw createError('NODE_NOT_ACTIVE')
    if (node.workflowMode !== 'review') throw createError('VALIDATION_ERROR')
    const processors = exactAccountIds(node.processorUserIds)
    const reviewers = exactAccountIds(node.reviewerUserIds)
    if (!processors || !processors.length || !reviewers || !reviewers.length ||
        processors.some(id => reviewers.includes(id)) || !lineMember(line, actor._id) ||
        !processors.includes(actor._id)) throw createError('FORBIDDEN')
    if (!isCurrentNode(line, node)) throw createError('NODE_NOT_ACTIVE')
    if (!REVIEW_MODES.has(node.reviewMode) || !safeInteger(node.processingRoundNumber, 1)) {
      throw createError('VERSION_CONFLICT')
    }
    return { processors, reviewers }
  }

  function validateDraft(value, node, feedback) {
    const { draft } = value
    if (!draft || typeof draft.feedbackId !== 'string' || !DOCUMENT_ID.test(draft.feedbackId) ||
        !safeInteger(draft.feedbackRevision, 1) ||
        draft.processingRoundNumber !== node.processingRoundNumber ||
        !Array.isArray(draft.fieldSnapshots) || !Array.isArray(draft.evidenceIds) ||
        draft.evidenceIds.some(id => typeof id !== 'string' || !DOCUMENT_ID.test(id)) ||
        new Set(draft.evidenceIds).size !== draft.evidenceIds.length ||
        !safeInteger(draft.evidenceTotalBytes) || draft.evidenceTotalBytes > FEEDBACK_TOTAL_LIMIT ||
        node.latestFeedbackId !== draft.feedbackId || node.latestFeedbackRevision !== draft.feedbackRevision ||
        !feedback || feedback._id !== draft.feedbackId || feedback.publishState !== 'published' ||
        feedback.businessLineId !== value.input.businessLineId || feedback.nodeId !== value.input.nodeId ||
        feedback.revision !== draft.feedbackRevision ||
        feedback.processingRoundNumber !== draft.processingRoundNumber ||
        !['save_progress', 'mark_blocked'].includes(feedback.action)) {
      throw createError('VERSION_CONFLICT')
    }
  }

  function validateTiming(timing, node) {
    const processingTotal = node && node.processingSlaWorkHours * 60
    const reviewTotal = node && node.reviewSlaWorkHours * 60
    if (!timing || !['calculated', 'pending_calendar'].includes(timing.processingTimingStatus) ||
        !safeInteger(timing.processingElapsedWorkMinutes) ||
        !safeInteger(timing.processingRemainingWorkMinutes) ||
        !safeInteger(timing.processingOverdueWorkMinutes) || !validDate(timing.reviewStartedAt) ||
        !safeInteger(timing.reviewRemainingWorkMinutes, 1) ||
        !['calculated', 'pending_calendar'].includes(timing.reviewDueStatus) ||
        !safeInteger(timing.reviewElapsedWorkMinutes) || !safeInteger(timing.reviewOverdueWorkMinutes) ||
        !safeInteger(processingTotal, 1) || !safeInteger(reviewTotal, 1) ||
        timing.processingRemainingWorkMinutes !== Math.max(0, processingTotal - timing.processingElapsedWorkMinutes) ||
        timing.processingOverdueWorkMinutes !== Math.max(0, timing.processingElapsedWorkMinutes - processingTotal) ||
        timing.reviewRemainingWorkMinutes !== reviewTotal || timing.reviewElapsedWorkMinutes !== 0 ||
        timing.reviewOverdueWorkMinutes !== 0) {
      throw createError('VERSION_CONFLICT')
    }
    if (timing.reviewDueStatus === 'calculated') {
      if (!validDate(timing.reviewDueAt)) throw createError('VERSION_CONFLICT')
    } else if (timing.reviewDueAt !== null) throw createError('VERSION_CONFLICT')
  }

  function assertIdempotentRound(round, node, value, roundId) {
    if (!round || round._id !== roundId || round.businessLineId !== value.input.businessLineId ||
        round.nodeId !== value.input.nodeId || round.status !== 'pending' ||
        round.requestKeyHash !== value.requestKeyHash || round.inputHash !== value.inputHash ||
        round.draftHash !== value.draftHash ||
        round.submittedBy !== value.actor._id ||
        round.submittedNodeVersion !== value.input.expectedNodeVersion ||
        node.status !== 'pending_review' || node.activeReviewRoundId !== roundId ||
        node.version !== round.lockedNodeVersion ||
        node.processingRoundNumber !== round.processingRoundNumber) {
      throw createError('VERSION_CONFLICT')
    }
  }

  async function findReviewRoundRetry(value) {
    if (!value || !value.actor || !value.input ||
        typeof value.input.businessLineId !== 'string' || !DOCUMENT_ID.test(value.input.businessLineId) ||
        typeof value.input.nodeId !== 'string' || !DOCUMENT_ID.test(value.input.nodeId) ||
        !safeInteger(value.input.expectedNodeVersion, 1) ||
        !HASH.test(value.requestKeyHash || '') || !HASH.test(value.inputHash || '')) {
      throw createError('VALIDATION_ERROR')
    }
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, 'users', value.actor._id)
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      assertBaseAuthorization(actor, line, node)
      if (node.status !== 'pending_review') {
        if (!ACTIVE_NODE_STATUSES.has(node.status) || node.version !== value.input.expectedNodeVersion ||
            node.activeReviewRoundId !== undefined && node.activeReviewRoundId !== null) {
          throw createError('VERSION_CONFLICT')
        }
        return null
      }
      if (typeof node.activeReviewRoundId !== 'string' || !DOCUMENT_ID.test(node.activeReviewRoundId)) {
        throw createError('VERSION_CONFLICT')
      }
      const round = await readDocument(transaction, 'node_review_rounds', node.activeReviewRoundId)
      if (!round || round.businessLineId !== line._id || round.nodeId !== node._id ||
          round.status !== 'pending' || round.submittedBy !== actor._id ||
          round.submittedNodeVersion !== value.input.expectedNodeVersion ||
          round.lockedNodeVersion !== node.version ||
          round.processingRoundNumber !== node.processingRoundNumber ||
          round.requestKeyHash !== value.requestKeyHash || round.inputHash !== value.inputHash) {
        throw createError('VERSION_CONFLICT')
      }
      return publicResult(round)
    })
  }

  async function createReviewRound(value) {
    if (!value || !value.actor || !value.input || !value.draft ||
        typeof value.input.businessLineId !== 'string' || !DOCUMENT_ID.test(value.input.businessLineId) ||
        typeof value.input.nodeId !== 'string' || !DOCUMENT_ID.test(value.input.nodeId) ||
        !safeInteger(value.input.expectedNodeVersion, 1) ||
        !HASH.test(value.requestKeyHash || '') || !HASH.test(value.inputHash || '') ||
        !HASH.test(value.draftHash || '')) {
      throw createError('VALIDATION_ERROR')
    }
    const roundId = `review-${value.draft.feedbackId}`
    const at = now()
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, 'users', value.actor._id)
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      const { reviewers } = assertBaseAuthorization(actor, line, node)
      const existing = await readDocument(transaction, 'node_review_rounds', roundId)
      if (existing) {
        assertIdempotentRound(existing, node, value, roundId)
        return publicResult(existing)
      }
      if (node.version !== value.input.expectedNodeVersion) throw createError('VERSION_CONFLICT')
      if (!ACTIVE_NODE_STATUSES.has(node.status)) throw createError('NODE_NOT_ACTIVE')
      if (node.activeReviewRoundId !== undefined && node.activeReviewRoundId !== null) {
        throw createError('VERSION_CONFLICT')
      }
      validateTiming(value.timing, node)
      const feedback = await readDocument(transaction, 'node_feedback', value.draft.feedbackId)
      validateDraft(value, node, feedback)
      const lockedNodeVersion = increment(node.version)
      const reviewRoundNumber = increment(node.reviewRoundNumber === undefined ? 0 : node.reviewRoundNumber)
      const round = {
        businessLineId: line._id,
        nodeId: node._id,
        nodeCode: node.nodeCode,
        nodeName: node.name,
        processingRoundNumber: node.processingRoundNumber,
        reviewRoundNumber,
        reviewMode: node.reviewMode,
        reviewerUserIds: clone(reviewers),
        feedbackId: value.draft.feedbackId,
        feedbackRevision: value.draft.feedbackRevision,
        fieldValues: clone(value.draft.fieldSnapshots),
        evidenceIds: clone(value.draft.evidenceIds),
        evidenceTotalBytes: value.draft.evidenceTotalBytes,
        status: 'pending',
        submittedBy: actor._id,
        submittedNodeVersion: node.version,
        lockedNodeVersion,
        requestKeyHash: value.requestKeyHash,
        inputHash: value.inputHash,
        draftHash: value.draftHash,
        reviewSlaWorkHours: node.reviewSlaWorkHours,
        reviewStartedAt: new Date(value.timing.reviewStartedAt),
        reviewRemainingWorkMinutes: value.timing.reviewRemainingWorkMinutes,
        reviewElapsedWorkMinutes: value.timing.reviewElapsedWorkMinutes,
        reviewOverdueWorkMinutes: value.timing.reviewOverdueWorkMinutes,
        reviewDueStatus: value.timing.reviewDueStatus,
        reviewDueAt: value.timing.reviewDueAt === null ? null : new Date(value.timing.reviewDueAt),
        reviewCalendarVersion: value.timing.reviewCalendarVersion || null,
        processingTimingStatus: value.timing.processingTimingStatus,
        processingElapsedWorkMinutes: value.timing.processingElapsedWorkMinutes,
        processingRemainingWorkMinutes: value.timing.processingRemainingWorkMinutes,
        processingOverdueWorkMinutes: value.timing.processingOverdueWorkMinutes,
        processingCalendarVersion: value.timing.processingCalendarVersion || null,
        calendarNotificationStatus: value.timing.reviewDueStatus === 'pending_calendar' ? 'pending' : 'not_required',
        version: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      await transaction.collection('node_review_rounds').doc(roundId).set({ data: round })
      await transaction.collection('business_nodes').doc(node._id).update({ data: {
        status: 'pending_review',
        activeReviewRoundId: roundId,
        reviewRoundNumber,
        reviewStartedAt: new Date(value.timing.reviewStartedAt),
        reviewDueStatus: value.timing.reviewDueStatus,
        reviewDueAt: value.timing.reviewDueAt === null ? null : new Date(value.timing.reviewDueAt),
        reviewCalendarVersion: value.timing.reviewCalendarVersion || null,
        processingTimingStatus: value.timing.processingTimingStatus,
        processingElapsedWorkMinutes: value.timing.processingElapsedWorkMinutes,
        processingRemainingWorkMinutes: value.timing.processingRemainingWorkMinutes,
        processingOverdueWorkMinutes: value.timing.processingOverdueWorkMinutes,
        processingCalendarVersion: value.timing.processingCalendarVersion || null,
        version: lockedNodeVersion,
        updatedAt: db.serverDate()
      } })
      const notificationId = `review-start-${hash(roundId).slice(0, 40)}`
      await transaction.collection('notifications').doc(notificationId).set({ data: {
        type: 'review_started',
        recipientUserIds: clone(reviewers),
        businessLineId: line._id,
        nodeId: node._id,
        reviewRoundId: roundId,
        status: 'unread',
        createdAt: db.serverDate()
      } })
      await transaction.collection('audit_logs').doc(`${roundId}-submitted`).set({ data: {
        actorId: actor._id,
        action: 'SUBMIT_NODE_FOR_REVIEW',
        targetType: 'node_review_round',
        targetId: roundId,
        businessLineId: line._id,
        nodeId: node._id,
        feedbackId: value.draft.feedbackId,
        processingRoundNumber: node.processingRoundNumber,
        reviewRoundNumber,
        createdAt: db.serverDate()
      } })
      return publicResult({ _id: roundId, ...round })
    })
  }

  return { findReviewRoundRetry, createReviewRound }
}

module.exports = { createCloudReviewRepository }
