'use strict'

const crypto = require('node:crypto')

const ENTRY_COLLECTION = 'work_calendar_entries'
const YEAR_COLLECTION = 'work_calendar_years'
const PROCESSING_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const SYNC_LEASE_MS = 10 * 60 * 1000
const WRITE_BATCH_SIZE = 20

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
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

function expectedDates(year) {
  const dates = []
  for (let at = Date.UTC(year, 0, 1); new Date(at).getUTCFullYear() === year; at += 86400000) {
    dates.push(new Date(at).toISOString().slice(0, 10))
  }
  return dates
}

function validateCompleteYear(year, days) {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 9999 || !Array.isArray(days)) {
    throw new TypeError('complete year calendar is required')
  }
  const expected = expectedDates(year)
  if (days.length !== expected.length) throw new TypeError('complete year calendar is required')
  const byDate = new Map()
  for (const day of days) {
    if (!day || typeof day !== 'object' || typeof day.date !== 'string' ||
        typeof day.isWorkday !== 'boolean' || byDate.has(day.date)) {
      throw new TypeError('complete year calendar is required')
    }
    byDate.set(day.date, day)
  }
  return expected.map(date => {
    if (!byDate.has(date)) throw new TypeError('complete year calendar is required')
    return { date, isWorkday: byDate.get(date).isWorkday }
  })
}

