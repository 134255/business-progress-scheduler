const crypto = require('node:crypto')
const { mapBounded } = require('./bounded-map')

const {
  safeSearchExcerpt
} = require('./search-domain')

const COLLECTIONS = Object.freeze({
  users: 'users',
  lines: 'business_lines',
  nodes: 'business_nodes',
  feedback: 'node_feedback',
  rounds: 'node_review_rounds',
  votes: 'node_review_votes',
  evidences: 'evidences',
  settings: 'system_settings',
  requests: 'business_search_requests',
  documents: 'business_search_documents'
})
const MAX_NODES = 48
const ROUTE_STATES = new Set(['active', 'completed', 'awaiting_manual_decision', 'skipped', 'dormant'])
const ACTUAL_ROUTE_STATES = new Set(['active', 'completed', 'awaiting_manual_decision'])
const FEEDBACK_RELATION_PAGE_SIZE = 100
const MAX_QUERY_CANDIDATES = 100
const MAX_GENERATION_ENTRIES = 5000
const MAX_CYCLE_BATCH = 40
const SEARCH_SCHEMA_VERSION = 2
const MAX_QUERY_RECOVERY_BUILDS = 2
const QUERY_CURSOR_TTL_MS = 5 * 60 * 1000
const CURSOR_SCHEMA_VERSION = 1
const CURSORS = Object.freeze({
  backfill: Object.freeze({ id: 'business-search-backfill-cursor', kind: 'business_search_backfill' }),
  recovery: Object.freeze({ id: 'business-search-recovery-cursor', kind: 'business_search_recovery' }),
  cleanup: Object.freeze({ id: 'business-search-cleanup-cursor', kind: 'business_search_cleanup' })
})

function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownDataValue(value, key) {
  if (!isPlainObject(value)) return { valid: false }
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { valid: true, value: descriptor.value }
    : { valid: false }
}

function queryFilters(input, errorCode) {
  if (!isPlainObject(input)) throw createError(errorCode)
  const filters = {}
  for (const [key, allowed] of [['businessStatus', ['active', 'completed']], ['scope', ['mine']]]) {
    if (!(key in input)) continue
    const field = ownDataValue(input, key)
    if (!field.valid || !allowed.includes(field.value)) throw createError(errorCode)
    filters[key] = field.value
  }
  return filters
}

function exactString(value, { allowEmpty = false, maximum = 4096 } = {}) {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
}

function exactSafeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function exactDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function shanghaiDateKey(value) {
  if (!exactDate(value)) return ''
  return new Date(value.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function exactStringArray(value, { nonEmpty = false, maximum = 100 } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (nonEmpty && value.length === 0)) return null
  const result = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        !exactString(descriptor.value, { maximum: 128 }) || seen.has(descriptor.value)) return null
    seen.add(descriptor.value)
    result.push(descriptor.value)
  }
  return result
}

// Keywords use the domain's Unicode code-point budget, not document-ID limits.
function exactKeywords(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null
  const result = []
  let total = 0
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'string' || !descriptor.value.length) return null
    total += Array.from(descriptor.value).length
    if (total > 100) return null
    result.push(descriptor.value)
  }
  return result
}

function hashHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('hex')
}

function hashToken(secret, value) {
  return crypto.createHmac('sha256', secret).update(value, 'utf8').digest('base64url').slice(0, 22)
}

function documentId(parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')
}

async function readDocument(store, collection, id) {
  try {
    return (await store.collection(collection).doc(id).get()).data || null
  } catch (_) {
    return null
  }
}

// Recovery must distinguish an explicit absent document from an unsuccessful
// read. The historical reader above intentionally keeps its existing behavior.
async function readRecoveryDocument(store, collection, id) {
  return (await store.collection(collection).doc(id).get()).data || null
}

function sourceError() {
  return createError('SEARCH_SOURCE_INVALID')
}

function includeRouteNode(line, node) {
  if (!Object.prototype.hasOwnProperty.call(line, 'flowSchemaVersion')) return true
  const version = ownDataValue(line, 'flowSchemaVersion')
  const routeState = ownDataValue(node, 'routeState')
  if (!version.valid || version.value !== 2 || !routeState.valid ||
      !ROUTE_STATES.has(routeState.value)) throw sourceError()
  return ACTUAL_ROUTE_STATES.has(routeState.value)
}

function isLegacyNodeWithoutRound(line, node) {
  if (!isPlainObject(line) || !isPlainObject(node) ||
      ['flowSchemaVersion', 'entryNodeId', 'traversedNodeIds', 'routeDecisionVersion',
        'awaitingManualDecision'].some(key => key in line)) return false
  // The API's pre-review template snapshot uses assigneeUserIds, not processor /
  // reviewer roles, and never creates a processing round in its submit protocol.
  // Present (even null/undefined), inherited or accessor markers are not absence.
  const modernOrFeedbackMarkers = [
    'workflowMode', 'flowSchemaVersion', 'processingRoundNumber', 'reviewRoundNumber',
    'processorUserIds', 'reviewerUserIds', 'processorAssignmentMode', 'reviewerAssignmentMode',
    'processorDisplayNames', 'reviewerDisplayNames', 'reviewMode',
    'processingSlaWorkHours', 'reviewSlaWorkHours', 'processingStartedAt', 'reviewStartedAt',
    'processingElapsedWorkMinutes', 'processingOverdueWorkMinutes', 'processingDueStatus', 'processingDueAt',
    'reviewDueStatus', 'reviewDueAt', 'activeReviewRoundId', 'lastReviewRoundId',
    'routeState', 'nodeKey', 'next', 'manualDecisionProcessorUserIds',
    'latestEvidenceIds',
    'feedbackClaimId', 'feedbackClaimHash', 'feedbackClaimExpiresAt'
  ]
  if (modernOrFeedbackMarkers.some(key => key in node)) return false
  const assignees = ownDataValue(node, 'assigneeUserIds')
  const ids = assignees.valid && exactStringArray(assignees.value, { nonEmpty: true })
  const fields = ownDataValue(node, 'fieldDefinitions')
  const sourceKey = ownDataValue(node, 'sourceTemplateNodeKey')
  const activation = ownDataValue(node, 'activationMode')
  return Boolean(ids && ids.every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)) &&
    fields.valid && Array.isArray(fields.value) && sourceKey.valid &&
    exactString(sourceKey.value, { maximum: 128 }) &&
    (!('activationMode' in node) || activation.valid && activation.value === 'required'))
}

function isLegacyMetadataWithoutRound(line, node) {
  return isLegacyNodeWithoutRound(line, node) && ['ready', 'waiting'].includes(node.status) &&
    !['latestFeedbackId', 'latestFeedbackRevision', 'latestComment'].some(key => key in node)
}

function isLegacyFeedbackWithoutRound(line, node) {
  if (!isLegacyNodeWithoutRound(line, node) || !['in_progress', 'blocked', 'completed'].includes(node.status)) return false
  const pointer = ownDataValue(node, 'latestFeedbackId')
  const revision = ownDataValue(node, 'latestFeedbackRevision')
  return pointer.valid && exactString(pointer.value, { maximum: 128 }) &&
    revision.valid && exactSafeInteger(revision.value, 1)
}

function cursorError() {
  return createError('SEARCH_CURSOR_INVALID')
}

function safeFieldValues(value) {
  if (!Array.isArray(value) || value.length > 100) throw sourceError()
  const result = []
  const keys = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const field = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : null
    if (!isPlainObject(field)) throw sourceError()
    const fieldKey = ownDataValue(field, 'fieldKey')
    const name = ownDataValue(field, 'name')
    const type = ownDataValue(field, 'type')
    const fieldValue = ownDataValue(field, 'value')
    if (!fieldKey.valid || !exactString(fieldKey.value, { maximum: 128 }) || keys.has(fieldKey.value) ||
        !name.valid || !exactString(name.value, { maximum: 200 }) ||
        !type.valid || !exactString(type.value, { maximum: 50 }) || !fieldValue.valid) throw sourceError()
    keys.add(fieldKey.value)
    result.push({ fieldKey: fieldKey.value, name: name.value, type: type.value, value: fieldValue.value })
  }
  return result
}

