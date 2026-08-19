'use strict'

const crypto = require('node:crypto')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,160}$/
const FACT_TYPES = new Set([
  'business_completed', 'node_completed', 'processor_contribution',
  'review_process', 'reviewer_process_contribution', 'review_response'
])
const TIMING_STATUSES = new Set(['calculated', 'pending_calendar', 'historical_unrecorded'])
const GRAINS = new Set(['day', 'week', 'month'])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function validationError() {
  const error = new Error('VALIDATION_ERROR')
  error.code = 'VALIDATION_ERROR'
  return error
}

function ownValue(source, key) {
  const descriptor = source && typeof source === 'object' && Object.getOwnPropertyDescriptor(source, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function safeId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw validationError()
  return value
}

function safeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw validationError()
  return value
}

function digest(parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex')
}

function factId(type, sourceIds) {
  if (!FACT_TYPES.has(type) || !Array.isArray(sourceIds) || sourceIds.length === 0) throw validationError()
  return `analytics-fact-${digest([type, ...sourceIds.map(safeId)])}`
}

function normalizeRollupIdentity(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationError()
  const allowed = ['day', 'templateId', 'templateVersion', 'stableNodeId', 'metric', 'dimensionRole', 'dimensionUserId']
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !allowed.includes(key))) throw validationError()
  const day = validateDay(ownValue(input, 'day'))
  const templateId = safeId(ownValue(input, 'templateId'))
  const templateVersion = safeInteger(ownValue(input, 'templateVersion'))
  const stableNodeId = ownValue(input, 'stableNodeId') === '' ? '' : safeId(ownValue(input, 'stableNodeId'))
  const metric = ownValue(input, 'metric')
  const dimensionRole = ownValue(input, 'dimensionRole')
  const dimensionUserId = ownValue(input, 'dimensionUserId')
  if (typeof metric !== 'string' || !metric || metric.length > 80 ||
      !['global', 'processor', 'reviewer'].includes(dimensionRole) ||
      (dimensionUserId !== '' && !DOCUMENT_ID.test(dimensionUserId)) ||
      (dimensionRole === 'global') !== (dimensionUserId === '')) throw validationError()
  return { day, templateId, templateVersion, stableNodeId, metric, dimensionRole, dimensionUserId }
}

function dailyRollupId(input) {
  const value = normalizeRollupIdentity(input)
  return `analytics-daily-${digest(Object.values(value).map(String))}`
}

function safeAverage(totalMinutes, sampleCount) {
  safeInteger(totalMinutes)
  safeInteger(sampleCount)
  return sampleCount === 0 ? null : Math.round(totalMinutes * 10 / sampleCount) / 10
}

function validateDay(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) throw validationError()
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw validationError()
  return value
}

function bucketDay(day, grain) {
  validateDay(day)
  if (!GRAINS.has(grain)) throw validationError()
  if (grain === 'day') return day
  if (grain === 'month') return day.slice(0, 7)
  const date = new Date(`${day}T00:00:00.000Z`)
  const weekday = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1))
  return date.toISOString().slice(0, 10)
}

function timingValue(source, statusKey, minutesKey) {
  const status = ownValue(source, statusKey)
  const minutes = ownValue(source, minutesKey)
  if (status === undefined && minutes === undefined) return { timingStatus: 'historical_unrecorded', workMinutes: null }
  if (!TIMING_STATUSES.has(status)) throw validationError()
  if (status === 'calculated') return { timingStatus: status, workMinutes: safeInteger(minutes) }
  if (minutes !== null) throw validationError()
  return { timingStatus: status, workMinutes: null }
}

function combineTimings(values) {
  if (!Array.isArray(values) || values.length === 0) return { timingStatus: 'historical_unrecorded', workMinutes: null }
  if (values.some(value => value.timingStatus === 'pending_calendar')) {
    return { timingStatus: 'pending_calendar', workMinutes: null }
  }
  if (values.some(value => value.timingStatus === 'historical_unrecorded')) {
    return { timingStatus: 'historical_unrecorded', workMinutes: null }
  }
  return { timingStatus: 'calculated', workMinutes: values.reduce((sum, value) => sum + value.workMinutes, 0) }
}

