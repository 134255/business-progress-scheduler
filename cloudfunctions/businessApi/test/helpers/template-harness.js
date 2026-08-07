const { createTemplateService } = require('../../lib/template-service')

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function createTemplateHarness({ templates = [], nodes = [], users = [] } = {}) {
  const definitions = new Map()
  const audits = []
  let nextTemplateId = 1
  let nextKey = 1

  for (const template of templates) {
    definitions.set(template._id, {
      template: clone(template),
      nodes: clone(nodes.filter(node => node.templateId === template._id))
    })
  }

  const repository = {
    async listTemplateDefinitions({ status } = {}) {
      return [...definitions.values()]
        .filter(item => item.template.status !== 'deleted')
        .filter(item => !status || item.template.status === status)
        .map(clone)
    },
    async getTemplateDefinition(templateId) {
      const definition = definitions.get(templateId)
      return definition && definition.template.status !== 'deleted' ? clone(definition) : null
    },
    async listActiveUserIds(userIds) {
      const requested = new Set(userIds)
      return users
        .filter(user => requested.has(user._id) && user.status === 'active')
        .map(user => user._id)
    },
    async createTemplateDefinition({ actor, definition, audit }) {
      const templateId = `template-${nextTemplateId++}`
      const stored = {
        template: { _id: templateId, ...clone(definition.template), version: 1 },
        nodes: clone(definition.nodes).map((node, index) => ({
          _id: `${templateId}-node-${index + 1}`,
          templateId,
          ...node,
          version: 1
        }))
      }
      definitions.set(templateId, stored)
      audits.push({ actorId: actor._id, targetId: templateId, ...clone(audit) })
      return clone(stored)
    },
    async mutateTemplateDefinition({ actor, templateId, expectedVersion, expectedStatus, definition, audit }) {
      const current = definitions.get(templateId)
      if (!current || current.template.status === 'deleted') throw createError('NOT_FOUND')
      if (current.template.version !== expectedVersion || current.template.status !== expectedStatus) {
        throw createError('VERSION_CONFLICT')
      }
      const version = current.template.version + 1
      const stored = {
        template: { ...current.template, ...clone(definition.template), version },
        nodes: definition.nodes === undefined
          ? current.nodes
          : clone(definition.nodes).map((node, index) => ({
            _id: node._id || `${templateId}-node-${index + 1}`,
            templateId,
            ...node,
            version
          }))
      }
      definitions.set(templateId, stored)
      audits.push({ actorId: actor._id, targetId: templateId, ...clone(audit) })
      return clone(stored)
    }
  }

  const now = new Date('2026-08-07T02:00:00.000Z')
  const service = createTemplateService({
    repository,
    clock: () => new Date(now),
    keyFactory: prefix => `${prefix}-${nextKey++}`
  })

  return {
    service,
    repository,
    audits,
    definitions,
    admin: { _id: 'admin-1', role: 'super_admin', status: 'active' },
    user: { _id: 'user-1', role: 'user', status: 'active' }
  }
}

module.exports = { createTemplateHarness }
