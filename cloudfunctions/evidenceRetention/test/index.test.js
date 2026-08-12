const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')

test('生产默认装配使用仓库合法批次完成一次空扫描', async () => {
  const fake = createFakeCloudDatabase({})
  const originalLoad = Module._load
  Module._load = function loadWithCloudStub(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test',
        init() {},
        database: () => fake.db,
        deleteFile: async () => ({ fileList: [] })
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  const indexPath = require.resolve('../index')
  delete require.cache[indexPath]
  try {
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
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
})
