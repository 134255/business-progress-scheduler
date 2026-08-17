'use strict'

const crypto = require('node:crypto')
const { createRetentionService } = require('./lib/retention-service')
const { createCloudRetentionRepository } = require('./lib/cloud-retention-repository')
const { createCloudStorageAdapter } = require('./lib/cloud-storage-adapter')

function safeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createScheduledHandler({
  service,
  getContext = () => ({}),
  getTriggerSource = () => ''
} = {}) {
  if (!service || typeof service.runOnce !== 'function') throw new TypeError('service.runOnce is required')
  if (typeof getContext !== 'function' || typeof getTriggerSource !== 'function') {
    throw new TypeError('getContext and getTriggerSource are required')
  }
  return async function scheduledRetentionHandler() {
    const context = getContext() || {}
    const openid = context.OPENID
    const hasClientIdentity = openid !== undefined && openid !== null && openid !== ''
    if (hasClientIdentity || getTriggerSource() !== 'timer') {
      throw safeError('FORBIDDEN', '凭证保留任务调用未经授权')
    }
    return service.runOnce()
  }
}

function createDefaultService() {
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const clock = () => new Date()
  const repository = createCloudRetentionRepository({
    db: cloud.database(),
    clock,
    tokenFactory: () => crypto.randomBytes(24).toString('hex')
  })
  const service = createRetentionService({
    repository,
    storage: createCloudStorageAdapter({ cloud }),
    clock,
    batchSize: 40
  })
  return { service, cloud }
}

let defaultHandler

exports.main = async function main() {
  if (!defaultHandler) {
    const { service, cloud } = createDefaultService()
    defaultHandler = createScheduledHandler({
      service,
      getContext: () => cloud.getWXContext(),
      getTriggerSource: () => process.env.TRIGGER_SRC
    })
  }
  return defaultHandler()
}

exports.createScheduledHandler = createScheduledHandler
