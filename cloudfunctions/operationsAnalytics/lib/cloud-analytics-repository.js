'use strict'

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
    const roundsResult = await db.collection('node_review_rounds').where({
      businessLineId: line._id, nodeId: node._id
    }).orderBy('reviewRoundNumber', 'asc').limit(100).get()
    const votesResult = await db.collection('node_review_votes').where({
      businessLineId: line._id, nodeId: node._id
    }).orderBy('createdAt', 'asc').limit(100).get()
    return {
      node,
      line,
      rounds: Array.isArray(roundsResult && roundsResult.data) ? roundsResult.data : [],
      votes: Array.isArray(votesResult && votesResult.data) ? votesResult.data : []
    }
  }

  async function readBusinessSource({ sourceId } = {}) {
    if (typeof sourceId !== 'string' || !DOCUMENT_ID.test(sourceId)) throw new TypeError('sourceId is invalid')
    const line = await readDocument(db, 'business_lines', sourceId)
    if (!line) throw new TypeError('business source is invalid')
    const nodesResult = await db.collection('business_nodes').where({ businessLineId: line._id })
      .orderBy('sequence', 'asc').limit(100).get()
    return { line, nodes: Array.isArray(nodesResult && nodesResult.data) ? nodesResult.data : [] }
  }

  return {
    claimNodeCandidates: ({ limit } = {}) => claim('node', limit),
    claimBusinessCandidates: ({ limit } = {}) => claim('business', limit),
    readNodeSource,
    readBusinessSource
  }
}

module.exports = { createCloudAnalyticsRepository }
