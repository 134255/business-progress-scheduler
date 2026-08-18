const crypto = require('node:crypto')

const { FEEDBACK_TOTAL_LIMIT } = require('./evidence-policy')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { ownDataValue, ownExactAccountIds } = require('./account-relationship-schema')
const { deterministicVoteId } = require('./review-domain')
const { fitsIndexedAccountArray } = require('./index-key-budget')
const { isNotificationId } = require('./notification-id')

const ACTIVE_NODE_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const FROZEN_LINE_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const REVIEW_MODES = new Set(['any', 'all'])
const HASH = /^[a-f0-9]{64}$/
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const MAX_QUERY_WINDOW = 100
const NOTIFICATION_TYPES = new Set([
  'review_started',
  'review_reminder',
  'node_review_rejected',
  'business_completed',
  'node_processing_started',
  'processing_reminder',
  'work_calendar_missing',
  'evidence_retention'
])

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function clone(value) {
  if (value instanceof Date) return new Date(value)
  if (Array.isArray(value)) return value.map(clone)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
}

function isMissingDocumentError(error) {
  const codes = [error && error.code, error && error.errCode].map(value => String(value || '').toUpperCase())
  if (codes.includes('DOCUMENT_NOT_FOUND')) return true
  const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
  return text.includes('document.get:fail') && text.includes('document with _id') && text.includes('does not exist')
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function processingComment(value, { allowMissing = false, errorCode = 'VERSION_CONFLICT' } = {}) {
  if (!value || typeof value !== 'object') throw createError(errorCode)
  const descriptor = Object.getOwnPropertyDescriptor(value, 'processingComment')
  if (!descriptor) {
    if (allowMissing && !('processingComment' in value)) return ''
    throw createError(errorCode)
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      typeof descriptor.value !== 'string' || descriptor.value.length > 1000) {
    throw createError(errorCode)
  }
  return descriptor.value
}

function increment(value) {
  if (!safeInteger(value) || value === Number.MAX_SAFE_INTEGER) throw createError('VERSION_CONFLICT')
  return value + 1
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function persistedDecision(value) {
  if (value === 'approve') return 'approved'
  if (value === 'reject') return 'rejected'
  throw createError('VALIDATION_ERROR')
}

function validDisplayName(value, maximum) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null
}

function reviewerDisplayName(actor) {
  const displayNameField = ownDataValue(actor, 'displayName')
  const displayName = displayNameField.valid
    ? validDisplayName(displayNameField.value, 100)
    : null
  if (displayName) return displayName
  const usernameField = ownDataValue(actor, 'username')
  const username = usernameField.valid ? validDisplayName(usernameField.value, 64) : null
  if (username) return username
  throw createError('VERSION_CONFLICT')
}

function processorAssignmentMode(node) {
  const descriptor = node && Object.getOwnPropertyDescriptor(node, 'processorAssignmentMode')
  if (!descriptor) {
    if (node && !('processorAssignmentMode' in node)) return 'fixed_accounts'
    throw createError('VERSION_CONFLICT')
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      !['fixed_accounts', 'business_creator'].includes(descriptor.value)) {
    throw createError('VERSION_CONFLICT')
  }
  return descriptor.value
}

function lineMember(line, actorId) {
  const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
  const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
  return Boolean(managers && members && (managers.includes(actorId) || members.includes(actorId)))
}

function isCurrentNode(line, node) {
  return line && node && line.currentNodeId === node._id &&
    safeInteger(line.currentNodeIndex) && Number(node.sequence) === line.currentNodeIndex
}

function publicResult(round) {
  return {
    reviewRoundId: round._id,
    status: round.status,
    nodeStatus: 'pending_review',
    evidenceIds: clone(round.evidenceIds)
  }
}

function sameIds(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function voteResult(round, nodeStatus, lineStatus, nextNodeId = null) {
  return {
    reviewRoundId: round._id,
    status: round.status,
    nodeStatus,
    lineStatus,
    nextNodeId
  }
}

function instanceNodeId(lineId, sequence) {
  return `${lineId}-node-${String(sequence + 1).padStart(3, '0')}`
}

function createCloudReviewRepository({ db, clock = () => new Date() }) {
  if (!db) throw new TypeError('db is required')

  async function readDocument(database, collectionName, id) {
    try {
      const result = await database.collection(collectionName).doc(id).get()
      return result && result.data ? result.data : null
    } catch (error) {
      if (isMissingDocumentError(error)) return null
      throw error
    }
  }

  function now() {
    const value = clock()
    if (!validDate(value)) throw new TypeError('clock must return a Date')
    return new Date(value)
  }

  function readMarkerId(notificationId, actorId) {
    return `notification-read-${hash(`${notificationId}\0${actorId}`).slice(0, 48)}`
  }

  function safeAccount(account, actorId) {
    if (!account || account._id !== actorId || account.status !== 'active' ||
        typeof account._id !== 'string' || !DOCUMENT_ID.test(account._id)) {
      throw createError('FORBIDDEN')
    }
    const role = ownDataValue(account, 'role')
    if (role.present && (!role.valid || !['user', 'super_admin'].includes(role.value))) {
      throw createError('FORBIDDEN')
    }
    return { account, role: role.valid ? role.value : 'user' }
  }

  async function requireCurrentAccount(database, actor) {
    if (!actor || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id)) {
      throw createError('FORBIDDEN')
    }
    return safeAccount(await readDocument(database, 'users', actor._id), actor._id)
  }

  async function participantNameSnapshots(database, ids, knownAccount = null) {
    const names = []
    for (const id of ids) {
      const account = knownAccount && knownAccount._id === id
        ? knownAccount
        : await readDocument(database, 'users', id)
      safeAccount(account, id)
      names.push(reviewerDisplayName(account))
    }
    return names
  }

  function persistedNameSnapshots(round, key, count, placeholder) {
    const field = ownDataValue(round, key)
    if (!field.present) return Array.from({ length: count }, () => placeholder)
    if (!field.valid || !Array.isArray(field.value) || field.value.length !== count) {
      throw createError('FORBIDDEN')
    }
    const names = field.value.map(value => validDisplayName(value, 100))
    if (names.some(value => !value)) throw createError('FORBIDDEN')
    return names
  }

  function safeLineRelationships(line) {
    const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    if (!managers || !members) throw createError('FORBIDDEN')
    return { managers, members }
  }

  function safeRoundRelationships(line, node, round) {
    if (!line || line.status === 'creating' || line.status === 'deleted' || !node || !round ||
        node.businessLineId !== line._id || round.businessLineId !== line._id ||
        round.nodeId !== node._id || node.workflowMode !== 'review') throw createError('FORBIDDEN')
    const lineRelationships = safeLineRelationships(line)
    const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(node, 'reviewerUserIds', { nonEmpty: true })
    const roundReviewers = ownExactAccountIds(round, 'reviewerUserIds', { nonEmpty: true })
    const roundNumbersMatch = round.status === 'rejected' && node.lastReviewRoundId === round._id
      ? node.processingRoundNumber === round.processingRoundNumber + 1 &&
        node.reviewRoundNumber === round.reviewRoundNumber
      : round.processingRoundNumber === node.processingRoundNumber &&
        round.reviewRoundNumber === node.reviewRoundNumber
    if (!processors || !reviewers || !roundReviewers || !fitsIndexedAccountArray(processors) ||
        !fitsIndexedAccountArray(reviewers) || !sameIds(reviewers, roundReviewers) ||
        processors.some(id => reviewers.includes(id)) || !REVIEW_MODES.has(round.reviewMode) ||
        round.reviewMode !== node.reviewMode || !safeInteger(round.processingRoundNumber, 1) ||
        !safeInteger(round.reviewRoundNumber, 1) || !roundNumbersMatch) throw createError('FORBIDDEN')
    return { ...lineRelationships, processors, reviewers }
  }

  function currentPendingRound(line, node, round) {
    return line.status === 'active' && isCurrentNode(line, node) && node.status === 'pending_review' &&
      round.status === 'pending' && node.activeReviewRoundId === round._id &&
      node.version === round.lockedNodeVersion
  }

  function safeFieldValues(value) {
    if (!Array.isArray(value) || value.length > 50) throw createError('FORBIDDEN')
    return value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw createError('FORBIDDEN')
      const result = {}
      for (const key of ['fieldKey', 'name', 'type']) {
        const field = ownDataValue(item, key)
        if (!field.valid || typeof field.value !== 'string' || !field.value || field.value.length > 200) {
          throw createError('FORBIDDEN')
        }
        result[key] = field.value
      }
      const field = ownDataValue(item, 'value')
      const validPrimitive = field.valid && (field.value === null ||
        ['string', 'number', 'boolean'].includes(typeof field.value))
      const validArray = field.valid && Array.isArray(field.value) && field.value.length <= 100 &&
        field.value.every(entry => entry === null || ['string', 'number', 'boolean'].includes(typeof entry))
      if (!validPrimitive && !validArray) throw createError('FORBIDDEN')
      result.value = clone(field.value)
      return result
    })
  }

  function safeEvidenceIds(value) {
    if (!Array.isArray(value) || value.some(id =>
      typeof id !== 'string' || !DOCUMENT_ID.test(id)) || new Set(value).size !== value.length) {
      throw createError('FORBIDDEN')
    }
    return value.map(evidenceId => ({ evidenceId }))
  }

  function safeDate(value) {
    if (value === null || value === undefined) return null
    if (!validDate(value)) throw createError('FORBIDDEN')
    return new Date(value)
  }

  function safeReviewSummary(line, node, round, vote, actorId) {
    const hasVoted = Boolean(vote)
    return {
      reviewRoundId: round._id,
      businessLineId: line._id,
      businessCode: validDisplayName(line.code, 100) || '',
      businessName: validDisplayName(line.name, 200) || '',
      nodeId: node._id,
      nodeCode: validDisplayName(node.nodeCode, 100) || '',
      nodeName: validDisplayName(node.name, 200) || '',
      reviewMode: round.reviewMode,
      reviewRoundNumber: round.reviewRoundNumber,
      status: round.status,
      reviewDueStatus: round.reviewDueStatus,
      reviewDueAt: safeDate(round.reviewDueAt),
      reviewOverdueWorkMinutes: safeInteger(round.reviewOverdueWorkMinutes)
        ? round.reviewOverdueWorkMinutes
        : 0,
      hasVoted,
      canApprove: !hasVoted && round.status === 'pending' && round.reviewerUserIds.includes(actorId),
      canReject: !hasVoted && round.status === 'pending' && round.reviewerUserIds.includes(actorId),
      createdAt: safeDate(round.createdAt)
    }
  }

  function safeNotificationShape(notification, account) {
    if (!notification || !isNotificationId(notification._id) ||
        !NOTIFICATION_TYPES.has(notification.type)) return null
    const recipientsField = ownDataValue(notification, 'recipientUserIds')
    const roleField = ownDataValue(notification, 'audienceRole')
    const recipients = recipientsField.present
      ? ownExactAccountIds(notification, 'recipientUserIds', { nonEmpty: true })
      : null
    const direct = Boolean(recipients && recipients.includes(account._id))
    const role = roleField.valid && roleField.value === 'super_admin' && account.role === 'super_admin'
    if (recipientsField.present && !recipients || roleField.present &&
        (!roleField.valid || roleField.value !== 'super_admin') || direct === role || !direct && !role) {
      return null
    }
    const oldReads = ownDataValue(notification, 'readByUserIds')
    if (oldReads.present && !ownExactAccountIds(notification, 'readByUserIds')) return null
    return { direct, role, oldRead: oldReads.present && oldReads.value.includes(account._id) }
  }

  function assertBaseAuthorization(actor, line, node) {
    if (!actor || actor.status !== 'active' || typeof actor._id !== 'string') throw createError('FORBIDDEN')
    if (!line || line.status === 'creating' || !node || node.businessLineId !== line._id) throw createError('NOT_FOUND')
    if (FROZEN_LINE_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
    if (line.status !== 'active') throw createError('NODE_NOT_ACTIVE')
    if (node.workflowMode !== 'review') throw createError('VALIDATION_ERROR')
    const processors = ownExactAccountIds(node, 'processorUserIds')
    const reviewers = ownExactAccountIds(node, 'reviewerUserIds')
    if (!processors || !processors.length || !reviewers || !reviewers.length ||
        !fitsIndexedAccountArray(processors) || !fitsIndexedAccountArray(reviewers) ||
        processors.some(id => reviewers.includes(id)) || !lineMember(line, actor._id) ||
        !processors.includes(actor._id)) throw createError('FORBIDDEN')
    if (!isCurrentNode(line, node)) throw createError('NODE_NOT_ACTIVE')
    if (!REVIEW_MODES.has(node.reviewMode) || !safeInteger(node.processingRoundNumber, 1)) {
      throw createError('VERSION_CONFLICT')
    }
    return { processors, reviewers }
  }

  function assertVoteRelationships(actor, line, node, round) {
    if (!actor || actor.status !== 'active' || typeof actor._id !== 'string' ||
        !DOCUMENT_ID.test(actor._id)) throw createError('FORBIDDEN')
    if (!line || !node || !round || node.businessLineId !== line._id ||
        round.businessLineId !== line._id || round.nodeId !== node._id) throw createError('FORBIDDEN')
    const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(node, 'reviewerUserIds', { nonEmpty: true })
    const roundReviewers = ownExactAccountIds(round, 'reviewerUserIds', { nonEmpty: true })
    if (!managers || !members || !processors || !reviewers || !roundReviewers ||
        !fitsIndexedAccountArray(processors) || !fitsIndexedAccountArray(reviewers) ||
        !sameIds(reviewers, roundReviewers) || processors.some(id => reviewers.includes(id)) ||
        !members.includes(actor._id) && !managers.includes(actor._id) ||
        !reviewers.includes(actor._id) || !roundReviewers.includes(actor._id)) {
      throw createError('FORBIDDEN')
    }
    return { processors, reviewers }
  }

  function assertVoteAuthorization(actor, line, node, round, input) {
    const relationships = assertVoteRelationships(actor, line, node, round)
    if (FROZEN_LINE_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
    if (line.status !== 'active') throw createError('NODE_NOT_ACTIVE')
    if (!isCurrentNode(line, node)) throw createError('NODE_NOT_ACTIVE')
    if (node.workflowMode !== 'review' || node.status !== 'pending_review' ||
        node.activeReviewRoundId !== round._id || round.status !== 'pending' ||
        !REVIEW_MODES.has(node.reviewMode) || round.reviewMode !== node.reviewMode ||
        !safeInteger(node.processingRoundNumber, 1) ||
        round.processingRoundNumber !== node.processingRoundNumber ||
        !safeInteger(node.reviewRoundNumber, 1) || round.reviewRoundNumber !== node.reviewRoundNumber ||
        node.version !== round.lockedNodeVersion || round.version !== input.expectedRoundVersion ||
        input.reviewRoundId !== round._id) {
      throw createError('VERSION_CONFLICT')
    }
    return relationships
  }

  function assertMatchingVote(vote, actor, round, value) {
    if (!vote || vote.reviewRoundId !== round._id || vote.reviewerUserId !== actor._id ||
        vote.requestKeyHash !== value.requestKeyHash || vote.inputHash !== value.inputHash ||
        vote.expectedRoundVersion !== value.input.expectedRoundVersion ||
        vote.decision !== persistedDecision(value.input.decision) ||
        !validDisplayName(vote.reviewerDisplayName, 100) || vote.comment !== value.input.comment) {
      throw createError(vote ? 'VOTE_CONFLICT' : 'VERSION_CONFLICT')
    }
  }

  function terminalCarryoverStateValid(round, kind, pending) {
    const review = kind === 'review'
    const statusKey = review ? 'reviewTimingCarryoverStatus' : 'processingCarryoverStatus'
    const startedKey = review ? 'reviewTimingCarryoverStartedAt' : 'processingCarryoverStartedAt'
    const endedKey = review ? 'reviewTimingCarryoverEndedAt' : 'processingCarryoverEndedAt'
    const baseKey = review
      ? 'reviewTimingCarryoverBaseElapsedWorkMinutes'
      : 'processingCarryoverBaseElapsedWorkMinutes'
    const totalKey = review
      ? 'reviewTimingCarryoverTotalWorkMinutes'
      : 'processingCarryoverTotalWorkMinutes'
    const resolvedKey = review ? 'reviewTimingCarryoverResolvedAt' : 'processingCarryoverResolvedAt'
    const fields = [statusKey, startedKey, endedKey, baseKey, totalKey, resolvedKey]
    if (!pending) return fields.every(key => round[key] === undefined || round[key] === null)
    const status = round[statusKey]
    const startedAt = round[startedKey]
    const endedAt = round[endedKey]
    const base = round[baseKey]
    const total = round[totalKey]
    if (!['pending', 'resolved'].includes(status) || !validDate(startedAt) ||
        !validDate(endedAt) || startedAt.getTime() > endedAt.getTime() ||
        !safeInteger(base) || !safeInteger(total, 1)) return false
    if (review && (!sameDateValue(startedAt, round.reviewStartedAt) ||
        !sameDateValue(endedAt, round.decidedAt) || total !== round.reviewSlaWorkHours * 60)) {
      return false
    }
    const prefix = review ? 'review' : 'processing'
    const timingStatus = round[`${prefix}TimingStatus`]
    const elapsed = round[`${prefix}ElapsedWorkMinutes`]
    const remaining = round[`${prefix}RemainingWorkMinutes`]
    const overdue = round[`${prefix}OverdueWorkMinutes`]
    const calendarVersion = round[`${prefix}CalendarVersion`]
    if (!safeInteger(elapsed) || !safeInteger(remaining) || !safeInteger(overdue) ||
        elapsed < base || remaining !== Math.max(0, total - elapsed) ||
        overdue !== Math.max(0, elapsed - total)) return false
    return status === 'pending'
      ? timingStatus === 'pending_calendar' && elapsed === base && calendarVersion === null &&
          (round[resolvedKey] === undefined || round[resolvedKey] === null)
      : timingStatus === 'calculated' && validDisplayName(calendarVersion, 200) !== null &&
          validDate(round[resolvedKey])
  }

  function assertFinalRetryAuthorization(actor, line, node, round, input) {
    assertVoteRelationships(actor, line, node, round)
    const baseRoundVersion = input.expectedRoundVersion + 1
    const baseNodeVersion = round.lockedNodeVersion + 1
    const processingPending = round.resultProcessingCarryoverPending === true
    const reviewPending = round.resultReviewCarryoverPending === true
    const processingStateValid = terminalCarryoverStateValid(round, 'processing', processingPending)
    const reviewStateValid = terminalCarryoverStateValid(round, 'review', reviewPending)
    const resolvedCount = Number(processingPending && round.processingCarryoverStatus === 'resolved') +
      Number(reviewPending && round.reviewTimingCarryoverStatus === 'resolved')
    const exactFinalVersion = round.version === baseRoundVersion + resolvedCount &&
      node.version === baseNodeVersion + resolvedCount
    if (!['approved', 'rejected'].includes(round.status) ||
        input.reviewRoundId !== round._id || !processingStateValid || !reviewStateValid ||
        typeof round.resultProcessingCarryoverPending !== 'boolean' ||
        typeof round.resultReviewCarryoverPending !== 'boolean' || !exactFinalVersion ||
        round.resultRoundVersion !== baseRoundVersion || round.resultNodeVersion !== baseNodeVersion ||
        round.resultLockedNodeVersion !== round.lockedNodeVersion ||
        round.resultReviewMode !== round.reviewMode || round.resultReviewMode !== node.reviewMode ||
        round.resultProcessingRoundNumber !== round.processingRoundNumber ||
        round.resultReviewRoundNumber !== round.reviewRoundNumber ||
        node.workflowMode !== 'review' || node.activeReviewRoundId !== undefined &&
        node.activeReviewRoundId !== null ||
        !['completed', 'in_progress'].includes(round.resultNodeStatus) ||
        !['active', 'completed'].includes(round.resultLineStatus) ||
        round.status === 'rejected' && (round.resultNodeStatus !== 'in_progress' ||
          round.resultLineStatus !== 'active' || round.resultNextNodeId !== null ||
          line.status !== 'active' || !isCurrentNode(line, node) || node.status !== 'in_progress' ||
          node.processingRoundNumber !== round.processingRoundNumber + 1) ||
        round.status === 'approved' && (round.resultNodeStatus !== 'completed' ||
          node.status !== 'completed' || round.resultLineStatus === 'completed' &&
          (line.status !== 'completed' || round.resultNextNodeId !== null) ||
          round.resultLineStatus === 'active' &&
          (line.status !== 'active' || typeof round.resultNextNodeId !== 'string' ||
            line.currentNodeId !== round.resultNextNodeId || line.currentNodeIndex !== node.sequence + 1))) {
      throw createError('VERSION_CONFLICT')
    }
    return voteResult(round, round.resultNodeStatus, round.resultLineStatus, round.resultNextNodeId)
  }

  function validateVoteInput(value, requireContext = false) {
    if (!value || !value.actor || !value.input ||
        typeof value.actor._id !== 'string' || !DOCUMENT_ID.test(value.actor._id) ||
        typeof value.input.reviewRoundId !== 'string' || !DOCUMENT_ID.test(value.input.reviewRoundId) ||
        !safeInteger(value.input.expectedRoundVersion, 1) ||
        !['approve', 'reject'].includes(value.input.decision) ||
        typeof value.input.comment !== 'string' || value.input.comment.length > 1000 ||
        value.input.decision === 'reject' && !value.input.comment.trim() || requireContext &&
        (!value.context || !value.timing || !HASH.test(value.requestKeyHash || '') ||
          !HASH.test(value.inputHash || ''))) {
      throw createError('VALIDATION_ERROR')
    }
  }

  function safeVoteCounts(round, reviewerCount) {
    const approvedVoteCount = round.approvedVoteCount === undefined ? 0 : round.approvedVoteCount
    const voteCount = round.voteCount === undefined ? 0 : round.voteCount
    if (!safeInteger(approvedVoteCount) || !safeInteger(voteCount) ||
        approvedVoteCount > voteCount || voteCount > reviewerCount) {
      throw createError('VERSION_CONFLICT')
    }
    return { approvedVoteCount, voteCount }
  }

  function validateDueTiming(timing, transition, expectedMinutes) {
    if (!timing || !validDate(timing.transitionAt)) throw createError('VERSION_CONFLICT')
    if (transition === 'complete_line') return
    if (!safeInteger(expectedMinutes) ||
        !['calculated', 'pending_calendar'].includes(timing.processingDueStatus)) {
      throw createError('VERSION_CONFLICT')
    }
    if (timing.processingDueStatus === 'calculated') {
      if (!validDate(timing.processingDueAt) ||
          timing.processingCalendarVersion !== null &&
          (typeof timing.processingCalendarVersion !== 'string' || !timing.processingCalendarVersion)) {
        throw createError('VERSION_CONFLICT')
      }
    } else if (timing.processingDueAt !== null || timing.processingCalendarVersion !== null) {
      throw createError('VERSION_CONFLICT')
    }
  }

  function reviewTimingContext(round) {
    const total = round && round.reviewSlaWorkHours * 60
    const base = round && round.reviewElapsedWorkMinutes
    if (!round || !validDate(round.reviewStartedAt) || !safeInteger(total, 1) ||
        !safeInteger(base) || !safeInteger(round.reviewRemainingWorkMinutes) ||
        !safeInteger(round.reviewOverdueWorkMinutes) ||
        round.reviewRemainingWorkMinutes !== Math.max(0, total - base) ||
        round.reviewOverdueWorkMinutes !== Math.max(0, base - total)) {
      throw createError('VERSION_CONFLICT')
    }
    return {
      reviewStartedAt: new Date(round.reviewStartedAt),
      reviewTotalWorkMinutes: total,
      reviewBaseElapsedWorkMinutes: base
    }
  }

  function validateCompletedReviewTiming(timing, context, round) {
    const expected = reviewTimingContext(round)
    if (!context || !sameDateValue(context.reviewStartedAt, expected.reviewStartedAt) ||
        context.reviewTotalWorkMinutes !== expected.reviewTotalWorkMinutes ||
        context.reviewBaseElapsedWorkMinutes !== expected.reviewBaseElapsedWorkMinutes ||
        !['calculated', 'pending_calendar'].includes(timing.reviewTimingStatus) ||
        !safeInteger(timing.reviewElapsedWorkMinutes) ||
        !safeInteger(timing.reviewRemainingWorkMinutes) ||
        !safeInteger(timing.reviewOverdueWorkMinutes) ||
        timing.reviewRemainingWorkMinutes !== Math.max(0,
          expected.reviewTotalWorkMinutes - timing.reviewElapsedWorkMinutes) ||
        timing.reviewOverdueWorkMinutes !== Math.max(0,
          timing.reviewElapsedWorkMinutes - expected.reviewTotalWorkMinutes) ||
        timing.reviewElapsedWorkMinutes < expected.reviewBaseElapsedWorkMinutes) {
      throw createError('VERSION_CONFLICT')
    }
    if (timing.reviewTimingStatus === 'calculated') {
      if (timing.reviewCalendarVersion !== null &&
          (typeof timing.reviewCalendarVersion !== 'string' || !timing.reviewCalendarVersion)) {
        throw createError('VERSION_CONFLICT')
      }
    } else if (timing.reviewElapsedWorkMinutes !== expected.reviewBaseElapsedWorkMinutes ||
        timing.reviewCalendarVersion !== null) throw createError('VERSION_CONFLICT')
    return expected
  }

  function sameDateValue(left, right) {
    return validDate(left) && validDate(right) && left.getTime() === right.getTime()
  }

  function completedReviewTiming(round, timing, at) {
    const fields = [
      'reviewTimingCarryoverStatus', 'reviewTimingCarryoverStartedAt',
      'reviewTimingCarryoverEndedAt', 'reviewTimingCarryoverBaseElapsedWorkMinutes',
      'reviewTimingCarryoverTotalWorkMinutes'
    ]
    if (fields.some(key => round[key] !== undefined && round[key] !== null)) {
      throw createError('VERSION_CONFLICT')
    }
    const data = {
      reviewTimingStatus: timing.reviewTimingStatus,
      reviewElapsedWorkMinutes: timing.reviewElapsedWorkMinutes,
      reviewRemainingWorkMinutes: timing.reviewRemainingWorkMinutes,
      reviewOverdueWorkMinutes: timing.reviewOverdueWorkMinutes,
      reviewCalendarVersion: timing.reviewCalendarVersion
    }
    if (timing.reviewTimingStatus === 'pending_calendar') {
      Object.assign(data, {
        reviewTimingCarryoverStatus: 'pending',
        reviewTimingCarryoverStartedAt: new Date(round.reviewStartedAt),
        reviewTimingCarryoverEndedAt: new Date(at),
        reviewTimingCarryoverBaseElapsedWorkMinutes: round.reviewElapsedWorkMinutes,
        reviewTimingCarryoverTotalWorkMinutes: round.reviewSlaWorkHours * 60
      })
    }
    return data
  }

  function processingCarryover(node, round) {
    const fields = [
      'processingCarryoverStatus', 'processingCarryoverStartedAt',
      'processingCarryoverEndedAt', 'processingCarryoverBaseElapsedWorkMinutes',
      'processingCarryoverTotalWorkMinutes'
    ]
    if (round.processingTimingStatus === 'calculated') {
      if (node.processingTimingStatus !== 'calculated' || fields.some(key =>
        round[key] !== undefined && round[key] !== null)) throw createError('VERSION_CONFLICT')
      return null
    }
    const total = node.processingSlaWorkHours * 60
    if (round.processingTimingStatus !== 'pending_calendar' ||
        node.processingTimingStatus !== 'pending_calendar' ||
        !validDate(node.processingStartedAt) || !validDate(round.reviewStartedAt) ||
        node.processingStartedAt.getTime() > round.reviewStartedAt.getTime() ||
        !safeInteger(total, 1) ||
        !safeInteger(round.processingElapsedWorkMinutes) ||
        round.processingElapsedWorkMinutes !== node.processingElapsedWorkMinutes ||
        round.processingRemainingWorkMinutes !== node.processingRemainingWorkMinutes ||
        round.processingOverdueWorkMinutes !== node.processingOverdueWorkMinutes ||
        round.processingCalendarVersion !== null || node.processingCalendarVersion !== null ||
        fields.some(key => round[key] !== undefined && round[key] !== null)) {
      throw createError('VERSION_CONFLICT')
    }
    return {
      processingCarryoverStatus: 'pending',
      processingCarryoverStartedAt: new Date(node.processingStartedAt),
      processingCarryoverEndedAt: new Date(round.reviewStartedAt),
      processingCarryoverBaseElapsedWorkMinutes: round.processingElapsedWorkMinutes,
      processingCarryoverTotalWorkMinutes: total
    }
  }

  function validateDraft(value, node, feedback) {
    const { draft } = value
    const draftComment = ownDataValue(draft, 'processingComment')
    const feedbackComment = ownDataValue(feedback, 'comment')
    if (!draft || typeof draft.feedbackId !== 'string' || !DOCUMENT_ID.test(draft.feedbackId) ||
        !safeInteger(draft.feedbackRevision, 1) ||
        draft.processingRoundNumber !== node.processingRoundNumber ||
        !draftComment.valid || typeof draftComment.value !== 'string' ||
        draftComment.value.length > 1000 ||
        !Array.isArray(draft.fieldSnapshots) || !Array.isArray(draft.evidenceIds) ||
        draft.evidenceIds.some(id => typeof id !== 'string' || !DOCUMENT_ID.test(id)) ||
        new Set(draft.evidenceIds).size !== draft.evidenceIds.length ||
        !safeInteger(draft.evidenceTotalBytes) || draft.evidenceTotalBytes > FEEDBACK_TOTAL_LIMIT ||
        node.latestFeedbackId !== draft.feedbackId || node.latestFeedbackRevision !== draft.feedbackRevision ||
        !feedback || feedback._id !== draft.feedbackId || feedback.publishState !== 'published' ||
        feedback.businessLineId !== value.input.businessLineId || feedback.nodeId !== value.input.nodeId ||
        feedback.revision !== draft.feedbackRevision ||
        feedback.processingRoundNumber !== draft.processingRoundNumber ||
        !feedbackComment.valid || typeof feedbackComment.value !== 'string' ||
        feedbackComment.value.length > 1000 || feedbackComment.value !== draftComment.value ||
        !['save_progress', 'mark_blocked'].includes(feedback.action)) {
      throw createError('VERSION_CONFLICT')
    }
  }

  function validateTiming(timing, node) {
    const processingTotal = node && node.processingSlaWorkHours * 60
    const reviewTotal = node && node.reviewSlaWorkHours * 60
    if (!timing || !['calculated', 'pending_calendar'].includes(timing.processingTimingStatus) ||
        !safeInteger(timing.processingElapsedWorkMinutes) ||
        !safeInteger(timing.processingRemainingWorkMinutes) ||
        !safeInteger(timing.processingOverdueWorkMinutes) || !validDate(timing.reviewStartedAt) ||
        !['calculated', 'pending_calendar'].includes(timing.processingRoundTimingStatus) ||
        !validDate(timing.processingRoundStartedAt) || !validDate(timing.processingRoundEndedAt) ||
        !sameDateValue(timing.processingRoundStartedAt, node.processingStartedAt) ||
        !sameDateValue(timing.processingRoundEndedAt, timing.reviewStartedAt) ||
        !safeInteger(timing.reviewRemainingWorkMinutes, 1) ||
        !['calculated', 'pending_calendar'].includes(timing.reviewDueStatus) ||
        !safeInteger(timing.reviewElapsedWorkMinutes) || !safeInteger(timing.reviewOverdueWorkMinutes) ||
        !safeInteger(processingTotal, 1) || !safeInteger(reviewTotal, 1) ||
        timing.processingRemainingWorkMinutes !== Math.max(0, processingTotal - timing.processingElapsedWorkMinutes) ||
        timing.processingOverdueWorkMinutes !== Math.max(0, timing.processingElapsedWorkMinutes - processingTotal) ||
        timing.reviewRemainingWorkMinutes !== reviewTotal || timing.reviewElapsedWorkMinutes !== 0 ||
        timing.reviewOverdueWorkMinutes !== 0) {
      throw createError('VERSION_CONFLICT')
    }
    const previous = node.processingElapsedWorkMinutes === undefined
      ? 0
      : node.processingElapsedWorkMinutes
    if (!safeInteger(previous)) throw createError('VERSION_CONFLICT')
    if (timing.processingRoundTimingStatus === 'calculated') {
      if (!safeInteger(timing.processingRoundWorkMinutes) ||
          timing.processingElapsedWorkMinutes !== previous + timing.processingRoundWorkMinutes ||
          timing.processingRoundCalendarVersion !== timing.processingCalendarVersion) {
        throw createError('VERSION_CONFLICT')
      }
    } else if (timing.processingRoundWorkMinutes !== null ||
        timing.processingRoundCalendarVersion !== null ||
        timing.processingTimingStatus !== 'pending_calendar' ||
        timing.processingElapsedWorkMinutes !== previous) {
      throw createError('VERSION_CONFLICT')
    }
    if (timing.reviewDueStatus === 'calculated') {
      if (!validDate(timing.reviewDueAt)) throw createError('VERSION_CONFLICT')
    } else if (timing.reviewDueAt !== null) throw createError('VERSION_CONFLICT')
  }

  function assertIdempotentRound(round, node, value, roundId) {
    const processingSnapshotFields = [
      'submittedByDisplayName', 'processorAssignmentMode',
      'processingRoundTimingStatus', 'processingRoundWorkMinutes',
      'processingRoundCalendarVersion', 'processingRoundStartedAt',
      'processingRoundEndedAt', 'processingAttributionHash'
    ]
    const presentProcessingSnapshotFields = processingSnapshotFields.filter(key =>
      Object.prototype.hasOwnProperty.call(round || {}, key))
    const legacyProcessingSnapshot = presentProcessingSnapshotFields.length === 0
    if (!legacyProcessingSnapshot) {
      const calculated = round.processingRoundTimingStatus === 'calculated'
      const pending = round.processingRoundTimingStatus === 'pending_calendar'
      if (presentProcessingSnapshotFields.length !== processingSnapshotFields.length ||
          !validDisplayName(round.submittedByDisplayName, 100) ||
          round.processorAssignmentMode !== processorAssignmentMode(node) ||
          !sameDateValue(round.processingRoundStartedAt, node.processingStartedAt) ||
          !sameDateValue(round.processingRoundEndedAt, round.reviewStartedAt) ||
          !['calculated', 'pending_calendar'].includes(round.processingTimingStatus) ||
          round.processingTimingStatus !== node.processingTimingStatus ||
          round.processingElapsedWorkMinutes !== node.processingElapsedWorkMinutes ||
          round.processingRemainingWorkMinutes !== node.processingRemainingWorkMinutes ||
          round.processingOverdueWorkMinutes !== node.processingOverdueWorkMinutes ||
          round.processingCalendarVersion !== node.processingCalendarVersion ||
          calculated && (!safeInteger(round.processingRoundWorkMinutes) ||
            round.processingRoundCalendarVersion !== round.processingCalendarVersion) ||
          pending && (round.processingRoundWorkMinutes !== null ||
            round.processingRoundCalendarVersion !== null ||
            round.processingTimingStatus !== 'pending_calendar') ||
          round.processingAttributionHash !== hash(JSON.stringify([
            round.submittedBy, round.submittedByDisplayName, round.processorAssignmentMode,
            round.processingRoundTimingStatus, round.processingRoundWorkMinutes,
            round.processingRoundCalendarVersion,
            round.processingRoundStartedAt.toISOString(), round.processingRoundEndedAt.toISOString()
          ]))) {
        throw createError('VERSION_CONFLICT')
      }
    }
    if (!round || round._id !== roundId || round.businessLineId !== value.input.businessLineId ||
        round.nodeId !== value.input.nodeId || round.status !== 'pending' ||
        round.requestKeyHash !== value.requestKeyHash || round.inputHash !== value.inputHash ||
        round.draftHash !== value.draftHash ||
        round.submittedBy !== value.actor._id ||
        round.submittedNodeVersion !== value.input.expectedNodeVersion ||
        node.status !== 'pending_review' || node.activeReviewRoundId !== roundId ||
        node.version !== round.lockedNodeVersion ||
        node.processingRoundNumber !== round.processingRoundNumber ||
        round.feedbackId !== value.draft.feedbackId ||
        round.feedbackRevision !== value.draft.feedbackRevision ||
        round.processingRoundNumber !== value.draft.processingRoundNumber ||
        processingComment(round) !== value.draft.processingComment ||
        round.evidenceTotalBytes !== value.draft.evidenceTotalBytes ||
        JSON.stringify(round.fieldValues) !== JSON.stringify(value.draft.fieldSnapshots) ||
        JSON.stringify(round.evidenceIds) !== JSON.stringify(value.draft.evidenceIds)) {
      throw createError('VERSION_CONFLICT')
    }
  }

  function validateRetryIdentity(value, requireDraft = false) {
    if (!value || !value.actor || !value.input ||
        typeof value.input.businessLineId !== 'string' || !DOCUMENT_ID.test(value.input.businessLineId) ||
        typeof value.input.nodeId !== 'string' || !DOCUMENT_ID.test(value.input.nodeId) ||
        !safeInteger(value.input.expectedNodeVersion, 1) ||
        !HASH.test(value.requestKeyHash || '') || !HASH.test(value.inputHash || '') || requireDraft &&
        (!value.draft || !HASH.test(value.draftHash || '') || typeof value.reviewRoundId !== 'string' ||
          !DOCUMENT_ID.test(value.reviewRoundId))) {
      throw createError('VALIDATION_ERROR')
    }
  }

  async function inspectReviewRoundRetry(value) {
    validateRetryIdentity(value)
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, 'users', value.actor._id)
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      assertBaseAuthorization(actor, line, node)
      if (node.status !== 'pending_review') {
        if (!ACTIVE_NODE_STATUSES.has(node.status) || node.version !== value.input.expectedNodeVersion ||
            node.activeReviewRoundId !== undefined && node.activeReviewRoundId !== null) {
          throw createError('VERSION_CONFLICT')
        }
        return null
      }
      if (typeof node.activeReviewRoundId !== 'string' || !DOCUMENT_ID.test(node.activeReviewRoundId)) {
        throw createError('VERSION_CONFLICT')
      }
      const round = await readDocument(transaction, 'node_review_rounds', node.activeReviewRoundId)
      if (!round || round.businessLineId !== line._id || round.nodeId !== node._id ||
          round.status !== 'pending' || round.submittedBy !== actor._id ||
          round.submittedNodeVersion !== value.input.expectedNodeVersion ||
          round.lockedNodeVersion !== node.version ||
          round.processingRoundNumber !== node.processingRoundNumber ||
          round.requestKeyHash !== value.requestKeyHash || round.inputHash !== value.inputHash) {
        throw createError('VERSION_CONFLICT')
      }
      return { reviewRoundId: round._id }
    })
  }

  async function findReviewRoundRetry(value) {
    validateRetryIdentity(value, true)
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, 'users', value.actor._id)
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      assertBaseAuthorization(actor, line, node)
      if (node.status !== 'pending_review' || node.activeReviewRoundId !== value.reviewRoundId) {
        throw createError('VERSION_CONFLICT')
      }
      const round = await readDocument(transaction, 'node_review_rounds', value.reviewRoundId)
      const feedback = await readDocument(transaction, 'node_feedback', value.draft.feedbackId)
      validateDraft(value, node, feedback)
      const recomputedDraftHash = hash(JSON.stringify([
        actor._id, value.input.businessLineId, value.input.nodeId, value.input.expectedNodeVersion,
        value.draft.feedbackId, value.draft.feedbackRevision, value.draft.processingRoundNumber,
        value.draft.processingComment, value.draft.fieldSnapshots,
        value.draft.evidenceIds, value.draft.evidenceTotalBytes
      ]))
      if (recomputedDraftHash !== value.draftHash) throw createError('VERSION_CONFLICT')
      assertIdempotentRound(round, node, value, value.reviewRoundId)
      return publicResult(round)
    })
  }

  async function createReviewRound(value) {
    if (!value || !value.actor || !value.input || !value.draft ||
        typeof value.input.businessLineId !== 'string' || !DOCUMENT_ID.test(value.input.businessLineId) ||
        typeof value.input.nodeId !== 'string' || !DOCUMENT_ID.test(value.input.nodeId) ||
        !safeInteger(value.input.expectedNodeVersion, 1) ||
        !HASH.test(value.requestKeyHash || '') || !HASH.test(value.inputHash || '') ||
        !HASH.test(value.draftHash || '')) {
      throw createError('VALIDATION_ERROR')
    }
    const roundId = `review-${value.draft.feedbackId}`
    const at = now()
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, 'users', value.actor._id)
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      const { processors, reviewers } = assertBaseAuthorization(actor, line, node)
      const existing = await readDocument(transaction, 'node_review_rounds', roundId)
      if (existing) {
        const feedback = await readDocument(transaction, 'node_feedback', value.draft.feedbackId)
        validateDraft(value, node, feedback)
        assertIdempotentRound(existing, node, value, roundId)
        return publicResult(existing)
      }
      if (node.version !== value.input.expectedNodeVersion) throw createError('VERSION_CONFLICT')
      if (!ACTIVE_NODE_STATUSES.has(node.status)) throw createError('NODE_NOT_ACTIVE')
      if (node.activeReviewRoundId !== undefined && node.activeReviewRoundId !== null) {
        throw createError('VERSION_CONFLICT')
      }
      validateTiming(value.timing, node)
      const feedback = await readDocument(transaction, 'node_feedback', value.draft.feedbackId)
      validateDraft(value, node, feedback)
      const processorDisplayNames = await participantNameSnapshots(transaction, processors, actor)
      const reviewerDisplayNames = await participantNameSnapshots(transaction, reviewers)
      const lockedNodeVersion = increment(node.version)
      const reviewRoundNumber = increment(node.reviewRoundNumber === undefined ? 0 : node.reviewRoundNumber)
      const round = {
        businessLineId: line._id,
        nodeId: node._id,
        nodeCode: node.nodeCode,
        nodeName: node.name,
        processingRoundNumber: node.processingRoundNumber,
        reviewRoundNumber,
        reviewMode: node.reviewMode,
        reviewerUserIds: clone(reviewers),
        processorDisplayNames,
        reviewerDisplayNames,
        feedbackId: value.draft.feedbackId,
        feedbackRevision: value.draft.feedbackRevision,
        processingComment: value.draft.processingComment,
        fieldValues: clone(value.draft.fieldSnapshots),
        evidenceIds: clone(value.draft.evidenceIds),
        evidenceTotalBytes: value.draft.evidenceTotalBytes,
        status: 'pending',
        submittedBy: actor._id,
        submittedByDisplayName: reviewerDisplayName(actor),
        processorAssignmentMode: processorAssignmentMode(node),
        submittedNodeVersion: node.version,
        lockedNodeVersion,
        requestKeyHash: value.requestKeyHash,
        inputHash: value.inputHash,
        draftHash: value.draftHash,
        reviewSlaWorkHours: node.reviewSlaWorkHours,
        reviewStartedAt: new Date(value.timing.reviewStartedAt),
        reviewRemainingWorkMinutes: value.timing.reviewRemainingWorkMinutes,
        reviewElapsedWorkMinutes: value.timing.reviewElapsedWorkMinutes,
        reviewOverdueWorkMinutes: value.timing.reviewOverdueWorkMinutes,
        reviewDueStatus: value.timing.reviewDueStatus,
        reviewDueAt: value.timing.reviewDueAt === null ? null : new Date(value.timing.reviewDueAt),
        reviewCalendarVersion: value.timing.reviewCalendarVersion || null,
        processingTimingStatus: value.timing.processingTimingStatus,
        processingElapsedWorkMinutes: value.timing.processingElapsedWorkMinutes,
        processingRemainingWorkMinutes: value.timing.processingRemainingWorkMinutes,
        processingOverdueWorkMinutes: value.timing.processingOverdueWorkMinutes,
        processingCalendarVersion: value.timing.processingCalendarVersion || null,
        processingRoundTimingStatus: value.timing.processingRoundTimingStatus,
        processingRoundWorkMinutes: value.timing.processingRoundWorkMinutes,
        processingRoundCalendarVersion: value.timing.processingRoundCalendarVersion,
        processingRoundStartedAt: new Date(value.timing.processingRoundStartedAt),
        processingRoundEndedAt: new Date(value.timing.processingRoundEndedAt),
        calendarNotificationStatus: value.timing.reviewDueStatus === 'pending_calendar' ? 'pending' : 'not_required',
        version: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      round.processingAttributionHash = hash(JSON.stringify([
        round.submittedBy, round.submittedByDisplayName, round.processorAssignmentMode,
        round.processingRoundTimingStatus, round.processingRoundWorkMinutes,
        round.processingRoundCalendarVersion,
        round.processingRoundStartedAt.toISOString(), round.processingRoundEndedAt.toISOString()
      ]))
      await transaction.collection('node_review_rounds').doc(roundId).set({ data: round })
      await transaction.collection('business_nodes').doc(node._id).update({ data: {
        status: 'pending_review',
        activeReviewRoundId: roundId,
        reviewRoundNumber,
        reviewStartedAt: new Date(value.timing.reviewStartedAt),
        reviewDueStatus: value.timing.reviewDueStatus,
        reviewDueAt: value.timing.reviewDueAt === null ? null : new Date(value.timing.reviewDueAt),
        reviewCalendarVersion: value.timing.reviewCalendarVersion || null,
        processingTimingStatus: value.timing.processingTimingStatus,
        processingElapsedWorkMinutes: value.timing.processingElapsedWorkMinutes,
        processingRemainingWorkMinutes: value.timing.processingRemainingWorkMinutes,
        processingOverdueWorkMinutes: value.timing.processingOverdueWorkMinutes,
        processingCalendarVersion: value.timing.processingCalendarVersion || null,
        version: lockedNodeVersion,
        updatedAt: db.serverDate()
      } })
      const notificationId = `review-start-${hash(roundId).slice(0, 40)}`
      await transaction.collection('notifications').doc(notificationId).set({ data: {
        type: 'review_started',
        recipientUserIds: clone(reviewers),
        businessLineId: line._id,
        nodeId: node._id,
        reviewRoundId: roundId,
        status: 'unread',
        createdAt: db.serverDate()
      } })
      await transaction.collection('audit_logs').doc(`${roundId}-submitted`).set({ data: {
        actorId: actor._id,
        action: 'SUBMIT_NODE_FOR_REVIEW',
        targetType: 'node_review_round',
        targetId: roundId,
        businessLineId: line._id,
        nodeId: node._id,
        feedbackId: value.draft.feedbackId,
        processingRoundNumber: node.processingRoundNumber,
        reviewRoundNumber,
        createdAt: db.serverDate()
      } })
      return publicResult({ _id: roundId, ...round })
    })
  }

  async function prepareReviewVote(value) {
    validateVoteInput(value)
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, 'users', value.actor._id)
      const hintedRound = await readDocument(transaction, 'node_review_rounds', value.input.reviewRoundId)
      if (!hintedRound || typeof hintedRound.businessLineId !== 'string' ||
          typeof hintedRound.nodeId !== 'string') throw createError('FORBIDDEN')
      const line = await readDocument(transaction, 'business_lines', hintedRound.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', hintedRound.nodeId)
      const round = await readDocument(transaction, 'node_review_rounds', value.input.reviewRoundId)
      if (round && ['approved', 'rejected'].includes(round.status)) {
        assertFinalRetryAuthorization(actor, line, node, round, value.input)
        if (!HASH.test(value.requestKeyHash || '') || !HASH.test(value.inputHash || '')) {
          throw createError('VALIDATION_ERROR')
        }
        const vote = await readDocument(
          transaction, 'node_review_votes', deterministicVoteId(round._id, actor._id)
        )
        assertMatchingVote(vote, actor, round, value)
        return {
          businessLineId: line._id, nodeId: node._id,
          nodeVersion: node.version, roundVersion: round.version,
          transition: 'finalized_retry', processingWorkMinutes: null
        }
      }
      assertVoteAuthorization(actor, line, node, round, value.input)
      const reviewContext = reviewTimingContext(round)
      if (!safeInteger(line.nodeCount, 1) || !safeInteger(node.sequence) ||
          node.sequence >= line.nodeCount) throw createError('VERSION_CONFLICT')
      if (value.input.decision === 'reject') {
        if (!safeInteger(round.processingRemainingWorkMinutes)) throw createError('VERSION_CONFLICT')
        return {
          businessLineId: line._id,
          nodeId: node._id,
          nodeVersion: node.version,
          roundVersion: round.version,
          transition: 'rework',
          processingWorkMinutes: round.processingRemainingWorkMinutes,
          processingCarryoverPending: round.processingTimingStatus === 'pending_calendar',
          ...reviewContext
        }
      }
      if (node.sequence + 1 === line.nodeCount) {
        return {
          businessLineId: line._id,
          nodeId: node._id,
          nodeVersion: node.version,
          roundVersion: round.version,
          transition: 'complete_line',
          processingWorkMinutes: null,
          ...reviewContext
        }
      }
      const nextId = instanceNodeId(line._id, node.sequence + 1)
      const next = await readDocument(transaction, 'business_nodes', nextId)
      const nextProcessors = ownExactAccountIds(next, 'processorUserIds', { nonEmpty: true })
      const nextReviewers = ownExactAccountIds(next, 'reviewerUserIds', { nonEmpty: true })
      const minutes = next && next.processingSlaWorkHours * 60
      if (!next || next.businessLineId !== line._id || next.sequence !== node.sequence + 1 ||
          next.status !== 'waiting' || next.workflowMode !== 'review' ||
          !nextProcessors || !nextReviewers || nextProcessors.some(id => nextReviewers.includes(id)) ||
          !safeInteger(next.version, 1) || !safeInteger(minutes, 1)) {
        throw createError('VERSION_CONFLICT')
      }
      return {
        businessLineId: line._id,
        nodeId: node._id,
        nodeVersion: node.version,
        roundVersion: round.version,
        transition: 'next_node',
        nextNodeId: next._id,
        nextNodeVersion: next.version,
        processingWorkMinutes: minutes,
        ...reviewContext
      }
    })
  }

  async function submitReviewVote(value) {
    validateVoteInput(value, true)
    const context = value.context
    if (typeof context.businessLineId !== 'string' || !DOCUMENT_ID.test(context.businessLineId) ||
        typeof context.nodeId !== 'string' || !DOCUMENT_ID.test(context.nodeId) ||
        !safeInteger(context.nodeVersion, 1) || !safeInteger(context.roundVersion, 1) ||
        !['rework', 'next_node', 'complete_line', 'finalized_retry'].includes(context.transition)) {
      throw createError('VALIDATION_ERROR')
    }
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, 'users', value.actor._id)
      const line = await readDocument(transaction, 'business_lines', context.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', context.nodeId)
      const round = await readDocument(transaction, 'node_review_rounds', value.input.reviewRoundId)
      if (context.transition === 'finalized_retry') {
        const result = assertFinalRetryAuthorization(actor, line, node, round, value.input)
        if (node.version !== context.nodeVersion || round.version !== context.roundVersion) {
          throw createError('VERSION_CONFLICT')
        }
        const vote = await readDocument(
          transaction, 'node_review_votes', deterministicVoteId(round._id, actor._id)
        )
        assertMatchingVote(vote, actor, round, value)
        return result
      }
      const { processors, reviewers } = assertVoteAuthorization(actor, line, node, round, value.input)
      if (node.version !== context.nodeVersion || round.version !== context.roundVersion) {
        throw createError('VERSION_CONFLICT')
      }
      const voteId = deterministicVoteId(round._id, actor._id)
      const counts = safeVoteCounts(round, reviewers.length)
      const existingVote = await readDocument(transaction, 'node_review_votes', voteId)
      if (existingVote) {
        assertMatchingVote(existingVote, actor, round, value)
        return voteResult(round, node.status, line.status)
      }
      validateCompletedReviewTiming(value.timing, context, round)
      const displayName = reviewerDisplayName(actor)

      if (!safeInteger(line.nodeCount, 1) || !safeInteger(node.sequence) ||
          node.sequence >= line.nodeCount) throw createError('VERSION_CONFLICT')
      let next = null
      let expectedTransition
      let expectedMinutes = null
      if (value.input.decision === 'reject') {
        expectedTransition = 'rework'
        expectedMinutes = round.processingRemainingWorkMinutes
      } else if (node.sequence + 1 === line.nodeCount) {
        expectedTransition = 'complete_line'
      } else {
        expectedTransition = 'next_node'
        const nextId = instanceNodeId(line._id, node.sequence + 1)
        next = await readDocument(transaction, 'business_nodes', nextId)
        const nextProcessors = ownExactAccountIds(next, 'processorUserIds', { nonEmpty: true })
        const nextReviewers = ownExactAccountIds(next, 'reviewerUserIds', { nonEmpty: true })
        expectedMinutes = next && next.processingSlaWorkHours * 60
        if (!next || next._id !== context.nextNodeId || next.businessLineId !== line._id ||
            next.sequence !== node.sequence + 1 || next.status !== 'waiting' ||
            next.workflowMode !== 'review' || !nextProcessors || !nextReviewers ||
            nextProcessors.some(id => nextReviewers.includes(id)) ||
            !safeInteger(next.version, 1) || next.version !== context.nextNodeVersion ||
            !safeInteger(expectedMinutes, 1)) throw createError('VERSION_CONFLICT')
      }
      if (context.transition !== expectedTransition ||
          context.processingWorkMinutes !== expectedMinutes ||
          expectedTransition === 'rework' && (context.processingCarryoverPending === true) !==
          (round.processingTimingStatus === 'pending_calendar') ||
          expectedTransition === 'rework' && !safeInteger(expectedMinutes)) {
        throw createError('VERSION_CONFLICT')
      }
      validateDueTiming(value.timing, expectedTransition, expectedMinutes)
      const carryover = processingCarryover(node, round)
      if (expectedTransition === 'rework' && carryover &&
          value.timing.processingDueStatus !== 'pending_calendar') throw createError('VERSION_CONFLICT')

      const voteCount = increment(counts.voteCount)
      const approvedVoteCount = value.input.decision === 'approve'
        ? increment(counts.approvedVoteCount)
        : counts.approvedVoteCount
      if (voteCount > reviewers.length || approvedVoteCount > reviewers.length) {
        throw createError('VERSION_CONFLICT')
      }
      const finalStatus = value.input.decision === 'reject'
        ? 'rejected'
        : round.reviewMode === 'any' || approvedVoteCount === reviewers.length
          ? 'approved'
          : 'pending'
      const at = new Date(value.timing.transitionAt)
      const normalizedDecision = persistedDecision(value.input.decision)
      await transaction.collection('node_review_votes').doc(voteId).set({ data: {
        reviewRoundId: round._id,
        businessLineId: line._id,
        nodeId: node._id,
        reviewerUserId: actor._id,
        reviewerDisplayName: displayName,
        decision: normalizedDecision,
        comment: value.input.comment,
        expectedRoundVersion: value.input.expectedRoundVersion,
        requestKeyHash: value.requestKeyHash,
        inputHash: value.inputHash,
        createdAt: db.serverDate()
      } })

      const auditId = `${voteId}-audit`
      await transaction.collection('audit_logs').doc(auditId).set({ data: {
        actorId: actor._id,
        action: 'SUBMIT_REVIEW_VOTE',
        targetType: 'node_review_round',
        targetId: round._id,
        businessLineId: line._id,
        nodeId: node._id,
        decision: normalizedDecision,
        resultStatus: finalStatus,
        createdAt: db.serverDate()
      } })

      if (finalStatus === 'pending') {
        await transaction.collection('node_review_rounds').doc(round._id).update({ data: {
          approvedVoteCount,
          voteCount,
          updatedAt: db.serverDate()
        } })
        return voteResult({ ...round, status: 'pending' }, node.status, line.status)
      }

      const reviewTiming = completedReviewTiming(round, value.timing, at)

      await transaction.collection('node_review_rounds').doc(round._id).update({ data: {
        status: finalStatus,
        finalDecision: normalizedDecision,
        finalActorId: actor._id,
        rejectionComment: finalStatus === 'rejected' ? value.input.comment : '',
        approvedVoteCount,
        voteCount,
        resultNodeStatus: finalStatus === 'rejected' ? 'in_progress' : 'completed',
        resultLineStatus: finalStatus === 'approved' && expectedTransition === 'complete_line'
          ? 'completed'
          : 'active',
        resultNextNodeId: finalStatus === 'approved' && expectedTransition === 'next_node'
          ? next._id
          : null,
        resultLockedNodeVersion: round.lockedNodeVersion,
        resultNodeVersion: increment(node.version),
        resultRoundVersion: increment(round.version),
        resultReviewMode: round.reviewMode,
        resultProcessingRoundNumber: round.processingRoundNumber,
        resultReviewRoundNumber: round.reviewRoundNumber,
        resultProcessingCarryoverPending: Boolean(carryover),
        resultReviewCarryoverPending: reviewTiming.reviewTimingCarryoverStatus === 'pending',
        ...(carryover || {}),
        ...reviewTiming,
        decidedAt: at,
        version: increment(round.version),
        updatedAt: db.serverDate()
      } })

      let nodeStatus
      let lineStatus = 'active'
      let nextNodeId = null
      let recipients
      let notificationType
      if (finalStatus === 'rejected') {
        nodeStatus = 'in_progress'
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          status: nodeStatus,
          processingRoundNumber: increment(node.processingRoundNumber),
          processingStartedAt: at,
          processingDueStatus: value.timing.processingDueStatus,
          processingDueAt: value.timing.processingDueAt === null
            ? null
            : new Date(value.timing.processingDueAt),
          processingCalendarVersion: value.timing.processingCalendarVersion,
          calendarNotificationStatus: value.timing.processingDueStatus === 'pending_calendar'
            ? 'pending'
            : 'not_required',
          activeReviewRoundId: db.command.remove(),
          reviewStartedAt: db.command.remove(),
          reviewDueStatus: db.command.remove(),
          reviewDueAt: db.command.remove(),
          reviewCalendarVersion: db.command.remove(),
          lastReviewRoundId: round._id,
          lastReviewTimingStatus: reviewTiming.reviewTimingStatus,
          lastReviewElapsedWorkMinutes: reviewTiming.reviewElapsedWorkMinutes,
          lastReviewRemainingWorkMinutes: reviewTiming.reviewRemainingWorkMinutes,
          lastReviewOverdueWorkMinutes: reviewTiming.reviewOverdueWorkMinutes,
          lastReviewCalendarVersion: reviewTiming.reviewCalendarVersion,
          version: increment(node.version),
          updatedAt: db.serverDate()
        } })
        await transaction.collection('business_lines').doc(line._id).update({ data: {
          version: increment(line.version),
          updatedAt: db.serverDate()
        } })
        recipients = processors
        notificationType = 'node_review_rejected'
      } else {
        nodeStatus = 'completed'
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          status: nodeStatus,
          completedAt: at,
          activeReviewRoundId: db.command.remove(),
          lastReviewRoundId: round._id,
          lastReviewTimingStatus: reviewTiming.reviewTimingStatus,
          lastReviewElapsedWorkMinutes: reviewTiming.reviewElapsedWorkMinutes,
          lastReviewRemainingWorkMinutes: reviewTiming.reviewRemainingWorkMinutes,
          lastReviewOverdueWorkMinutes: reviewTiming.reviewOverdueWorkMinutes,
          lastReviewCalendarVersion: reviewTiming.reviewCalendarVersion,
          version: increment(node.version),
          updatedAt: db.serverDate()
        } })
        if (expectedTransition === 'complete_line') {
          lineStatus = 'completed'
          const purgeDueAt = new Date(at.getTime() + RETENTION_MS)
          await transaction.collection('business_lines').doc(line._id).update({ data: {
            status: lineStatus,
            progress: 100,
            completedAt: at,
            frozenAt: at,
            retentionStartedAt: at,
            purgeDueAt,
            version: increment(line.version),
            updatedAt: db.serverDate()
          } })
          recipients = [...new Set([...processors, ...reviewers])].sort()
          notificationType = 'business_completed'
        } else {
          nextNodeId = next._id
          const nextProcessors = ownExactAccountIds(next, 'processorUserIds', { nonEmpty: true })
          await transaction.collection('business_nodes').doc(next._id).update({ data: {
            status: 'ready',
            processingStartedAt: at,
            processingDueStatus: value.timing.processingDueStatus,
            processingDueAt: value.timing.processingDueAt === null
              ? null
              : new Date(value.timing.processingDueAt),
            processingCalendarVersion: value.timing.processingCalendarVersion,
            calendarNotificationStatus: value.timing.processingDueStatus === 'pending_calendar'
              ? 'pending'
              : 'not_required',
            version: increment(next.version),
            updatedAt: db.serverDate()
          } })
          const progress = Math.floor(((node.sequence + 1) / line.nodeCount) * 100)
          await transaction.collection('business_lines').doc(line._id).update({ data: {
            currentNodeId: next._id,
            currentNodeIndex: next.sequence,
            currentNodeName: next.name,
            progress,
            version: increment(line.version),
            updatedAt: db.serverDate()
          } })
          recipients = nextProcessors
          notificationType = 'node_processing_started'
        }
      }

      const notificationId = `review-result-${hash(`${round._id}\0${finalStatus}`).slice(0, 40)}`
      if (!fitsIndexedAccountArray(recipients)) throw createError('VERSION_CONFLICT')
      await transaction.collection('notifications').doc(notificationId).set({ data: {
        type: notificationType,
        recipientUserIds: clone(recipients),
        businessLineId: line._id,
        nodeId: node._id,
        reviewRoundId: round._id,
        status: 'unread',
        createdAt: db.serverDate()
      } })
      const processingCalendarMissing = expectedTransition !== 'complete_line' &&
        value.timing.processingDueStatus === 'pending_calendar'
      const reviewCalendarMissing = value.timing.reviewTimingStatus === 'pending_calendar'
      if (processingCalendarMissing || reviewCalendarMissing) {
        const calendarNotificationId = `work-calendar-missing-${hash(`${line._id}\0processing`).slice(0, 40)}`
        const existingWarning = await readDocument(transaction, 'notifications', calendarNotificationId)
        if (!existingWarning) {
          await transaction.collection('notifications').doc(calendarNotificationId).set({ data: {
            type: 'work_calendar_missing',
            audienceRole: 'super_admin',
            status: 'pending',
            createdAt: db.serverDate()
          } })
        }
      }
      return voteResult(
        { ...round, status: finalStatus }, nodeStatus, lineStatus, nextNodeId
      )
    })
  }

  async function validatedPendingCandidate(candidate, actorId) {
    try {
      return await db.runTransaction(async transaction => {
        const { account } = await requireCurrentAccount(transaction, { _id: actorId })
        const round = await readDocument(transaction, 'node_review_rounds', candidate && candidate._id)
        const line = round && await readDocument(transaction, 'business_lines', round.businessLineId)
        const node = round && await readDocument(transaction, 'business_nodes', round.nodeId)
        const relationships = safeRoundRelationships(line, node, round)
        if (!relationships.members.includes(account._id) ||
            !relationships.reviewers.includes(account._id) || !currentPendingRound(line, node, round)) {
          throw createError('FORBIDDEN')
        }
        const vote = await readDocument(
          transaction, 'node_review_votes', deterministicVoteId(round._id, account._id)
        )
        if (vote && (vote.reviewRoundId !== round._id || vote.reviewerUserId !== account._id ||
            !['approved', 'rejected'].includes(vote.decision))) throw createError('FORBIDDEN')
        return safeReviewSummary(line, node, round, vote, account._id)
      })
    } catch (error) {
      if (error && error[APPLICATION_ERROR_MARKER]) return null
      throw error
    }
  }

  async function listPendingReviews({ actor, query }) {
    const { account } = await requireCurrentAccount(db, actor)
    const requested = query.page * query.pageSize
    if (!safeInteger(requested, 1) || requested > MAX_QUERY_WINDOW) throw createError('INVALID_PAGINATION')
    const response = await db.collection('node_review_rounds')
      .where({ reviewerUserIds: account._id, status: 'pending' })
      .orderBy('createdAt', 'desc')
      .orderBy('_id', 'asc')
      .limit(MAX_QUERY_WINDOW)
      .get()
    const candidates = Array.isArray(response && response.data) ? response.data : []
    const initiallyValidated = (await Promise.all(candidates.map(candidate =>
      validatedPendingCandidate(candidate, account._id)))).filter(Boolean)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() ||
        left.reviewRoundId.localeCompare(right.reviewRoundId))
    await requireCurrentAccount(db, actor)
    const validated = (await Promise.all(initiallyValidated.map(candidate =>
      validatedPendingCandidate({ _id: candidate.reviewRoundId }, account._id)))).filter(Boolean)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() ||
        left.reviewRoundId.localeCompare(right.reviewRoundId))
    const offset = (query.page - 1) * query.pageSize
    return {
      items: validated.slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      hasMore: offset + query.pageSize < validated.length
    }
  }

  function authorizeReviewDetail(account, line, node, round) {
    const relationships = safeRoundRelationships(line, node, round)
    const isReviewer = relationships.members.includes(account._id) &&
      relationships.reviewers.includes(account._id)
    const isManager = relationships.managers.includes(account._id)
    const isSuperAdmin = account.role === 'super_admin'
    const roundAttached = currentPendingRound(line, node, round) ||
      node.lastReviewRoundId === round._id && ['approved', 'rejected'].includes(round.status)
    if (!roundAttached || !isReviewer && !isManager && !isSuperAdmin) throw createError('FORBIDDEN')
    return { relationships, isReviewer }
  }

  function safeVoteProjection(vote, round) {
    if (!vote || vote.reviewRoundId !== round._id ||
        !round.reviewerUserIds.includes(vote.reviewerUserId) ||
        !['approved', 'rejected'].includes(vote.decision)) return null
    const displayName = validDisplayName(vote.reviewerDisplayName, 100)
    if (!displayName || !validDate(vote.createdAt)) return null
    return {
      reviewerDisplayName: displayName,
      decision: vote.decision,
      createdAt: new Date(vote.createdAt)
    }
  }

  async function readAuthorizedDetailSnapshot(actor, reviewRoundId) {
    return db.runTransaction(async transaction => {
      const { account, role } = await requireCurrentAccount(transaction, actor)
      const round = await readDocument(transaction, 'node_review_rounds', reviewRoundId)
      const line = round && await readDocument(transaction, 'business_lines', round.businessLineId)
      const node = round && await readDocument(transaction, 'business_nodes', round.nodeId)
      const authorization = authorizeReviewDetail({ ...account, role }, line, node, round)
      const vote = authorization.isReviewer
        ? await readDocument(transaction, 'node_review_votes', deterministicVoteId(round._id, account._id))
        : null
      if (vote && (vote.reviewRoundId !== round._id || vote.reviewerUserId !== account._id)) {
        throw createError('FORBIDDEN')
      }
      return {
        accountId: account._id,
        line,
        node,
        round,
        isReviewer: authorization.isReviewer,
        hasVoted: Boolean(vote)
      }
    })
  }

  async function getReviewDetail({ actor, reviewRoundId }) {
    let first
    try {
      first = await readAuthorizedDetailSnapshot(actor, reviewRoundId)
    } catch (error) {
      if (error && error[APPLICATION_ERROR_MARKER]) throw createError('FORBIDDEN')
      throw error
    }
    const votesResponse = await db.collection('node_review_votes')
      .where({ reviewRoundId })
      .orderBy('createdAt', 'asc')
      .orderBy('_id', 'asc')
      .limit(first.round.reviewerUserIds.length + 1)
      .get()
    const second = await readAuthorizedDetailSnapshot(actor, reviewRoundId)
    if (first.line.version !== second.line.version || first.node.version !== second.node.version ||
        first.round.version !== second.round.version || first.round.status !== second.round.status) {
      throw createError('VERSION_CONFLICT')
    }
    const rawVotes = votesResponse.data || []
    const votes = rawVotes.map(vote => safeVoteProjection(vote, second.round))
    if (rawVotes.length > second.round.reviewerUserIds.length || votes.some(vote => !vote) ||
        new Set(rawVotes.map(vote => vote.reviewerUserId)).size !== rawVotes.length) {
      throw createError('FORBIDDEN')
    }
    const canAct = second.isReviewer && !second.hasVoted && second.round.status === 'pending'
    const relationships = safeRoundRelationships(second.line, second.node, second.round)
    const processorDisplayNames = persistedNameSnapshots(
      second.round, 'processorDisplayNames', relationships.processors.length, '历史处理人'
    )
    const reviewerDisplayNames = persistedNameSnapshots(
      second.round, 'reviewerDisplayNames', relationships.reviewers.length, '历史审核人'
    )
    const third = await readAuthorizedDetailSnapshot(actor, reviewRoundId)
    if (second.line.version !== third.line.version || second.node.version !== third.node.version ||
        second.round.version !== third.round.version || second.round.status !== third.round.status) {
      throw createError('VERSION_CONFLICT')
    }
    return {
      reviewRoundId: second.round._id,
      businessLineId: second.line._id,
      businessCode: validDisplayName(second.line.code, 100) || '',
      businessName: validDisplayName(second.line.name, 200) || '',
      nodeId: second.node._id,
      nodeCode: validDisplayName(second.node.nodeCode, 100) || '',
      nodeName: validDisplayName(second.node.name, 200) || '',
      processorDisplayNames,
      reviewerDisplayNames,
      reviewMode: second.round.reviewMode,
      reviewRoundNumber: second.round.reviewRoundNumber,
      version: second.round.version,
      status: second.round.status,
      submittedAt: safeDate(second.round.reviewStartedAt),
      processingComment: processingComment(second.round, { allowMissing: true, errorCode: 'FORBIDDEN' }),
      fieldValues: safeFieldValues(second.round.fieldValues),
      evidences: safeEvidenceIds(second.round.evidenceIds),
      votes,
      reviewDueStatus: second.round.reviewDueStatus,
      reviewDueAt: safeDate(second.round.reviewDueAt),
      reviewOverdueWorkMinutes: safeInteger(second.round.reviewOverdueWorkMinutes)
        ? second.round.reviewOverdueWorkMinutes
        : 0,
      hasVoted: second.hasVoted,
      canApprove: canAct,
      canReject: canAct
    }
  }

  async function validatedNotification(notificationId, actor) {
    try {
      return await db.runTransaction(async transaction => {
        const { account, role } = await requireCurrentAccount(transaction, actor)
        const note = await readDocument(transaction, 'notifications', notificationId)
        const visibility = safeNotificationShape(note, { ...account, role })
        if (!visibility) throw createError('FORBIDDEN')
        const marker = await readDocument(transaction, 'notifications', readMarkerId(note._id, account._id))
        if (marker && (marker.type !== 'notification_read_marker' ||
            marker.parentNotificationId !== note._id || marker.userId !== account._id)) {
          throw createError('FORBIDDEN')
        }
        const result = {
          notificationId: note._id,
          type: note.type,
          read: visibility.oldRead || Boolean(marker),
          createdAt: safeDate(note.createdAt)
        }
        for (const key of ['businessLineId', 'nodeId', 'reviewRoundId']) {
          if (note[key] !== undefined && note[key] !== null) {
            if (typeof note[key] !== 'string' || !DOCUMENT_ID.test(note[key])) throw createError('FORBIDDEN')
            result[key] = note[key]
          }
        }
        return result
      })
    } catch (error) {
      if (error && error[APPLICATION_ERROR_MARKER]) return null
      throw error
    }
  }

  async function listNotifications({ actor, query }) {
    const { account, role } = await requireCurrentAccount(db, actor)
    const direct = await db.collection('notifications')
      .where({ recipientUserIds: account._id })
      .orderBy('createdAt', 'desc')
      .orderBy('_id', 'asc')
      .limit(MAX_QUERY_WINDOW)
      .get()
    const roleRows = role === 'super_admin'
      ? (await db.collection('notifications')
        .where({ audienceRole: 'super_admin' })
        .orderBy('createdAt', 'desc')
        .orderBy('_id', 'asc')
        .limit(MAX_QUERY_WINDOW)
        .get()).data || []
      : []
    const candidates = [...new Map([...(direct.data || []), ...roleRows]
      .map(item => [item._id, item])).values()]
      .filter(item => item.type !== 'notification_read_marker')
      .sort((left, right) => {
        const leftTime = validDate(left.createdAt) ? left.createdAt.getTime() : Number.NEGATIVE_INFINITY
        const rightTime = validDate(right.createdAt) ? right.createdAt.getTime() : Number.NEGATIVE_INFINITY
        return rightTime - leftTime || String(left._id || '').localeCompare(String(right._id || ''))
      })
      .slice(0, MAX_QUERY_WINDOW)
    const initiallyValidated = (await Promise.all(candidates.map(item =>
      validatedNotification(item._id, { _id: account._id })))).filter(Boolean)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() ||
        left.notificationId.localeCompare(right.notificationId))
    await requireCurrentAccount(db, actor)
    const items = (await Promise.all(initiallyValidated.map(item =>
      validatedNotification(item.notificationId, { _id: account._id })))).filter(Boolean)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() ||
        left.notificationId.localeCompare(right.notificationId))
    const offset = (query.page - 1) * query.pageSize
    return {
      items: items.slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      hasMore: offset + query.pageSize < items.length
    }
  }

  async function markNotificationRead({ actor, notificationId }) {
    try {
      return await db.runTransaction(async transaction => {
        const { account, role } = await requireCurrentAccount(transaction, actor)
        const note = await readDocument(transaction, 'notifications', notificationId)
        const visibility = safeNotificationShape(note, { ...account, role })
        if (!visibility) throw createError('FORBIDDEN')
        const markerId = readMarkerId(note._id, account._id)
        const existing = await readDocument(transaction, 'notifications', markerId)
        if (existing) {
          if (existing.type !== 'notification_read_marker' ||
              existing.parentNotificationId !== note._id || existing.userId !== account._id) {
            throw createError('FORBIDDEN')
          }
        } else {
          await transaction.collection('notifications').doc(markerId).set({ data: {
            type: 'notification_read_marker',
            parentNotificationId: note._id,
            userId: account._id,
            createdAt: db.serverDate()
          } })
        }
        return { notificationId: note._id, read: true }
      })
    } catch (error) {
      if (error && error[APPLICATION_ERROR_MARKER]) throw createError('FORBIDDEN')
      throw error
    }
  }

  return {
    inspectReviewRoundRetry,
    findReviewRoundRetry,
    createReviewRound,
    prepareReviewVote,
    submitReviewVote,
    listPendingReviews,
    getReviewDetail,
    listNotifications,
    markNotificationRead
  }
}

module.exports = { createCloudReviewRepository }
