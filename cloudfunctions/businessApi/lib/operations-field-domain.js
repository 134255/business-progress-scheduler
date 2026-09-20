'use strict'

const crypto = require('node:crypto')
const { normalizeFieldDefinition, validateFieldValues, FIELD_TYPES } = require('./field-domain')
const { resolveConditionalFields } = require('./conditional-field-domain')
const { buildOptionLinkageContext, optionLinkageSemanticProjection } = require('./option-linkage-domain')

const SELECT_TYPES = new Set(['single_select', 'multi_select'])
const LINE_KEYS = ['_id', 'code', 'name', 'status', 'sourceTemplateId', 'sourceTemplateVersion',
  'sourceTemplateName', 'templateName', 'flowSchemaVersion', 'traversedNodeIds', 'currentNodeId']
const NODE_KEYS = ['_id', 'businessLineId', 'sourceTemplateNodeKey', 'nodeCode', 'name', 'sequence',
  'status', 'completedAt', 'workflowMode', 'flowSchemaVersion', 'routeState', 'activationMode',
  'fieldDefinitions', 'processingRoundNumber', 'reviewRoundNumber', 'latestFeedbackId',
  'latestFeedbackRevision', 'activeReviewRoundId', 'lastReviewRoundId',
  'processorUserIds', 'reviewerUserIds', 'reviewMode']
const RESULT_KEYS = ['schemaVersion', 'businessLineId', 'nodeId', 'templateId', 'templateName',
  'templateVersion', 'stableNodeId', 'nodeName', 'nodeSequence', 'businessCode', 'businessName',
  'businessStatus', 'nodeCode', 'day', 'completedAt', 'sourceDigest', 'sourceHeader',
  'processorToken', 'reviewerTokens', 'fields']

function invalid() { const error = new Error('FIELD_SOURCE_INVALID'); error.code = 'FIELD_SOURCE_INVALID'; return error }
function demand(condition) { if (!condition) throw invalid() }
function id(value) { demand(typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)); return value }
function integer(value, min = 0) { demand(Number.isSafeInteger(value) && value >= min); return value }
function text(value, empty = false) { demand(typeof value === 'string' && (empty || value.trim().length > 0)); return value }
function object(value) {
  demand(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)))
}

// Inspect descriptors before field-domain's property reads/spreads. No getters,
// prototypes, sparse arrays, Date overrides or cycles become executable input.
function copy(value, depth = 0, budget = { left: 30000, arrayLimit: 2000 }, arrayLimit = budget.arrayLimit) {
  demand(depth <= 20 && --budget.left >= 0)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { demand(Number.isFinite(value)); return value }
  if (value instanceof Date) {
    demand(Object.getPrototypeOf(value) === Date.prototype && Reflect.ownKeys(value).length === 0)
    const milliseconds = Date.prototype.getTime.call(value)
    demand(Number.isFinite(milliseconds))
    return new Date(milliseconds).toISOString()
  }
  const array = Array.isArray(value)
  if (array) {
    demand(Object.getPrototypeOf(value) === Array.prototype && value.length <= arrayLimit &&
      Reflect.ownKeys(value).length === value.length + 1)
  } else object(value)
  const output = array ? [] : {}
  const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : Reflect.ownKeys(value)
  for (const key of keys) {
    demand(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key))
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    demand(descriptor && Object.hasOwn(descriptor, 'value'))
    // Only result.fields[index].options gets the larger dictionary allowance;
    // field values and all source/report record arrays keep their existing cap.
    output[key] = copy(descriptor.value, depth + 1, budget,
      budget.fieldOptions && depth === 1 && key === 'options' ? 5000 : budget.arrayLimit)
  }
  return output
}

