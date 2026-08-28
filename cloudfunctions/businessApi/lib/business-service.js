const { collectTemplateParticipantUserIds, validateTemplateForEnable } = require('./template-domain')
const { stripSearchEnvelope, synchronizeSearchResult } = require('./search-version')
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
const LIST_QUERY_KEYS = new Set([
  'keyword', 'startDate', 'endDate', 'page', 'pageSize', 'cursor'
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
  const requestKey = requireText(input.requestKey)
  if (!REQUEST_KEY_PATTERN.test(requestKey)) throw createError('VALIDATION_ERROR')
  return {
    templateId: requireText(input.templateId),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    requestKey
  }
}

function normalizeMetadataInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError('VALIDATION_ERROR')
  if (Object.keys(input).some(key => !METADATA_INPUT_KEYS.has(key))) throw createError('VALIDATION_ERROR')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw createError('VALIDATION_ERROR')
  }
  return {
    lineId: requireText(input.businessLineId),
    expectedVersion: input.expectedVersion,
    metadata: {
      description: typeof input.description === 'string' ? input.description.trim() : ''
    }
  }
}

function normalizePendingQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(key => !['cursor', 'pageSize'].includes(key))) {
    throw createError('VALIDATION_ERROR')
  }
  const pageSize = query.pageSize === undefined ? 20 : query.pageSize
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw createError('VALIDATION_ERROR')
  }
  if (query.cursor !== undefined && typeof query.cursor !== 'string') {
    throw createError('VALIDATION_ERROR')
  }
  return { cursor: query.cursor || '', pageSize }
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

function normalizeListQuery(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(key => !LIST_QUERY_KEYS.has(key))) {
    throw createError('VALIDATION_ERROR')
  }
  const keyword = query.keyword === undefined ? '' : query.keyword
  if (typeof keyword !== 'string') throw createError('VALIDATION_ERROR')
  const normalizedKeyword = keyword.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const words = normalizedKeyword === '' ? [] : normalizedKeyword.split(' ')
  const length = words.reduce((total, word) => total + Array.from(word).length, 0)
  if (words.length > 5 || length > 100) throw createError('VALIDATION_ERROR')
  const startDate = normalizeDate(query.startDate)
  const endDate = normalizeDate(query.endDate)
  if (startDate && endDate && startDate > endDate) throw createError('VALIDATION_ERROR')
  const page = query.page === undefined ? 1 : query.page
  if (!Number.isSafeInteger(page) || page < 1) throw createError('VALIDATION_ERROR')
  const maximum = normalizedKeyword ? 20 : 50
  const minimum = normalizedKeyword ? 1 : 5
  const defaultPageSize = 20
  const pageSize = query.pageSize === undefined ? defaultPageSize : query.pageSize
  if (!Number.isSafeInteger(pageSize) || pageSize < minimum || pageSize > maximum) {
    throw createError('VALIDATION_ERROR')
  }
  const cursor = query.cursor === undefined ? '' : query.cursor
  if (typeof cursor !== 'string' || cursor.length > 2048) throw createError('VALIDATION_ERROR')
  return {
    keyword: normalizedKeyword,
    startDate,
    endDate,
    page,
    pageSize,
    cursor
  }
}

function safeSearchResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.items)) {
    throw createError('BUSINESS_SEARCH_PENDING')
  }
  const items = result.items.map(item => ({
    _id: typeof item._id === 'string' ? item._id : '',
    code: typeof item.code === 'string' ? item.code : '',
    name: typeof item.name === 'string' ? item.name : '',
    status: typeof item.status === 'string' ? item.status : '',
    currentNodeName: typeof item.currentNodeName === 'string' ? item.currentNodeName : '',
    matches: Array.isArray(item.matches) ? item.matches.slice(0, 3).map(match => ({
      nodeName: typeof match.nodeName === 'string' ? match.nodeName : '',
      label: typeof match.label === 'string' ? match.label : '',
      excerpt: typeof match.excerpt === 'string' ? match.excerpt : ''
    })) : []
  }))
  if (items.some(item => !item._id)) throw createError('BUSINESS_SEARCH_PENDING')
  return {
    items,
    cursor: typeof result.cursor === 'string' ? result.cursor : '',
    hasMore: result.hasMore === true,
    total: null
  }
}

function createBusinessService({ repository, workTimeService, businessSearchClient = null, clock = () => new Date() }) {
  if (!repository) throw new TypeError('repository is required')
  if (!workTimeService || typeof workTimeService.tryAddWorkMinutes !== 'function') {
    throw new TypeError('workTimeService.tryAddWorkMinutes is required')
  }
  if (typeof clock !== 'function') throw new TypeError('clock is required')

  async function createFromTemplate({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeInput(input)
    const existing = await repository.findCreationResult({ actorId: actor._id, input: normalized })
    if (existing) return synchronizeSearchResult(existing, businessSearchClient)
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
    return synchronizeSearchResult(await repository.createBusinessSnapshot(snapshotInput), businessSearchClient)
  }

  async function listBusinessLines({ actor, query = {} }) {
    requireActiveActor(actor)
    const normalized = normalizeListQuery(query)
    if (normalized.keyword) {
      if (!businessSearchClient || typeof businessSearchClient.query !== 'function') {
        throw createError('BUSINESS_SEARCH_PENDING')
      }
      try {
        return safeSearchResult(await businessSearchClient.query({
          actorId: actor._id,
          query: {
            keyword: normalized.keyword,
            pageSize: normalized.pageSize,
            cursor: normalized.cursor,
            ...(normalized.startDate ? { startDate: normalized.startDate } : {}),
            ...(normalized.endDate ? { endDate: normalized.endDate } : {})
          }
        }))
      } catch (error) {
        if (error && error.code === 'VALIDATION_ERROR') throw error
        throw createError('BUSINESS_SEARCH_PENDING')
      }
    }
    return repository.listBusinessLines({
      actor,
      query: {
        ...(normalized.startDate ? { startDate: normalized.startDate } : {}),
        ...(normalized.endDate ? { endDate: normalized.endDate } : {}),
        page: normalized.page,
        pageSize: normalized.pageSize
      }
    })
  }

  async function getBusinessLine({ actor, lineId }) {
    requireActiveActor(actor)
    return repository.getBusinessLine({ actor, lineId: requireText(lineId) })
  }

  async function listMyPendingProcessing({ actor, query = {} }) {
    requireActiveActor(actor)
    return repository.listMyPendingProcessing({ actor, query: normalizePendingQuery(query) })
  }

  async function getMyDashboardSummary({ actor }) {
    requireActiveActor(actor)
    return repository.getMyBusinessSummary({ actor })
  }

  async function updateMetadata({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeMetadataInput(input)
    return synchronizeSearchResult(
      await repository.updateBusinessMetadata({ actor, ...normalized }),
      businessSearchClient
    )
  }

  return {
    createFromTemplate,
    listBusinessLines,
    listMyPendingProcessing,
    getMyDashboardSummary,
    getBusinessLine,
    updateMetadata
  }
}

module.exports = { createBusinessService }
