'use strict'

function configError() {
  const error = new Error('invalid AI config')
  error.code = 'NODE_TEXT_CONFIG_INVALID'
  throw error
}

function responseError() {
  const error = new Error('invalid AI response')
  error.code = 'NODE_TEXT_MODEL_INVALID'
  throw error
}

function resolveModelName(value) {
  if (value === undefined) return 'deepseek-v4-flash'
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(value)) configError()
  return value
}

function readStrictJson(value) {
  if (typeof value !== 'string') responseError()
  let text = value.trim()
  const fence = /^```json\s*([\s\S]*?)\s*```$/i.exec(text)
  if (fence) text = fence[1].trim()
  let parsed
  try { parsed = JSON.parse(text) } catch (_) { responseError() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype ||
      Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'candidates') || !Array.isArray(parsed.candidates) ||
      text.includes('"__proto__"') || text.includes('"constructor"') || text.includes('"prototype"')) responseError()
  return parsed
}

function createCloudbaseAiClient({ createModel, modelName } = {}) {
  if (typeof createModel !== 'function') configError()
  const resolvedModelName = resolveModelName(modelName)
  return {
    async parse(request) {
      if (!request || !Array.isArray(request.messages)) responseError()
      const model = createModel('cloudbase')
      if (!model || typeof model.generateText !== 'function') configError()
      const response = await model.generateText({ model: resolvedModelName, messages: request.messages })
      if (!response || response.error) responseError()
      return readStrictJson(response.text)
    }
  }
}

module.exports = { createCloudbaseAiClient, resolveModelName, readStrictJson }
