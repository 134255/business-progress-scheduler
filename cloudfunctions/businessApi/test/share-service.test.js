const test = require('node:test')
const assert = require('node:assert/strict')

const { createShareService } = require('../lib/share-service')

test('分享服务使用服务端随机令牌与固定七天有效期且公开读取无需账号', async () => {
  const calls = []
  const token = Buffer.alloc(32, 9).toString('base64url')
  const now = new Date('2026-08-17T10:00:00.000Z')
  const service = createShareService({
    repository: {
      async createSnapshot(input) { calls.push(['create', input]); return { shareId: 'share-1' } },
      async getPublicSnapshot(input) { calls.push(['get', input]); return { title: '固定快照' } }
    },
    tokenFactory: () => token,
    clock: () => new Date(now)
  })
  const actor = { _id: 'user-1', status: 'active' }
  const created = await service.createNodeShareSnapshot({
    actor,
    input: { businessLineId: 'line-1', nodeId: 'node-1', requestKey: 'share-request-1' }
  })
  assert.equal(created.token, token)
  assert.equal(created.expiresAt.toISOString(), '2026-08-24T10:00:00.000Z')
  assert.match(created.path, /public-node-share/)
  assert.equal(Object.hasOwn(created, 'shareId'), false)
  assert.equal(calls[0][1].actor, actor)
  assert.match(calls[0][1].requestKeyHash, /^[a-f0-9]{64}$/)
  assert.match(calls[0][1].inputHash, /^[a-f0-9]{64}$/)
  assert.equal((await service.getPublicNodeShare({ input: { token, cursor: '', pageSize: 40 } })).title, '固定快照')
  assert.equal(calls[1][1].actor, undefined)
})

test('相同请求上下文可稳定派生同一能力令牌且不同请求不会碰撞', () => {
  const { deriveShareToken } = require('../lib/share-service')
  const secret = 'test-secret-that-is-long-enough-for-hmac-derivation'
  const context = { actorId: 'user-1', businessLineId: 'line-1', nodeId: 'node-1', requestKey: 'request-1' }
  const first = deriveShareToken(secret, context)
  assert.equal(first, deriveShareToken(secret, context))
  assert.notEqual(first, deriveShareToken(secret, { ...context, requestKey: 'request-2' }))
  assert.match(first, /^[A-Za-z0-9_-]{43}$/)
})
