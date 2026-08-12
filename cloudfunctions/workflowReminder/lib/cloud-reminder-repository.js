'use strict'

const crypto = require('node:crypto')

const MAX_BATCH_SIZE = 40
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const ACTIVE_LINE_STATUSES = new Set(['active'])
const ACTIVE_PROCESSING_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const PROCESSING_CURSOR_ID = 'workflow-reminder-processing-cursor'
const REVIEW_CURSOR_ID = 'workflow-reminder-review-cursor'

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function missingDocument(error) {
  return /document(?:\.get)?:fail.*(?:does not exist|not found)|document with _id .* does not exist/i
    .test(String(error && (error.errMsg || error.message || error)))
}

async function readDocument(source, collection, id) {
  if (typeof id !== 'string' || !DOCUMENT_ID.test(id)) return null
  try {
    const result = await source.collection(collection).doc(id).get()
    return result && result.data ? result.data : null
  } catch (error) {
    if (missingDocument(error)) return null
    throw error
  }
}

function exactIds(value, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || nonEmpty && value.length === 0 ||
      value.some(id => typeof id !== 'string' || !DOCUMENT_ID.test(id)) ||
      new Set(value).size !== value.length) return null
  return value
}

function ownExactIds(value, key, options) {
  if (!value || typeof value !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? exactIds(descriptor.value, options)
    : null
}

function safeHour(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

function safeMinutes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function digest(parts) {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 48)
}

function processingNotificationId(nodeCode, accumulatedWorkHour) {
  return `processing-reminder-${digest([nodeCode, String(accumulatedWorkHour)])}`
}

function reviewNotificationId(reviewRoundId, reviewerUserId, accumulatedWorkHour) {
  return `review-reminder-${digest([reviewRoundId, reviewerUserId, String(accumulatedWorkHour)])}`
}

function voteId(reviewRoundId, reviewerUserId) {
  return `review-vote-${crypto.createHash('sha256')
    .update(`${reviewRoundId}\0${reviewerUserId}`).digest('hex')}`
}

function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new TypeError('limit must be from 1 to 40')
  }
}

function validateCursor(document, id, kind) {
  if (!document) return null
  if (document._id !== id || document.kind !== kind ||
      document.cursorId !== null && (typeof document.cursorId !== 'string' || !DOCUMENT_ID.test(document.cursorId))) {
    throw new TypeError('reminder cursor is invalid')
  }
  return document.cursorId
}

async function readCandidates(query, limit) {
  const result = await query.limit(limit).get()
  return Array.isArray(result && result.data) ? result.data : []
}