function safeText(value, maximum = 10000) {
  if (!exactString(value, { allowEmpty: true, maximum })) throw sourceError()
  return value
}

function safeSourceVersion(document, expected, { allowLagging = false } = {}) {
  if (!document || !exactSafeInteger(document.searchSourceVersion) ||
      !exactSafeInteger(document.searchGeneratedVersion) ||
      document.searchGeneratedVersion > document.searchSourceVersion ||
      !['pending', 'generated'].includes(document.searchIndexStatus) ||
      document.searchIndexStatus === 'generated' &&
        document.searchGeneratedVersion !== document.searchSourceVersion) return false
  return allowLagging
    ? document.searchSourceVersion <= expected
    : document.searchSourceVersion === expected
}

function compareNodes(left, right) {
  return Number(left.sequence) - Number(right.sequence) || String(left._id).localeCompare(String(right._id))
}

function createCloudSearchRepository({ db, clock = () => new Date(), secret }) {
  if (!db || typeof db.runTransaction !== 'function' || !exactString(secret) || Array.from(secret).length < 32) {
    throw createError('SEARCH_CONFIGURATION_INVALID')
  }

  async function consumeRequest({ token, operation }) {
    if (!exactString(token, { maximum: 512 }) || !['index', 'query'].includes(operation)) {
      throw createError('FORBIDDEN')
    }
    const now = clock()
    const id = hashHex(secret, token)
    return db.runTransaction(async transaction => {
      const ticket = await readDocument(transaction, COLLECTIONS.requests, id)
      const ticketOperation = ownDataValue(ticket, 'operation')
      const actorId = ownDataValue(ticket, 'actorId')
      const businessLineId = ownDataValue(ticket, 'businessLineId')
      const sourceVersion = ownDataValue(ticket, 'sourceVersion')
      const status = ownDataValue(ticket, 'status')
      const createdAt = ownDataValue(ticket, 'createdAt')
      const expiresAt = ownDataValue(ticket, 'expiresAt')
      if (!ticketOperation.valid || ticketOperation.value !== operation ||
          !actorId.valid || !exactString(actorId.value, { maximum: 128 }) ||
          !status.valid || status.value !== 'pending' ||
          !createdAt.valid || !exactDate(createdAt.value) ||
          !expiresAt.valid || !exactDate(expiresAt.value) || expiresAt.value.getTime() <= now.getTime()) {
        throw createError('FORBIDDEN')
      }
      if (operation === 'index' && (!businessLineId.valid ||
          !exactString(businessLineId.value, { maximum: 128 }) ||
          !sourceVersion.valid || !exactSafeInteger(sourceVersion.value))) throw createError('FORBIDDEN')
      const normalizedKeywords = ownDataValue(ticket, 'normalizedKeywords')
      const digestInput = ownDataValue(ticket, 'digestInput')
      const pageSize = ownDataValue(ticket, 'pageSize')
      const cursor = ownDataValue(ticket, 'cursor')
      const startDate = ownDataValue(ticket, 'startDate')
      const endDate = ownDataValue(ticket, 'endDate')
      const safeStartDate = startDate.valid ? startDate.value : ''
      const safeEndDate = endDate.valid ? endDate.value : ''
      const safeKeywords = operation === 'query'
        ? exactKeywords(normalizedKeywords.value)
        : null
      const filters = operation === 'query' ? queryFilters(ticket, 'FORBIDDEN') : {}
      if (operation === 'query' && (!normalizedKeywords.valid || !safeKeywords ||
          !digestInput.valid || !exactString(digestInput.value, { maximum: 512 }) ||
          !pageSize.valid || !exactSafeInteger(pageSize.value, 1) || pageSize.value > 20 ||
          !cursor.valid || !exactString(cursor.value, { allowEmpty: true, maximum: 2048 }) ||
          !/^$|^\d{4}-\d{2}-\d{2}$/.test(safeStartDate) ||
          !/^$|^\d{4}-\d{2}-\d{2}$/.test(safeEndDate) ||
          (safeStartDate && safeEndDate && safeStartDate > safeEndDate))) {
        throw createError('FORBIDDEN')
      }
      await transaction.collection(COLLECTIONS.requests).doc(id).update({
        data: { status: 'consumed', consumedAt: now }
      })
      const common = {
        actorId: actorId.value,
        operation: ticketOperation.value
      }
      return operation === 'index'
        ? { ...common, businessLineId: businessLineId.value, sourceVersion: sourceVersion.value }
        : {
            ...common,
            ...filters,
            normalizedKeywords: safeKeywords,
            digestInput: digestInput.value,
            pageSize: pageSize.value,
            cursor: cursor.value,
            startDate: safeStartDate,
            endDate: safeEndDate
          }
    })
  }

  function readCursor(document, definition) {
    if (!document) return { exists: false, revision: 0, cursorUpdatedAt: null, cursorId: null }
    const kind = ownDataValue(document, 'kind')
    const schemaVersion = ownDataValue(document, 'schemaVersion')
    const revision = ownDataValue(document, 'revision')
    const cursorUpdatedAt = ownDataValue(document, 'cursorUpdatedAt')
    const cursorId = ownDataValue(document, 'cursorId')
    if (!kind.valid || kind.value !== definition.kind ||
        !schemaVersion.valid || schemaVersion.value !== CURSOR_SCHEMA_VERSION ||
        !revision.valid || !exactSafeInteger(revision.value) || revision.value >= Number.MAX_SAFE_INTEGER ||
        !cursorUpdatedAt.valid || !cursorId.valid ||
        !((cursorUpdatedAt.value === null && cursorId.value === null) ||
          (exactDate(cursorUpdatedAt.value) && exactString(cursorId.value, { maximum: 128 })))) {
      throw cursorError()
    }
    return { exists: true, revision: revision.value,
      cursorUpdatedAt: cursorUpdatedAt.value, cursorId: cursorId.value }
  }

  function sameCursor(left, right) {
    return left.exists === right.exists && left.revision === right.revision && left.cursorId === right.cursorId &&
      (left.cursorUpdatedAt === null && right.cursorUpdatedAt === null ||
        exactDate(left.cursorUpdatedAt) && exactDate(right.cursorUpdatedAt) &&
          left.cursorUpdatedAt.getTime() === right.cursorUpdatedAt.getTime())
  }

  function validateRawPage(rows, sortField) {
    let previous = null
    for (const row of rows) {
      if (!isPlainObject(row) || !exactString(row._id, { maximum: 128 }) || !exactDate(row[sortField])) {
        throw cursorError()
      }
      if (previous && (row[sortField].getTime() < previous[sortField].getTime() ||
          row[sortField].getTime() === previous[sortField].getTime() && row._id <= previous._id)) {
        throw cursorError()
      }
      previous = row
    }
  }

  async function queryCursorPage({ collection, criteria, cursor, sortField, batchSize }) {
    const order = query => query.orderBy(sortField, 'asc').orderBy('_id', 'asc')
    const base = () => Object.keys(criteria).length > 0
      ? db.collection(collection).where(criteria)
      : db.collection(collection)
    if (!cursor.cursorUpdatedAt) {
      const result = await order(base()).limit(batchSize).get()
      const rows = result.data || []
      validateRawPage(rows, sortField)
      return rows
    }
    const sameTime = await order(db.collection(collection).where({
      ...criteria,
      [sortField]: db.command.eq(cursor.cursorUpdatedAt),
      _id: db.command.gt(cursor.cursorId)
    })).limit(batchSize).get()
    const rows = sameTime.data || []
    if (rows.length < batchSize) {
      const later = await order(db.collection(collection).where({
        ...criteria,
        [sortField]: db.command.gt(cursor.cursorUpdatedAt)
      })).limit(batchSize - rows.length).get()
      rows.push(...(later.data || []))
    }
    if (rows.length === 0) {
      const wrapped = await order(base()).limit(batchSize).get()
      rows.push(...(wrapped.data || []))
    }
    validateRawPage(rows, sortField)
    return rows
  }

  async function claimRawPage({ definition, collection, criteria = {}, sortField, batchSize, now }) {
    if (!exactDate(now) || !exactSafeInteger(batchSize, 1) || batchSize > MAX_CYCLE_BATCH) throw cursorError()
    const observed = readCursor(await readDocument(db, COLLECTIONS.settings, definition.id), definition)
    const rows = await queryCursorPage({ collection, criteria, cursor: observed, sortField, batchSize })
    if (rows.length === 0 && !observed.cursorUpdatedAt) return []
    const next = rows.length > 0
      ? { cursorUpdatedAt: rows.at(-1)[sortField], cursorId: rows.at(-1)._id }
      : { cursorUpdatedAt: null, cursorId: null }
    const claimed = await db.runTransaction(async transaction => {
      const current = readCursor(await readDocument(transaction, COLLECTIONS.settings, definition.id), definition)
      if (!sameCursor(current, observed)) return false
      const data = { kind: definition.kind, schemaVersion: CURSOR_SCHEMA_VERSION,
        revision: current.revision + 1, cursorUpdatedAt: next.cursorUpdatedAt,
        cursorId: next.cursorId, updatedAt: now }
      if (current.exists) await transaction.collection(COLLECTIONS.settings).doc(definition.id).update({ data })
      else await transaction.collection(COLLECTIONS.settings).doc(definition.id).set({ data })
      return true
    })
    return claimed ? rows : []
  }

  const SEARCH_STATE_FIELDS = Object.freeze([
    'searchSourceVersion', 'searchGeneratedVersion', 'searchGenerationId',
    'searchIndexStatus', 'searchGeneratedAt', 'searchUpdatedAt', 'searchSchemaVersion'
  ])

  function hasAnySearchState(document) {
    return !isPlainObject(document) || SEARCH_STATE_FIELDS.some(field => field in document)
  }

  async function initializeLegacyLine(line, now, recoveryAccess) {
    if (!isPlainObject(line) || !exactString(line._id, { maximum: 128 }) ||
        ['creating', 'deleted'].includes(line.status) || hasAnySearchState(line) ||
        !exactSafeInteger(line.nodeCount, 1) || line.nodeCount > MAX_NODES) return null
    const response = await db.collection(COLLECTIONS.nodes)
      .where({ businessLineId: line._id }).orderBy('sequence', 'asc').orderBy('_id', 'asc')
      .limit(MAX_NODES + 1).get()
    const nodes = (response.data || []).slice().sort(compareNodes)
    if (nodes.length !== line.nodeCount || nodes.some(node => !isPlainObject(node) ||
        node.businessLineId !== line._id || !exactString(node._id, { maximum: 128 }) || hasAnySearchState(node))) {
      return null
    }
    return db.runTransaction(async transaction => {
      const readHead = recoveryAccess ? readRecoveryDocument : readDocument
      const actor = recoveryAccess && await readHead(transaction, COLLECTIONS.users, recoveryAccess.actorId)
      const currentLine = await readHead(transaction, COLLECTIONS.lines, line._id)
      if (!currentLine || currentLine.status !== line.status || currentLine.nodeCount !== line.nodeCount ||
          hasAnySearchState(currentLine) || recoveryAccess && !recoveryCanRead(actor, currentLine, recoveryAccess)) return null
      const currentNodes = []
      for (const node of nodes) {
        const current = await readDocument(transaction, COLLECTIONS.nodes, node._id)
        if (!current || current.businessLineId !== line._id || hasAnySearchState(current)) return null
        currentNodes.push(current)
      }
      const pending = { searchSourceVersion: 1, searchGeneratedVersion: 0,
        searchIndexStatus: 'pending', searchUpdatedAt: now }
      await transaction.collection(COLLECTIONS.lines).doc(line._id).update({ data: pending })
      for (const node of currentNodes) {
        await transaction.collection(COLLECTIONS.nodes).doc(node._id).update({ data: pending })
      }
      return { businessLineId: line._id, sourceVersion: 1 }
    })
  }

  async function initializeMissingNodeSearchState(line, nodes, sourceVersion, access) {
    const included = nodes.map(node => includeRouteNode(line, node))
    const missing = nodes.map((node, index) => included[index] && !hasAnySearchState(node))
    if (!missing.some(Boolean)) return nodes
    if (!exactSafeInteger(sourceVersion, 1) || !exactSafeInteger(line.version, 1) ||
        new Set(nodes.map(node => node._id)).size !== nodes.length ||
        nodes.some((node, index) => !isPlainObject(node) ||
          !exactString(node._id, { maximum: 128 }) || node.businessLineId !== line._id ||
          !exactSafeInteger(node.version, 1) || included[index] && !missing[index] &&
            !safeSourceVersion(node, sourceVersion, { allowLagging: true }))) throw sourceError()

    function unchanged(left, right, fields) {
      return fields.every(field => {
        const before = ownDataValue(left, field), after = ownDataValue(right, field)
        return before.valid === after.valid && (before.value instanceof Date && after.value instanceof Date
          ? before.value.getTime() === after.value.getTime() : before.value === after.value)
      })
    }
    // Only recovery can initialize derived metadata. Read every fixed document
    // before writing: actor + line + 48 nodes + 48 updates = at most 98 operations.
    return db.runTransaction(async transaction => {
      const actor = await readRecoveryDocument(transaction, COLLECTIONS.users, access.actorId)
      const currentLine = await readRecoveryDocument(transaction, COLLECTIONS.lines, line._id)
      if (!recoveryCanRead(actor, currentLine, access)) throw createError('FORBIDDEN')
      if (!safeSourceVersion(currentLine, sourceVersion) ||
          !unchanged(line, currentLine, ['version', 'status', 'nodeCount', 'currentNodeId',
            'flowSchemaVersion', ...SEARCH_STATE_FIELDS])) throw createError('VERSION_CONFLICT')
      const currentNodes = []
      for (let index = 0; index < nodes.length; index += 1) {
        const observed = nodes[index]
        const current = await readRecoveryDocument(transaction, COLLECTIONS.nodes, observed._id)
        if (!isPlainObject(current) || current._id !== observed._id ||
            current.businessLineId !== line._id ||
            !unchanged(observed, current, ['version', 'status', 'sequence', 'routeState',
              'processingRoundNumber', 'latestFeedbackId', 'latestFeedbackRevision', ...SEARCH_STATE_FIELDS]) ||
            includeRouteNode(currentLine, current) !== included[index] ||
            missing[index] && hasAnySearchState(current)) throw createError('VERSION_CONFLICT')
        if (included[index] && !missing[index] &&
            !safeSourceVersion(current, sourceVersion, { allowLagging: true })) throw sourceError()
        currentNodes.push(current)
      }
      const pending = { searchSourceVersion: sourceVersion, searchGeneratedVersion: 0,
        searchIndexStatus: 'pending', searchUpdatedAt: clock() }
      for (let index = 0; index < currentNodes.length; index += 1) {
        if (!missing[index]) continue
        await transaction.collection(COLLECTIONS.nodes).doc(currentNodes[index]._id).update({ data: pending })
        currentNodes[index] = { ...currentNodes[index], ...pending }
      }
      return currentNodes
    })
  }

  async function claimBackfillPage({ now, batchSize }) {
    const rows = await claimRawPage({ definition: CURSORS.backfill, collection: COLLECTIONS.lines,
      sortField: 'updatedAt', batchSize, now })
    const requests = []
    for (const line of rows) {
      const initialized = await initializeLegacyLine(line, now)
      if (initialized) requests.push(initialized)
    }
    return { scanned: rows.length, items: requests }
  }

  async function claimRecoveryPage({ now, batchSize }) {
    const rows = await claimRawPage({ definition: CURSORS.recovery, collection: COLLECTIONS.lines,
      criteria: { searchIndexStatus: 'pending' }, sortField: 'updatedAt', batchSize, now })
    const items = rows.flatMap(line => safeSourceVersion(line, line.searchSourceVersion) &&
      !['creating', 'deleted'].includes(line.status)
      ? [{ businessLineId: line._id, sourceVersion: line.searchSourceVersion }]
      : [])
    return { scanned: rows.length, items }
  }

  async function cleanupOldGeneration({ now, batchSize }) {
    const rows = await claimRawPage({ definition: CURSORS.cleanup, collection: COLLECTIONS.documents,
      sortField: 'createdAt', batchSize, now })
    let cleaned = 0
    for (const document of rows) {
      if (!exactString(document.businessLineId, { maximum: 128 }) ||
          !exactString(document.generationId, { maximum: 128 })) continue
      const line = await readDocument(db, COLLECTIONS.lines, document.businessLineId)
      if (line && line.searchGenerationId === document.generationId) continue
      const result = await db.collection(COLLECTIONS.documents).doc(document._id).remove()
      if (result && result.stats && result.stats.removed === 1) cleaned += 1
    }
    return { scanned: rows.length, cleaned }
  }

  async function loadVotes(round, lineId, nodeId) {
    const response = await db.collection(COLLECTIONS.votes)
      .where({ reviewRoundId: round._id }).orderBy('_id', 'asc').limit(100).get()
    const comments = []
    const reviewers = new Set()
    for (const vote of response.data || []) {
      if (!isPlainObject(vote) || vote.reviewRoundId !== round._id || vote.businessLineId !== lineId ||
          vote.nodeId !== nodeId || !exactString(vote.reviewerUserId, { maximum: 128 }) ||
          !['approved', 'rejected'].includes(vote.decision) || reviewers.has(vote.reviewerUserId) ||
          !exactString(vote.comment, { allowEmpty: true, maximum: 5000 })) throw sourceError()
      reviewers.add(vote.reviewerUserId)
      if (vote.comment) comments.push(vote.comment)
    }
    return comments
  }

  async function loadEvidenceName(evidenceId, lineId, nodeId) {
    const evidence = await readDocument(db, COLLECTIONS.evidences, evidenceId)
    if (!evidence || evidence.businessLineId !== lineId || evidence.nodeId !== nodeId ||
        evidence.storageStatus !== 'available' || (evidence.purgedAt !== null && evidence.purgedAt !== undefined) ||
        !exactString(evidence.fileId, { maximum: 2048 }) || !evidence.fileId.startsWith('cloud://') ||
        !exactString(evidence.fileName, { maximum: 500 })) throw sourceError()
    return evidence.fileName
  }

  async function loadFeedbackEvidenceNames(feedback, lineId, nodeId, { legacy = false } = {}) {
    if (!exactSafeInteger(feedback.evidenceCount) ||
        !exactSafeInteger(feedback.claimedCount) ||
        feedback.claimedCount !== feedback.evidenceCount) throw sourceError()
    const ordered = []
    let cursor = ''
    while (true) {
      const criteria = { feedbackId: feedback._id }
      if (cursor) criteria._id = db.command.gt(cursor)
      const response = await db.collection(COLLECTIONS.evidences)
        .where(criteria).orderBy('_id', 'asc').limit(FEEDBACK_RELATION_PAGE_SIZE).get()
      const page = response && response.data
      if (!Array.isArray(page)) throw sourceError()
      for (const evidence of page) {
        const order = ownDataValue(evidence, 'feedbackEvidenceOrder')
        const hasOrder = evidence && 'feedbackEvidenceOrder' in evidence
        if (!exactString(evidence && evidence._id, { maximum: 128 }) ||
            legacy && (!isPlainObject(evidence) || 'processingRoundNumber' in evidence) ||
            evidence.businessLineId !== lineId || evidence.nodeId !== nodeId ||
            evidence.feedbackId !== feedback._id || evidence.feedbackRevision !== feedback.revision ||
            evidence.processingRoundNumber !== feedback.processingRoundNumber ||
            evidence.attachmentState !== 'attached' || evidence.storageStatus !== 'available' ||
            (evidence.purgedAt !== null && evidence.purgedAt !== undefined) ||
            !exactString(evidence.fileId, { maximum: 2048 }) || !evidence.fileId.startsWith('cloud://') ||
            !exactString(evidence.fileName, { maximum: 500 }) || hasOrder &&
              (!order.valid || !exactSafeInteger(order.value) || order.value >= feedback.evidenceCount)) {
          throw sourceError()
        }
        ordered.push({ id: evidence._id, order: hasOrder ? order.value : null, fileName: evidence.fileName })
      }
      if (page.length < FEEDBACK_RELATION_PAGE_SIZE) break
      const nextCursor = page.at(-1)._id
      if (!exactString(nextCursor, { maximum: 128 }) || nextCursor === cursor) throw sourceError()
      cursor = nextCursor
    }
    ordered.sort((left, right) =>
      (left.order === null ? Number.MAX_SAFE_INTEGER : left.order) -
        (right.order === null ? Number.MAX_SAFE_INTEGER : right.order) || left.id.localeCompare(right.id))
    const explicitOrders = ordered.filter(item => item.order !== null).map(item => item.order)
    if (ordered.length !== feedback.evidenceCount || new Set(explicitOrders).size !== explicitOrders.length ||
        explicitOrders.length === ordered.length && ordered.some((item, index) => item.order !== index)) {
      throw sourceError()
    }
    return ordered.map(item => item.fileName)
  }

  async function loadCurrentRoundEvidenceNames(latest, lineId, node, { completed }) {
    const names = []
    let beforeRevision = null
    let foundLatest = false
    while (true) {
      const criteria = { nodeId: node._id, revision: beforeRevision === null
        ? db.command.lte(latest.revision) : db.command.lt(beforeRevision) }
      const response = await db.collection(COLLECTIONS.feedback).where(criteria)
        .orderBy('revision', 'desc').limit(FEEDBACK_RELATION_PAGE_SIZE).get()
      const page = response && response.data
      if (!Array.isArray(page)) throw sourceError()
      let previous = beforeRevision
      let reachedOldRound = false
      for (const feedback of page) {
        if (!feedback || !exactSafeInteger(feedback.revision, 1) ||
            previous !== null && feedback.revision >= previous) throw sourceError()
        previous = feedback.revision
        if (feedback.publishState !== 'published') continue
        if (feedback.businessLineId !== lineId || feedback.nodeId !== node._id ||
            !exactString(feedback._id, { maximum: 128 }) ||
            !exactSafeInteger(feedback.processingRoundNumber, 1) ||
            feedback.processingRoundNumber > node.processingRoundNumber) throw sourceError()
        if (feedback.processingRoundNumber < node.processingRoundNumber) {
          reachedOldRound = true
          break
        }
        if (!['save_progress', 'mark_blocked'].includes(feedback.action) &&
            !(completed && feedback._id === latest._id && feedback.action === 'complete_node')) throw sourceError()
        if (feedback._id === latest._id && feedback.revision === latest.revision) foundLatest = true
        names.push(...await loadFeedbackEvidenceNames(feedback, lineId, node._id))
      }
      if (reachedOldRound || page.length < FEEDBACK_RELATION_PAGE_SIZE) break
      if (previous === null || previous === beforeRevision) throw sourceError()
      beforeRevision = previous
    }
    if (!foundLatest) throw sourceError()
    return names
  }

  async function snapshotFromFeedback(node, lineId, { completed = false } = {}) {
    const feedback = await readDocument(db, COLLECTIONS.feedback, node.latestFeedbackId)
    if (!feedback || feedback.businessLineId !== lineId || feedback.nodeId !== node._id ||
        feedback.revision !== node.latestFeedbackRevision || feedback.publishState !== 'published' ||
        !(completed ? feedback.action === 'complete_node'
          : ['save_progress', 'mark_blocked'].includes(feedback.action))) throw sourceError()
    if (feedback.processingRoundNumber !== node.processingRoundNumber) {
      // Rejection opens an empty new processing round while preserving the old
      // feedback pointer for history. Only the verified rejection may project
      // empty content; arbitrary stale/corrupt pointers still fail closed.
      const round = !completed && node.status === 'in_progress' &&
        exactSafeInteger(feedback.processingRoundNumber, 1) &&
        feedback.processingRoundNumber + 1 === node.processingRoundNumber &&
        exactString(node.lastReviewRoundId, { maximum: 128 })
        ? await readDocument(db, COLLECTIONS.rounds, node.lastReviewRoundId) : null
      if (!round || round.businessLineId !== lineId || round.nodeId !== node._id ||
          round.status !== 'rejected' || round.finalDecision !== 'rejected' ||
          round.processingRoundNumber !== feedback.processingRoundNumber ||
          round.feedbackId !== feedback._id || round.feedbackRevision !== feedback.revision) throw sourceError()
      return { fieldValues: [], processingComment: '', reviewComments: [], evidenceFileNames: [] }
    }
    const comment = ownDataValue(feedback, 'comment')
    if (!comment.valid || !exactString(comment.value, { allowEmpty: true, maximum: 1000 })) {
      throw sourceError()
    }
    return {
      fieldValues: safeFieldValues(feedback.fieldValues || []),
      processingComment: comment.value,
      reviewComments: [],
      evidenceFileNames: await loadCurrentRoundEvidenceNames(feedback, lineId, node, { completed })
    }
  }

  async function snapshotFromLegacyFeedback(node, lineId) {
    const feedback = await readDocument(db, COLLECTIONS.feedback, node.latestFeedbackId)
    if (!isPlainObject(feedback) ||
        ['action', 'processingRoundNumber', 'workflowMode', 'reviewRoundNumber', 'reviewRoundId',
          'processorUserIds', 'reviewerUserIds', 'routeState', 'routeTransition',
          'activeReviewRoundId', 'lastReviewRoundId'].some(key => key in feedback) ||
        ['_id', 'businessLineId', 'nodeId', 'revision', 'publishState', 'status',
          'fieldValues', 'comment', 'evidenceCount', 'claimedCount'].some(key => !ownDataValue(feedback, key).valid) ||
        feedback._id !== node.latestFeedbackId || feedback.businessLineId !== lineId ||
        feedback.nodeId !== node._id || feedback.revision !== node.latestFeedbackRevision ||
        feedback.publishState !== 'published' || feedback.status !== node.status ||
        !exactString(feedback.comment, { allowEmpty: true, maximum: 1000 })) throw sourceError()
    // Pre-review feedback has immutable revisions, but no processing rounds.
    // Select only the exact latest revision and its own attachments, never a
    // fabricated same-round union or a history[0] fallback after rejection.
    return {
      fieldValues: safeFieldValues(feedback.fieldValues),
      processingComment: feedback.comment,
      reviewComments: [],
      evidenceFileNames: await loadFeedbackEvidenceNames(feedback, lineId, node._id, { legacy: true })
    }
  }

  async function snapshotFromRound(node, lineId, final) {
    const roundId = final ? node.lastReviewRoundId : node.activeReviewRoundId
    const round = await readDocument(db, COLLECTIONS.rounds, roundId)
    const statusValid = final
      ? round && round.status === 'approved' && round.finalDecision === 'approved'
      : round && round.status === 'pending' && (round.finalDecision === null || round.finalDecision === undefined)
    if (!statusValid || round.businessLineId !== lineId || round.nodeId !== node._id ||
        round.processingRoundNumber !== node.processingRoundNumber) throw sourceError()
    const fieldValues = safeFieldValues(round.fieldValues || [])
    const processingComment = safeText(round.processingComment || '')
    const evidenceIds = exactStringArray(round.evidenceIds || [], { maximum: 100 })
    if (!evidenceIds) throw sourceError()
    // Keep the outer node traversal serial. Votes and individual evidence reads
    // share ONE pool, after the authoritative round has been validated.
    const [reviewComments, ...evidenceFileNames] = await mapBounded([
      () => loadVotes(round, lineId, node._id),
      ...evidenceIds.map(id => () => loadEvidenceName(id, lineId, node._id))
    ], read => read())
    return {
      fieldValues, processingComment, reviewComments, evidenceFileNames
    }
  }

  async function loadAuthoritativeSnapshot({ businessLineId, sourceVersion, recoveryAccess }) {
    if (!exactString(businessLineId, { maximum: 128 }) || !exactSafeInteger(sourceVersion)) throw sourceError()
    const line = recoveryAccess
      ? await authorizeRecoveryLine(businessLineId, recoveryAccess)
      : await readDocument(db, COLLECTIONS.lines, businessLineId)
    if (recoveryAccess && !line) throw createError('FORBIDDEN')
    if (!safeSourceVersion(line, sourceVersion) || !exactString(line.code, { maximum: 128 }) ||
        !exactString(line.name, { maximum: 500 }) ||
        !exactString(line.description || '', { allowEmpty: true, maximum: 10000 }) ||
        ['creating', 'deleted'].includes(line.status)) throw sourceError()
    const response = await db.collection(COLLECTIONS.nodes)
      .where({ businessLineId }).orderBy('sequence', 'asc').orderBy('_id', 'asc').limit(MAX_NODES + 1).get()
    let nodes = (response.data || []).slice().sort(compareNodes)
    if (nodes.length > MAX_NODES || !exactSafeInteger(line.nodeCount, 1) || line.nodeCount !== nodes.length) {
      throw sourceError()
    }
    if (recoveryAccess) nodes = await initializeMissingNodeSearchState(line, nodes, sourceVersion, recoveryAccess)
    const projected = []
    for (const node of nodes) {
      if (!includeRouteNode(line, node)) continue
      const legacyFeedback = isLegacyFeedbackWithoutRound(line, node)
      if (!safeSourceVersion(node, sourceVersion, { allowLagging: true }) ||
          node.businessLineId !== businessLineId ||
          !exactString(node._id, { maximum: 128 }) || !exactString(node.name, { maximum: 500 }) ||
          !exactString(node.nodeCode, { maximum: 128 }) ||
          !exactSafeInteger(node.processingRoundNumber, 1) &&
            !isLegacyMetadataWithoutRound(line, node) && !legacyFeedback) {
        throw sourceError()
      }
      let dynamic = { fieldValues: [], processingComment: '', reviewComments: [], evidenceFileNames: [] }
      if (node.activationMode === 'optional_tail' && ['awaiting_decision', 'skipped'].includes(node.status)) continue
      if (legacyFeedback) dynamic = await snapshotFromLegacyFeedback(node, businessLineId)
      else if (['in_progress', 'blocked'].includes(node.status)) dynamic = await snapshotFromFeedback(node, businessLineId)
      else if (node.status === 'pending_review') dynamic = await snapshotFromRound(node, businessLineId, false)
      else if (node.status === 'completed' || line.flowSchemaVersion === 2 &&
          node.status === 'awaiting_decision' && node.routeState === 'awaiting_manual_decision') {
        if (typeof node.lastReviewRoundId === 'string' && node.lastReviewRoundId) {
          dynamic = await snapshotFromRound(node, businessLineId, true)
        } else {
          const reviewers = exactStringArray(node.reviewerUserIds || [], { maximum: 100 })
          if (!reviewers || reviewers.length) throw sourceError()
          dynamic = await snapshotFromFeedback(node, businessLineId, { completed: true })
        }
      }
      else if (!['ready', 'waiting'].includes(node.status)) throw sourceError()
      projected.push({ nodeId: node._id, name: node.name, code: node.nodeCode, ...dynamic })
    }
    return {
      businessLineId,
      name: line.name,
      code: line.code,
      description: line.description || '',
      nodes: projected
    }
  }

  async function isGenerationCurrent({ businessLineId, sourceVersion }) {
    if (!exactString(businessLineId, { maximum: 128 }) || !exactSafeInteger(sourceVersion)) return false
    const line = await readDocument(db, COLLECTIONS.lines, businessLineId)
    return Boolean(completeGenerationHeader(line) &&
      line.searchSchemaVersion === SEARCH_SCHEMA_VERSION &&
      line.searchSourceVersion === sourceVersion)
  }

  function completeGenerationHeader(line) {
    return Boolean(line && line.searchIndexStatus === 'generated' &&
      safeSourceVersion(line, line.searchSourceVersion) &&
      line.searchSourceVersion === line.searchGeneratedVersion &&
      exactString(line.searchGenerationId, { maximum: 128 }))
  }

  async function publishGeneration({ businessLineId, sourceVersion, generationId, entries, recoveryAccess }) {
    if (!exactString(businessLineId, { maximum: 128 }) || !exactSafeInteger(sourceVersion) ||
        !exactString(generationId, { maximum: 128 }) || !Array.isArray(entries) || entries.length > 5000) {
      throw sourceError()
    }
    const nodesResponse = await db.collection(COLLECTIONS.nodes)
      .where({ businessLineId }).orderBy('sequence', 'asc').orderBy('_id', 'asc').limit(MAX_NODES + 1).get()
    const nodeIds = (nodesResponse.data || []).slice().sort(compareNodes).map(node => node._id)
    if (nodeIds.length < 1 || nodeIds.length > MAX_NODES) throw sourceError()
    const createdAt = clock()
    function* generationWrites() {
      const documentIds = new Set()
      for (const entry of entries) {
        if (!isPlainObject(entry) || entry.businessLineId !== businessLineId ||
            !exactString(entry.entryId, { maximum: 256 }) || !exactString(entry.sourceKind, { maximum: 64 }) ||
            !exactString(entry.label, { maximum: 500 }) ||
            !exactString(entry.normalizedText, { maximum: 4096 }) ||
            !exactString(entry.safeExcerpt, { maximum: 1000 }) || !exactSafeInteger(entry.segmentIndex) ||
            !Array.isArray(entry.tokenChunks)) throw sourceError()
        const entryId = documentId([businessLineId, generationId, entry.entryId, 'entry'])
        if (documentIds.has(entryId)) throw sourceError()
        documentIds.add(entryId)
        yield { id: entryId, data: {
          documentType: 'entry', businessLineId, nodeId: entry.nodeId || null, sourceVersion, generationId,
          entryId: entry.entryId, sourceKind: entry.sourceKind, label: entry.label,
          normalizedText: entry.normalizedText, safeExcerpt: entry.safeExcerpt,
          segmentIndex: entry.segmentIndex, nodeName: entry.nodeName || '', createdAt
        } }
        for (const tokenChunk of entry.tokenChunks) {
          if (!isPlainObject(tokenChunk) || !exactSafeInteger(tokenChunk.tokenChunkIndex) ||
              !Array.isArray(tokenChunk.tokenHashes) || tokenChunk.tokenHashes.length < 1 ||
              tokenChunk.tokenHashes.some(hash => !exactString(hash, { maximum: 32 }))) throw sourceError()
          const tokenId = documentId([
            businessLineId, generationId, entry.entryId, 'tokens', String(tokenChunk.tokenChunkIndex)
          ])
          if (documentIds.has(tokenId)) throw sourceError()
          documentIds.add(tokenId)
          yield { id: tokenId, data: {
            documentType: 'tokens', businessLineId, nodeId: entry.nodeId || null, sourceVersion, generationId,
            entryId: entry.entryId, tokenChunkIndex: tokenChunk.tokenChunkIndex,
            tokenHashes: tokenChunk.tokenHashes.slice(), createdAt
          } }
        }
      }
    }
    await mapBounded(generationWrites(), write =>
      db.collection(COLLECTIONS.documents).doc(write.id).set({ data: write.data }))
    return db.runTransaction(async transaction => {
      const readHead = recoveryAccess ? readRecoveryDocument : readDocument
      const actor = recoveryAccess && await readHead(transaction, COLLECTIONS.users, recoveryAccess.actorId)
      const line = await readHead(transaction, COLLECTIONS.lines, businessLineId)
      if (recoveryAccess && !recoveryCanRead(actor, line, recoveryAccess)) throw createError('FORBIDDEN')
      if (!safeSourceVersion(line, sourceVersion) || line.nodeCount !== nodeIds.length) {
        throw createError('VERSION_CONFLICT')
      }
      const currentNodes = []
      for (const nodeId of nodeIds) {
        const node = await readDocument(transaction, COLLECTIONS.nodes, nodeId)
        if (!node || node.businessLineId !== businessLineId) {
          throw createError('VERSION_CONFLICT')
        }
        if (!includeRouteNode(line, node)) continue
        if (!safeSourceVersion(node, sourceVersion, { allowLagging: true })) {
          throw createError('VERSION_CONFLICT')
        }
        currentNodes.push(node)
      }
      const update = {
        searchSourceVersion: sourceVersion,
        searchGeneratedVersion: sourceVersion,
        searchGenerationId: generationId,
        searchIndexStatus: 'generated',
        searchSchemaVersion: SEARCH_SCHEMA_VERSION,
        searchGeneratedAt: createdAt
      }
      await transaction.collection(COLLECTIONS.lines).doc(businessLineId).update({ data: update })
      for (const node of currentNodes) {
        await transaction.collection(COLLECTIONS.nodes).doc(node._id).update({ data: update })
      }
      return { generatedVersion: sourceVersion, generationId }
    })
  }

  function accountCanRead(actor, line, scope) {
    if (!actor || actor.status !== 'active') return false
    if (actor.role === 'super_admin' && scope !== 'mine') return true
    const accountManagers = ownDataValue(line, 'managerUserIds')
    const accountMembers = ownDataValue(line, 'memberUserIds')
    if (Object.prototype.hasOwnProperty.call(line, 'managerUserIds') ||
        Object.prototype.hasOwnProperty.call(line, 'memberUserIds')) {
      if (scope === 'mine') {
        return [accountManagers, accountMembers].some(field => {
          if (!field.valid) return false
          const ids = exactStringArray(field.value, { maximum: Number.MAX_SAFE_INTEGER })
          return Boolean(ids && ids.every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id)) && ids.includes(actor._id))
        })
      }
      const managers = exactStringArray(accountManagers.value, { nonEmpty: true })
      const members = exactStringArray(accountMembers.value, { nonEmpty: true })
      return Boolean(managers && members && (managers.includes(actor._id) || members.includes(actor._id)))
    }
    const legacyManagers = exactStringArray(ownDataValue(line, 'managerIds').value)
    const legacyMembers = exactStringArray(ownDataValue(line, 'memberIds').value)
    const openid = ownDataValue(actor, 'openid')
    return Boolean(legacyManagers && legacyMembers && openid.valid &&
      exactString(openid.value, { maximum: 128 }) &&
      (legacyManagers.includes(openid.value) || legacyMembers.includes(openid.value)))
  }

  function validateQueryInput(input) {
    const filters = queryFilters(input, 'INVALID_SEARCH_QUERY')
    const { actorId, normalizedKeywords, digestInput, pageSize, cursor = '', startDate = '', endDate = '' } = input
    if (!exactString(actorId, { maximum: 128 }) || !exactKeywords(normalizedKeywords) ||
        !exactString(digestInput, { maximum: 512 }) || !exactSafeInteger(pageSize, 1) || pageSize > 20 ||
        !exactString(cursor, { allowEmpty: true, maximum: 2048 }) ||
        typeof startDate !== 'string' || typeof endDate !== 'string' ||
        !/^$|^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^$|^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
        (startDate && endDate && startDate > endDate)) throw createError('INVALID_SEARCH_QUERY')
    return filters
  }

  function recoveryCanRead(actor, line, access) {
    if (!actor || actor._id !== access.actorId || actor.role !== access.role || !isPlainObject(line) ||
        !accountCanRead(actor, line, access.scope) || ['creating', 'deleted'].includes(line.status) ||
        access.businessStatus && line.status !== access.businessStatus) return false
    const date = shanghaiDateKey(line.createdAt)
    return !(access.startDate && (!date || date < access.startDate) ||
      access.endDate && (!date || date > access.endDate))
  }

  async function authorizeRecoveryLine(lineId, access) {
    return db.runTransaction(async transaction => {
      const actor = await readRecoveryDocument(transaction, COLLECTIONS.users, access.actorId)
      const line = await readRecoveryDocument(transaction, COLLECTIONS.lines, lineId)
      return recoveryCanRead(actor, line, access) ? line : null
    })
  }

  // A raw scan position can belong to somebody else's line. Authentication
  // alone would expose it through base64: encrypt it with a domain-separated key.
  const recoveryKey = crypto.createHmac('sha256', secret).update('businessSearch/recovery-cursor/v1').digest()
  const recoveryAad = Buffer.from('businessSearch/recovery/v1')
  function encodeRecoveryCursor(state) {
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', recoveryKey, nonce)
    cipher.setAAD(recoveryAad)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
    return `recovery:${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')}`
  }

  function decodeRecoveryCursor(cursor, binding, now) {
    try {
      const encoded = cursor.slice('recovery:'.length)
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw createError('INVALID_SEARCH_QUERY')
      const bytes = Buffer.from(encoded, 'base64url')
      if (bytes.length < 29 || bytes.toString('base64url') !== encoded) throw createError('INVALID_SEARCH_QUERY')
      const decipher = crypto.createDecipheriv('aes-256-gcm', recoveryKey, bytes.subarray(0, 12))
      decipher.setAAD(recoveryAad)
      decipher.setAuthTag(bytes.subarray(12, 28))
      const state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
      if (!isPlainObject(state) || state.v !== 1 || state.actorId !== binding.actorId || state.role !== binding.role ||
          state.filterDigest !== binding.filterDigest || !exactString(state.afterId, { maximum: 128 }) ||
          typeof state.incomplete !== 'boolean' || !exactSafeInteger(state.expiresAt, 1) ||
          state.expiresAt <= now.getTime()) throw createError('INVALID_SEARCH_QUERY')
      return state
    } catch (_) {
      throw createError('INVALID_SEARCH_QUERY')
    }
  }

  async function recoverForQuery(input, rebuild, reportFailure = () => {}) {
    const filters = validateQueryInput(input)
    if (typeof rebuild !== 'function') throw createError('SEARCH_CONFIGURATION_INVALID')
    const now = clock()
    if (!exactDate(now)) throw sourceError()
    const diagnostics = []
    let state = { incomplete: false }
    let actor
    try {
      actor = await readRecoveryDocument(db, COLLECTIONS.users, input.actorId)
    } catch (error) {
      failed('initialize', error)
      return { done: true, cursor: '', incomplete: true, diagnostics }
    }
    if (!actor || actor.status !== 'active' || !exactString(actor.role, { maximum: 50 })) {
      return { done: true, cursor: '', incomplete: false, diagnostics }
    }
    const binding = { actorId: actor._id, role: actor.role,
      filterDigest: hashHex(secret, JSON.stringify([input.normalizedKeywords, input.digestInput,
        input.startDate || '', input.endDate || '', filters.businessStatus || '', filters.scope || ''])) }
    state = input.cursor
      ? decodeRecoveryCursor(input.cursor, binding, now)
      : { v: 1, ...binding, afterId: '', incomplete: false, expiresAt: now.getTime() + QUERY_CURSOR_TTL_MS }
    const access = { actorId: actor._id, role: actor.role, ...filters,
      startDate: input.startDate || '', endDate: input.endDate || '' }
    function failed(phase, error) {
      state.incomplete = true
      const descriptor = error && (typeof error === 'object' || typeof error === 'function') &&
        Object.getOwnPropertyDescriptor(error, 'code')
      const code = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : ''
      diagnostics.push({ phase, code: ['SEARCH_SOURCE_INVALID', 'SEARCH_STATE_INVALID', 'VERSION_CONFLICT', 'FORBIDDEN'].includes(code)
        ? code : 'SEARCH_RECOVERY_FAILED' })
      try {
        if (!Object.getOwnPropertyDescriptor(error, 'searchPhase')) {
          Object.defineProperty(error, 'searchPhase', { value: 'recovery', configurable: true })
        }
      } catch (_) {}
      try { reportFailure(error) } catch (_) {}
    }
    let rows
    try {
      const query = db.collection(COLLECTIONS.lines)
      const response = await (state.afterId ? query.where({ _id: db.command.gt(state.afterId) }) : query)
        .orderBy('_id', 'asc').limit(MAX_CYCLE_BATCH).get()
      rows = response.data
      if (!Array.isArray(rows) || rows.length > MAX_CYCLE_BATCH) throw sourceError()
      let previous = state.afterId
      for (const row of rows) {
        if (!isPlainObject(row) || !exactString(row._id, { maximum: 128 }) || row._id <= previous) throw sourceError()
        previous = row._id
      }
    } catch (error) {
      failed('scan', error)
      return { done: true, cursor: '', incomplete: true, diagnostics }
    }
    let attempts = 0, processed = 0
    for (const row of rows) {
      if (attempts >= MAX_QUERY_RECOVERY_BUILDS) break
      // Advance even after failure so a continuation never retries this head.
      processed += 1
      state.afterId = row._id
      if (!recoveryCanRead(actor, row, access)) continue
      if (completeGenerationHeader(row) && row.searchSchemaVersion === SEARCH_SCHEMA_VERSION) continue
      let phase = 'initialize'
      try {
        const line = await authorizeRecoveryLine(row._id, access)
        if (!line) continue
        let request
        if (!hasAnySearchState(line)) {
          attempts += 1
          request = await initializeLegacyLine(line, now, access)
          if (!request) throw sourceError()
        } else if (safeSourceVersion(line, line.searchSourceVersion) &&
            (line.searchIndexStatus === 'pending' || completeGenerationHeader(line) &&
              line.searchSchemaVersion !== SEARCH_SCHEMA_VERSION)) {
          attempts += 1
          request = { businessLineId: line._id, sourceVersion: line.searchSourceVersion }
        } else {
          // Never initialize partially populated/corrupt version metadata.
          if (!completeGenerationHeader(line) || line.searchSchemaVersion !== SEARCH_SCHEMA_VERSION) throw sourceError()
          continue
        }
        phase = 'rebuild'
        await rebuild({ ...request, recoveryAccess: access })
      } catch (error) {
        failed(phase, error)
      }
    }
    const more = processed < rows.length || rows.length === MAX_CYCLE_BATCH
    return { done: !more, cursor: more ? encodeRecoveryCursor(state) : '', incomplete: state.incomplete, diagnostics }
  }

  async function authorizeCandidate(actorId, lineId, filters) {
    try {
      return await db.runTransaction(async transaction => {
        const actor = await readDocument(transaction, COLLECTIONS.users, actorId)
        const line = await readDocument(transaction, COLLECTIONS.lines, lineId)
        if (!accountCanRead(actor, line, filters.scope) || ['creating', 'deleted'].includes(line.status) ||
            (filters.businessStatus && line.status !== filters.businessStatus) ||
            line.searchIndexStatus !== 'generated' ||
            line.searchSourceVersion !== line.searchGeneratedVersion ||
            !exactString(line.searchGenerationId, { maximum: 128 })) return null
        return {
          _id: line._id, code: line.code || '', name: line.name || '', status: line.status,
          currentNodeId: line.currentNodeId || '', generationId: line.searchGenerationId,
          createdDate: shanghaiDateKey(line.createdAt)
        }
      })
    } catch (_) {
      return null
    }
  }

  function cursorSignature(payload) {
    return hashHex(secret, payload)
  }

  function encodeCursor({ actorId, filterDigest, accessMode, lastLineId, now, incomplete = false }) {
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      actorId,
      filterDigest,
      accessMode,
      lastLineId,
      ...(incomplete ? { incomplete: true } : {}),
      expiresAt: now.getTime() + QUERY_CURSOR_TTL_MS
    }), 'utf8').toString('base64url')
    return `${payload}.${cursorSignature(payload)}`
  }

  function decodeCursor(cursor, actorId, filterDigest, accessMode, now) {
    if (!cursor) return { lastLineId: '', incomplete: false }
    if (!exactString(cursor, { maximum: 2048 })) throw createError('INVALID_SEARCH_QUERY')
    const [payload, signature, extra] = cursor.split('.')
    if (!payload || !signature || extra || cursorSignature(payload) !== signature) {
      throw createError('INVALID_SEARCH_QUERY')
    }
    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (!isPlainObject(decoded) || decoded.v !== 1 || decoded.actorId !== actorId ||
          decoded.filterDigest !== filterDigest || decoded.accessMode !== accessMode ||
          !exactString(decoded.lastLineId, { maximum: 128 }) ||
            !exactSafeInteger(decoded.expiresAt, 1) || decoded.expiresAt <= now.getTime() ||
            decoded.incomplete !== undefined && typeof decoded.incomplete !== 'boolean') {
        throw createError('INVALID_SEARCH_QUERY')
      }
      return { lastLineId: decoded.lastLineId, incomplete: decoded.incomplete === true }
    } catch (error) {
      if (error && error.code === 'INVALID_SEARCH_QUERY') throw error
      throw createError('INVALID_SEARCH_QUERY')
    }
  }

  function anchorHash(keyword) {
    const points = Array.from(keyword)
    return hashToken(secret, points.slice(0, Math.min(3, points.length)).join(''))
  }

  async function candidateLinePage(keyword, lastLineId) {
    const criteria = { documentType: 'tokens', tokenHashes: anchorHash(keyword) }
    if (lastLineId) criteria.businessLineId = db.command.gt(lastLineId)
    const response = await db.collection(COLLECTIONS.documents)
      .where(criteria).orderBy('businessLineId', 'asc')
      .limit(MAX_QUERY_CANDIDATES).get()
    const rows = response.data || []
    const ids = []
    const seen = new Set()
    for (const row of rows) {
      if (!isPlainObject(row) || !exactString(row.businessLineId, { maximum: 128 })) throw sourceError()
      if (!seen.has(row.businessLineId)) {
        seen.add(row.businessLineId)
        ids.push(row.businessLineId)
      }
    }
    return { ids, rawFull: rows.length === MAX_QUERY_CANDIDATES }
  }

  async function loadGenerationEntries(businessLineId, generationId) {
    const entries = []
    let afterEntryId = ''
    while (entries.length < MAX_GENERATION_ENTRIES) {
      const criteria = { documentType: 'entry', businessLineId, generationId }
      if (afterEntryId) criteria.entryId = db.command.gt(afterEntryId)
      const response = await db.collection(COLLECTIONS.documents)
        .where(criteria).orderBy('entryId', 'asc').limit(MAX_QUERY_CANDIDATES).get()
      const page = response.data || []
      for (const entry of page) {
        if (!isPlainObject(entry) || !exactString(entry.entryId, { maximum: 256 }) ||
            (afterEntryId && entry.entryId <= afterEntryId) ||
            !exactString(entry.normalizedText, { allowEmpty: true, maximum: 4096 })) throw sourceError()
        entries.push(entry)
        afterEntryId = entry.entryId
      }
      if (page.length < MAX_QUERY_CANDIDATES) return entries
    }
    const overflow = await db.collection(COLLECTIONS.documents)
      .where({ documentType: 'entry', businessLineId, generationId, entryId: db.command.gt(afterEntryId) })
      .orderBy('entryId', 'asc').limit(1).get()
    if ((overflow.data || []).length) throw sourceError()
    return entries
  }

  async function queryAuthorized(input, { incomplete = false } = {}) {
    const filters = validateQueryInput(input)
    const { actorId, normalizedKeywords, digestInput, pageSize, cursor = '', startDate = '', endDate = '' } = input
    const now = clock()
    if (!exactDate(now)) throw sourceError()
    const currentActor = await readDocument(db, COLLECTIONS.users, actorId)
    if (!currentActor || currentActor.status !== 'active') return { items: [], cursor: '', hasMore: false }
    const accessMode = currentActor.role === 'super_admin' ? 'global' : 'scoped'
    const filterDigest = Object.keys(filters).length
      ? JSON.stringify([digestInput, startDate, endDate, filters.businessStatus || '', filters.scope || ''])
      : [digestInput, startDate, endDate].join('\u0000')
    const decodedCursor = decodeCursor(cursor, actorId, filterDigest, accessMode, now)
    const lastLineId = decodedCursor.lastLineId
    incomplete = incomplete || decodedCursor.incomplete
    const candidatePage = await candidateLinePage(normalizedKeywords[0], lastLineId)
    const candidates = candidatePage.ids
    const items = []
    let scannedLast = ''
    for (const lineId of candidates) {
      scannedLast = lineId
      const first = await authorizeCandidate(actorId, lineId, filters)
      if (!first) continue
      if ((startDate && (!first.createdDate || first.createdDate < startDate)) ||
          (endDate && (!first.createdDate || first.createdDate > endDate))) continue
      const sourceEntries = await loadGenerationEntries(lineId, first.generationId)
      const everyKeywordMatched = normalizedKeywords.every(keyword => sourceEntries.some(entry =>
        typeof entry.normalizedText === 'string' && entry.normalizedText.includes(keyword)))
      if (!everyKeywordMatched) continue
      const selectedEntries = []
      const selectedIds = new Set()
      for (const keyword of normalizedKeywords) {
        const entry = sourceEntries.find(candidate => typeof candidate.normalizedText === 'string' &&
          candidate.normalizedText.includes(keyword) && !selectedIds.has(candidate.entryId))
        if (entry && selectedEntries.length < 3) {
          selectedEntries.push(entry)
          selectedIds.add(entry.entryId)
        }
      }
      for (const entry of sourceEntries) {
        if (selectedEntries.length >= 3) break
        if (selectedIds.has(entry.entryId) || typeof entry.normalizedText !== 'string' ||
            !normalizedKeywords.some(keyword => entry.normalizedText.includes(keyword))) continue
        selectedEntries.push(entry)
        selectedIds.add(entry.entryId)
      }
      const second = await authorizeCandidate(actorId, lineId, filters)
      if (!second || second.generationId !== first.generationId) continue
      const node = second.currentNodeId
        ? await readDocument(db, COLLECTIONS.nodes, second.currentNodeId)
        : null
      items.push({
        _id: second._id,
        code: second.code,
        name: second.name,
        status: second.status,
        currentNodeName: node && node.businessLineId === lineId ? node.name || '' : '',
        matches: selectedEntries.map(entry => ({
          nodeName: entry.nodeName || '',
          label: entry.label || '',
          excerpt: safeSearchExcerpt(entry,
            normalizedKeywords.filter(keyword => entry.normalizedText.includes(keyword)))
        }))
      })
      if (items.length >= pageSize) break
    }
    const hasMore = candidatePage.rawFull || candidates.some(id => id > scannedLast)
    return {
      items,
      ...(incomplete ? { indexStatus: 'incomplete' } : {}),
      cursor: scannedLast && (hasMore || items.length >= pageSize)
        ? encodeCursor({ actorId, filterDigest, accessMode, lastLineId: scannedLast, now, incomplete })
        : '',
      hasMore
    }
  }

  return {
    consumeRequest,
    claimBackfillPage,
    claimRecoveryPage,
    cleanupOldGeneration,
    isGenerationCurrent,
    loadAuthoritativeSnapshot,
    publishGeneration,
    queryAuthorized,
    recoverForQuery
  }
}

module.exports = { createCloudSearchRepository }
