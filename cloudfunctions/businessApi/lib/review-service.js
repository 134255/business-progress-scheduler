const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INPUT_KEYS = new Set(['businessLineId', 'nodeId', 'expectedNodeVersion', 'requestKey'])

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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hashDraft(actorId, input, draft) {
  return sha256(JSON.stringify([
    actorId, input.businessLineId, input.nodeId, input.expectedNodeVersion,
    draft.feedbackId, draft.feedbackRevision, draft.processingRoundNumber,
    draft.fieldSnapshots, draft.evidenceIds, draft.evidenceTotalBytes
  ]))
}

function strictWorkMinutes(value, code = 'VERSION_CONFLICT') {
  if (!Number.isSafeInteger(value) || value < 0) throw createError(code)
  return value
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function buildProcessingTiming(node, calculated) {
  const total = node.processingSlaWorkHours * 60
  if (!Number.isSafeInteger(total) || total <= 0) throw createError('VERSION_CONFLICT')
  const previous = strictWorkMinutes(node.processingElapsedWorkMinutes || 0)
  if (calculated && calculated.status === 'calculated' &&
      Number.isSafeInteger(calculated.minutes) && calculated.minutes >= 0) {
    const elapsed = strictWorkMinutes(previous + calculated.minutes)
    return {
      processingTimingStatus: 'calculated',
      processingElapsedWorkMinutes: elapsed,
      processingRemainingWorkMinutes: Math.max(0, total - elapsed),
      processingOverdueWorkMinutes: Math.max(0, elapsed - total),
      processingCalendarVersion: calculated.calendarVersion || null
    }
  }
  if (calculated && calculated.status === 'pending_calendar' && calculated.minutes === null) {
    return {
      processingTimingStatus: 'pending_calendar',
      processingElapsedWorkMinutes: previous,
      processingRemainingWorkMinutes: Math.max(0, total - previous),
      processingOverdueWorkMinutes: Math.max(0, previous - total),
      processingCalendarVersion: null
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
        ...buildProcessingTiming(draft.node, processing),
        ...buildReviewTiming(draft.node, at, reviewDue)
      },
      requestKeyHash,
      inputHash,
      draftHash
    })
  }

  return { submitNodeForReview }
}

module.exports = { createReviewService }
