const { createBusinessService } = require('../../lib/business-service')

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function businessTemplate(overrides = {}) {
  return {
    template: {
      _id: 'template-1',
      name: '交付模板',
      status: 'enabled',
      version: 3,
      nodeCount: 2,
      ...clone(overrides.template || {})
    },
    nodes: overrides.nodes || [
      {
        _id: 'template-node-1', templateId: 'template-1', nodeKey: 'node-a', sequence: 0,
        name: '启动', description: '', assigneeUserIds: ['user-2'], slaWorkHours: 8,
        requiresEvidence: false, allowedEvidenceTypes: ['pdf'], fields: []
      },
      {
        _id: 'template-node-2', templateId: 'template-1', nodeKey: 'node-b', sequence: 1,
        name: '交付', description: '', assigneeUserIds: ['user-3'], slaWorkHours: 22,
        requiresEvidence: true, allowedEvidenceTypes: ['pdf'], fields: []
      }
    ]
  }
}

function createBusinessHarness({ definition = businessTemplate(), existing = null, createError } = {}) {
  const calls = []
  const repository = {
    async findCreationResult(input) {
      calls.push(['findCreationResult', clone(input)])
      return clone(existing)
    },
    async getTemplateDefinition(templateId) {
      calls.push(['getTemplateDefinition', templateId])
      return clone(definition)
    },
    async createBusinessSnapshot(input) {
      calls.push(['createBusinessSnapshot', clone(input)])
      if (createError) throw createError
      return { id: 'business-1', code: 'BL-20260807-0001' }
    }
  }
  const service = createBusinessService({ repository })
  return {
    service,
    repository,
    calls,
    actor: { _id: 'user-1', role: 'user', status: 'active' }
  }
}

module.exports = { businessTemplate, createBusinessHarness }
