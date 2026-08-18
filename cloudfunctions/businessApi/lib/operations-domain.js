const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const ALLOWED_KEYS = new Set(['startDate', 'endDate', 'status', 'cursor', 'pageSize'])
const ALLOWED_STATUSES = new Set(['', 'active', 'completed', 'cancelled', 'closed', 'deleted'])
const DAY_MS = 24 * 60 * 60 * 1000

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function shanghaiDateText(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

function startOfShanghaiDate(value) {
  if (typeof value !== 'string') throw createError('VALIDATION_ERROR')
  const match = DATE_PATTERN.exec(value)
  if (!match) throw createError('VALIDATION_ERROR')
  const [, year, month, day] = match
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), -8)
  const date = new Date(utc)
  const expected = new Date(utc + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (expected !== value) throw createError('VALIDATION_ERROR')
  return date
}

function normalizeOperationsQuery(query = {}, now = new Date()) {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Reflect.ownKeys(query).some(key => typeof key !== 'string' || !ALLOWED_KEYS.has(key))) {
    throw createError('VALIDATION_ERROR')
  }
  const current = now instanceof Date && !Number.isNaN(now.getTime()) ? now : null
  if (!current) throw new TypeError('clock must return a Date')
  const endDate = query.endDate || shanghaiDateText(current)
  const defaultStart = new Date(startOfShanghaiDate(endDate).getTime() - 29 * DAY_MS)
  const startDate = query.startDate || shanghaiDateText(defaultStart)
  const startAt = startOfShanghaiDate(startDate)
  const endStart = startOfShanghaiDate(endDate)
  if (endStart < startAt || (endStart.getTime() - startAt.getTime()) / DAY_MS + 1 > 366) {
    throw createError('VALIDATION_ERROR')
  }
  const cursor = query.cursor === undefined ? '' : query.cursor
  const pageSize = query.pageSize === undefined ? 50 : query.pageSize
  const status = query.status === undefined ? '' : query.status
  if (typeof cursor !== 'string' || cursor.length > 512 ||
      typeof status !== 'string' || !ALLOWED_STATUSES.has(status) ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw createError('VALIDATION_ERROR')
  }
  return { startDate, endDate, startAt, endAt: new Date(endStart.getTime() + DAY_MS), status, cursor, pageSize }
}