function own(source, key) {
  object(source)
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  demand(descriptor ? Object.hasOwn(descriptor, 'value') : !(key in source))
  return descriptor ? descriptor.value : undefined
}
function pick(source, keys) {
  const output = {}
  for (const key of keys) {
    const value = own(source, key)
    demand(value !== undefined || !Object.hasOwn(source, key))
    if (value !== undefined) output[key] = key === 'fieldDefinitions'
      ? copy(value, 0, { left:100000, arrayLimit:5000 })
      : key === 'fields' ? copy(value, 0, { left:100000, arrayLimit:2000, fieldOptions:true }) : copy(value)
  }
  return output
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex') }
function token(role, userId) {
  return crypto.createHash('sha256').update(['operations-filter-v1', role, id(userId)].join('\0')).digest('hex')
}
function ids(value, min = 0) {
  demand(Array.isArray(value) && value.length >= min)
  value.forEach(id); demand(new Set(value).size === value.length)
  return value
}
function timestamp(value) {
  demand(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))
  const date = new Date(value)
  demand(Number.isFinite(date.getTime()) && date.toISOString() === value.replace(/(?<=:\d\d)Z$/, '.000Z'))
  return date.toISOString()
}
function dayOf(completedAt) { return new Date(new Date(completedAt).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) }

function sourceHead(source) {
  return { line: pick(own(source, 'line'), LINE_KEYS), node: pick(own(source, 'node'), NODE_KEYS) }
}
function eligible(line, node) {
  id(line._id); id(node._id); demand(node.businessLineId === line._id)
  demand(['creating', 'active', 'completed', 'cancelled', 'closed', 'deleted'].includes(line.status))
  if (['deleted', 'creating'].includes(line.status)) return false
  if (Object.hasOwn(line, 'flowSchemaVersion')) {
    demand(line.flowSchemaVersion === 2 && (!Object.hasOwn(node, 'flowSchemaVersion') || node.flowSchemaVersion === 2))
    demand(['dormant', 'active', 'awaiting_manual_decision', 'completed', 'skipped'].includes(node.routeState))
    ids(line.traversedNodeIds)
    if (['dormant', 'skipped'].includes(node.routeState)) return false
    if (!line.traversedNodeIds.includes(node._id) && line.currentNodeId !== node._id) return false
  } else demand(!Object.hasOwn(node, 'routeState') && !Object.hasOwn(node, 'flowSchemaVersion'))
  if (node.status !== 'completed' && !(line.flowSchemaVersion === 2 &&
      node.status === 'awaiting_decision' && node.routeState === 'awaiting_manual_decision')) return false
  if (line.flowSchemaVersion === 2) demand(['completed', 'awaiting_manual_decision'].includes(node.routeState))
  return true
}
function definitionsFor(node) {
  demand(Array.isArray(node.fieldDefinitions))
  const definitions = node.fieldDefinitions.map(normalizeFieldDefinition)
    .sort((a, b) => a.sequence - b.sequence || compare(a.fieldKey, b.fieldKey))
  demand(new Set(definitions.map(field => field.fieldKey)).size === definitions.length)
  // Resolve an empty optional projection to validate the entire condition graph
  // without pretending we have loaded its final values for the header fast path.
  validateFieldValues(definitions.map(field => ({ ...field, required: false })), [])
  return definitions
}
function headerFor(line, node, isEligible) {
  for (const key of ['activeReviewRoundId', 'lastReviewRoundId']) {
    if (Object.hasOwn(node, key) && node[key] !== null) id(node[key])
  }
  if (isEligible) {
    demand(node.workflowMode === 'review' && !node.activeReviewRoundId)
    integer(node.processingRoundNumber, 1); integer(node.reviewRoundNumber)
    id(node.latestFeedbackId); integer(node.latestFeedbackRevision, 1); timestamp(node.completedAt)
    ids(node.processorUserIds, 1); ids(node.reviewerUserIds)
    demand(!node.processorUserIds.some(userId => node.reviewerUserIds.includes(userId)))
    if (node.reviewerUserIds.length) {
      id(node.lastReviewRoundId); integer(node.reviewRoundNumber, 1)
      demand(['any', 'all'].includes(node.reviewMode))
    } else demand(!node.lastReviewRoundId && node.reviewRoundNumber === 0)
  }
  return digest({ purpose: 'operations-field-header-v1', businessLineId: line._id, nodeId: node._id,
    templateId: id(line.sourceTemplateId), templateVersion: integer(line.sourceTemplateVersion, 1),
    stableNodeId: id(node.sourceTemplateNodeKey), eligible: isEligible,
    workflowMode: node.workflowMode ?? null, flowSchemaVersion: line.flowSchemaVersion ?? null,
    completedAt: node.completedAt ? timestamp(node.completedAt) : null,
    definitions: definitionsFor(node), processingRoundNumber: node.processingRoundNumber ?? null,
    reviewRoundNumber: node.reviewRoundNumber ?? null, latestFeedbackId: node.latestFeedbackId ?? null,
    latestFeedbackRevision: node.latestFeedbackRevision ?? null,
    activeReviewRoundId: node.activeReviewRoundId ?? null, lastReviewRoundId: node.lastReviewRoundId ?? null,
    processorUserIds: ids(node.processorUserIds, 1).slice().sort(),
    reviewerUserIds: ids(node.reviewerUserIds).slice().sort(), reviewMode: node.reviewMode ?? null })
}

