'use strict'

const { isDeepStrictEqual } = require('node:util')
const domain = require('./operations-field-domain')

const CURSOR_ID = 'operations-field-snapshot-cursor'
const MAX_BATCH = 40
const MAX_VOTES = 50
const MAX_TIME_MS = 5000

function invalid() { const error = new Error('FIELD_RECOVERY_INVALID'); error.code = 'FIELD_RECOVERY_INVALID'; return error }
function demand(condition) { if (!condition) throw invalid() }
function own(document, key) {
  demand(document && typeof document === 'object' && !Array.isArray(document) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(document)))
  const descriptor = Object.getOwnPropertyDescriptor(document, key)
  demand(descriptor ? Object.hasOwn(descriptor, 'value') : !(key in document))
  return descriptor ? descriptor.value : undefined
}
function documentId(value) {
  // Cursor keys may belong to malformed application nodes. Keep them traversable
  // even if the final-source domain rejects their narrower application ID shape.
  demand(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value))
  return value
}
function isMissingDocument(error) {
  const code = String(error && (error.code || error.errCode) || '').toUpperCase()
  if (code === 'DOCUMENT_NOT_FOUND') return true
  const message = String(error && (error.message || error.errMsg) || '')
  return /document\.get:fail/i.test(message) && /document with _id .+ does not exist/i.test(message)
}
function cursorState(document) {
  if (!document) return { cursorId: null, version: 0 }
  demand(own(document, '_id') === CURSOR_ID)
  demand(Reflect.ownKeys(document).every(key => ['_id', 'cursorId', 'version', 'updatedAt'].includes(key)))
  const cursorId = own(document, 'cursorId'), version = own(document, 'version')
  if (cursorId !== null) documentId(cursorId)
  demand(Number.isSafeInteger(version) && version > 0 && version < Number.MAX_SAFE_INTEGER)
  return { cursorId, version }
}

