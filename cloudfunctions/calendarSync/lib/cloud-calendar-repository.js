'use strict'

const crypto = require('node:crypto')

const ENTRY_COLLECTION = 'work_calendar_entries'
const YEAR_COLLECTION = 'work_calendar_years'
const PROCESSING_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const SYNC_LEASE_MS = 10 * 60 * 1000
const WRITE_BATCH_SIZE = 20
const REVIEW_PROCESSING_CURSOR_ID = 'calendar-review-processing-cursor'
const REVIEW_CARRYOVER_CURSOR_ID = 'calendar-review-carryover-cursor'
const REVIEW_TIMING_CARRYOVER_CURSOR_ID = 'calendar-review-timing-carryover-cursor'
const REVIEW_RESPONSE_CURSOR_ID = 'calendar-review-vote-response-cursor'
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function processingAttributionHash(round, overrides = {}) {
  const submittedBy = round && round.submittedBy
  const displayName = round && round.submittedByDisplayName
  const mode = round && round.processorAssignmentMode
  const status = overrides.status === undefined ? round && round.processingRoundTimingStatus : overrides.status
  const minutes = overrides.minutes === undefined ? round && round.processingRoundWorkMinutes : overrides.minutes
  const calendarVersion = overrides.calendarVersion === undefined
    ? round && round.processingRoundCalendarVersion
    : overrides.calendarVersion
  if (typeof submittedBy !== 'string' || !DOCUMENT_ID.test(submittedBy) ||
      typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100 ||
      !['fixed_accounts', 'business_creator'].includes(mode) ||
      !validDate(round && round.processingRoundStartedAt) ||
      !validDate(round && round.processingRoundEndedAt)) return null
  return crypto.createHash('sha256').update(JSON.stringify([
    submittedBy, displayName, mode, status, minutes, calendarVersion,
    round.processingRoundStartedAt.toISOString(), round.processingRoundEndedAt.toISOString()
  ])).digest('hex')
}

function processingRoundSnapshotState(round, startAt, endAt) {
  const keys = [
    'processingRoundTimingStatus', 'processingRoundWorkMinutes',
    'processingRoundCalendarVersion', 'processingRoundStartedAt', 'processingRoundEndedAt'
  ]
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(round || {}, key))
  if (descriptors.every(descriptor => descriptor === undefined)) return 'legacy'
  if (descriptors.some(descriptor => !descriptor ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) return null
  if (round.processingRoundTimingStatus !== 'pending_calendar' ||
      round.processingRoundWorkMinutes !== null || round.processingRoundCalendarVersion !== null ||
      !sameDate(round.processingRoundStartedAt, startAt) ||
      !sameDate(round.processingRoundEndedAt, endAt) ||
      processingAttributionHash(round) !== round.processingAttributionHash) return null
  return 'pending'
}

function reviewResponseHash(vote, overrides = {}) {
  const status = overrides.status === undefined
    ? vote && vote.reviewResponseTimingStatus
    : overrides.status
  const minutes = overrides.minutes === undefined
    ? vote && vote.reviewResponseWorkMinutes
    : overrides.minutes
  const calendarVersion = overrides.calendarVersion === undefined
    ? vote && vote.reviewResponseCalendarVersion
    : overrides.calendarVersion
  if (!vote || typeof vote.reviewerUserId !== 'string' || !DOCUMENT_ID.test(vote.reviewerUserId) ||
      typeof vote.reviewerDisplayName !== 'string' || !vote.reviewerDisplayName.trim() ||
      vote.reviewerDisplayName.length > 100 || !validDate(vote.reviewResponseStartedAt) ||
      !validDate(vote.reviewResponseEndedAt)) return null
  return crypto.createHash('sha256').update(JSON.stringify([
    vote.reviewerUserId, vote.reviewerDisplayName, status, minutes, calendarVersion,
    vote.reviewResponseStartedAt.toISOString(), vote.reviewResponseEndedAt.toISOString()
  ])).digest('hex')
}

