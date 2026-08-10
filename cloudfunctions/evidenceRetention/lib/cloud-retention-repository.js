'use strict'

const FROZEN_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const RETENTION_SCOPE = 'business_line'
const RETENTION_SOURCE = 'node_feedback'
const AMENDMENT_SCOPE = 'evidence'
const AMENDMENT_SOURCE = 'audit_amendment'
const PURGE_LEASE_MS = 10 * 60 * 1000
const RECOVERY_CHUNK_SIZE = 40

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function due(value, now) {
  return validDate(value) && value.getTime() <= now.getTime()
}

function expiredOrMalformed(value, now) {
  return !validDate(value) || value.getTime() <= now.getTime()
}

function missingDocument(error) {
  return /document(?:\.get)?:fail.*(?:does not exist|not found)|document with _id .* does not exist/i
    .test(String(error && (error.errMsg || error.message || error)))
}

async function readDocument(source, collection, id) {
  if (typeof id !== 'string' || !id) return null
  try {
    const result = await source.collection(collection).doc(id).get()
    return result && result.data ? result.data : null
  } catch (error) {
    if (missingDocument(error)) return null
    throw error
  }
}

async function readAll(db, collection) {
  const rows = []
  for (let offset = 0;; offset += 100) {
    const result = await db.collection(collection).orderBy('_id', 'asc').skip(offset).limit(100).get()
    const page = Array.isArray(result && result.data) ? result.data : []
    rows.push(...page)
    if (page.length < 100) return rows
  }
}

async function readPage(db, collection, offset, maximum = 100) {
  const result = await db.collection(collection).orderBy('_id', 'asc').skip(offset).limit(maximum).get()
  return Array.isArray(result && result.data) ? result.data : []
}

function shanghaiDaySerial(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value)
  const part = type => Number(parts.find(item => item.type === type).value)
  return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / 86400000)
}

function pageCandidates(values, afterId, limit) {
  return values
    .filter(value => value.evidenceId > afterId)
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, limit)
}

function purgeCandidateStatus(evidence, now) {
  return ['available', 'purge_failed'].includes(evidence.storageStatus) ||
    (evidence.storageStatus === 'purge_pending' && due(evidence.purgeClaimExpiresAt, now))
}

