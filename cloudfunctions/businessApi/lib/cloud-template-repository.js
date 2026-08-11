const crypto = require('node:crypto')

const COLLECTIONS = Object.freeze({
  templates: 'templates',
  nodes: 'template_nodes',
  users: 'users',
  audit: 'audit_logs'
})
const QUERY_PAGE_SIZE = 100
const MAX_TRANSACTION_OPERATIONS = 100
const MAX_TEMPLATE_NODES = 48
const TEMPLATE_LIMIT_MESSAGE = `Template definitions support at most ${MAX_TEMPLATE_NODES} nodes and must fit the transaction operation budget`
const APPLICATION_ERROR_MARKER = Symbol('businessApi.applicationError')

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`
}

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function createTemplateLimitError() {
  return createError('TEMPLATE_LIMIT_EXCEEDED', TEMPLATE_LIMIT_MESSAGE)
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

function compareIds(left, right) {
  return String(left._id).localeCompare(String(right._id))
}

function compareNodes(left, right) {
  return Number(left.sequence) - Number(right.sequence) || compareIds(left, right)
}

function createCloudTemplateRepository({ db, idFactory = defaultIdFactory }) {
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

  async function readAll(buildQuery) {
    const documents = []
    for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
      const result = await buildQuery().skip(offset).limit(QUERY_PAGE_SIZE).get()
      const page = result.data || []
      documents.push(...page)
      if (page.length < QUERY_PAGE_SIZE) return documents
    }
  }

  async function readNodes(templateId) {
    const nodes = await readAll(() => db.collection(COLLECTIONS.nodes)
      .where({ templateId })
      .orderBy('sequence', 'asc'))
    return nodes.sort(compareNodes)
  }

  async function getTemplateDefinition(templateId) {
    const template = await readDocument(db, COLLECTIONS.templates, templateId)
    if (!template || template.status === 'deleted') return null
    return { template, nodes: await readNodes(templateId) }
  }

  async function listTemplateDefinitions({ status } = {}) {
    const templates = (await readAll(() => db.collection(COLLECTIONS.templates).orderBy('_id', 'asc')))
      .filter(template => template.status !== 'deleted')
      .filter(template => !status || template.status === status)
      .sort(compareIds)
    return Promise.all(templates.map(async template => ({ template, nodes: await readNodes(template._id) })))
  }

  async function listActiveUserIds(userIds) {
    const result = []
    for (const userId of [...new Set(userIds)].sort()) {
      const user = await readDocument(db, COLLECTIONS.users, userId)
      if (user && user.status === 'active') result.push(user._id)
    }
    return result
  }

  async function assertActiveParticipantDocuments(database, userIds) {
    for (const userId of userIds) {
      const user = await readDocument(database, COLLECTIONS.users, userId)
      if (!user || user.status !== 'active') throw createError('PARTICIPANT_INACTIVE')
    }
  }

  function timestampedTemplate(template, { create = false } = {}) {
    const stored = clone(template)
    delete stored._id
    delete stored.version
    if (create) {
      stored.createdAt = db.serverDate()
      stored.updatedAt = db.serverDate()
    } else {
      delete stored.createdAt
      delete stored.createdBy
      for (const field of ['updatedAt', 'enabledAt', 'disabledAt', 'deletedAt']) {
        if (Object.prototype.hasOwnProperty.call(stored, field)) stored[field] = db.serverDate()
      }
    }
    return stored
  }

  function timestampedNode(node, templateId, version, existing) {
    const stored = clone(node)
    delete stored._id
    delete stored.templateId
    delete stored.version
    delete stored.createdAt
    delete stored.updatedAt
    return {
      ...stored,
      templateId,
      version,
      createdAt: existing && existing.createdAt ? existing.createdAt : db.serverDate(),
      updatedAt: db.serverDate()
    }
  }

  async function writeAudit(database, actor, targetId, audit, auditId) {
    const stored = {
      actorId: actor._id,
      action: audit.action,
      resultCode: audit.resultCode,
      targetType: 'template',
      targetId,
      createdAt: db.serverDate()
    }
    await database.collection(COLLECTIONS.audit).doc(auditId).set({ data: stored })
    return { _id: auditId, ...stored }
  }

  async function createTemplateDefinition({ actor, participantUserIds = [], definition, audit }) {
    const participantIds = [...new Set(participantUserIds)].sort()
    if (definition.nodes.length > MAX_TEMPLATE_NODES ||
        definition.nodes.length + participantIds.length + 2 > MAX_TRANSACTION_OPERATIONS) {
      throw createTemplateLimitError()
    }
    const templateId = idFactory('template')
    const preparedNodes = definition.nodes.map(node => ({ id: idFactory('template_node'), node }))
    const auditId = idFactory('audit')
    return db.runTransaction(async transaction => {
      await assertActiveParticipantDocuments(transaction, participantIds)
      const template = {
        ...timestampedTemplate(definition.template, { create: true }),
        version: 1
      }
      await transaction.collection(COLLECTIONS.templates).doc(templateId).set({ data: template })
      const nodes = []
      for (const prepared of preparedNodes.slice().sort((left, right) =>
        Number(left.node.sequence) - Number(right.node.sequence) || String(left.id).localeCompare(String(right.id)))) {
        const stored = timestampedNode(prepared.node, templateId, 1)
        await transaction.collection(COLLECTIONS.nodes).doc(prepared.id).set({ data: stored })
        nodes.push({ _id: prepared.id, ...stored })
      }
      await writeAudit(transaction, actor, templateId, audit, auditId)
      return { template: { _id: templateId, ...template }, nodes }
    })
  }

  async function mutateTemplateDefinition({
    actor,
    templateId,
    expectedVersion,
    expectedStatus,
    participantUserIds,
    definition,
    audit
  }) {
    const initial = await getTemplateDefinition(templateId)
    if (!initial) throw createError('NOT_FOUND')
    const initialByKey = new Map(initial.nodes.map(node => [node.nodeKey, node]))
    const preparedNodes = definition.nodes === undefined
      ? undefined
      : definition.nodes.map(node => {
        const existing = initialByKey.get(node.nodeKey)
        return { id: existing ? existing._id : idFactory('template_node'), node, existing }
      })
    const participantIds = participantUserIds === undefined ? [] : [...new Set(participantUserIds)].sort()
    const definitionOperations = preparedNodes === undefined ? 0 : initial.nodes.length + preparedNodes.length
    if ((preparedNodes !== undefined && preparedNodes.length > MAX_TEMPLATE_NODES) ||
        definitionOperations + participantIds.length + 3 > MAX_TRANSACTION_OPERATIONS) {
      throw createTemplateLimitError()
    }
    const auditId = idFactory('audit')

    return db.runTransaction(async transaction => {
      const current = await readDocument(transaction, COLLECTIONS.templates, templateId)
      if (!current || current.status === 'deleted') throw createError('NOT_FOUND')
      if (!Number.isSafeInteger(current.version) || current.version < 1 ||
          current.version === Number.MAX_SAFE_INTEGER || current.version !== expectedVersion ||
          current.status !== expectedStatus) {
        throw createError('VERSION_CONFLICT')
      }
      await assertActiveParticipantDocuments(transaction, participantIds)
      const version = current.version + 1
      const changes = { ...timestampedTemplate(definition.template), version }
      const updated = await transaction.collection(COLLECTIONS.templates).doc(templateId).update({ data: changes })
      if (!updated.stats || updated.stats.updated !== 1) throw createError('NOT_FOUND')

      let nodes = initial.nodes
      if (preparedNodes !== undefined) {
        for (const existing of initial.nodes) {
          await transaction.collection(COLLECTIONS.nodes).doc(existing._id).remove()
        }
        nodes = []
        for (const prepared of preparedNodes.slice().sort((left, right) =>
          Number(left.node.sequence) - Number(right.node.sequence) || String(left.id).localeCompare(String(right.id)))) {
          const stored = timestampedNode(prepared.node, templateId, version, prepared.existing)
          await transaction.collection(COLLECTIONS.nodes).doc(prepared.id).set({ data: stored })
          nodes.push({ _id: prepared.id, ...stored })
        }
      }
      await writeAudit(transaction, actor, templateId, audit, auditId)
      return {
        template: { ...current, ...changes, _id: templateId },
        nodes
      }
    })
  }

  return {
    getTemplateDefinition,
    listTemplateDefinitions,
    listActiveUserIds,
    createTemplateDefinition,
    mutateTemplateDefinition
  }
}

module.exports = {
  APPLICATION_ERROR_MARKER,
  COLLECTIONS,
  MAX_TEMPLATE_NODES,
  TEMPLATE_LIMIT_MESSAGE,
  createCloudTemplateRepository
}