function groupedContribution(map) {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([userId, values]) => ({ userId, ...combineTimings(values) }))
}

function summarizeNodeFacts({ rounds, votes, reviewMinuteByRoundId }) {
  if (!Array.isArray(rounds) || !Array.isArray(votes) || !(reviewMinuteByRoundId instanceof Map)) throw validationError()
  const roundIds = new Set()
  const processingValues = []
  const processorValues = new Map()
  const reviewValues = []
  const reviewerValues = new Map()
  const responses = []

  for (const round of rounds) {
    const id = safeId(ownValue(round, '_id'))
    if (roundIds.has(id) || !['approved', 'rejected'].includes(ownValue(round, 'status'))) throw validationError()
    roundIds.add(id)
    const processorId = safeId(ownValue(round, 'submittedByUserId'))
    const processing = timingValue(round, 'processingRoundTimingStatus', 'processingRoundWorkMinutes')
    processingValues.push(processing)
    if (!processorValues.has(processorId)) processorValues.set(processorId, [])
    processorValues.get(processorId).push(processing)

    const review = reviewMinuteByRoundId.has(id)
      ? timingValue(reviewMinuteByRoundId.get(id), 'timingStatus', 'workMinutes')
      : { timingStatus: 'historical_unrecorded', workMinutes: null }
    reviewValues.push(review)
  }

  const voteIds = new Set()
  for (const vote of votes) {
    const id = safeId(ownValue(vote, '_id'))
    const roundId = safeId(ownValue(vote, 'reviewRoundId'))
    const userId = safeId(ownValue(vote, 'reviewerUserId'))
    if (voteIds.has(id) || !roundIds.has(roundId) || !['approved', 'rejected'].includes(ownValue(vote, 'decision'))) {
      throw validationError()
    }
    voteIds.add(id)
    const response = timingValue(vote, 'reviewResponseTimingStatus', 'reviewResponseWorkMinutes')
    responses.push({ voteId: id, userId, ...response })
    const roundReview = reviewMinuteByRoundId.has(roundId)
      ? timingValue(reviewMinuteByRoundId.get(roundId), 'timingStatus', 'workMinutes')
      : { timingStatus: 'historical_unrecorded', workMinutes: null }
    if (!reviewerValues.has(userId)) reviewerValues.set(userId, [])
    reviewerValues.get(userId).push(roundReview)
  }

  return {
    processing: combineTimings(processingValues),
    reviewProcess: combineTimings(reviewValues),
    processorContributions: groupedContribution(processorValues),
    reviewerContributions: groupedContribution(reviewerValues),
    reviewResponses: responses.sort((left, right) => left.voteId.localeCompare(right.voteId))
  }
}

function aggregateRollups(rows, grain) {
  if (!Array.isArray(rows) || !GRAINS.has(grain)) throw validationError()
  const buckets = new Map()
  for (const row of rows) {
    const bucket = bucketDay(ownValue(row, 'day'), grain)
    const current = buckets.get(bucket) || { bucket, sampleCount: 0, totalMinutes: 0, pendingCount: 0, unrecordedCount: 0 }
    for (const key of ['sampleCount', 'totalMinutes', 'pendingCount', 'unrecordedCount']) {
      current[key] += safeInteger(ownValue(row, key))
    }
    buckets.set(bucket, current)
  }
  return [...buckets.values()].sort((left, right) => left.bucket.localeCompare(right.bucket)).map(value => ({
    ...value,
    averageMinutes: safeAverage(value.totalMinutes, value.sampleCount)
  }))
}

module.exports = {
  factId,
  dailyRollupId,
  summarizeNodeFacts,
  bucketDay,
  aggregateRollups,
  safeAverage
}
