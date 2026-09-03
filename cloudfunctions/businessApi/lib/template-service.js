const {
  normalizeTemplateNode,
  normalizeVersion2TemplateDefinition,
  version2TemplateDefinitionDigest,
  templateDefinitionDigest,
  collectTemplateParticipantUserIds,
  validateTemplateForEnable,
  assertTemplateEditable
} = require('./template-domain')
const {
  APPLICATION_ERROR_MARKER,
  MAX_TEMPLATE_NODES,
  TEMPLATE_LIMIT_MESSAGE
} = require('./cloud-template-repository')
const {
  SNAPSHOT_LIMIT_MESSAGE,
  canCreateBusinessSnapshot
} = require('./cloud-business-repository')

const TEMPLATE_STATUSES = new Set(['draft', 'enabled', 'disabled', 'deleted'])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function callTemplateDomain(operation) {
  try {
    return operation()
  } catch (error) {
    if (['TEMPLATE_INVALID', 'TEMPLATE_LIMIT_EXCEEDED', 'TEMPLATE_NOT_EDITABLE', 'ASSIGNEE_INACTIVE',
      'PROCESSOR_INACTIVE', 'REVIEWER_INACTIVE', 'ROLE_OVERLAP', 'NOT_FOUND'].includes(error.code)) {
      error[APPLICATION_ERROR_MARKER] = true
    }
    throw error
  }
}

function requireSuperAdmin(actor) {
  if (!actor || actor.role !== 'super_admin' || actor.status !== 'active') {
    throw createError('FORBIDDEN')
  }
}

function requireActiveActor(actor) {
  if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError('TEMPLATE_INVALID')
  return value.trim()
}

function safeOwnDataRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw createError('TEMPLATE_INVALID')
  }
  const result = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw createError('TEMPLATE_INVALID')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw createError('TEMPLATE_INVALID')
    }
    result[key] = descriptor.value
  }
  return result
}

function safeArrayValues(value) {
  if (!Array.isArray(value)) throw createError('TEMPLATE_INVALID')
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw createError('TEMPLATE_INVALID')
    }
    result.push(descriptor.value)
  }
  return result
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw createError('VERSION_CONFLICT')
  return value
}

function normalizeMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError('TEMPLATE_INVALID')
  return {
    name: requireText(input.name),
    description: typeof input.description === 'string' ? input.description.trim() : ''
  }
}

function requireNodeBudget(nodes) {
  if (!Array.isArray(nodes)) throw createError('TEMPLATE_INVALID')
  if (nodes.length > MAX_TEMPLATE_NODES) {
    throw createError('TEMPLATE_LIMIT_EXCEEDED', TEMPLATE_LIMIT_MESSAGE)
  }
  return nodes
}

function nodesForSnapshotBudget(nodes, participantUserIds) {
  return nodes.map((node, index) => ({
    ...node,
    assigneeUserIds: index === 0 ? participantUserIds : []
  }))
}

function requireSnapshotBudget(nodes, participantUserIds) {
  if (!canCreateBusinessSnapshot(nodesForSnapshotBudget(nodes, participantUserIds))) {
    throw createError('TEMPLATE_LIMIT_EXCEEDED', SNAPSHOT_LIMIT_MESSAGE)
  }
}

function normalizeNodeInput(node, sequence, nodeKey) {
  return callTemplateDomain(() => normalizeTemplateNode({ ...safeOwnDataRecord(node), nodeKey, sequence }))
}

function normalizeVersion2Input(input) {
  const safeInput = safeOwnDataRecord(input)
  const nodes = safeArrayValues(requireNodeBudget(safeInput.nodes)).map((node, sequence) => {
    const safeNode = safeOwnDataRecord(node)
    const fields = safeArrayValues(safeNode.fields === undefined ? [] : safeNode.fields)
      .map((field, fieldSequence) => ({ ...safeOwnDataRecord(field), sequence: fieldSequence }))
    return { ...safeNode, sequence, fields }
  })
  return callTemplateDomain(() => normalizeVersion2TemplateDefinition({
    flowSchemaVersion: safeInput.flowSchemaVersion,
    entryNodeKey: safeInput.entryNodeKey,
    nodes
  }))
}

function digestForDefinition(template, nodes) {
  return template.flowSchemaVersion === 2
    ? callTemplateDomain(() => version2TemplateDefinitionDigest({
      flowSchemaVersion: 2,
      entryNodeKey: template.entryNodeKey,
      nodes
    }))
    : callTemplateDomain(() => templateDefinitionDigest(nodes))
}

