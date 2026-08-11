const { collectTemplateParticipantUserIds, validateTemplateForEnable } = require('./template-domain')
const {
  APPLICATION_ERROR_MARKER,
  MAX_TEMPLATE_NODES,
  TEMPLATE_LIMIT_MESSAGE
} = require('./cloud-template-repository')

const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const METADATA_INPUT_KEYS = new Set([
  'businessLineId', 'expectedVersion', 'name', 'description',
  'plannedStartDate', 'plannedEndDate'
])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function requireActiveActor(actor) {
  if (!actor || typeof actor._id !== 'string' || !actor._id || actor.status !== 'active') {
    throw createError('FORBIDDEN')
  }
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError('VALIDATION_ERROR')
  return value.trim()
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return ''
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

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError('VALIDATION_ERROR')
  const plannedStartDate = normalizeDate(input.plannedStartDate)
  const plannedEndDate = normalizeDate(input.plannedEndDate)
  if (plannedStartDate && plannedEndDate && plannedStartDate > plannedEndDate) {
    throw createError('VALIDATION_ERROR')
  }
  const requestKey = requireText(input.requestKey)
  if (!REQUEST_KEY_PATTERN.test(requestKey)) throw createError('VALIDATION_ERROR')
  return {
    templateId: requireText(input.templateId),
    name: requireText(input.name),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    plannedStartDate,
    plannedEndDate,
    requestKey
  }
}

function normalizeMetadataInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError('VALIDATION_ERROR')
  if (Object.keys(input).some(key => !METADATA_INPUT_KEYS.has(key))) throw createError('VALIDATION_ERROR')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw createError('VALIDATION_ERROR')
  }
  const plannedStartDate = normalizeDate(input.plannedStartDate)
  const plannedEndDate = normalizeDate(input.plannedEndDate)
  if (plannedStartDate && plannedEndDate && plannedStartDate > plannedEndDate) {
    throw createError('VALIDATION_ERROR')
  }
  return {
    lineId: requireText(input.businessLineId),
    expectedVersion: input.expectedVersion,
    metadata: {
      name: requireText(input.name),
      description: typeof input.description === 'string' ? input.description.trim() : '',
      plannedStartDate,
      plannedEndDate
    }
  }
}

function requireEnabledDefinition(definition) {
  if (!definition || !definition.template || definition.template.status !== 'enabled') {
    throw createError('TEMPLATE_NOT_ENABLED')
  }
  if (!Array.isArray(definition.nodes) || definition.nodes.length > MAX_TEMPLATE_NODES) {
    throw createError('TEMPLATE_LIMIT_EXCEEDED', TEMPLATE_LIMIT_MESSAGE)
  }
  if (definition.template.nodeCount !== definition.nodes.length) throw createError('TEMPLATE_INVALID')
  let participantUserIds
  try {
    participantUserIds = collectTemplateParticipantUserIds(definition.nodes)
    validateTemplateForEnable(definition.template, definition.nodes, participantUserIds)
  } catch (error) {
    error[APPLICATION_ERROR_MARKER] = true
    throw error
  }
  return definition
}

function firstProcessingDue(startedAt, result) {
  if (result && result.status === 'calculated' && result.dueAt instanceof Date &&
      !Number.isNaN(result.dueAt.getTime()) &&
      (result.calendarVersion === null ||
        (typeof result.calendarVersion === 'string' && result.calendarVersion))) {
    return {
      processingStartedAt: new Date(startedAt),
      processingDueStatus: 'calculated',
      processingDueAt: new Date(result.dueAt),
      processingCalendarVersion: result.calendarVersion,
      calendarNotificationStatus: 'not_required'
    }
  }
  if (result && result.status === 'pending_calendar' && result.dueAt === null) {
    return {
      processingStartedAt: new Date(startedAt),
      processingDueStatus: 'pending_calendar',
      processingDueAt: null,
      calendarNotificationStatus: 'pending'
    }
  }
  throw createError('BUSINESS_ERROR')
}

function createBusinessService({ repository, workTimeService, clock = () => new Date() }) {
  if (!repository) throw new TypeError('repository is required')
  if (!workTimeService || typeof workTimeService.tryAddWorkMinutes !== 'function') {
    throw new TypeError('workTimeService.tryAddWorkMinutes is required')
  }
  if (typeof clock !== 'function') throw new TypeError('clock is required')

  async function createFromTemplate({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeInput(input)
    const existing = await repository.findCreationResult({ actorId: actor._id, input: normalized })
    if (existing) return existing
    const definition = requireEnabledDefinition(
      await repository.getTemplateDefinition(normalized.templateId)
    )
    const snapshotInput = { actor, input: normalized, definition }
    if (definition.nodes[0].workflowMode === 'review') {
      const startedAt = clock()
      if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
        throw new TypeError('clock must return a Date')
      }
      const minutes = definition.nodes[0].processingSlaWorkHours * 60
      if (!Number.isSafeInteger(minutes) || minutes <= 0) throw createError('TEMPLATE_INVALID')
      snapshotInput.firstProcessingDue = firstProcessingDue(
        startedAt,
        await workTimeService.tryAddWorkMinutes(new Date(startedAt), minutes)
      )
    }
    return repository.createBusinessSnapshot(snapshotInput)
  }

  async function listBusinessLines({ actor, query = {} }) {
    requireActiveActor(actor)
    return repository.listBusinessLines({ actor, query })
  }

  async function getBusinessLine({ actor, lineId }) {
    requireActiveActor(actor)
    return repository.getBusinessLine({ actor, lineId: requireText(lineId) })
  }

  async function updateMetadata({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeMetadataInput(input)
    return repository.updateBusinessMetadata({ actor, ...normalized })
  }

  return { createFromTemplate, listBusinessLines, getBusinessLine, updateMetadata }
}

module.exports = { createBusinessService }