// A cheap server-cache invalidation key, NOT proof of immutable contents or an
// authorization capability. Only use with previously verified server snapshots.
function fieldSourceHeader(source) {
  try { const { line, node } = sourceHead(source); return headerFor(line, node, eligible(line, node)) }
  catch (_) { throw invalid() }
}

function finalValues(definitions, stored) {
  demand(Array.isArray(stored))
  const byKey = new Map(definitions.map(field => [field.fieldKey, field]))
  const submitted = []
  const seen = new Set()
  for (const item of stored) {
    object(item)
    demand(Object.keys(item).every(key => ['fieldKey', 'name', 'type', 'value'].includes(key)))
    const definition = byKey.get(item.fieldKey)
    demand(definition && Object.hasOwn(item, 'value') && !seen.has(item.fieldKey))
    seen.add(item.fieldKey)
    if (Object.hasOwn(item, 'name')) demand(item.name === definition.name)
    if (Object.hasOwn(item, 'type')) demand(item.type === definition.type)
    // validateFieldValues writes optional absent select values as null, while
    // its conditional resolver rejects a *submitted* null select. Adapt that
    // stored representation back to absence, without discarding invalid choices.
    if (definition.type === 'single_select' && item.value === null) continue
    submitted.push({ fieldKey: item.fieldKey, value: item.value })
  }
  const values = validateFieldValues(definitions, submitted)
  // Even null values on hidden fields must not silently enter from old branches.
  const visible = new Set(values.map(field => field.fieldKey))
  demand([...seen].every(key => visible.has(key)))
  return values
}

function compatibilityFor(result, definition, linkage) {
  const condition = definition.condition ? {
    parentFieldKey: definition.condition.parentFieldKey,
    visibleWhen: definition.condition.visibleWhen.slice().sort(),
    ...(definition.condition.optionsByParentValue ? { optionsByParentValue: Object.fromEntries(
      Object.entries(definition.condition.optionsByParentValue).map(([key, value]) => [key, value.slice().sort()])) } : {})
  } : null
  return digest({ purpose: 'operations-field-group-v1', templateId: result.templateId,
    stableNodeId: result.stableNodeId, fieldKey: definition.fieldKey, type: definition.type,
    options: (definition.constraints.options || []).slice().sort(), condition,
    ...(linkage ? { optionLinkage:linkage } : {}) })
}

