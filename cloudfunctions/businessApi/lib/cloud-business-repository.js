const crypto = require('node:crypto')

const { formatBusinessCode, formatNodeCode } = require('./business-numbering')
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
  audit: 'audit_logs'
})
const QUERY_PAGE_SIZE = 100
const MAX_TRANSACTION_OPERATIONS = 100
const MAX_DUPLICATE_RETRIES = 3
const SNAPSHOT_LIMIT_MESSAGE = 'Template snapshot transaction operation budget exceeded; reduce distinct assignees'

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

function snapshotReservationOperationCount(nodes) {
  if (!Array.isArray(nodes)) return Number.POSITIVE_INFINITY
  const assigneeIds = new Set(nodes.flatMap(node => Array.isArray(node && node.assigneeUserIds)
    ? node.assigneeUserIds
    : []))
  return nodes.length + assigneeIds.size + 6
}

function canCreateBusinessSnapshot(nodes) {
  return Array.isArray(nodes) && nodes.length > 0 && nodes.length <= MAX_TEMPLATE_NODES &&
    snapshotReservationOperationCount(nodes) <= MAX_TRANSACTION_OPERATIONS
}

function createCloudBusinessRepository({ db, clock = () => new Date(), duplicateRetries = MAX_DUPLICATE_RETRIES }) {
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

  function nodeId(lineId, sequence) {
    return `${lineId}-node-${String(sequence + 1).padStart(3, '0')}`
  }

  function preparedSnapshot(lineId, code, sourceNodes) {
    return sourceNodes.slice().sort(compareNodes).map((source, index) => ({
      id: nodeId(lineId, index),
      data: {
        businessLineId: lineId,
        nodeCode: formatNodeCode(code, index + 1),
        sourceTemplateNodeKey: source.nodeKey,
        sequence: index,
        name: source.name,
        description: source.description || '',
        assigneeUserIds: clone(source.assigneeUserIds),
        slaWorkHours: source.slaWorkHours,
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
    if (line.status !== 'creating') return { id: line._id, code: line.code }
    const nodes = Array.from({ length: line.nodeCount }, (_, index) => ({
      id: nodeId(line._id, index),
      data: { nodeCode: formatNodeCode(line.code, index + 1), sequence: index }
    }))
    return publishCreation(actorId, input, line._id, nodes)
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

  async function createBusinessSnapshot({ actor, input, definition }) {
    const identity = creationIdentity(actor && actor._id, input)
    const existing = await findCreationResult({ actorId: actor._id, input })
    if (existing) return existing

    const sourceNodes = clone(definition.nodes).sort(compareNodes)
    const assigneeIds = [...new Set(sourceNodes.flatMap(node => node.assigneeUserIds))].sort()
    assertDefinitionBudget(definition)
    const memberUserIds = [...new Set([actor._id, ...assigneeIds])].sort()
    const at = clock()
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
          for (const userId of assigneeIds) {
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
          prepared = preparedSnapshot(identity.lineId, code, sourceNodes)
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
    return publishCreation(actor._id, input, identity.lineId, prepared)
  }

  return {
    getTemplateDefinition,
    findCreationResult,
    createBusinessSnapshot,
    listBusinessLines,
    getBusinessLine
  }
}

module.exports = {
  COLLECTIONS,
  SNAPSHOT_LIMIT_MESSAGE,
  snapshotReservationOperationCount,
  canCreateBusinessSnapshot,
  createCloudBusinessRepository
}
