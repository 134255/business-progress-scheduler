const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { resolveCompletedNodeTarget } = require('./workflow-routing-domain')
const { synchronizeSearchResult } = require('./search-version')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const INPUT_KEYS = new Set([
  'businessLineId', 'nodeId', 'expectedLineVersion', 'expectedNodeVersion',
  'fieldValues', 'requestKey'
])
const FIELD_VALUE_KEYS = new Set(['fieldKey', 'name', 'type', 'value'])

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw createError('VALIDATION_ERROR')
  }
  return descriptor.value
}

function safeScalar(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  if (!Array.isArray(value)) throw createError('VALIDATION_ERROR')
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const item = ownValue(value, String(index))
    if (!['string', 'number', 'boolean'].includes(typeof item)) throw createError('VALIDATION_ERROR')
    result.push(item)
  }
  return result
}

function safeFieldValues(value) {
  if (!Array.isArray(value)) throw createError('VALIDATION_ERROR')
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const item = ownValue(value, String(index))
    if (!isPlainObject(item) || Reflect.ownKeys(item).some(key =>
      typeof key !== 'string' || !FIELD_VALUE_KEYS.has(key))) throw createError('VALIDATION_ERROR')
    const normalized = {
      fieldKey: ownValue(item, 'fieldKey'),
      name: ownValue(item, 'name'),
      type: ownValue(item, 'type'),
      value: safeScalar(ownValue(item, 'value'))
    }
    if (![normalized.fieldKey, normalized.name, normalized.type].every(text =>
      typeof text === 'string' && text)) throw createError('VALIDATION_ERROR')
    result.push(normalized)
  }
  return result
}

function normalizeInput(input) {
  if (!isPlainObject(input) || Reflect.ownKeys(input).some(key =>
    typeof key !== 'string' || !INPUT_KEYS.has(key))) throw createError('VALIDATION_ERROR')
  const businessLineId = ownValue(input, 'businessLineId')
  const nodeId = ownValue(input, 'nodeId')
  const expectedLineVersion = ownValue(input, 'expectedLineVersion')
  const expectedNodeVersion = ownValue(input, 'expectedNodeVersion')
  const fieldValues = safeFieldValues(ownValue(input, 'fieldValues'))
  const requestKey = ownValue(input, 'requestKey')
  if (!DOCUMENT_ID.test(businessLineId) || !DOCUMENT_ID.test(nodeId) ||
      !Number.isSafeInteger(expectedLineVersion) || expectedLineVersion < 1 ||
      !Number.isSafeInteger(expectedNodeVersion) || expectedNodeVersion < 1 ||
      typeof requestKey !== 'string' || !REQUEST_KEY.test(requestKey)) {
    throw createError('VALIDATION_ERROR')
  }
  return { businessLineId, nodeId, expectedLineVersion, expectedNodeVersion, fieldValues, requestKey }
}

function requireActor(actor) {
  if (!actor || actor.status !== 'active' || typeof actor._id !== 'string' ||
      !DOCUMENT_ID.test(actor._id)) throw createError('FORBIDDEN')
}

function processingTiming(result, at) {
  if (result && result.status === 'calculated' && result.dueAt instanceof Date &&
      !Number.isNaN(result.dueAt.getTime()) && result.dueAt.getTime() >= at.getTime() &&
      (result.calendarVersion === null || result.calendarVersion === undefined ||
        typeof result.calendarVersion === 'string')) {
    return {
      processingStartedAt: new Date(at),
      processingDueStatus: 'calculated',
      processingDueAt: new Date(result.dueAt),
      processingCalendarVersion: result.calendarVersion || null
    }
  }
  if (result && result.status === 'pending_calendar' && result.dueAt === null) {
    return {
      processingStartedAt: new Date(at),
      processingDueStatus: 'pending_calendar',
      processingDueAt: null,
      processingCalendarVersion: null
    }
  }
  throw createError('VERSION_CONFLICT')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function createWorkflowTransitionService({
  repository, workTimeService, businessSearchClient = null, clock = () => new Date()
}) {
  if (!repository || typeof repository.inspectCompletion !== 'function' ||
      typeof repository.commitCompletion !== 'function') throw new TypeError('repository is required')
  if (!workTimeService || typeof workTimeService.tryAddWorkMinutes !== 'function') {
    throw new TypeError('workTimeService is required')
  }

  async function complete({ actor, input }) {
    requireActor(actor)
    const normalized = normalizeInput(input)
    const safeInput = {
      businessLineId: normalized.businessLineId,
      nodeId: normalized.nodeId,
      expectedLineVersion: normalized.expectedLineVersion,
      expectedNodeVersion: normalized.expectedNodeVersion,
      fieldValues: normalized.fieldValues
    }
    const requestKeyHash = sha256(`${actor._id}\0${normalized.nodeId}\0${normalized.requestKey}`)
    const inputHash = sha256(JSON.stringify([
      actor._id, safeInput.businessLineId, safeInput.nodeId,
      safeInput.expectedLineVersion, safeInput.expectedNodeVersion, safeInput.fieldValues
    ]))
    const context = await repository.inspectCompletion({
      actor, input: safeInput, requestKeyHash, inputHash
    })
    if (context && context.retryResult) return context.retryResult
    let resolved
    try {
      resolved = resolveCompletedNodeTarget({ node: context.node, fieldValues: safeInput.fieldValues })
    } catch (error) {
      throw createError('VERSION_CONFLICT')
    }
    let transition
    let timing
    if (resolved.kind === 'end') {
      transition = { kind: 'complete_line' }
    } else if (resolved.kind === 'manual') {
      transition = { kind: 'await_manual_decision' }
    } else {
      if (!context.targetNode || context.targetNode._id !== resolved.nodeId ||
          context.targetNode.businessLineId !== safeInput.businessLineId ||
          !Number.isSafeInteger(context.targetNode.processingSlaWorkHours) ||
          context.targetNode.processingSlaWorkHours <= 0) throw createError('VERSION_CONFLICT')
      transition = { kind: 'activate_node', targetNodeId: resolved.nodeId }
      const at = clock()
      if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError('clock must return a Date')
      const minutes = context.targetNode.processingSlaWorkHours * 60
      if (!Number.isSafeInteger(minutes) || minutes <= 0) throw createError('VERSION_CONFLICT')
      timing = processingTiming(
        await workTimeService.tryAddWorkMinutes(new Date(at), minutes), at
      )
    }
    const commit = {
      actor, input: safeInput, context, transition, requestKeyHash, inputHash,
      ...(timing ? { timing } : {})
    }
    return synchronizeSearchResult(
      await repository.commitCompletion(commit), businessSearchClient
    )
  }

  return { complete }
}

module.exports = { createWorkflowTransitionService }
