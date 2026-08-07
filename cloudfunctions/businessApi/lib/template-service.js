const {
  normalizeTemplateNode,
  validateTemplateForEnable,
  assertTemplateEditable
} = require('./template-domain')
const {
  APPLICATION_ERROR_MARKER,
  MAX_TEMPLATE_NODES,
  TEMPLATE_LIMIT_MESSAGE
} = require('./cloud-template-repository')

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
    if (['TEMPLATE_INVALID', 'TEMPLATE_NOT_EDITABLE', 'ASSIGNEE_INACTIVE', 'NOT_FOUND'].includes(error.code)) {
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

function normalizeNodeInput(node, sequence, nodeKey) {
  return callTemplateDomain(() => normalizeTemplateNode({ ...node, nodeKey, sequence }))
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
  return inputNodes.map((node, sequence) => {
    const nodeKey = uniqueKey(keyFactory, 'node', nodeKeys)
    const fields = Array.isArray(node && node.fields) ? node.fields : []
    const keyedFields = fields.map(field => ({ ...field, fieldKey: uniqueKey(keyFactory, 'field', fieldKeys) }))
    return normalizeNodeInput({ ...node, fields: keyedFields }, sequence, nodeKey)
  })
}

function assignUpdateKeys(current, inputNodes, keyFactory) {
  if (!Array.isArray(inputNodes)) throw createError('TEMPLATE_INVALID')
  const currentNodes = new Map(current.nodes.map(node => [node.nodeKey, node]))
  const occupiedNodeKeys = new Set(currentNodes.keys())
  const occupiedFieldKeys = new Set(current.nodes.flatMap(node => node.fields.map(field => field.fieldKey)))
  const selectedNodeKeys = new Set()
  const selectedFieldKeys = new Set()

  return inputNodes.map((node, sequence) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw createError('TEMPLATE_INVALID')
    let existingNode = null
    let nodeKey
    if (node.nodeKey === undefined || node.nodeKey === '') {
      nodeKey = uniqueKey(keyFactory, 'node', occupiedNodeKeys)
    } else {
      nodeKey = requireText(node.nodeKey)
      existingNode = currentNodes.get(nodeKey)
      if (!existingNode || selectedNodeKeys.has(nodeKey)) throw createError('TEMPLATE_INVALID')
    }
    if (selectedNodeKeys.has(nodeKey)) throw createError('TEMPLATE_INVALID')
    selectedNodeKeys.add(nodeKey)

    const existingFields = new Map((existingNode && existingNode.fields || []).map(field => [field.fieldKey, field]))
    if (!Array.isArray(node.fields)) throw createError('TEMPLATE_INVALID')
    const fields = node.fields.map(field => {
      let fieldKey
      if (field.fieldKey === undefined || field.fieldKey === '') {
        fieldKey = uniqueKey(keyFactory, 'field', occupiedFieldKeys)
      } else {
        fieldKey = requireText(field.fieldKey)
        if (!existingFields.has(fieldKey) || selectedFieldKeys.has(fieldKey)) throw createError('TEMPLATE_INVALID')
      }
      if (selectedFieldKeys.has(fieldKey)) throw createError('TEMPLATE_INVALID')
      selectedFieldKeys.add(fieldKey)
      return { ...field, fieldKey }
    })
    return {
      ...normalizeNodeInput({ ...node, fields }, sequence, nodeKey),
      ...(existingNode && existingNode._id ? { _id: existingNode._id } : {})
    }
  })
}

function allAssigneeIds(nodes) {
  return [...new Set(nodes.flatMap(node => node.assigneeUserIds))]
}

async function assertActiveAssignees(repository, nodes, { requireNodes = false } = {}) {
  const requested = allAssigneeIds(nodes)
  const active = await repository.listActiveUserIds(requested)
  if ((requireNodes && nodes.length === 0) || active.length !== requested.length ||
      nodes.some(node => node.assigneeUserIds.length === 0)) {
    throw createError(requested.length ? 'ASSIGNEE_INACTIVE' : 'TEMPLATE_INVALID')
  }
  return active
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

function projectEnabledTemplate(definition, available) {
  const { template } = definition
  return {
    _id: template._id,
    name: template.name,
    description: template.description || '',
    nodeCount: template.nodeCount,
    available,
    unavailableReason: available ? '' : 'ASSIGNEE_INACTIVE'
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
    const metadata = normalizeMetadata(input)
    const nodes = assignCreateKeys(requireNodeBudget(input.nodes === undefined ? [] : input.nodes), keyFactory)
    await assertActiveAssignees(repository, nodes)
    const at = clock()
    return repository.createTemplateDefinition({
      actor,
      assigneeUserIds: allAssigneeIds(nodes),
      definition: {
        template: {
          ...metadata,
          status: 'draft',
          nodeCount: nodes.length,
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
    const metadata = normalizeMetadata(input)
    const nodes = assignUpdateKeys(
      current,
      requireNodeBudget(input.nodes === undefined ? [] : input.nodes),
      keyFactory
    )
    await assertActiveAssignees(repository, nodes)
    return repository.mutateTemplateDefinition({
      actor,
      templateId: current.template._id,
      expectedVersion,
      expectedStatus: current.template.status,
      assigneeUserIds: allAssigneeIds(nodes),
      definition: {
        template: { ...metadata, nodeCount: nodes.length, updatedBy: actor._id, updatedAt: clock() },
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
      const active = await assertActiveAssignees(repository, current.nodes, { requireNodes: true })
      callTemplateDomain(() => validateTemplateForEnable(current.template, current.nodes, active))
    }
    const timestampField = status === 'enabled' ? 'enabledAt' : 'disabledAt'
    return repository.mutateTemplateDefinition({
      actor,
      templateId: current.template._id,
      expectedVersion,
      expectedStatus: currentStatus,
      ...(status === 'enabled' ? { assigneeUserIds: allAssigneeIds(current.nodes) } : {}),
      definition: {
        template: { status, [timestampField]: clock(), updatedBy: actor._id, updatedAt: clock() }
      },
      audit: {
        action: status === 'enabled' ? 'ENABLE_TEMPLATE' : 'DISABLE_TEMPLATE',
        resultCode: status === 'enabled' ? 'TEMPLATE_ENABLED' : 'TEMPLATE_DISABLED'
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
    const requested = [...new Set(definitions.flatMap(definition => allAssigneeIds(definition.nodes)))]
    const active = new Set(await repository.listActiveUserIds(requested))
    return {
      items: definitions.map(definition => projectEnabledTemplate(
        definition,
        definition.nodes.length > 0 && definition.nodes.every(node =>
          node.assigneeUserIds.length > 0 && node.assigneeUserIds.every(id => active.has(id)))
      ))
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
