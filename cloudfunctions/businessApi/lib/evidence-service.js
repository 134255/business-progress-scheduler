const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { MAX_SINGLE_FILE_SIZE } = require('./evidence-policy')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const CLOUD_FILE_ID = /^cloud:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_./-]{1,768}$/

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function normalizeDocumentId(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!DOCUMENT_ID.test(normalized)) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return normalized
}

function normalizeCloudFileId(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!CLOUD_FILE_ID.test(normalized) || normalized.includes('//', 'cloud://'.length) ||
      normalized.split('/').some(segment => segment === '.' || segment === '..')) {
    throw createError('EVIDENCE_NOT_ATTACHABLE')
  }
  return normalized
}

function normalizeFileName(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 255 ||
      /[\0-\x1f\x7f\\/]/.test(value)) {
    throw createError('EVIDENCE_NOT_ATTACHABLE')
  }
  return value
}

function createEvidenceService({ repository }) {
  if (!repository) throw new TypeError('repository is required')

  async function registerUpload({ actor, input }) {
    if (!actor || typeof actor !== 'object' || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id) ||
        !input || typeof input !== 'object' || !Number.isSafeInteger(input.declaredSize) ||
        input.declaredSize < 0) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    if (input.declaredSize > MAX_SINGLE_FILE_SIZE) throw createError('FILE_TOO_LARGE')
    const purpose = input.purpose === undefined ? 'node_feedback' : input.purpose
    if (!['node_feedback', 'audit_amendment'].includes(purpose)) throw createError('EVIDENCE_NOT_ATTACHABLE')
    if (purpose === 'audit_amendment' && actor.role !== 'super_admin') throw createError('FORBIDDEN')
    const nodeId = purpose === 'audit_amendment'
      ? null
      : normalizeDocumentId(input.nodeId)
    return repository.registerUpload({
      actor,
      input: {
        businessLineId: normalizeDocumentId(input.businessLineId),
        nodeId,
        ...(purpose === 'audit_amendment' ? { purpose } : {}),
        fileId: normalizeCloudFileId(input.fileId),
        fileName: normalizeFileName(input.fileName),
        declaredSize: input.declaredSize
      }
    })
  }

  async function getAccessGrant({ actor, evidenceId }) {
    if (!actor || typeof actor !== 'object' || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id)) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    return repository.getAccessGrant({ actor, evidenceId: normalizeDocumentId(evidenceId) })
  }

  return { registerUpload, getAccessGrant }
}

module.exports = {
  createEvidenceService,
  normalizeCloudFileId
}
