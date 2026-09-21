const { isDeepStrictEqual } = require('node:util')
const { readCardDisplay } = require('./business-card-display')
const { summarizeNodeFields, copyOwnData, isStableId, invalidSummary } = require('./business-card-summary')
const { ownDataValue } = require('./account-relationship-schema')
const { boundedMap } = require('./bounded-map')

const MAX_NODES = 48
const NODE_KEYS = [
  '_id', 'businessLineId', 'sourceTemplateNodeKey', 'version', 'status', 'sequence', 'fieldDefinitions',
  'workflowMode', 'flowSchemaVersion', 'processingRoundNumber', 'reviewRoundNumber', 'assigneeUserIds',
  'processorUserIds', 'reviewerUserIds', 'processorAssignmentMode', 'reviewerAssignmentMode',
  'processorDisplayNames', 'reviewerDisplayNames', 'reviewMode', 'processingSlaWorkHours',
  'reviewSlaWorkHours', 'processingStartedAt', 'reviewStartedAt', 'processingElapsedWorkMinutes',
  'processingOverdueWorkMinutes', 'processingDueStatus', 'processingDueAt', 'reviewDueStatus', 'reviewDueAt',
  'activeReviewRoundId', 'lastReviewRoundId', 'routeState', 'nodeKey', 'next', 'manualDecisionProcessorUserIds',
  'latestEvidenceIds', 'feedbackClaimId', 'feedbackClaimHash', 'feedbackClaimExpiresAt',
  'latestFeedbackId', 'latestFeedbackRevision', 'activationMode'
]
const MODERN_KEYS = NODE_KEYS.slice(NODE_KEYS.indexOf('workflowMode'), NODE_KEYS.indexOf('latestFeedbackId'))
  .filter(key => key !== 'assigneeUserIds')
const FEEDBACK_KEYS = ['_id', 'businessLineId', 'nodeId', 'revision', 'publishState', 'action',
  'processingRoundNumber', 'status', 'fieldValues', 'workflowMode', 'reviewRoundNumber', 'reviewRoundId',
  'processorUserIds', 'reviewerUserIds', 'routeState', 'routeTransition', 'activeReviewRoundId', 'lastReviewRoundId']
const ROUND_KEYS = ['_id', 'businessLineId', 'nodeId', 'version', 'processingRoundNumber', 'reviewRoundNumber',
  'status', 'finalDecision', 'feedbackId', 'feedbackRevision', 'fieldValues']
const TEMPLATE_KEYS = ['_id', 'version', 'definitionDigest', 'definitionNodeIds']
const LINE_KEYS = ['_id', 'sourceTemplateId', 'version', 'status', 'nodeCount', 'flowSchemaVersion',
  'currentNodeId', 'entryNodeId', 'traversedNodeIds', 'routeDecisionVersion', 'awaitingManualDecision']

function integer(value, minimum = 1) { return Number.isSafeInteger(value) && value >= minimum }
function conflict() { const error = new Error('CARD_SUMMARY_CONFLICT'); error.code = 'CARD_SUMMARY_CONFLICT'; return error }
function isConflict(error) { return ['CARD_SUMMARY_CONFLICT', 'TRANSACTION_CONFLICT'].includes(error && error.code) }
function isAuthorizationError(error) {
  return Boolean(error && error[require('./cloud-template-repository').APPLICATION_ERROR_MARKER] &&
    ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'].includes(error.code))
}
function unavailable(configRevision = 0) { return { state: 'unavailable', fields: [], configRevision } }
function ready(fields, configRevision) { return { state: 'ready', fields: copyOwnData(fields), configRevision } }

function pick(document, keys) {
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(document))) throw invalidSummary()
  const result = {}
  for (const key of keys) {
    const property = ownDataValue(document, key)
    if (!property.present && !(key in document)) continue
    if (!property.valid) throw invalidSummary()
    // Timing metadata is not card content. Retain presence for the strict
    // legacy discriminator, without copying dates or server-date sentinels.
    if (['processingStartedAt', 'reviewStartedAt', 'processingDueAt', 'reviewDueAt',
      'feedbackClaimExpiresAt'].includes(key)) result[key] = true
    // Match the summarizer's bounded definition budget for strict product
    // linkage tables. Keep unrelated arrays and feedback values on the
    // smaller default budget, including during transaction revalidation.
    else if (key === 'fieldDefinitions' || key === 'fields') {
      result[key] = copyOwnData(property.value, 0, { remaining: 100000, arrayLimit: 5000 })
    }
    else result[key] = copyOwnData(property.value)
  }
  return result
}
function same(left, right) { return isDeepStrictEqual(left, right) }
function stringIds(value, nonempty = false) {
  return Array.isArray(value) && (!nonempty || value.length > 0) &&
    value.every(isStableId) && new Set(value).size === value.length
}
async function readDocument(database, collection, id) {
  if (!isStableId(id)) throw invalidSummary()
  try {
    const response = await database.collection(collection).doc(id).get()
    return response && response.data || null
  } catch (error) {
    const code = String(error && (error.code || error.errCode) || '').toUpperCase()
    const message = String(error && (error.message || error.errMsg) || '').toLowerCase()
    if (code === 'DOCUMENT_NOT_FOUND' || message.includes('document.get:fail') &&
        message.includes('document with _id') && message.includes('does not exist')) return null
    throw error
  }
}

