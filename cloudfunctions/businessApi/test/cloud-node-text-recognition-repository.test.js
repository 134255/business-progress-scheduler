'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudNodeTextRecognitionRepository } = require('../lib/cloud-node-text-recognition-repository')

const now = new Date('2026-08-26T08:00:00.000Z')
const actorId = 'account-1'
const actorHash = crypto.createHash('sha256').update(actorId).digest('hex')

function seed(overrides = {}) {
  return {
    users: [{ _id: actorId, status: 'active' }],
    business_lines: [{
      _id: 'line-1', status: 'active', currentNodeId: 'node-1',
      managerUserIds: ['manager-1'], memberUserIds: [actorId]
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', status: 'ready', workflowMode: 'review', version: 3,
      processorUserIds: [actorId], reviewerUserIds: ['reviewer-1'],
      fieldDefinitions: [{ fieldKey: 'name', name: '姓名', type: 'short_text', required: true, constraints: {} }]
    }],
    ...overrides
  }
}

function claimInput(overrides = {}) {
  return {
    actorId, businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
    schemaDigest: 'a'.repeat(64), textDigest: 'b'.repeat(64), requestKeyHash: 'c'.repeat(64),
    dailyLimit: 300, now, ...overrides
  }
}

test('recognition repository reauthorizes current processor and creates a five-minute bound single-use ticket', async () => {
  const fake = createFakeCloudDatabase(seed())
  const repository = createCloudNodeTextRecognitionRepository({ db: fake.db, randomBytes: size => Buffer.alloc(size, 7) })
  const authorized = await repository.authorizeRecognition(claimInput())
  assert.equal(authorized.fieldDefinitions[0].fieldKey, 'name')

  const result = await repository.claimUsageAndCreateTicket(claimInput())
  const tickets = fake.documents('node_text_parse_requests')
  const usage = fake.documents('node_text_parse_usage')[0]
  assert.equal(tickets.length, 1)
  assert.equal(tickets[0].status, 'pending')
  assert.equal(tickets[0].actorHash, actorHash)
  assert.equal(tickets[0].expiresAt.getTime(), now.getTime() + 5 * 60 * 1000)
  assert.equal(usage.dailyCount, 1)
  assert.equal(usage.minuteCount, 1)
  assert.equal(result.actorHash, actorHash)
})

test('recognition repository fails closed at daily 300, per-minute 10 and active single-flight limits', async () => {
  const baseUsage = { _id: `ntu_${actorHash}`, actorHash, dateKey: '2026-08-26', minuteKey: Math.floor(now.getTime() / 60000), revision: 1, lockToken: '' }
  const cases = [
    [{ ...baseUsage, dailyCount: 300, minuteCount: 0, inflightUntil: null }, 'NODE_TEXT_DAILY_LIMITED'],
    [{ ...baseUsage, dailyCount: 1, minuteCount: 10, inflightUntil: null }, 'NODE_TEXT_RATE_LIMITED'],
    [{ ...baseUsage, dailyCount: 1, minuteCount: 1, inflightUntil: new Date(now.getTime() + 1000), lockToken: 'a'.repeat(48) }, 'NODE_TEXT_BUSY']
  ]
  for (const [usage, code] of cases) {
    const fake = createFakeCloudDatabase(seed({ node_text_parse_usage: [usage] }))
    const repository = createCloudNodeTextRecognitionRepository({ db: fake.db })
    await assert.rejects(repository.claimUsageAndCreateTicket(claimInput()), error => error.code === code)
    assert.equal(fake.documents('node_text_parse_requests').length, 0)
  }
})

test('recognition repository rejects stale node and removed processor before issuing ticket', async () => {
  for (const nodeChange of [{ version: 4 }, { status: 'pending_review' }, { processorUserIds: ['account-2'] }]) {
    const documents = seed()
    Object.assign(documents.business_nodes[0], nodeChange)
    const repository = createCloudNodeTextRecognitionRepository({ db: createFakeCloudDatabase(documents).db })
    await assert.rejects(repository.claimUsageAndCreateTicket(claimInput()), error => ['NODE_TEXT_STALE', 'FORBIDDEN'].includes(error.code))
  }
})

