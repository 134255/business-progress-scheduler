'use strict'

const { createSearchService } = require('./lib/search-service')
const { createCloudSearchRepository } = require('./lib/cloud-search-repository')

function safeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function createBusinessSearchHandler({
  service,
  getContext = () => ({}),
  getTriggerSource = () => '',
  clock = () => new Date(),
  logger = console
} = {}) {
  if (!service || typeof service.indexRequest !== 'function' || typeof service.queryRequest !== 'function' ||
      typeof service.runCycle !== 'function') throw new TypeError('search service is required')
  return async function businessSearchHandler(event = {}) {
    const context = getContext() || {}
    const hasClientIdentity = context.OPENID !== undefined && context.OPENID !== null && context.OPENID !== ''
    try {
      if (event && typeof event.ticket === 'string' && event.ticket &&
          (event.operation === 'index' || event.operation === 'query')) {
        return event.operation === 'query'
          ? await service.queryRequest({ token: event.ticket })
          : await service.indexRequest({ token: event.ticket })
      }
      if (hasClientIdentity || getTriggerSource() !== 'timer') {
        throw safeError('FORBIDDEN', '售后检索任务调用未经授权')
      }
      const now = clock()
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid Date')
      const result = await service.runCycle({ now, batchSize: 40 })
      return {
        examined: safeCount(result && result.examined),
        generated: safeCount(result && result.generated),
        failed: safeCount(result && result.failed),
        cleaned: safeCount(result && result.cleaned)
      }
    } catch (error) {
      if (error && error.code === 'FORBIDDEN') throw error
      logger.error('[businessSearch]', { code: 'BUSINESS_SEARCH_FAILED' })
      throw safeError('BUSINESS_SEARCH_FAILED', '售后检索服务暂时不可用，请稍后重试')
    }
  }
}

function createDefaultHandler() {
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const db = cloud.database()
  const secret = process.env.BUSINESS_SEARCH_HMAC_SECRET
  const repository = createCloudSearchRepository({ db, secret })
  return createBusinessSearchHandler({
    service: createSearchService({ repository, secret }),
    getContext: () => cloud.getWXContext(),
    getTriggerSource: () => process.env.TRIGGER_SRC
  })
}

let defaultHandler

exports.main = async function main(event) {
  if (!defaultHandler) defaultHandler = createDefaultHandler()
  return defaultHandler(event)
}

exports.createBusinessSearchHandler = createBusinessSearchHandler
