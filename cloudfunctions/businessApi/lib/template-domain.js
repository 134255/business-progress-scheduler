const crypto = require('node:crypto')

const { normalizeFieldDefinition } = require('./field-domain')
const { WORKFLOW_MODE, normalizeReviewMode } = require('./review-domain')
const {
  INDEXED_ACCOUNT_ARRAY_LIMIT_MESSAGE,
  fitsBusinessMemberArray,
  fitsIndexedAccountArray
} = require('./index-key-budget')

const DEFAULT_PROCESSING_SLA_WORK_HOURS = 22
const DEFAULT_REVIEW_SLA_WORK_HOURS = 8
const PROCESSOR_ASSIGNMENT_MODE = Object.freeze({
  FIXED_ACCOUNTS: 'fixed_accounts',
  BUSINESS_CREATOR: 'business_creator'
})
const REVIEWER_ASSIGNMENT_MODE = Object.freeze({
  FIXED_ACCOUNTS: 'fixed_accounts',
  BUSINESS_CREATOR: 'business_creator'
})
const ALLOWED_EVIDENCE_TYPES = Object.freeze(['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function hasDescriptorInPrototype(object, key) {
  let current = Object.getPrototypeOf(object)
  while (current) {
    if (Object.getOwnPropertyDescriptor(current, key)) return true
    current = Object.getPrototypeOf(current)
  }
  return false
}

function ownDataObject(value) {
  if (!isPlainObject(value)) throw createError('TEMPLATE_INVALID')
  const result = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw createError('TEMPLATE_INVALID')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !hasOwn(descriptor, 'value')) throw createError('TEMPLATE_INVALID')
    result[key] = descriptor.value
  }
  return result
}

function ownArrayValues(value) {
  if (!Array.isArray(value)) throw createError('TEMPLATE_INVALID')
  const values = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !hasOwn(descriptor, 'value')) throw createError('TEMPLATE_INVALID')
    values.push(descriptor.value)
  }
  return values
}

function normalizeProcessorAssignmentMode(input) {
  const descriptor = Object.getOwnPropertyDescriptor(input, 'processorAssignmentMode')
  if (!descriptor) {
    if (hasDescriptorInPrototype(input, 'processorAssignmentMode')) throw createError('TEMPLATE_INVALID')
    return PROCESSOR_ASSIGNMENT_MODE.FIXED_ACCOUNTS
  }
  if (!hasOwn(descriptor, 'value')) throw createError('TEMPLATE_INVALID')
  if (![PROCESSOR_ASSIGNMENT_MODE.FIXED_ACCOUNTS, PROCESSOR_ASSIGNMENT_MODE.BUSINESS_CREATOR].includes(descriptor.value)) {
    throw createError('TEMPLATE_INVALID')
  }
  return descriptor.value
}

function normalizeReviewerAssignmentMode(input) {
  const descriptor = Object.getOwnPropertyDescriptor(input, 'reviewerAssignmentMode')
  if (!descriptor) {
    if (hasDescriptorInPrototype(input, 'reviewerAssignmentMode')) throw createError('TEMPLATE_INVALID')
    return REVIEWER_ASSIGNMENT_MODE.FIXED_ACCOUNTS
  }
  if (!hasOwn(descriptor, 'value')) throw createError('TEMPLATE_INVALID')
  if (![REVIEWER_ASSIGNMENT_MODE.FIXED_ACCOUNTS, REVIEWER_ASSIGNMENT_MODE.BUSINESS_CREATOR].includes(descriptor.value)) {
    throw createError('TEMPLATE_INVALID')
  }
  return descriptor.value
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError('TEMPLATE_INVALID')
  return value.trim()
}

function normalizeSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw createError('TEMPLATE_INVALID')
  return value
}

function validSlaHours(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(value * 60)
}

function normalizeAccountIds(value) {
  const ids = ownArrayValues(value).map(requireText)
  if (new Set(ids).size !== ids.length) throw createError('TEMPLATE_INVALID')
  return ids
}

function assertIndexedAccountArray(values) {
  if (!fitsIndexedAccountArray(values)) {
    throw createError('TEMPLATE_LIMIT_EXCEEDED', INDEXED_ACCOUNT_ARRAY_LIMIT_MESSAGE)
  }
  return values
}

function normalizeEvidenceTypes(value) {
  const types = ownArrayValues(value).map(type => {
    if (typeof type !== 'string') throw createError('TEMPLATE_INVALID')
    const normalized = type.trim().toLowerCase()
    if (!ALLOWED_EVIDENCE_TYPES.includes(normalized)) throw createError('TEMPLATE_INVALID')
    return normalized
  })
  if (new Set(types).size !== types.length) throw createError('TEMPLATE_INVALID')
  return types
}

function normalizeFields(fields) {
  const values = ownArrayValues(fields)
  let normalized
  try {
    normalized = values.map(field => normalizeFieldDefinition(ownDataObject(field)))
  } catch (error) {
    throw createError('TEMPLATE_INVALID')
  }
  if (new Set(normalized.map(field => field.fieldKey)).size !== normalized.length) throw createError('TEMPLATE_INVALID')
  return normalized.map((field, sequence) => ({ ...field, sequence }))
}