test('recognition repository matches feedback authorization for active line membership and strict account schema', async () => {
  const cases = [
    documents => { documents.business_lines[0].status = 'blocked' },
    documents => { documents.business_lines[0].memberUserIds = ['account-2'] },
    documents => { documents.business_lines[0].managerUserIds = [] },
    documents => { documents.business_nodes[0].reviewerUserIds = [actorId] }
  ]
  for (const mutate of cases) {
    const documents = seed()
    mutate(documents)
    const repository = createCloudNodeTextRecognitionRepository({ db: createFakeCloudDatabase(documents).db })
    await assert.rejects(repository.claimUsageAndCreateTicket(claimInput()), error =>
      ['NODE_TEXT_STALE', 'FORBIDDEN'].includes(error.code))
  }
})

test('recognition repository fails closed on usage read errors, future counters and inconsistent locks', async () => {
  const usage = {
    _id: `ntu_${actorHash}`, actorHash, dateKey: '2026-08-26', dailyCount: 1,
    minuteKey: Math.floor(now.getTime() / 60000), minuteCount: 1,
    inflightUntil: null, lockToken: '', revision: 1
  }
  for (const damaged of [
    { ...usage, dateKey: '2026-02-31', dailyCount: 300, minuteCount: 10 },
    { ...usage, dateKey: '2026-08-27', dailyCount: 300 },
    { ...usage, minuteKey: Math.floor(now.getTime() / 60000) + 1, minuteCount: 10 },
    { ...usage, inflightUntil: new Date(now.getTime() + 1000), lockToken: '' },
    { ...usage, inflightUntil: null, lockToken: 'a'.repeat(48) }
  ]) {
    const fake = createFakeCloudDatabase(seed({ node_text_parse_usage: [damaged] }))
    const repository = createCloudNodeTextRecognitionRepository({ db: fake.db })
    await assert.rejects(repository.claimUsageAndCreateTicket(claimInput()), error => error.code === 'NODE_TEXT_CONFIG_INVALID')
    assert.equal(fake.documents('node_text_parse_requests').length, 0)
  }

  const fake = createFakeCloudDatabase(seed({ node_text_parse_usage: [usage] }))
  const originalRunTransaction = fake.db.runTransaction.bind(fake.db)
  const failingDb = {
    ...fake.db,
    runTransaction(callback) {
      return originalRunTransaction(transaction => callback({
        collection(name) {
          const collection = transaction.collection(name)
          if (name !== 'node_text_parse_usage') return collection
          return {
            ...collection,
            doc(id) {
              const document = collection.doc(id)
              return { ...document, async get() { throw new Error('database temporarily unavailable') } }
            }
          }
        }
      }))
    }
  }
  const repository = createCloudNodeTextRecognitionRepository({ db: failingDb })
  await assert.rejects(repository.claimUsageAndCreateTicket(claimInput()), /temporarily unavailable/)
  assert.equal(fake.documents('node_text_parse_requests').length, 0)
})

test('recognition repository fails closed on malformed stored usage without executing accessors', async () => {
  let getterCalls = 0
  const baseUsage = {
    _id: `ntu_${actorHash}`, actorHash, dateKey: '2026-08-26', dailyCount: 1,
    minuteKey: Math.floor(now.getTime() / 60000), minuteCount: 1,
    inflightUntil: null, lockToken: '', revision: 1
  }
  for (const options of [
    {},
    { transformRead: ({ collection, data }) => {
      if (collection !== 'node_text_parse_usage') return data
      const damaged = { ...data }
      Object.defineProperty(damaged, 'dailyCount', { enumerable: true, get() { getterCalls += 1; return 1 } })
      return damaged
    } }
  ]) {
    const usage = options.transformRead ? baseUsage : { ...baseUsage, dailyCount: '1' }
    const fake = createFakeCloudDatabase(seed({ node_text_parse_usage: [usage] }), options)
    const repository = createCloudNodeTextRecognitionRepository({ db: fake.db })
    await assert.rejects(repository.claimUsageAndCreateTicket(claimInput()), error => error.code === 'NODE_TEXT_CONFIG_INVALID')
    assert.equal(fake.documents('node_text_parse_requests').length, 0)
  }
  assert.equal(getterCalls, 0)
})
