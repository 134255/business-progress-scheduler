const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INPUT_KEYS = new Set([
  'businessLineId', 'nodeId', 'expectedNodeVersion', 'fieldValues', 'comment',
  'evidenceIds', 'progressRequestKey', 'reviewRequestKey'
])

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

function ownData(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw createError('VALIDATION_ERROR')
  }
  return descriptor.value
}

function normalizeInput(input) {
  if (!isPlainOwnObject(input) || Reflect.ownKeys(input).some(key =>
    typeof key !== 'string' || !INPUT_KEYS.has(key)) || Reflect.ownKeys(input).length !== INPUT_KEYS.size) {
    throw createError('VALIDATION_ERROR')
  }
  const value = Object.create(null)
  for (const key of INPUT_KEYS) value[key] = ownData(input, key)
  if (typeof value.businessLineId !== 'string' || !DOCUMENT_ID.test(value.businessLineId) ||
      typeof value.nodeId !== 'string' || !DOCUMENT_ID.test(value.nodeId) ||
      !Number.isSafeInteger(value.expectedNodeVersion) || value.expectedNodeVersion < 1 ||
      !Array.isArray(value.fieldValues) || !Array.isArray(value.evidenceIds) ||
      typeof value.comment !== 'string' ||
      typeof value.progressRequestKey !== 'string' || !REQUEST_KEY.test(value.progressRequestKey) ||
      typeof value.reviewRequestKey !== 'string' || !REQUEST_KEY.test(value.reviewRequestKey)) {
    throw createError('VALIDATION_ERROR')
  }
  return value
}

function createNodeSubmitService({ feedbackService, reviewService }) {
  if (!feedbackService || typeof feedbackService.saveNodeProgress !== 'function') {
    throw new TypeError('feedbackService.saveNodeProgress is required')
  }
  if (typeof feedbackService.assertNodeRequiresReview !== 'function') {
    throw new TypeError('feedbackService.assertNodeRequiresReview is required')
  }
  if (!reviewService || typeof reviewService.submitNodeForReview !== 'function') {
    throw new TypeError('reviewService.submitNodeForReview is required')
  }

  async function saveAndSubmitNodeForReview({ actor, input }) {
    const normalized = normalizeInput(input)
    await feedbackService.assertNodeRequiresReview({
      actor,
      businessLineId: normalized.businessLineId,
      nodeId: normalized.nodeId
    })
    const progress = await feedbackService.saveNodeProgress({
      actor,
      input: {
        businessLineId: normalized.businessLineId,
        nodeId: normalized.nodeId,
        expectedNodeVersion: normalized.expectedNodeVersion,
        action: 'save_progress',
        fieldValues: normalized.fieldValues,
        comment: normalized.comment,
        evidenceIds: normalized.evidenceIds,
        requestKey: normalized.progressRequestKey
      }
    })
    if (!progress || !Number.isSafeInteger(progress.nodeVersion) ||
        progress.nodeVersion <= normalized.expectedNodeVersion ||
        typeof progress.feedbackId !== 'string' || !DOCUMENT_ID.test(progress.feedbackId)) {
      throw createError('VERSION_CONFLICT')
    }
    const review = await reviewService.submitNodeForReview({
      actor,
      input: {
        businessLineId: normalized.businessLineId,
        nodeId: normalized.nodeId,
        expectedNodeVersion: progress.nodeVersion,
        requestKey: normalized.reviewRequestKey
      }
    })
    if (!review || typeof review.reviewRoundId !== 'string' ||
        !DOCUMENT_ID.test(review.reviewRoundId) || review.nodeStatus !== 'pending_review') {
      throw createError('VERSION_CONFLICT')
    }
    const result = {
      feedbackId: progress.feedbackId,
      reviewRoundId: review.reviewRoundId,
      nodeVersion: progress.nodeVersion,
      nodeStatus: review.nodeStatus
    }
    if (progress.searchIndexStatus === 'pending' || review.searchIndexStatus === 'pending') {
      result.searchIndexStatus = 'pending'
    }
    return result
  }

  return { saveAndSubmitNodeForReview }
}

module.exports = { createNodeSubmitService }
