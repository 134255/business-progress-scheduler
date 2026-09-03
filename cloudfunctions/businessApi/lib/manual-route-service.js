const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { synchronizeSearchResult } = require('./search-version')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INPUT_KEYS = new Set([
  'businessLineId', 'nodeId', 'expectedLineVersion', 'expectedNodeVersion',
  'decision', 'comment', 'requestKey'
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

function normalizeInput(input) {
  if (!isPlainOwnObject(input) || Reflect.ownKeys(input).some(key =>
    typeof key !== 'string' || !INPUT_KEYS.has(key))) throw createError('VALIDATION_ERROR')
  for (const key of INPUT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw createError('VALIDATION_ERROR')
    }
  }
  const comment = typeof input.comment === 'string' ? input.comment.trim() : null
  if (!DOCUMENT_ID.test(input.businessLineId) || !DOCUMENT_ID.test(input.nodeId) ||
      !Number.isSafeInteger(input.expectedLineVersion) || input.expectedLineVersion < 1 ||
      !Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 1 ||
      !['activate', 'skip'].includes(input.decision) || comment === null || comment.length > 500 ||
      (input.decision === 'skip' && !comment) ||
      typeof input.requestKey !== 'string' || !REQUEST_KEY.test(input.requestKey)) {
    throw createError('VALIDATION_ERROR')
  }
  return { ...input, comment }
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function decisionTiming(calculated, at) {
  if (calculated && calculated.status === 'calculated' &&
      Number.isSafeInteger(calculated.minutes) && calculated.minutes >= 0) {
    return {
      decisionAt: new Date(at), decisionTimingStatus: 'calculated',
      decisionWorkMinutes: calculated.minutes, decisionCalendarVersion: calculated.calendarVersion || null
    }
  }
  if (calculated && calculated.status === 'pending_calendar' && calculated.minutes === null) {
    return {
      decisionAt: new Date(at), decisionTimingStatus: 'pending_calendar',
      decisionWorkMinutes: null, decisionCalendarVersion: null
    }
  }
  throw createError('VERSION_CONFLICT')
}

function processingTiming(calculated, at) {
  if (calculated && calculated.status === 'calculated' && validDate(calculated.dueAt)) {
    return {
      processingStartedAt: new Date(at), processingDueStatus: 'calculated',
      processingDueAt: new Date(calculated.dueAt),
      processingCalendarVersion: calculated.calendarVersion || null
    }
  }
  if (calculated && calculated.status === 'pending_calendar' && calculated.dueAt === null) {
    return {
      processingStartedAt: new Date(at), processingDueStatus: 'pending_calendar',
      processingDueAt: null, processingCalendarVersion: null
    }
  }
  throw createError('VERSION_CONFLICT')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createManualRouteService({
  repository, workTimeService, businessSearchClient = null, clock = () => new Date()
}) {
  if (!repository || typeof repository.inspectDecision !== 'function' ||
      typeof repository.commitDecision !== 'function') throw new TypeError('repository is required')
  if (!workTimeService || typeof workTimeService.workingMinutesBetween !== 'function' ||
      typeof workTimeService.tryAddWorkMinutes !== 'function') throw new TypeError('workTimeService is required')

  async function decide({ actor, input }) {
    if (!actor || actor.status !== 'active' || !DOCUMENT_ID.test(actor._id)) throw createError('FORBIDDEN')
    const normalized = normalizeInput(input)
    const safeInput = {
      businessLineId: normalized.businessLineId, nodeId: normalized.nodeId,
      expectedLineVersion: normalized.expectedLineVersion,
      expectedNodeVersion: normalized.expectedNodeVersion,
      decision: normalized.decision, comment: normalized.comment
    }
    const requestKeyHash = sha256(`${actor._id}\0${normalized.nodeId}\0${normalized.requestKey}`)
    const inputHash = sha256(JSON.stringify([
      actor._id, safeInput.businessLineId, safeInput.nodeId, safeInput.expectedLineVersion,
      safeInput.expectedNodeVersion, safeInput.decision, safeInput.comment
    ]))
    const context = await repository.inspectDecision({ actor, input: safeInput, requestKeyHash, inputHash })
    if (context && context.retryResult) return context.retryResult
    const at = clock()
    const startedAt = new Date(context && context.decisionStartedAt)
    if (!validDate(at) || !validDate(startedAt) || startedAt.getTime() > at.getTime()) {
      throw createError('VERSION_CONFLICT')
    }
    const elapsed = await workTimeService.workingMinutesBetween(startedAt, new Date(at))
    const timing = decisionTiming(elapsed, at)
    if (context.targetNodeId) {
      const minutes = Number(context.processingSlaWorkHours) * 60
      if (!Number.isSafeInteger(minutes) || minutes <= 0) throw createError('VERSION_CONFLICT')
      Object.assign(timing, processingTiming(await workTimeService.tryAddWorkMinutes(new Date(at), minutes), at))
    }
    return synchronizeSearchResult(await repository.commitDecision({
      actor, input: safeInput, context, timing, requestKeyHash, inputHash
    }), businessSearchClient)
  }

  return { decide }
}

module.exports = { createManualRouteService }