function normalizeTemplateNode(input) {
  input = ownDataObject(input)
  if (hasOwn(input, 'assigneeUserIds') || hasOwn(input, 'slaWorkHours')) throw createError('TEMPLATE_INVALID')
  const processorAssignmentMode = normalizeProcessorAssignmentMode(input)
  const reviewerAssignmentMode = normalizeReviewerAssignmentMode(input)
  const requiresEvidence = input.requiresEvidence === undefined ? false : input.requiresEvidence
  if (typeof requiresEvidence !== 'boolean') throw createError('TEMPLATE_INVALID')
  const processingSlaWorkHours = input.processingSlaWorkHours === undefined ? DEFAULT_PROCESSING_SLA_WORK_HOURS : input.processingSlaWorkHours
  const reviewSlaWorkHours = input.reviewSlaWorkHours === undefined ? DEFAULT_REVIEW_SLA_WORK_HOURS : input.reviewSlaWorkHours
  if (!validSlaHours(processingSlaWorkHours)) throw createError('TEMPLATE_INVALID')
  if (!validSlaHours(reviewSlaWorkHours)) throw createError('TEMPLATE_INVALID')
  let reviewMode
  try {
    reviewMode = normalizeReviewMode(input.reviewMode === undefined ? 'any' : input.reviewMode)
  } catch (error) {
    throw createError('TEMPLATE_INVALID')
  }
  const allowedEvidenceTypes = normalizeEvidenceTypes(input.allowedEvidenceTypes === undefined ? [] : input.allowedEvidenceTypes)
  if (requiresEvidence && allowedEvidenceTypes.length === 0) throw createError('TEMPLATE_INVALID')
  const processorUserIds = assertIndexedAccountArray(normalizeAccountIds(input.processorUserIds === undefined ? [] : input.processorUserIds))
  if (processorAssignmentMode === PROCESSOR_ASSIGNMENT_MODE.BUSINESS_CREATOR && processorUserIds.length) {
    throw createError('TEMPLATE_INVALID')
  }
  const reviewerUserIds = assertIndexedAccountArray(normalizeAccountIds(input.reviewerUserIds === undefined ? [] : input.reviewerUserIds))
  if (reviewerAssignmentMode === REVIEWER_ASSIGNMENT_MODE.BUSINESS_CREATOR && reviewerUserIds.length) {
    throw createError('TEMPLATE_INVALID')
  }

  return {
    nodeKey: requireText(input.nodeKey),
    sequence: input.sequence === undefined ? 0 : normalizeSequence(input.sequence),
    name: requireText(input.name),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    workflowMode: WORKFLOW_MODE,
    processorAssignmentMode,
    processorUserIds,
    reviewerAssignmentMode,
    reviewerUserIds,
    reviewMode,
    processingSlaWorkHours,
    reviewSlaWorkHours,
    requiresEvidence,
    allowedEvidenceTypes,
    fields: normalizeFields(input.fields === undefined ? [] : input.fields)
  }
}

function normalizeLegacyTemplateNode(input) {
  input = ownDataObject(input)
  if (['workflowMode', 'processorAssignmentMode', 'processorUserIds', 'reviewerAssignmentMode',
    'reviewerUserIds', 'reviewMode', 'processingSlaWorkHours', 'reviewSlaWorkHours']
    .some(key => hasOwn(input, key))) throw createError('TEMPLATE_INVALID')
  const requiresEvidence = input.requiresEvidence === undefined ? false : input.requiresEvidence
  if (typeof requiresEvidence !== 'boolean') throw createError('TEMPLATE_INVALID')
  const slaWorkHours = input.slaWorkHours === undefined ? DEFAULT_PROCESSING_SLA_WORK_HOURS : input.slaWorkHours
  if (!validSlaHours(slaWorkHours)) throw createError('TEMPLATE_INVALID')
  const allowedEvidenceTypes = normalizeEvidenceTypes(input.allowedEvidenceTypes === undefined ? [] : input.allowedEvidenceTypes)
  if (requiresEvidence && allowedEvidenceTypes.length === 0) throw createError('TEMPLATE_INVALID')
  return {
    nodeKey: requireText(input.nodeKey),
    sequence: input.sequence === undefined ? 0 : normalizeSequence(input.sequence),
    name: requireText(input.name),
    assigneeUserIds: assertIndexedAccountArray(normalizeAccountIds(input.assigneeUserIds)),
    slaWorkHours,
    requiresEvidence,
    allowedEvidenceTypes,
    fields: normalizeFields(input.fields === undefined ? [] : input.fields)
  }
}

