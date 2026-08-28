const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { synchronizeSearchResult } = require('./search-version')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REJECTION_INPUT_KEYS = new Set([
  'businessLineId',
  'currentNodeId',
  'expectedCurrentVersion',
  'expectedPreviousVersion',
  'reason',
  'requestKey'
])
const CLOSURE_INPUT_KEYS = new Set(['businessLineId', 'expectedVersion', 'outcome', 'reason'])
const CLOSURE_OUTCOMES = new Set(['cancelled', 'closed', 'deleted'])
const AMENDMENT_INPUT_KEYS = new Set([
  'businessLineId', 'expectedVersion', 'reason', 'changes', 'evidenceIds'
])
const AMENDMENT_CHANGE_KEYS = new Set([
  'name', 'description', 'plannedStartDate', 'plannedEndDate', 'status'
])
const FROZEN_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function requireActiveActor(actor) {
  if (!actor || actor.status !== 'active' || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id)) {
    throw createError('FORBIDDEN')
  }
}

function isPlainOwnObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireOwnDataProperties(input, allowedKeys) {
  if (!isPlainOwnObject(input) || Reflect.ownKeys(input).some(key =>
    typeof key !== 'string' || !allowedKeys.has(key))) {
    throw createError('VALIDATION_ERROR')
  }
  for (const key of allowedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw createError('VALIDATION_ERROR')
    }
  }
}

function requireId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw createError('VALIDATION_ERROR')
  return value
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw createError('VALIDATION_ERROR')
  return value
}

function normalizeRejectionInput(input) {
  requireOwnDataProperties(input, REJECTION_INPUT_KEYS)
  if (typeof input.reason !== 'string') throw createError('VALIDATION_ERROR')
  const reason = input.reason.trim()
  if (!reason || reason.length > 500 || typeof input.requestKey !== 'string' ||
      !REQUEST_KEY.test(input.requestKey)) {
    throw createError('VALIDATION_ERROR')
  }
  return {
    lineId: requireId(input.businessLineId),
    currentNodeId: requireId(input.currentNodeId),
    expectedCurrentVersion: requireVersion(input.expectedCurrentVersion),
    expectedPreviousVersion: requireVersion(input.expectedPreviousVersion),
    reason,
    requestKey: input.requestKey
  }
}

function requireReason(value) {
  if (typeof value !== 'string') throw createError('VALIDATION_ERROR')
  const normalized = value.trim()
  if (!normalized || normalized.length > 500) throw createError('VALIDATION_ERROR')
  return normalized
}

function normalizeClosureInput(input) {
  requireOwnDataProperties(input, CLOSURE_INPUT_KEYS)
  if (!CLOSURE_OUTCOMES.has(input.outcome)) throw createError('VALIDATION_ERROR')
  return {
    lineId: requireId(input.businessLineId),
    expectedVersion: requireVersion(input.expectedVersion),
    outcome: input.outcome,
    reason: requireReason(input.reason)
  }
}

function normalizeDate(value) {
  if (value === '') return ''
  if (typeof value !== 'string') throw createError('VALIDATION_ERROR')
  const match = DATE_PATTERN.exec(value)
  if (!match) throw createError('VALIDATION_ERROR')
  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day)) {
    throw createError('VALIDATION_ERROR')
  }
  return value
}

function normalizeAmendmentChanges(value) {
  if (!isPlainOwnObject(value) || Reflect.ownKeys(value).some(key =>
    typeof key !== 'string' || !AMENDMENT_CHANGE_KEYS.has(key))) {
    throw createError('VALIDATION_ERROR')
  }
  const changes = {}
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw createError('VALIDATION_ERROR')
    }
    if (key === 'name') {
      if (typeof descriptor.value !== 'string' || !descriptor.value.trim()) throw createError('VALIDATION_ERROR')
      changes.name = descriptor.value.trim()
    } else if (key === 'description') {
      if (typeof descriptor.value !== 'string') throw createError('VALIDATION_ERROR')
      changes.description = descriptor.value.trim()
    } else if (key === 'plannedStartDate' || key === 'plannedEndDate') {
      changes[key] = normalizeDate(descriptor.value)
    } else if (key === 'status') {
      if (!FROZEN_STATUSES.has(descriptor.value)) throw createError('VALIDATION_ERROR')
      changes.status = descriptor.value
    }
  }
  if (changes.plannedStartDate && changes.plannedEndDate &&
      changes.plannedStartDate > changes.plannedEndDate) {
    throw createError('VALIDATION_ERROR')
  }
  return changes
}

