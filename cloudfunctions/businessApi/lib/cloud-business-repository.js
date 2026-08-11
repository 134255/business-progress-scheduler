const crypto = require('node:crypto')

const { formatBusinessCode, formatNodeCode } = require('./business-numbering')
const { createCloudWorkCalendarRepository } = require('./cloud-work-calendar-repository')
const { createWorkTimeService } = require('./work-time-service')
const { FEEDBACK_TOTAL_LIMIT } = require('./evidence-policy')
const { parseStrictTimestamp } = require('./evidence-retention')
const {
  APPLICATION_ERROR_MARKER,
  MAX_TEMPLATE_NODES,
  TEMPLATE_LIMIT_MESSAGE
} = require('./cloud-template-repository')

const COLLECTIONS = Object.freeze({
  templates: 'templates',
  templateNodes: 'template_nodes',
  users: 'users',
  counters: 'sequence_counters',
  lines: 'business_lines',
  nodes: 'business_nodes',
  notifications: 'notifications',
  audit: 'audit_logs'
})
const QUERY_PAGE_SIZE = 100
const MAX_TRANSACTION_OPERATIONS = 100
const MAX_DUPLICATE_RETRIES = 3
const SNAPSHOT_LIMIT_MESSAGE = 'Template snapshot transaction operation budget exceeded; reduce distinct assignees'
const FROZEN_BUSINESS_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const CLOSURE_OUTCOMES = new Set(['cancelled', 'closed', 'deleted'])
const RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const AMENDMENT_EVIDENCE_CHUNK_SIZE = 40
const AMENDMENT_CLAIM_LIFETIME_MS = 15 * 60 * 1000

