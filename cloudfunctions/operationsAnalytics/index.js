'use strict'

const { createAnalyticsService } = require('./lib/analytics-service')
const { createCloudAnalyticsRepository } = require('./lib/cloud-analytics-repository')
const { createWorkTimeService } = require('./lib/work-time-service')
const { createCloudWorkCalendarRepository } = require('./lib/cloud-work-calendar-repository')

function safeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function createOperationsAnalyticsHandler({
  service,
  getContext = () => ({}),
  getTriggerSource = () => '',
  clock = () => new Date(),
  logger = console
} = {}) {
  if (!service || typeof service.runCycle !== 'function') throw new TypeError('service.runCycle is required')
  return async function operationsAnalyticsHandler() {
    const context = getContext() || {}
    const hasClientIdentity = context.OPENID !== undefined && context.OPENID !== null && context.OPENID !== ''
    if (hasClientIdentity || getTriggerSource() !== 'timer') {
      throw safeError('FORBIDDEN', '运营统计任务调用未经授权')
    }
    const now = clock()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid Date')
    try {
      const result = await service.runCycle({ now, batchSize: 40 })
      return {
        nodeExamined: safeCount(result && result.nodeExamined),
        businessExamined: safeCount(result && result.businessExamined),
        refreshExamined: safeCount(result && result.refreshExamined),
        nodeGenerated: safeCount(result && result.nodeGenerated),
        businessGenerated: safeCount(result && result.businessGenerated),
        refreshed: safeCount(result && result.refreshed),
        failed: safeCount(result && result.failed)
      }
    } catch (_) {
      logger.error('[operationsAnalytics]', { code: 'OPERATIONS_ANALYTICS_FAILED' })
      throw safeError('OPERATIONS_ANALYTICS_FAILED', '运营统计任务执行失败，请稍后重试')
    }
  }
}

function createDefaultHandler() {
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const db = cloud.database()
  const repository = createCloudAnalyticsRepository({ db })
  return createOperationsAnalyticsHandler({
    service: createAnalyticsService({
      analyticsRepository: repository,
      workTimeService: createWorkTimeService({
        calendarRepository: createCloudWorkCalendarRepository({ db })
      })
    }),
    getContext: () => cloud.getWXContext(),
    getTriggerSource: () => process.env.TRIGGER_SRC
  })
}

let defaultHandler

exports.main = async function main() {
  if (!defaultHandler) defaultHandler = createDefaultHandler()
  return defaultHandler()
}

exports.createOperationsAnalyticsHandler = createOperationsAnalyticsHandler
