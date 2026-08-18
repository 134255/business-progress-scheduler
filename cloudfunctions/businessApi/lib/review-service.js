const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { isNotificationId } = require('./notification-id')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INPUT_KEYS = new Set(['businessLineId', 'nodeId', 'expectedNodeVersion', 'requestKey'])
const VOTE_INPUT_KEYS = new Set([
  'reviewRoundId', 'expectedRoundVersion', 'decision', 'comment', 'requestKey'
])
const QUERY_KEYS = new Set(['page', 'pageSize'])
const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const MAX_QUERY_WINDOW = 100

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function isPlainOwnObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireActiveActor(actor) {
  if (!actor || actor.status !== 'active' || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id)) {
    throw createError('FORBIDDEN')
  }
}

function normalizeDocumentId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw createError('VALIDATION_ERROR')
  return value
}

function normalizeNotificationId(value) {
  if (!isNotificationId(value)) throw createError('VALIDATION_ERROR')
  return value
}

function normalizeQuery(query) {
  const value = query === undefined ? {} : query
  if (!isPlainOwnObject(value) || Reflect.ownKeys(value).some(key =>
    typeof key !== 'string' || !QUERY_KEYS.has(key))) throw createError('INVALID_QUERY')
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw createError('INVALID_QUERY')
    }
  }
  const page = value.page === undefined ? DEFAULT_PAGE : value.page
  const pageSize = value.pageSize === undefined ? DEFAULT_PAGE_SIZE : value.pageSize
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) ||
      pageSize < 1 || pageSize > MAX_PAGE_SIZE || page * pageSize > MAX_QUERY_WINDOW) {
    throw createError('INVALID_PAGINATION')
  }
  return { page, pageSize }
}

function normalizeInput(input) {
  if (!isPlainOwnObject(input) || Reflect.ownKeys(input).some(key =>
    typeof key !== 'string' || !INPUT_KEYS.has(key)) || [...INPUT_KEYS].some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  })) throw createError('VALIDATION_ERROR')
  if (typeof input.businessLineId !== 'string' || !DOCUMENT_ID.test(input.businessLineId) ||
      typeof input.nodeId !== 'string' || !DOCUMENT_ID.test(input.nodeId) ||
      !Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 1 ||
      typeof input.requestKey !== 'string' || !REQUEST_KEY.test(input.requestKey)) {
    throw createError('VALIDATION_ERROR')
  }
  return { ...input }
}

