'use strict'

const crypto = require('node:crypto')
const { createRetentionService } = require('./lib/retention-service')
const { createCloudRetentionRepository } = require('./lib/cloud-retention-repository')
const { createCloudStorageAdapter } = require('./lib/cloud-storage-adapter')

function createScheduledHandler({ service } = {}) {
  if (!service || typeof service.runOnce !== 'function') throw new TypeError('service.runOnce is required')
  return async function scheduledRetentionHandler() {
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
  return createRetentionService({
    repository,
    storage: createCloudStorageAdapter({ cloud }),
    clock,
    batchSize: 40
  })
}

let defaultHandler

exports.main = async function main() {
  if (!defaultHandler) defaultHandler = createScheduledHandler({ service: createDefaultService() })
  return defaultHandler()
}

exports.createScheduledHandler = createScheduledHandler
