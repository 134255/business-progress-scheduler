'use strict'

const MAX_BATCH_SIZE = 40

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function safeMinutes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function safeElapsedMinutes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function safeNextHour(value, baseMinutes) {
  if (Number.isSafeInteger(value) && value >= 1) return value
  return Math.floor(baseMinutes / 60) + 1
}

function createReminderService({ reminderRepository, workTimeService } = {}) {
  const methods = [
    'listDueProcessingReminders', 'listDueReviewReminders', 'createProcessingReminder',
    'createReviewReminder', 'advanceReminderCursor'
  ]
  if (!reminderRepository || methods.some(name => typeof reminderRepository[name] !== 'function')) {
    throw new TypeError('reminderRepository is invalid')
  }
  if (!workTimeService || typeof workTimeService.isWorkingInstant !== 'function' ||
      typeof workTimeService.workingMinutesBetween !== 'function') {
    throw new TypeError('workTimeService is invalid')
  }

  async function accumulatedHour(candidate, startedAtKey, elapsedKey, nextHourKey, now) {
    const startedAt = candidate && candidate[startedAtKey]
    const baseMinutes = safeMinutes(candidate && candidate[elapsedKey])
    if (!validDate(startedAt) || baseMinutes === null || startedAt.getTime() > now.getTime()) return null
    const interval = await workTimeService.workingMinutesBetween(startedAt, now)
    const intervalMinutes = interval && interval.status === 'calculated'
      ? safeElapsedMinutes(interval.minutes)
      : null
    if (intervalMinutes === null) return null
    const total = baseMinutes + intervalMinutes
    const nextHour = safeNextHour(candidate[nextHourKey], baseMinutes)
    return total >= nextHour * 60 ? nextHour : null
  }

  async function runReminderCycle({ now, batchSize } = {}) {
    if (!validDate(now) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
      throw new TypeError('valid now and batchSize from 1 to 40 are required')
    }
    const instant = await workTimeService.isWorkingInstant(now)
    if (!instant || instant.status !== 'calculated' || instant.isWorking !== true) {
      return { processingCreated: 0, reviewCreated: 0 }
    }

    const processingLimit = Math.ceil(batchSize / 2)
    const processing = await reminderRepository.listDueProcessingReminders({ limit: processingLimit })
    if (!Array.isArray(processing) || processing.length > processingLimit) {
      throw new TypeError('processing candidates are invalid')
    }
    const reviewLimit = batchSize - processing.length
    const reviewPage = reviewLimit
      ? await reminderRepository.listDueReviewReminders({ limit: reviewLimit })
      : { items: [], lastScannedRawId: null }
    if (!reviewPage || !Array.isArray(reviewPage.items) || reviewPage.items.length > reviewLimit ||
        reviewPage.lastScannedRawId !== null &&
        (typeof reviewPage.lastScannedRawId !== 'string' ||
         !/^[A-Za-z0-9_-]{1,128}$/.test(reviewPage.lastScannedRawId))) {
      throw new TypeError('review candidates are invalid')
    }
    const review = reviewPage.items

    let processingCreated = 0
    for (const candidate of processing) {
      const accumulatedWorkHour = await accumulatedHour(
        candidate, 'processingStartedAt', 'processingElapsedWorkMinutes',
        'nextReminderWorkHour', now)
      if (accumulatedWorkHour !== null) {
        const result = await reminderRepository.createProcessingReminder({
          nodeId: candidate.nodeId,
          processingRoundNumber: candidate.processingRoundNumber,
          accumulatedWorkHour
        })
        if (result && result.created === true) processingCreated += 1
      }
    }
    if (processing.length) {
      await reminderRepository.advanceReminderCursor({
        kind: 'processing', cursorId: processing.at(-1).nodeId
      })
    }

    let reviewCreated = 0
    for (const candidate of review) {
      const accumulatedWorkHour = await accumulatedHour(
        candidate, 'reviewStartedAt', 'reviewElapsedWorkMinutes',
        'nextReminderWorkHour', now)
      if (accumulatedWorkHour !== null) {
        const voted = new Set(Array.isArray(candidate.votedReviewerUserIds)
          ? candidate.votedReviewerUserIds
          : [])
        const reviewers = Array.isArray(candidate.reviewerUserIds) ? candidate.reviewerUserIds : []
        const pendingReviewers = reviewers.filter(reviewerUserId => !voted.has(reviewerUserId))
        let hourCanAdvance = true
        for (const [index, reviewerUserId] of pendingReviewers.entries()) {
          const result = await reminderRepository.createReviewReminder({
            reviewRoundId: candidate.reviewRoundId, nodeId: candidate.nodeId,
            reviewerUserId, accumulatedWorkHour,
            expectedVoteCount: candidate.voteCount,
            expectedApprovedVoteCount: candidate.approvedVoteCount,
            advanceHour: hourCanAdvance && index === pendingReviewers.length - 1
          })
          if (result && result.created === true) reviewCreated += 1
          if (!result || result.fulfilled !== true) hourCanAdvance = false
        }
      }
    }
    if (reviewPage.lastScannedRawId !== null) {
      await reminderRepository.advanceReminderCursor({
        kind: 'review', cursorId: reviewPage.lastScannedRawId
      })
    }
    return { processingCreated, reviewCreated }
  }

  return { runReminderCycle }
}

module.exports = { MAX_BATCH_SIZE, createReminderService }
