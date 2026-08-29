const crypto = require('node:crypto')

const { ownDataValue, ownExactAccountIds } = require('./account-relationship-schema')
const { fitsIndexedAccountArray } = require('./index-key-budget')
const { advanceSearchVersion, currentSearchVersion } = require('./search-version')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000

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

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function increment(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER) {
    throw createError('VERSION_CONFLICT')
  }
  return value + 1
}

function nextAnalyticsSourceVersion(value) {
  const field = ownDataValue(value, 'analyticsSourceVersion')
  if (!field.present) return 1
  if (!field.valid || !Number.isSafeInteger(field.value) || field.value < 0 ||
      field.value === Number.MAX_SAFE_INTEGER) throw createError('VERSION_CONFLICT')
  return field.value + 1
}

function isMissingDocumentError(error) {
  const codes = [error && error.code, error && error.errCode].map(value => String(value || '').toUpperCase())
  if (codes.includes('DOCUMENT_NOT_FOUND')) return true
  const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
  return text.includes('document.get:fail') && text.includes('does not exist')
}

function sameDate(left, right) {
  return validDate(left) && validDate(right) && left.getTime() === right.getTime()
}

function publicResult(input, lineVersion, nodeVersion) {
  return {
    decision: input.decision,
    lineStatus: input.decision === 'skip' ? 'completed' : 'active',
    nodeStatus: input.decision === 'skip' ? 'skipped' : 'ready',
    lineVersion,
    nodeVersion
  }
}

function withSearchEnvelope(result, actorId, lineId, lineOrVersion) {
  const state = typeof lineOrVersion === 'number'
    ? { searchSourceVersion: lineOrVersion }
    : currentSearchVersion(lineOrVersion)
  Object.defineProperties(result, {
    publicResult: { value: result },
    searchEnvelope: { value: { actorId, businessLineId: lineId, sourceVersion: state.searchSourceVersion } }
  })
  return result
}

