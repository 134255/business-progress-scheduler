const crypto = require('node:crypto')
const { createFakeCloudDatabase } = require('./fake-cloud-database')
const { createCloudSearchRepository } = require('../../lib/cloud-search-repository')
const { buildSearchEntries, tokenizeEntry } = require('../../lib/search-domain')

const SECRET = 'synthetic-concurrency-secret-not-production-1234'
const NOW = new Date('2026-09-10T02:00:00.000Z')
const tick = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function observe(promise) {
  const state = { settled: false }
  state.done = promise.then(value => {
    state.settled = true
    return { value }
  }, error => {
    state.settled = true
    return { error }
  })
  return state
}

// Only gates the fake DB boundary. Repository validation and transaction effects
// remain real; releasing a gate performs the original operation on the fake DB.
function controlDatabase(db, select = () => false) {
  const selected = []
  const operations = []
  let automatic = false
  let active = 0
  let maximum = 0
  function wrap(target, collection, transaction = false, id = null) {
    return new Proxy(target, { get(object, key) {
      const value = object[key]
      if (typeof value !== 'function') return value
      if (['get', 'set', 'update', 'remove'].includes(key)) {
        return async (...args) => {
          const operation = { collection, transaction, id, method: key, data: args[0]?.data }
          operations.push(operation)
          const tracked = select(operation)
          if (tracked) {
            Object.assign(operation, deferred(), { finished: false })
            selected.push(operation)
            active += 1
            maximum = Math.max(maximum, active)
          }
          try {
            if (tracked && !automatic) await operation.promise
            return await value.apply(object, args)
          } finally {
            if (tracked) { operation.finished = true; active -= 1 }
          }
        }
      }
      return (...args) => wrap(value.apply(object, args), collection, transaction,
        key === 'doc' ? args[0] : id)
    } })
  }
  return {
    db: {
      command: db.command,
      collection: name => wrap(db.collection(name), name),
      runTransaction: callback => db.runTransaction(transaction => callback({
        collection: name => wrap(transaction.collection(name), name, true)
      }))
    },
    selected,
    operations,
    get active() { return active },
    get maximum() { return maximum },
    releaseAll() {
      automatic = true
      for (const operation of selected) operation.resolve()
    }
  }
}

function readySeed(nodeCount = 1) {
  const version = { searchSourceVersion: 1, searchGeneratedVersion: 0, searchIndexStatus: 'pending' }
  return {
    users: [{ _id: 'audit-reader', role: 'super_admin', status: 'active' }],
    business_lines: [{ _id: 'audit-line', name: '\u6d4b\u8bd5-BL20260910-000001',
      code: 'BL20260910-000001', description: '', status: 'active', nodeCount,
      currentNodeId: 'audit-node-0', createdAt: NOW, ...version }],
    business_nodes: Array.from({ length: nodeCount }, (_, index) => ({
      _id: `audit-node-${index}`, businessLineId: 'audit-line', sequence: index,
      name: '\u5165\u53e3', nodeCode: `BL20260910-000001-N${String(index + 1).padStart(3, '0')}`,
      status: 'ready', processingRoundNumber: 1, ...version
    }))
  }
}

function roundSeed(nodeCount = 1, evidenceCount = 6) {
  const seed = readySeed(nodeCount)
  seed.node_review_rounds = []
  seed.node_review_votes = []
  seed.evidences = []
  for (const [index, node] of seed.business_nodes.entries()) {
    const roundId = `audit-round-${index}`
    const final = index < nodeCount - 1
    Object.assign(node, { status: final ? 'completed' : 'pending_review',
      activeReviewRoundId: roundId, lastReviewRoundId: roundId })
    const evidenceIds = Array.from({ length: evidenceCount }, (_, item) => `evidence-${index}-${item}`)
    seed.node_review_rounds.push({ _id: roundId, businessLineId: 'audit-line', nodeId: node._id,
      status: final ? 'approved' : 'pending', finalDecision: final ? 'approved' : null,
      processingRoundNumber: 1, fieldValues: [], processingComment: 'current comment', evidenceIds })
    seed.node_review_votes.push({ _id: `vote-${index}`, reviewRoundId: roundId,
      businessLineId: 'audit-line', nodeId: node._id, reviewerUserId: 'audit-reviewer',
      decision: 'approved', comment: 'current vote' })
    for (const id of evidenceIds) seed.evidences.push({ _id: id, businessLineId: 'audit-line',
      nodeId: node._id, storageStatus: 'available', purgedAt: null,
      fileId: `cloud://synthetic/${id}`, fileName: `${id}.pdf` })
  }
  return seed
}

function harness(seed = readySeed(), select) {
  const fake = createFakeCloudDatabase(seed, { rejectExplicitIdOnSet: true })
  const control = controlDatabase(fake.db, select)
  const repository = createCloudSearchRepository({ db: control.db, secret: SECRET, clock: () => NOW })
  return { fake, control, repository }
}

async function publication(repository, generationId = 'audit-generation', sourceVersion = 1) {
  const snapshot = await repository.loadAuthoritativeSnapshot({ businessLineId: 'audit-line', sourceVersion })
  return { businessLineId: 'audit-line', sourceVersion, generationId,
    entries: buildSearchEntries(snapshot).map(entry => ({ ...entry, tokenChunks: tokenizeEntry(entry, SECRET) })) }
}

function ticket(fake, token, sourceVersion = 1) {
  const id = crypto.createHmac('sha256', SECRET).update(token).digest('hex')
  fake.replace('business_search_requests', id, { operation: 'index', actorId: 'audit-reader',
    businessLineId: 'audit-line', sourceVersion, status: 'pending', createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60000) })
}

async function drainWaves(control, outcome) {
  let waves = 0
  await tick()
  while (!outcome.settled) {
    const pending = control.selected.filter(operation => !operation.finished)
    if (!pending.length) throw new Error('probe stalled without an in-flight operation')
    waves += 1
    for (const operation of pending.reverse()) operation.resolve()
    await tick()
  }
  return waves
}

const indexWrite = operation => operation.collection === 'business_search_documents' && operation.method === 'set'
const roundRead = operation => operation.method === 'get' &&
  ['node_review_votes', 'evidences'].includes(operation.collection)

module.exports = { SECRET, NOW, tick, observe, readySeed, roundSeed, harness, publication,
  ticket, drainWaves, indexWrite, roundRead }
