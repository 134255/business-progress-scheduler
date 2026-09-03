'use strict'

const crypto = require('node:crypto')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { isSafeRegularExpression } = require('./field-domain')
const { resolveConditionalFields } = require('./conditional-field-domain')

const MAX_TEXT_LENGTH = 8000
const FIELD_TYPES = new Set(['short_text', 'long_text', 'number', 'boolean', 'date', 'single_select', 'multi_select'])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function ownData(object, key) {
  if (!object || typeof object !== 'object') return { valid: false }
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { valid: true, value: descriptor.value }
    : { valid: false }
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function denseArray(value) {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false
  }
  return true
}

function normalizeConstraints(type, value) {
  if (!plainRecord(value)) throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  const allowed = type === 'short_text' || type === 'long_text'
    ? ['minLength', 'maxLength', 'pattern']
    : type === 'number' ? ['min', 'max', 'decimalPlaces']
      : type === 'single_select' || type === 'multi_select' ? ['options'] : []
  if (Object.keys(value).some(key => !allowed.includes(key) || !ownData(value, key).valid)) {
    throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  }
  const result = {}
  for (const key of ['minLength', 'maxLength', 'decimalPlaces']) {
    const entry = ownData(value, key)
    if (entry.valid) {
      if (!Number.isSafeInteger(entry.value) || entry.value < 0) throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
      result[key] = entry.value
    }
  }
  for (const key of ['min', 'max']) {
    const entry = ownData(value, key)
    if (entry.valid) {
      if (!Number.isFinite(entry.value)) throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
      result[key] = entry.value
    }
  }
  const pattern = ownData(value, 'pattern')
  if (pattern.valid) {
    if (typeof pattern.value !== 'string' || !pattern.value.trim() || pattern.value.length > 256 || !isSafeRegularExpression(pattern.value)) {
      throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
    }
    result.pattern = pattern.value
  }
  const options = ownData(value, 'options')
  if (options.valid) {
    if (!denseArray(options.value) || !options.value.length || options.value.length > 100 ||
        options.value.some(option => typeof option !== 'string' || !option.trim() || option.length > 100) ||
        new Set(options.value).size !== options.value.length) throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
    result.options = options.value.slice()
  }
  if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength) {
    throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  }
  if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
    throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  }
  if ((type === 'single_select' || type === 'multi_select') && !result.options) throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  return result
}

function resolveDailyLimit(value) {
  if (value === undefined) return 300
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/.test(value)) throw createError('NODE_TEXT_CONFIG_INVALID', '文本识别配置异常')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) throw createError('NODE_TEXT_CONFIG_INVALID', '文本识别配置异常')
  return parsed
}

