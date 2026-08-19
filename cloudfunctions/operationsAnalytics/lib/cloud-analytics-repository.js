'use strict'

const crypto = require('node:crypto')
const { dailyRollupId } = require('./analytics-domain')

const MAX_BATCH_SIZE = 40
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const CURSORS = Object.freeze({
  node: { id: 'operations-analytics-node-cursor', kind: 'operations_analytics_node', collection: 'business_nodes' },
  business: { id: 'operations-analytics-business-cursor', kind: 'operations_analytics_business', collection: 'business_lines' }
})

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new TypeError('limit must be from 1 to 40')
  }
}

function missingDocument(error) {
  return /does not exist|not found/i.test(String(error && (error.errMsg || error.message || error)))
}

async function readDocument(source, collection, id) {
  try {
    const result = await source.collection(collection).doc(id).get()
    return result && result.data ? result.data : null
  } catch (error) {
    if (missingDocument(error)) return null
    throw error
  }
}

function validateCursor(document, spec) {
  if (!document) return { cursorId: null, version: 0 }
  if (document._id !== spec.id || document.kind !== spec.kind ||
      !Number.isSafeInteger(document.version) || document.version < 1 ||
      document.cursorId !== null && (typeof document.cursorId !== 'string' || !DOCUMENT_ID.test(document.cursorId))) {
    throw new TypeError('analytics cursor is invalid')
  }
  return { cursorId: document.cursorId, version: document.version }
}

async function queryCandidates(db, spec, cursorId, limit) {
  const where = {
    analyticsSnapshotStatus: 'pending',
    ...(cursorId ? { _id: db.command.gt(cursorId) } : {})
  }
  const result = await db.collection(spec.collection).where(where).orderBy('_id', 'asc').limit(limit).get()
  return Array.isArray(result && result.data) ? result.data : []
}

async function readAllById(db, collection, baseWhere, pageSize = 100) {
  const rows = []
  let cursorId = null
  for (;;) {
    const result = await db.collection(collection).where({
      ...baseWhere,
      ...(cursorId ? { _id: db.command.gt(cursorId) } : {})
    }).orderBy('_id', 'asc').limit(pageSize).get()
    const page = Array.isArray(result && result.data) ? result.data : []
    rows.push(...page)
    if (page.length < pageSize) return rows
    const next = page.at(-1) && page.at(-1)._id
    if (typeof next !== 'string' || !DOCUMENT_ID.test(next) || next === cursorId) {
      throw new TypeError('analytics source page is invalid')
    }
    cursorId = next
  }
}

const FACT_HASH_FIELDS = [
  '_id', 'sourceType', 'sourceId', 'sourceVersion', 'businessLineId', 'nodeId', 'factType',
  'metric', 'day', 'templateId', 'templateVersion', 'stableNodeId', 'dimensionRole',
  'dimensionUserId', 'dimensionDisplayName', 'timingStatus', 'workMinutes'
]

function factHash(fact) {
  return crypto.createHash('sha256').update(JSON.stringify(FACT_HASH_FIELDS.map(key => fact[key]))).digest('hex')
}

