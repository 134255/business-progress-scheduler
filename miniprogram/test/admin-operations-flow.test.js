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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function loadBusinessService(cloudFake) {
  const servicePath = path.join(miniProgramRoot, 'services/business.js')
  if (require.cache[require.resolve(servicePath)]) delete require.cache[require.resolve(servicePath)]
  return withFakeModule('utils/cloud.js', cloudFake, () => require(servicePath))
}

test('运营明细服务使用受保护动作且保留安全中文错误', async () => {
  const calls = []
  const service = loadBusinessService({
    async callBusinessApi(action, payload, options) {
      calls.push({ action, payload, options })
      return { items: [] }
    }
  })
  await service.listOperationsTimingDetails({ startDate: '2026-08-01', endDate: '2026-08-17', pageSize: 20 })
  assert.deepEqual(calls, [{
    action: 'listOperationsTimingDetails',
    payload: { startDate: '2026-08-01', endDate: '2026-08-17', pageSize: 20 },
    options: { silent: true }
  }])
})

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
    },
    async listOperationsTimingDetails(query) {
      calls.push(['timing', query])
      return {
        items: [{
          roundId: 'round-1', businessCode: 'BL-1', businessName: '业务一', businessStatus: 'active',
          nodeCode: 'BL-1-N001', nodeName: '资料处理', processingRoundNumber: 2, reviewRoundNumber: 1,
          reviewStartedAt: '2026-08-17T01:00:00.000Z', submittedByDisplayName: '实际提交人',
          processorAssignmentMode: 'business_creator',
          processingTiming: { recorded: true, status: 'calculated', workMinutes: 95,
            overdueWorkMinutes: 5, startedAt: '2026-08-16T01:00:00.000Z', endedAt: '2026-08-17T01:00:00.000Z' },
          votes: [{ reviewerDisplayName: '实际审核人', decision: 'approved', votedAt: '2026-08-17T02:00:00.000Z',
            responseTiming: { recorded: false } }]
        }],
        nextCursor: 'timing-next', hasMore: false
      }
    }
  }, { toCsv: rows => `CSV:${rows.map(row => row.businessCode).join(',')}` })

  await page.onShow()
  await page.exportCsv()

  assert.equal(page.data.stats.businesses, 3)
  assert.equal(page.data.timingItems[0].assignmentModeLabel, '业务发起人')
  assert.equal(page.data.timingItems[0].processingTimingLabel, '95 个工作分钟')
  assert.equal(page.data.timingItems[0].votes[0].responseTimingLabel, '历史未记录')
  assert.deepEqual(calls.filter(call => call[0] === 'export').map(call => call[1].cursor), ['', 'next'])
  assert.equal(writes[0].data, 'CSV:BL-1,BL-2')
  assert.equal(calls.some(call => call[0] === 'shareFileMessage'), true)
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-operations/index.wxml'), 'utf8')
  assert.match(wxml, /运营看板/)
  assert.match(wxml, /导出 CSV/)
  assert.match(wxml, /节点处理时间明细/)
  assert.match(wxml, /实际提交人/)
})

test('运营明细分页按轮次去重且重复点击只发起一次请求', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'root', role: 'super_admin', status: 'active' } } })
  global.wx = { reLaunch: () => {}, env: { USER_DATA_PATH: '/tmp' } }
  const later = deferred()
  let calls = 0
  const page = loadPage({
    async getOperationsDashboard() { return { stats: {} } },
    async listOperationsTimingDetails(query) {
      calls += 1
      if (!query.cursor) return { items: [{ roundId: 'round-1', processingTiming: { recorded: false }, votes: [] }], nextCursor: 'next', hasMore: true }
      return later.promise
    },
    async exportOperationsRows() { return { items: [], hasMore: false } }
  }, { toCsv: () => '' })
  await page.onShow()
  const first = page.loadMoreTiming()
  const second = page.loadMoreTiming()
  assert.equal(calls, 2)
  later.resolve({
    items: [
      { roundId: 'round-1', processingTiming: { recorded: false }, votes: [] },
      { roundId: 'round-2', processingTiming: { recorded: true, status: 'pending_calendar', workMinutes: null }, votes: [] }
    ], nextCursor: 'end', hasMore: false
  })
  await Promise.all([first, second])
  assert.deepEqual(page.data.timingItems.map(item => item.roundId), ['round-1', 'round-2'])
  assert.equal(page.data.timingItems[1].processingTimingLabel, '日历待补算')
})

test('运营明细加载失败不伪造空结果且账号切换或页面隐藏会丢弃旧响应', async () => {
  const state = { currentUser: { _id: 'root', role: 'super_admin', status: 'active' } }
  global.getApp = () => ({ globalData: state })
  global.wx = { reLaunch: () => {}, env: { USER_DATA_PATH: '/tmp' } }
  const pending = deferred()
  const page = loadPage({
    async getOperationsDashboard() { return { stats: { businesses: 1 } } },
    async listOperationsTimingDetails() { return pending.promise },
    async exportOperationsRows() { return { items: [], hasMore: false } }
  }, { toCsv: () => '' })
  page.data.timingItems = [{ roundId: 'existing' }]
  const request = page.onShow()
  state.currentUser = { _id: 'other', role: 'super_admin', status: 'active' }
  page.onHide()
  pending.resolve({ items: [{ roundId: 'stale', processingTiming: { recorded: false }, votes: [] }], hasMore: false })
  await request
  assert.deepEqual(page.data.timingItems, [{ roundId: 'existing' }])

  state.currentUser = { _id: 'root', role: 'super_admin', status: 'active' }
  const failed = loadPage({
    async getOperationsDashboard() { return { stats: {} } },
    async listOperationsTimingDetails() { throw new Error('底层 cloud://secret') },
    async exportOperationsRows() { return { items: [], hasMore: false } }
  }, { toCsv: () => '' })
  failed.data.timingItems = [{ roundId: 'existing' }]
  await failed.onShow()
  assert.deepEqual(failed.data.timingItems, [{ roundId: 'existing' }])
  assert.equal(failed.data.timingError, '个人工时明细加载失败，请稍后重试')
})
