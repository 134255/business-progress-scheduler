const crypto = require('node:crypto')

const { validateFieldValues } = require('./field-domain')
const { validateFeedbackTotalSize } = require('./evidence-policy')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FEEDBACK_STATUSES = new Set(['in_progress', 'blocked', 'completed'])
const INPUT_KEYS = new Set([
  'businessLineId', 'nodeId', 'expectedNodeVersion', 'status',
  'fieldValues', 'comment', 'evidenceIds', 'requestKey'
])
const REQUIRED_INPUT_KEYS = [...INPUT_KEYS]

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
  return crypto.createHash('sha256').update(JSON.stringify([
    actor._id, input.businessLineId, input.nodeId, input.expectedNodeVersion,
    input.status, input.fieldValues, input.comment, input.evidenceIds, input.requestKey
  ])).digest('hex')
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

function createFeedbackService({ repository }) {
  if (!repository) throw new TypeError('repository is required')

  async function submitFeedback({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeInput(input)
    const requestFingerprint = createRequestFingerprint(actor, normalized)
    const { fieldValues, ...commitInput } = normalized
    const published = await repository.findPublishedFeedback({ actor, input: commitInput, requestFingerprint })
    if (published) return published
    const submission = await repository.getSubmissionContext({
      actor,
      businessLineId: normalized.businessLineId,
      nodeId: normalized.nodeId,
      evidenceIds: normalized.evidenceIds
    })
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
    return repository.commitFeedback({
      actor,
      input: commitInput,
      requestFingerprint,
      fieldSnapshots,
      evidenceTotalBytes
    })
  }

  async function getNodeHistory({ actor, businessLineId, nodeId }) {
    requireActiveActor(actor)
    return repository.getNodeHistory({ actor, businessLineId: requireId(businessLineId), nodeId: requireId(nodeId) })
  }

  return { submitFeedback, getNodeHistory }
}

module.exports = { createFeedbackService, createRequestFingerprint }
