'use strict'

const crypto = require('node:crypto')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,160}$/
const FACT_TYPES = new Set([
  'business_completed', 'node_completed', 'processor_contribution',
  'review_process', 'reviewer_process_contribution', 'review_response',
  'optional_tail_decision', 'optional_tail_activation',
  'manual_route_decision', 'manual_route_activation'
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

function personFilterToken(role, userId) {
  if (!['processor', 'reviewer'].includes(role)) throw validationError()
  return digest(['operations-filter-v1', role, safeId(userId)])
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
    const processorId = safeId(ownValue(round, 'submittedBy'))
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

function shanghaiDay(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw validationError()
  return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function safeText(value, maximum = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw validationError()
  return value.trim()
}

function factBase({ line, node, sourceType, sourceId, sourceVersion, day }) {
  return {
    sourceType,
    sourceId,
    sourceVersion: safeInteger(sourceVersion),
    businessLineId: safeId(line._id),
    nodeId: node ? safeId(node._id) : '',
    day,
    templateId: safeId(line.sourceTemplateId),
    templateVersion: safeInteger(line.sourceTemplateVersion),
    stableNodeId: node ? safeId(node.sourceTemplateNodeKey) : '',
    nodeName: node ? safeText(node.name, 200) : '',
    nodeSequence: node ? safeInteger(node.sequence) : null
  }
}

function timingFact(base, { factType, metric, dimensionRole = 'global', dimensionUserId = '', dimensionDisplayName = '', timing, identityIds = [] }) {
  if (!TIMING_STATUSES.has(timing.timingStatus) ||
      timing.timingStatus === 'calculated' && !Number.isSafeInteger(timing.workMinutes) ||
      timing.timingStatus !== 'calculated' && timing.workMinutes !== null) throw validationError()
  const ids = [base.sourceId, metric, dimensionRole, dimensionUserId || 'global', ...identityIds]
  return {
    _id: factId(factType, ids),
    ...base,
    factType,
    metric,
    dimensionRole,
    dimensionUserId,
    dimensionFilterToken: dimensionRole === 'global' ? '' : personFilterToken(dimensionRole, dimensionUserId),
    dimensionDisplayName,
    timingStatus: timing.timingStatus,
    workMinutes: timing.workMinutes
  }
}

function eventFact(base, { factType, metric, sampleValue }) {
  if (![0, 1].includes(sampleValue)) throw validationError()
  return {
    _id: factId(factType, [base.sourceId, metric, 'global']),
    ...base,
    factType,
    metric,
    dimensionRole: 'global',
    dimensionUserId: '',
    dimensionFilterToken: '',
    dimensionDisplayName: '',
    sampleValue
  }
}

function ownStringArray(source, key) {
  const value = ownValue(source, key)
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw validationError()
  return value
}

function decisionKind(source) {
  if (ownValue(source.node, 'activationMode') === 'optional_tail') {
    return {
      sourceType: 'optional_tail_decision',
      durationFactType: 'optional_tail_decision', durationMetric: 'optional_tail_decision_duration',
      eventFactType: 'optional_tail_activation', eventMetric: 'optional_tail_activation'
    }
  }
  const traversedNodeIds = ownValue(source.line, 'traversedNodeIds')
  const next = ownValue(source.node, 'next')
  if (ownValue(source.line, 'flowSchemaVersion') === 2 &&
      Array.isArray(traversedNodeIds) && traversedNodeIds.includes(source.node._id) &&
      ownValue(source.node, 'routeState') === 'completed' && next && next.mode === 'manual') {
    return {
      sourceType: 'manual_route_decision',
      durationFactType: 'manual_route_decision', durationMetric: 'manual_route_decision_duration',
      eventFactType: 'manual_route_activation', eventMetric: 'manual_route_activation'
    }
  }
  throw validationError()
}

function materializeDecisionSource(source) {
  if (!source || typeof source !== 'object' || !source.line || !source.node ||
      source.node.businessLineId !== source.line._id ||
      ownValue(source.node, 'decisionAnalyticsSnapshotStatus') !== 'pending' ||
      !Number.isSafeInteger(ownValue(source.node, 'decisionAnalyticsSourceVersion')) ||
      ownValue(source.node, 'decisionAnalyticsSourceVersion') < 1 ||
      !['activate', 'skip'].includes(ownValue(source.node, 'decision')) ||
      !(ownValue(source.node, 'decisionStartedAt') instanceof Date) ||
      Number.isNaN(ownValue(source.node, 'decisionStartedAt').getTime()) ||
      !(ownValue(source.node, 'decisionAt') instanceof Date) ||
      Number.isNaN(ownValue(source.node, 'decisionAt').getTime()) ||
      ownValue(source.node, 'decisionStartedAt').getTime() > ownValue(source.node, 'decisionAt').getTime()) {
    throw validationError()
  }
  const kind = decisionKind(source)
  const base = factBase({
    line: source.line,
    node: source.node,
    sourceType: kind.sourceType,
    sourceId: source.node._id,
    sourceVersion: source.node.decisionAnalyticsSourceVersion,
    day: shanghaiDay(source.node.decisionAt)
  })
  const facts = []
  if (ownValue(source.node, 'decisionTimingStatus') === 'calculated') {
    facts.push(timingFact(base, {
      factType: kind.durationFactType, metric: kind.durationMetric,
      timing: timingValue(source.node, 'decisionTimingStatus', 'decisionWorkMinutes')
    }))
  } else if (ownValue(source.node, 'decisionTimingStatus') !== 'pending_calendar' ||
      ownValue(source.node, 'decisionWorkMinutes') !== null) {
    throw validationError()
  }
  facts.push(eventFact(base, {
    factType: kind.eventFactType, metric: kind.eventMetric,
    sampleValue: source.node.decision === 'activate' ? 1 : 0
  }))
  return facts
}

const materializeOptionalTailDecisionSource = materializeDecisionSource

function materializeNodeSource(source) {
  if (!source || typeof source !== 'object' || !source.line || !source.node ||
      source.node.analyticsSnapshotStatus !== 'pending' ||
      source.node.businessLineId !== source.line._id) throw validationError()
  const day = shanghaiDay(source.node.analyticsCompletedAt)
  const base = factBase({
    line: source.line, node: source.node, sourceType: 'node', sourceId: source.node._id,
    sourceVersion: source.node.analyticsSourceVersion, day
  })
  if (source.node.status === 'skipped') return []
  const reviewMinuteByRoundId = new Map()
  const processorNames = new Map()
  for (const round of source.rounds) {
    reviewMinuteByRoundId.set(round._id, {
      timingStatus: ownValue(round, 'reviewTimingStatus'),
      workMinutes: ownValue(round, 'reviewElapsedWorkMinutes')
    })
    processorNames.set(round.submittedBy, safeText(round.submittedByDisplayName))
  }
  const reviewerNames = new Map()
  for (const vote of source.votes) reviewerNames.set(vote.reviewerUserId, safeText(vote.reviewerDisplayName))
  let summary
  if (source.rounds.length === 0 && source.node.workflowMode === 'review') {
    const reviewers = ownStringArray(source.node, 'reviewerUserIds')
    const processors = ownStringArray(source.node, 'processorUserIds')
    const displays = ownStringArray(source.node, 'processorDisplayNames')
    const feedback = source.feedback
    if (reviewers.length || processors.length !== displays.length || !feedback ||
        feedback._id !== source.node.latestFeedbackId || feedback.revision !== source.node.latestFeedbackRevision ||
        feedback.action !== 'complete_node' || feedback.status !== 'completed' || feedback.publishState !== 'published' ||
        !processors.includes(feedback.submittedBy)) throw validationError()
    const processing = timingValue(source.node, 'processingTimingStatus', 'processingElapsedWorkMinutes')
    summary = {
      processing,
      reviewProcess: { timingStatus: 'calculated', workMinutes: 0 },
      processorContributions: [{ userId: feedback.submittedBy, ...processing }],
      reviewerContributions: [], reviewResponses: []
    }
    processorNames.set(feedback.submittedBy, safeText(displays[processors.indexOf(feedback.submittedBy)]))
  } else {
    summary = summarizeNodeFacts({ rounds: source.rounds, votes: source.votes, reviewMinuteByRoundId })
  }
  const facts = [
    timingFact(base, { factType: 'node_completed', metric: 'node_processing', timing: summary.processing }),
    ...summary.processorContributions.map(item => timingFact(base, {
      factType: 'processor_contribution', metric: 'node_processing', dimensionRole: 'processor',
      dimensionUserId: item.userId, dimensionDisplayName: processorNames.get(item.userId), timing: item
    })),
    timingFact(base, { factType: 'review_process', metric: 'node_review', timing: summary.reviewProcess }),
    ...summary.reviewerContributions.map(item => timingFact(base, {
      factType: 'reviewer_process_contribution', metric: 'node_review', dimensionRole: 'reviewer',
      dimensionUserId: item.userId, dimensionDisplayName: reviewerNames.get(item.userId), timing: item
    })),
    ...summary.reviewResponses.map(item => timingFact(base, {
      factType: 'review_response', metric: 'review_response', dimensionRole: 'reviewer',
      dimensionUserId: item.userId, dimensionDisplayName: reviewerNames.get(item.userId), timing: item,
      identityIds: [item.voteId]
    }))
  ]
  return facts
}

function combineFactMetric(facts, metric) {
  const values = facts.filter(item => item.metric === metric && item.dimensionRole === 'global')
    .map(item => ({ timingStatus: item.timingStatus, workMinutes: item.workMinutes }))
  return combineTimings(values)
}

async function materializeBusinessSource(source, workTimeService) {
  if (!source || typeof source !== 'object' || !source.line || !Array.isArray(source.nodes) ||
      source.nodes.length === 0 || !Array.isArray(source.nodeFacts) ||
      source.line.analyticsSnapshotStatus !== 'pending' || !workTimeService ||
      typeof workTimeService.workingMinutesBetween !== 'function') throw validationError()
  const line = source.line
  let effectiveNodes
  if (ownValue(line, 'flowSchemaVersion') === 2) {
    const traversedNodeIds = ownStringArray(line, 'traversedNodeIds')
    if (!traversedNodeIds.length || new Set(traversedNodeIds).size !== traversedNodeIds.length) throw validationError()
    const traversed = new Set(traversedNodeIds)
    effectiveNodes = source.nodes.filter(node => node && node.routeState === 'completed' && traversed.has(node._id))
    if (effectiveNodes.length !== traversed.size || effectiveNodes.some(node => node.status !== 'completed')) {
      throw validationError()
    }
  } else {
    effectiveNodes = source.nodes.filter(node => node && node.status !== 'skipped')
  }
  if (!effectiveNodes.length) throw validationError()
  for (const node of effectiveNodes) {
    if (!node || node.analyticsSnapshotStatus !== 'generated' ||
        !Number.isSafeInteger(node.analyticsSourceVersion) ||
        node.analyticsGeneratedVersion !== node.analyticsSourceVersion) throw validationError()
  }
  const nodeById = new Map()
  for (const node of effectiveNodes) {
    const nodeId = safeId(node._id)
    if (nodeById.has(nodeId) || node.businessLineId !== line._id) throw validationError()
    nodeById.set(nodeId, node)
  }
  const factKeys = new Set()
  for (const fact of source.nodeFacts) {
    if (!['node_processing', 'node_review'].includes(ownValue(fact, 'metric'))) continue
    const node = nodeById.get(ownValue(fact, 'nodeId'))
    const metric = ownValue(fact, 'metric')
    const key = `${ownValue(fact, 'nodeId')}\0${metric}`
    if (!node || !['node_processing', 'node_review'].includes(metric) || factKeys.has(key) ||
        ownValue(fact, 'sourceType') !== 'node' || ownValue(fact, 'sourceId') !== node._id ||
        ownValue(fact, 'sourceVersion') !== node.analyticsSourceVersion ||
        ownValue(fact, 'businessLineId') !== line._id || ownValue(fact, 'dimensionRole') !== 'global' ||
        ownValue(fact, 'templateId') !== line.sourceTemplateId ||
        ownValue(fact, 'templateVersion') !== line.sourceTemplateVersion ||
        ownValue(fact, 'stableNodeId') !== node.sourceTemplateNodeKey) throw validationError()
    factKeys.add(key)
  }
  if (factKeys.size !== effectiveNodes.length * 2) throw validationError()
  const day = shanghaiDay(line.analyticsCompletedAt)
  const base = factBase({
    line, node: null, sourceType: 'business', sourceId: line._id,
    sourceVersion: line.analyticsSourceVersion, day
  })
  const completion = await workTimeService.workingMinutesBetween(line.createdAt, line.analyticsCompletedAt)
  const completionTiming = completion && completion.status === 'calculated'
    ? { timingStatus: 'calculated', workMinutes: Math.floor(completion.minutes) }
    : { timingStatus: 'pending_calendar', workMinutes: null }
  return [
    timingFact(base, { factType: 'business_completed', metric: 'business_completion', timing: completionTiming }),
    timingFact(base, { factType: 'business_completed', metric: 'business_node_processing_total', timing: combineFactMetric(source.nodeFacts, 'node_processing') }),
    timingFact(base, { factType: 'business_completed', metric: 'business_review_total', timing: combineFactMetric(source.nodeFacts, 'node_review') })
  ]
}

module.exports = {
  factId,
  dailyRollupId,
  summarizeNodeFacts,
  bucketDay,
  aggregateRollups,
  safeAverage,
  personFilterToken,
  materializeNodeSource,
  materializeDecisionSource,
  materializeOptionalTailDecisionSource,
  materializeBusinessSource
}