function uniqueKey(keyFactory, prefix, occupied) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const key = requireText(keyFactory(prefix))
    if (!occupied.has(key)) {
      occupied.add(key)
      return key
    }
  }
  throw createError('TEMPLATE_INVALID')
}

function assignCreateKeys(inputNodes, keyFactory) {
  if (!Array.isArray(inputNodes)) throw createError('TEMPLATE_INVALID')
  const nodeKeys = new Set()
  const fieldKeys = new Set()
  return safeArrayValues(inputNodes).map((node, sequence) => {
    const safeNode = safeOwnDataRecord(node)
    const nodeKey = uniqueKey(keyFactory, 'node', nodeKeys)
    const fields = safeNode.fields === undefined ? [] : safeArrayValues(safeNode.fields)
    const keyedFields = fields.map(field => ({
      ...safeOwnDataRecord(field),
      fieldKey: uniqueKey(keyFactory, 'field', fieldKeys)
    }))
    return normalizeNodeInput({ ...safeNode, fields: keyedFields }, sequence, nodeKey)
  })
}

function assignUpdateKeys(current, inputNodes, keyFactory) {
  if (!Array.isArray(inputNodes)) throw createError('TEMPLATE_INVALID')
  const currentNodes = new Map(current.nodes.map(node => [node.nodeKey, node]))
  const occupiedNodeKeys = new Set(currentNodes.keys())
  const occupiedFieldKeys = new Set(current.nodes.flatMap(node => node.fields.map(field => field.fieldKey)))
  const selectedNodeKeys = new Set()
  const selectedFieldKeys = new Set()

  return safeArrayValues(inputNodes).map((node, sequence) => {
    const safeNode = safeOwnDataRecord(node)
    let existingNode = null
    let nodeKey
    if (safeNode.nodeKey === undefined || safeNode.nodeKey === '') {
      nodeKey = uniqueKey(keyFactory, 'node', occupiedNodeKeys)
    } else {
      nodeKey = requireText(safeNode.nodeKey)
      existingNode = currentNodes.get(nodeKey)
      if (!existingNode || selectedNodeKeys.has(nodeKey)) throw createError('TEMPLATE_INVALID')
    }
    if (selectedNodeKeys.has(nodeKey)) throw createError('TEMPLATE_INVALID')
    selectedNodeKeys.add(nodeKey)

    const existingFields = new Map((existingNode && existingNode.fields || []).map(field => [field.fieldKey, field]))
    const fields = safeArrayValues(safeNode.fields).map(field => {
      const safeField = safeOwnDataRecord(field)
      let fieldKey
      if (safeField.fieldKey === undefined || safeField.fieldKey === '') {
        fieldKey = uniqueKey(keyFactory, 'field', occupiedFieldKeys)
      } else {
        fieldKey = requireText(safeField.fieldKey)
        if (!existingFields.has(fieldKey) || selectedFieldKeys.has(fieldKey)) throw createError('TEMPLATE_INVALID')
      }
      if (selectedFieldKeys.has(fieldKey)) throw createError('TEMPLATE_INVALID')
      selectedFieldKeys.add(fieldKey)
      return { ...safeField, fieldKey }
    })
    return {
      ...normalizeNodeInput({ ...safeNode, fields }, sequence, nodeKey),
      ...(existingNode && existingNode._id ? { _id: existingNode._id } : {})
    }
  })
}

function allParticipantUserIds(nodes) {
  if (Array.isArray(nodes) && nodes.length === 0) return []
  return callTemplateDomain(() => collectTemplateParticipantUserIds(nodes)).sort()
}

async function assertActiveParticipants(repository, nodes, { requireNodes = false } = {}) {
  if (Array.isArray(nodes) && nodes.length === 0) {
    if (requireNodes) throw createError('TEMPLATE_INVALID')
    return []
  }
  const participantUserIds = allParticipantUserIds(nodes)
  const active = await repository.listActiveUserIds(participantUserIds)
  callTemplateDomain(() => validateTemplateForEnable({}, nodes, active))
  return participantUserIds
}

function requireCurrent(current) {
  if (!current || !current.template || current.template.status === 'deleted') throw createError('NOT_FOUND')
  return current
}

function assertExpectedVersion(current, expectedVersion) {
  const expected = requireVersion(expectedVersion)
  if (current.template.version !== expected) throw createError('VERSION_CONFLICT')
  return expected
}

function projectAdminTemplate(definition) {
  return { ...definition.template }
}

function projectEnabledTemplate(definition, unavailableReason) {
  const { template } = definition
  return {
    _id: template._id,
    name: template.name,
    description: template.description || '',
    nodeCount: template.nodeCount,
    available: !unavailableReason,
    unavailableReason
  }
}