function safeVersion(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function processingMinutes(node) {
  if (Number.isSafeInteger(node.processingRemainingWorkMinutes) && node.processingRemainingWorkMinutes >= 0) {
    return node.processingRemainingWorkMinutes
  }
  if (typeof node.processingSlaWorkHours !== 'number' || !Number.isFinite(node.processingSlaWorkHours) ||
      node.processingSlaWorkHours <= 0) return null
  const elapsed = Number.isFinite(node.processingElapsedWorkMinutes) && node.processingElapsedWorkMinutes >= 0
    ? node.processingElapsedWorkMinutes
    : 0
  const remaining = node.processingSlaWorkHours * 60 - elapsed
  return Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : null
}

function reviewMinutes(round) {
  if (Number.isSafeInteger(round.reviewRemainingWorkMinutes) && round.reviewRemainingWorkMinutes >= 0) {
    return round.reviewRemainingWorkMinutes
  }
  if (typeof round.reviewSlaWorkHours !== 'number' || !Number.isFinite(round.reviewSlaWorkHours) ||
      round.reviewSlaWorkHours <= 0) return null
  const elapsed = Number.isFinite(round.reviewElapsedWorkMinutes) && round.reviewElapsedWorkMinutes >= 0
    ? round.reviewElapsedWorkMinutes
    : 0
  const remaining = round.reviewSlaWorkHours * 60 - elapsed
  return Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : null
}

function createCloudCalendarRepository({
  db,
  clock = () => new Date(),
  tokenFactory = () => crypto.randomBytes(24).toString('hex')
} = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('db is required')
  }
  if (typeof clock !== 'function' || typeof tokenFactory !== 'function') {
    throw new TypeError('clock and tokenFactory are required')
  }

  async function replaceYear({ year, days, sourceVersion, syncedAt } = {}) {
    const normalized = validateCompleteYear(year, days)
    if (typeof sourceVersion !== 'string' || !sourceVersion || !validDate(syncedAt)) {
      throw new TypeError('sourceVersion and syncedAt are required')
    }
    const at = clock()
    if (!validDate(at)) throw new TypeError('clock must return a valid Date')
    const syncToken = tokenFactory()
    if (typeof syncToken !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(syncToken)) throw new TypeError('tokenFactory must return a safe string')
    const generationId = `${year}_${syncToken}`
    const yearId = String(year)
    const before = await readDocument(db, YEAR_COLLECTION, yearId)
    let sameVersionComplete = false
    if (before && before.year === year && before.sourceVersion === sourceVersion &&
        typeof before.generationId === 'string' && before.generationId && before.dayCount === normalized.length) {
      sameVersionComplete = true
      for (const day of normalized) {
        const record = await readDocument(db, ENTRY_COLLECTION, `${before.generationId}_${day.date}`)
        if (!record || record.date !== day.date || record.sourceYear !== year ||
            record.sourceVersion !== sourceVersion || record.generationId !== before.generationId ||
            typeof record.isWorkday !== 'boolean') {
          sameVersionComplete = false
          break
        }
      }
    }
    const claim = await db.runTransaction(async transaction => {
      const current = await readDocument(transaction, YEAR_COLLECTION, yearId)
      if (sameVersionComplete && current && current.generationId === before.generationId &&
          current.sourceVersion === sourceVersion) {
        return { changed: false, generationId: current.generationId }
      }
      if (current && typeof current.syncToken === 'string' && current.syncToken &&
          validDate(current.syncExpiresAt) && current.syncExpiresAt.getTime() > at.getTime()) {
        throw new Error('calendar sync conflict')
      }
      const claimData = {
        syncToken,
        pendingGenerationId: generationId,
        syncStartedAt: new Date(at),
        syncExpiresAt: new Date(at.getTime() + SYNC_LEASE_MS)
      }
      if (current) {
        await transaction.collection(YEAR_COLLECTION).doc(yearId).update({ data: claimData })
      } else {
        await transaction.collection(YEAR_COLLECTION).doc(yearId).set({ data: {
          year,
          generationId: null,
          sourceVersion: null,
          dayCount: 0,
          syncedAt: null,
          ...claimData
        } })
      }
      return { changed: true, generationId }
    })
    if (!claim.changed) return { changed: false, generationId: claim.generationId }
    try {
      for (let offset = 0; offset < normalized.length; offset += WRITE_BATCH_SIZE) {
        await Promise.all(normalized.slice(offset, offset + WRITE_BATCH_SIZE).map(day =>
          db.collection(ENTRY_COLLECTION).doc(`${generationId}_${day.date}`).set({ data: {
            date: day.date,
            isWorkday: day.isWorkday,
            source: 'ailcc',
            sourceYear: year,
            generationId,
            sourceVersion,
            syncedAt: new Date(syncedAt)
          } })))
      }
      await db.runTransaction(async transaction => {
        const latest = await readDocument(transaction, YEAR_COLLECTION, yearId)
        if (!latest || latest.syncToken !== syncToken || latest.pendingGenerationId !== generationId) throw new Error('calendar sync conflict')
        await transaction.collection(YEAR_COLLECTION).doc(yearId).set({ data: {
          year,
          generationId,
          sourceVersion,
          dayCount: normalized.length,
          syncedAt: new Date(syncedAt)
        } })
      })
    } catch (error) {
      try {
        await db.runTransaction(async transaction => {
          const latest = await readDocument(transaction, YEAR_COLLECTION, yearId)
          if (!latest || latest.syncToken !== syncToken) return
          await transaction.collection(YEAR_COLLECTION).doc(yearId).update({ data: {
            syncToken: db.command.remove(),
            syncStartedAt: db.command.remove(),
            syncExpiresAt: db.command.remove(),
            lastSyncFailedAt: new Date(at)
          } })
        })
      } catch (releaseError) {
        // The expiring lease keeps the old active generation safe if cleanup also fails.
      }
      throw error
    }
    return { changed: true, generationId }
  }

  async function getDayRule(dateKey) {
    if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null
    const year = Number(dateKey.slice(0, 4))
    const generation = await readDocument(db, YEAR_COLLECTION, String(year))
    if (!generation || generation.year !== year || typeof generation.sourceVersion !== 'string' ||
        !generation.sourceVersion || typeof generation.generationId !== 'string' || !generation.generationId) return null
    const record = await readDocument(db, ENTRY_COLLECTION, `${generation.generationId}_${dateKey}`)
    if (!record || record._id !== `${generation.generationId}_${dateKey}` || record.date !== dateKey || typeof record.isWorkday !== 'boolean') return null
    if (record.sourceYear !== year || record.sourceVersion !== generation.sourceVersion ||
        record.generationId !== generation.generationId) return null
    return {
      date: record.date,
      isWorkday: record.isWorkday,
      calendarVersion: typeof record.sourceVersion === 'string' ? record.sourceVersion : null
    }
  }

  async function listPendingDueCandidates({ limit } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40) throw new TypeError('limit must be from 1 to 40')
    const result = []
    const processing = await db.collection('business_nodes')
      .where({ processingDueStatus: 'pending_calendar' }).orderBy('_id', 'asc').limit(limit).get()
    for (const node of Array.isArray(processing && processing.data) ? processing.data : []) {
      const minutes = processingMinutes(node)
      if (result.length >= limit) break
      if (!PROCESSING_STATUSES.has(node.status) || !validDate(node.processingStartedAt) ||
          safeVersion(node.version) === null || minutes === null || typeof node.businessLineId !== 'string') continue
      result.push({
        kind: 'processing', id: node._id, businessLineId: node.businessLineId,
        status: node.status, version: node.version, startAt: node.processingStartedAt, minutes
      })
    }
    if (result.length >= limit) return result
    const reviews = await db.collection('node_review_rounds')
      .where({ reviewDueStatus: 'pending_calendar' }).orderBy('_id', 'asc').limit(limit - result.length).get()
    for (const round of Array.isArray(reviews && reviews.data) ? reviews.data : []) {
      if (result.length >= limit) break
      const minutes = reviewMinutes(round)
      const node = await readDocument(db, 'business_nodes', round.nodeId)
      if (round.status !== 'pending' || !validDate(round.reviewStartedAt) || safeVersion(round.version) === null ||
          minutes === null || typeof round.businessLineId !== 'string' || !node || node.status !== 'pending_review' ||
          node.activeReviewRoundId !== round._id || safeVersion(node.version) === null) continue
      result.push({
        kind: 'review', id: round._id, businessLineId: round.businessLineId,
        nodeId: round.nodeId, status: round.status, version: round.version, nodeVersion: node.version,
        startAt: round.reviewStartedAt, minutes
      })
    }
    return result
  }

  async function applyDueCalculation({ candidate, calculation, now } = {}) {
    if (!candidate || !calculation || calculation.status !== 'calculated' || !validDate(calculation.dueAt) ||
        (calculation.calendarVersion !== null &&
          (typeof calculation.calendarVersion !== 'string' || !calculation.calendarVersion)) || !validDate(now)) {
      throw new TypeError('valid calculated due result is required')
    }
    return db.runTransaction(async transaction => {
      const line = await readDocument(transaction, 'business_lines', candidate.businessLineId)
      if (!line || line.status !== 'active') return false
      if (candidate.kind === 'processing') {
        const node = await readDocument(transaction, 'business_nodes', candidate.id)
        if (!node || node.businessLineId !== line._id || line.currentNodeId !== node._id ||
            node.status !== candidate.status || node.version !== candidate.version ||
            !PROCESSING_STATUSES.has(node.status) || node.processingDueStatus !== 'pending_calendar' ||
            node.version === Number.MAX_SAFE_INTEGER) return false
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          processingDueStatus: 'calculated',
          processingDueAt: new Date(calculation.dueAt),
          processingCalendarVersion: calculation.calendarVersion,
          calendarNotificationStatus: 'resolved',
          calendarRecalculatedAt: new Date(now),
          version: node.version + 1,
          updatedAt: db.serverDate()
        } })
        return true
      }
      if (candidate.kind === 'review') {
        const node = await readDocument(transaction, 'business_nodes', candidate.nodeId)
        const round = await readDocument(transaction, 'node_review_rounds', candidate.id)
        if (!node || !round || node.businessLineId !== line._id || round.businessLineId !== line._id ||
            round.nodeId !== node._id || line.currentNodeId !== node._id || node.status !== 'pending_review' ||
            node.activeReviewRoundId !== round._id || node.version !== candidate.nodeVersion ||
            round.status !== candidate.status || round.status !== 'pending' || round.version !== candidate.version ||
            round.reviewDueStatus !== 'pending_calendar') return false
        if (round.version === Number.MAX_SAFE_INTEGER) return false
        await transaction.collection('node_review_rounds').doc(round._id).update({ data: {
          reviewDueStatus: 'calculated',
          reviewDueAt: new Date(calculation.dueAt),
          reviewCalendarVersion: calculation.calendarVersion,
          calendarNotificationStatus: 'resolved',
          calendarRecalculatedAt: new Date(now),
          version: round.version + 1,
          updatedAt: db.serverDate()
        } })
        return true
      }
      return false
    })
  }

  return { replaceYear, getDayRule, listPendingDueCandidates, applyDueCalculation }
}

module.exports = {
  ENTRY_COLLECTION,
  YEAR_COLLECTION,
  createCloudCalendarRepository
}