function cacheFields(line, display) {
  try {
    const cache = copyOwnData(ownDataValue(line, 'cardSummary').value)
    if (!cache || Object.keys(cache).sort().join(',') !==
        'configRevision,fields,lineVersion,schemaVersion,templateId' || cache.schemaVersion !== 1 ||
        cache.templateId !== line.sourceTemplateId || cache.configRevision !== display.revision ||
        cache.lineVersion !== line.version || !Array.isArray(cache.fields) || cache.fields.length > display.fields.length) return null
    let previous = 0
    for (const field of cache.fields) {
      if (!field || Object.keys(field).sort().join(',') !== 'id,label,value') return null
      const match = /^field-([1-4])$/.exec(field.id)
      const index = match && Number(match[1])
      if (!index || index <= previous || index > display.fields.length ||
          typeof field.label !== 'string' || !field.label.trim() || Array.from(field.label).length > 80 ||
          typeof field.value !== 'string' || !field.value.trim() || Array.from(field.value).length > 80 ||
          /[\u0000-\u001f\u007f]/.test(field.label + field.value)) return null
      previous = index
    }
    return cache.fields
  } catch (_) { return null }
}

// One pool per request, not one pool per card. Transactions occupy one slot
// and use serial fixed-document reads; nested loaders never acquire this pool.
function createPool() {
  let active = 0
  const queue = []
  function drain() {
    while (active < 4 && queue.length) {
      const { task, resolve, reject } = queue.shift()
      active++
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; drain() })
    }
  }
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); drain() })
}

function excludedNode(line, node) {
  if (Object.hasOwn(line, 'flowSchemaVersion')) {
    if (line.flowSchemaVersion !== 2 || !['dormant', 'active', 'awaiting_manual_decision', 'completed', 'skipped'].includes(node.routeState)) {
      throw invalidSummary()
    }
    if (['dormant', 'skipped'].includes(node.routeState)) return true
  } else if (Object.hasOwn(node, 'routeState')) throw invalidSummary()
  return node.activationMode === 'optional_tail' && ['awaiting_decision', 'skipped'].includes(node.status)
}

function isLegacyNode(line, node) {
  return !['flowSchemaVersion', 'entryNodeId', 'traversedNodeIds', 'routeDecisionVersion', 'awaitingManualDecision']
    .some(key => Object.hasOwn(line, key)) && !MODERN_KEYS.some(key => Object.hasOwn(node, key)) &&
    stringIds(node.assigneeUserIds, true) && (!Object.hasOwn(node, 'activationMode') || node.activationMode === 'required')
}

