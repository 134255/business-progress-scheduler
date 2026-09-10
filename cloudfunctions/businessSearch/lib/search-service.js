const crypto = require('node:crypto')

const { buildSearchEntries, tokenizeEntry } = require('./search-domain')
const { reportSearchFailure } = require('./search-diagnostics')

function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function claimedPage(value, limit) {
  if (!value || !Number.isSafeInteger(value.scanned) || value.scanned < 0 || value.scanned > limit ||
      !Array.isArray(value.items) || value.items.length > value.scanned) {
    throw createError('INVALID_SEARCH_CYCLE')
  }
  return { scanned: value.scanned, items: value.items.slice() }
}

function createSearchService({
  repository,
  secret,
  logger = console,
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

  async function stage(phase, operation) {
    try {
      return await operation()
    } catch (error) {
      // Preserve the original exception/code. Logging only reads this safe tag.
      try { Object.defineProperty(error, 'searchPhase', { value: phase, configurable: true }) } catch (_) {}
      throw error
    }
  }

  async function buildAndPublish(request) {
    if (typeof repository.isGenerationCurrent === 'function' &&
        await stage('load_snapshot', () => repository.isGenerationCurrent(request))) {
      return { businessLineId: request.businessLineId, sourceVersion: request.sourceVersion, indexStatus: 'generated' }
    }
    const snapshot = await stage('load_snapshot', () => repository.loadAuthoritativeSnapshot(request))
    const { generationId, entries } = await stage('build_entries', () => {
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
      return { generationId, entries }
    })
    await stage('publish_generation', () => repository.publishGeneration({
      businessLineId: request.businessLineId,
      sourceVersion: request.sourceVersion,
      ...(request.recoveryAccess ? { recoveryAccess: request.recoveryAccess } : {}),
      generationId,
      entries
    }))
    return { businessLineId: request.businessLineId, sourceVersion: request.sourceVersion, indexStatus: 'generated' }
  }

  async function indexRequest({ token }) {
    const request = await repository.consumeRequest({ token, operation: 'index' })
    return buildAndPublish(request)
  }

  async function queryRequest({ token }) {
    const request = await repository.consumeRequest({ token, operation: 'query' })
    const input = {
      ...(request.businessStatus ? { businessStatus: request.businessStatus } : {}),
      ...(request.scope ? { scope: request.scope } : {}),
      actorId: request.actorId,
      normalizedKeywords: request.normalizedKeywords,
      digestInput: request.digestInput,
      pageSize: request.pageSize,
      cursor: request.cursor,
      startDate: request.startDate || '',
      endDate: request.endDate || ''
    }
    if (typeof repository.recoverForQuery !== 'function' ||
        input.cursor && !input.cursor.startsWith('recovery:')) {
      return stage('query', () => repository.queryAuthorized(input))
    }
    const recovery = await stage('recovery', () => repository.recoverForQuery(input, buildAndPublish,
      error => reportSearchFailure(logger, error, 'recovery')))
    if (!recovery.done) {
      return { items: [], cursor: recovery.cursor, hasMore: true, indexStatus: 'recovering' }
    }
    // Finish the bounded recovery phase before starting ordinary result paging.
    // The encrypted cursor carries failures; no partial result page is lost.
    const result = await stage('query', () => repository.queryAuthorized({ ...input, cursor: '' },
      { incomplete: recovery.incomplete }))
    return {
      ...result,
      ...(recovery.incomplete ? { indexStatus: 'incomplete' } : {})
    }
  }

  async function runCycle({ now, batchSize }) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime()) || batchSize !== 40 ||
        typeof repository.claimBackfillPage !== 'function' ||
        typeof repository.claimRecoveryPage !== 'function' ||
        typeof repository.cleanupOldGeneration !== 'function') {
      throw createError('INVALID_SEARCH_CYCLE')
    }
    const backfill = claimedPage(await repository.claimBackfillPage({ now, batchSize }), batchSize)
    let remaining = batchSize - backfill.scanned
    const recovery = remaining > 0
      ? claimedPage(await repository.claimRecoveryPage({ now, batchSize: remaining }), remaining)
      : { scanned: 0, items: [] }
    remaining -= recovery.scanned
    const candidates = [...backfill.items, ...recovery.items]
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
    if (remaining > 0) {
      try {
        const cleanup = await repository.cleanupOldGeneration({ now, batchSize: remaining })
        if (!cleanup || !Number.isSafeInteger(cleanup.scanned) || cleanup.scanned < 0 ||
            cleanup.scanned > remaining || !Number.isSafeInteger(cleanup.cleaned) || cleanup.cleaned < 0 ||
            cleanup.cleaned > cleanup.scanned) throw createError('INVALID_SEARCH_CYCLE')
        cleaned = cleanup.cleaned
      } catch (_) {
        failed += 1
      }
    }
    return { examined: candidates.length, generated, failed, cleaned }
  }

  return { indexRequest, queryRequest, runCycle }
}

module.exports = { createSearchService }