function createFieldSnapshotRecovery({ db, clock = () => new Date(),
  buildFinalFieldResult = domain.buildFinalFieldResult, selectionSnapshot = domain.selectionSnapshot } = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function' ||
      !db.command || typeof db.command.gt !== 'function' || typeof clock !== 'function' ||
      typeof buildFinalFieldResult !== 'function' || typeof selectionSnapshot !== 'function') {
    throw new TypeError('db, clock and field domain functions are required')
  }

  async function runCycle({ batchSize = MAX_BATCH, timeBudgetMs = MAX_TIME_MS } = {}) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH ||
        !Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 0 || timeBudgetMs > MAX_TIME_MS) {
      throw new TypeError('batchSize must be 1..40 and timeBudgetMs must be 0..5000')
    }
    const counts = { examined: 0, generated: 0, failed: 0, hasMore: true }
    if (!timeBudgetMs) return counts
    let highWaterTime = -Infinity
    function time() {
      const at = clock()
      demand(at instanceof Date && Number.isFinite(Date.prototype.getTime.call(at)))
      highWaterTime = Math.max(highWaterTime, Date.prototype.getTime.call(at))
      return highWaterTime
    }
    let deadline
    function budget() {
      if (time() >= deadline) {
        const error = new Error('FIELD_RECOVERY_BUDGET'); error.code = 'FIELD_RECOVERY_BUDGET'; throw error
      }
    }
    async function read(database, collection, id) {
      budget(); documentId(id)
      try {
        const response = await database.collection(collection).doc(id).get()
        budget()
        const data = response && response.data
        if (!data) return null
        demand(own(data, '_id') === id)
        return data
      } catch (error) {
        if (isMissingDocument(error)) { budget(); return null }
        throw error
      }
    }
    async function moveCursor(observed, cursorId) {
      budget()
      return db.runTransaction(async transaction => {
        const current = cursorState(await read(transaction, 'system_settings', CURSOR_ID))
        if (current.version !== observed.version || current.cursorId !== observed.cursorId) return null
        demand(current.version < Number.MAX_SAFE_INTEGER - 1)
        const next = { cursorId, version: current.version + 1 }
        budget()
        await transaction.collection('system_settings').doc(CURSOR_ID).set({ data: {
          ...next, updatedAt: new Date(time())
        } })
        return next
      })
    }
    async function loadSource(nodeId) {
      const node = await read(db, 'business_nodes', nodeId)
      if (!node) return null
      const status = own(node, 'status'), route = own(node, 'routeState')
      if (!['completed', 'awaiting_decision'].includes(status) ||
          status === 'awaiting_decision' && route !== 'awaiting_manual_decision' ||
          ['dormant', 'skipped'].includes(route)) return null
      const line = await read(db, 'business_lines', own(node, 'businessLineId'))
      demand(line)
      if (['creating', 'deleted'].includes(own(line, 'status'))) return null
      const feedback = await read(db, 'node_feedback', own(node, 'latestFeedbackId'))
      const roundId = own(node, 'lastReviewRoundId')
      const round = roundId == null ? null : await read(db, 'node_review_rounds', roundId)
      let votes = []
      if (round) {
        budget()
        const response = await db.collection('node_review_votes').where({ reviewRoundId: roundId })
          .orderBy('_id', 'asc').limit(MAX_VOTES + 1).get()
        budget()
        demand(response && Array.isArray(response.data) && response.data.length <= MAX_VOTES)
        votes = response.data
      }
      return { line, node, feedback, round, votes }
    }
    function validateVoteCoverage(source) {
      if (!source.round) return
      // The finalized writer freezes these counts. Their fixed-document recheck
      // detects an incomplete/stale vote enumeration without transaction queries.
      demand(own(source.round, 'voteCount') === source.votes.length &&
        own(source.round, 'approvedVoteCount') === source.votes.length)
    }
    async function publish(source, result) {
      validateVoteCoverage(source)
      budget()
      return db.runTransaction(async transaction => {
        const line = await read(transaction, 'business_lines', own(source.line, '_id'))
        const node = await read(transaction, 'business_nodes', own(source.node, '_id'))
        const feedback = source.feedback ? await read(transaction, 'node_feedback', own(source.feedback, '_id')) : null
        const round = source.round ? await read(transaction, 'node_review_rounds', own(source.round, '_id')) : null
        const votes = []
        for (const vote of source.votes) votes.push(await read(transaction, 'node_review_votes', own(vote, '_id')))
        const freshSource = { line, node, feedback, round, votes }
        validateVoteCoverage(freshSource)
        const fresh = buildFinalFieldResult(freshSource)
        demand(fresh && fresh.sourceDigest === result.sourceDigest && fresh.sourceHeader === result.sourceHeader &&
          fresh.nodeId === result.nodeId && fresh.businessLineId === result.businessLineId)
        const snapshot = selectionSnapshot(fresh)
        demand(!Object.hasOwn(snapshot, '_id'))
        const existing = await read(transaction, 'operations_field_snapshots', node._id)
        if (existing) {
          try {
            const projected = selectionSnapshot(existing)
            const exactKeys = Reflect.ownKeys(existing).length === Object.keys(snapshot).length + 1 &&
              Object.keys(snapshot).every(key => Object.hasOwn(existing, key)) &&
              own(existing, 'fields').length === projected.fields.length
            if (exactKeys && isDeepStrictEqual(projected, snapshot)) return false
          } catch (_) { /* replace a malformed derived cache with verified data */ }
        }
        budget()
        await transaction.collection('operations_field_snapshots').doc(node._id).set({ data: snapshot })
        return true
      })
    }

    try {
      deadline = time() + timeBudgetMs
      let observed = cursorState(await read(db, 'system_settings', CURSOR_ID))
      budget()
      const response = await db.collection('business_nodes')
        .where(observed.cursorId === null ? {} : { _id: db.command.gt(observed.cursorId) })
        .orderBy('_id', 'asc').limit(batchSize).get()
      demand(response && Array.isArray(response.data) && response.data.length <= batchSize)
      const page = response.data
      counts.examined = page.length
      budget()
      const tail = page.length < batchSize
      if (!page.length) {
        if (observed.cursorId !== null && !await moveCursor(observed, null)) return counts
        counts.hasMore = false
        return counts
      }
      let previousId = observed.cursorId
      for (let index = 0; index < page.length; index++) {
        budget()
        const nodeId = documentId(own(page[index], '_id'))
        demand(previousId === null || nodeId > previousId)
        // Claim/checkpoint only this raw candidate, not the entire fetched page:
        // expiry or an error cannot perpetually skip its unattempted successors.
        const next = await moveCursor(observed, tail && index === page.length - 1 ? null : nodeId)
        if (!next) return counts
        observed = next; previousId = nodeId
        try {
          const source = await loadSource(nodeId)
          if (source) {
            const result = buildFinalFieldResult(source)
            if (result && await publish(source, result)) counts.generated++
          }
        } catch (error) {
          if (error && error.code === 'FIELD_RECOVERY_BUDGET') return counts
          counts.failed++
        }
      }
      counts.hasMore = !tail
    } catch (error) {
      if (!error || error.code !== 'FIELD_RECOVERY_BUDGET') counts.failed++
    }
    return counts
  }
  return { runCycle }
}

module.exports = { createFieldSnapshotRecovery }