function normalizeVote(input) {
  if (!isPlainOwnObject(input) || Reflect.ownKeys(input).some(key =>
    typeof key !== 'string' || !VOTE_INPUT_KEYS.has(key)) || [...VOTE_INPUT_KEYS].some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  })) throw createError('VALIDATION_ERROR')
  const comment = typeof input.comment === 'string' ? input.comment.trim() : null
  if (typeof input.reviewRoundId !== 'string' || !DOCUMENT_ID.test(input.reviewRoundId) ||
      !Number.isSafeInteger(input.expectedRoundVersion) || input.expectedRoundVersion < 1 ||
      !['approve', 'reject'].includes(input.decision) || comment === null || comment.length > 1000 ||
      typeof input.requestKey !== 'string' || !REQUEST_KEY.test(input.requestKey)) {
    throw createError(input && !['approve', 'reject'].includes(input.decision)
      ? 'VOTE_DECISION_INVALID'
      : 'VALIDATION_ERROR')
  }
  if (input.decision === 'reject' && !comment) throw createError('REVIEW_COMMENT_REQUIRED')
  return {
    reviewRoundId: input.reviewRoundId,
    expectedRoundVersion: input.expectedRoundVersion,
    decision: input.decision,
    comment,
    requestKey: input.requestKey
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hashDraft(actorId, input, draft) {
  return sha256(JSON.stringify([
    actorId, input.businessLineId, input.nodeId, input.expectedNodeVersion,
    draft.feedbackId, draft.feedbackRevision, draft.processingRoundNumber,
    draft.processingComment, draft.fieldSnapshots, draft.evidenceIds, draft.evidenceTotalBytes
  ]))
}

function strictWorkMinutes(value, code = 'VERSION_CONFLICT') {
  if (!Number.isSafeInteger(value) || value < 0) throw createError(code)
  return value
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function buildProcessingTiming(node, calculated, endedAt) {
  const total = node.processingSlaWorkHours * 60
  if (!Number.isSafeInteger(total) || total <= 0) throw createError('VERSION_CONFLICT')
  const previous = strictWorkMinutes(node.processingElapsedWorkMinutes || 0)
  const startedAt = new Date(node.processingStartedAt)
  if (!validDate(startedAt) || !validDate(endedAt) || startedAt.getTime() > endedAt.getTime()) {
    throw createError('VERSION_CONFLICT')
  }
  if (calculated && calculated.status === 'calculated' &&
      Number.isSafeInteger(calculated.minutes) && calculated.minutes >= 0) {
    const elapsed = strictWorkMinutes(previous + calculated.minutes)
    return {
      processingTimingStatus: 'calculated',
      processingElapsedWorkMinutes: elapsed,
      processingRemainingWorkMinutes: Math.max(0, total - elapsed),
      processingOverdueWorkMinutes: Math.max(0, elapsed - total),
      processingCalendarVersion: calculated.calendarVersion || null,
      processingRoundTimingStatus: 'calculated',
      processingRoundWorkMinutes: calculated.minutes,
      processingRoundCalendarVersion: calculated.calendarVersion || null,
      processingRoundStartedAt: startedAt,
      processingRoundEndedAt: new Date(endedAt)
    }
  }
  if (calculated && calculated.status === 'pending_calendar' && calculated.minutes === null) {
    return {
      processingTimingStatus: 'pending_calendar',
      processingElapsedWorkMinutes: previous,
      processingRemainingWorkMinutes: Math.max(0, total - previous),
      processingOverdueWorkMinutes: Math.max(0, previous - total),
      processingCalendarVersion: null,
      processingRoundTimingStatus: 'pending_calendar',
      processingRoundWorkMinutes: null,
      processingRoundCalendarVersion: null,
      processingRoundStartedAt: startedAt,
      processingRoundEndedAt: new Date(endedAt)
    }
  }
  throw createError('VERSION_CONFLICT')
}

function buildReviewTiming(node, startedAt, calculated) {
  const minutes = node.reviewSlaWorkHours * 60
  if (!Number.isSafeInteger(minutes) || minutes <= 0) throw createError('VERSION_CONFLICT')
  if (calculated && calculated.status === 'calculated' && validDate(calculated.dueAt)) {
    return {
      reviewStartedAt: new Date(startedAt),
      reviewRemainingWorkMinutes: minutes,
      reviewElapsedWorkMinutes: 0,
      reviewOverdueWorkMinutes: 0,
      reviewDueStatus: 'calculated',
      reviewDueAt: new Date(calculated.dueAt),
      reviewCalendarVersion: calculated.calendarVersion || null
    }
  }
  if (calculated && calculated.status === 'pending_calendar' && calculated.dueAt === null) {
    return {
      reviewStartedAt: new Date(startedAt),
      reviewRemainingWorkMinutes: minutes,
      reviewElapsedWorkMinutes: 0,
      reviewOverdueWorkMinutes: 0,
      reviewDueStatus: 'pending_calendar',
      reviewDueAt: null,
      reviewCalendarVersion: null
    }
  }
  throw createError('VERSION_CONFLICT')
}

function buildCompletedReviewTiming(context, calculated) {
  if (!context || !validDate(context.reviewStartedAt) ||
      !Number.isSafeInteger(context.reviewTotalWorkMinutes) || context.reviewTotalWorkMinutes <= 0 ||
      !Number.isSafeInteger(context.reviewBaseElapsedWorkMinutes) ||
      context.reviewBaseElapsedWorkMinutes < 0) throw createError('VERSION_CONFLICT')
  const base = context.reviewBaseElapsedWorkMinutes
  if (calculated && calculated.status === 'calculated' &&
      Number.isSafeInteger(calculated.minutes) && calculated.minutes >= 0 &&
      Number.isSafeInteger(base + calculated.minutes)) {
    const elapsed = base + calculated.minutes
    return {
      reviewTimingStatus: 'calculated',
      reviewElapsedWorkMinutes: elapsed,
      reviewRemainingWorkMinutes: Math.max(0, context.reviewTotalWorkMinutes - elapsed),
      reviewOverdueWorkMinutes: Math.max(0, elapsed - context.reviewTotalWorkMinutes),
      reviewCalendarVersion: calculated.calendarVersion || null
    }
  }
  if (calculated && calculated.status === 'pending_calendar' && calculated.minutes === null) {
    return {
      reviewTimingStatus: 'pending_calendar',
      reviewElapsedWorkMinutes: base,
      reviewRemainingWorkMinutes: Math.max(0, context.reviewTotalWorkMinutes - base),
      reviewOverdueWorkMinutes: Math.max(0, base - context.reviewTotalWorkMinutes),
      reviewCalendarVersion: null
    }
  }
  throw createError('VERSION_CONFLICT')
}

function buildReviewResponseTiming(context, calculated, endedAt) {
  const startedAt = new Date(context && context.reviewStartedAt)
  if (!validDate(startedAt) || !validDate(endedAt) || startedAt.getTime() > endedAt.getTime()) {
    throw createError('VERSION_CONFLICT')
  }
  if (calculated && calculated.status === 'calculated' &&
      Number.isSafeInteger(calculated.minutes) && calculated.minutes >= 0) {
    return {
      reviewResponseTimingStatus: 'calculated',
      reviewResponseWorkMinutes: calculated.minutes,
      reviewResponseCalendarVersion: calculated.calendarVersion || null,
      reviewResponseStartedAt: startedAt,
      reviewResponseEndedAt: new Date(endedAt)
    }
  }
  if (calculated && calculated.status === 'pending_calendar' && calculated.minutes === null) {
    return {
      reviewResponseTimingStatus: 'pending_calendar',
      reviewResponseWorkMinutes: null,
      reviewResponseCalendarVersion: null,
      reviewResponseStartedAt: startedAt,
      reviewResponseEndedAt: new Date(endedAt)
    }
  }
  throw createError('VERSION_CONFLICT')
}

function createReviewService({ feedbackRepository, reviewRepository, workTimeService, clock = () => new Date() }) {
  if (!feedbackRepository || typeof feedbackRepository.getCurrentProcessingRoundDraft !== 'function') {
    throw new TypeError('feedbackRepository.getCurrentProcessingRoundDraft is required')
  }
  if (typeof feedbackRepository.getLockedProcessingRoundDraft !== 'function') {
    throw new TypeError('feedbackRepository.getLockedProcessingRoundDraft is required')
  }
  if (!reviewRepository || typeof reviewRepository.createReviewRound !== 'function') {
    throw new TypeError('reviewRepository.createReviewRound is required')
  }
  if (typeof reviewRepository.findReviewRoundRetry !== 'function') {
    throw new TypeError('reviewRepository.findReviewRoundRetry is required')
  }
  if (typeof reviewRepository.inspectReviewRoundRetry !== 'function') {
    throw new TypeError('reviewRepository.inspectReviewRoundRetry is required')
  }
  if (typeof reviewRepository.prepareReviewVote !== 'function' ||
      typeof reviewRepository.submitReviewVote !== 'function') {
    throw new TypeError('reviewRepository vote methods are required')
  }
  for (const method of [
    'listPendingReviews', 'getReviewDetail', 'listNotifications', 'markNotificationRead'
  ]) {
    if (typeof reviewRepository[method] !== 'function') {
      throw new TypeError(`reviewRepository.${method} is required`)
    }
  }
  if (!workTimeService || typeof workTimeService.workingMinutesBetween !== 'function' ||
      typeof workTimeService.tryAddWorkMinutes !== 'function') {
    throw new TypeError('workTimeService is required')
  }

  async function submitNodeForReview({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeInput(input)
    const safeInput = {
      businessLineId: normalized.businessLineId,
      nodeId: normalized.nodeId,
      expectedNodeVersion: normalized.expectedNodeVersion
    }
    const requestKeyHash = sha256(`${actor._id}\0${normalized.nodeId}\0${normalized.requestKey}`)
    const inputHash = sha256(JSON.stringify([
      actor._id, safeInput.businessLineId, safeInput.nodeId, safeInput.expectedNodeVersion
    ]))
    const retryContext = await reviewRepository.inspectReviewRoundRetry({
      actor,
      input: safeInput,
      requestKeyHash,
      inputHash
    })
    if (retryContext) {
      const lockedDraft = await feedbackRepository.getLockedProcessingRoundDraft({
        actor,
        businessLineId: normalized.businessLineId,
        nodeId: normalized.nodeId,
        expectedNodeVersion: normalized.expectedNodeVersion,
        reviewRoundId: retryContext.reviewRoundId
      })
      return reviewRepository.findReviewRoundRetry({
        actor, input: safeInput, requestKeyHash, inputHash,
        reviewRoundId: retryContext.reviewRoundId,
        draft: lockedDraft,
        draftHash: hashDraft(actor._id, normalized, lockedDraft)
      })
    }
    const draft = await feedbackRepository.getCurrentProcessingRoundDraft({
      actor,
      businessLineId: normalized.businessLineId,
      nodeId: normalized.nodeId,
      expectedNodeVersion: normalized.expectedNodeVersion
    })
    const at = clock()
    if (!validDate(at) || !draft || !draft.node || !validDate(new Date(draft.node.processingStartedAt))) {
      throw createError('VERSION_CONFLICT')
    }
    const processing = await workTimeService.workingMinutesBetween(
      new Date(draft.node.processingStartedAt), new Date(at)
    )
    const reviewMinutes = draft.node.reviewSlaWorkHours * 60
    if (!Number.isSafeInteger(reviewMinutes) || reviewMinutes <= 0) throw createError('VERSION_CONFLICT')
    const reviewDue = await workTimeService.tryAddWorkMinutes(new Date(at), reviewMinutes)
    const draftHash = hashDraft(actor._id, normalized, draft)
    return reviewRepository.createReviewRound({
      actor,
      input: safeInput,
      draft,
      timing: {
        ...buildProcessingTiming(draft.node, processing, at),
        ...buildReviewTiming(draft.node, at, reviewDue)
      },
      requestKeyHash,
      inputHash,
      draftHash
    })
  }

  async function submitReviewVote({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeVote(input)
    const safeInput = {
      reviewRoundId: normalized.reviewRoundId,
      expectedRoundVersion: normalized.expectedRoundVersion,
      decision: normalized.decision,
      comment: normalized.comment
    }
    const requestKeyHash = sha256(
      `${actor._id}\0${normalized.reviewRoundId}\0${normalized.requestKey}`
    )
    const inputHash = sha256(JSON.stringify([
      actor._id, safeInput.reviewRoundId, safeInput.expectedRoundVersion,
      safeInput.decision, safeInput.comment
    ]))
    const context = await reviewRepository.prepareReviewVote({
      actor, input: safeInput, requestKeyHash, inputHash
    })
    const at = clock()
    if (!validDate(at) || !context ||
        !['rework', 'next_node', 'complete_line', 'finalized_retry'].includes(context.transition)) {
      throw createError('VERSION_CONFLICT')
    }
    const timing = { transitionAt: new Date(at) }
    if (context.transition !== 'finalized_retry') {
      const elapsed = await workTimeService.workingMinutesBetween(
        new Date(context.reviewStartedAt), new Date(at)
      )
      Object.assign(timing,
        buildCompletedReviewTiming(context, elapsed),
        buildReviewResponseTiming(context, elapsed, at))
    }
    if (context.transition === 'rework' && context.processingCarryoverPending === true) {
      Object.assign(timing, {
        processingDueStatus: 'pending_calendar',
        processingDueAt: null,
        processingCalendarVersion: null
      })
    } else if (!['complete_line', 'finalized_retry'].includes(context.transition)) {
      if (!Number.isSafeInteger(context.processingWorkMinutes) || context.processingWorkMinutes < 0) {
        throw createError('VERSION_CONFLICT')
      }
      const due = await workTimeService.tryAddWorkMinutes(
        new Date(at), context.processingWorkMinutes
      )
      if (due && due.status === 'calculated' && validDate(due.dueAt)) {
        Object.assign(timing, {
          processingDueStatus: 'calculated',
          processingDueAt: new Date(due.dueAt),
          processingCalendarVersion: due.calendarVersion || null
        })
      } else if (due && due.status === 'pending_calendar' && due.dueAt === null) {
        Object.assign(timing, {
          processingDueStatus: 'pending_calendar',
          processingDueAt: null,
          processingCalendarVersion: null
        })
      } else {
        throw createError('VERSION_CONFLICT')
      }
    }
    return reviewRepository.submitReviewVote({
      actor,
      input: safeInput,
      context,
      timing,
      requestKeyHash,
      inputHash
    })
  }

  async function listMyPendingReviews({ actor, query }) {
    requireActiveActor(actor)
    return reviewRepository.listPendingReviews({ actor, query: normalizeQuery(query) })
  }

  async function getReviewDetail({ actor, reviewRoundId }) {
    requireActiveActor(actor)
    return reviewRepository.getReviewDetail({
      actor,
      reviewRoundId: normalizeDocumentId(reviewRoundId)
    })
  }

  async function listMyNotifications({ actor, query }) {
    requireActiveActor(actor)
    return reviewRepository.listNotifications({ actor, query: normalizeQuery(query) })
  }

  async function markNotificationRead({ actor, notificationId }) {
    requireActiveActor(actor)
    return reviewRepository.markNotificationRead({
      actor,
      notificationId: normalizeNotificationId(notificationId)
    })
  }

  return {
    submitNodeForReview,
    submitReviewVote,
    listMyPendingReviews,
    getReviewDetail,
    listMyNotifications,
    markNotificationRead
  }
}

module.exports = { createReviewService }
