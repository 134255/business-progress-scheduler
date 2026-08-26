'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudParseRepository } = require('../lib/cloud-parse-repository')

const now = new Date('2026-08-26T08:00:00.000Z')
const input = {
  ticketId: 'ntp_123456789012345678901234',
  actorHash: 'a'.repeat(64),
  businessLineId: 'business_12345678901234567890',
  nodeId: 'node_123456789012345678901234',
  expectedNodeVersion: 3,
  schemaDigest: 'b'.repeat(64),
  textDigest: 'c'.repeat(64),
  requestKeyHash: 'd'.repeat(64)
}

function ticket(overrides = {}) {
  return {
    _id: input.ticketId, status: 'pending', actorHash: input.actorHash,
    businessLineId: input.businessLineId, nodeId: input.nodeId, expectedNodeVersion: input.expectedNodeVersion,
    schemaDigest: input.schemaDigest, textDigest: input.textDigest, requestKeyHash: input.requestKeyHash,
    expiresAt: new Date(now.getTime() + 60_000), revision: 0, ...overrides
  }
}

test('parse ticket is atomically consumed once and exact binding mismatches fail closed', async () => {
  const fake = createFakeCloudDatabase({ node_text_parse_requests: [ticket()] })
  const repository = createCloudParseRepository({ db: fake.db, clock: () => now })
  assert.deepEqual(await repository.consumeParseTicket(input), { consumed: true })
  assert.equal(fake.documents('node_text_parse_requests')[0].status, 'consumed')
  await assert.rejects(repository.consumeParseTicket(input), error => error.code === 'NODE_TEXT_TICKET_INVALID')

  for (const [key, value] of [['actorHash', 'e'.repeat(64)], ['textDigest', 'f'.repeat(64)], ['nodeId', 'node_999999999999999999999999']]) {
    const isolated = createFakeCloudDatabase({ node_text_parse_requests: [ticket()] })
    const target = createCloudParseRepository({ db: isolated.db, clock: () => now })
    await assert.rejects(target.consumeParseTicket({ ...input, [key]: value }), error => error.code === 'NODE_TEXT_TICKET_INVALID')
  }
})

test('expired ticket is rejected and bounded cleanup removes only expired tickets', async () => {
  const expired = ticket({ expiresAt: new Date(now.getTime() - 1) })
  const future = ticket({ _id: 'ntp_999999999999999999999999', expiresAt: new Date(now.getTime() + 1) })
  const fake = createFakeCloudDatabase({ node_text_parse_requests: [expired, future] })
  const repository = createCloudParseRepository({ db: fake.db, clock: () => now })
  await assert.rejects(repository.consumeParseTicket(input), error => error.code === 'NODE_TEXT_TICKET_INVALID')
  assert.equal(await repository.cleanupExpired({ limit: 20 }), 1)
  assert.deepEqual(fake.documents('node_text_parse_requests').map(item => item._id), [future._id])
})

test('parse ticket rejects inherited and accessor-backed stored fields without executing getters', async () => {
  let getterCalls = 0
  for (const transformRead of [
    ({ collection, data }) => {
      if (collection !== 'node_text_parse_requests') return data
      const damaged = Object.create({ actorHash: data.actorHash })
      for (const [key, value] of Object.entries(data)) if (key !== 'actorHash') damaged[key] = value
      return damaged
    },
    ({ collection, data }) => {
      if (collection !== 'node_text_parse_requests') return data
      const damaged = { ...data }
      Object.defineProperty(damaged, 'textDigest', { enumerable: true, get() { getterCalls += 1; return data.textDigest } })
      return damaged
    }
  ]) {
    const fake = createFakeCloudDatabase({ node_text_parse_requests: [ticket()] }, { transformRead })
    const repository = createCloudParseRepository({ db: fake.db, clock: () => now })
    await assert.rejects(repository.consumeParseTicket(input), error => error.code === 'NODE_TEXT_TICKET_INVALID')
  }
  assert.equal(getterCalls, 0)
})