function buildFinalFieldResult(source) {
  try {
    const { line, node } = sourceHead(source)
    if (!eligible(line, node)) return null
    demand(node.workflowMode === 'review') // unprovable legacy records are data gaps
    integer(node.processingRoundNumber, 1); integer(node.reviewRoundNumber)
    ids(node.processorUserIds, 1); ids(node.reviewerUserIds)
    demand(!node.processorUserIds.some(userId => node.reviewerUserIds.includes(userId)))
    demand(!node.activeReviewRoundId)
    const definitions = definitionsFor(node)
    const feedback = pick(own(source, 'feedback'), ['_id', 'businessLineId', 'nodeId', 'revision',
      'publishState', 'action', 'status', 'processingRoundNumber', 'fieldValues', 'submittedBy'])
    demand(feedback._id === id(node.latestFeedbackId) && feedback.businessLineId === line._id &&
      feedback.nodeId === node._id && feedback.revision === integer(node.latestFeedbackRevision, 1) &&
      feedback.publishState === 'published' && feedback.processingRoundNumber === node.processingRoundNumber)
    const feedbackValues = finalValues(definitions, feedback.fieldValues)
    const rawVotes = own(source, 'votes')
    const votes = rawVotes === undefined ? [] : copy(rawVotes)
    demand(Array.isArray(votes))
    let values = feedbackValues
    let processor = feedback.submittedBy
    let roundIdentity = null
    let reviewerTokens = []
    if (node.reviewerUserIds.length) {
      const round = pick(own(source, 'round'), ['_id', 'businessLineId', 'nodeId', 'processingRoundNumber',
        'reviewRoundNumber', 'status', 'finalDecision', 'feedbackId', 'feedbackRevision', 'fieldValues',
        'submittedBy', 'reviewerUserIds', 'reviewMode'])
      demand(round._id === id(node.lastReviewRoundId) && round.businessLineId === line._id &&
        round.nodeId === node._id && round.processingRoundNumber === node.processingRoundNumber &&
        round.reviewRoundNumber === integer(node.reviewRoundNumber, 1) &&
        round.status === 'approved' && round.finalDecision === 'approved' &&
        round.feedbackId === feedback._id && round.feedbackRevision === feedback.revision)
      demand(['save_progress', 'mark_blocked'].includes(feedback.action) &&
        feedback.status === (feedback.action === 'mark_blocked' ? 'blocked' : 'in_progress'))
      demand(['any', 'all'].includes(round.reviewMode) && round.reviewMode === node.reviewMode &&
        canonical(ids(round.reviewerUserIds, 1).slice().sort()) === canonical(node.reviewerUserIds.slice().sort()))
      values = finalValues(definitions, round.fieldValues)
      demand(canonical(values) === canonical(feedbackValues))
      processor = round.submittedBy
      const voters = new Set()
      const voteIds = new Set()
      for (const vote of votes) {
        object(vote); id(vote._id)
        demand(vote.reviewRoundId === round._id && vote.businessLineId === line._id &&
          vote.nodeId === node._id && vote.decision === 'approved' &&
          round.reviewerUserIds.includes(vote.reviewerUserId) &&
          !voters.has(vote.reviewerUserId) && !voteIds.has(vote._id))
        voters.add(vote.reviewerUserId); voteIds.add(vote._id)
      }
      demand(round.reviewMode === 'all' ? voters.size === round.reviewerUserIds.length : voters.size === 1)
      reviewerTokens = [...voters].map(userId => token('reviewer', userId)).sort()
      roundIdentity = { id: round._id, processingRoundNumber: round.processingRoundNumber,
        reviewRoundNumber: round.reviewRoundNumber, status: round.status,
        voteIds: [...voteIds].sort(), submittedBy: processor }
    } else {
      demand(!node.lastReviewRoundId && !own(source, 'round') && votes.length === 0 &&
        node.reviewRoundNumber === 0 && feedback.action === 'complete_node' && feedback.status === 'completed')
    }
    demand(node.processorUserIds.includes(id(processor)) && node.processorUserIds.includes(id(feedback.submittedBy)))
    const completedAt = timestamp(node.completedAt)
    const result = {
      schemaVersion: 1, businessLineId: line._id, nodeId: node._id,
      templateId: id(line.sourceTemplateId), templateName: text(line.sourceTemplateName ?? line.templateName ?? '', true),
      templateVersion: integer(line.sourceTemplateVersion, 1), stableNodeId: id(node.sourceTemplateNodeKey),
      nodeName: text(node.name), nodeSequence: integer(node.sequence), businessCode: text(line.code),
      businessName: text(line.name), businessStatus: line.status, nodeCode: text(node.nodeCode),
      day: dayOf(completedAt), completedAt, sourceHeader: headerFor(line, node, true),
      processorToken: token('processor', processor), reviewerTokens
    }
    const byKey = new Map(definitions.map(field => [field.fieldKey, field]))
    const submitted = values.filter(field => field.value !== null).map(({ fieldKey, value }) => ({ fieldKey, value }))
    const effective = new Map(resolveConditionalFields(definitions, submitted).visibleDefinitions.map(field => [field.fieldKey, field]))
    const linkage = buildOptionLinkageContext(definitions)
    const groupDigests = new Map()
    for (const { group } of linkage.members.values()) if (!groupDigests.has(group)) {
      groupDigests.set(group, digest(optionLinkageSemanticProjection(definitions, group.rule.fieldKeys[0])))
    }
    result.fields = values.map(field => {
      const definition = byKey.get(field.fieldKey)
      const member = linkage.members.get(field.fieldKey)
      const options = effective.get(field.fieldKey).constraints.options || []
      return { ...field, compatibilityKey: compatibilityFor(result, definition,
        member ? groupDigests.get(member.group) : null), options: options.slice().sort() }
    })
    result.sourceDigest = digest({ purpose: 'operations-field-source-v1', header: result.sourceHeader,
      feedbackId: feedback._id, feedbackRevision: feedback.revision, feedbackAction: feedback.action,
      feedbackSubmitter: feedback.submittedBy, round: roundIdentity,
      processorToken: result.processorToken, reviewerTokens, fields: result.fields })
    return result
  } catch (_) { throw invalid() }
}

