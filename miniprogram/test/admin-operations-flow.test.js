const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const miniProgramRoot = path.resolve(__dirname, '..')

function withFakeModule(relativePath, exports, callback) {
  const modulePath = path.join(miniProgramRoot, relativePath)
  const resolved = require.resolve(modulePath)
  const original = require.cache[resolved]
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
  try { return callback() } finally {
    if (original) require.cache[resolved] = original
    else delete require.cache[resolved]
  }
}

function loadPage(businessFake, csvFake) {
  const pagePath = path.join(miniProgramRoot, 'pages/admin-operations/index.js')
  let definition
  global.Page = value => { definition = value }
  try {
    withFakeModule('services/business.js', businessFake, () =>
      withFakeModule('utils/csv.js', csvFake, () => require(pagePath)))
  } finally {
    delete global.Page
    if (require.cache[require.resolve(pagePath)]) delete require.cache[require.resolve(pagePath)]
  }
  assert.ok(definition)
  return { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update) } }
}

test('运营看板仅超级管理员可用并按稳定游标导出全部安全行', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'root', role: 'super_admin', status: 'active' } } })
  const calls = []
  const writes = []
  global.wx = {
    env: { USER_DATA_PATH: '/tmp' },
    reLaunch: () => assert.fail('管理员不应重定向'),
    showToast: () => {},
    getFileSystemManager: () => ({ writeFile(options) { writes.push(options); options.success() } }),
    shareFileMessage: options => { calls.push(['shareFileMessage', options.filePath]) }
  }
  const page = loadPage({
    async getOperationsDashboard(query) {
      calls.push(['dashboard', query])
      return { stats: { businesses: 3, active: 2, completed: 1 }, range: query }
    },
    async exportOperationsRows(query) {
      calls.push(['export', query])
      return query.cursor
        ? { items: [{ businessCode: 'BL-2' }], nextCursor: 'end', hasMore: false }
        : { items: [{ businessCode: 'BL-1' }], nextCursor: 'next', hasMore: true }
    }
  }, { toCsv: rows => `CSV:${rows.map(row => row.businessCode).join(',')}` })

  await page.onShow()
  await page.exportCsv()

  assert.equal(page.data.stats.businesses, 3)
  assert.deepEqual(calls.filter(call => call[0] === 'export').map(call => call[1].cursor), ['', 'next'])
  assert.equal(writes[0].data, 'CSV:BL-1,BL-2')
  assert.equal(calls.some(call => call[0] === 'shareFileMessage'), true)
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-operations/index.wxml'), 'utf8')
  assert.match(wxml, /运营看板/)
  assert.match(wxml, /导出 CSV/)
})
