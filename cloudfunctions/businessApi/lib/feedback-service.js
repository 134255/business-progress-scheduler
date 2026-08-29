const crypto = require('node:crypto')

const { validateFieldValues } = require('./field-domain')
const { validateFeedbackTotalSize } = require('./evidence-policy')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { synchronizeSearchResult } = require('./search-version')
const { ownExactAccountIds } = require('./account-relationship-schema')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FEEDBACK_STATUSES = new Set(['in_progress', 'blocked', 'completed'])
const PROGRESS_ACTIONS = new Set(['save_progress', 'mark_blocked', 'complete_node'])
const INPUT_KEYS = new Set([
  'businessLineId', 'nodeId', 'expectedNodeVersion', 'status',
  'fieldValues', 'comment', 'evidenceIds', 'requestKey'
])
const REQUIRED_INPUT_KEYS = [...INPUT_KEYS]
const PROGRESS_INPUT_KEYS = new Set([
  'businessLineId', 'nodeId', 'expectedNodeVersion', 'action',
  'fieldValues', 'comment', 'evidenceIds', 'requestKey'
])

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function markApplicationError(error) {
  if (error && typeof error === 'object') error[APPLICATION_ERROR_MARKER] = true
  throw error
}

function requireActiveActor(actor) {
  if (!actor || actor.status !== 'active' || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id)) {
    throw createError('FORBIDDEN')
  }
}

function requireId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw createError('VALIDATION_ERROR')
  return value
}

function isPlainOwnObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function createRequestFingerprint(actor, input) {
  const identity = [
    actor._id, input.businessLineId, input.nodeId, input.expectedNodeVersion,
    input.status, input.fieldValues, input.comment, input.evidenceIds, input.requestKey
  ]
  if (input.action) identity.splice(5, 0, input.action)
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function normalizeInput(input) {
  if (!isPlainOwnObject(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !INPUT_KEYS.has(key)) ||
      REQUIRED_INPUT_KEYS.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      })) {
    throw createError('VALIDATION_ERROR')
  }
  if (!Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 1 ||
      !FEEDBACK_STATUSES.has(input.status) || typeof input.requestKey !== 'string' ||
      !REQUEST_KEY.test(input.requestKey) || !Array.isArray(input.fieldValues) ||
      !Array.isArray(input.evidenceIds)) {
    throw createError('VALIDATION_ERROR')
  }
  if (input.comment !== undefined && input.comment !== null && typeof input.comment !== 'string') {
    throw createError('VALIDATION_ERROR')
  }
  const evidenceIds = input.evidenceIds.map(requireId)
  if (new Set(evidenceIds).size !== evidenceIds.length) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return {
    businessLineId: requireId(input.businessLineId),
    nodeId: requireId(input.nodeId),
    expectedNodeVersion: input.expectedNodeVersion,
    status: input.status,
    fieldValues: input.fieldValues,
    comment: typeof input.comment === 'string' ? input.comment.trim() : '',
    evidenceIds,
    requestKey: input.requestKey
  }
}

function normalizeProgressInput(input) {
  if (!isPlainOwnObject(input) || Reflect.ownKeys(input).some(key =>
    typeof key !== 'string' || !PROGRESS_INPUT_KEYS.has(key)) ||
      [...PROGRESS_INPUT_KEYS].some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      })) {
    throw createError('VALIDATION_ERROR')
  }
  if (!PROGRESS_ACTIONS.has(input.action) || !Number.isSafeInteger(input.expectedNodeVersion) ||
      input.expectedNodeVersion < 1 || typeof input.requestKey !== 'string' ||
      !REQUEST_KEY.test(input.requestKey) || !Array.isArray(input.fieldValues) ||
      !Array.isArray(input.evidenceIds) ||
      input.comment !== undefined && input.comment !== null && typeof input.comment !== 'string') {
    throw createError('VALIDATION_ERROR')
  }
  const comment = typeof input.comment === 'string' ? input.comment.trim() : ''
  if (input.action === 'mark_blocked' && !comment) throw createError('BLOCKED_REASON_REQUIRED')
  const evidenceIds = input.evidenceIds.map(requireId)
  if (new Set(evidenceIds).size !== evidenceIds.length) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return {
    businessLineId: requireId(input.businessLineId),
    nodeId: requireId(input.nodeId),
    expectedNodeVersion: input.expectedNodeVersion,
    action: input.action,
    status: input.action === 'mark_blocked'
      ? 'blocked'
      : input.action === 'complete_node'
        ? 'completed'
        : 'in_progress',
    fieldValues: input.fieldValues,
    comment,
    evidenceIds,
    requestKey: input.requestKey
  }
}

