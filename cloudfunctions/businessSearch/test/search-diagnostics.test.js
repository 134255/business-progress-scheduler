const test = require('node:test')
const assert = require('node:assert/strict')
const { createBusinessSearchHandler } = require('../index')
const { reportSearchFailure } = require('../lib/search-diagnostics')

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

test('数据库失败仅输出白名单分类；冲突、权限、超时和系统错误可区分', async () => {
  const wrapped = 'document.update:fail -501001 resource system error. database transaction conflict'
  for (const [properties, causeCode] of [
    [{ code: 'DATABASE_TRANSACTION_CONFLICT' }, 'DATABASE_TRANSACTION_CONFLICT'],
    [{ errCode: -501001, errMsg: wrapped }, 'DATABASE_TRANSACTION_CONFLICT'],
    [{ errCode: -501001, message: wrapped }, 'DATABASE_TRANSACTION_CONFLICT'],
    [{ errCode: -501001, errMsg: 'private system details' }, 'DATABASE_SYSTEM_ERROR'],
    [{ errCode: -501002 }, 'DATABASE_TIMEOUT'],
    [{ errCode: -502003 }, 'DATABASE_PERMISSION_DENIED'],
    [{ code: 'DATABASE_PERMISSION_DENIED' }, 'DATABASE_PERMISSION_DENIED'],
    [{ errCode: -502001 }, 'DATABASE_REQUEST_FAILED'],
    [{ code: 'VERSION_CONFLICT', errCode: -501001, errMsg: wrapped }, 'VERSION_CONFLICT'],
    [{ code: 'private-code', errCode: -501001, errMsg: wrapped }, 'UNKNOWN'],
    [{ errCode: -999999, errMsg: 'private error' }, 'UNKNOWN']
  ]) {
    const logs = []
    const error = Object.assign(new Error('private message'), properties, { searchPhase: 'publish_generation' })
    await assert.rejects(failingHandler(error, logs)({ operation: 'index', ticket: 'private-ticket' }),
      { code: 'BUSINESS_SEARCH_FAILED' })
    assert.deepEqual(logs, [['[businessSearch]', {
      code: 'BUSINESS_SEARCH_FAILED', causeCode, phase: 'publish_generation', operation: 'index'
    }]])
    assert.equal(JSON.stringify(logs).includes('private'), false)
  }
})

test('错误分类不读取访问器或继承值，且不泄漏错误内容', async () => {
  const wrapped = 'document.update:fail -501001 resource system error. database transaction conflict'
  const getter = () => { throw new Error('accessor must not execute') }
  for (const error of [
    Object.create({ code: 'DATABASE_TRANSACTION_CONFLICT', errCode: -501001, errMsg: wrapped }),
    Object.defineProperty({ errCode: -501001 }, 'errMsg', { get: getter }),
    Object.defineProperty({}, 'code', { get: getter }),
    new Proxy({}, { getOwnPropertyDescriptor: getter })
  ]) {
    const logs = []
    reportSearchFailure({ error: (...args) => logs.push(args) }, error, 'index')
    assert.equal(logs.length, 1)
    assert(['UNKNOWN', 'DATABASE_SYSTEM_ERROR'].includes(logs[0][1].causeCode))
  }
})
