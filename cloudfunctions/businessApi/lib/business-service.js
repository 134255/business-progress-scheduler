const { validateTemplateForEnable } = require('./template-domain')
const {
  APPLICATION_ERROR_MARKER,
  MAX_TEMPLATE_NODES,
  TEMPLATE_LIMIT_MESSAGE
} = require('./cloud-template-repository')

const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function requireActiveActor(actor) {
  if (!actor || typeof actor._id !== 'string' || !actor._id || actor.status !== 'active') {
    throw createError('FORBIDDEN')
  }
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError('VALIDATION_ERROR')
  return value.trim()
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw createError('VALIDATION_ERROR')
  const match = DATE_PATTERN.exec(value)
  if (!match) throw createError('VALIDATION_ERROR')
  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 ||
      date.getUTCDate() !== Number(day)) {
    throw createError('VALIDATION_ERROR')
  }
  return value
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError('VALIDATION_ERROR')
  const plannedStartDate = normalizeDate(input.plannedStartDate)
  const plannedEndDate = normalizeDate(input.plannedEndDate)
  if (plannedStartDate && plannedEndDate && plannedStartDate > plannedEndDate) {
    throw createError('VALIDATION_ERROR')
  }
  const requestKey = requireText(input.requestKey)
  if (!REQUEST_KEY_PATTERN.test(requestKey)) throw createError('VALIDATION_ERROR')
  return {
    templateId: requireText(input.templateId),
    name: requireText(input.name),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    plannedStartDate,
    plannedEndDate,
    requestKey
  }
}

function requireEnabledDefinition(definition) {
  if (!definition || !definition.template || definition.template.status !== 'enabled') {
    throw createError('TEMPLATE_NOT_ENABLED')
  }
  if (!Array.isArray(definition.nodes) || definition.nodes.length > MAX_TEMPLATE_NODES) {
    throw createError('TEMPLATE_LIMIT_EXCEEDED', TEMPLATE_LIMIT_MESSAGE)
  }
  if (definition.template.nodeCount !== definition.nodes.length) throw createError('TEMPLATE_INVALID')
  const assigneeIds = [...new Set(definition.nodes.flatMap(node => node.assigneeUserIds || []))]
  try {
    validateTemplateForEnable(definition.template, definition.nodes, assigneeIds)
  } catch (error) {
    error[APPLICATION_ERROR_MARKER] = true
    throw error
  }
  return definition
}

function createBusinessService({ repository }) {
  if (!repository) throw new TypeError('repository is required')

  async function createFromTemplate({ actor, input }) {
    requireActiveActor(actor)
    const normalized = normalizeInput(input)
    const existing = await repository.findCreationResult({ actorId: actor._id, input: normalized })
    if (existing) return existing
    const definition = requireEnabledDefinition(
      await repository.getTemplateDefinition(normalized.templateId)
    )
    return repository.createBusinessSnapshot({ actor, input: normalized, definition })
  }

  return { createFromTemplate }
}

module.exports = { createBusinessService }
