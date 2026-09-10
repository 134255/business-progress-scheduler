const crypto = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { ownDataValue } = require('./account-relationship-schema')
const {
  readCardDisplay, normalizeCardDisplayFields, assertCardDisplayReferences
} = require('./business-card-display')
const {
  REVIEWER_ASSIGNMENT_MODE,
  templateDefinitionDigest,
  preActivationModeTemplateDefinitionDigest,
  version2TemplateDefinitionDigest
} = require('./template-domain')

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

function publishedNodeIds(nodes) {
  const ids = nodes.slice().sort(compareNodes).map(node => {
    const descriptor = node && Object.getOwnPropertyDescriptor(node, '_id')
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : null
  })
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw createError('TEMPLATE_INVALID')
  }
  return ids
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
    const nodes = await readNodes(templateId)
    assertStoredDefinitionDigest(template, nodes)
    return { template, nodes }
  }

  function assertStoredDefinitionDigest(template, nodes) {
    const version2 = template.flowSchemaVersion === 2
    const requiresNodeIds = version2 || nodes.some(node => {
      const descriptor = node && Object.getOwnPropertyDescriptor(node, 'reviewerAssignmentMode')
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
        descriptor.value === REVIEWER_ASSIGNMENT_MODE.BUSINESS_CREATOR
    })
    if (requiresNodeIds && !Object.prototype.hasOwnProperty.call(template, 'definitionNodeIds')) {
      throw createError('TEMPLATE_INVALID')
    }
    if (Object.prototype.hasOwnProperty.call(template, 'definitionNodeIds')) {
      const descriptor = Object.getOwnPropertyDescriptor(template, 'definitionNodeIds')
      const storedIds = descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : null
      const actualIds = publishedNodeIds(nodes)
      if (!Array.isArray(storedIds) || storedIds.length !== actualIds.length ||
          actualIds.some((id, index) => {
            const item = Object.getOwnPropertyDescriptor(storedIds, String(index))
            return !item || !Object.prototype.hasOwnProperty.call(item, 'value') ||
              typeof item.value !== 'string' || !item.value || item.value !== id
          })) {
        throw createError('TEMPLATE_INVALID')
      }
    }
    if (!Object.prototype.hasOwnProperty.call(template, 'definitionDigest')) return
    let actualDigest = null
    try {
      actualDigest = version2
        ? version2TemplateDefinitionDigest({
          flowSchemaVersion: 2,
          entryNodeKey: template.entryNodeKey,
          nodes
        })
        : templateDefinitionDigest(nodes)
    } catch (error) {
      throw createError('TEMPLATE_INVALID')
    }
    const storedDigest = template.definitionDigest
    const storedDigestIsValid = typeof storedDigest === 'string' && /^[a-f0-9]{64}$/.test(storedDigest)
    const legacyDigestMatches = !version2 && storedDigestIsValid && actualDigest !== storedDigest &&
      nodes.every(node => !Object.prototype.hasOwnProperty.call(node, 'activationMode')) &&
      preActivationModeTemplateDefinitionDigest(nodes) === storedDigest
    if (!storedDigestIsValid || (actualDigest !== storedDigest && !legacyDigestMatches)) {
      throw createError('TEMPLATE_INVALID')
    }
  }

  async function listTemplateDefinitions({ status } = {}) {
    const templates = (await readAll(() => db.collection(COLLECTIONS.templates).orderBy('_id', 'asc')))
      .filter(template => template.status !== 'deleted')
      .filter(template => !status || template.status === status)
      .sort(compareIds)
    return Promise.all(templates.map(async template => {
      const nodes = await readNodes(template._id)
      assertStoredDefinitionDigest(template, nodes)
      return { template, nodes }
    }))
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
      ...(audit.configRevision === undefined ? {} : { configRevision: audit.configRevision }),
      createdAt: db.serverDate()
    }
    await database.collection(COLLECTIONS.audit).doc(auditId).set({ data: stored })
    return { _id: auditId, ...stored }
  }

  function requireCardAdmin(actor) {
    const id = ownDataValue(actor, '_id').value
    if (ownDataValue(actor, 'role').value !== 'super_admin' ||
        ownDataValue(actor, 'status').value !== 'active' ||
        typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw createError('FORBIDDEN')
    return id
  }

  async function readCardTemplate(transaction, actor, templateId) {
    const actorId = requireCardAdmin(actor)
    const currentActor = await readDocument(transaction, COLLECTIONS.users, actorId)
    if (requireCardAdmin(currentActor) !== actorId) throw createError('FORBIDDEN')
    const template = await readDocument(transaction, COLLECTIONS.templates, templateId)
    if (!template) throw createError('NOT_FOUND')
    assertCardDefinitionHeader(template)
    if (template.status === 'deleted') throw createError('NOT_FOUND')
    return template
  }

  function assertCardDefinitionHeader(template) {
    readCardDisplay(template)
    for (const key of ['status', 'version', 'definitionDigest', 'definitionNodeIds', 'flowSchemaVersion', 'entryNodeKey']) {
      const field = ownDataValue(template, key)
      if (field.present ? !field.valid : key in template) throw createError('TEMPLATE_INVALID')
    }
    if (!['draft', 'enabled', 'disabled', 'deleted'].includes(ownDataValue(template, 'status').value)) {
      throw createError('TEMPLATE_INVALID')
    }
    const ids = ownDataValue(template, 'definitionNodeIds')
    if (ids.present && (!Array.isArray(ids.value) || Object.getPrototypeOf(ids.value) !== Array.prototype ||
        Reflect.ownKeys(ids.value).length !== ids.value.length + 1)) throw createError('TEMPLATE_INVALID')
    if (ids.present) {
      for (let index = 0; index < ids.value.length; index += 1) {
        const item = ownDataValue(ids.value, String(index))
        if (!item.valid || typeof item.value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.value)) {
          throw createError('TEMPLATE_INVALID')
        }
      }
    }
  }

  async function readDisplayDefinition(templateId) {
    const template = await readDocument(db, COLLECTIONS.templates, templateId)
    if (!template) throw createError('NOT_FOUND')
    assertCardDefinitionHeader(template)
    if (template.status === 'deleted') throw createError('NOT_FOUND')
    const nodes = await readNodes(templateId)
    if (nodes.length > MAX_TEMPLATE_NODES) throw createTemplateLimitError()
    assertStoredDefinitionDigest(template, nodes)
    return { template, nodes }
  }

  async function checkCardDefinition(transaction, current, initial, fields) {
    assertCardDefinitionHeader(current)
    if (!Number.isSafeInteger(current.version) || current.version < 1 ||
        ['version', 'definitionDigest', 'definitionNodeIds', 'flowSchemaVersion', 'entryNodeKey']
          .some(key => !isDeepStrictEqual(ownDataValue(current, key), ownDataValue(initial.template, key)))) {
      throw createError('VERSION_CONFLICT')
    }
    const normalized = normalizeCardDisplayFields(fields, initial.nodes)
    const referencedKeys = new Set(normalized.map(field => field.nodeKey))
    const checkedNodes = new Map()
    for (const node of initial.nodes.filter(node => referencedKeys.has(node.nodeKey))) {
      const checked = await readDocument(transaction, COLLECTIONS.nodes, node._id)
      if (!checked || checked.templateId !== current._id || !isDeepStrictEqual(checked, node)) {
        throw createError('VERSION_CONFLICT')
      }
      checkedNodes.set(node._id, checked)
    }
    const nodes = initial.nodes.map(node => checkedNodes.get(node._id) || node)
    assertStoredDefinitionDigest(current, nodes)
    return normalizeCardDisplayFields(normalized, nodes)
  }

  async function getTemplateCardDisplay({ actor, templateId }) {
    requireCardAdmin(actor)
    const initial = await readDisplayDefinition(templateId)
    return db.runTransaction(async transaction => {
      const template = await readCardTemplate(transaction, actor, templateId)
      const { revision, fields } = readCardDisplay(template)
      return { templateId, revision, fields: await checkCardDefinition(transaction, template, initial, fields) }
    })
  }

  async function updateTemplateCardDisplay({ actor, templateId, expectedRevision, fields }) {
    requireCardAdmin(actor)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        expectedRevision === Number.MAX_SAFE_INTEGER) throw createError('VERSION_CONFLICT')
    const initial = await readDisplayDefinition(templateId)
    const normalized = normalizeCardDisplayFields(fields, initial.nodes)
    const auditId = idFactory('audit')
    return db.runTransaction(async transaction => {
      const current = await readCardTemplate(transaction, actor, templateId)
      const display = readCardDisplay(current)
      if (display.revision !== expectedRevision) throw createError('VERSION_CONFLICT')
      const cardDisplay = {
        schemaVersion: 1, revision: display.revision + 1,
        fields: await checkCardDefinition(transaction, current, initial, normalized)
      }
      const updated = await transaction.collection(COLLECTIONS.templates).doc(templateId).update({ data: {
        cardDisplay, cardDisplayUpdatedAt: db.serverDate(), cardDisplayUpdatedBy: actor._id
      } })
      if (!updated.stats || updated.stats.updated !== 1) throw createError('NOT_FOUND')
      await writeAudit(transaction, actor, templateId, {
        action: 'UPDATE_TEMPLATE_CARD_DISPLAY', resultCode: 'TEMPLATE_CARD_DISPLAY_UPDATED',
        configRevision: cardDisplay.revision
      }, auditId)
      return { templateId, revision: cardDisplay.revision, fields: cardDisplay.fields }
    })
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
        definitionNodeIds: preparedNodes
          .slice()
          .sort((left, right) => Number(left.node.sequence) - Number(right.node.sequence) ||
            String(left.id).localeCompare(String(right.id)))
          .map(prepared => prepared.id),
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
      // Display saves do not advance the definition version: guard the current
      // transactional configuration, never the earlier definition pre-read.
      if (preparedNodes !== undefined) {
        const display = readCardDisplay(current)
        if (display.fields.length) assertCardDisplayReferences(display, definition.nodes)
      }
      await assertActiveParticipantDocuments(transaction, participantIds)
      const version = current.version + 1
      const authoritativeNodes = preparedNodes === undefined
        ? initial.nodes.map(node => ({ id: node._id, node }))
        : preparedNodes
      const changes = {
        ...timestampedTemplate(definition.template),
        definitionNodeIds: authoritativeNodes
          .slice()
          .sort((left, right) => Number(left.node.sequence) - Number(right.node.sequence) ||
            String(left.id).localeCompare(String(right.id)))
          .map(prepared => prepared.id),
        version
      }
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
    getTemplateCardDisplay,
    updateTemplateCardDisplay,
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
