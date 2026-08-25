const crypto = require('node:crypto')

const { buildSearchEntries, tokenizeEntry } = require('./search-domain')

function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function createSearchService({
  repository,
  secret,
  generationIdFactory = () => crypto.randomBytes(24).toString('hex')
}) {
  if (!repository || typeof repository.consumeRequest !== 'function' ||
      typeof repository.loadAuthoritativeSnapshot !== 'function' ||
      typeof repository.publishGeneration !== 'function' ||
      typeof repository.queryAuthorized !== 'function') {
    throw new TypeError('search repository is required')
  }
  if (typeof secret !== 'string' || Array.from(secret).length < 32) {
    throw createError('SEARCH_SECRET_INVALID')
  }

  async function buildAndPublish(request) {
    if (typeof repository.isGenerationCurrent === 'function' &&
        await repository.isGenerationCurrent(request)) {
      return { businessLineId: request.businessLineId, sourceVersion: request.sourceVersion, indexStatus: 'generated' }
    }
    const snapshot = await repository.loadAuthoritativeSnapshot(request)
    const generationId = generationIdFactory(request)
    if (typeof generationId !== 'string' || generationId.length < 1 || generationId.length > 128) {
      throw createError('SEARCH_GENERATION_INVALID')
    }
    const entries = buildSearchEntries(snapshot).map(entry => ({
      ...entry,
      nodeName: snapshot.nodes.find(node => node.nodeId === entry.nodeId)?.name || '',
      tokenChunks: tokenizeEntry(entry, secret).map(chunk => ({
        tokenChunkIndex: chunk.tokenChunkIndex,
        tokenHashes: chunk.tokenHashes
      }))
    }))
    await repository.publishGeneration({
      businessLineId: request.businessLineId,
      sourceVersion: request.sourceVersion,
      generationId,
      entries
    })
    return { businessLineId: request.businessLineId, sourceVersion: request.sourceVersion, indexStatus: 'generated' }
  }

  async function indexRequest({ token }) {
    const request = await repository.consumeRequest({ token, operation: 'index' })
    return buildAndPublish(request)
  }

  async function queryRequest({ token }) {
    const request = await repository.consumeRequest({ token, operation: 'query' })
    return repository.queryAuthorized({
      actorId: request.actorId,
      normalizedKeywords: request.normalizedKeywords,
      digestInput: request.digestInput,
      pageSize: request.pageSize,
      cursor: request.cursor,
      startDate: request.startDate || '',
      endDate: request.endDate || ''
    })
  }

  async function runCycle({ now, batchSize }) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime()) || batchSize !== 40 ||
        typeof repository.claimBackfillPage !== 'function' ||
        typeof repository.claimRecoveryPage !== 'function' ||
        typeof repository.cleanupOldGeneration !== 'function') {
      throw createError('INVALID_SEARCH_CYCLE')
    }
    const backfill = await repository.claimBackfillPage({ now, batchSize })
    const recovery = await repository.claimRecoveryPage({ now, batchSize })
    const candidates = [...(Array.isArray(backfill) ? backfill : []), ...(Array.isArray(recovery) ? recovery : [])]
      .slice(0, batchSize)
    let generated = 0
    let failed = 0
    for (const request of candidates) {
      try {
        await buildAndPublish(request)
        generated += 1
      } catch (_) {
        failed += 1
      }
    }
    let cleaned = 0
    try {
      const cleanup = await repository.cleanupOldGeneration({ now, batchSize })
      cleaned = Number.isSafeInteger(cleanup && cleanup.cleaned) && cleanup.cleaned >= 0 ? cleanup.cleaned : 0
    } catch (_) {
      failed += 1
    }
    return { examined: candidates.length, generated, failed, cleaned }
  }

  return { indexRequest, queryRequest, runCycle }
}

module.exports = { createSearchService }