function normalizeAmendmentInput(input) {
  requireOwnDataProperties(input, AMENDMENT_INPUT_KEYS)
  if (!Array.isArray(input.evidenceIds)) throw createError('EVIDENCE_NOT_ATTACHABLE')
  const evidenceIds = input.evidenceIds.map(value => {
    try {
      return requireId(value)
    } catch (error) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
  })
  if (new Set(evidenceIds).size !== evidenceIds.length) throw createError('EVIDENCE_NOT_ATTACHABLE')
  const changes = normalizeAmendmentChanges(input.changes)
  if (!Object.keys(changes).length && !evidenceIds.length) throw createError('VALIDATION_ERROR')
  return {
    lineId: requireId(input.businessLineId),
    expectedVersion: requireVersion(input.expectedVersion),
    reason: requireReason(input.reason),
    changes,
    evidenceIds
  }
}

function normalizeFrozenQuery(query) {
  if (!isPlainOwnObject(query) || Reflect.ownKeys(query).some(key =>
    typeof key !== 'string' || !['keyword', 'page', 'pageSize'].includes(key))) {
    throw createError('VALIDATION_ERROR')
  }
  const keyword = query.keyword === undefined ? '' : query.keyword
  const page = query.page === undefined ? 1 : query.page
  const pageSize = query.pageSize === undefined ? 20 : query.pageSize
  if (typeof keyword !== 'string' || keyword.trim().length > 100 ||
      !Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(pageSize) || pageSize < 5 || pageSize > 50) {
    throw createError('VALIDATION_ERROR')
  }
  return { keyword: keyword.trim(), page, pageSize }
}

function createBusinessLifecycleService({ repository, businessSearchClient = null }) {
  if (!repository) throw new TypeError('repository is required')

  async function rejectPreviousNode({ actor, input }) {
    requireActiveActor(actor)
    return repository.rejectPreviousNode({
      actor,
      ...normalizeRejectionInput(input)
    })
  }

  async function closeBusinessLine({ actor, input }) {
    requireActiveActor(actor)
    return repository.closeBusinessLine({ actor, ...normalizeClosureInput(input) })
  }

  async function amendFrozenBusiness({ actor, input }) {
    requireActiveActor(actor)
    if (actor.role !== 'super_admin') throw createError('FORBIDDEN')
    return synchronizeSearchResult(
      await repository.amendFrozenBusiness({ actor, ...normalizeAmendmentInput(input) }),
      businessSearchClient
    )
  }

  async function listFrozenBusinessesForAdmin({ actor, query = {} }) {
    requireActiveActor(actor)
    if (actor.role !== 'super_admin') throw createError('FORBIDDEN')
    return repository.listFrozenBusinessesForAdmin({ actor, query: normalizeFrozenQuery(query) })
  }

  async function getFrozenBusinessForAdmin({ actor, businessLineId }) {
    requireActiveActor(actor)
    if (actor.role !== 'super_admin') throw createError('FORBIDDEN')
    return repository.getFrozenBusinessForAdmin({ actor, lineId: requireId(businessLineId) })
  }

  return {
    rejectPreviousNode,
    closeBusinessLine,
    amendFrozenBusiness,
    listFrozenBusinessesForAdmin,
    getFrozenBusinessForAdmin
  }
}

module.exports = { createBusinessLifecycleService }
