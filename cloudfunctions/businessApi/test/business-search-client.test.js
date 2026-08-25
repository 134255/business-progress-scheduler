const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createBusinessSearchClient } = require('../lib/business-search-client')

const SECRET = 'search-secret-for-tests-only-1234567890'
const NOW = new Date('2026-08-25T10:00:00.000Z')

function harness({ invoke } = {}) {
  const writes = []
  const calls = []
  let sequence = 0
  const db = {
    collection(name) {
      assert.equal(name, 'business_search_requests')
      return {
        doc(id) {
          return { async set({ data }) { writes.push({ id, data: structuredClone(data) }) } }
        }
      }
    }
  }
  const client = createBusinessSearchClient({
    db,
    secret: SECRET,
    clock: () => new Date(NOW),
    randomBytes: size => {
      assert.ok(size >= 24)
      sequence += 1
      return Buffer.alloc(size, sequence)
    },
    callFunction: async input => {
      calls.push(structuredClone(input))
      return invoke ? invoke(input, calls.length) : { result: { ok: true } }
    }
  })
  return { client, writes, calls }
}

test('索引票据不少于二十四字节且数据库只保存票据摘要', async () => {
  const value = harness()
  await value.client.ensureIndexed({ actorId: 'actor-1', businessLineId: 'line-1', sourceVersion: 3 })
  assert.equal(value.writes.length, 1)
  assert.match(value.writes[0].id, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(value.writes).includes(value.calls[0].data.ticket), false)
  assert.deepEqual(value.calls[0], {
    name: 'businessSearch', data: { operation: 'index', ticket: value.calls[0].data.ticket }
  })
  assert.ok(Buffer.from(value.calls[0].data.ticket, 'base64url').length >= 24)
})

test('调用失败映射稳定错误且再次同步签发新票据并复用来源版本', async () => {
  const value = harness({ invoke(input, count) {
    if (count === 1) throw new Error('network cloud://private')
    return { result: { indexStatus: 'generated' } }
  } })
  const envelope = { actorId: 'actor-1', businessLineId: 'line-1', sourceVersion: 3 }
  await assert.rejects(value.client.ensureIndexed(envelope), { code: 'BUSINESS_SEARCH_UNAVAILABLE' })
  assert.deepEqual(await value.client.ensureIndexed(envelope), { indexStatus: 'generated' })
  assert.notEqual(value.calls[0].data.ticket, value.calls[1].data.ticket)
  assert.deepEqual(value.writes.map(write => write.data.sourceVersion), [3, 3])
})

test('查询票据绑定账号和规范化查询且不在调用事件暴露关键词', async () => {
  const value = harness({ invoke: () => ({ result: { items: [{ _id: 'line-1' }], cursor: '' } }) })
  const result = await value.client.query({
    actorId: 'actor-1', query: {
      keyword: '  故障   当前  ', pageSize: 10, cursor: '',
      startDate: '2026-08-01', endDate: '2026-08-31'
    }
  })
  assert.deepEqual(result.items, [{ _id: 'line-1' }])
  assert.equal(JSON.stringify(value.calls).includes('故障'), false)
  assert.deepEqual(value.writes[0].data.normalizedKeywords, ['故障', '当前'])
  assert.equal(value.writes[0].data.actorId, 'actor-1')
  assert.equal(value.writes[0].data.startDate, '2026-08-01')
  assert.equal(value.writes[0].data.endDate, '2026-08-31')
})

test('缺失或过短密钥失败关闭', () => {
  assert.throws(() => createBusinessSearchClient({
    db: { collection() {} }, callFunction() {}, secret: 'short', clock: () => NOW,
    randomBytes: crypto.randomBytes
  }), { code: 'SEARCH_CONFIGURATION_INVALID' })
})