function createCloudReminderRepository({ db } = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('db is required')
  }

  async function listDueProcessingReminders({ limit } = {}) {
    validateLimit(limit)
    const cursor = validateCursor(
      await readDocument(db, 'system_settings', PROCESSING_CURSOR_ID),
      PROCESSING_CURSOR_ID, 'workflow_reminder_processing')
    let query = db.collection('business_nodes')
      .where({
        workflowMode: 'review', processingDueStatus: 'calculated',
        ...(cursor ? { _id: db.command.gt(cursor) } : {})
      })
      .orderBy('_id', 'asc')
    let raw = await readCandidates(query, limit)
    if (!raw.length && cursor) {
      raw = await readCandidates(db.collection('business_nodes')
        .where({ workflowMode: 'review', processingDueStatus: 'calculated' })
        .orderBy('_id', 'asc'), limit)
    }
    return raw.map(node => ({
      nodeId: node._id,
      processingRoundNumber: node.processingRoundNumber,
      processingStartedAt: node.processingStartedAt,
      processingElapsedWorkMinutes: node.processingElapsedWorkMinutes,
      nextReminderWorkHour: node.nextProcessingReminderWorkHour
    }))
  }

  async function listDueReviewReminders({ limit } = {}) {
    validateLimit(limit)
    const cursor = validateCursor(
      await readDocument(db, 'system_settings', REVIEW_CURSOR_ID),
      REVIEW_CURSOR_ID, 'workflow_reminder_review')
    let query = db.collection('node_review_rounds')
      .where({
        status: 'pending', reviewDueStatus: 'calculated',
        ...(cursor ? { _id: db.command.gt(cursor) } : {})
      })
      .orderBy('_id', 'asc')
    let raw = await readCandidates(query, limit)
    if (!raw.length && cursor) {
      raw = await readCandidates(db.collection('node_review_rounds')
        .where({ status: 'pending', reviewDueStatus: 'calculated' })
        .orderBy('_id', 'asc'), limit)
    }
    const result = []
    for (const round of raw) {
      const reviewers = ownExactIds(round, 'reviewerUserIds', { nonEmpty: true })
      if (!reviewers) continue
      const votesResult = await db.collection('node_review_votes')
        .where({ reviewRoundId: round._id }).limit(reviewers.length + 1).get()
      const votes = Array.isArray(votesResult && votesResult.data) ? votesResult.data : []
      if (votes.length > reviewers.length) continue
      const votedReviewerUserIds = votes.map(vote => vote && vote.reviewerUserId)
      if (!exactIds(votedReviewerUserIds) || votedReviewerUserIds.some(id => !reviewers.includes(id))) continue
      result.push({
        reviewRoundId: round._id,
        nodeId: round.nodeId,
        reviewerUserIds: reviewers,
        votedReviewerUserIds,
        reviewStartedAt: round.reviewStartedAt,
        reviewElapsedWorkMinutes: round.reviewElapsedWorkMinutes,
        nextReminderWorkHour: round.nextReviewReminderWorkHour
      })
    }
    return result
  }

  async function createProcessingReminder(value = {}) {
    const hour = safeHour(value.accumulatedWorkHour)
    if (typeof value.nodeId !== 'string' || !DOCUMENT_ID.test(value.nodeId) ||
        !Number.isSafeInteger(value.processingRoundNumber) || value.processingRoundNumber < 1 || hour === null) {
      throw new TypeError('processing reminder input is invalid')
    }
    return db.runTransaction(async transaction => {
      const node = await readDocument(transaction, 'business_nodes', value.nodeId)
      const line = node && await readDocument(transaction, 'business_lines', node.businessLineId)
      if (!node || !line || node.workflowMode !== 'review' || !ACTIVE_LINE_STATUSES.has(line.status) ||
          line.currentNodeId !== node._id ||
          !ACTIVE_PROCESSING_STATUSES.has(node.status) ||
          node.processingRoundNumber !== value.processingRoundNumber ||
          node.processingDueStatus !== 'calculated' || !validDate(node.processingDueAt) ||
          typeof node.nodeCode !== 'string' || !node.nodeCode ||
          node.activeReviewRoundId !== null &&
          node.activeReviewRoundId !== undefined) return { created: false }
      const processors = ownExactIds(node, 'processorUserIds', { nonEmpty: true })
      const lineMembers = ownExactIds(line, 'memberUserIds', { nonEmpty: true })
      const lineManagers = ownExactIds(line, 'managerUserIds', { nonEmpty: true })
      if (!processors || !lineMembers || !lineManagers ||
          processors.some(id => !lineMembers.includes(id))) return { created: false }
      for (const processorId of processors) {
        const account = await readDocument(transaction, 'users', processorId)
        if (!account || account.status !== 'active') return { created: false }
      }
      const baseMinutes = safeMinutes(node.processingElapsedWorkMinutes)
      const storedNextHour = node.nextProcessingReminderWorkHour === undefined
        ? baseMinutes === null ? null : Math.floor(baseMinutes / 60) + 1
        : safeHour(node.nextProcessingReminderWorkHour)
      if (storedNextHour === null || storedNextHour !== hour) return { created: false }
      const notificationId = processingNotificationId(node.nodeCode, hour)
      const existing = await readDocument(transaction, 'notifications', notificationId)
      if (!existing) {
        await transaction.collection('notifications').doc(notificationId).set({ data: {
          type: 'processing_reminder',
          recipientUserIds: processors,
          businessLineId: line._id,
          nodeId: node._id,
          reviewRoundId: null,
          accumulatedWorkHour: hour,
          status: 'pending',
          createdAt: db.serverDate()
        } })
      }
      await transaction.collection('business_nodes').doc(node._id).update({ data: {
        nextProcessingReminderWorkHour: hour + 1,
        updatedAt: db.serverDate()
      } })
      return { created: !existing }
    })
  }

  async function createReviewReminder(value = {}) {
    const hour = safeHour(value.accumulatedWorkHour)
    if (typeof value.reviewRoundId !== 'string' || !DOCUMENT_ID.test(value.reviewRoundId) ||
        typeof value.nodeId !== 'string' || !DOCUMENT_ID.test(value.nodeId) ||
        typeof value.reviewerUserId !== 'string' || !DOCUMENT_ID.test(value.reviewerUserId) || hour === null) {
      throw new TypeError('review reminder input is invalid')
    }
    const notificationId = reviewNotificationId(value.reviewRoundId, value.reviewerUserId, hour)
    return db.runTransaction(async transaction => {
      const round = await readDocument(transaction, 'node_review_rounds', value.reviewRoundId)
      const node = await readDocument(transaction, 'business_nodes', value.nodeId)
      const line = node && await readDocument(transaction, 'business_lines', node.businessLineId)
      if (!round || !node || !line || round.nodeId !== node._id || round.businessLineId !== line._id ||
          node.workflowMode !== 'review' || !ACTIVE_LINE_STATUSES.has(line.status) ||
          line.currentNodeId !== node._id ||
          node.status !== 'pending_review' || node.activeReviewRoundId !== round._id ||
          round.status !== 'pending' || !['any', 'all'].includes(round.reviewMode) ||
          round.reviewMode !== node.reviewMode ||
          round.processingRoundNumber !== node.processingRoundNumber ||
          round.reviewRoundNumber !== node.reviewRoundNumber ||
          round.reviewDueStatus !== 'calculated' || !validDate(round.reviewDueAt) ||
          node.reviewDueStatus !== 'calculated') return { created: false }
      const nodeReviewers = ownExactIds(node, 'reviewerUserIds', { nonEmpty: true })
      const roundReviewers = ownExactIds(round, 'reviewerUserIds', { nonEmpty: true })
      const lineMembers = ownExactIds(line, 'memberUserIds', { nonEmpty: true })
      const lineManagers = ownExactIds(line, 'managerUserIds', { nonEmpty: true })
      if (!nodeReviewers || !roundReviewers || !lineMembers || !lineManagers ||
          nodeReviewers.length !== roundReviewers.length ||
          nodeReviewers.some((id, index) => id !== roundReviewers[index]) ||
          !roundReviewers.includes(value.reviewerUserId) ||
          roundReviewers.some(id => !lineMembers.includes(id))) return { created: false }
      const account = await readDocument(transaction, 'users', value.reviewerUserId)
      if (!account || account.status !== 'active') return { created: false }
      if (await readDocument(transaction, 'node_review_votes', voteId(round._id, value.reviewerUserId))) {
        return { created: false }
      }
      const baseMinutes = safeMinutes(round.reviewElapsedWorkMinutes)
      const storedNextHour = round.nextReviewReminderWorkHour === undefined
        ? baseMinutes === null ? null : Math.floor(baseMinutes / 60) + 1
        : safeHour(round.nextReviewReminderWorkHour)
      if (storedNextHour === null || storedNextHour !== hour) return { created: false }
      const existing = await readDocument(transaction, 'notifications', notificationId)
      if (!existing) {
        await transaction.collection('notifications').doc(notificationId).set({ data: {
          type: 'review_reminder',
          recipientUserIds: [value.reviewerUserId],
          businessLineId: line._id,
          nodeId: node._id,
          reviewRoundId: round._id,
          accumulatedWorkHour: hour,
          status: 'pending',
          createdAt: db.serverDate()
        } })
      }
      let hourComplete = true
      for (const reviewerUserId of roundReviewers) {
        const vote = await readDocument(transaction, 'node_review_votes', voteId(round._id, reviewerUserId))
        if (vote) continue
        const reviewerNotificationId = reviewNotificationId(round._id, reviewerUserId, hour)
        if (reviewerNotificationId === notificationId && !existing) continue
        if (!await readDocument(transaction, 'notifications', reviewerNotificationId)) {
          hourComplete = false
          break
        }
      }
      if (hourComplete) {
        await transaction.collection('node_review_rounds').doc(round._id).update({ data: {
          nextReviewReminderWorkHour: hour + 1,
          updatedAt: db.serverDate()
        } })
      }
      return { created: !existing }
    })
  }

  async function advanceReminderCursor(value = {}) {
    if (value.kind === 'processing' || value.kind === 'review') {
      if (typeof value.cursorId !== 'string' || !DOCUMENT_ID.test(value.cursorId)) {
        throw new TypeError('cursorId is invalid')
      }
      const processing = value.kind === 'processing'
      const id = processing ? PROCESSING_CURSOR_ID : REVIEW_CURSOR_ID
      await db.collection('system_settings').doc(id).set({ data: {
        kind: processing ? 'workflow_reminder_processing' : 'workflow_reminder_review',
        cursorId: value.cursorId,
        updatedAt: db.serverDate()
      } })
      return
    }
    throw new TypeError('reminder cursor kind is invalid')
  }

  async function getDayRule(dateKey) {
    if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      throw new TypeError('dateKey is invalid')
    }
    const year = Number(dateKey.slice(0, 4))
    const generation = await readDocument(db, 'work_calendar_years', String(year))
    if (!generation || generation.year !== year || typeof generation.sourceVersion !== 'string' ||
        !generation.sourceVersion || typeof generation.generationId !== 'string' || !generation.generationId) return null
    const recordId = `${generation.generationId}_${dateKey}`
    const record = await readDocument(db, 'work_calendar_entries', recordId)
    if (!record || record._id !== recordId || record.date !== dateKey ||
        record.sourceYear !== year || record.sourceVersion !== generation.sourceVersion ||
        record.generationId !== generation.generationId || typeof record.isWorkday !== 'boolean') return null
    return { date: dateKey, isWorkday: record.isWorkday, calendarVersion: record.sourceVersion }
  }

  return {
    getDayRule,
    listDueProcessingReminders,
    listDueReviewReminders,
    createProcessingReminder,
    createReviewReminder,
    advanceReminderCursor
  }
}

module.exports = {
  createCloudReminderRepository,
  processingNotificationId,
  reviewNotificationId
}