function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0 }
function empty(value) { return value === null || value === '' || Array.isArray(value) && value.length === 0 }
function validResult(raw) {
  const result = pick(raw, RESULT_KEYS)
  demand(result.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(result.sourceDigest) &&
    /^[a-f0-9]{64}$/.test(result.sourceHeader))
  for (const key of ['businessLineId', 'nodeId', 'templateId', 'stableNodeId']) id(result[key])
  integer(result.templateVersion, 1); integer(result.nodeSequence)
  for (const key of ['templateName', 'nodeName', 'businessCode', 'businessName', 'businessStatus', 'nodeCode']) text(result[key], true)
  demand(result.day === dayOf(timestamp(result.completedAt)))
  demand(/^[a-f0-9]{64}$/.test(result.processorToken) && Array.isArray(result.reviewerTokens) &&
    result.reviewerTokens.every(value => /^[a-f0-9]{64}$/.test(value)) &&
    new Set(result.reviewerTokens).size === result.reviewerTokens.length)
  demand(Array.isArray(result.fields))
  const seen = new Set()
  for (const field of result.fields) {
    object(field); text(field.fieldKey); text(field.name)
    demand(Object.keys(field).every(key => ['fieldKey', 'name', 'type', 'compatibilityKey', 'options', 'value'].includes(key)))
    demand(!seen.has(field.fieldKey) && FIELD_TYPES.includes(field.type) &&
      /^[a-f0-9]{64}$/.test(field.compatibilityKey) && Object.hasOwn(field, 'value') && Array.isArray(field.options))
    seen.add(field.fieldKey)
    const constraints = SELECT_TYPES.has(field.type) ? { options: field.options } : {}
    demand(SELECT_TYPES.has(field.type) || field.options.length === 0)
    validateFieldValues([{ fieldKey: field.fieldKey, name: field.name, type: field.type, constraints }],
      field.value === null ? [] : [{ fieldKey: field.fieldKey, value: field.value }])
  }
  return result
}
function selectionSnapshot(result) {
  try {
    const snapshot = validResult(result)
    snapshot.fields = snapshot.fields.filter(field => SELECT_TYPES.has(field.type))
    return snapshot
  } catch (_) { throw invalid() }
}
function uniqueResults(results) {
  demand(Array.isArray(results) && results.length <= 2000)
  const byNode = new Map()
  // Inspect the outer array as data too, without applying the per-document copy
  // budget to an entire authorized report.
  demand(Object.getPrototypeOf(results) === Array.prototype && Reflect.ownKeys(results).length === results.length + 1)
  for (let index = 0; index < results.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(results, String(index))
    demand(descriptor && Object.hasOwn(descriptor, 'value'))
    const result = validResult(descriptor.value)
    const previous = byNode.get(result.nodeId)
    if (previous) demand(canonical(previous) === canonical(result))
    else byNode.set(result.nodeId, result)
  }
  return [...byNode.values()].sort((a, b) => compare(a.templateId, b.templateId) ||
    a.nodeSequence - b.nodeSequence || compare(a.stableNodeId, b.stableNodeId) ||
    a.templateVersion - b.templateVersion || compare(a.completedAt, b.completedAt) || compare(a.nodeId, b.nodeId))
}
function aggregateUnique(results) {
  const groups = new Map()
  for (const result of results) for (const field of result.fields) {
    if (!SELECT_TYPES.has(field.type)) continue
    let group = groups.get(field.compatibilityKey)
    if (!group) {
      group = { id: field.compatibilityKey, templateId: result.templateId, templateName: result.templateName,
        templateVersions: [], stableNodeId: result.stableNodeId, nodeName: result.nodeName,
        nodeSequence: result.nodeSequence, fieldKey: field.fieldKey, fieldName: field.name,
        fieldType: field.type, filledSampleCount: 0, emptySampleCount: 0, options: [] }
      groups.set(group.id, group)
    }
    demand(group.templateId === result.templateId && group.stableNodeId === result.stableNodeId &&
      group.fieldKey === field.fieldKey && group.fieldType === field.type)
    if (!group.templateVersions.includes(result.templateVersion)) group.templateVersions.push(result.templateVersion)
    const options = new Map(group.options.map(option => [option.label, option]))
    for (const label of field.options) if (!options.has(label)) options.set(label, { label, count: 0 })
    if (empty(field.value)) group.emptySampleCount++
    else {
      group.filledSampleCount++
      for (const label of field.type === 'multi_select' ? field.value : [field.value]) options.get(label).count++
    }
    group.options = [...options.values()].sort((a, b) => compare(a.label, b.label))
  }
  // Map insertion retains the instance definition order of the first stable,
  // deterministic sample; do not sort fields lexically and lose their sequence.
  return [...groups.values()].map(group => ({ ...group, templateVersions: group.templateVersions.sort((a, b) => a - b) }))
}
function aggregateFieldResults(results) {
  try { return aggregateUnique(uniqueResults(results)) } catch (_) { throw invalid() }
}
function exportValue(field) {
  if (empty(field.value)) return field.type === 'multi_select' && Array.isArray(field.value) ? '[]' : ''
  if (field.type === 'boolean') return field.value ? '是' : '否'
  return field.type === 'multi_select' ? JSON.stringify(field.value) : String(field.value)
}
function fieldExportRows(results) {
  try {
    const unique = uniqueResults(results)
    const details = unique.flatMap(result => result.fields.map(field => ({
      recordType: '字段明细', dateBasis: '节点完成日期', templateName: result.templateName,
      templateVersions: String(result.templateVersion), fieldKey: field.fieldKey, fieldName: field.name,
      fieldType: field.type, fieldValue: exportValue(field), dataStatus: empty(field.value) ? '未填写' : '有效',
      fieldGroupId: field.compatibilityKey, businessCode: result.businessCode, businessName: result.businessName,
      businessStatus: result.businessStatus, nodeCode: result.nodeCode, nodeName: result.nodeName,
      nodeCompletedAt: result.completedAt
    })))
    const statistics = aggregateUnique(unique).flatMap(group => group.options.map(option => ({
      recordType: '选项统计', dateBasis: '节点完成日期', templateName: group.templateName,
      templateVersions: group.templateVersions.join(','), nodeName: group.nodeName,
      fieldKey: group.fieldKey, fieldName: group.fieldName, fieldType: group.fieldType,
      optionValue: option.label, occurrenceCount: option.count, filledSampleCount: group.filledSampleCount,
      emptySampleCount: group.emptySampleCount, dataStatus: '有效', fieldGroupId: group.id
    })))
    return [...details, ...statistics]
  } catch (_) { throw invalid() }
}

module.exports = { buildFinalFieldResult, selectionSnapshot, aggregateFieldResults, fieldExportRows, fieldSourceHeader }
