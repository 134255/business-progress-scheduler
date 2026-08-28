const test = require('node:test')
const assert = require('node:assert/strict')

function freshCloud() {
  const path = require.resolve('../utils/cloud')
  delete require.cache[path]
  return require(path)
}

test('每次云调用只上报动作、耗时和安全结果码且不携带载荷或账号内容', async () => {
  const events = []
  let current = 100
  global.wx = {
    showToast: () => {},
    cloud: {
      callFunction: async request => {
        assert.deepEqual(request.data.payload, { secretText: '不得进入计时事件' })
        current = 137
        return { result: { ok: true, data: { accountId: '不得进入计时事件' } } }
      }
    }
  }
  const { callBusinessApi } = freshCloud()
  await callBusinessApi('getWorkspace', { secretText: '不得进入计时事件' }, {
    clock: () => current,
    onTiming: event => events.push(event)
  })

  assert.deepEqual(events, [{ action: 'getWorkspace', durationMs: 37, outcomeCode: 'OK' }])
  assert.doesNotMatch(JSON.stringify(events), /secretText|accountId|不得进入计时事件/)
})

test('失败调用也只上报稳定结果码且每次恰好一个事件', async () => {
  const events = []
  let current = 10
  global.wx = {
    showToast: () => {},
    cloud: {
      callFunction: async () => {
        current = 25
        return { result: { ok: false, code: 'VERSION_CONFLICT', message: '数据已变化' } }
      }
    }
  }
  const { callBusinessApi } = freshCloud()
  await assert.rejects(callBusinessApi('submit', {}, {
    silent: true,
    clock: () => current,
    onTiming: event => events.push(event)
  }), error => error.code === 'VERSION_CONFLICT')

  assert.deepEqual(events, [{ action: 'submit', durationMs: 15, outcomeCode: 'VERSION_CONFLICT' }])
})
