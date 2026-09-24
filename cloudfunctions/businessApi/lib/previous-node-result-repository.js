const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { buildFinalFieldResult } = require('./operations-field-domain')
const { classifyEvidenceRetention } = require('./evidence-retention')

function failure(code = 'NODE_RESULT_UNAVAILABLE') {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const text = value => typeof value === 'string' ? value : ''
const displayName = value => typeof value === 'string' && value.trim() && value.length <= 100 &&
  !/[\u0000-\u001f\u007f]/.test(value) ? value : '处理人姓名未留存'

function storedComment(source, key) {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (!descriptor && !(key in source)) return '' // Historical rounds may predate the snapshot field.
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.length > 1000) throw failure()
  return descriptor.value
}

function safeVotes(votes) {
  return votes.map(vote => {
    const comment = Object.getOwnPropertyDescriptor(vote, 'comment')
    const name = typeof vote.reviewerDisplayName === 'string' ? vote.reviewerDisplayName.trim() : ''
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) ||
        !(vote.createdAt instanceof Date) || Number.isNaN(vote.createdAt.getTime()) ||
        (comment ? !Object.hasOwn(comment, 'value') || typeof comment.value !== 'string' || comment.value.length > 1000 : 'comment' in vote)) throw failure()
    return { reviewerDisplayName: name, decision: vote.decision, comment: comment ? comment.value : '', createdAt: vote.createdAt }
  })
}

