'use strict'

const { createWorkTimeService } = require('./lib/work-time-service')
const { createReminderService } = require('./lib/reminder-service')
const { createCloudReminderRepository } = require('./lib/cloud-reminder-repository')

function safeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createWorkflowReminderHandler({
  service,
  getContext = () => ({}),
  getTriggerSource = () => '',
  clock = () => new Date(),
  logger = console
} = {}) {
  if (!service || typeof service.runReminderCycle !== 'function') {
    throw new TypeError('service.runReminderCycle is required')
  }
  if (typeof getContext !== 'function' || typeof getTriggerSource !== 'function' || typeof clock !== 'function') {
    throw new TypeError('getContext, getTriggerSource and clock are required')
  }
  return async function workflowReminderHandler() {
    const context = getContext() || {}
    const openid = context.OPENID
    const hasClientIdentity = openid !== undefined && openid !== null && openid !== ''
    if (hasClientIdentity || getTriggerSource() !== 'timer') {
      throw safeError('FORBIDDEN', '提醒任务调用未经授权')
    }
    const now = clock()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid Date')
    try {
      const result = await service.runReminderCycle({ now, batchSize: 40 })
      return {
        processingCreated: Number.isSafeInteger(result && result.processingCreated)
          ? result.processingCreated
          : 0,
        reviewCreated: Number.isSafeInteger(result && result.reviewCreated)
          ? result.reviewCreated
          : 0
      }
    } catch (error) {
      logger.error('[workflowReminder]', { code: 'WORKFLOW_REMINDER_FAILED' })
      throw safeError('WORKFLOW_REMINDER_FAILED', '工作流提醒执行失败，请稍后重试')
    }
  }
}

function createDefaultHandler() {
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const db = cloud.database()
  const repository = createCloudReminderRepository({ db })
  const service = createReminderService({
    reminderRepository: repository,
    workTimeService: createWorkTimeService({ calendarRepository: repository })
  })
  return createWorkflowReminderHandler({
    service,
    getContext: () => cloud.getWXContext(),
    getTriggerSource: () => process.env.TRIGGER_SRC
  })
}

let defaultHandler

exports.main = async function main(event) {
  if (!defaultHandler) defaultHandler = createDefaultHandler()
  return defaultHandler(event)
}

exports.createWorkflowReminderHandler = createWorkflowReminderHandler
