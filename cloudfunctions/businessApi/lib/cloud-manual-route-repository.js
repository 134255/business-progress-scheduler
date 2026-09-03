const crypto = require('node:crypto')

const { ownDataValue, ownExactAccountIds } = require('./account-relationship-schema')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { fitsIndexedAccountArray } = require('./index-key-budget')
const { advanceSearchVersion, currentSearchVersion } = require('./search-version')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function clone(value) {
  if (value instanceof Date) return new Date(value)
  if (Array.isArray(value)) return value.map(clone)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function increment(value, allowZero = false) {
  const minimum = allowZero ? 0 : 1
  if (!Number.isSafeInteger(value) || value < minimum || value === Number.MAX_SAFE_INTEGER) {
    throw createError('VERSION_CONFLICT')
  }
  return value + 1
}

function nextAnalyticsVersion(value) {
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

function createCloudManualRouteRepository({ db }) {
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

  function assertRequest(value) {
    const input = value && value.input
    if (!input || !DOCUMENT_ID.test(input.businessLineId) || !DOCUMENT_ID.test(input.nodeId) ||
        !Number.isSafeInteger(input.expectedLineVersion) || input.expectedLineVersion < 1 ||
        !Number.isSafeInteger(input.expectedNodeVersion) || input.expectedNodeVersion < 1 ||
        !['activate', 'skip'].includes(input.decision) || typeof input.comment !== 'string' ||
        input.comment.length > 500 || (input.decision === 'skip' && !input.comment) ||
        !HASH.test(value.requestKeyHash) || !HASH.test(value.inputHash)) throw createError('VALIDATION_ERROR')
  }

  function safeActor(account, actor) {
    if (!actor || !DOCUMENT_ID.test(actor._id) || !account || account._id !== actor._id ||
        account.status !== 'active') throw createError('FORBIDDEN')
    return account
  }

  function routeTargets(source) {
    const next = ownDataValue(source, 'next')
    if (!next.valid || !next.value || next.value.mode !== 'manual' ||
        !Object.hasOwn(next.value, 'activateTargetNodeId') ||
        !Object.hasOwn(next.value, 'skipTargetNodeId')) throw createError('VERSION_CONFLICT')
    const activateId = next.value.activateTargetNodeId
    const skipId = next.value.skipTargetNodeId
    if (!DOCUMENT_ID.test(activateId) ||
        !(skipId === 'end' || DOCUMENT_ID.test(skipId)) || activateId === skipId) {
      throw createError('VERSION_CONFLICT')
    }
    return { activateId, skipId }
  }

  function assertTarget(target, lineId, targetId) {
    const processors = ownExactAccountIds(target, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(target, 'reviewerUserIds', { nonEmpty: false })
    if (!target || target._id !== targetId || target.businessLineId !== lineId ||
        target.routeState !== 'dormant' || target.status !== 'waiting' ||
        !Number.isSafeInteger(target.version) || target.version < 1 ||
        !Number.isSafeInteger(target.processingSlaWorkHours) || target.processingSlaWorkHours <= 0 ||
        target.processingDueStatus !== 'not_started' || target.processingDueAt !== null ||
        !processors || !reviewers || processors.some(id => reviewers.includes(id)) ||
        !fitsIndexedAccountArray(processors) || !fitsIndexedAccountArray(reviewers)) {
      throw createError('VERSION_CONFLICT')
    }
    return { processors, reviewers }
  }

  function assertPending(line, source, value, actorId) {
    const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    const traversed = ownDataValue(line, 'traversedNodeIds')
    const decisionStartedAt = ownDataValue(source, 'decisionStartedAt')
    if (!managers || !members || !members.includes(actorId)) throw createError('FORBIDDEN')
    if (!line || !source || line._id !== value.input.businessLineId || source._id !== value.input.nodeId ||
        source.businessLineId !== line._id || line.flowSchemaVersion !== 2 || line.status !== 'active' ||
        line.currentNodeId !== source._id || line.currentNodeIndex !== source.sequence ||
        line.awaitingManualDecision !== true || source.status !== 'awaiting_decision' ||
        source.routeState !== 'awaiting_manual_decision' || line.version !== value.input.expectedLineVersion ||
        source.version !== value.input.expectedNodeVersion || !decisionStartedAt.valid ||
        !validDate(decisionStartedAt.value) || !traversed.valid || !Array.isArray(traversed.value) ||
        !traversed.value.includes(source._id) || new Set(traversed.value).size !== traversed.value.length ||
        !Number.isSafeInteger(line.routeDecisionVersion) || line.routeDecisionVersion < 0) {
      throw createError('VERSION_CONFLICT')
    }
    return { managers, members, decisionStartedAt: new Date(decisionStartedAt.value) }
  }

  function assertDecisionAuthorization(activationTarget, actorId) {
    const relationships = assertTarget(activationTarget, activationTarget.businessLineId, activationTarget._id)
    if (!relationships.processors.includes(actorId)) throw createError('FORBIDDEN')
    return relationships
  }

  function auditId(value) {
    return `manual-route-decision-${value.requestKeyHash}`
  }

  function publishedResult(audit, value) {
    if (!audit || audit.publishState !== 'published' || audit.actorId !== value.actor._id ||
        audit.businessLineId !== value.input.businessLineId || audit.targetId !== value.input.nodeId ||
        audit.requestKeyHash !== value.requestKeyHash || audit.inputHash !== value.inputHash ||
        !audit.result || typeof audit.result !== 'object') throw createError('VERSION_CONFLICT')
    return clone(audit.result)
  }

  async function assertRetryAuthorization(transaction, value) {
    const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
    const source = await readDocument(transaction, 'business_nodes', value.input.nodeId)
    if (!line || !source || source.businessLineId !== line._id) throw createError('VERSION_CONFLICT')
    const targets = routeTargets(source)
    const activationTarget = await readDocument(transaction, 'business_nodes', targets.activateId)
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    const processors = ownExactAccountIds(activationTarget, 'processorUserIds', { nonEmpty: true })
    if (!members || !processors || !members.includes(value.actor._id) ||
        !processors.includes(value.actor._id)) throw createError('FORBIDDEN')
  }

  async function loadRoute(transaction, value) {
    const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
    const source = await readDocument(transaction, 'business_nodes', value.input.nodeId)
    const relationships = assertPending(line, source, value, value.actor._id)
    const { activateId, skipId } = routeTargets(source)
    const activationTarget = await readDocument(transaction, 'business_nodes', activateId)
    const activationRelationships = assertDecisionAuthorization(activationTarget, value.actor._id)
    const selectedId = value.input.decision === 'activate' ? activateId : skipId
    let selectedTarget = null
    let selectedRelationships = null
    if (selectedId !== 'end') {
      selectedTarget = selectedId === activateId
        ? activationTarget
        : await readDocument(transaction, 'business_nodes', selectedId)
      selectedRelationships = selectedId === activateId
        ? activationRelationships
        : assertTarget(selectedTarget, line._id, selectedId)
    }
    return { line, source, relationships, activateId, skipId, activationTarget,
      activationRelationships, selectedTarget, selectedRelationships }
  }

  async function inspectDecision(value) {
    return db.runTransaction(async transaction => {
      assertRequest(value)
      safeActor(await readDocument(transaction, 'users', value.actor && value.actor._id), value.actor)
      const existing = await readDocument(transaction, 'audit_logs', auditId(value))
      if (existing) {
        await assertRetryAuthorization(transaction, value)
        return { retryResult: publishedResult(existing, value) }
      }
      const route = await loadRoute(transaction, value)
      return {
        decisionStartedAt: route.relationships.decisionStartedAt,
        targetNodeId: route.selectedTarget ? route.selectedTarget._id : null,
        processingSlaWorkHours: route.selectedTarget ? route.selectedTarget.processingSlaWorkHours : null,
        activationTargetVersion: route.activationTarget.version,
        selectedTargetVersion: route.selectedTarget ? route.selectedTarget.version : null
      }
    })
  }

  function assertDecisionTiming(timing, source) {
    if (!timing || !validDate(timing.decisionAt) || !validDate(source.decisionStartedAt) ||
        timing.decisionAt.getTime() < source.decisionStartedAt.getTime() ||
        !['calculated', 'pending_calendar'].includes(timing.decisionTimingStatus) ||
        (timing.decisionTimingStatus === 'calculated' &&
          (!Number.isSafeInteger(timing.decisionWorkMinutes) || timing.decisionWorkMinutes < 0)) ||
        (timing.decisionTimingStatus === 'pending_calendar' && timing.decisionWorkMinutes !== null) ||
        (timing.decisionCalendarVersion !== null && typeof timing.decisionCalendarVersion !== 'string')) {
      throw createError('VERSION_CONFLICT')
    }
    return new Date(timing.decisionAt)
  }

  function assertProcessingTiming(timing, at) {
    if (!validDate(timing.processingStartedAt) || timing.processingStartedAt.getTime() !== at.getTime() ||
        !['calculated', 'pending_calendar'].includes(timing.processingDueStatus) ||
        (timing.processingDueStatus === 'calculated' && (!validDate(timing.processingDueAt) ||
          timing.processingDueAt.getTime() < at.getTime())) ||
        (timing.processingDueStatus === 'pending_calendar' && timing.processingDueAt !== null) ||
        (timing.processingCalendarVersion !== null && typeof timing.processingCalendarVersion !== 'string')) {
      throw createError('VERSION_CONFLICT')
    }
  }

  async function commitDecision(value) {
    return db.runTransaction(async transaction => {
      assertRequest(value)
      const account = safeActor(
        await readDocument(transaction, 'users', value.actor && value.actor._id), value.actor
      )
      const id = auditId(value)
      const existing = await readDocument(transaction, 'audit_logs', id)
      if (existing) {
        await assertRetryAuthorization(transaction, value)
        return publishedResult(existing, value)
      }
      const route = await loadRoute(transaction, value)
      if (!value.context || value.context.activationTargetVersion !== route.activationTarget.version ||
          value.context.selectedTargetVersion !== (route.selectedTarget ? route.selectedTarget.version : null) ||
          value.context.targetNodeId !== (route.selectedTarget ? route.selectedTarget._id : null) ||
          !validDate(value.context.decisionStartedAt) ||
          value.context.decisionStartedAt.getTime() !== route.source.decisionStartedAt.getTime()) {
        throw createError('VERSION_CONFLICT')
      }
      const decisionAt = assertDecisionTiming(value.timing, route.source)
      if (route.selectedTarget) assertProcessingTiming(value.timing, decisionAt)
      const lineVersion = increment(route.line.version)
      const nodeVersion = increment(route.source.version)
      const lineSearch = advanceSearchVersion(route.line)
      const sourceSearch = advanceSearchVersion(route.source)
      const decisionFields = {
        decision: value.input.decision, decisionAt, decisionActorId: account._id,
        decisionComment: value.input.comment,
        decisionTimingStatus: value.timing.decisionTimingStatus,
        decisionWorkMinutes: value.timing.decisionWorkMinutes,
        decisionCalendarVersion: value.timing.decisionCalendarVersion,
        decisionAnalyticsSnapshotStatus: 'pending',
        decisionAnalyticsSourceVersion: nextAnalyticsVersion(route.source),
        decisionReminderStatus: db.command.remove(),
        nextDecisionReminderWorkHour: db.command.remove(),
        lastDecisionReminderWorkHour: db.command.remove()
      }
      await transaction.collection('business_nodes').doc(route.source._id).update({ data: {
        ...decisionFields, status: 'completed', routeState: 'completed',
        version: nodeVersion, ...sourceSearch, updatedAt: db.serverDate()
      } })

      if (value.input.decision === 'skip') {
        const skippedVersion = increment(route.activationTarget.version)
        const skippedSearch = advanceSearchVersion(route.activationTarget)
        await transaction.collection('business_nodes').doc(route.activationTarget._id).update({ data: {
          status: 'skipped', routeState: 'skipped', skippedAt: decisionAt,
          analyticsSnapshotStatus: 'pending',
          analyticsSourceVersion: nextAnalyticsVersion(route.activationTarget),
          analyticsCompletedAt: decisionAt, version: skippedVersion,
          ...skippedSearch, updatedAt: db.serverDate()
        } })
      }

      let lineStatus = 'active'
      let currentNodeId = route.source._id
      let notificationType
      let recipients
      const lineFields = {
        awaitingManualDecision: false,
        routeDecisionVersion: increment(route.line.routeDecisionVersion, true),
        analyticsSnapshotStatus: 'pending',
        analyticsSourceVersion: nextAnalyticsVersion(route.line),
        version: lineVersion, ...lineSearch, updatedAt: db.serverDate()
      }
      if (route.selectedTarget) {
        const targetVersion = increment(route.selectedTarget.version)
        const targetSearch = advanceSearchVersion(route.selectedTarget)
        await transaction.collection('business_nodes').doc(route.selectedTarget._id).update({ data: {
          status: 'ready', routeState: 'active',
          processingStartedAt: new Date(value.timing.processingStartedAt),
          processingDueStatus: value.timing.processingDueStatus,
          processingDueAt: value.timing.processingDueAt === null ? null : new Date(value.timing.processingDueAt),
          processingCalendarVersion: value.timing.processingCalendarVersion,
          calendarNotificationStatus: value.timing.processingDueStatus === 'pending_calendar'
            ? 'pending' : 'not_required',
          version: targetVersion, ...targetSearch, updatedAt: db.serverDate()
        } })
        currentNodeId = route.selectedTarget._id
        Object.assign(lineFields, {
          currentNodeId, currentNodeIndex: route.selectedTarget.sequence,
          currentNodeName: route.selectedTarget.name
        })
        notificationType = 'node_processing_started'
        recipients = route.selectedRelationships.processors
      } else {
        lineStatus = 'completed'
        const purgeDueAt = new Date(decisionAt.getTime() + RETENTION_MS)
        Object.assign(lineFields, {
          status: 'completed', progress: 100, completedAt: decisionAt, frozenAt: decisionAt,
          retentionStartedAt: decisionAt, purgeDueAt
        })
        notificationType = 'business_completed'
        recipients = route.relationships.managers
      }
      await transaction.collection('business_lines').doc(route.line._id).update({ data: lineFields })
      if (!fitsIndexedAccountArray(recipients)) throw createError('VERSION_CONFLICT')
      const notificationId = `manual-route-result-${hash(`${id}\0${notificationType}`).slice(0, 40)}`
      await transaction.collection('notifications').doc(notificationId).set({ data: {
        type: notificationType, recipientUserIds: clone(recipients),
        businessLineId: route.line._id, nodeId: route.source._id,
        status: 'unread', createdAt: db.serverDate()
      } })
      if (route.selectedTarget && value.timing.processingDueStatus === 'pending_calendar') {
        const warningId = `work-calendar-missing-${hash(`${route.line._id}\0processing`).slice(0, 40)}`
        const warning = await readDocument(transaction, 'notifications', warningId)
        if (!warning) await transaction.collection('notifications').doc(warningId).set({ data: {
          type: 'work_calendar_missing', audienceRole: 'super_admin', status: 'pending',
          createdAt: db.serverDate()
        } })
      }
      const result = { decision: value.input.decision, lineStatus, currentNodeId, nodeVersion, lineVersion }
      await transaction.collection('audit_logs').doc(id).set({ data: {
        action: value.input.decision === 'activate' ? 'ACTIVATE_WORKFLOW_ROUTE' : 'SKIP_WORKFLOW_ROUTE',
        targetType: 'business_node', targetId: route.source._id, businessLineId: route.line._id,
        actorId: account._id, requestKeyHash: value.requestKeyHash, inputHash: value.inputHash,
        publishState: 'published', result: clone(result), createdAt: db.serverDate()
      } })
      return withSearchEnvelope(result, account._id, route.line._id, lineSearch.searchSourceVersion)
    })
  }

  return { inspectDecision, commitDecision }
}

module.exports = { createCloudManualRouteRepository }