// Read-only final results. Reuse the final-source proof used by analytics; never
// infer approval from the latest save or call the actionable review-detail API.
function createPreviousNodeResultRepository({ db, businessRepository }) {
  async function read(database, collection, id) {
    if (!validId(id)) throw failure()
    try { return (await database.collection(collection).doc(id).get()).data || null } catch (error) {
      if (error.code === 'DOCUMENT_NOT_FOUND' || /document\.get:fail.*does not exist/i.test(String(error.message))) return null
      throw error
    }
  }
  async function context(database, input) {
    const { actor, businessLineId, nodeId, anchorNodeId } = input
    if (![businessLineId, nodeId, anchorNodeId].every(validId)) throw failure('VALIDATION_ERROR')
    const authorized = await businessRepository.getAuthorizedCardLine({ actor, lineId: businessLineId, database })
    if (!authorized.canReadFields) throw failure('FORBIDDEN')
    const line = authorized.line
    const node = await read(database, 'business_nodes', nodeId)
    const anchor = await read(database, 'business_nodes', anchorNodeId)
    if (!node || !anchor || node.businessLineId !== businessLineId || anchor.businessLineId !== businessLineId ||
        node.status !== 'completed' || nodeId === anchorNodeId) throw failure('NOT_FOUND')
    if (line.flowSchemaVersion === 2) {
      const route = Array.isArray(line.traversedNodeIds) ? line.traversedNodeIds.slice() : []
      if (!route.includes(line.currentNodeId)) route.push(line.currentNodeId)
      if (node.routeState !== 'completed' || ['dormant', 'skipped'].includes(anchor.routeState) ||
          route.indexOf(nodeId) < 0 || route.indexOf(anchorNodeId) <= route.indexOf(nodeId)) throw failure('NOT_FOUND')
    } else if (!Number.isSafeInteger(node.sequence) || !Number.isSafeInteger(anchor.sequence) ||
        node.sequence >= anchor.sequence) throw failure('NOT_FOUND')
    return { line, node, anchor, role: authorized.actor.role }
  }
  async function scan(collection, criteria, maximum) {
    const rows = []
    while (rows.length <= maximum) {
      const size = Math.min(100, maximum + 1 - rows.length)
      let query = db.collection(collection).where(criteria)
      // Match the existing reviewRoundId/createdAt/_id index; no new index needed.
      if (collection === 'node_review_votes') query = query.orderBy('createdAt', 'asc')
      const page = (await query.orderBy('_id', 'asc').skip(rows.length).limit(size).get()).data
      if (!Array.isArray(page)) throw failure()
      rows.push(...page)
      if (page.length < size) break
    }
    if (rows.length > maximum) throw failure()
    return rows
  }
  async function getPreviousNodeResult(input) {
    const first = await db.runTransaction(tx => context(tx, input))
    const { node } = first
    const feedback = node.latestFeedbackId ? await read(db, 'node_feedback', node.latestFeedbackId) : null
    const round = node.lastReviewRoundId ? await read(db, 'node_review_rounds', node.lastReviewRoundId) : null
    const votes = round ? await scan('node_review_votes', { reviewRoundId: round._id }, Array.isArray(round.reviewerUserIds) ? round.reviewerUserIds.length : 0) : []
    if (!round && (!feedback || !Number.isSafeInteger(feedback.evidenceCount) || feedback.evidenceCount < 0)) throw failure()
    const directEvidence = !round ? await scan('evidences', { feedbackId: feedback._id }, feedback.evidenceCount) : []
    const evidenceIds = round ? round.evidenceIds : directEvidence.map(item => item._id)
    if (!Array.isArray(evidenceIds) || !evidenceIds.every(validId) ||
        new Set(evidenceIds).size !== evidenceIds.length || !round && feedback && evidenceIds.length !== feedback.evidenceCount) throw failure()
    let result
    try { result = buildFinalFieldResult({ line: first.line, node, feedback, round, votes }) } catch (_) { throw failure() }
    if (!result) throw failure()
    const projectedVotes = safeVotes(votes)
    const processingComment = storedComment(round || feedback, round ? 'processingComment' : 'comment')
    async function verifySource(tx) {
      const fresh = await context(tx, input)
      if (!same(first, fresh)) throw failure('VERSION_CONFLICT')
      const finalFeedback = feedback && await read(tx, 'node_feedback', feedback._id)
      const finalRound = round && await read(tx, 'node_review_rounds', round._id)
      if (!same(feedback, finalFeedback) || !same(round, finalRound)) throw failure('VERSION_CONFLICT')
      return fresh
    }
    // Immutable terminal sources allow bounded verification. Each transaction
    // rechecks authorization and the source; even 40 distinct owners stay <100
    // operations. File count remains governed by the existing byte policy.
    for (let offset = 0; offset < votes.length; offset += 40) {
      await db.runTransaction(async tx => {
        await verifySource(tx)
        for (const vote of votes.slice(offset, offset + 40)) {
          if (!same(vote, await read(tx, 'node_review_votes', vote._id))) throw failure('VERSION_CONFLICT')
        }
      })
    }
    const evidences = []
    for (let offset = 0; offset < evidenceIds.length; offset += 40) {
      const chunk = await db.runTransaction(async tx => {
        const fresh = await verifySource(tx)
        const owners = new Map([[feedback._id, feedback]])
        const projected = []
        for (const evidenceId of evidenceIds.slice(offset, offset + 40)) {
          const evidence = await read(tx, 'evidences', evidenceId)
          const retention = classifyEvidenceRetention(evidence, fresh.line)
          if (!evidence || !retention || evidence.businessLineId !== input.businessLineId || evidence.nodeId !== node._id ||
              evidence.attachmentState !== 'attached') throw failure()
          if (!owners.has(evidence.feedbackId)) owners.set(evidence.feedbackId, await read(tx, 'node_feedback', evidence.feedbackId))
          const owner = owners.get(evidence.feedbackId)
          if (!owner || owner.publishState !== 'published' || owner.businessLineId !== input.businessLineId ||
              owner.nodeId !== node._id || owner.processingRoundNumber !== node.processingRoundNumber ||
              owner.revision !== evidence.feedbackRevision || owner.revision > feedback.revision) throw failure()
          projected.push({ evidenceId, fileName: text(evidence.fileName), category: evidence.category,
            storageStatus: evidence.storageStatus, purgeDueAt: retention.effectivePurgeDueAt })
        }
        return projected
      })
      evidences.push(...chunk)
    }
    return db.runTransaction(async tx => {
      await verifySource(tx) // Last check occurs after every potentially slow read.
      const submitter = round ? round.submittedBy : feedback.submittedBy
      const names = Array.isArray(node.processorDisplayNames) && node.processorDisplayNames.length === node.processorUserIds.length
        ? node.processorDisplayNames : []
      const name = round ? round.submittedByDisplayName : names[node.processorUserIds.indexOf(submitter)]
      return {
        nodeId: node._id, nodeName: text(node.name), nodeCode: text(node.nodeCode),
        processingRoundNumber: node.processingRoundNumber, reviewRequired: Boolean(round),
        processorDisplayName: displayName(name), submittedAt: round ? round.reviewStartedAt : feedback.submittedAt,
        completedAt: result.completedAt, processingComment,
        fieldValues: result.fields.map(({ fieldKey, name, type, value }) => ({ fieldKey, name, type, value })),
        evidences, votes: projectedVotes
      }
    })
  }
  return { getPreviousNodeResult }
}
module.exports = { createPreviousNodeResultRepository }