function createError(code, message = code) {
  const error = new Error(message)
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

function isMissingDocumentError(error) {
  const codes = [error && error.code, error && error.errCode].map(value => String(value || '').toUpperCase())
  if (codes.includes('DOCUMENT_NOT_FOUND')) return true
  const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
  return text.includes('document.get:fail') && text.includes('document with _id') && text.includes('does not exist')
}

function isDuplicateError(error) {
  if (Number(error && error.errCode) === -502005) return true
  return /duplicate key|duplicate value|unique index/i.test(String(error && error.message || ''))
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function creationIdentity(actorId, input) {
  const actor = String(actorId || '')
  if (!actor || !input || typeof input.requestKey !== 'string' || !input.requestKey) {
    throw createError('VALIDATION_ERROR')
  }
  const requestHash = hash(`${actor}\0${input.requestKey}`)
  const inputHash = hash(JSON.stringify([
    actor,
    input.templateId,
    input.name,
    input.description,
    input.plannedStartDate,
    input.plannedEndDate
  ]))
  return { lineId: `business-${requestHash}`, requestHash, inputHash }
}

function assertMatchingReservation(line, actorId, identity) {
  if (line.createdBy !== actorId || line.creationRequestHash !== identity.requestHash ||
      line.creationInputHash !== identity.inputHash) {
    throw createError('VERSION_CONFLICT')
  }
}

function compareNodes(left, right) {
  return Number(left.sequence) - Number(right.sequence) || String(left._id).localeCompare(String(right._id))
}

function snapshotParticipantUserIds(nodes) {
  if (!Array.isArray(nodes)) return []
  return [...new Set(nodes.flatMap(node => {
    if (node && node.workflowMode === 'review') {
      return [
        ...(Array.isArray(node.processorUserIds) ? node.processorUserIds : []),
        ...(Array.isArray(node.reviewerUserIds) ? node.reviewerUserIds : [])
      ]
    }
    return Array.isArray(node && node.assigneeUserIds) ? node.assigneeUserIds : []
  }))].sort()
}

function snapshotReservationOperationCount(nodes) {
  if (!Array.isArray(nodes)) return Number.POSITIVE_INFINITY
  return nodes.length + snapshotParticipantUserIds(nodes).length + 6
}

function canCreateBusinessSnapshot(nodes) {
  return Array.isArray(nodes) && nodes.length > 0 && nodes.length <= MAX_TEMPLATE_NODES &&
    snapshotReservationOperationCount(nodes) <= MAX_TRANSACTION_OPERATIONS
}

function createCloudBusinessRepository({
  db,
  clock = () => new Date(),
  duplicateRetries = MAX_DUPLICATE_RETRIES,
  workTimeService
}) {
  if (!db) throw new TypeError('db is required')
  const dueTimeService = workTimeService || createWorkTimeService({
    calendarRepository: createCloudWorkCalendarRepository({ db })
  })
  if (!dueTimeService || typeof dueTimeService.tryAddWorkMinutes !== 'function') {
    throw new TypeError('workTimeService.tryAddWorkMinutes is required')
  }

  async function readDocument(database, collectionName, id) {
    try {
      const result = await database.collection(collectionName).doc(id).get()
      return result && result.data ? result.data : null
    } catch (error) {
      if (isMissingDocumentError(error)) return null
      throw error
    }
  }

  async function readTemplateNodes(templateId) {
    const nodes = []
    for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
      const result = await db.collection(COLLECTIONS.templateNodes)
        .where({ templateId })
        .orderBy('sequence', 'asc')
        .skip(offset)
        .limit(QUERY_PAGE_SIZE)
        .get()
      const page = result.data || []
      nodes.push(...page)
      if (page.length < QUERY_PAGE_SIZE) return nodes.sort(compareNodes)
    }
  }

  async function getTemplateDefinition(templateId) {
    const template = await readDocument(db, COLLECTIONS.templates, templateId)
    if (!template || template.status === 'deleted') return null
    return { template, nodes: await readTemplateNodes(templateId) }
  }

  async function readAll(buildQuery) {
    const results = []
    for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
      const response = await buildQuery().skip(offset).limit(QUERY_PAGE_SIZE).get()
      const page = response.data || []
      results.push(...page)
      if (page.length < QUERY_PAGE_SIZE) return results
    }
  }

  function membershipArray(value) {
    return Array.isArray(value) ? value : []
  }

  function isNewLineMember(line, actorId) {
    return [...membershipArray(line.managerUserIds), ...membershipArray(line.memberUserIds)]
      .includes(actorId)
  }

  function isLegacyLineMember(line, openid) {
    return Boolean(openid) && [...membershipArray(line.managerIds), ...membershipArray(line.memberIds)]
      .includes(openid)
  }

  function usesAccountMembership(line) {
    return Object.prototype.hasOwnProperty.call(line, 'managerUserIds') ||
      Object.prototype.hasOwnProperty.call(line, 'memberUserIds')
  }

  function assertLineMember(line, actor) {
    const allowed = usesAccountMembership(line)
      ? isNewLineMember(line, actor._id)
      : isLegacyLineMember(line, actor.openid)
    if (!allowed) throw createError('FORBIDDEN')
  }

  function isLineManager(line, actor) {
    return usesAccountMembership(line)
      ? membershipArray(line.managerUserIds).includes(actor._id)
      : Boolean(actor.openid) && membershipArray(line.managerIds).includes(actor.openid)
  }

  function usesAccountAssignees(node) {
    return Object.prototype.hasOwnProperty.call(node, 'assigneeUserIds')
  }

  function assertCurrentAssignee(line, node, actor) {
    const accountSchema = usesAccountMembership(line) || usesAccountAssignees(node)
    const memberAllowed = accountSchema
      ? isNewLineMember(line, actor._id)
      : isLegacyLineMember(line, actor.openid)
    const assigneeAllowed = accountSchema
      ? membershipArray(node.assigneeUserIds).includes(actor._id)
      : Boolean(actor.openid) && membershipArray(node.assigneeIds).includes(actor.openid)
    if (!memberAllowed || !assigneeAllowed) throw createError('FORBIDDEN')
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

  function rejectionIdentity(actorId, input) {
    const requestHash = hash(`${actorId}\0${input.requestKey}`)
    const inputHash = hash(JSON.stringify([
      actorId,
      input.lineId,
      input.currentNodeId,
      input.expectedCurrentVersion,
      input.expectedPreviousVersion,
      input.reason
    ]))
    return {
      auditId: `business-rejection-${requestHash}`,
      requestHash,
      inputHash
    }
  }

  function compareUpdatedDesc(left, right) {
    const leftValue = left.updatedAt instanceof Date ? left.updatedAt.getTime() : Number(left.updatedAt)
    const rightValue = right.updatedAt instanceof Date ? right.updatedAt.getTime() : Number(right.updatedAt)
    if (Number.isFinite(leftValue) && Number.isFinite(rightValue) && leftValue !== rightValue) {
      return rightValue - leftValue
    }
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')) ||
      String(left._id).localeCompare(String(right._id))
  }

  async function listBusinessLines({ actor, query = {} }) {
    const accountMemberLines = await readAll(() => db.collection(COLLECTIONS.lines)
      .where({ memberUserIds: actor._id })
      .orderBy('updatedAt', 'desc'))
    const accountManagerLines = await readAll(() => db.collection(COLLECTIONS.lines)
      .where({ managerUserIds: actor._id })
      .orderBy('updatedAt', 'desc'))
    const legacyMemberLines = actor.openid
      ? await readAll(() => db.collection(COLLECTIONS.lines)
        .where({ memberIds: actor.openid })
        .orderBy('updatedAt', 'desc'))
      : []
    const legacyManagerLines = actor.openid
      ? await readAll(() => db.collection(COLLECTIONS.lines)
        .where({ managerIds: actor.openid })
        .orderBy('updatedAt', 'desc'))
      : []
    const byId = new Map([
      ...accountMemberLines,
      ...accountManagerLines,
      ...legacyMemberLines,
      ...legacyManagerLines
    ].map(line => [line._id, line]))
    const keyword = String(query.keyword || '').trim().toLowerCase()
    const start = query.startDate ? new Date(`${query.startDate}T00:00:00+08:00`) : null
    const end = query.endDate ? new Date(`${query.endDate}T23:59:59+08:00`) : null
    const visible = [...byId.values()]
      .filter(line => usesAccountMembership(line)
        ? isNewLineMember(line, actor._id)
        : isLegacyLineMember(line, actor.openid))
      .filter(line => line.status !== 'creating' && line.status !== 'deleted')
      .filter(line => !keyword || [line.name, line.code]
        .some(value => String(value || '').toLowerCase().includes(keyword)))
      .filter(line => {
        const itemDate = line.plannedStartDate ? new Date(line.plannedStartDate) : null
        return (!start || (itemDate && itemDate >= start)) && (!end || (itemDate && itemDate <= end))
      })
      .sort(compareUpdatedDesc)
    const page = Number.isSafeInteger(query.page) && query.page > 0 ? query.page : 1
    const pageSize = Number.isSafeInteger(query.pageSize) && query.pageSize >= 5 && query.pageSize <= 50
      ? query.pageSize
      : 20
    const offset = (page - 1) * pageSize
    return {
      items: visible.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: visible.length,
      hasMore: offset + pageSize < visible.length
    }
  }

  function frozenLineProjection(line) {
    return {
      _id: line._id,
      code: line.code || '',
      name: line.name || '',
      description: line.description || '',
      plannedStartDate: line.plannedStartDate || '',
      plannedEndDate: line.plannedEndDate || '',
      status: line.status,
      version: line.version,
      progress: Number(line.progress || 0),
      nodeCount: Number(line.nodeCount || 0),
      currentNodeId: line.currentNodeId || '',
      currentNodeName: line.currentNodeName || '',
      frozenAt: clone(line.frozenAt || null),
      retentionStartedAt: clone(line.retentionStartedAt || null),
      purgeDueAt: clone(line.purgeDueAt || null),
      updatedAt: clone(line.updatedAt || null)
    }
  }

  function frozenNodeProjection(node) {
    return {
      _id: node._id,
      nodeCode: node.nodeCode || '',
      sequence: Number(node.sequence || 0),
      name: node.name || '',
      description: node.description || '',
      status: node.status,
      version: node.version,
      activatedAt: clone(node.activatedAt || null),
      dueAt: clone(node.dueAt || null),
      completedAt: clone(node.completedAt || null),
      overdueWorkMinutes: Number(node.overdueWorkMinutes || 0),
      rejectionCount: Number(node.rejectionCount || 0)
    }
  }

  function amendmentEvidenceProjection(evidence) {
    return {
      evidenceId: evidence._id,
      fileName: evidence.fileName || '',
      category: evidence.category || '',
      size: Number(evidence.size || 0),
      storageStatus: evidence.storageStatus || ''
    }
  }

  function amendmentProjection(amendment, evidences) {
    return {
      amendmentId: amendment._id,
      reason: amendment.reason || '',
      before: clone(amendment.before || {}),
      after: clone(amendment.after || {}),
      beforeVersion: amendment.beforeVersion,
      afterVersion: amendment.afterVersion,
      publishedAt: clone(amendment.publishedAt || amendment.transitionAt || amendment.createdAt || null),
      evidences: evidences.map(amendmentEvidenceProjection)
    }
  }

  async function requireCurrentSuperAdmin(actorId) {
    const actor = await readDocument(db, COLLECTIONS.users, actorId)
    if (!actor || actor.status !== 'active' || actor.role !== 'super_admin') throw createError('FORBIDDEN')
    return actor
  }

  async function listFrozenBusinessesForAdmin({ actor, query }) {
    await requireCurrentSuperAdmin(actor && actor._id)
    const groups = await Promise.all([...FROZEN_BUSINESS_STATUSES].map(status =>
      readAll(() => db.collection(COLLECTIONS.lines).where({ status }))))
    await requireCurrentSuperAdmin(actor && actor._id)
    const keyword = query.keyword.toLowerCase()
    const items = groups.flat()
      .filter(line => !keyword || [line.code, line.name]
        .some(value => String(value || '').toLowerCase().includes(keyword)))
      .sort(compareUpdatedDesc)
      .map(frozenLineProjection)
    const offset = (query.page - 1) * query.pageSize
    return {
      items: items.slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: items.length,
      hasMore: offset + query.pageSize < items.length
    }
  }

  async function getFrozenBusinessForAdmin({ actor, lineId }) {
    const line = await db.runTransaction(async transaction => {
      const currentActor = await readDocument(transaction, COLLECTIONS.users, actor && actor._id)
      if (!currentActor || currentActor.status !== 'active' || currentActor.role !== 'super_admin') {
        throw createError('FORBIDDEN')
      }
      const currentLine = await readDocument(transaction, COLLECTIONS.lines, lineId)
      if (!currentLine || currentLine.status === 'creating' || !FROZEN_BUSINESS_STATUSES.has(currentLine.status)) {
        throw createError('NOT_FOUND')
      }
      return currentLine
    })
    const [nodes, auditRows, evidences] = await Promise.all([
      readAll(() => db.collection(COLLECTIONS.nodes).where({ businessLineId: line._id })),
      readAll(() => db.collection(COLLECTIONS.audit).where({ targetId: line._id })),
      readAll(() => db.collection('evidences').where({ businessLineId: line._id }))
    ])
    await requireCurrentSuperAdmin(actor && actor._id)
    const amendments = auditRows
      .filter(item => item.action === 'AMEND_FROZEN_BUSINESS' && item.targetType === 'business_line' &&
        item.targetId === line._id && item.publishState === 'published')
      .sort(compareUpdatedDesc)
      .map(item => amendmentProjection(item, evidences.filter(evidence =>
        evidence.amendmentId === item._id && evidence.businessLineId === line._id && evidence.nodeId === null)))
    return {
      line: frozenLineProjection(line),
      nodes: nodes.sort(compareNodes).map(frozenNodeProjection),
      amendments
    }
  }

  async function getBusinessLine({ actor, lineId }) {
    const line = await readDocument(db, COLLECTIONS.lines, lineId)
    if (!line || line.status === 'creating' || line.status === 'deleted') throw createError('NOT_FOUND')
    assertLineMember(line, actor)
    const nodes = (await readAll(() => db.collection(COLLECTIONS.nodes)
      .where({ businessLineId: line._id })
      .orderBy('sequence', 'asc'))).sort(compareNodes)
    const accountSchema = usesAccountMembership(line)
    const canManage = accountSchema
      ? membershipArray(line.managerUserIds).includes(actor._id)
      : Boolean(actor.openid) && membershipArray(line.managerIds).includes(actor.openid)
    const projectedNodes = nodes.map(node => ({
      ...node,
      canFeedback: canManage || (accountSchema
        ? membershipArray(node.assigneeUserIds).includes(actor._id)
        : Boolean(actor.openid) && membershipArray(node.assigneeIds).includes(actor.openid)),
      assigneeNamesText: (node.assigneeNames || []).join('、')
    }))
    const canEditNodes = !accountSchema && canManage && Number(line.progress || 0) === 0 &&
      projectedNodes.every(node => ['pending', 'ready'].includes(node.status) && !node.latestComment)
    return { line, nodes: projectedNodes, canManage, canEditNodes }
  }

  async function updateBusinessMetadata({ actor, lineId, expectedVersion, metadata }) {
    return db.runTransaction(async transaction => {
      const currentActor = await readDocument(transaction, COLLECTIONS.users, actor && actor._id)
      if (!currentActor || currentActor.status !== 'active') throw createError('FORBIDDEN')
      const line = await readDocument(transaction, COLLECTIONS.lines, lineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      if (FROZEN_BUSINESS_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
      if (!isLineManager(line, currentActor)) throw createError('FORBIDDEN')
      if (line.version !== expectedVersion) throw createError('VERSION_CONFLICT')
      if (!Number.isSafeInteger(line.version) || line.version < 1 || line.version === Number.MAX_SAFE_INTEGER) {
        throw createError('VERSION_CONFLICT')
      }
      const nextVersion = line.version + 1
      await transaction.collection(COLLECTIONS.lines).doc(lineId).update({
        data: {
          name: metadata.name,
          description: metadata.description,
          plannedStartDate: metadata.plannedStartDate,
          plannedEndDate: metadata.plannedEndDate,
          version: nextVersion,
          updatedAt: db.serverDate()
        }
      })
      await transaction.collection(COLLECTIONS.audit).doc(`business-metadata-${lineId}-${nextVersion}`).set({
        data: {
          actorId: actor._id,
          action: 'UPDATE_BUSINESS_METADATA',
          targetType: 'business_line',
          targetId: lineId,
          beforeVersion: line.version,
          afterVersion: nextVersion,
          createdAt: db.serverDate()
        }
      })
      return { id: lineId, version: nextVersion }
    })
  }

  async function rejectPreviousNode(input) {
    const identity = rejectionIdentity(input.actor && input.actor._id, input)
    const currentSequence = await db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, COLLECTIONS.users, input.actor && input.actor._id)
      if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
      const line = await readDocument(transaction, COLLECTIONS.lines, input.lineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      const current = await readDocument(transaction, COLLECTIONS.nodes, input.currentNodeId)
      if (!current || current.businessLineId !== line._id) throw createError('NOT_FOUND')
      assertCurrentAssignee(line, current, actor)
      return Number(current.sequence)
    })
    if (!Number.isSafeInteger(currentSequence) || currentSequence < 1) {
      throw createError('REJECTION_NOT_ALLOWED')
    }
    const candidates = await readAll(() => db.collection(COLLECTIONS.nodes)
      .where({ businessLineId: input.lineId }))
    const previousCandidates = candidates.filter(node => Number(node.sequence) === currentSequence - 1)
    if (previousCandidates.length !== 1) throw createError('REJECTION_NOT_ALLOWED')
    const previousNodeId = previousCandidates[0]._id
    const at = clock()

    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, COLLECTIONS.users, input.actor && input.actor._id)
      if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
      const line = await readDocument(transaction, COLLECTIONS.lines, input.lineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      const current = await readDocument(transaction, COLLECTIONS.nodes, input.currentNodeId)
      if (!current || current.businessLineId !== line._id) throw createError('NOT_FOUND')
      assertCurrentAssignee(line, current, actor)

      const existing = await readDocument(transaction, COLLECTIONS.audit, identity.auditId)
      if (existing) {
        if (existing.action !== 'REJECT_PREVIOUS_NODE' || existing.actorId !== actor._id ||
            existing.targetId !== line._id || existing.currentNodeId !== current._id ||
            existing.previousNodeId !== previousNodeId || existing.requestHash !== identity.requestHash ||
            existing.inputHash !== identity.inputHash || !existing.result) {
          throw createError('VERSION_CONFLICT')
        }
        return clone(existing.result)
      }

      if (line.status !== 'active' || line.currentNodeId !== current._id ||
          !['ready', 'in_progress', 'blocked'].includes(current.status) || current.feedbackClaimId) {
        throw createError('REJECTION_NOT_ALLOWED')
      }
      const previous = await readDocument(transaction, COLLECTIONS.nodes, previousNodeId)
      if (!previous || previous.businessLineId !== line._id || previous.status !== 'completed' ||
          Number(previous.sequence) + 1 !== Number(current.sequence)) {
        throw createError('REJECTION_NOT_ALLOWED')
      }
      if (current.version !== input.expectedCurrentVersion ||
          previous.version !== input.expectedPreviousVersion) {
        throw createError('VERSION_CONFLICT')
      }

      const currentVersion = increment(current.version)
      const previousVersion = increment(previous.version)
      const lineVersion = increment(line.version)
      const rejectionCount = incrementCounter(previous.rejectionCount)
      const nodeCount = Number(line.nodeCount)
      if (!Number.isSafeInteger(nodeCount) || nodeCount < 1) throw createError('VERSION_CONFLICT')
      const progress = Math.floor((Number(previous.sequence) / nodeCount) * 100)
      const result = {
        businessLineId: line._id,
        previousNodeId: previous._id,
        currentNodeId: current._id,
        previousVersion,
        currentVersion,
        lineVersion
      }

      await transaction.collection(COLLECTIONS.nodes).doc(previous._id).update({ data: {
        status: 'in_progress',
        version: previousVersion,
        rejectionCount,
        lastRejectedAt: at,
        lastReactivatedAt: at,
        updatedAt: db.serverDate()
      } })
      await transaction.collection(COLLECTIONS.nodes).doc(current._id).update({ data: {
        status: 'waiting',
        version: currentVersion,
        lastReturnedToWaitingAt: at,
        updatedAt: db.serverDate()
      } })
      await transaction.collection(COLLECTIONS.lines).doc(line._id).update({ data: {
        currentNodeId: previous._id,
        currentNodeIndex: previous.sequence,
        currentNodeName: previous.name,
        progress,
        version: lineVersion,
        updatedAt: db.serverDate()
      } })
      await transaction.collection(COLLECTIONS.audit).doc(identity.auditId).set({ data: {
        actorId: actor._id,
        action: 'REJECT_PREVIOUS_NODE',
        targetType: 'business_line',
        targetId: line._id,
        previousNodeId: previous._id,
        currentNodeId: current._id,
        reason: input.reason,
        requestHash: identity.requestHash,
        inputHash: identity.inputHash,
        result,
        createdAt: db.serverDate()
      } })
      return result
    })
  }

  async function closeBusinessLine({ actor, lineId, expectedVersion, outcome, reason }) {
    if (!CLOSURE_OUTCOMES.has(outcome)) throw createError('VALIDATION_ERROR')
    const at = clock()
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError('clock must return a Date')
    const purgeDueAt = new Date(at.getTime() + RETENTION_MS)
    return db.runTransaction(async transaction => {
      const currentActor = await readDocument(transaction, COLLECTIONS.users, actor && actor._id)
      if (!currentActor || currentActor.status !== 'active') throw createError('FORBIDDEN')
      const line = await readDocument(transaction, COLLECTIONS.lines, lineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      if (currentActor.role !== 'super_admin' && !isLineManager(line, currentActor)) {
        throw createError('FORBIDDEN')
      }
      if (FROZEN_BUSINESS_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
      if (line.status !== 'active') throw createError('BUSINESS_FROZEN')
      if (line.version !== expectedVersion) throw createError('VERSION_CONFLICT')
      const version = increment(line.version)
      const changes = {
        status: outcome,
        version,
        frozenAt: at,
        retentionStartedAt: at,
        purgeDueAt,
        [`${outcome}At`]: at,
        updatedAt: db.serverDate()
      }
      if (outcome === 'deleted') changes.closedAt = at
      await transaction.collection(COLLECTIONS.lines).doc(line._id).update({ data: changes })
      await transaction.collection(COLLECTIONS.audit).doc(`business-close-${line._id}-${version}`).set({ data: {
        actorId: currentActor._id,
        action: 'CLOSE_BUSINESS',
        targetType: 'business_line',
        targetId: line._id,
        beforeStatus: line.status,
        afterStatus: outcome,
        beforeVersion: line.version,
        afterVersion: version,
        reason,
        createdAt: db.serverDate()
      } })
      return { businessLineId: line._id, status: outcome, version }
    })
  }

  function amendmentIdentity(input) {
    const nextVersion = increment(input.expectedVersion)
    const amendmentId = `business-amend-${input.lineId}-${nextVersion}`
    const evidenceDigest = hash(JSON.stringify(input.evidenceIds))
    const inputHash = hash(JSON.stringify([
      input.actor && input.actor._id,
      input.lineId,
      input.expectedVersion,
      input.reason,
      input.changes,
      evidenceDigest,
      input.evidenceIds.length
    ]))
    return { amendmentId, nextVersion, evidenceDigest, inputHash }
  }

  function assertAmendmentActor(actor) {
    if (!actor || actor.status !== 'active' || actor.role !== 'super_admin') throw createError('FORBIDDEN')
  }

  function assertAmendmentReservation(reservation, input, identity) {
    if (!reservation || reservation.action !== 'AMEND_FROZEN_BUSINESS' ||
        reservation.actorId !== input.actor._id || reservation.targetId !== input.lineId ||
        reservation.beforeVersion !== input.expectedVersion ||
        reservation.afterVersion !== identity.nextVersion ||
        reservation.inputHash !== identity.inputHash ||
        reservation.evidenceDigest !== identity.evidenceDigest ||
        reservation.evidenceCount !== input.evidenceIds.length) {
      throw createError('VERSION_CONFLICT')
    }
  }

  function strictFuture(value, now) {
    return value instanceof Date && !Number.isNaN(value.getTime()) && value.getTime() > now.getTime()
  }

  async function beginAmendment(input, identity, at) {
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, COLLECTIONS.users, input.actor && input.actor._id)
      assertAmendmentActor(actor)
      const line = await readDocument(transaction, COLLECTIONS.lines, input.lineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      const existing = await readDocument(transaction, COLLECTIONS.audit, identity.amendmentId)
      if (existing) {
        assertAmendmentReservation(existing, input, identity)
        if (existing.publishState === 'published') return { published: true, result: clone(existing.result) }
        if (existing.publishState !== 'reserved') throw createError('VERSION_CONFLICT')
        if (line.version !== input.expectedVersion || !FROZEN_BUSINESS_STATUSES.has(line.status)) {
          throw createError('VERSION_CONFLICT')
        }
        return { published: false, reservation: existing }
      }
      if (!FROZEN_BUSINESS_STATUSES.has(line.status)) throw createError('BUSINESS_FROZEN')
      if (line.version !== input.expectedVersion) throw createError('VERSION_CONFLICT')
      const mergedStart = Object.prototype.hasOwnProperty.call(input.changes, 'plannedStartDate')
        ? input.changes.plannedStartDate
        : line.plannedStartDate || ''
      const mergedEnd = Object.prototype.hasOwnProperty.call(input.changes, 'plannedEndDate')
        ? input.changes.plannedEndDate
        : line.plannedEndDate || ''
      if (mergedStart && mergedEnd && mergedStart > mergedEnd) throw createError('VALIDATION_ERROR')
      const before = {}
      const after = {}
      for (const [key, value] of Object.entries(input.changes)) {
        before[key] = clone(line[key])
        after[key] = clone(value)
      }
      const reservation = {
        actorId: actor._id,
        action: 'AMEND_FROZEN_BUSINESS',
        targetType: 'business_line',
        targetId: line._id,
        reason: input.reason,
        before,
        after,
        beforeVersion: line.version,
        afterVersion: identity.nextVersion,
        inputHash: identity.inputHash,
        evidenceDigest: identity.evidenceDigest,
        evidenceCount: input.evidenceIds.length,
        claimedCount: 0,
        claimedBytes: 0,
        claimedDigest: hash(JSON.stringify([])),
        publishState: 'reserved',
        transitionAt: at,
        claimExpiresAt: new Date(at.getTime() + AMENDMENT_CLAIM_LIFETIME_MS),
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      await transaction.collection(COLLECTIONS.audit).doc(identity.amendmentId).set({ data: reservation })
      return { published: false, reservation: { _id: identity.amendmentId, ...reservation } }
    })
  }

  async function claimAmendmentEvidence(input, identity, at) {
    for (;;) {
      const outcome = await db.runTransaction(async transaction => {
        const actor = await readDocument(transaction, COLLECTIONS.users, input.actor && input.actor._id)
        assertAmendmentActor(actor)
        const line = await readDocument(transaction, COLLECTIONS.lines, input.lineId)
        if (!line || line.status === 'creating') throw createError('NOT_FOUND')
        const reservation = await readDocument(transaction, COLLECTIONS.audit, identity.amendmentId)
        assertAmendmentReservation(reservation, input, identity)
        if (reservation.publishState === 'published') return { done: true, result: clone(reservation.result) }
        if (!FROZEN_BUSINESS_STATUSES.has(line.status) || line.version !== input.expectedVersion) {
          throw createError('VERSION_CONFLICT')
        }
        if (reservation.publishState !== 'reserved' || !Number.isSafeInteger(reservation.claimedCount) ||
            reservation.claimedCount < 0 || reservation.claimedCount > input.evidenceIds.length ||
            !Number.isSafeInteger(reservation.claimedBytes) || reservation.claimedBytes < 0 ||
            reservation.claimedDigest !== hash(JSON.stringify(input.evidenceIds.slice(0, reservation.claimedCount)))) {
          throw createError('VERSION_CONFLICT')
        }
        if (reservation.claimedCount === input.evidenceIds.length) return { done: true }
        const nextCount = Math.min(
          reservation.claimedCount + AMENDMENT_EVIDENCE_CHUNK_SIZE,
          input.evidenceIds.length
        )
        let claimedBytes = reservation.claimedBytes
        for (const evidenceId of input.evidenceIds.slice(reservation.claimedCount, nextCount)) {
          const evidence = await readDocument(transaction, 'evidences', evidenceId)
          if (!evidence || evidence.businessLineId !== line._id || evidence.nodeId !== null ||
              evidence.feedbackId !== null || evidence.uploadedBy !== actor._id ||
              evidence.uploadPurpose !== 'audit_amendment' || evidence.storageStatus !== 'available' ||
              !['unattached', undefined].includes(evidence.attachmentState) ||
              !strictFuture(evidence.orphanExpiresAt, at) || !Number.isSafeInteger(evidence.size) ||
              evidence.size < 1 || evidence.size > FEEDBACK_TOTAL_LIMIT - claimedBytes) {
            throw createError(evidence && Number.isSafeInteger(evidence.size) &&
              evidence.size > FEEDBACK_TOTAL_LIMIT - claimedBytes
              ? 'FEEDBACK_TOTAL_TOO_LARGE'
              : 'EVIDENCE_NOT_ATTACHABLE')
          }
          const uploaded = parseStrictTimestamp(evidence.uploadedAt)
          if (!uploaded.valid || !uploaded.date || uploaded.date.getTime() > at.getTime()) {
            throw createError('EVIDENCE_NOT_ATTACHABLE')
          }
          const evidencePurgeDueAt = new Date(uploaded.date.getTime() + RETENTION_MS)
          claimedBytes += evidence.size
          await transaction.collection('evidences').doc(evidenceId).update({ data: {
            amendmentId: identity.amendmentId,
            attachmentState: 'amendment_claimed',
            retentionScope: 'evidence',
            retentionSource: 'audit_amendment',
            retentionStartedAt: uploaded.date,
            purgeDueAt: evidencePurgeDueAt,
            amendmentRollbackOrphanExpiresAt: evidence.orphanExpiresAt,
            orphanExpiresAt: null,
            updatedAt: db.serverDate()
          } })
        }
        await transaction.collection(COLLECTIONS.audit).doc(identity.amendmentId).update({ data: {
          claimedCount: nextCount,
          claimedBytes,
          claimedDigest: hash(JSON.stringify(input.evidenceIds.slice(0, nextCount))),
          updatedAt: db.serverDate()
        } })
        return { done: nextCount === input.evidenceIds.length }
      })
      if (outcome.done) return outcome.result || null
    }
  }

  async function finalizeAmendment(input, identity) {
    return db.runTransaction(async transaction => {
      const actor = await readDocument(transaction, COLLECTIONS.users, input.actor && input.actor._id)
      assertAmendmentActor(actor)
      const line = await readDocument(transaction, COLLECTIONS.lines, input.lineId)
      if (!line || line.status === 'creating') throw createError('NOT_FOUND')
      const reservation = await readDocument(transaction, COLLECTIONS.audit, identity.amendmentId)
      assertAmendmentReservation(reservation, input, identity)
      if (reservation.publishState === 'published') return clone(reservation.result)
      if (!FROZEN_BUSINESS_STATUSES.has(line.status) || line.version !== input.expectedVersion) {
        throw createError('VERSION_CONFLICT')
      }
      if (reservation.publishState !== 'reserved' || reservation.claimedCount !== input.evidenceIds.length ||
          reservation.claimedDigest !== identity.evidenceDigest ||
          !Number.isSafeInteger(reservation.claimedBytes) || reservation.claimedBytes < 0 ||
          reservation.claimedBytes > FEEDBACK_TOTAL_LIMIT) {
        throw createError('VERSION_CONFLICT')
      }
      const changes = { ...clone(input.changes), version: identity.nextVersion, updatedAt: db.serverDate() }
      if (input.changes.status && input.changes.status !== line.status) {
        changes[`${input.changes.status}At`] = reservation.transitionAt
        if (input.changes.status === 'deleted' && !line.closedAt) changes.closedAt = reservation.transitionAt
      }
      await transaction.collection(COLLECTIONS.lines).doc(line._id).update({ data: changes })
      const result = {
        businessLineId: line._id,
        amendmentId: identity.amendmentId,
        version: identity.nextVersion
      }
      await transaction.collection(COLLECTIONS.audit).doc(identity.amendmentId).update({ data: {
        publishState: 'published',
        result,
        publishedAt: reservation.transitionAt,
        claimExpiresAt: db.command.remove(),
        updatedAt: db.serverDate()
      } })
      return result
    })
  }

  async function amendFrozenBusiness(input) {
    const identity = amendmentIdentity(input)
    const at = clock()
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError('clock must return a Date')
    const begun = await beginAmendment(input, identity, at)
    if (begun.published) return begun.result
    const published = await claimAmendmentEvidence(input, identity, at)
    if (published) return published
    return finalizeAmendment(input, identity)
  }

  function nodeId(lineId, sequence) {
    return `${lineId}-node-${String(sequence + 1).padStart(3, '0')}`
  }

  function preparedSnapshot(lineId, code, sourceNodes, firstProcessingDue) {
    return sourceNodes.slice().sort(compareNodes).map((source, index) => ({
      id: nodeId(lineId, index),
      data: {
        businessLineId: lineId,
        nodeCode: formatNodeCode(code, index + 1),
        sourceTemplateNodeKey: source.nodeKey,
        sequence: index,
        name: source.name,
        description: source.description || '',
        ...(source.workflowMode === 'review'
          ? {
              workflowMode: 'review',
              processorUserIds: clone(source.processorUserIds),
              reviewerUserIds: clone(source.reviewerUserIds),
              reviewMode: source.reviewMode,
              processingSlaWorkHours: source.processingSlaWorkHours,
              reviewSlaWorkHours: source.reviewSlaWorkHours,
              processingRoundNumber: 1,
              processingElapsedWorkMinutes: 0,
              processingOverdueWorkMinutes: 0,
              ...(index === 0 ? clone(firstProcessingDue) : {})
            }
          : {
              assigneeUserIds: clone(source.assigneeUserIds),
              slaWorkHours: source.slaWorkHours
            }),
        requiresEvidence: source.requiresEvidence,
        allowedEvidenceTypes: clone(source.allowedEvidenceTypes),
        fieldDefinitions: clone(source.fields),
        status: index === 0 ? 'ready' : 'waiting',
        version: 1,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    }))
  }

  function calendarWarningId(lineId) {
    return `work-calendar-missing-${hash(`${lineId}\0processing`).slice(0, 40)}`
  }

  async function ensurePendingCalendarWarning(lineId) {
    try {
      return await db.runTransaction(async transaction => {
        const line = await readDocument(transaction, COLLECTIONS.lines, lineId)
        if (!line || line.status !== 'active' || typeof line.currentNodeId !== 'string') return false
        const node = await readDocument(transaction, COLLECTIONS.nodes, line.currentNodeId)
        if (!node || node.businessLineId !== lineId || node.sequence !== 0 ||
            node.workflowMode !== 'review' || node.processingDueStatus !== 'pending_calendar') return false
        const warningId = calendarWarningId(lineId)
        const existing = await readDocument(transaction, COLLECTIONS.notifications, warningId)
        if (!existing) {
          await transaction.collection(COLLECTIONS.notifications).doc(warningId).set({ data: {
            type: 'work_calendar_missing',
            audienceRole: 'super_admin',
            status: 'pending',
            createdAt: db.serverDate()
          } })
        }
        if (node.calendarNotificationStatus !== 'notified') {
          await transaction.collection(COLLECTIONS.nodes).doc(node._id).update({ data: {
            calendarNotificationStatus: 'notified',
            updatedAt: db.serverDate()
          } })
        }
        return true
      })
    } catch (_) {
      return false
    }
  }

  async function publishCreation(actorId, input, lineId, expectedNodes) {
    const identity = creationIdentity(actorId, input)
    return db.runTransaction(async transaction => {
      const line = await readDocument(transaction, COLLECTIONS.lines, lineId)
      if (!line) throw createError('NOT_FOUND')
      assertMatchingReservation(line, actorId, identity)
      if (line.status !== 'creating') return { id: line._id, code: line.code }

      for (const expected of expectedNodes) {
        const stored = await readDocument(transaction, COLLECTIONS.nodes, expected.id)
        if (!stored || stored.businessLineId !== lineId || stored.nodeCode !== expected.data.nodeCode ||
            stored.sequence !== expected.data.sequence) {
          throw createError('BUSINESS_ERROR')
        }
      }
      const changes = { status: 'active', updatedAt: db.serverDate() }
      const updated = await transaction.collection(COLLECTIONS.lines).doc(lineId).update({ data: changes })
      if (!updated.stats || updated.stats.updated !== 1) throw createError('NOT_FOUND')
      await transaction.collection(COLLECTIONS.audit).doc(`${lineId}-created`).set({
        data: {
          actorId,
          action: 'CREATE_BUSINESS',
          resultCode: 'BUSINESS_CREATED',
          targetType: 'business_line',
          targetId: lineId,
          createdAt: db.serverDate()
        }
      })
      return { id: lineId, code: line.code }
    })
  }

  async function findCreationResult({ actorId, input }) {
    const identity = creationIdentity(actorId, input)
    const line = await readDocument(db, COLLECTIONS.lines, identity.lineId)
    if (!line) return null
    assertMatchingReservation(line, actorId, identity)
    if (line.status !== 'creating') {
      await ensurePendingCalendarWarning(line._id)
      return { id: line._id, code: line.code }
    }
    const nodes = Array.from({ length: line.nodeCount }, (_, index) => ({
      id: nodeId(line._id, index),
      data: { nodeCode: formatNodeCode(line.code, index + 1), sequence: index }
    }))
    const result = await publishCreation(actorId, input, line._id, nodes)
    await ensurePendingCalendarWarning(line._id)
    return result
  }

  function assertDefinitionBudget(definition) {
    const nodeCount = definition && Array.isArray(definition.nodes) ? definition.nodes.length : 0
    if (!nodeCount) throw createError('TEMPLATE_INVALID')
    if (nodeCount > MAX_TEMPLATE_NODES) {
      throw createError('TEMPLATE_LIMIT_EXCEEDED', TEMPLATE_LIMIT_MESSAGE)
    }
    if (!canCreateBusinessSnapshot(definition.nodes)) {
      throw createError('TEMPLATE_LIMIT_EXCEEDED', SNAPSHOT_LIMIT_MESSAGE)
    }
  }

  async function createBusinessSnapshot({ actor, input, definition, firstProcessingDue: suppliedFirstDue }) {
    const identity = creationIdentity(actor && actor._id, input)
    const existing = await findCreationResult({ actorId: actor._id, input })
    if (existing) return existing

    const sourceNodes = clone(definition.nodes).sort(compareNodes)
    const processorIds = [...new Set(sourceNodes.flatMap(node => node.workflowMode === 'review' &&
      Array.isArray(node.processorUserIds) ? node.processorUserIds : []))].sort()
    const reviewerIds = [...new Set(sourceNodes.flatMap(node => node.workflowMode === 'review' &&
      Array.isArray(node.reviewerUserIds) ? node.reviewerUserIds : []))].sort()
    const legacyAssigneeIds = [...new Set(sourceNodes.flatMap(node => node.workflowMode !== 'review' &&
      Array.isArray(node.assigneeUserIds) ? node.assigneeUserIds : []))].sort()
    const participantIds = snapshotParticipantUserIds(sourceNodes)
    assertDefinitionBudget(definition)
    const memberUserIds = [...new Set([actor._id, ...participantIds])].sort()
    const at = clock()
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError('clock must return a Date')
    let firstProcessingDue = suppliedFirstDue ? clone(suppliedFirstDue) : null
    if (sourceNodes[0].workflowMode === 'review') {
      if (!firstProcessingDue) {
        const minutes = sourceNodes[0].processingSlaWorkHours * 60
        if (!Number.isSafeInteger(minutes) || minutes <= 0) throw createError('TEMPLATE_INVALID')
        const calculated = await dueTimeService.tryAddWorkMinutes(new Date(at), minutes)
        if (calculated && calculated.status === 'calculated' && calculated.dueAt instanceof Date &&
            !Number.isNaN(calculated.dueAt.getTime()) &&
            (calculated.calendarVersion === null ||
              (typeof calculated.calendarVersion === 'string' && calculated.calendarVersion))) {
          firstProcessingDue = {
            processingStartedAt: new Date(at),
            processingDueStatus: 'calculated',
            processingDueAt: new Date(calculated.dueAt),
            processingCalendarVersion: calculated.calendarVersion,
            calendarNotificationStatus: 'not_required'
          }
        } else if (calculated && calculated.status === 'pending_calendar' && calculated.dueAt === null) {
          firstProcessingDue = {
            processingStartedAt: new Date(at),
            processingDueStatus: 'pending_calendar',
            processingDueAt: null,
            calendarNotificationStatus: 'pending'
          }
        } else {
          throw createError('BUSINESS_ERROR')
        }
      }
      const calculatedDue = firstProcessingDue.processingDueStatus === 'calculated'
      const pendingDue = firstProcessingDue.processingDueStatus === 'pending_calendar'
      if (!(firstProcessingDue.processingStartedAt instanceof Date) ||
          Number.isNaN(firstProcessingDue.processingStartedAt.getTime()) ||
          (calculatedDue && (!(firstProcessingDue.processingDueAt instanceof Date) ||
            Number.isNaN(firstProcessingDue.processingDueAt.getTime()) ||
            (firstProcessingDue.processingCalendarVersion !== null &&
              (typeof firstProcessingDue.processingCalendarVersion !== 'string' ||
                !firstProcessingDue.processingCalendarVersion)))) ||
          (pendingDue && firstProcessingDue.processingDueAt !== null) ||
          (!calculatedDue && !pendingDue)) throw createError('BUSINESS_ERROR')
    }
    const dayKey = formatBusinessCode(at, 1).slice(3, 11)
    const counterId = `business-line-${dayKey}`
    let minimumSequence = 1
    let prepared
    let reserved

    for (let attempt = 0; attempt < duplicateRetries; attempt += 1) {
      let attemptedSequence
      try {
        reserved = await db.runTransaction(async transaction => {
          const concurrent = await readDocument(transaction, COLLECTIONS.lines, identity.lineId)
          if (concurrent) {
            assertMatchingReservation(concurrent, actor._id, identity)
            return { line: concurrent, existing: true }
          }
          const template = await readDocument(transaction, COLLECTIONS.templates, definition.template._id)
          if (!template || template.status !== 'enabled' || template.version !== definition.template.version ||
              template.nodeCount !== sourceNodes.length) {
            throw createError('TEMPLATE_NOT_ENABLED')
          }
          const creator = await readDocument(transaction, COLLECTIONS.users, actor._id)
          if (!creator || creator.status !== 'active') throw createError('FORBIDDEN')
          for (const userId of processorIds) {
            if (userId === actor._id) continue
            const user = await readDocument(transaction, COLLECTIONS.users, userId)
            if (!user || user.status !== 'active') throw createError('PROCESSOR_INACTIVE')
          }
          for (const userId of reviewerIds.filter(userId => !processorIds.includes(userId))) {
            if (userId === actor._id) continue
            const user = await readDocument(transaction, COLLECTIONS.users, userId)
            if (!user || user.status !== 'active') throw createError('REVIEWER_INACTIVE')
          }
          for (const userId of legacyAssigneeIds.filter(userId =>
            !processorIds.includes(userId) && !reviewerIds.includes(userId))) {
            if (userId === actor._id) continue
            const user = await readDocument(transaction, COLLECTIONS.users, userId)
            if (!user || user.status !== 'active') throw createError('ASSIGNEE_INACTIVE')
          }

          const counter = await readDocument(transaction, COLLECTIONS.counters, counterId)
          const currentSequence = counter ? counter.sequence : 0
          if (!Number.isSafeInteger(currentSequence) || currentSequence < 0 ||
              currentSequence === Number.MAX_SAFE_INTEGER) {
            throw createError('BUSINESS_ERROR')
          }
          attemptedSequence = Math.max(currentSequence + 1, minimumSequence)
          const code = formatBusinessCode(at, attemptedSequence)
          prepared = preparedSnapshot(identity.lineId, code, sourceNodes, firstProcessingDue)
          await transaction.collection(COLLECTIONS.counters).doc(counterId).set({
            data: { sequence: attemptedSequence, dateKey: dayKey, updatedAt: db.serverDate() }
          })
          const line = {
            code,
            name: input.name,
            description: input.description,
            plannedStartDate: input.plannedStartDate,
            plannedEndDate: input.plannedEndDate,
            sourceTemplateId: template._id,
            sourceTemplateVersion: template.version,
            status: 'creating',
            managerUserIds: [actor._id],
            memberUserIds,
            currentNodeIndex: 0,
            currentNodeId: prepared[0].id,
            currentNodeName: prepared[0].data.name,
            nodeCount: prepared.length,
            progress: 0,
            createdBy: actor._id,
            creationRequestHash: identity.requestHash,
            creationInputHash: identity.inputHash,
            version: 1,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
          await transaction.collection(COLLECTIONS.lines).doc(identity.lineId).set({ data: line })
          for (const node of prepared) {
            await transaction.collection(COLLECTIONS.nodes).doc(node.id).set({ data: node.data })
          }
          return { line: { _id: identity.lineId, ...line }, existing: false }
        })
        break
      } catch (error) {
        if (!isDuplicateError(error)) throw error
        minimumSequence = attemptedSequence + 1
        if (attempt === duplicateRetries - 1) throw createError('DUPLICATE_CODE')
      }
    }

    if (!reserved) throw createError('DUPLICATE_CODE')
    if (reserved.existing) {
      if (reserved.line.status !== 'creating') return { id: reserved.line._id, code: reserved.line.code }
      prepared = Array.from({ length: reserved.line.nodeCount }, (_, index) => ({
        id: nodeId(reserved.line._id, index),
        data: { nodeCode: formatNodeCode(reserved.line.code, index + 1), sequence: index }
      }))
    }
    const result = await publishCreation(actor._id, input, identity.lineId, prepared)
    await ensurePendingCalendarWarning(identity.lineId)
    return result
  }

  return {
    getTemplateDefinition,
    findCreationResult,
    createBusinessSnapshot,
    listBusinessLines,
    getBusinessLine,
    updateBusinessMetadata,
    listFrozenBusinessesForAdmin,
    getFrozenBusinessForAdmin,
    rejectPreviousNode,
    closeBusinessLine,
    amendFrozenBusiness
  }
}

module.exports = {
  COLLECTIONS,
  SNAPSHOT_LIMIT_MESSAGE,
  snapshotReservationOperationCount,
  canCreateBusinessSnapshot,
  createCloudBusinessRepository
}