function createCloudOptionalTailRepository({ db }) {
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

  function decisionId(value) {
    if (!value || typeof value.requestKeyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestKeyHash) ||
        typeof value.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputHash)) {
      throw createError('VALIDATION_ERROR')
    }
    return `optional-tail-decision-${value.requestKeyHash}`
  }

  function safeAccount(account, actor) {
    if (!actor || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id) ||
        !account || account._id !== actor._id || account.status !== 'active') throw createError('FORBIDDEN')
    return account
  }

  function assertPending(line, node, value, actorId) {
    if (!line || !node) throw createError('VERSION_CONFLICT')
    const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(node, 'reviewerUserIds', { nonEmpty: false })
    const decisionStartedAt = ownDataValue(node, 'decisionStartedAt')
    if (!managers || !members || !processors || !reviewers ||
        !members.includes(actorId) || !processors.includes(actorId) ||
        processors.some(id => reviewers.includes(id))) throw createError('FORBIDDEN')
    if (line._id !== value.input.businessLineId || node._id !== value.input.nodeId ||
        node.businessLineId !== line._id || line.status !== 'active' ||
        line.optionalTailState !== 'pending' || line.optionalTailNodeId !== node._id ||
        line.currentNodeId !== node._id || line.currentNodeIndex !== node.sequence ||
        node.activationMode !== 'optional_tail' || node.status !== 'awaiting_decision' ||
        line.version !== value.input.expectedLineVersion || node.version !== value.input.expectedNodeVersion ||
        !decisionStartedAt.valid || !validDate(decisionStartedAt.value) ||
        !Number.isSafeInteger(node.processingSlaWorkHours) || node.processingSlaWorkHours <= 0) {
      throw createError('VERSION_CONFLICT')
    }
    return { processors, reviewers, decisionStartedAt: new Date(decisionStartedAt.value) }
  }

  function assertRetryAuthorization(line, node, value, actorId) {
    if (!line || !node || line._id !== value.input.businessLineId || node._id !== value.input.nodeId ||
        node.businessLineId !== line._id) throw createError('VERSION_CONFLICT')
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
    if (!members || !processors || !members.includes(actorId) || !processors.includes(actorId)) {
      throw createError('FORBIDDEN')
    }
  }

  function assertDecisionInput(value) {
    const input = value && value.input
    if (!input || !DOCUMENT_ID.test(input.businessLineId) || !DOCUMENT_ID.test(input.nodeId) ||
        !Number.isSafeInteger(input.expectedLineVersion) || input.expectedLineVersion < 1 ||
        !Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 1 ||
        !['activate', 'skip'].includes(input.decision) || typeof input.comment !== 'string' ||
        input.comment.length > 500 || (input.decision === 'skip' && !input.comment)) {
      throw createError('VALIDATION_ERROR')
    }
  }

  function validatePublishedDecision(audit, value) {
    if (!audit || audit.publishState !== 'published' || audit.actorId !== value.actor._id ||
        audit.targetId !== value.input.nodeId || audit.businessLineId !== value.input.businessLineId ||
        audit.requestKeyHash !== value.requestKeyHash || audit.inputHash !== value.inputHash ||
        !audit.result || typeof audit.result !== 'object') throw createError('VERSION_CONFLICT')
    return clone(audit.result)
  }

  async function inspectDecision(value) {
    return db.runTransaction(async transaction => {
      assertDecisionInput(value)
      safeAccount(await readDocument(transaction, 'users', value.actor && value.actor._id), value.actor)
      const audit = await readDocument(transaction, 'audit_logs', decisionId(value))
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      if (audit) {
        assertRetryAuthorization(line, node, value, value.actor._id)
        return { retryResult: validatePublishedDecision(audit, value) }
      }
      const relationships = assertPending(line, node, value, value.actor._id)
      return {
        decisionStartedAt: relationships.decisionStartedAt,
        processingSlaWorkHours: node.processingSlaWorkHours
      }
    })
  }

  function assertDecisionTiming(timing, node) {
    const decisionAt = timing && timing.decisionAt
    if (!validDate(decisionAt) || !validDate(node.decisionStartedAt) ||
        decisionAt.getTime() < node.decisionStartedAt.getTime() ||
        !['calculated', 'pending_calendar'].includes(timing.decisionTimingStatus) ||
        (timing.decisionTimingStatus === 'calculated' &&
          (!Number.isSafeInteger(timing.decisionWorkMinutes) || timing.decisionWorkMinutes < 0)) ||
        (timing.decisionTimingStatus === 'pending_calendar' && timing.decisionWorkMinutes !== null)) {
      throw createError('VERSION_CONFLICT')
    }
    if (timing.decisionCalendarVersion !== null && typeof timing.decisionCalendarVersion !== 'string') {
      throw createError('VERSION_CONFLICT')
    }
    return new Date(decisionAt)
  }

  function assertActivationTiming(timing, decisionAt) {
    if (!sameDate(timing.processingStartedAt, decisionAt) ||
        !['calculated', 'pending_calendar'].includes(timing.processingDueStatus) ||
        (timing.processingDueStatus === 'calculated' && (!validDate(timing.processingDueAt) ||
          timing.processingDueAt.getTime() < decisionAt.getTime())) ||
        (timing.processingDueStatus === 'pending_calendar' && timing.processingDueAt !== null) ||
        (timing.processingCalendarVersion !== null && typeof timing.processingCalendarVersion !== 'string')) {
      throw createError('VERSION_CONFLICT')
    }
  }

  async function commitDecision(value) {
    return db.runTransaction(async transaction => {
      assertDecisionInput(value)
      const account = safeAccount(
        await readDocument(transaction, 'users', value.actor && value.actor._id), value.actor
      )
      const auditId = decisionId(value)
      const existing = await readDocument(transaction, 'audit_logs', auditId)
      if (existing) return validatePublishedDecision(existing, value)
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      const { processors } = assertPending(line, node, value, account._id)
      if (!value.context || !sameDate(value.context.decisionStartedAt, node.decisionStartedAt) ||
          value.context.processingSlaWorkHours !== node.processingSlaWorkHours) {
        throw createError('VERSION_CONFLICT')
      }
      const decisionAt = assertDecisionTiming(value.timing, node)
      if (value.input.decision === 'activate') assertActivationTiming(value.timing, decisionAt)
      const lineVersion = increment(line.version)
      const nodeVersion = increment(node.version)
      const lineSearch = advanceSearchVersion(line)
      const nodeSearch = advanceSearchVersion(node)
      const result = publicResult(value.input, lineVersion, nodeVersion)
      const decisionFields = {
        decisionAt,
        decisionActorId: account._id,
        decisionComment: value.input.comment,
        decisionTimingStatus: value.timing.decisionTimingStatus,
        decisionWorkMinutes: value.timing.decisionWorkMinutes,
        decisionCalendarVersion: value.timing.decisionCalendarVersion,
        nextDecisionReminderWorkHour: db.command.remove(),
        lastDecisionReminderWorkHour: db.command.remove()
      }
      let notificationType
      if (value.input.decision === 'activate') {
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          ...decisionFields,
          status: 'ready',
          processingStartedAt: new Date(value.timing.processingStartedAt),
          processingDueStatus: value.timing.processingDueStatus,
          processingDueAt: value.timing.processingDueAt === null ? null : new Date(value.timing.processingDueAt),
          processingCalendarVersion: value.timing.processingCalendarVersion,
          calendarNotificationStatus: value.timing.processingDueStatus === 'pending_calendar'
            ? 'pending'
            : 'not_required',
          version: nodeVersion,
          ...nodeSearch,
          updatedAt: db.serverDate()
        } })
        await transaction.collection('business_lines').doc(line._id).update({ data: {
          optionalTailState: 'activated',
          version: lineVersion,
          ...lineSearch,
          updatedAt: db.serverDate()
        } })
        notificationType = 'node_processing_started'
      } else {
        const purgeDueAt = new Date(decisionAt.getTime() + RETENTION_MS)
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          ...decisionFields,
          status: 'skipped',
          skippedAt: decisionAt,
          analyticsSnapshotStatus: 'pending',
          analyticsSourceVersion: nextAnalyticsSourceVersion(node),
          analyticsCompletedAt: decisionAt,
          version: nodeVersion,
          ...nodeSearch,
          updatedAt: db.serverDate()
        } })
        await transaction.collection('business_lines').doc(line._id).update({ data: {
          optionalTailState: 'skipped',
          status: 'completed',
          progress: 100,
          completedAt: decisionAt,
          frozenAt: decisionAt,
          retentionStartedAt: decisionAt,
          purgeDueAt,
          analyticsSnapshotStatus: 'pending',
          analyticsSourceVersion: nextAnalyticsSourceVersion(line),
          analyticsCompletedAt: decisionAt,
          version: lineVersion,
          ...lineSearch,
          updatedAt: db.serverDate()
        } })
        notificationType = 'business_completed'
      }
      if (!fitsIndexedAccountArray(processors)) throw createError('VERSION_CONFLICT')
      const notificationId = `optional-tail-result-${hash(`${auditId}\0${value.input.decision}`).slice(0, 40)}`
      await transaction.collection('notifications').doc(notificationId).set({ data: {
        type: notificationType,
        recipientUserIds: clone(processors),
        businessLineId: line._id,
        nodeId: node._id,
        status: 'unread',
        createdAt: db.serverDate()
      } })
      if (value.input.decision === 'activate' && value.timing.processingDueStatus === 'pending_calendar') {
        const warningId = `work-calendar-missing-${hash(`${line._id}\0processing`).slice(0, 40)}`
        const warning = await readDocument(transaction, 'notifications', warningId)
        if (!warning) {
          await transaction.collection('notifications').doc(warningId).set({ data: {
            type: 'work_calendar_missing', audienceRole: 'super_admin', status: 'pending',
            createdAt: db.serverDate()
          } })
        }
      }
      await transaction.collection('audit_logs').doc(auditId).set({ data: {
        action: value.input.decision === 'activate' ? 'ACTIVATE_OPTIONAL_TAIL' : 'SKIP_OPTIONAL_TAIL',
        targetType: 'business_node',
        targetId: node._id,
        businessLineId: line._id,
        actorId: account._id,
        requestKeyHash: value.requestKeyHash,
        inputHash: value.inputHash,
        publishState: 'published',
        result: clone(result),
        createdAt: db.serverDate()
      } })
      return withSearchEnvelope(result, account._id, line._id, lineSearch.searchSourceVersion)
    })
  }

  return { inspectDecision, commitDecision }
}

module.exports = { createCloudOptionalTailRepository }
