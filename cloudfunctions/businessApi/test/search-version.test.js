const test = require('node:test')
const assert = require('node:assert/strict')

const { advanceSearchVersion, stripSearchEnvelope } = require('../lib/search-version')

test('检索来源版本从一开始并保留合法生成版本', () => {
  assert.deepEqual(advanceSearchVersion({}), {
    searchSourceVersion: 1, searchGeneratedVersion: 0, searchIndexStatus: 'pending'
  })
  assert.deepEqual(advanceSearchVersion({ searchSourceVersion: 3, searchGeneratedVersion: 2 }), {
    searchSourceVersion: 4, searchGeneratedVersion: 2, searchIndexStatus: 'pending'
  })
})

test('检索版本对非法、访问器、继承和溢出失败关闭', () => {
  for (const record of [
    { searchSourceVersion: -1 },
    { searchSourceVersion: 1.5 },
    { searchSourceVersion: '1' },
    { searchSourceVersion: Number.MAX_SAFE_INTEGER },
    { searchSourceVersion: 1, searchGeneratedVersion: 2 },
    Object.create({ searchSourceVersion: 1 }),
    Object.defineProperty({}, 'searchSourceVersion', { get() { throw new Error('getter executed') } })
  ]) {
    assert.throws(() => advanceSearchVersion(record), { code: 'SEARCH_STATE_INVALID' })
  }
})

test('内部检索信封只向服务编排暴露公开结果', () => {
  const publicResult = { id: 'line-1', status: 'active' }
  assert.equal(stripSearchEnvelope({ publicResult, searchEnvelope: { sourceVersion: 2 } }), publicResult)
  assert.deepEqual(stripSearchEnvelope(publicResult), publicResult)
  assert.throws(() => stripSearchEnvelope({ searchEnvelope: {} }), { code: 'SEARCH_STATE_INVALID' })
})