function createCloudBusinessCardRepository({ db, businessRepository }) {
  if (!db || !businessRepository || typeof businessRepository.getAuthorizedCardLine !== 'function') {
    throw new TypeError('db and businessRepository.getAuthorizedCardLine are required')
  }

  function createRequestSession({ actor }) {
    const run = createPool()
    const templates = new Map()
    const definitions = new Map()
    function template(id) {
      if (!templates.has(id)) templates.set(id, run(() => readDocument(db, 'templates', id)))
      return templates.get(id)
    }
    function savedDefinitions(id) {
      if (!definitions.has(id)) definitions.set(id, run(async () => {
        const response = await db.collection('template_nodes').where({ templateId: id }).limit(MAX_NODES).get()
        if (!response || !Array.isArray(response.data)) throw invalidSummary()
        return response.data.map(doc => pick(doc, ['_id', 'templateId', 'nodeKey', 'fields']))
      }))
      return definitions.get(id)
    }
    const authorize = (businessLineId, database = db) =>
      businessRepository.getAuthorizedCardLine({ actor, lineId: businessLineId, database })

    async function validatedUnavailable(businessLineId) {
      return run(() => db.runTransaction(async database => {
        const current = await authorize(businessLineId, database)
        if (!current.canReadFields || !isStableId(current.line.sourceTemplateId)) return unavailable()
        try {
          const head = await readDocument(database, 'templates', current.line.sourceTemplateId)
          return unavailable(head ? readCardDisplay(head).revision : 0)
        } catch (error) {
          if (isAuthorizationError(error)) throw error
          return unavailable()
        }
      }))
    }

    async function build(line, display, head) {
      if (!integer(line.nodeCount) || line.nodeCount > MAX_NODES) throw invalidSummary()
      const response = await run(() => db.collection('business_nodes').where({ businessLineId: line._id })
        .limit(MAX_NODES).get())
      if (!response || !Array.isArray(response.data) || response.data.length !== line.nodeCount) throw invalidSummary()
      const byKey = new Map()
      const ids = new Set()
      for (const raw of response.data) {
        const identity = pick(raw, ['_id', 'businessLineId', 'sourceTemplateNodeKey'])
        if (!isStableId(identity._id) || identity.businessLineId !== line._id ||
            !isStableId(identity.sourceTemplateNodeKey) || ids.has(identity._id) || byKey.has(identity.sourceTemplateNodeKey)) {
          throw invalidSummary()
        }
        byKey.set(identity.sourceTemplateNodeKey, raw); ids.add(identity._id)
      }
      const selected = new Map()
      display.fields.forEach((field, index) => {
        if (!selected.has(field.nodeKey)) selected.set(field.nodeKey, [])
        selected.get(field.nodeKey).push({ fieldKey: field.fieldKey, id: `field-${index + 1}` })
      })
      const checks = new Map()
      function remember(collection, document, keys) {
        const snapshot = pick(document, keys)
        if (!isStableId(snapshot._id)) throw invalidSummary()
        checks.set(`${collection}/${snapshot._id}`, { collection, id: snapshot._id, keys, snapshot })
        return snapshot
      }
      async function source(collection, id, keys) {
        const document = await readDocument(db, collection, id)
        if (!document || document._id !== id) throw invalidSummary()
        return remember(collection, document, keys)
      }
      async function sourceValues(node) {
        const legacy = isLegacyNode(line, node)
        if (!legacy && (node.workflowMode !== 'review' || !integer(node.processingRoundNumber) ||
            !integer(node.reviewRoundNumber, 0) ||
            !stringIds(node.processorUserIds, true) || !stringIds(node.reviewerUserIds))) throw invalidSummary()
        for (const key of ['activeReviewRoundId', 'lastReviewRoundId']) {
          if (Object.hasOwn(node, key) && node[key] !== null && !isStableId(node[key])) throw invalidSummary()
        }
        const hasPointer = Object.hasOwn(node, 'latestFeedbackId') || Object.hasOwn(node, 'latestFeedbackRevision')
        if (['ready', 'waiting'].includes(node.status) || node.status === 'in_progress' && !hasPointer) {
          if (hasPointer || node.activeReviewRoundId || node.lastReviewRoundId ||
              !legacy && node.processingRoundNumber !== 1) throw invalidSummary()
          return []
        }
        const completed = node.status === 'completed' || line.flowSchemaVersion === 2 &&
          node.status === 'awaiting_decision' && node.routeState === 'awaiting_manual_decision'
        if (!legacy && (node.status === 'pending_review' || completed && node.lastReviewRoundId)) {
          const id = completed ? node.lastReviewRoundId : node.activeReviewRoundId
          const round = await source('node_review_rounds', id, ROUND_KEYS)
          if (!integer(round.version) || round.businessLineId !== line._id || round.nodeId !== node._id ||
              round.processingRoundNumber !== node.processingRoundNumber ||
              round.reviewRoundNumber !== node.reviewRoundNumber || !integer(round.reviewRoundNumber) ||
              round.feedbackId !== node.latestFeedbackId || round.feedbackRevision !== node.latestFeedbackRevision ||
              !isStableId(round.feedbackId) || !integer(round.feedbackRevision) ||
              (completed ? round.status !== 'approved' || round.finalDecision !== 'approved' || Boolean(node.activeReviewRoundId)
                : round.status !== 'pending' || round.finalDecision != null)) throw invalidSummary()
          return round.fieldValues
        }
        if (!['in_progress', 'blocked'].includes(node.status) && !completed) throw invalidSummary()
        if (!integer(node.latestFeedbackRevision) || !legacy && node.activeReviewRoundId ||
            completed && !legacy && node.reviewerUserIds.length) throw invalidSummary()
        const feedback = await source('node_feedback', node.latestFeedbackId, FEEDBACK_KEYS)
        if (feedback.businessLineId !== line._id || feedback.nodeId !== node._id ||
            feedback.revision !== node.latestFeedbackRevision || feedback.publishState !== 'published') throw invalidSummary()
        if (legacy) {
          if (['action', 'processingRoundNumber', 'workflowMode', 'reviewRoundNumber', 'reviewRoundId',
            'processorUserIds', 'reviewerUserIds', 'routeState', 'routeTransition', 'activeReviewRoundId', 'lastReviewRoundId']
            .some(key => Object.hasOwn(feedback, key)) || feedback.status !== node.status) throw invalidSummary()
        } else {
          if (completed ? feedback.action !== 'complete_node' : !['save_progress', 'mark_blocked'].includes(feedback.action)) {
            throw invalidSummary()
          }
          if (feedback.processingRoundNumber !== node.processingRoundNumber) {
            if (completed || node.status !== 'in_progress' || !integer(feedback.processingRoundNumber) ||
                feedback.processingRoundNumber + 1 !== node.processingRoundNumber) throw invalidSummary()
            const rejected = await source('node_review_rounds', node.lastReviewRoundId, ROUND_KEYS)
            if (rejected.businessLineId !== line._id || rejected.nodeId !== node._id ||
                rejected.status !== 'rejected' || rejected.finalDecision !== 'rejected' ||
                rejected.processingRoundNumber !== feedback.processingRoundNumber ||
                rejected.reviewRoundNumber !== node.reviewRoundNumber ||
                rejected.feedbackId !== feedback._id || rejected.feedbackRevision !== feedback.revision) throw invalidSummary()
            return []
          }
        }
        return feedback.fieldValues
      }
      // Run selected source chains in the shared pool. Missing labels are loaded
      // outside that chain to avoid nested pool acquisition/deadlock.
      const groups = await boundedMap([...selected], async ([nodeKey, selections]) => {
        const raw = byKey.get(nodeKey)
        const node = raw ? remember('business_nodes', raw, NODE_KEYS) : null
        if (node && (!integer(node.version) || !Array.isArray(node.fieldDefinitions))) throw invalidSummary()
        if (node && excludedNode(line, node)) return { selections, excluded: true }
        const missing = !node || selections.some(selection => !node.fieldDefinitions.some(field => field.fieldKey === selection.fieldKey))
        let fallbackDefinitions = []
        if (missing) {
          const saved = await savedDefinitions(line.sourceTemplateId)
          if (new Set(saved.map(doc => doc.nodeKey)).size !== saved.length || saved.some(doc =>
            doc.templateId !== line.sourceTemplateId || !isStableId(doc._id) || !isStableId(doc.nodeKey))) throw invalidSummary()
          if (Object.hasOwn(head, 'definitionNodeIds') && (!stringIds(head.definitionNodeIds, true) ||
              head.definitionNodeIds.length !== saved.length || saved.some(doc => !head.definitionNodeIds.includes(doc._id)))) throw invalidSummary()
          const matches = saved.filter(doc => doc.nodeKey === nodeKey)
          if (matches.length !== 1) throw invalidSummary()
          fallbackDefinitions = remember('template_nodes', matches[0], ['_id', 'templateId', 'nodeKey', 'fields']).fields
        }
        const values = node ? await run(() => sourceValues(node)) : []
        return { selections, node, values, fallbackDefinitions }
      })
      const rows = groups.flatMap(group => group.excluded ? [] : summarizeNodeFields({
        definitions: group.node ? group.node.fieldDefinitions : [], values: group.values,
        selections: group.selections, fallbackDefinitions: group.fallbackDefinitions
      }))
      rows.sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)))
      return { fields: rows, checks: [...checks.values()] }
    }

    async function finalize({ businessLineId, line, head, display, fields, checks, write }) {
      let callbacks = 0
      return run(() => db.runTransaction(async database => {
        // SDK automatic transaction replay must not multiply rebuild retries.
        if (++callbacks > 1) throw conflict()
        const current = await authorize(businessLineId, database)
        if (!current.canReadFields) return unavailable()
        if (!same(pick(current.line, LINE_KEYS), pick(line, LINE_KEYS))) throw conflict()
        const currentHead = await readDocument(database, 'templates', line.sourceTemplateId)
        if (!currentHead || !same(readCardDisplay(currentHead), display) ||
            !same(pick(currentHead, TEMPLATE_KEYS), pick(head, TEMPLATE_KEYS))) throw conflict()
        for (const check of checks) {
          const document = await readDocument(database, check.collection, check.id)
          if (!document || !same(pick(document, check.keys), check.snapshot)) throw conflict()
        }
        if (write) {
          await database.collection('business_lines').doc(businessLineId).update({ data: { cardSummary: {
            schemaVersion: 1, templateId: line.sourceTemplateId, configRevision: display.revision,
            lineVersion: line.version, fields
          } } })
        }
        return ready(fields, display.revision)
      }))
    }

    async function getSummary({ businessLineId }) {
      let templateId
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const access = await run(() => authorize(businessLineId))
          if (!access.canReadFields) return await validatedUnavailable(businessLineId)
          const line = access.line
          templateId = line.sourceTemplateId
          if (!integer(line.version) || !isStableId(templateId)) throw invalidSummary()
          const head = await template(templateId)
          if (!head || head._id !== templateId) throw invalidSummary()
          const display = readCardDisplay(head)
          const cached = cacheFields(line, display)
          const built = cached !== null ? { fields: cached, checks: [] } : display.fields.length
            ? await build(line, display, head) : { fields: [], checks: [] }
          const input = { businessLineId, line, head, display, ...built }
          try {
            return await finalize({ ...input, write: cached === null })
          } catch (error) {
            if (isAuthorizationError(error) || isConflict(error)) throw error
            // A failed derived write may still return freshly validated content;
            // this second transaction has no writes and repeats ALL guards.
            return await finalize({ ...input, write: false })
          }
        } catch (error) {
          if (isAuthorizationError(error)) throw error
          if (isConflict(error) && attempt === 0) {
            templates.delete(templateId); definitions.delete(templateId)
            continue
          }
          return validatedUnavailable(businessLineId)
        }
      }
      return validatedUnavailable(businessLineId)
    }
    return { getSummary }
  }

  async function resolveMutationLine({ nodeId, reviewRoundId }) {
    if (reviewRoundId !== undefined) {
      const round = await readDocument(db, 'node_review_rounds', reviewRoundId)
      if (!round || round._id !== reviewRoundId || !isStableId(round.businessLineId) || !isStableId(round.nodeId)) throw invalidSummary()
      const node = await readDocument(db, 'business_nodes', round.nodeId)
      if (!node || node._id !== round.nodeId || node.businessLineId !== round.businessLineId) throw invalidSummary()
      return round.businessLineId
    }
    const node = await readDocument(db, 'business_nodes', nodeId)
    if (!node || node._id !== nodeId || !isStableId(node.businessLineId)) throw invalidSummary()
    return node.businessLineId
  }

  return {
    getSummary: ({ actor, businessLineId }) => createRequestSession({ actor }).getSummary({ businessLineId }),
    createRequestSession,
    resolveMutationLine
  }
}

module.exports = { createCloudBusinessCardRepository }