function createCloudRetentionRepository({ db, clock = () => new Date(), tokenFactory } = {}) {
  if (!db || typeof db.runTransaction !== 'function') throw new TypeError('db is required')
  if (typeof clock !== 'function') throw new TypeError('clock is required')
  if (typeof tokenFactory !== 'function') throw new TypeError('tokenFactory is required')

  async function createDueReminders({ now, limit }) {
    if (!validDate(now)) throw new TypeError('now must be a valid Date')
    const today = shanghaiDaySerial(now)
    let created = 0
    for (let offset = 0; created < limit; offset += 100) {
      const page = await readPage(db, 'business_lines', offset)
      for (const candidateLine of page) {
        if (!FROZEN_STATUSES.has(candidateLine.status) || !validDate(candidateLine.purgeDueAt)) continue
        const days = shanghaiDaySerial(candidateLine.purgeDueAt) - today
        if (![15, 7, 1].includes(days)) continue
        const notificationId = `evidence-retention:${candidateLine._id}:${days}`
        const didCreate = await db.runTransaction(async transaction => {
          if (await readDocument(transaction, 'notifications', notificationId)) return false
          const line = await readDocument(transaction, 'business_lines', candidateLine._id)
          if (!line || !FROZEN_STATUSES.has(line.status) || !validDate(line.purgeDueAt) ||
              shanghaiDaySerial(line.purgeDueAt) - shanghaiDaySerial(now) !== days) return false
          const recipientUserIds = Array.isArray(line.managerUserIds)
            ? [...new Set(line.managerUserIds.filter(value => typeof value === 'string' && value))]
            : []
          await transaction.collection('notifications').doc(notificationId).set({ data: {
            type: 'evidence_retention', businessLineId: line._id, recipientUserIds,
            daysRemaining: days, status: 'pending', createdAt: db.serverDate()
          } })
          return true
        })
        if (didCreate) created += 1
        if (created >= limit) break
      }
      if (page.length < 100) break
    }
    return created
  }

  async function listDueEvidence({ now, afterId = '', limit }) {
    const candidates = []
    for (let offset = 0; candidates.length < limit; offset += 100) {
      const page = await readPage(db, 'evidences', offset)
      for (const evidence of page) {
        if (evidence._id <= afterId || !purgeCandidateStatus(evidence, now)) continue
        if (evidence.retentionScope === RETENTION_SCOPE && evidence.retentionSource === RETENTION_SOURCE && evidence.feedbackId) {
          const line = await readDocument(db, 'business_lines', evidence.businessLineId)
          if (line && FROZEN_STATUSES.has(line.status) && due(line.purgeDueAt, now)) candidates.push({ evidenceId: evidence._id })
        } else if (evidence.retentionScope === AMENDMENT_SCOPE && evidence.retentionSource === AMENDMENT_SOURCE &&
                   evidence.amendmentId && due(evidence.purgeDueAt, now)) {
          const audit = await readDocument(db, 'audit_logs', evidence.amendmentId)
          if (audit && audit.action === 'AMEND_FROZEN_BUSINESS' && audit.publishState === 'published' &&
              audit.targetId === evidence.businessLineId) candidates.push({ evidenceId: evidence._id })
        }
        if (candidates.length >= limit) break
      }
      if (page.length < 100) break
    }
    return candidates
  }

  async function listExpiredOrphans({ now, afterId = '', limit }) {
    const candidates = []
    for (let offset = 0; candidates.length < limit; offset += 100) {
      const page = await readPage(db, 'evidences', offset)
      for (const evidence of page) {
        if (evidence._id > afterId && purgeCandidateStatus(evidence, now) && due(evidence.orphanExpiresAt, now) &&
            !evidence.feedbackId && !evidence.amendmentId &&
            [undefined, null, 'unattached'].includes(evidence.attachmentState)) {
          candidates.push({ evidenceId: evidence._id })
        }
        if (candidates.length >= limit) break
      }
      if (page.length < 100) break
    }
    return candidates
  }

  async function retentionEligible(transaction, evidence, now) {
    if (evidence.retentionScope === RETENTION_SCOPE && evidence.retentionSource === RETENTION_SOURCE && evidence.feedbackId) {
      const line = await readDocument(transaction, 'business_lines', evidence.businessLineId)
      return Boolean(line && FROZEN_STATUSES.has(line.status) && due(line.purgeDueAt, now))
    }
    if (evidence.retentionScope === AMENDMENT_SCOPE && evidence.retentionSource === AMENDMENT_SOURCE &&
        evidence.amendmentId && due(evidence.purgeDueAt, now)) {
      const audit = await readDocument(transaction, 'audit_logs', evidence.amendmentId)
      return Boolean(audit && audit.action === 'AMEND_FROZEN_BUSINESS' && audit.publishState === 'published' &&
        audit.targetId === evidence.businessLineId)
    }
    return false
  }

  async function claimEvidenceForPurge({ evidenceId, mode, now }) {
    return db.runTransaction(async transaction => {
      const evidence = await readDocument(transaction, 'evidences', evidenceId)
      if (!evidence || typeof evidence.fileId !== 'string' || !evidence.fileId) return null
      const reclaimable = ['available', 'purge_failed'].includes(evidence.storageStatus) ||
        (evidence.storageStatus === 'purge_pending' && due(evidence.purgeClaimExpiresAt, now))
      if (!reclaimable) return null
      const eligible = mode === 'orphan'
        ? due(evidence.orphanExpiresAt, now) && !evidence.feedbackId && !evidence.amendmentId &&
          [undefined, null, 'unattached'].includes(evidence.attachmentState)
        : mode === 'retention' && await retentionEligible(transaction, evidence, now)
      if (!eligible) return null
      const claimToken = tokenFactory()
      if (typeof claimToken !== 'string' || !claimToken) throw new TypeError('tokenFactory must return a string')
      await transaction.collection('evidences').doc(evidenceId).update({ data: {
        storageStatus: 'purge_pending',
        purgeClaimToken: claimToken,
        purgeClaimExpiresAt: new Date(now.getTime() + PURGE_LEASE_MS),
        updatedAt: db.serverDate()
      } })
      return { evidenceId, fileId: evidence.fileId, claimToken }
    })
  }

  async function markEvidencePurged({ evidenceId, now, claimToken, objectWasAbsent }) {
    return db.runTransaction(async transaction => {
      const evidence = await readDocument(transaction, 'evidences', evidenceId)
      if (!evidence || evidence.storageStatus !== 'purge_pending' || evidence.purgeClaimToken !== claimToken) return false
      await transaction.collection('evidences').doc(evidenceId).update({ data: {
        storageStatus: 'purged',
        fileId: db.command.remove(),
        purgeClaimToken: db.command.remove(),
        purgeClaimExpiresAt: db.command.remove(),
        purgedAt: now,
        purgedObjectWasAbsent: Boolean(objectWasAbsent),
        updatedAt: db.serverDate()
      } })
      return true
    })
  }

  async function markEvidencePurgeFailed({ evidenceId, now, claimToken, errorCategory }) {
    return db.runTransaction(async transaction => {
      const evidence = await readDocument(transaction, 'evidences', evidenceId)
      if (!evidence || evidence.storageStatus !== 'purge_pending' || evidence.purgeClaimToken !== claimToken) return false
      const previous = Number.isSafeInteger(evidence.purgeFailureCount) && evidence.purgeFailureCount >= 0
        ? evidence.purgeFailureCount : 0
      await transaction.collection('evidences').doc(evidenceId).update({ data: {
        storageStatus: 'purge_failed',
        purgeFailureCount: previous + 1,
        lastPurgeErrorCategory: errorCategory,
        lastPurgeFailedAt: now,
        purgeClaimToken: db.command.remove(),
        purgeClaimExpiresAt: db.command.remove(),
        updatedAt: db.serverDate()
      } })
      return true
    })
  }

  async function listExpiredFeedbackReservations({ now, afterId = '', limit }) {
    const [feedback, nodes] = await Promise.all([
      readAll(db, 'node_feedback'), readAll(db, 'business_nodes')
    ])
    const byId = new Map(feedback.map(item => [item._id, item]))
    const ids = new Set(feedback
      .filter(item => item.publishState === 'aborting' ||
        (item.publishState === 'reserved' && expiredOrMalformed(item.claimExpiresAt, now)))
      .map(item => item._id))
    for (const node of nodes) {
      if (typeof node.feedbackClaimId === 'string' && node.feedbackClaimId &&
          !byId.has(node.feedbackClaimId) && expiredOrMalformed(node.feedbackClaimExpiresAt, now)) {
        ids.add(node.feedbackClaimId)
      }
    }
    return [...ids].filter(id => id > afterId).sort().slice(0, limit)
  }

  async function recoverExpiredFeedbackReservation({ id, now }) {
    const initial = await readDocument(db, 'node_feedback', id)
    if (!initial) {
      const nodes = (await readAll(db, 'business_nodes'))
        .filter(node => node.feedbackClaimId === id && expiredOrMalformed(node.feedbackClaimExpiresAt, now))
      let cleared = false
      for (const candidate of nodes) {
        const changed = await db.runTransaction(async transaction => {
          if (await readDocument(transaction, 'node_feedback', id)) return false
          const node = await readDocument(transaction, 'business_nodes', candidate._id)
          if (!node || node.feedbackClaimId !== id || !expiredOrMalformed(node.feedbackClaimExpiresAt, now)) return false
          await transaction.collection('business_nodes').doc(node._id).update({ data: {
            feedbackClaimId: db.command.remove(),
            feedbackClaimHash: db.command.remove(),
            feedbackClaimExpiresAt: db.command.remove()
          } })
          return true
        })
        cleared = cleared || changed
      }
      return cleared
    }
    const started = await db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, 'node_feedback', id)
      if (!reservation || ['published', 'aborted'].includes(reservation.publishState)) return false
      if (reservation.publishState !== 'aborting' &&
          (reservation.publishState !== 'reserved' || !expiredOrMalformed(reservation.claimExpiresAt, now))) return false
      const node = await readDocument(transaction, 'business_nodes', reservation.nodeId)
      if (node && node.businessLineId === reservation.businessLineId && node.feedbackClaimId === id) {
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          feedbackClaimId: db.command.remove(),
          feedbackClaimHash: db.command.remove(),
          feedbackClaimExpiresAt: db.command.remove()
        } })
      }
      if (reservation.publishState !== 'aborting') {
        await transaction.collection('node_feedback').doc(id).update({ data: {
          publishState: 'aborting', recoveryReason: 'CLAIM_EXPIRED', recoveryStartedAt: now, updatedAt: db.serverDate()
        } })
      }
      return true
    })
    if (!started) return false
    for (;;) {
      const result = await db.collection('evidences').where({ feedbackId: id })
        .orderBy('_id', 'asc').limit(RECOVERY_CHUNK_SIZE).get()
      const chunk = Array.isArray(result && result.data) ? result.data : []
      if (!chunk.length) break
      await db.runTransaction(async transaction => {
        const reservation = await readDocument(transaction, 'node_feedback', id)
        if (!reservation || reservation.publishState !== 'aborting') return
        for (const candidate of chunk) {
          const evidence = await readDocument(transaction, 'evidences', candidate._id)
          if (!evidence || evidence.feedbackId !== id) continue
          await transaction.collection('evidences').doc(evidence._id).update({ data: {
            feedbackId: null,
            feedbackRevision: null,
            attachmentState: db.command.remove(),
            attachmentClaimExpiresAt: db.command.remove(),
            orphanExpiresAt: evidence.attachmentPreviousOrphanExpiresAt,
            attachmentPreviousOrphanExpiresAt: db.command.remove(),
            retentionScope: null,
            retentionSource: null
          } })
        }
      })
    }
    return db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, 'node_feedback', id)
      if (!reservation) return false
      if (reservation.publishState === 'aborted') return true
      if (reservation.publishState !== 'aborting') return false
      await transaction.collection('node_feedback').doc(id).update({ data: {
        publishState: 'aborted', abortedAt: now, claimExpiresAt: db.command.remove(), updatedAt: db.serverDate()
      } })
      return true
    })
  }

  async function listExpiredAmendmentReservations({ now, afterId = '', limit }) {
    const audits = await readAll(db, 'audit_logs')
    return audits.filter(item => item.action === 'AMEND_FROZEN_BUSINESS' &&
      (item.publishState === 'aborting' ||
       (item.publishState === 'reserved' && expiredOrMalformed(item.claimExpiresAt, now))) && item._id > afterId)
      .map(item => item._id).sort().slice(0, limit)
  }

  async function recoverExpiredAmendmentReservation({ id, now }) {
    const started = await db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, 'audit_logs', id)
      if (!reservation || reservation.action !== 'AMEND_FROZEN_BUSINESS' ||
          ['published', 'aborted'].includes(reservation.publishState)) return false
      if (reservation.publishState !== 'aborting' &&
          (reservation.publishState !== 'reserved' || !expiredOrMalformed(reservation.claimExpiresAt, now))) return false
      if (reservation.publishState !== 'aborting') {
        await transaction.collection('audit_logs').doc(id).update({ data: {
          publishState: 'aborting', recoveryReason: 'CLAIM_EXPIRED', recoveryStartedAt: now, updatedAt: db.serverDate()
        } })
      }
      return true
    })
    if (!started) return false
    for (;;) {
      const result = await db.collection('evidences').where({ amendmentId: id })
        .orderBy('_id', 'asc').limit(RECOVERY_CHUNK_SIZE).get()
      const chunk = Array.isArray(result && result.data) ? result.data : []
      if (!chunk.length) break
      await db.runTransaction(async transaction => {
        const reservation = await readDocument(transaction, 'audit_logs', id)
        if (!reservation || reservation.publishState !== 'aborting') return
        for (const candidate of chunk) {
          const evidence = await readDocument(transaction, 'evidences', candidate._id)
          if (!evidence || evidence.amendmentId !== id) continue
          await transaction.collection('evidences').doc(evidence._id).update({ data: {
            amendmentId: null,
            attachmentState: db.command.remove(),
            orphanExpiresAt: evidence.amendmentRollbackOrphanExpiresAt,
            amendmentRollbackOrphanExpiresAt: db.command.remove(),
            retentionStartedAt: null,
            purgeDueAt: null,
            retentionScope: null,
            retentionSource: null
          } })
        }
      })
    }
    return db.runTransaction(async transaction => {
      const reservation = await readDocument(transaction, 'audit_logs', id)
      if (!reservation) return false
      if (reservation.publishState === 'aborted') return true
      if (reservation.publishState !== 'aborting') return false
      await transaction.collection('audit_logs').doc(id).update({ data: {
        publishState: 'aborted', abortedAt: now, claimExpiresAt: db.command.remove(), updatedAt: db.serverDate()
      } })
      return true
    })
  }

  return {
    createDueReminders,
    listDueEvidence,
    listExpiredOrphans,
    claimEvidenceForPurge,
    markEvidencePurged,
    markEvidencePurgeFailed,
    listExpiredFeedbackReservations,
    recoverExpiredFeedbackReservation,
    listExpiredAmendmentReservations,
    recoverExpiredAmendmentReservation
  }
}

module.exports = { createCloudRetentionRepository }
