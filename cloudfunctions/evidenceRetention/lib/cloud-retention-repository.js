'use strict'

const { fitsIndexedAccountArray } = require('./index-key-budget')

const FROZEN_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const RETENTION_SCOPE = 'business_line'
const RETENTION_SOURCE = 'node_feedback'
const AMENDMENT_SCOPE = 'evidence'
const AMENDMENT_SOURCE = 'audit_amendment'
const PURGE_LEASE_MS = 10 * 60 * 1000
const RECOVERY_CHUNK_SIZE = 40
const MAX_SCAN_SIZE = 40
const CURSOR_PREFIX = 'evidence-retention:'
const CURSOR_ID = /^[A-Za-z0-9:_-]{1,128}$/
const SORT_TYPES = new Set(['date', 'string'])

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

function shanghaiDaySerial(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value)
  const part = type => Number(parts.find(item => item.type === type).value)
  return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / 86400000)
}

function shanghaiDayRange(value, daysAhead) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value)
  const part = type => Number(parts.find(item => item.type === type).value)
  const start = new Date(Date.UTC(part('year'), part('month') - 1, part('day') + daysAhead) - 8 * 60 * 60 * 1000)
  return [start, new Date(start.getTime() + 24 * 60 * 60 * 1000)]
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

  function requireScanLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCAN_SIZE) {
      throw new TypeError(`limit must be between 1 and ${MAX_SCAN_SIZE}`)
    }
    return limit
  }

  function serializeSortValue(value, type) {
    if (type === 'date' && validDate(value)) return value.toISOString()
    if (type === 'string' && typeof value === 'string' && value) return value
    throw new Error('retention row sort value invalid')
  }

  function deserializeSortValue(value, type) {
    if (type === 'date' && typeof value === 'string') {
      const parsed = new Date(value)
      if (validDate(parsed) && parsed.toISOString() === value) return parsed
    }
    if (type === 'string' && typeof value === 'string' && value) return value
    throw new Error('retention cursor sort value invalid')
  }

  function phaseByKey(phases, key) {
    return phases.find(phase => phase.key === key)
  }

  async function readCursor(name, phases) {
    const cursor = await readDocument(db, 'system_settings', `${CURSOR_PREFIX}${name}`)
    if (!cursor) return { phase: phases[0].key, afterSortValue: null, afterId: '' }
    const phase = phaseByKey(phases, cursor.phase)
    const empty = cursor.afterSortValue === null && cursor.afterId === ''
    const positioned = typeof cursor.afterSortValue === 'string' &&
      typeof cursor.afterId === 'string' && CURSOR_ID.test(cursor.afterId)
    if (!phase || (!empty && !positioned)) {
      throw new Error(`retention cursor invalid: ${name}`)
    }
    if (positioned) deserializeSortValue(cursor.afterSortValue, phase.sortType)
    return { phase: cursor.phase, afterSortValue: cursor.afterSortValue, afterId: cursor.afterId }
  }

  async function advanceCursor(name, phases, current, rawPage, limit) {
    const full = rawPage.length === limit
    const phaseIndex = phases.findIndex(phase => phase.key === current.phase)
    const phase = phases[phaseIndex]
    const next = full
      ? {
          phase: current.phase,
          afterSortValue: serializeSortValue(rawPage[rawPage.length - 1][phase.sortField], phase.sortType),
          afterId: rawPage[rawPage.length - 1]._id
        }
      : { phase: phases[(phaseIndex + 1) % phases.length].key, afterSortValue: null, afterId: '' }
    await db.runTransaction(async transaction => {
      const stored = await readDocument(transaction, 'system_settings', `${CURSOR_PREFIX}${name}`)
      const actual = stored
        ? { phase: stored.phase, afterSortValue: stored.afterSortValue, afterId: stored.afterId }
        : { phase: phases[0].key, afterSortValue: null, afterId: '' }
      if (actual.phase !== current.phase || actual.afterSortValue !== current.afterSortValue ||
          actual.afterId !== current.afterId) {
        throw new Error(`retention cursor conflict: ${name}`)
      }
      await transaction.collection('system_settings').doc(`${CURSOR_PREFIX}${name}`).set({ data: {
        phase: next.phase, afterSortValue: next.afterSortValue, afterId: next.afterId, updatedAt: db.serverDate()
      } })
    })
    return next
  }

  function queryRows({ collection, criteria, sortField, limit }) {
    return db.collection(collection).where(criteria)
      .orderBy(sortField, 'asc').orderBy('_id', 'asc').limit(limit).get()
  }

  async function readKeysetPage({ definition, cursor, limit }) {
    const { __collection: collection, __sortField: sortField, __sortType: sortType,
      __constantSort: constantSort, ...criteria } = definition
    if (typeof collection !== 'string' || typeof sortField !== 'string' || !SORT_TYPES.has(sortType)) {
      throw new TypeError('retention phase query definition invalid')
    }
    if (!cursor.afterId) {
      const response = await queryRows({ collection, criteria, sortField, limit })
      return Array.isArray(response && response.data) ? response.data : []
    }
    const afterSortValue = deserializeSortValue(cursor.afterSortValue, sortType)
    if (constantSort) {
      const response = await queryRows({
        collection, criteria: { ...criteria, _id: db.command.gt(cursor.afterId) }, sortField, limit
      })
      return Array.isArray(response && response.data) ? response.data : []
    }
    const sameResponse = await queryRows({
      collection,
      criteria: { ...criteria, [sortField]: db.command.eq(afterSortValue), _id: db.command.gt(cursor.afterId) },
      sortField,
      limit
    })
    const sameRows = Array.isArray(sameResponse && sameResponse.data) ? sameResponse.data : []
    if (sameRows.length === limit) return sameRows
    const lowerBound = db.command.gt(afterSortValue)
    const existingBound = criteria[sortField]
    const laterResponse = await queryRows({
      collection,
      criteria: {
        ...criteria,
        [sortField]: existingBound === undefined ? lowerBound : db.command.and(lowerBound, existingBound)
      },
      sortField,
      limit: limit - sameRows.length
    })
    const laterRows = Array.isArray(laterResponse && laterResponse.data) ? laterResponse.data : []
    return [...sameRows, ...laterRows]
  }

  async function scanOnePage({ name, phases, limit, query, project }) {
    requireScanLimit(limit)
    const projected = []
    let scanned = 0
    let cursor = await readCursor(name, phases)
    const visited = new Set()
    while (scanned < limit && !visited.has(cursor.phase)) {
      visited.add(cursor.phase)
      const remaining = limit - scanned
      const phaseDefinition = phaseByKey(phases, cursor.phase)
      const definition = { ...query(phaseDefinition.key) }
      const rawPage = await readKeysetPage({ definition, cursor, limit: remaining })
      scanned += rawPage.length
      const phase = phaseDefinition.key
      cursor = await advanceCursor(name, phases, cursor, rawPage, remaining)
      for (const row of rawPage) {
        const value = await project(row, phase)
        if (value !== null && value !== undefined) projected.push(value)
      }
      if (rawPage.length === remaining) break
    }
    return projected.sort((left, right) => {
      const leftId = typeof left === 'string' ? left : left.evidenceId || left._id
      const rightId = typeof right === 'string' ? right : right.evidenceId || right._id
      return leftId.localeCompare(rightId)
    })
  }

  async function createDueReminders({ now, limit }) {
    if (!validDate(now)) throw new TypeError('now must be a valid Date')
    requireScanLimit(limit)
    const today = shanghaiDaySerial(now)
    const phases = [...FROZEN_STATUSES].flatMap(status => [15, 7, 1].map(days => ({
      key: `${status}:${days}`, sortField: 'purgeDueAt', sortType: 'date'
    })))
    const page = await scanOnePage({
      name: 'reminders', phases, limit,
      query(phase) {
        const [status, daysText] = phase.split(':')
        const [start, end] = shanghaiDayRange(now, Number(daysText))
        return {
          __collection: 'business_lines', status,
          __sortField: 'purgeDueAt', __sortType: 'date',
          purgeDueAt: db.command.and(db.command.gte(start), db.command.lt(end))
        }
      },
      project: line => line
    })
    let created = 0
    for (const candidateLine of page) {
      if (!FROZEN_STATUSES.has(candidateLine.status) || !validDate(candidateLine.purgeDueAt)) continue
      const days = shanghaiDaySerial(candidateLine.purgeDueAt) - today
      if (![15, 7, 1].includes(days)) continue
        const notificationId = `evidence-retention:${candidateLine._id}:${days}`
        const didCreate = await db.runTransaction(async transaction => {
          const line = await readDocument(transaction, 'business_lines', candidateLine._id)
          if (!line || !FROZEN_STATUSES.has(line.status) || !validDate(line.purgeDueAt) ||
              shanghaiDaySerial(line.purgeDueAt) - shanghaiDaySerial(now) !== days) return false
          const accountSchema = Object.prototype.hasOwnProperty.call(line, 'managerUserIds') ||
            Object.prototype.hasOwnProperty.call(line, 'memberUserIds')
          const directRecipients = accountSchema && Array.isArray(line.managerUserIds)
            ? [...new Set(line.managerUserIds)] : null
          const hasAccountRecipients = fitsIndexedAccountArray(directRecipients) && directRecipients.length > 0
          if (accountSchema && !hasAccountRecipients) return false
          const existing = await readDocument(transaction, 'notifications', notificationId)
          if (existing) {
            const brokenLegacyAudience = !hasAccountRecipients && existing.type === 'evidence_retention' &&
              existing.businessLineId === line._id && existing.daysRemaining === days &&
              Array.isArray(existing.recipientUserIds) && existing.recipientUserIds.length === 0 &&
              existing.audienceRole === undefined
            if (!brokenLegacyAudience) return false
            await transaction.collection('notifications').doc(notificationId).update({ data: {
              recipientUserIds: db.command.remove(),
              audienceRole: 'super_admin',
              updatedAt: db.serverDate()
            } })
            return true
          }
          await transaction.collection('notifications').doc(notificationId).set({ data: {
            type: 'evidence_retention', businessLineId: line._id,
            ...(hasAccountRecipients
              ? { recipientUserIds: directRecipients }
              : { audienceRole: 'super_admin' }),
            daysRemaining: days, status: 'pending', createdAt: db.serverDate()
          } })
          return true
        })
      if (didCreate) created += 1
    }
    return created
  }

  async function listDueEvidence({ now, limit }) {
    const phaseKeys = [
      'business_line:available', 'business_line:purge_failed', 'business_line:purge_pending',
      'evidence:available', 'evidence:purge_failed', 'evidence:purge_pending'
    ]
    const phases = phaseKeys.map(key => {
      const [scope, storageStatus] = key.split(':')
      const dueField = storageStatus === 'purge_pending'
        ? 'purgeClaimExpiresAt'
        : scope === 'evidence' ? 'purgeDueAt' : 'storageStatus'
      return { key, sortField: dueField, sortType: dueField === 'storageStatus' ? 'string' : 'date' }
    })
    return scanOnePage({
      name: 'due-evidence', phases, limit,
      query(phase) {
        const [scope, storageStatus] = phase.split(':')
        return {
          __collection: 'evidences', retentionScope: scope, storageStatus,
          __sortField: storageStatus === 'purge_pending'
            ? 'purgeClaimExpiresAt' : scope === 'evidence' ? 'purgeDueAt' : 'storageStatus',
          __sortType: storageStatus === 'purge_pending' || scope === 'evidence' ? 'date' : 'string',
          ...((storageStatus === 'purge_pending')
            ? { purgeClaimExpiresAt: db.command.lte(now) }
            : scope === 'evidence' ? { purgeDueAt: db.command.lte(now) } : { __constantSort: true })
        }
      },
      async project(evidence, phase) {
        if (!purgeCandidateStatus(evidence, now)) return null
        if (phase.startsWith('business_line:') && evidence.retentionSource === RETENTION_SOURCE && evidence.feedbackId) {
          const line = await readDocument(db, 'business_lines', evidence.businessLineId)
          if (line && FROZEN_STATUSES.has(line.status) && due(line.purgeDueAt, now)) return { evidenceId: evidence._id }
        } else if (phase.startsWith('evidence:') && evidence.retentionSource === AMENDMENT_SOURCE &&
                   evidence.amendmentId && due(evidence.purgeDueAt, now)) {
          const audit = await readDocument(db, 'audit_logs', evidence.amendmentId)
          if (audit && audit.action === 'AMEND_FROZEN_BUSINESS' && audit.publishState === 'published' &&
              audit.targetId === evidence.businessLineId) return { evidenceId: evidence._id }
        }
        return null
      }
    })
  }

  async function listExpiredOrphans({ now, limit }) {
    const phases = ['available', 'purge_failed', 'purge_pending'].map(storageStatus => ({
      key: storageStatus,
      sortField: storageStatus === 'purge_pending' ? 'purgeClaimExpiresAt' : 'orphanExpiresAt',
      sortType: 'date'
    }))
    return scanOnePage({
      name: 'orphans', phases, limit,
      query(storageStatus) {
        return {
          __collection: 'evidences', storageStatus,
          __sortField: storageStatus === 'purge_pending' ? 'purgeClaimExpiresAt' : 'orphanExpiresAt',
          __sortType: 'date',
          ...(storageStatus === 'purge_pending'
            ? { purgeClaimExpiresAt: db.command.lte(now) }
            : { orphanExpiresAt: db.command.lte(now) })
        }
      },
      project(evidence) {
        return purgeCandidateStatus(evidence, now) && due(evidence.orphanExpiresAt, now) &&
          !evidence.feedbackId && !evidence.amendmentId &&
          [undefined, null, 'unattached'].includes(evidence.attachmentState)
          ? { evidenceId: evidence._id }
          : null
      }
    })
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

  async function listExpiredFeedbackReservations({ now, limit }) {
    const phases = [
      { key: 'aborting', sortField: 'publishState', sortType: 'string' },
      { key: 'reserved', sortField: 'claimExpiresAt', sortType: 'date' },
      { key: 'missing', sortField: 'feedbackClaimExpiresAt', sortType: 'date' }
    ]
    return scanOnePage({
      name: 'feedback-reservations', phases, limit,
      query(phase) {
        if (phase === 'missing') return {
          __collection: 'business_nodes', __sortField: 'feedbackClaimExpiresAt', __sortType: 'date',
          feedbackClaimExpiresAt: db.command.lte(now)
        }
        return {
          __collection: 'node_feedback', publishState: phase,
          __sortField: phase === 'reserved' ? 'claimExpiresAt' : 'publishState',
          __sortType: phase === 'reserved' ? 'date' : 'string',
          ...(phase === 'aborting' ? { __constantSort: true } : {}),
          ...(phase === 'reserved' ? { claimExpiresAt: db.command.lte(now) } : {})
        }
      },
      async project(item, phase) {
        if (phase !== 'missing') {
          if (typeof item.businessLineId !== 'string' || !CURSOR_ID.test(item.businessLineId) ||
              typeof item.nodeId !== 'string' || !CURSOR_ID.test(item.nodeId)) return null
          return item.publishState === 'aborting' ||
            item.publishState === 'reserved' && due(item.claimExpiresAt, now) ? item._id : null
        }
        if (typeof item.feedbackClaimId !== 'string' || !item.feedbackClaimId ||
            !due(item.feedbackClaimExpiresAt, now) ||
            await readDocument(db, 'node_feedback', item.feedbackClaimId)) return null
        return item.feedbackClaimId
      }
    })
  }

  async function recoverExpiredFeedbackReservation({ id, now }) {
    const initial = await readDocument(db, 'node_feedback', id)
    if (!initial) {
      const result = await db.collection('business_nodes').where({ feedbackClaimId: id })
        .orderBy('_id', 'asc').limit(RECOVERY_CHUNK_SIZE).get()
      const nodes = (result.data || []).filter(node => due(node.feedbackClaimExpiresAt, now))
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

  async function listExpiredAmendmentReservations({ now, limit }) {
    const phases = [
      { key: 'aborting', sortField: 'publishState', sortType: 'string' },
      { key: 'reserved', sortField: 'claimExpiresAt', sortType: 'date' }
    ]
    return scanOnePage({
      name: 'amendment-reservations', phases, limit,
      query(publishState) {
        return {
          __collection: 'audit_logs', action: 'AMEND_FROZEN_BUSINESS', publishState,
          __sortField: publishState === 'reserved' ? 'claimExpiresAt' : 'publishState',
          __sortType: publishState === 'reserved' ? 'date' : 'string',
          ...(publishState === 'aborting' ? { __constantSort: true } : {}),
          ...(publishState === 'reserved' ? { claimExpiresAt: db.command.lte(now) } : {})
        }
      },
      project(item) {
        if (typeof item.targetId !== 'string' || !CURSOR_ID.test(item.targetId)) return null
        return item.publishState === 'aborting' ||
          item.publishState === 'reserved' && due(item.claimExpiresAt, now) ? item._id : null
      }
    })
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
