const test = require('node:test')
const assert = require('node:assert/strict')
const { createBusinessSearchHandler } = require('../index')

function failingHandler(error, logs) {
  return createBusinessSearchHandler({
    service: {
      async indexRequest() { throw error },
      async queryRequest() { throw error },
      async runCycle() { throw error }
    },
    logger: { error(...args) { logs.push(args) } }
  })
}

test('索引失败日志保留允许的原因和阶段，但不输出记录、消息或堆栈', async () => {
  const logs = []
  const error = Object.assign(new Error('private field value'), {
    code: 'SEARCH_SOURCE_INVALID', searchPhase: 'load_snapshot', businessLineId: 'private-record'
  })
  await assert.rejects(failingHandler(error, logs)({ operation: 'index', ticket: 'private-ticket' }),
    { code: 'BUSINESS_SEARCH_FAILED' })
  assert.deepEqual(logs, [['[businessSearch]', {
    code: 'BUSINESS_SEARCH_FAILED', causeCode: 'SEARCH_SOURCE_INVALID', phase: 'load_snapshot', operation: 'index'
  }]])
})

test('未知错误码和阶段不能通过日志泄漏原始数据', async () => {
  const logs = []
  const error = Object.assign(new Error('private message'), { code: 'private-code', searchPhase: 'private-phase' })
  await assert.rejects(failingHandler(error, logs)({ operation: 'query', ticket: 'private-ticket' }),
    { code: 'BUSINESS_SEARCH_FAILED' })
  assert.deepEqual(logs, [['[businessSearch]', {
    code: 'BUSINESS_SEARCH_FAILED', causeCode: 'UNKNOWN', phase: 'unknown', operation: 'query'
  }]])
})
