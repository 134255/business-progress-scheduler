const test = require('node:test')
const assert = require('node:assert/strict')

let bootstrapUser
try {
  ;({ bootstrapUser } = require('../lib/bootstrap-user'))
} catch (error) {
  // RED 阶段允许实现模块暂时不存在；测试本身仍以明确断言失败。
}

test('并发初始化撞到 openid 唯一索引时返回已创建的用户', async () => {
  assert.equal(typeof bootstrapUser, 'function', '缺少并发安全的 bootstrapUser 实现')

  const winner = {
    _id: 'user-winner',
    openid: 'openid-1',
    displayName: '微信用户',
    status: 'active'
  }
  const lookupResults = [[], [winner]]
  const users = {
    where(query) {
      assert.deepEqual(query, { openid: 'openid-1' })
      return {
        limit(limit) {
          assert.equal(limit, 1)
          return {
            async get() {
              return { data: lookupResults.shift() }
            }
          }
        }
      }
    },
    async add() {
      throw new Error('E11000 duplicate key error: openid_unique')
    }
  }

  const result = await bootstrapUser({
    users,
    openid: 'openid-1',
    now: () => 'server-date'
  })

  assert.deepEqual(result, winner)
  assert.equal(lookupResults.length, 0)
})
