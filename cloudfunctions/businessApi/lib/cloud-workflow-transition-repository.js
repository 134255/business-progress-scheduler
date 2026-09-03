const crypto = require('node:crypto')

const { ownDataValue, ownExactAccountIds } = require('./account-relationship-schema')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { fitsIndexedAccountArray } = require('./index-key-budget')
const { advanceSearchVersion, currentSearchVersion } = require('./search-version')
const { resolveCompletedNodeTarget } = require('./workflow-routing-domain')

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const COMPLETABLE_STATUSES = new Set(['ready', 'in_progress', 'blocked', 'pending_review'])

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

function increment(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value === Number.MAX_SAFE_INTEGER) {
    throw createError('VERSION_CONFLICT')
  }
  return value + 1
}

function incrementCounter(value) {
  const normalized = value === undefined ? 0 : value
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized === Number.MAX_SAFE_INTEGER) {
    throw createError('VERSION_CONFLICT')
  }
  return normalized + 1
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

function createCloudWorkflowTransitionRepository({ db, clock = () => new Date() }) {
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
    if (!value || !value.input || !DOCUMENT_ID.test(value.input.businessLineId) ||
        !DOCUMENT_ID.test(value.input.nodeId) ||
        !Number.isSafeInteger(value.input.expectedLineVersion) || value.input.expectedLineVersion < 1 ||
        !Number.isSafeInteger(value.input.expectedNodeVersion) || value.input.expectedNodeVersion < 1 ||
        !Array.isArray(value.input.fieldValues) || !HASH.test(value.requestKeyHash) ||
        !HASH.test(value.inputHash)) throw createError('VALIDATION_ERROR')
  }

  function safeActor(account, actor) {
    if (!actor || !DOCUMENT_ID.test(actor._id) || !account || account._id !== actor._id ||
        account.status !== 'active') throw createError('FORBIDDEN')
    return account
  }

  function exactRoute(line, node, value, actorId) {
    const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(node, 'reviewerUserIds', { nonEmpty: false })
    const traversed = ownDataValue(line, 'traversedNodeIds')
    if (!managers || !members || !processors || !reviewers ||
        !fitsIndexedAccountArray(processors) || !fitsIndexedAccountArray(reviewers) ||
        !members.includes(actorId) ||
        (!processors.includes(actorId) && !reviewers.includes(actorId)) ||
        processors.some(id => reviewers.includes(id))) throw createError('FORBIDDEN')
    if (line._id !== value.input.businessLineId || node._id !== value.input.nodeId ||
        node.businessLineId !== line._id || line.flowSchemaVersion !== 2 || line.status !== 'active' ||
        line.currentNodeId !== node._id || line.currentNodeIndex !== node.sequence ||
        node.routeState !== 'active' || !COMPLETABLE_STATUSES.has(node.status) ||
        line.version !== value.input.expectedLineVersion || node.version !== value.input.expectedNodeVersion ||
        !traversed.valid || !Array.isArray(traversed.value) || traversed.value.includes(node._id) ||
        traversed.value.length >= 48 || new Set(traversed.value).size !== traversed.value.length ||
        !Number.isSafeInteger(line.routeDecisionVersion) || line.routeDecisionVersion < 0) {
      throw createError('VERSION_CONFLICT')
    }
    return { managers, members, processors, reviewers, traversedNodeIds: clone(traversed.value) }
  }

  function assertRetryAuthorization(line, node, value, actorId) {
    if (!line || !node || line._id !== value.input.businessLineId || node._id !== value.input.nodeId ||
        node.businessLineId !== line._id) throw createError('VERSION_CONFLICT')
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(node, 'reviewerUserIds', { nonEmpty: false })
    if (!members || !processors || !reviewers || !members.includes(actorId) ||
        (!processors.includes(actorId) && !reviewers.includes(actorId))) throw createError('FORBIDDEN')
  }

  function auditId(value) {
    return `workflow-transition-${value.requestKeyHash}`
  }

  function publishedResult(audit, value) {
    if (!audit || audit.publishState !== 'published' || audit.actorId !== value.actor._id ||
        audit.businessLineId !== value.input.businessLineId || audit.targetId !== value.input.nodeId ||
        audit.requestKeyHash !== value.requestKeyHash || audit.inputHash !== value.inputHash ||
        !audit.result || typeof audit.result !== 'object') throw createError('VERSION_CONFLICT')
    return clone(audit.result)
  }

  function resolve(node, fieldValues) {
    try {
      return resolveCompletedNodeTarget({ node, fieldValues })
    } catch (error) {
      throw createError('VERSION_CONFLICT')
    }
  }

  function assertTarget(target, lineId, targetId) {
    const processors = ownExactAccountIds(target, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(target, 'reviewerUserIds', { nonEmpty: false })
    if (!target || target._id !== targetId || target.businessLineId !== lineId ||
        target.routeState !== 'dormant' || target.status !== 'waiting' ||
        !Number.isSafeInteger(target.version) || target.version < 1 ||
        !Number.isSafeInteger(target.processingSlaWorkHours) || target.processingSlaWorkHours <= 0 ||
        target.processingDueStatus !== 'not_started' || target.processingDueAt !== null ||
        !processors || !reviewers || processors.some(id => reviewers.includes(id))) {
      throw createError('VERSION_CONFLICT')
    }
    return { processors, reviewers }
  }

  async function inspectCompletion(value) {
    return db.runTransaction(async transaction => {
      assertRequest(value)
      const account = safeActor(
        await readDocument(transaction, 'users', value.actor && value.actor._id), value.actor
      )
      const existing = await readDocument(transaction, 'audit_logs', auditId(value))
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      if (existing) {
        assertRetryAuthorization(line, node, value, account._id)
        return { retryResult: publishedResult(existing, value) }
      }
      exactRoute(line, node, value, account._id)
      const outcome = resolve(node, value.input.fieldValues)
      let targetNode = null
      if (outcome.kind === 'node') {
        targetNode = await readDocument(transaction, 'business_nodes', outcome.nodeId)
        assertTarget(targetNode, line._id, outcome.nodeId)
      }
      return { node: clone(node), targetNode: clone(targetNode) }
    })
  }

  function assertTransition(outcome, transition) {
    if (!transition || typeof transition !== 'object') throw createError('VERSION_CONFLICT')
    if (outcome.kind === 'end' && transition.kind === 'complete_line') return
    if (outcome.kind === 'manual' && transition.kind === 'await_manual_decision') return
    if (outcome.kind === 'node' && transition.kind === 'activate_node' &&
        transition.targetNodeId === outcome.nodeId) return
    throw createError('VERSION_CONFLICT')
  }

  function assertTiming(timing, target) {
    if (!timing || !validDate(timing.processingStartedAt) ||
        !['calculated', 'pending_calendar'].includes(timing.processingDueStatus) ||
        (timing.processingDueStatus === 'calculated' && (!validDate(timing.processingDueAt) ||
          timing.processingDueAt.getTime() < timing.processingStartedAt.getTime())) ||
        (timing.processingDueStatus === 'pending_calendar' && timing.processingDueAt !== null) ||
        (timing.processingCalendarVersion !== null &&
          typeof timing.processingCalendarVersion !== 'string') ||
        target.processingDueStatus !== 'not_started' || target.processingDueAt !== null) {
      throw createError('VERSION_CONFLICT')
    }
  }

  async function commitCompletion(value) {
    return db.runTransaction(async transaction => {
      assertRequest(value)
      const account = safeActor(
        await readDocument(transaction, 'users', value.actor && value.actor._id), value.actor
      )
      const id = auditId(value)
      const existing = await readDocument(transaction, 'audit_logs', id)
      const line = await readDocument(transaction, 'business_lines', value.input.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', value.input.nodeId)
      if (existing) {
        assertRetryAuthorization(line, node, value, account._id)
        return publishedResult(existing, value)
      }
      const relationships = exactRoute(line, node, value, account._id)
      const outcome = resolve(node, value.input.fieldValues)
      assertTransition(outcome, value.transition)
      if (!value.context || !value.context.node || value.context.node.version !== node.version ||
          JSON.stringify(value.context.node.next) !== JSON.stringify(node.next) ||
          JSON.stringify(value.context.node.fieldDefinitions) !== JSON.stringify(node.fieldDefinitions)) {
        throw createError('VERSION_CONFLICT')
      }
      let target = null
      let targetRelationships = null
      if (outcome.kind === 'node') {
        target = await readDocument(transaction, 'business_nodes', outcome.nodeId)
        targetRelationships = assertTarget(target, line._id, outcome.nodeId)
        if (!value.context.targetNode || value.context.targetNode.version !== target.version ||
            value.context.targetNode._id !== target._id) throw createError('VERSION_CONFLICT')
        assertTiming(value.timing, target)
      }
      const at = clock()
      if (!validDate(at)) throw new TypeError('clock must return a Date')
      const lineVersion = increment(line.version)
      const nodeVersion = increment(node.version)
      const lineSearch = advanceSearchVersion(line)
      const nodeSearch = advanceSearchVersion(node)
      const traversedNodeIds = [...relationships.traversedNodeIds, node._id]
      const commonLine = {
        traversedNodeIds,
        routeDecisionVersion: incrementCounter(line.routeDecisionVersion),
        analyticsSnapshotStatus: 'pending',
        analyticsSourceVersion: nextAnalyticsVersion(line),
        version: lineVersion,
        ...lineSearch,
        updatedAt: db.serverDate()
      }
      const commonNode = {
        completedAt: new Date(at),
        analyticsSnapshotStatus: 'pending',
        analyticsSourceVersion: nextAnalyticsVersion(node),
        analyticsCompletedAt: new Date(at),
        version: nodeVersion,
        ...nodeSearch,
        updatedAt: db.serverDate()
      }
      let result
      let notificationType
      let recipients
      if (outcome.kind === 'node') {
        const targetVersion = increment(target.version)
        const targetSearch = advanceSearchVersion(target)
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          ...commonNode, status: 'completed', routeState: 'completed'
        } })
        await transaction.collection('business_nodes').doc(target._id).update({ data: {
          status: 'ready', routeState: 'active',
          processingStartedAt: new Date(value.timing.processingStartedAt),
          processingDueStatus: value.timing.processingDueStatus,
          processingDueAt: value.timing.processingDueAt === null
            ? null
            : new Date(value.timing.processingDueAt),
          processingCalendarVersion: value.timing.processingCalendarVersion,
          calendarNotificationStatus: value.timing.processingDueStatus === 'pending_calendar'
            ? 'pending'
            : 'not_required',
          version: targetVersion,
          ...targetSearch,
          updatedAt: db.serverDate()
        } })
        await transaction.collection('business_lines').doc(line._id).update({ data: {
          ...commonLine,
          currentNodeId: target._id,
          currentNodeIndex: target.sequence,
          currentNodeName: target.name,
          awaitingManualDecision: false
        } })
        result = {
          nodeStatus: 'completed', lineStatus: 'active', currentNodeId: target._id,
          routeState: 'active', lineVersion, nodeVersion
        }
        notificationType = 'node_processing_started'
        recipients = targetRelationships.processors
      } else if (outcome.kind === 'manual') {
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          ...commonNode, status: 'awaiting_decision', routeState: 'awaiting_manual_decision',
          decisionStartedAt: new Date(at)
        } })
        await transaction.collection('business_lines').doc(line._id).update({ data: {
          ...commonLine, awaitingManualDecision: true
        } })
        result = {
          nodeStatus: 'awaiting_decision', lineStatus: 'active', currentNodeId: node._id,
          routeState: 'awaiting_manual_decision', lineVersion, nodeVersion
        }
        notificationType = 'node_route_decision_pending'
        recipients = [...new Set([...relationships.processors, ...relationships.reviewers])]
      } else {
        const purgeDueAt = new Date(at.getTime() + RETENTION_MS)
        await transaction.collection('business_nodes').doc(node._id).update({ data: {
          ...commonNode, status: 'completed', routeState: 'completed'
        } })
        await transaction.collection('business_lines').doc(line._id).update({ data: {
          ...commonLine,
          status: 'completed', progress: 100, completedAt: new Date(at), frozenAt: new Date(at),
          retentionStartedAt: new Date(at), purgeDueAt, awaitingManualDecision: false
        } })
        result = {
          nodeStatus: 'completed', lineStatus: 'completed', currentNodeId: node._id,
          routeState: 'completed', lineVersion, nodeVersion
        }
        notificationType = 'business_completed'
        recipients = relationships.managers
      }
      if (!fitsIndexedAccountArray(recipients)) throw createError('VERSION_CONFLICT')
      const notificationId = `workflow-result-${hash(`${id}\0${notificationType}`).slice(0, 40)}`
      await transaction.collection('notifications').doc(notificationId).set({ data: {
        type: notificationType,
        recipientUserIds: clone(recipients),
        businessLineId: line._id,
        nodeId: node._id,
        status: 'unread',
        createdAt: db.serverDate()
      } })
      await transaction.collection('audit_logs').doc(id).set({ data: {
        action: 'COMPLETE_WORKFLOW_NODE',
        targetType: 'business_node',
        targetId: node._id,
        businessLineId: line._id,
        actorId: account._id,
        requestKeyHash: value.requestKeyHash,
        inputHash: value.inputHash,
        transitionKind: value.transition.kind,
        publishState: 'published',
        result: clone(result),
        createdAt: db.serverDate()
      } })
      return withSearchEnvelope(result, account._id, line._id, lineSearch.searchSourceVersion)
    })
  }

  return { inspectCompletion, commitCompletion }
}

module.exports = { createCloudWorkflowTransitionRepository }