function normalizeTimingDetailsQuery(query = {}, now = new Date()) {
  const source = query && typeof query === 'object' && !Array.isArray(query) ? query : query
  const normalized = normalizeOperationsQuery({
    ...source,
    pageSize: source && source.pageSize === undefined ? 20 : source && source.pageSize
  }, now)
  if (normalized.pageSize > 20) throw createError('VALIDATION_ERROR')
  return normalized
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function safeOperationsRow({ line, node, processorDisplayNames = [], reviewerDisplayNames = [] }) {
  return {
    businessCode: String(line.code || ''),
    businessName: String(line.name || ''),
    businessStatus: String(line.status || ''),
    nodeCode: String(node.nodeCode || ''),
    nodeName: String(node.name || ''),
    nodeStatus: String(node.status || ''),
    workflowMode: String(node.workflowMode || 'legacy'),
    reviewMode: String(node.reviewMode || ''),
    processorDisplayNames: processorDisplayNames.join('、'),
    reviewerDisplayNames: reviewerDisplayNames.join('、'),
    processingRoundNumber: Number(node.processingRoundNumber || 0),
    reviewRoundNumber: Number(node.reviewRoundNumber || 0),
    submittedForReviewAt: iso(node.reviewStartedAt),
    processingDueStatus: String(node.processingDueStatus || ''),
    processingDueAt: iso(node.processingDueAt),
    processingOverdueWorkMinutes: Number(node.processingOverdueWorkMinutes || 0),
    processingElapsedWorkMinutes: Number(node.processingElapsedWorkMinutes || 0),
    reviewDueStatus: String(node.reviewDueStatus || ''),
    reviewDueAt: iso(node.reviewDueAt),
    reviewOverdueWorkMinutes: Number(node.reviewOverdueWorkMinutes || 0),
    reviewElapsedWorkMinutes: Number(node.reviewElapsedWorkMinutes || node.lastReviewElapsedWorkMinutes || 0),
    businessCreatedAt: iso(line.createdAt),
    nodeCompletedAt: iso(node.completedAt)
  }
}

function ownValue(source, key) {
  const descriptor = source && Object.getOwnPropertyDescriptor(source, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function safeText(source, key, { required = true, max = 200 } = {}) {
  const value = ownValue(source, key)
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw createError('VALIDATION_ERROR')
  }
  return value.trim()
}

function safeIntegerValue(source, key, { nullable = false } = {}) {
  const value = ownValue(source, key)
  if (nullable && value === null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw createError('VALIDATION_ERROR')
  return value
}

function safeDateValue(source, key) {
  const value = ownValue(source, key)
  const date = value instanceof Date ? value : new Date(value)
  if (value === undefined || Number.isNaN(date.getTime())) throw createError('VALIDATION_ERROR')
  return date.toISOString()
}

function timingSnapshot(source, prefix) {
  const statusKey = `${prefix}TimingStatus`
  if (ownValue(source, statusKey) === undefined) return { recorded: false }
  const status = ownValue(source, statusKey)
  if (!['calculated', 'pending_calendar'].includes(status)) throw createError('VALIDATION_ERROR')
  const startedAt = safeDateValue(source, `${prefix}StartedAt`)
  const endedAt = safeDateValue(source, `${prefix}EndedAt`)
  if (startedAt > endedAt) throw createError('VALIDATION_ERROR')
  const result = { recorded: true, status, startedAt, endedAt }
  if (status === 'calculated') result.workMinutes = safeIntegerValue(source, `${prefix}WorkMinutes`)
  else {
    if (ownValue(source, `${prefix}WorkMinutes`) !== null) throw createError('VALIDATION_ERROR')
    result.workMinutes = null
  }
  return result
}

function safeVote(vote) {
  const decision = ownValue(vote, 'decision')
  if (!['approved', 'rejected'].includes(decision)) throw createError('VALIDATION_ERROR')
  return {
    reviewerDisplayName: safeText(vote, 'reviewerDisplayName', { max: 100 }),
    decision,
    votedAt: safeDateValue(vote, 'createdAt'),
    responseTiming: timingSnapshot(vote, 'reviewResponse')
  }
}

function safeTimingDetail({ line, node, round, votes = [] }) {
  const assignmentMode = ownValue(round, 'processorAssignmentMode')
  if (assignmentMode !== undefined && !['fixed_accounts', 'business_creator'].includes(assignmentMode)) {
    throw createError('VALIDATION_ERROR')
  }
  const submittedByDisplayName = ownValue(round, 'submittedByDisplayName') === undefined
    ? '历史未记录'
    : safeText(round, 'submittedByDisplayName', { max: 100 })
  const processingTiming = timingSnapshot(round, 'processingRound')
  if (processingTiming.recorded) {
    processingTiming.overdueWorkMinutes = safeIntegerValue(round, 'processingOverdueWorkMinutes')
  }
  return {
    roundId: safeText(round, '_id', { max: 200 }),
    businessCode: safeText(line, 'code', { max: 100 }),
    businessName: safeText(line, 'name', { max: 200 }),
    businessStatus: safeText(line, 'status', { max: 40 }),
    nodeCode: safeText(node, 'nodeCode', { max: 100 }),
    nodeName: safeText(node, 'name', { max: 200 }),
    processingRoundNumber: safeIntegerValue(round, 'processingRoundNumber'),
    reviewRoundNumber: safeIntegerValue(round, 'reviewRoundNumber'),
    reviewStartedAt: safeDateValue(round, 'reviewStartedAt'),
    submittedByDisplayName,
    processorAssignmentMode: assignmentMode || 'historical_unknown',
    processingTiming,
    votes: votes.map(safeVote)
  }
}

module.exports = {
  normalizeOperationsQuery,
  normalizeTimingDetailsQuery,
  safeOperationsRow,
  safeTimingDetail
}
