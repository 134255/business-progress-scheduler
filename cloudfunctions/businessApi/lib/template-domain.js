const { normalizeFieldDefinition } = require('./field-domain')
const { WORKFLOW_MODE, normalizeReviewMode } = require('./review-domain')

const DEFAULT_SLA_WORK_HOURS = 22
const ALLOWED_EVIDENCE_TYPES = Object.freeze(['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError('TEMPLATE_INVALID')
  return value.trim()
}

function normalizeSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw createError('TEMPLATE_INVALID')
  return value
}

function normalizeAccountIds(value) {
  if (!Array.isArray(value)) throw createError('TEMPLATE_INVALID')
  const ids = value.map(requireText)
  if (new Set(ids).size !== ids.length) throw createError('TEMPLATE_INVALID')
  return ids
}

function normalizeEvidenceTypes(value) {
  if (!Array.isArray(value)) throw createError('TEMPLATE_INVALID')
  const types = value.map(type => {
    if (typeof type !== 'string') throw createError('TEMPLATE_INVALID')
    const normalized = type.trim().toLowerCase()
    if (!ALLOWED_EVIDENCE_TYPES.includes(normalized)) throw createError('TEMPLATE_INVALID')
    return normalized
  })
  if (new Set(types).size !== types.length) throw createError('TEMPLATE_INVALID')
  return types
}

function normalizeFields(fields) {
  if (!Array.isArray(fields)) throw createError('TEMPLATE_INVALID')
  let normalized
  try {
    normalized = fields.map(normalizeFieldDefinition)
  } catch (error) {
    throw createError('TEMPLATE_INVALID')
  }
  if (new Set(normalized.map(field => field.fieldKey)).size !== normalized.length) throw createError('TEMPLATE_INVALID')
  return normalized.map((field, sequence) => ({ ...field, sequence }))
}

function normalizeTemplateNode(input) {
  if (!isPlainObject(input)) throw createError('TEMPLATE_INVALID')
  const requiresEvidence = input.requiresEvidence === undefined ? false : input.requiresEvidence
  if (typeof requiresEvidence !== 'boolean') throw createError('TEMPLATE_INVALID')
  const processingSlaWorkHours = input.processingSlaWorkHours === undefined ? DEFAULT_SLA_WORK_HOURS : input.processingSlaWorkHours
  const reviewSlaWorkHours = input.reviewSlaWorkHours === undefined ? DEFAULT_SLA_WORK_HOURS : input.reviewSlaWorkHours
  if (!Number.isFinite(processingSlaWorkHours) || processingSlaWorkHours <= 0) throw createError('TEMPLATE_INVALID')
  if (!Number.isFinite(reviewSlaWorkHours) || reviewSlaWorkHours <= 0) throw createError('TEMPLATE_INVALID')
  let reviewMode
  try {
    reviewMode = normalizeReviewMode(input.reviewMode === undefined ? 'any' : input.reviewMode)
  } catch (error) {
    throw createError('TEMPLATE_INVALID')
  }
  const allowedEvidenceTypes = normalizeEvidenceTypes(input.allowedEvidenceTypes === undefined ? [] : input.allowedEvidenceTypes)
  if (requiresEvidence && allowedEvidenceTypes.length === 0) throw createError('TEMPLATE_INVALID')

  return {
    nodeKey: requireText(input.nodeKey),
    sequence: input.sequence === undefined ? 0 : normalizeSequence(input.sequence),
    name: requireText(input.name),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    workflowMode: WORKFLOW_MODE,
    processorUserIds: normalizeAccountIds(input.processorUserIds === undefined ? [] : input.processorUserIds),
    reviewerUserIds: normalizeAccountIds(input.reviewerUserIds === undefined ? [] : input.reviewerUserIds),
    reviewMode,
    processingSlaWorkHours,
    reviewSlaWorkHours,
    requiresEvidence,
    allowedEvidenceTypes,
    fields: normalizeFields(input.fields === undefined ? [] : input.fields)
  }
}

function assertTemplateEditable(template) {
  if (!isPlainObject(template) || template.status === 'deleted') throw createError('NOT_FOUND')
  if (template.status === 'enabled') throw createError('TEMPLATE_NOT_EDITABLE')
}

function validateTemplateForEnable(template, nodes, activeUserIds) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw createError('TEMPLATE_INVALID')
  let normalizedNodes
  try {
    normalizedNodes = nodes.map(normalizeTemplateNode)
  } catch (error) {
    if (error.code === 'TEMPLATE_INVALID') throw error
    throw createError('TEMPLATE_INVALID')
  }
  if (new Set(normalizedNodes.map(node => node.nodeKey)).size !== normalizedNodes.length) {
    throw createError('TEMPLATE_INVALID')
  }
  const orderedNodes = normalizedNodes.slice().sort((left, right) => left.sequence - right.sequence)
  if (orderedNodes.some((node, index) => node.sequence !== index)) throw createError('TEMPLATE_INVALID')
  if (!Array.isArray(activeUserIds)) throw createError('TEMPLATE_INVALID')
  const active = new Set(activeUserIds)
  for (const node of orderedNodes) {
    if (!node.processorUserIds.length || !node.reviewerUserIds.length) throw createError('TEMPLATE_INVALID')
    if (node.processorUserIds.some(id => !active.has(id))) throw createError('PROCESSOR_INACTIVE')
    if (node.reviewerUserIds.some(id => !active.has(id))) throw createError('REVIEWER_INACTIVE')
    if (node.processorUserIds.some(id => node.reviewerUserIds.includes(id))) throw createError('ROLE_OVERLAP')
  }
  return true
}

module.exports = {
  DEFAULT_SLA_WORK_HOURS,
  ALLOWED_EVIDENCE_TYPES,
  normalizeTemplateNode,
  validateTemplateForEnable,
  assertTemplateEditable
}
