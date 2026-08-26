'use strict'

const { createParserService } = require('./lib/parser-service')
const { createCloudParseRepository } = require('./lib/cloud-parse-repository')
const { createCloudbaseAiClient, resolveModelName } = require('./lib/cloudbase-ai-client')

function safeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createNodeTextParserHandler({ service, repository, getContext = () => ({}), logger = console } = {}) {
  if (!service || typeof service.parseAuthorizedText !== 'function') throw new TypeError('service is required')
  return async function handler(event = {}) {
    const context = getContext() || {}
    if (context.OPENID) throw safeError('FORBIDDEN', '文本识别任务调用未经授权')
    try {
      const result = await service.parseAuthorizedText(event)
      if (repository && typeof repository.cleanupExpired === 'function') {
        try { await repository.cleanupExpired({ limit: 20 }) } catch (_) { logger.error('[nodeTextParser]', { code: 'TICKET_CLEANUP_FAILED' }) }
      }
      return result
    } catch (error) {
      if (error && error.code === 'FORBIDDEN') throw error
      logger.error('[nodeTextParser]', { code: error && error.code === 'NODE_TEXT_TICKET_INVALID' ? 'TICKET_INVALID' : 'PARSE_FAILED' })
      throw safeError(error && error.code === 'NODE_TEXT_TICKET_INVALID' ? 'NODE_TEXT_TICKET_INVALID' : 'NODE_TEXT_PARSE_FAILED',
        error && error.code === 'NODE_TEXT_TICKET_INVALID' ? '文本识别请求已失效，请重试' : '文本识别暂时不可用，请稍后重试')
    }
  }
}

function createDefaultHandler() {
  const cloud = require('wx-server-sdk')
  const tcb = require('@cloudbase/node-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const repository = createCloudParseRepository({ db: cloud.database() })
  const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV, timeout: 60000 })
  const aiClient = createCloudbaseAiClient({
    createModel: group => app.ai().createModel(group),
    modelName: resolveModelName(process.env.NODE_TEXT_PARSE_MODEL)
  })
  return createNodeTextParserHandler({
    repository,
    service: createParserService({ repository, aiClient }),
    getContext: () => cloud.getWXContext()
  })
}

let defaultHandler
exports.main = event => {
  if (!defaultHandler) defaultHandler = createDefaultHandler()
  return defaultHandler(event)
}
exports.createNodeTextParserHandler = createNodeTextParserHandler