function createCloudAnalyticsRepository({ db } = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('db is required')
  }

  async function claim(kind, limit) {
    validateLimit(limit)
    const spec = CURSORS[kind]
    const observed = validateCursor(await readDocument(db, 'system_settings', spec.id), spec)
    let rows = await queryCandidates(db, spec, observed.cursorId, limit)
    if (!rows.length && observed.cursorId) rows = await queryCandidates(db, spec, null, limit)
    if (!rows.length) return []
    const nextCursorId = rows.at(-1)._id
    if (typeof nextCursorId !== 'string' || !DOCUMENT_ID.test(nextCursorId)) {
      throw new TypeError('candidate id is invalid')
    }
    const claimed = await db.runTransaction(async transaction => {
      const current = validateCursor(await readDocument(transaction, 'system_settings', spec.id), spec)
      if (current.cursorId !== observed.cursorId || current.version !== observed.version) return false
      if (current.version === Number.MAX_SAFE_INTEGER) throw new TypeError('analytics cursor is invalid')
      await transaction.collection('system_settings').doc(spec.id).set({ data: {
        _id: spec.id,
        kind: spec.kind,
        cursorId: nextCursorId,
        version: current.version + 1,
        updatedAt: db.serverDate()
      } })
      return true
    })
    return claimed ? rows.map(row => ({ sourceId: row._id })) : []
  }

  async function readNodeSource({ sourceId } = {}) {
    if (typeof sourceId !== 'string' || !DOCUMENT_ID.test(sourceId)) throw new TypeError('sourceId is invalid')
    const node = await readDocument(db, 'business_nodes', sourceId)
    if (!node || typeof node.businessLineId !== 'string' || !DOCUMENT_ID.test(node.businessLineId)) {
      throw new TypeError('node source is invalid')
    }
    const line = await readDocument(db, 'business_lines', node.businessLineId)
    if (!line) throw new TypeError('node source is invalid')
    const rounds = await readAllById(db, 'node_review_rounds', { businessLineId: line._id, nodeId: node._id })
    const votes = await readAllById(db, 'node_review_votes', { businessLineId: line._id, nodeId: node._id })
    return {
      node,
      line,
      rounds,
      votes
    }
  }

  async function readBusinessSource({ sourceId } = {}) {
    if (typeof sourceId !== 'string' || !DOCUMENT_ID.test(sourceId)) throw new TypeError('sourceId is invalid')
    const line = await readDocument(db, 'business_lines', sourceId)
    if (!line) throw new TypeError('business source is invalid')
    const nodesResult = await db.collection('business_nodes').where({ businessLineId: line._id })
      .orderBy('sequence', 'asc').limit(100).get()
    const factsResult = await db.collection('operations_analytics_facts').where({
      businessLineId: line._id, sourceType: 'node', dimensionRole: 'global'
    }).orderBy('_id', 'asc').limit(100).get()
    return {
      line,
      nodes: Array.isArray(nodesResult && nodesResult.data) ? nodesResult.data : [],
      nodeFacts: Array.isArray(factsResult && factsResult.data) ? factsResult.data : []
    }
  }

  function sourceSpec(fact) {
    if (fact.sourceType === 'node') return { collection: 'business_nodes', id: fact.sourceId }
    if (fact.sourceType === 'business') return { collection: 'business_lines', id: fact.sourceId }
    throw new TypeError('fact source is invalid')
  }

  function deltaForFact(fact) {
    if (fact.timingStatus === 'calculated' && Number.isSafeInteger(fact.workMinutes) && fact.workMinutes >= 0) {
      return { sampleCount: 1, totalMinutes: fact.workMinutes, pendingCount: 0, unrecordedCount: 0 }
    }
    if (fact.timingStatus === 'pending_calendar' && fact.workMinutes === null) {
      return { sampleCount: 0, totalMinutes: 0, pendingCount: 1, unrecordedCount: 0 }
    }
    if (fact.timingStatus === 'historical_unrecorded' && fact.workMinutes === null) {
      return { sampleCount: 0, totalMinutes: 0, pendingCount: 0, unrecordedCount: 1 }
    }
    throw new TypeError('fact timing is invalid')
  }

  function safeCounter(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }

  async function applyFact(fact) {
    if (!fact || typeof fact !== 'object' || typeof fact._id !== 'string' || !DOCUMENT_ID.test(fact._id) ||
        !Number.isSafeInteger(fact.sourceVersion) || fact.sourceVersion < 1) throw new TypeError('fact is invalid')
    const spec = sourceSpec(fact)
    const delta = deltaForFact(fact)
    const identity = {
      day: fact.day,
      templateId: fact.templateId,
      templateVersion: fact.templateVersion,
      stableNodeId: fact.stableNodeId,
      metric: fact.metric,
      dimensionRole: fact.dimensionRole,
      dimensionUserId: fact.dimensionUserId
    }
    const rollupId = dailyRollupId(identity)
    const expectedFactHash = factHash(fact)
    return db.runTransaction(async transaction => {
      const source = await readDocument(transaction, spec.collection, spec.id)
      if (!source || source.analyticsSnapshotStatus !== 'pending' ||
          source.analyticsSourceVersion !== fact.sourceVersion) throw new TypeError('analytics source changed')
      const existingFact = await readDocument(transaction, 'operations_analytics_facts', fact._id)
      if (existingFact) {
        if (existingFact.sourceVersion === fact.sourceVersion &&
            existingFact.rollupAppliedVersion === fact.sourceVersion && existingFact.rollupId === rollupId &&
            existingFact.factHash === expectedFactHash) {
          return { applied: false }
        }
        throw new TypeError('analytics fact conflict')
      }
      const existingRollup = await readDocument(transaction, 'operations_analytics_daily', rollupId)
      const counters = existingRollup || { sampleCount: 0, totalMinutes: 0, pendingCount: 0, unrecordedCount: 0, version: 0 }
      const next = {}
      for (const key of ['sampleCount', 'totalMinutes', 'pendingCount', 'unrecordedCount']) {
        const current = safeCounter(counters[key])
        if (current === null || current > Number.MAX_SAFE_INTEGER - delta[key]) throw new TypeError('analytics rollup is invalid')
        next[key] = current + delta[key]
      }
      const version = safeCounter(counters.version)
      if (version === null || version === Number.MAX_SAFE_INTEGER) throw new TypeError('analytics rollup is invalid')
      await transaction.collection('operations_analytics_facts').doc(fact._id).set({ data: {
        ...fact,
        factHash: expectedFactHash,
        rollupId,
        rollupAppliedVersion: fact.sourceVersion,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      } })
      await transaction.collection('operations_analytics_daily').doc(rollupId).set({ data: {
        _id: rollupId,
        ...identity,
        ...next,
        version: version + 1,
        updatedAt: db.serverDate()
      } })
      return { applied: true }
    })
  }

  async function markSourceGenerated({ sourceType, sourceId, sourceVersion } = {}) {
    const spec = sourceSpec({ sourceType, sourceId })
    return db.runTransaction(async transaction => {
      const source = await readDocument(transaction, spec.collection, spec.id)
      if (!source || source.analyticsSourceVersion !== sourceVersion) throw new TypeError('analytics source changed')
      if (source.analyticsSnapshotStatus === 'generated') return { generated: false }
      if (source.analyticsSnapshotStatus !== 'pending') throw new TypeError('analytics source changed')
      await transaction.collection(spec.collection).doc(spec.id).update({ data: {
        analyticsSnapshotStatus: 'generated',
        analyticsGeneratedVersion: sourceVersion,
        analyticsGeneratedAt: db.serverDate(),
        updatedAt: db.serverDate()
      } })
      return { generated: true }
    })
  }

  return {
    claimNodeCandidates: ({ limit } = {}) => claim('node', limit),
    claimBusinessCandidates: ({ limit } = {}) => claim('business', limit),
    readNodeSource,
    readBusinessSource,
    applyFact,
    markSourceGenerated
  }
}

module.exports = { createCloudAnalyticsRepository }
