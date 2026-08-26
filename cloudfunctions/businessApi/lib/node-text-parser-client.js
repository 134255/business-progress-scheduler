'use strict'

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

function createError() {
  const error = new Error('文本识别暂时不可用，请稍后重试')
  error.code = 'NODE_TEXT_PARSE_FAILED'
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function ownData(object, key) {
  if (!object || typeof object !== 'object') return false
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return Boolean(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value'))
}

function denseArray(value, maximum = 48) {
  if (!Array.isArray(value) || value.length > maximum) return false
  for (let index = 0; index < value.length; index += 1) if (!ownData(value, String(index))) return false
  return true
}

function safeValue(value) {
  return typeof value === 'string' && value.length <= 4000 || typeof value === 'boolean' || Number.isFinite(value) ||
    denseArray(value, 100) && value.every(item => typeof item === 'string' && item.length <= 100)
}

function safeAlternatives(value) {
  return denseArray(value, 100) && value.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).length === 2 && ownData(item, 'value') && ownData(item, 'confidence') &&
    typeof item.value === 'string' && item.value.length <= 100 && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1)
}

function normalizeCandidates(value) {
  if (!denseArray(value)) throw createError()
  const seen = new Set()
  const candidates = value.map(item => {
    const required = ['fieldKey', 'value', 'confidence', 'sourceExcerpt', 'matchKind', 'requiresConfirmation', 'alternatives']
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !required.includes(key)) ||
        !required.every(key => ownData(item, key)) || typeof item.fieldKey !== 'string' || !item.fieldKey || item.fieldKey.length > 100 ||
        seen.has(item.fieldKey) || !safeValue(item.value) || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 ||
        typeof item.sourceExcerpt !== 'string' || !item.sourceExcerpt.trim() || item.sourceExcerpt.length > 160 ||
        !['direct', 'exact', 'semantic'].includes(item.matchKind) || typeof item.requiresConfirmation !== 'boolean' || !safeAlternatives(item.alternatives)) throw createError()
    seen.add(item.fieldKey)
    return {
      fieldKey: item.fieldKey, value: item.value, confidence: item.confidence, sourceExcerpt: item.sourceExcerpt,
      matchKind: item.matchKind, requiresConfirmation: item.requiresConfirmation,
      alternatives: item.alternatives.map(entry => ({ value: entry.value, confidence: entry.confidence }))
    }
  })
  return candidates
}

function createNodeTextParserClient({ callFunction } = {}) {
  if (typeof callFunction !== 'function') throw new TypeError('callFunction is required')
  return {
    async parse(data) {
      let response
      try { response = await callFunction({ name: 'nodeTextParser', data }) } catch (_) { throw createError() }
      const result = response && response.result
      if (!result || !ownData(result, 'candidates')) throw createError()
      return { candidates: normalizeCandidates(result.candidates) }
    }
  }
}

module.exports = { createNodeTextParserClient }