function pendingReviewResponse(vote, round) {
  const keys = [
    '_id', 'reviewRoundId', 'businessLineId', 'nodeId', 'reviewerUserId',
    'reviewerDisplayName', 'decision', 'createdAt',
    'reviewResponseTimingStatus', 'reviewResponseWorkMinutes',
    'reviewResponseCalendarVersion', 'reviewResponseStartedAt',
    'reviewResponseEndedAt', 'reviewResponseHash'
  ]
  const descriptors = keys.map(key => Object.getOwnPropertyDescriptor(vote || {}, key))
  if (descriptors.some(descriptor => !descriptor ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) return false
  return Boolean(round && ['pending', 'approved', 'rejected'].includes(round.status) &&
    typeof vote._id === 'string' && DOCUMENT_ID.test(vote._id) && validDate(vote.createdAt) &&
    vote.reviewRoundId === round._id && vote.businessLineId === round.businessLineId &&
    vote.nodeId === round.nodeId && ['approved', 'rejected'].includes(vote.decision) &&
    vote.reviewResponseTimingStatus === 'pending_calendar' &&
    vote.reviewResponseWorkMinutes === null && vote.reviewResponseCalendarVersion === null &&
    sameDate(vote.reviewResponseStartedAt, round.reviewStartedAt) &&
    vote.reviewResponseStartedAt.getTime() <= vote.reviewResponseEndedAt.getTime() &&
    vote.createdAt.getTime() >= vote.reviewResponseEndedAt.getTime() &&
    reviewResponseHash(vote) === vote.reviewResponseHash)
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

function sameDate(left, right) {
  return validDate(left) && validDate(right) && left.getTime() === right.getTime()
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function pendingReviewTimingCarryover(round) {
  const base = safeNonNegativeInteger(
    round && round.reviewTimingCarryoverBaseElapsedWorkMinutes
  )
  const total = safeNonNegativeInteger(
    round && round.reviewTimingCarryoverTotalWorkMinutes
  )
  const slaTotal = round && round.reviewSlaWorkHours * 60
  if (!round || round.resultReviewCarryoverPending !== true ||
      round.reviewTimingStatus !== 'pending_calendar' ||
      round.reviewTimingCarryoverStatus !== 'pending' ||
      !validDate(round.reviewStartedAt) || !validDate(round.decidedAt) ||
      !sameDate(round.reviewTimingCarryoverStartedAt, round.reviewStartedAt) ||
      !sameDate(round.reviewTimingCarryoverEndedAt, round.decidedAt) ||
      round.reviewStartedAt.getTime() > round.decidedAt.getTime() ||
      base === null || total === null || total < 1 ||
      !Number.isSafeInteger(slaTotal) || slaTotal !== total ||
      round.reviewElapsedWorkMinutes !== base ||
      round.reviewRemainingWorkMinutes !== Math.max(0, total - base) ||
      round.reviewOverdueWorkMinutes !== Math.max(0, base - total) ||
      round.reviewCalendarVersion !== null) return null
  return { baseElapsedWorkMinutes: base, totalWorkMinutes: total }
}

function calendarWarningId(lineId) {
  const digest = crypto.createHash('sha256').update(`${lineId}\0processing`).digest('hex')
  return `work-calendar-missing-${digest.slice(0, 40)}`
}

function validateReviewProcessingCursor(document) {
  if (!document) return { exists: false, cursorId: null, version: 0 }
  if (document._id !== REVIEW_PROCESSING_CURSOR_ID || document.kind !== 'review_processing' ||
      safeVersion(document.version) === null ||
      document.cursorId !== null && (typeof document.cursorId !== 'string' || !DOCUMENT_ID.test(document.cursorId))) {
    throw new TypeError('review processing cursor is invalid')
  }
  return { exists: true, cursorId: document.cursorId, version: document.version }
}

function validateCarryoverCursor(document) {
  if (!document) return { exists: false, cursorId: null, version: 0 }
  if (document._id !== REVIEW_CARRYOVER_CURSOR_ID || document.kind !== 'review_carryover' ||
      safeVersion(document.version) === null ||
      document.cursorId !== null && (typeof document.cursorId !== 'string' || !DOCUMENT_ID.test(document.cursorId))) {
    throw new TypeError('review carryover cursor is invalid')
  }
  return { exists: true, cursorId: document.cursorId, version: document.version }
}

function validateReviewTimingCarryoverCursor(document) {
  if (!document) return { exists: false, cursorId: null, version: 0 }
  if (document._id !== REVIEW_TIMING_CARRYOVER_CURSOR_ID ||
      document.kind !== 'review_timing_carryover' || safeVersion(document.version) === null ||
      document.cursorId !== null &&
      (typeof document.cursorId !== 'string' || !DOCUMENT_ID.test(document.cursorId))) {
    throw new TypeError('review timing carryover cursor is invalid')
  }
  return { exists: true, cursorId: document.cursorId, version: document.version }
}

function validateReviewResponseCursor(document) {
  if (!document) return { exists: false, cursorId: null, version: 0 }
  if (document._id !== REVIEW_RESPONSE_CURSOR_ID || document.kind !== 'review_response' ||
      safeVersion(document.version) === null || document.cursorId !== null &&
      (typeof document.cursorId !== 'string' || !DOCUMENT_ID.test(document.cursorId))) {
    throw new TypeError('review response cursor is invalid')
  }
  return { exists: true, cursorId: document.cursorId, version: document.version }
}

async function readGenerationRecords(source, year, generationId, expectedLength) {
  const pageSize = 100
  const pages = Math.ceil((expectedLength + 1) / pageSize)
  const records = []
  for (let page = 0; page < pages; page += 1) {
    const result = await source.collection(ENTRY_COLLECTION)
      .where({ sourceYear: year, generationId })
      .orderBy('date', 'asc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get()
    const batch = Array.isArray(result && result.data) ? result.data : []
    records.push(...batch)
    if (batch.length < pageSize) break
  }
  return records
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
      const records = await readGenerationRecords(db, year, before.generationId, normalized.length)
      sameVersionComplete = records.length === normalized.length && records.every((record, index) => {
        const day = normalized[index]
        return record && record._id === `${before.generationId}_${day.date}` && record.date === day.date &&
          record.sourceYear === year && record.sourceVersion === sourceVersion &&
          record.generationId === before.generationId && record.isWorkday === day.isWorkday
      })
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
    const responseCursor = validateReviewResponseCursor(
      await readDocument(db, 'system_settings', REVIEW_RESPONSE_CURSOR_ID)
    )
    const responseCriteria = { reviewResponseTimingStatus: 'pending_calendar' }
    if (responseCursor.cursorId !== null) responseCriteria._id = db.command.gt(responseCursor.cursorId)
    const responseQuery = await db.collection('node_review_votes')
      .where(responseCriteria).orderBy('_id', 'asc').limit(limit).get()
    const responseRows = Array.isArray(responseQuery && responseQuery.data) ? responseQuery.data : []
    const responseNextCursorId = responseRows.length ? responseRows.at(-1)._id : null
    const responseCursorClaimed = await db.runTransaction(async transaction => {
      const current = validateReviewResponseCursor(
        await readDocument(transaction, 'system_settings', REVIEW_RESPONSE_CURSOR_ID)
      )
      if (current.exists !== responseCursor.exists || current.cursorId !== responseCursor.cursorId ||
          current.version !== responseCursor.version) return false
      if (!responseRows.length && responseCursor.cursorId === null) return true
      if (current.version === Number.MAX_SAFE_INTEGER) {
        throw new TypeError('review response cursor is invalid')
      }
      const data = {
        kind: 'review_response', cursorId: responseNextCursorId,
        version: current.version + 1, updatedAt: db.serverDate()
      }
      if (current.exists) {
        await transaction.collection('system_settings').doc(REVIEW_RESPONSE_CURSOR_ID).update({ data })
      } else {
        await transaction.collection('system_settings').doc(REVIEW_RESPONSE_CURSOR_ID).set({ data })
      }
      return true
    })
    if (!responseCursorClaimed) return result
    for (const vote of responseRows) {
      const round = await readDocument(db, 'node_review_rounds', vote.reviewRoundId)
      const node = round ? await readDocument(db, 'business_nodes', round.nodeId) : null
      if (!pendingReviewResponse(vote, round) || !node ||
          node.businessLineId !== round.businessLineId || safeVersion(node.version) === null ||
          safeVersion(round.version) === null) continue
      result.push({
        kind: 'review_response', id: vote._id, reviewRoundId: round._id,
        businessLineId: round.businessLineId, nodeId: round.nodeId,
        reviewerUserId: vote.reviewerUserId, responseHash: vote.reviewResponseHash,
        roundVersion: round.version, nodeVersion: node.version,
        startAt: vote.reviewResponseStartedAt, endAt: vote.reviewResponseEndedAt
      })
    }
    if (result.length >= limit) return result
    const carryCursor = validateCarryoverCursor(
      await readDocument(db, 'system_settings', REVIEW_CARRYOVER_CURSOR_ID)
    )
    const carryCriteria = { processingCarryoverStatus: 'pending' }
    if (carryCursor.cursorId !== null) carryCriteria._id = db.command.gt(carryCursor.cursorId)
    // 为独立的审核时长游标至少保留一个名额，避免处理时长长期满批时饥饿。
    const carryRemaining = limit - result.length
    const carryCapacity = carryRemaining > 1 ? carryRemaining - 1 : 1
    const carryQuery = await db.collection('node_review_rounds')
      .where(carryCriteria).orderBy('_id', 'asc').limit(carryCapacity).get()
    const carryRows = Array.isArray(carryQuery && carryQuery.data) ? carryQuery.data : []
    const carryNextCursorId = carryRows.length ? carryRows.at(-1)._id : null
    const carryCursorClaimed = await db.runTransaction(async transaction => {
      const current = validateCarryoverCursor(
        await readDocument(transaction, 'system_settings', REVIEW_CARRYOVER_CURSOR_ID)
      )
      if (current.exists !== carryCursor.exists || current.cursorId !== carryCursor.cursorId ||
          current.version !== carryCursor.version) return false
      if (!carryRows.length && carryCursor.cursorId === null) return true
      if (current.version === Number.MAX_SAFE_INTEGER) throw new TypeError('review carryover cursor is invalid')
      const data = {
        kind: 'review_carryover', cursorId: carryNextCursorId,
        version: current.version + 1, updatedAt: db.serverDate()
      }
      if (current.exists) {
        await transaction.collection('system_settings').doc(REVIEW_CARRYOVER_CURSOR_ID).update({ data })
      } else {
        await transaction.collection('system_settings').doc(REVIEW_CARRYOVER_CURSOR_ID).set({ data })
      }
      return true
    })
    if (!carryCursorClaimed) return result
    for (const round of carryRows) {
      if (result.length >= limit) break
      const node = await readDocument(db, 'business_nodes', round.nodeId)
      const baseElapsedWorkMinutes = safeNonNegativeInteger(
        round.processingCarryoverBaseElapsedWorkMinutes
      )
      const totalWorkMinutes = safeNonNegativeInteger(round.processingCarryoverTotalWorkMinutes)
      if (!node || round.businessLineId !== node.businessLineId || round.nodeId !== node._id ||
          !['approved', 'rejected'].includes(round.status) ||
          round.processingTimingStatus !== 'pending_calendar' ||
          !validDate(round.processingCarryoverStartedAt) ||
          !validDate(round.processingCarryoverEndedAt) ||
          round.processingCarryoverStartedAt.getTime() > round.processingCarryoverEndedAt.getTime() ||
          baseElapsedWorkMinutes === null || totalWorkMinutes === null || totalWorkMinutes < 1 ||
          !Number.isSafeInteger(node.processingSlaWorkHours * 60) ||
          node.processingSlaWorkHours * 60 !== totalWorkMinutes ||
          safeVersion(node.version) === null || safeVersion(round.version) === null) continue
      const activeProcessing = PROCESSING_STATUSES.has(node.status) && validDate(node.processingStartedAt)
      const currentElapsedWorkMinutes = safeNonNegativeInteger(node.processingElapsedWorkMinutes)
      if (currentElapsedWorkMinutes === null) continue
      result.push({
        kind: 'review_processing_carryover', id: round._id,
        businessLineId: node.businessLineId, nodeId: node._id,
        status: round.status, version: round.version, nodeVersion: node.version,
        startAt: round.processingCarryoverStartedAt,
        endAt: round.processingCarryoverEndedAt,
        resumeAt: activeProcessing ? node.processingStartedAt : null,
        activeReviewRoundId: typeof node.activeReviewRoundId === 'string'
          ? node.activeReviewRoundId
          : null,
        baseElapsedWorkMinutes, currentElapsedWorkMinutes, totalWorkMinutes
      })
    }
    if (result.length >= limit) return result
    const reviewTimingCapacity = limit - result.length
    const reviewTimingCursor = validateReviewTimingCarryoverCursor(
      await readDocument(db, 'system_settings', REVIEW_TIMING_CARRYOVER_CURSOR_ID)
    )
    const reviewTimingCriteria = { reviewTimingCarryoverStatus: 'pending' }
    if (reviewTimingCursor.cursorId !== null) {
      reviewTimingCriteria._id = db.command.gt(reviewTimingCursor.cursorId)
    }
    const reviewTimingQuery = await db.collection('node_review_rounds')
      .where(reviewTimingCriteria).orderBy('_id', 'asc').limit(reviewTimingCapacity).get()
    const reviewTimingRows = Array.isArray(reviewTimingQuery && reviewTimingQuery.data)
      ? reviewTimingQuery.data
      : []
    const reviewTimingNextCursorId = reviewTimingRows.length
      ? reviewTimingRows.at(-1)._id
      : null
    const reviewTimingCursorClaimed = await db.runTransaction(async transaction => {
      const current = validateReviewTimingCarryoverCursor(
        await readDocument(transaction, 'system_settings', REVIEW_TIMING_CARRYOVER_CURSOR_ID)
      )
      if (current.exists !== reviewTimingCursor.exists ||
          current.cursorId !== reviewTimingCursor.cursorId ||
          current.version !== reviewTimingCursor.version) return false
      if (!reviewTimingRows.length && reviewTimingCursor.cursorId === null) return true
      if (current.version === Number.MAX_SAFE_INTEGER) {
        throw new TypeError('review timing carryover cursor is invalid')
      }
      const data = {
        kind: 'review_timing_carryover', cursorId: reviewTimingNextCursorId,
        version: current.version + 1, updatedAt: db.serverDate()
      }
      if (current.exists) {
        await transaction.collection('system_settings')
          .doc(REVIEW_TIMING_CARRYOVER_CURSOR_ID).update({ data })
      } else {
        await transaction.collection('system_settings')
          .doc(REVIEW_TIMING_CARRYOVER_CURSOR_ID).set({ data })
      }
      return true
    })
    if (!reviewTimingCursorClaimed) return result
    for (const round of reviewTimingRows) {
      if (result.length >= limit) break
      const node = await readDocument(db, 'business_nodes', round.nodeId)
      const timing = pendingReviewTimingCarryover(round)
      if (!node || round.businessLineId !== node.businessLineId || round.nodeId !== node._id ||
          !['approved', 'rejected'].includes(round.status) ||
          !timing ||
          safeVersion(node.version) === null || safeVersion(round.version) === null) continue
      result.push({
        kind: 'review_timing_carryover', id: round._id,
        businessLineId: round.businessLineId, nodeId: round.nodeId,
        status: round.status, version: round.version, nodeVersion: node.version,
        activeReviewRoundId: typeof node.activeReviewRoundId === 'string'
          ? node.activeReviewRoundId
          : null,
        startAt: round.reviewTimingCarryoverStartedAt,
        endAt: round.reviewTimingCarryoverEndedAt,
        ...timing
      })
    }
    if (result.length >= limit) return result
    const processing = await db.collection('business_nodes')
      .where({ processingDueStatus: 'pending_calendar' }).orderBy('_id', 'asc')
      .limit(limit - result.length).get()
    const carryNodeIds = new Set(result.filter(candidate =>
      candidate.kind === 'review_processing_carryover').map(candidate => candidate.nodeId))
    for (const node of Array.isArray(processing && processing.data) ? processing.data : []) {
      const minutes = processingMinutes(node)
      if (result.length >= limit) break
      if (carryNodeIds.has(node._id)) continue
      if (!PROCESSING_STATUSES.has(node.status) || !validDate(node.processingStartedAt) ||
          safeVersion(node.version) === null || minutes === null || typeof node.businessLineId !== 'string') continue
      result.push({
        kind: 'processing', id: node._id, businessLineId: node.businessLineId,
        status: node.status, version: node.version, startAt: node.processingStartedAt, minutes
      })
    }
    if (result.length >= limit) return result
    const capacity = limit - result.length
    const cursorSnapshot = validateReviewProcessingCursor(
      await readDocument(db, 'system_settings', REVIEW_PROCESSING_CURSOR_ID)
    )
    const reviewCriteria = { processingTimingStatus: 'pending_calendar' }
    if (cursorSnapshot.cursorId !== null) reviewCriteria._id = db.command.gt(cursorSnapshot.cursorId)
    const reviewProcessing = await db.collection('business_nodes')
      .where(reviewCriteria).orderBy('_id', 'asc').limit(capacity).get()
    const reviewRows = Array.isArray(reviewProcessing && reviewProcessing.data) ? reviewProcessing.data : []
    const nextCursorId = reviewRows.length ? reviewRows.at(-1)._id : null
    const cursorClaimed = await db.runTransaction(async transaction => {
      const current = validateReviewProcessingCursor(
        await readDocument(transaction, 'system_settings', REVIEW_PROCESSING_CURSOR_ID)
      )
      if (current.exists !== cursorSnapshot.exists || current.cursorId !== cursorSnapshot.cursorId ||
          current.version !== cursorSnapshot.version) return false
      if (!reviewRows.length && cursorSnapshot.cursorId === null) return true
      if (current.version === Number.MAX_SAFE_INTEGER) {
        throw new TypeError('review processing cursor is invalid')
      }
      const data = {
        kind: 'review_processing', cursorId: nextCursorId,
        version: current.version + 1, updatedAt: db.serverDate()
      }
      if (current.exists) {
        await transaction.collection('system_settings').doc(REVIEW_PROCESSING_CURSOR_ID).update({ data })
      } else {
        await transaction.collection('system_settings').doc(REVIEW_PROCESSING_CURSOR_ID).set({ data })
      }
      return true
    })
    if (!cursorClaimed) return result
    for (const node of reviewRows) {
      if (result.length >= limit) break
      if (node.status !== 'pending_review' || typeof node.businessLineId !== 'string' ||
          typeof node.activeReviewRoundId !== 'string' || !node.activeReviewRoundId ||
          !validDate(node.processingStartedAt) || safeVersion(node.version) === null) continue
      const round = await readDocument(db, 'node_review_rounds', node.activeReviewRoundId)
      const baseElapsedWorkMinutes = safeNonNegativeInteger(node.processingElapsedWorkMinutes)
      const totalWorkMinutes = typeof node.processingSlaWorkHours === 'number' &&
        Number.isFinite(node.processingSlaWorkHours) && node.processingSlaWorkHours > 0
        ? node.processingSlaWorkHours * 60
        : null
      if (!round || round.businessLineId !== node.businessLineId || round.nodeId !== node._id ||
          round.status !== 'pending' || round.lockedNodeVersion !== node.version ||
          round.processingTimingStatus !== 'pending_calendar' || !validDate(round.reviewStartedAt) ||
          safeVersion(round.version) === null || baseElapsedWorkMinutes === null ||
          !Number.isSafeInteger(totalWorkMinutes)) continue
      result.push({
        kind: 'review_processing', id: round._id, businessLineId: node.businessLineId,
        nodeId: node._id, status: round.status, version: round.version, nodeVersion: node.version,
        startAt: node.processingStartedAt, endAt: round.reviewStartedAt,
        baseElapsedWorkMinutes, totalWorkMinutes
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
    const reviewProcessingCalculation = candidate && candidate.kind === 'review_processing'
    const carryoverCalculation = candidate && candidate.kind === 'review_processing_carryover'
    const reviewTimingCarryoverCalculation = candidate &&
      candidate.kind === 'review_timing_carryover'
    const reviewResponseCalculation = candidate && candidate.kind === 'review_response'
    if (!candidate || !calculation || calculation.status !== 'calculated' ||
        (reviewProcessingCalculation || carryoverCalculation || reviewTimingCarryoverCalculation ||
          reviewResponseCalculation
          ? safeNonNegativeInteger(calculation.minutes) === null
          : !validDate(calculation.dueAt)) ||
        carryoverCalculation && validDate(candidate.resumeAt) &&
          (!validDate(calculation.dueAt) || calculation.dueCalendarVersion !== null &&
            (typeof calculation.dueCalendarVersion !== 'string' || !calculation.dueCalendarVersion)) ||
        (calculation.calendarVersion !== null &&
          (typeof calculation.calendarVersion !== 'string' || !calculation.calendarVersion)) || !validDate(now)) {
      throw new TypeError('valid calculated due result is required')
    }
    if (reviewResponseCalculation &&
        (typeof calculation.calendarVersion !== 'string' || !calculation.calendarVersion)) {
      throw new TypeError('valid calculated due result is required')
    }
    return db.runTransaction(async transaction => {
      const line = await readDocument(transaction, 'business_lines', candidate.businessLineId)
      if (!line || !carryoverCalculation && !reviewTimingCarryoverCalculation &&
          !reviewResponseCalculation &&
          line.status !== 'active') return false
      if (candidate.kind === 'review_response') {
        const node = await readDocument(transaction, 'business_nodes', candidate.nodeId)
        const round = await readDocument(transaction, 'node_review_rounds', candidate.reviewRoundId)
        const vote = await readDocument(transaction, 'node_review_votes', candidate.id)
        if (!node || !round || !vote || node.businessLineId !== line._id ||
            round.businessLineId !== line._id || round.nodeId !== node._id ||
            node.version !== candidate.nodeVersion || round.version !== candidate.roundVersion ||
            vote.reviewerUserId !== candidate.reviewerUserId ||
            vote.reviewResponseHash !== candidate.responseHash ||
            !sameDate(vote.reviewResponseStartedAt, candidate.startAt) ||
            !sameDate(vote.reviewResponseEndedAt, candidate.endAt) ||
            !pendingReviewResponse(vote, round)) return false
        const resolvedHash = reviewResponseHash(vote, {
          status: 'calculated', minutes: calculation.minutes,
          calendarVersion: calculation.calendarVersion
        })
        if (!resolvedHash) return false
        await transaction.collection('node_review_votes').doc(vote._id).update({ data: {
          reviewResponseTimingStatus: 'calculated',
          reviewResponseWorkMinutes: calculation.minutes,
          reviewResponseCalendarVersion: calculation.calendarVersion,
          reviewResponseHash: resolvedHash,
          reviewResponseRecalculatedAt: new Date(now)
        } })
        return true
      }
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
      if (candidate.kind === 'review_processing') {
        const node = await readDocument(transaction, 'business_nodes', candidate.nodeId)
        const round = await readDocument(transaction, 'node_review_rounds', candidate.id)
        const roundSnapshotState = processingRoundSnapshotState(
          round, candidate.startAt, candidate.endAt
        )
        if (!node || !round || node.businessLineId !== line._id || round.businessLineId !== line._id ||
            round.nodeId !== node._id || line.currentNodeId !== node._id || node.status !== 'pending_review' ||
            node.activeReviewRoundId !== round._id || node.version !== candidate.nodeVersion ||
            round.status !== candidate.status || round.status !== 'pending' || round.version !== candidate.version ||
            round.lockedNodeVersion !== node.version || node.processingTimingStatus !== 'pending_calendar' ||
            round.processingTimingStatus !== 'pending_calendar' ||
            !sameDate(node.processingStartedAt, candidate.startAt) ||
            !sameDate(round.reviewStartedAt, candidate.endAt) ||
            node.processingElapsedWorkMinutes !== candidate.baseElapsedWorkMinutes ||
            node.processingSlaWorkHours * 60 !== candidate.totalWorkMinutes ||
            node.version === Number.MAX_SAFE_INTEGER || round.version === Number.MAX_SAFE_INTEGER ||
            roundSnapshotState === null) return false
        const elapsed = candidate.baseElapsedWorkMinutes + calculation.minutes
        if (!Number.isSafeInteger(elapsed)) return false
        const remaining = Math.max(0, candidate.totalWorkMinutes - elapsed)
        const overdue = Math.max(0, elapsed - candidate.totalWorkMinutes)
        const timing = {
          processingTimingStatus: 'calculated',
          processingElapsedWorkMinutes: elapsed,
          processingRemainingWorkMinutes: remaining,
          processingOverdueWorkMinutes: overdue,
          processingCalendarVersion: calculation.calendarVersion,
          calendarRecalculatedAt: new Date(now),
          updatedAt: db.serverDate()
        }
        const lockedNodeVersion = node.version + 1
        const resolvedAttributionHash = roundSnapshotState === 'pending'
          ? processingAttributionHash(round, {
              status: 'calculated', minutes: calculation.minutes,
              calendarVersion: calculation.calendarVersion
            })
          : null
        if (roundSnapshotState === 'pending' && !resolvedAttributionHash) return false
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          ...timing,
          version: lockedNodeVersion
        } })
        await transaction.collection('node_review_rounds').doc(round._id).update({ data: {
          ...timing,
          ...(roundSnapshotState === 'pending' ? {
              processingRoundTimingStatus: 'calculated',
              processingRoundWorkMinutes: calculation.minutes,
              processingRoundCalendarVersion: calculation.calendarVersion,
              processingAttributionHash: resolvedAttributionHash
            } : {}),
          lockedNodeVersion,
          version: round.version + 1
        } })
        return true
      }
      if (candidate.kind === 'review_processing_carryover') {
        const node = await readDocument(transaction, 'business_nodes', candidate.nodeId)
        const round = await readDocument(transaction, 'node_review_rounds', candidate.id)
        const activeRound = candidate.activeReviewRoundId === null
          ? null
          : await readDocument(transaction, 'node_review_rounds', candidate.activeReviewRoundId)
        const rejected = round && round.status === 'rejected'
        const approved = round && round.status === 'approved'
        const roundSnapshotState = processingRoundSnapshotState(
          round, candidate.startAt, candidate.endAt
        )
        if (!node || !round || node.businessLineId !== line._id || round.businessLineId !== line._id ||
            round.nodeId !== node._id || node.version !== candidate.nodeVersion ||
            round.version !== candidate.version ||
            round.processingTimingStatus !== 'pending_calendar' ||
            round.processingCarryoverStatus !== 'pending' ||
            !sameDate(round.processingCarryoverStartedAt, candidate.startAt) ||
            !sameDate(round.processingCarryoverEndedAt, candidate.endAt) ||
            round.processingCarryoverBaseElapsedWorkMinutes !== candidate.baseElapsedWorkMinutes ||
            round.processingCarryoverTotalWorkMinutes !== candidate.totalWorkMinutes ||
            node.processingElapsedWorkMinutes !== candidate.currentElapsedWorkMinutes ||
            node.version === Number.MAX_SAFE_INTEGER || round.version === Number.MAX_SAFE_INTEGER ||
            rejected && (round.resultNodeStatus !== 'in_progress' || round.resultLineStatus !== 'active') ||
            approved && round.resultNodeStatus !== 'completed' ||
            candidate.activeReviewRoundId !== (typeof node.activeReviewRoundId === 'string'
              ? node.activeReviewRoundId
              : null) ||
            !approved && !rejected || roundSnapshotState === null) return false
        const recalculateCurrentDue = validDate(candidate.resumeAt)
        if (recalculateCurrentDue && (line.status !== 'active' || line.currentNodeId !== node._id ||
            !PROCESSING_STATUSES.has(node.status) ||
            !sameDate(node.processingStartedAt, candidate.resumeAt) ||
            !validDate(calculation.dueAt))) return false
        if (!recalculateCurrentDue && candidate.resumeAt !== null) return false
        const historicalElapsed = candidate.baseElapsedWorkMinutes + calculation.minutes
        const currentElapsed = safeNonNegativeInteger(node.processingElapsedWorkMinutes)
        const currentTotal = typeof node.processingSlaWorkHours === 'number' &&
          Number.isSafeInteger(node.processingSlaWorkHours * 60) && node.processingSlaWorkHours > 0
          ? node.processingSlaWorkHours * 60
          : null
        if (!Number.isSafeInteger(historicalElapsed) || currentElapsed === null ||
            currentTotal === null ||
            !Number.isSafeInteger(currentElapsed + calculation.minutes)) return false
        const elapsed = currentElapsed + calculation.minutes
        const remaining = Math.max(0, currentTotal - elapsed)
        const overdue = Math.max(0, elapsed - currentTotal)
        if (activeRound && (activeRound._id === round._id || activeRound.status !== 'pending' ||
            activeRound.businessLineId !== line._id || activeRound.nodeId !== node._id ||
            activeRound.lockedNodeVersion !== node.version ||
            activeRound.processingElapsedWorkMinutes !== currentElapsed ||
            activeRound.processingRemainingWorkMinutes !== node.processingRemainingWorkMinutes ||
            activeRound.processingOverdueWorkMinutes !== node.processingOverdueWorkMinutes ||
            activeRound.version === Number.MAX_SAFE_INTEGER)) return false
        const latestCompletedRound = !activeRound && node.status === 'completed' &&
          node.reviewRoundNumber === round.reviewRoundNumber
        const timingResolved = recalculateCurrentDue || latestCompletedRound ||
          Boolean(activeRound && activeRound.processingTimingStatus === 'calculated')
        const resolvedAttributionHash = roundSnapshotState === 'pending'
          ? processingAttributionHash(round, {
              status: 'calculated', minutes: calculation.minutes,
              calendarVersion: calculation.calendarVersion
            })
          : null
        if (roundSnapshotState === 'pending' && !resolvedAttributionHash) return false
        const nodeVersion = node.version + 1
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          processingTimingStatus: timingResolved ? 'calculated' : 'pending_calendar',
          processingElapsedWorkMinutes: elapsed,
          processingRemainingWorkMinutes: remaining,
          processingOverdueWorkMinutes: overdue,
          ...(timingResolved ? { processingCalendarVersion: calculation.calendarVersion } : {}),
          ...(recalculateCurrentDue
            ? {
                processingDueStatus: 'calculated',
                processingDueAt: new Date(calculation.dueAt),
                processingCalendarVersion: calculation.dueCalendarVersion,
                calendarNotificationStatus: 'resolved'
              }
            : {}),
          calendarRecalculatedAt: new Date(now),
          version: nodeVersion,
          updatedAt: db.serverDate()
        } })
        await transaction.collection('node_review_rounds').doc(round._id).update({ data: {
          processingTimingStatus: 'calculated',
          processingElapsedWorkMinutes: historicalElapsed,
          processingRemainingWorkMinutes: Math.max(0, candidate.totalWorkMinutes - historicalElapsed),
          processingOverdueWorkMinutes: Math.max(0, historicalElapsed - candidate.totalWorkMinutes),
          processingCalendarVersion: calculation.calendarVersion,
          ...(roundSnapshotState === 'pending' ? {
              processingRoundTimingStatus: 'calculated',
              processingRoundWorkMinutes: calculation.minutes,
              processingRoundCalendarVersion: calculation.calendarVersion,
              processingAttributionHash: resolvedAttributionHash
            } : {}),
          processingCarryoverStatus: 'resolved',
          processingCarryoverResolvedAt: new Date(now),
          calendarRecalculatedAt: new Date(now),
          version: round.version + 1,
          updatedAt: db.serverDate()
        } })
        if (activeRound) {
          await transaction.collection('node_review_rounds').doc(activeRound._id).update({ data: {
            processingElapsedWorkMinutes: elapsed,
            processingRemainingWorkMinutes: remaining,
            processingOverdueWorkMinutes: overdue,
            lockedNodeVersion: nodeVersion,
            version: activeRound.version + 1,
            updatedAt: db.serverDate()
          } })
        }
        return true
      }
      if (candidate.kind === 'review_timing_carryover') {
        const node = await readDocument(transaction, 'business_nodes', candidate.nodeId)
        const round = await readDocument(transaction, 'node_review_rounds', candidate.id)
        const activeRound = candidate.activeReviewRoundId === null
          ? null
          : await readDocument(transaction, 'node_review_rounds', candidate.activeReviewRoundId)
        const reviewTiming = pendingReviewTimingCarryover(round)
        if (!node || !round || node.businessLineId !== line._id ||
            round.businessLineId !== line._id || round.nodeId !== node._id ||
            node.version !== candidate.nodeVersion || round.version !== candidate.version ||
            round.status !== candidate.status || !['approved', 'rejected'].includes(round.status) ||
            !reviewTiming ||
            !sameDate(round.reviewTimingCarryoverStartedAt, candidate.startAt) ||
            !sameDate(round.reviewTimingCarryoverEndedAt, candidate.endAt) ||
            reviewTiming.baseElapsedWorkMinutes !== candidate.baseElapsedWorkMinutes ||
            reviewTiming.totalWorkMinutes !== candidate.totalWorkMinutes ||
            candidate.activeReviewRoundId !== (typeof node.activeReviewRoundId === 'string'
              ? node.activeReviewRoundId
              : null) || node.version === Number.MAX_SAFE_INTEGER ||
            round.version === Number.MAX_SAFE_INTEGER) return false
        if (activeRound && (activeRound._id === round._id || activeRound.status !== 'pending' ||
            activeRound.businessLineId !== line._id || activeRound.nodeId !== node._id ||
            activeRound.lockedNodeVersion !== node.version ||
            activeRound.version === Number.MAX_SAFE_INTEGER)) return false
        const elapsed = candidate.baseElapsedWorkMinutes + calculation.minutes
        if (!Number.isSafeInteger(elapsed)) return false
        const remaining = Math.max(0, candidate.totalWorkMinutes - elapsed)
        const overdue = Math.max(0, elapsed - candidate.totalWorkMinutes)
        const nodeVersion = node.version + 1
        const latestReview = node.lastReviewRoundId === round._id ||
          node.reviewRoundNumber === round.reviewRoundNumber && !activeRound
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          ...(latestReview
            ? {
                lastReviewRoundId: round._id,
                lastReviewTimingStatus: 'calculated',
                lastReviewElapsedWorkMinutes: elapsed,
                lastReviewRemainingWorkMinutes: remaining,
                lastReviewOverdueWorkMinutes: overdue,
                lastReviewCalendarVersion: calculation.calendarVersion
              }
            : {}),
          version: nodeVersion,
          updatedAt: db.serverDate()
        } })
        await transaction.collection('node_review_rounds').doc(round._id).update({ data: {
          reviewTimingStatus: 'calculated',
          reviewElapsedWorkMinutes: elapsed,
          reviewRemainingWorkMinutes: remaining,
          reviewOverdueWorkMinutes: overdue,
          reviewCalendarVersion: calculation.calendarVersion,
          reviewTimingCarryoverStatus: 'resolved',
          reviewTimingCarryoverResolvedAt: new Date(now),
          calendarRecalculatedAt: new Date(now),
          version: round.version + 1,
          updatedAt: db.serverDate()
        } })
        if (activeRound) {
          await transaction.collection('node_review_rounds').doc(activeRound._id).update({ data: {
            lockedNodeVersion: nodeVersion,
            version: activeRound.version + 1,
            updatedAt: db.serverDate()
          } })
        }
        return true
      }
      return false
    })
  }

  async function ensurePendingCalendarWarning({ candidate } = {}) {
    if (!candidate || !['processing', 'review_processing', 'review_processing_carryover',
      'review_timing_carryover', 'review_response'].includes(candidate.kind) ||
        typeof candidate.id !== 'string' ||
        typeof candidate.businessLineId !== 'string' ||
        (candidate.kind === 'review_response'
          ? typeof candidate.reviewRoundId !== 'string' ||
            typeof candidate.responseHash !== 'string' ||
            safeVersion(candidate.roundVersion) === null || safeVersion(candidate.nodeVersion) === null
          : typeof candidate.status !== 'string' || safeVersion(candidate.version) === null)) return false
    return db.runTransaction(async transaction => {
      const line = await readDocument(transaction, 'business_lines', candidate.businessLineId)
      const nodeId = candidate.kind === 'processing' ? candidate.id : candidate.nodeId
      const node = await readDocument(transaction, 'business_nodes', nodeId)
      if (!line || !node || node.businessLineId !== line._id ||
          !['review_processing_carryover', 'review_timing_carryover', 'review_response']
            .includes(candidate.kind) &&
          (line.status !== 'active' || line.currentNodeId !== nodeId)) return false
      if (candidate.kind === 'processing') {
        if (node.status !== candidate.status || node.version !== candidate.version ||
            !PROCESSING_STATUSES.has(node.status) || node.processingDueStatus !== 'pending_calendar') return false
      } else if (candidate.kind === 'review_processing') {
        const round = await readDocument(transaction, 'node_review_rounds', candidate.id)
        if (!round || node.status !== 'pending_review' || node.activeReviewRoundId !== round._id ||
            node.version !== candidate.nodeVersion || round.businessLineId !== line._id ||
            round.nodeId !== node._id || round.status !== candidate.status || round.status !== 'pending' ||
            round.version !== candidate.version || round.lockedNodeVersion !== node.version ||
            node.processingTimingStatus !== 'pending_calendar' ||
            round.processingTimingStatus !== 'pending_calendar') return false
      } else if (candidate.kind === 'review_processing_carryover') {
        const round = await readDocument(transaction, 'node_review_rounds', candidate.id)
        if (!round || round.processingCarryoverStatus !== 'pending' ||
            node.version !== candidate.nodeVersion || round.version !== candidate.version ||
            round.processingTimingStatus !== 'pending_calendar' ||
            round.businessLineId !== line._id || round.nodeId !== node._id ||
            !['approved', 'rejected'].includes(round.status)) return false
      } else if (candidate.kind === 'review_timing_carryover') {
        const round = await readDocument(transaction, 'node_review_rounds', candidate.id)
        if (!round || !pendingReviewTimingCarryover(round) ||
            node.version !== candidate.nodeVersion || round.version !== candidate.version ||
            round.businessLineId !== line._id || round.nodeId !== node._id ||
            !['approved', 'rejected'].includes(round.status)) return false
      } else {
        const round = await readDocument(transaction, 'node_review_rounds', candidate.reviewRoundId)
        const vote = await readDocument(transaction, 'node_review_votes', candidate.id)
        if (!round || !vote || round.businessLineId !== line._id || round.nodeId !== node._id ||
            round.version !== candidate.roundVersion || node.version !== candidate.nodeVersion ||
            vote.reviewerUserId !== candidate.reviewerUserId ||
            vote.reviewResponseHash !== candidate.responseHash ||
            !pendingReviewResponse(vote, round)) return false
      }
      const warningId = calendarWarningId(line._id)
      const existing = await readDocument(transaction, 'notifications', warningId)
      if (!existing) {
        await transaction.collection('notifications').doc(warningId).set({ data: {
          type: 'work_calendar_missing',
          audienceRole: 'super_admin',
          status: 'pending',
          createdAt: db.serverDate()
        } })
      }
      if (candidate.kind === 'processing' && node.calendarNotificationStatus !== 'notified') {
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          calendarNotificationStatus: 'notified',
          updatedAt: db.serverDate()
        } })
      }
      return true
    })
  }

  return {
    replaceYear,
    getDayRule,
    listPendingDueCandidates,
    applyDueCalculation,
    ensurePendingCalendarWarning
  }
}

module.exports = {
  ENTRY_COLLECTION,
  YEAR_COLLECTION,
  createCloudCalendarRepository
}