function normalizeSchema(definitions) {
  if (!denseArray(definitions) || !definitions.length || definitions.length > 48) throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  const schema = definitions.map(definition => {
    const fieldKey = ownData(definition, 'fieldKey')
    const name = ownData(definition, 'name')
    const type = ownData(definition, 'type')
    const required = ownData(definition, 'required')
    const constraints = ownData(definition, 'constraints')
    if (!fieldKey.valid || !name.valid || !type.valid || !required.valid || !constraints.valid ||
        typeof fieldKey.value !== 'string' || !fieldKey.value.trim() || typeof name.value !== 'string' || !name.value.trim() ||
        typeof type.value !== 'string' || !FIELD_TYPES.has(type.value) || typeof required.value !== 'boolean' ||
        !constraints.value || typeof constraints.value !== 'object' || Array.isArray(constraints.value)) {
      throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
    }
    return {
      fieldKey: fieldKey.value.trim(), name: name.value.trim(), type: type.value,
      required: required.value, constraints: normalizeConstraints(type.value, constraints.value)
    }
  })
  if (new Set(schema.map(item => item.fieldKey)).size !== schema.length) throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  return schema
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function normalizeRecognitionValues(value) {
  if (value === undefined) return []
  if (!denseArray(value)) throw createError('VALIDATION_ERROR', '当前表单内容无效，请刷新后重试')
  const seen = new Set()
  return value.map(item => {
    if (!plainRecord(item) || Object.keys(item).some(key => !['fieldKey', 'value'].includes(key)) ||
        !ownData(item, 'fieldKey').valid || !ownData(item, 'value').valid ||
        typeof item.fieldKey !== 'string' || !item.fieldKey.trim()) {
      throw createError('VALIDATION_ERROR', '当前表单内容无效，请刷新后重试')
    }
    const fieldKey = item.fieldKey.trim()
    const candidate = ownData(item, 'value').value
    const validScalar = typeof candidate === 'string' && candidate.length <= 1000 ||
      typeof candidate === 'boolean' || typeof candidate === 'number' && Number.isFinite(candidate)
    const validArray = denseArray(candidate) && candidate.length <= 100 &&
      candidate.every(entry => typeof entry === 'string' && entry.length <= 100)
    if (seen.has(fieldKey) || !validScalar && !validArray) {
      throw createError('VALIDATION_ERROR', '当前表单内容无效，请刷新后重试')
    }
    seen.add(fieldKey)
    return { fieldKey, value: Array.isArray(candidate) ? candidate.slice() : candidate }
  })
}

function visibleSchema(definitions, fieldValues) {
  try {
    if (!definitions.some(definition => definition && definition.condition !== undefined)) {
      return normalizeSchema(definitions)
    }
    return normalizeSchema(resolveConditionalFields(definitions, fieldValues).visibleDefinitions)
  } catch (error) {
    if (error && ['NODE_TEXT_STALE', 'VALIDATION_ERROR'].includes(error.code)) throw error
    throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validCandidateValue(definition, value) {
  const constraints = definition.constraints
  if (definition.type === 'short_text' || definition.type === 'long_text') {
    if (typeof value !== 'string' || !value.trim()) return false
    if (constraints.minLength !== undefined && value.length < constraints.minLength) return false
    if (constraints.maxLength !== undefined && value.length > constraints.maxLength) return false
    if (constraints.pattern !== undefined && !new RegExp(constraints.pattern).test(value)) return false
    return true
  }
  if (definition.type === 'number') {
    if (!Number.isFinite(value) || constraints.min !== undefined && value < constraints.min ||
        constraints.max !== undefined && value > constraints.max) return false
    if (constraints.decimalPlaces !== undefined) {
      const scaled = value * (10 ** constraints.decimalPlaces)
      if (Math.abs(scaled - Math.round(scaled)) > Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8) return false
    }
    return true
  }
  if (definition.type === 'boolean') return typeof value === 'boolean'
  if (definition.type === 'date') return validDate(value)
  if (definition.type === 'single_select') return typeof value === 'string' && constraints.options.includes(value)
  return denseArray(value) && value.length <= constraints.options.length &&
    value.every(item => typeof item === 'string' && constraints.options.includes(item)) && new Set(value).size === value.length
}

function validateReturnedCandidates(schema, candidates) {
  if (!denseArray(candidates) || candidates.length > schema.length) throw createError('NODE_TEXT_PARSE_FAILED', '文本识别暂时不可用，请稍后重试')
  const definitions = new Map(schema.map(item => [item.fieldKey, item]))
  const seen = new Set()
  return candidates.map(candidate => {
    const definition = candidate && definitions.get(candidate.fieldKey)
    const select = definition && (definition.type === 'single_select' || definition.type === 'multi_select')
    const alternatives = candidate && candidate.alternatives
    if (!definition || seen.has(candidate.fieldKey) || !validCandidateValue(definition, candidate.value) ||
        !denseArray(alternatives) || alternatives.some(item => !item || typeof item.value !== 'string' ||
          !select || !definition.constraints.options.includes(item.value) || !Number.isFinite(item.confidence) ||
          item.confidence < 0 || item.confidence > 1) ||
        new Set(alternatives.map(item => item.value)).size !== alternatives.length ||
        select && !['exact', 'semantic'].includes(candidate.matchKind) ||
        !select && candidate.matchKind !== 'direct' || !select && alternatives.length) {
      throw createError('NODE_TEXT_PARSE_FAILED', '文本识别暂时不可用，请稍后重试')
    }
    seen.add(candidate.fieldKey)
    return candidate
  })
}

function createNodeTextRecognitionService({ repository, parserClient, dailyLimit, clock = () => new Date() } = {}) {
  if (!repository || typeof repository.authorizeRecognition !== 'function' || typeof repository.claimUsageAndCreateTicket !== 'function' ||
      typeof repository.releaseUsage !== 'function' || !parserClient || typeof parserClient.parse !== 'function') throw new TypeError('recognition dependencies are required')
  const resolvedDailyLimit = resolveDailyLimit(dailyLimit)
  return {
    async recognize({ actor, input }) {
      const text = ownData(input, 'text')
      const requestKey = ownData(input, 'requestKey')
      if (!actor || typeof actor._id !== 'string' || !text.valid || typeof text.value !== 'string' || !text.value.trim() || text.value.trim().length > MAX_TEXT_LENGTH ||
          !requestKey.valid || typeof requestKey.value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey.value)) {
        throw createError('VALIDATION_ERROR', '请输入需要识别的文本')
      }
      const expectedNodeVersion = input.expectedNodeVersion
      if (!Number.isSafeInteger(expectedNodeVersion) || expectedNodeVersion < 0) throw createError('VERSION_CONFLICT', '数据已变化，请刷新后重试')
      const formValues = normalizeRecognitionValues(input.fieldValues)
      const before = await repository.authorizeRecognition({
        actorId: actor._id, businessLineId: input.businessLineId, nodeId: input.nodeId, expectedNodeVersion
      })
      const schema = visibleSchema(before.fieldDefinitions, formValues)
      const schemaDigest = digest(JSON.stringify(schema))
      const claim = await repository.claimUsageAndCreateTicket({
        actorId: actor._id,
        businessLineId: input.businessLineId,
        nodeId: input.nodeId,
        expectedNodeVersion,
        schemaDigest,
        textDigest: digest(text.value.trim()),
        requestKeyHash: digest(requestKey.value),
        dailyLimit: resolvedDailyLimit,
        now: clock()
      })
      try {
        const result = await parserClient.parse({
          ticketId: claim.ticketId,
          actorHash: claim.actorHash,
          businessLineId: input.businessLineId,
          nodeId: input.nodeId,
          expectedNodeVersion,
          requestKeyHash: digest(requestKey.value),
          text: text.value.trim(),
          schema
        })
        const after = await repository.authorizeRecognition({
          actorId: actor._id, businessLineId: input.businessLineId, nodeId: input.nodeId, expectedNodeVersion
        })
        if (digest(JSON.stringify(visibleSchema(after.fieldDefinitions, formValues))) !== schemaDigest) {
          throw createError('NODE_TEXT_STALE', '当前节点字段已变化，请刷新后重试')
        }
        return { candidates: validateReturnedCandidates(schema, result.candidates), nodeVersion: expectedNodeVersion, schemaDigest }
      } finally {
        await repository.releaseUsage({ actorHash: claim.actorHash, lockToken: claim.lockToken, now: clock() })
      }
    }
  }
}

module.exports = { createNodeTextRecognitionService, resolveDailyLimit, normalizeSchema, validateReturnedCandidates, digest }
