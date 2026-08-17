const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')

test('生产默认装配使用仓库合法批次完成一次空扫描', async () => {
  const fake = createFakeCloudDatabase({})
  const originalLoad = Module._load
  const originalTriggerSource = process.env.TRIGGER_SRC
  Module._load = function loadWithCloudStub(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        getWXContext: () => ({}),
        database: () => fake.db,
        deleteFile: async () => ({ fileList: [] })
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  const indexPath = require.resolve('../index')
  delete require.cache[indexPath]
  try {
    process.env.TRIGGER_SRC = 'timer'
    const { main } = require('../index')
    const result = await main()
    assert.deepEqual(result, {
      feedbackReservationsRecovered: 0,
      amendmentReservationsRecovered: 0,
      remindersCreated: 0,
      objectsPurged: 0,
      orphansPurged: 0,
      failures: {}
    })
  } finally {
    if (originalTriggerSource === undefined) delete process.env.TRIGGER_SRC
    else process.env.TRIGGER_SRC = originalTriggerSource
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})

test('生产默认装配拒绝带小程序身份的调用且不执行云文件删除', async () => {
  const fake = createFakeCloudDatabase({})
  const originalLoad = Module._load
  const originalTriggerSource = process.env.TRIGGER_SRC
  let deleteCalls = 0
  Module._load = function loadWithCloudStub(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        getWXContext: () => ({ OPENID: 'client-openid' }),
        database: () => fake.db,
        async deleteFile() { deleteCalls += 1; return { fileList: [] } }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  const indexPath = require.resolve('../index')
  delete require.cache[indexPath]
  try {
    process.env.TRIGGER_SRC = 'timer'
    const { main } = require('../index')
    await assert.rejects(main({ Type: 'Timer' }), error => error.code === 'FORBIDDEN')
    assert.equal(deleteCalls, 0)
  } finally {
    if (originalTriggerSource === undefined) delete process.env.TRIGGER_SRC
    else process.env.TRIGGER_SRC = originalTriggerSource
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})
