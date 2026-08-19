'use strict'

const { materializeNodeSource, materializeBusinessSource } = require('./analytics-domain')

const MAX_BATCH_SIZE = 40

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function createAnalyticsService({
  analyticsRepository,
  workTimeService,
  nodeMaterializer,
  businessMaterializer
} = {}) {
  if (!analyticsRepository ||
      typeof analyticsRepository.claimNodeCandidates !== 'function' ||
      typeof analyticsRepository.claimBusinessCandidates !== 'function' ||
      typeof analyticsRepository.readNodeSource !== 'function' ||
      typeof analyticsRepository.readBusinessSource !== 'function') {
    throw new TypeError('analyticsRepository is required')
  }

  async function generateNode(source, now) {
    if (typeof nodeMaterializer === 'function') return nodeMaterializer({ source, now })
    if (typeof analyticsRepository.applyFact !== 'function' ||
        typeof analyticsRepository.markSourceGenerated !== 'function') return { generated: false }
    const facts = materializeNodeSource(source)
    for (const fact of facts) await analyticsRepository.applyFact(fact)
    return analyticsRepository.markSourceGenerated({
      sourceType: 'node', sourceId: source.node._id, sourceVersion: source.node.analyticsSourceVersion
    })
  }

  async function generateBusiness(source, now) {
    if (typeof businessMaterializer === 'function') return businessMaterializer({ source, now })
    if (typeof analyticsRepository.applyFact !== 'function' ||
        typeof analyticsRepository.markSourceGenerated !== 'function') return { generated: false }
    const facts = await materializeBusinessSource(source, workTimeService)
    for (const fact of facts) await analyticsRepository.applyFact(fact)
    return analyticsRepository.markSourceGenerated({
      sourceType: 'business', sourceId: source.line._id, sourceVersion: source.line.analyticsSourceVersion
    })
  }

  async function runCycle({ now, batchSize } = {}) {
    if (!validDate(now)) throw new TypeError('now must be a valid Date')
    if (!Number.isSafeInteger(batchSize) || batchSize !== MAX_BATCH_SIZE) {
      throw new TypeError('batchSize must be 40')
    }
    const nodeCandidates = await analyticsRepository.claimNodeCandidates({ limit: batchSize })
    const businessCandidates = await analyticsRepository.claimBusinessCandidates({ limit: batchSize })
    if (!Array.isArray(nodeCandidates) || !Array.isArray(businessCandidates)) {
      throw new TypeError('candidate page is invalid')
    }
    const result = {
      nodeExamined: nodeCandidates.length,
      businessExamined: businessCandidates.length,
      nodeGenerated: 0,
      businessGenerated: 0,
      failed: 0
    }
    for (const candidate of nodeCandidates) {
      try {
        const source = await analyticsRepository.readNodeSource(candidate)
        const applied = await generateNode(source, now)
        if (applied && applied.generated === true) result.nodeGenerated += 1
      } catch (_) {
        result.failed += 1
      }
    }
    for (const candidate of businessCandidates) {
      try {
        const source = await analyticsRepository.readBusinessSource(candidate)
        const applied = await generateBusiness(source, now)
        if (applied && applied.generated === true) result.businessGenerated += 1
      } catch (_) {
        result.failed += 1
      }
    }
    return result
  }

  return { runCycle }
}

module.exports = { createAnalyticsService, MAX_BATCH_SIZE }