function orderedEvidences(evidences, evidenceIds) {
  if (!Array.isArray(evidences)) throw createError('EVIDENCE_NOT_ATTACHABLE')
  const byId = new Map()
  for (const evidence of evidences) {
    if (!evidence || typeof evidence._id !== 'string' || byId.has(evidence._id)) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    byId.set(evidence._id, evidence)
  }
  return evidenceIds.map(id => {
    const evidence = byId.get(id)
    if (!evidence) throw createError('EVIDENCE_NOT_ATTACHABLE')
    return evidence
  })
}

function createFeedbackService({ repository, businessSearchClient = null }) {
  if (!repository) throw new TypeError('repository is required')

  async function submitFeedback({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeInput(input)
    const requestFingerprint = createRequestFingerprint(actor, normalized)
    const { fieldValues, ...commitInput } = normalized
    const published = await repository.findPublishedFeedback({
      actor,
      input: commitInput,
      requestFingerprint,
      legacyOnly: true
    })
    if (published) return synchronizeSearchResult(published, businessSearchClient)
    const submission = await repository.getSubmissionContext({
      actor,
      businessLineId: normalized.businessLineId,
      nodeId: normalized.nodeId,
      evidenceIds: normalized.evidenceIds
    })
    if (submission.node && submission.node.workflowMode === 'review') {
      throw createError('NODE_PENDING_REVIEW')
    }
    let fieldSnapshots
    let evidenceTotalBytes
    try {
      fieldSnapshots = validateFieldValues(submission.node.fieldDefinitions, normalized.fieldValues)
      const evidences = orderedEvidences(submission.evidences, normalized.evidenceIds)
      evidenceTotalBytes = validateFeedbackTotalSize(evidences.map(evidence => evidence.size))
    } catch (error) {
      markApplicationError(error)
    }
    if (normalized.status === 'completed' && submission.node.requiresEvidence && !normalized.evidenceIds.length) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    return synchronizeSearchResult(await repository.commitFeedback({
      actor,
      input: commitInput,
      requestFingerprint,
      fieldSnapshots,
      evidenceTotalBytes
    }), businessSearchClient)
  }

  async function saveNodeProgress({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeProgressInput(input)
    const requestFingerprint = createRequestFingerprint(actor, normalized)
    const { fieldValues, ...commitInput } = normalized
    const published = await repository.findPublishedFeedback({ actor, input: commitInput, requestFingerprint })
    if (published) return synchronizeSearchResult(published, businessSearchClient)
    const submission = await repository.getSubmissionContext({
      actor,
      businessLineId: normalized.businessLineId,
      nodeId: normalized.nodeId,
      evidenceIds: normalized.evidenceIds
    })
    if (!submission.node || submission.node.workflowMode !== 'review') throw createError('VALIDATION_ERROR')
    const reviewers = ownExactAccountIds(submission.node, 'reviewerUserIds', { nonEmpty: false })
    if (!reviewers) throw createError('FORBIDDEN')
    if (normalized.action === 'complete_node' && reviewers.length) throw createError('NODE_REVIEW_REQUIRED')
    let fieldSnapshots
    let evidenceTotalBytes
    try {
      fieldSnapshots = validateFieldValues(submission.node.fieldDefinitions, normalized.fieldValues)
      const evidences = orderedEvidences(submission.evidences, normalized.evidenceIds)
      evidenceTotalBytes = validateFeedbackTotalSize(evidences.map(evidence => evidence.size))
    } catch (error) {
      markApplicationError(error)
    }
    if (normalized.action === 'complete_node' && submission.node.requiresEvidence && !normalized.evidenceIds.length) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    return synchronizeSearchResult(await repository.commitFeedback({
      actor,
      input: commitInput,
      requestFingerprint,
      fieldSnapshots,
      evidenceTotalBytes
    }), businessSearchClient)
  }

  async function assertNodeRequiresReview({ actor, businessLineId, nodeId }) {
    requireActiveActor(actor)
    const submission = await repository.getSubmissionContext({
      actor,
      businessLineId: requireId(businessLineId),
      nodeId: requireId(nodeId),
      evidenceIds: []
    })
    if (!submission.node || submission.node.workflowMode !== 'review') throw createError('VALIDATION_ERROR')
    const reviewers = ownExactAccountIds(submission.node, 'reviewerUserIds', { nonEmpty: false })
    if (!reviewers) throw createError('FORBIDDEN')
    if (!reviewers.length) throw createError('NODE_REVIEW_NOT_REQUIRED')
    return { requiresReview: true }
  }

  async function getNodeHistory({ actor, businessLineId, nodeId }) {
    requireActiveActor(actor)
    return repository.getNodeHistory({ actor, businessLineId: requireId(businessLineId), nodeId: requireId(nodeId) })
  }

  return { submitFeedback, saveNodeProgress, assertNodeRequiresReview, getNodeHistory }
}

module.exports = { createFeedbackService, createRequestFingerprint }