function normalizeDefinitionNodes(nodes) {
  const nodeValues = ownArrayValues(nodes)
  if (nodeValues.length === 0) throw createError('TEMPLATE_INVALID')
  const workflowModes = nodeValues.map(node => {
    if (!isPlainObject(node)) throw createError('TEMPLATE_INVALID')
    const safeNode = ownDataObject(node)
    if (safeNode.workflowMode === WORKFLOW_MODE ||
        (!hasOwn(node, 'workflowMode') && (hasOwn(node, 'processorUserIds') || hasOwn(node, 'reviewerUserIds')))) {
      return WORKFLOW_MODE
    }
    if (!hasOwn(node, 'workflowMode') && hasOwn(node, 'assigneeUserIds')) return 'legacy'
    throw createError('TEMPLATE_INVALID')
  })
  if (new Set(workflowModes).size !== 1) throw createError('TEMPLATE_INVALID')
  const workflowMode = workflowModes[0]
  const normalizedNodes = workflowMode === WORKFLOW_MODE
    ? nodeValues.map(normalizeTemplateNode)
    : nodeValues.map(normalizeLegacyTemplateNode)
  if (new Set(normalizedNodes.map(node => node.nodeKey)).size !== normalizedNodes.length) {
    throw createError('TEMPLATE_INVALID')
  }
  const orderedNodes = normalizedNodes.slice().sort((left, right) => left.sequence - right.sequence)
  if (orderedNodes.some((node, index) => node.sequence !== index)) throw createError('TEMPLATE_INVALID')
  return { workflowMode, nodes: orderedNodes }
}

function templateDefinitionDigest(nodes) {
  const values = ownArrayValues(nodes)
  if (values.length === 0) {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ workflowMode: null, nodes: [] }))
      .digest('hex')
  }
  const definition = normalizeDefinitionNodes(values)
  return crypto.createHash('sha256')
    .update(JSON.stringify({ workflowMode: definition.workflowMode, nodes: definition.nodes }))
    .digest('hex')
}

function collectTemplateParticipantUserIds(nodes) {
  const definition = normalizeDefinitionNodes(nodes)
  const userIds = definition.workflowMode === WORKFLOW_MODE
    ? definition.nodes.flatMap(node => [...node.processorUserIds, ...node.reviewerUserIds])
    : definition.nodes.flatMap(node => node.assigneeUserIds)
  return [...new Set(userIds)]
}

function assertTemplateEditable(template) {
  if (!isPlainObject(template) || template.status === 'deleted') throw createError('NOT_FOUND')
  if (template.status === 'enabled') throw createError('TEMPLATE_NOT_EDITABLE')
}

function validateTemplateForEnable(template, nodes, activeUserIds) {
  const definition = normalizeDefinitionNodes(nodes)
  if (!Array.isArray(activeUserIds)) throw createError('TEMPLATE_INVALID')
  const active = new Set(activeUserIds)
  const participants = definition.workflowMode === WORKFLOW_MODE
    ? [...new Set(definition.nodes.flatMap(node => [...node.processorUserIds, ...node.reviewerUserIds]))]
    : [...new Set(definition.nodes.flatMap(node => node.assigneeUserIds))]
  if (!fitsBusinessMemberArray(participants)) {
    throw createError('TEMPLATE_LIMIT_EXCEEDED', INDEXED_ACCOUNT_ARRAY_LIMIT_MESSAGE)
  }
  for (const node of definition.nodes) {
    if (definition.workflowMode === 'legacy') {
      if (!node.assigneeUserIds.length) throw createError('TEMPLATE_INVALID')
      if (node.assigneeUserIds.some(id => !active.has(id))) throw createError('ASSIGNEE_INACTIVE')
      continue
    }
    if (node.processorAssignmentMode === PROCESSOR_ASSIGNMENT_MODE.BUSINESS_CREATOR &&
        node.reviewerAssignmentMode === REVIEWER_ASSIGNMENT_MODE.BUSINESS_CREATOR) {
      throw createError('ROLE_OVERLAP')
    }
    if (node.reviewerAssignmentMode === REVIEWER_ASSIGNMENT_MODE.FIXED_ACCOUNTS && !node.reviewerUserIds.length) {
      throw createError('TEMPLATE_INVALID')
    }
    if (node.processorAssignmentMode === PROCESSOR_ASSIGNMENT_MODE.FIXED_ACCOUNTS && !node.processorUserIds.length) {
      throw createError('TEMPLATE_INVALID')
    }
    if (node.processorAssignmentMode === PROCESSOR_ASSIGNMENT_MODE.FIXED_ACCOUNTS &&
        node.processorUserIds.some(id => !active.has(id))) throw createError('PROCESSOR_INACTIVE')
    if (node.reviewerAssignmentMode === REVIEWER_ASSIGNMENT_MODE.FIXED_ACCOUNTS &&
        node.reviewerUserIds.some(id => !active.has(id))) throw createError('REVIEWER_INACTIVE')
    if (node.processorUserIds.some(id => node.reviewerUserIds.includes(id))) throw createError('ROLE_OVERLAP')
  }
  return true
}

module.exports = {
  DEFAULT_PROCESSING_SLA_WORK_HOURS,
  DEFAULT_REVIEW_SLA_WORK_HOURS,
  PROCESSOR_ASSIGNMENT_MODE,
  REVIEWER_ASSIGNMENT_MODE,
  ALLOWED_EVIDENCE_TYPES,
  normalizeTemplateNode,
  templateDefinitionDigest,
  collectTemplateParticipantUserIds,
  validateTemplateForEnable,
  assertTemplateEditable
}