function createTemplateService({ repository, clock = () => new Date(), keyFactory }) {
  if (!repository) throw new TypeError('repository is required')
  if (typeof keyFactory !== 'function') throw new TypeError('keyFactory is required')

  async function listTemplates({ actor, query = {} }) {
    requireSuperAdmin(actor)
    const status = query && query.status
    if (status && !TEMPLATE_STATUSES.has(status)) throw createError('INVALID_STATUS')
    const keyword = String(query && query.keyword || '').trim().toLowerCase()
    const definitions = await repository.listTemplateDefinitions({ status: status || undefined })
    return {
      items: definitions
        .filter(definition => !keyword || [definition.template.name, definition.template.description]
          .some(value => String(value || '').toLowerCase().includes(keyword)))
        .map(projectAdminTemplate)
    }
  }

  async function getTemplate({ actor, templateId }) {
    requireSuperAdmin(actor)
    return requireCurrent(await repository.getTemplateDefinition(requireText(templateId)))
  }

  async function createTemplate({ actor, input }) {
    requireSuperAdmin(actor)
    const safeInput = safeOwnDataRecord(input)
    const metadata = normalizeMetadata(safeInput)
    const version2 = safeInput.flowSchemaVersion === 2
      ? normalizeVersion2Input(safeInput)
      : null
    const nodes = version2
      ? version2.nodes
      : assignCreateKeys(requireNodeBudget(safeInput.nodes === undefined ? [] : safeInput.nodes), keyFactory)
    const participantUserIds = await assertActiveParticipants(repository, nodes)
    const at = clock()
    return repository.createTemplateDefinition({
      actor,
      participantUserIds,
      definition: {
        template: {
          ...metadata,
          ...(version2 ? {
            flowSchemaVersion: version2.flowSchemaVersion,
            entryNodeKey: version2.entryNodeKey
          } : {}),
          status: 'draft',
          nodeCount: nodes.length,
          definitionDigest: version2
            ? version2TemplateDefinitionDigest(version2)
            : templateDefinitionDigest(nodes),
          createdBy: actor._id,
          createdAt: at,
          updatedBy: actor._id,
          updatedAt: at
        },
        nodes
      },
      audit: { action: 'CREATE_TEMPLATE', resultCode: 'TEMPLATE_CREATED' }
    })
  }

  async function updateTemplate({ actor, templateId, expectedVersion, input }) {
    requireSuperAdmin(actor)
    const current = requireCurrent(await repository.getTemplateDefinition(requireText(templateId)))
    assertExpectedVersion(current, expectedVersion)
    callTemplateDomain(() => assertTemplateEditable(current.template))
    const safeInput = safeOwnDataRecord(input)
    const metadata = normalizeMetadata(safeInput)
    const isVersion2 = current.template.flowSchemaVersion === 2 || safeInput.flowSchemaVersion === 2
    if (isVersion2 && (current.template.flowSchemaVersion !== 2 || safeInput.flowSchemaVersion !== 2)) {
      throw createError('TEMPLATE_INVALID')
    }
    const version2 = isVersion2 ? normalizeVersion2Input(safeInput) : null
    const currentByKey = new Map(current.nodes.map(node => [node.nodeKey, node]))
    const nodes = version2
      ? version2.nodes.map(node => ({
        ...node,
        ...(currentByKey.has(node.nodeKey) && currentByKey.get(node.nodeKey)._id
          ? { _id: currentByKey.get(node.nodeKey)._id }
          : {})
      }))
      : assignUpdateKeys(
        current,
        requireNodeBudget(safeInput.nodes === undefined ? [] : safeInput.nodes),
        keyFactory
      )
    const participantUserIds = await assertActiveParticipants(repository, nodes)
    return repository.mutateTemplateDefinition({
      actor,
      templateId: current.template._id,
      expectedVersion,
      expectedStatus: current.template.status,
      participantUserIds,
      definition: {
        template: {
          ...metadata,
          ...(version2 ? { flowSchemaVersion: 2, entryNodeKey: version2.entryNodeKey } : {}),
          nodeCount: nodes.length,
          definitionDigest: version2
            ? version2TemplateDefinitionDigest(version2)
            : templateDefinitionDigest(nodes),
          updatedBy: actor._id,
          updatedAt: clock()
        },
        nodes
      },
      audit: { action: 'UPDATE_TEMPLATE', resultCode: 'TEMPLATE_UPDATED' }
    })
  }

  async function changeTemplateStatus({ actor, templateId, expectedVersion, status }) {
    requireSuperAdmin(actor)
    if (status !== 'enabled' && status !== 'disabled') throw createError('INVALID_STATUS')
    const current = requireCurrent(await repository.getTemplateDefinition(requireText(templateId)))
    assertExpectedVersion(current, expectedVersion)
    const currentStatus = current.template.status
    const validTransition = status === 'enabled'
      ? currentStatus === 'draft' || currentStatus === 'disabled'
      : currentStatus === 'enabled'
    if (!validTransition) throw createError('INVALID_STATUS')
    if (status === 'enabled') {
      requireNodeBudget(current.nodes)
      if (current.template.flowSchemaVersion === 2) {
        callTemplateDomain(() => normalizeVersion2TemplateDefinition({
          flowSchemaVersion: 2,
          entryNodeKey: current.template.entryNodeKey,
          nodes: current.nodes
        }))
      }
      const participantUserIds = await assertActiveParticipants(repository, current.nodes, { requireNodes: true })
      requireSnapshotBudget(current.nodes, participantUserIds)
      return repository.mutateTemplateDefinition({
        actor,
        templateId: current.template._id,
        expectedVersion,
        expectedStatus: currentStatus,
        participantUserIds,
        definition: {
          template: {
            status,
            definitionDigest: digestForDefinition(current.template, current.nodes),
            enabledAt: clock(),
            updatedBy: actor._id,
            updatedAt: clock()
          }
        },
        audit: { action: 'ENABLE_TEMPLATE', resultCode: 'TEMPLATE_ENABLED' }
      })
    }
    return repository.mutateTemplateDefinition({
      actor,
      templateId: current.template._id,
      expectedVersion,
      expectedStatus: currentStatus,
      definition: {
        template: { status, disabledAt: clock(), updatedBy: actor._id, updatedAt: clock() }
      },
      audit: {
        action: 'DISABLE_TEMPLATE',
        resultCode: 'TEMPLATE_DISABLED'
      }
    })
  }

  async function deleteTemplate({ actor, templateId, expectedVersion }) {
    requireSuperAdmin(actor)
    const current = requireCurrent(await repository.getTemplateDefinition(requireText(templateId)))
    assertExpectedVersion(current, expectedVersion)
    callTemplateDomain(() => assertTemplateEditable(current.template))
    const at = clock()
    return repository.mutateTemplateDefinition({
      actor,
      templateId: current.template._id,
      expectedVersion,
      expectedStatus: current.template.status,
      definition: {
        template: {
          status: 'deleted', deletedBy: actor._id, deletedAt: at,
          updatedBy: actor._id, updatedAt: at
        }
      },
      audit: { action: 'DELETE_TEMPLATE', resultCode: 'TEMPLATE_DELETED' }
    })
  }

  async function listEnabledTemplates({ actor }) {
    requireActiveActor(actor)
    const definitions = await repository.listTemplateDefinitions({ status: 'enabled' })
    const definitionsWithParticipants = definitions.map(definition => {
      try {
        return { definition, participantUserIds: allParticipantUserIds(definition.nodes) }
      } catch (error) {
        return { definition, participantUserIds: null }
      }
    })
    const requested = [...new Set(definitionsWithParticipants.flatMap(item => item.participantUserIds || []))].sort()
    const active = new Set(await repository.listActiveUserIds(requested))
    return {
      items: definitionsWithParticipants.map(({ definition, participantUserIds }) => {
        let unavailableReason = ''
        try {
          if (!participantUserIds) throw createError('TEMPLATE_INVALID')
          if (definition.template.flowSchemaVersion === 2) {
            callTemplateDomain(() => normalizeVersion2TemplateDefinition({
              flowSchemaVersion: 2,
              entryNodeKey: definition.template.entryNodeKey,
              nodes: definition.nodes
            }))
          }
          validateTemplateForEnable(definition.template, definition.nodes, [...active])
          if (!canCreateBusinessSnapshot(nodesForSnapshotBudget(definition.nodes, participantUserIds))) {
            unavailableReason = 'TEMPLATE_LIMIT_EXCEEDED'
          }
        } catch (error) {
          unavailableReason = error.code === 'ASSIGNEE_INACTIVE'
            ? 'ASSIGNEE_INACTIVE'
            : ['PROCESSOR_INACTIVE', 'REVIEWER_INACTIVE', 'ROLE_OVERLAP', 'TEMPLATE_INVALID',
                'TEMPLATE_LIMIT_EXCEEDED'].includes(error.code)
              ? error.code
              : 'TEMPLATE_INVALID'
        }
        return projectEnabledTemplate(definition, unavailableReason)
      })
    }
  }

  return {
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    changeTemplateStatus,
    deleteTemplate,
    listEnabledTemplates
  }
}

module.exports = { MAX_TEMPLATE_NODES, createTemplateService }
