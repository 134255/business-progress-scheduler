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

function loadPage(businessFake) {
  const pagePath = path.join(miniProgramRoot, 'pages/admin-operations/index.js')
  let definition
  global.Page = value => { definition = value }
  try { withFakeModule('services/business.js', businessFake, () => require(pagePath)) } finally {
    delete global.Page
    if (require.cache[require.resolve(pagePath)]) delete require.cache[require.resolve(pagePath)]
  }
  return { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update) } }
}

function loadBusinessService(cloudFake) {
  const servicePath = path.join(miniProgramRoot, 'services/business.js')
  if (require.cache[require.resolve(servicePath)]) delete require.cache[require.resolve(servicePath)]
  return withFakeModule('utils/cloud.js', cloudFake, () => require(servicePath))
}

test('历史统计客户端服务使用三条受保护动作并保留中文安全错误', async () => {
  const calls = []
  const service = loadBusinessService({
    async callBusinessApi(action, payload, options) {
      calls.push({ action, payload, options })
      return {}
    }
  })
  await service.getOperationsAnalyticsFilters({ templateId: 'template-1' })
  await service.getOperationsAnalyticsSummary({ templateId: 'template-1', grain: 'week' })
  await service.listOperationsAnalyticsSamples({ templateId: 'template-1', metric: 'node_processing' })
  assert.deepEqual(calls.map(item => item.action), [
    'getOperationsAnalyticsFilters', 'getOperationsAnalyticsSummary', 'listOperationsAnalyticsSamples'
  ])
  assert.equal(calls.every(item => item.options.silent === true), true)
})

test('普通活动用户可生成模板节点双柱图并按权限下钻业务样本', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', role: 'user', status: 'active' } } })
  global.wx = { reLaunch: () => assert.fail('活动用户不应重定向') }
  const calls = []
  const page = loadPage({
    async getOperationsAnalyticsFilters(query) {
      calls.push(['filters', query])
      if (!query.templateId) return { templates: [{ templateId: 'template-1', templateName: '验收模板' }] }
      return {
        templates: [{ templateId: 'template-1', templateName: '验收模板' }], templateVersions: [2],
        stableNodes: [{ stableNodeId: 'stable-1', nodeName: '资料处理', sequence: 0 }],
        processors: [{ token: 'a'.repeat(64), displayName: '处理人甲' }], reviewers: []
      }
    },
    async getOperationsAnalyticsSummary(query) {
      calls.push(['summary', query])
      return {
        scopeNotice: '全局汇总可见；业务明细仍按当前账号权限过滤',
        templateMetrics: {
          businessCompletion: { averageMinutes: 120, sampleCount: 2 },
          nodeProcessingPerBusiness: { averageMinutes: 60 },
          reviewPerBusiness: { averageMinutes: 20 }
        },
        nodeSeries: [{ stableNodeId: 'stable-1', nodeName: '资料处理', sequence: 0,
          processing: { averageMinutes: 60, sampleCount: 2 }, review: { averageMinutes: 20, sampleCount: 2 } }],
        trendSeries: [{ bucket: '2026-08-17', processing: { averageMinutes: 60, sampleCount: 1 },
          review: { averageMinutes: 20, sampleCount: 1 } }]
      }
    },
    async listOperationsAnalyticsSamples(query) {
      calls.push(['samples', query])
      return { globalSampleCount: 2, visibleSampleCount: 1, visibilityNotice: '部分明细不可见',
        statistics: { averageMinutes: 60, medianMinutes: 60 },
        items: [{ businessCode: 'BL-1', businessName: '业务一', completedDay: '2026-08-19', workMinutes: 60 }] }
    }
  })
  await page.onShow()
  assert.equal(page.data.summary.businessCompletionSampleLabel, '样本 2')
  assert.equal(page.data.nodeSeries[0].processingWidth, '100%')
  assert.equal(page.data.nodeSeries[0].reviewWidth, '33%')
  assert.equal(page.data.trendSeries[0].processingWidth, '100%')
  assert.equal(page.data.trendSeries[0].reviewWidth, '33%')
  await page.openSamples({ currentTarget: { dataset: { nodeId: 'stable-1', metric: 'node_processing' } } })
  assert.equal(page.data.samples.visibleSampleCount, 1)
  assert.equal(calls.some(call => call[0] === 'samples'), true)
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-operations/index.wxml'), 'utf8')
  assert.match(wxml, /模板节点历史对比/)
  assert.match(wxml, /处理人/)
  assert.match(wxml, /中位数/)
  assert.match(wxml, /businessCompletionSampleLabel/)
})

test('停用账号不能进入历史统计看板', () => {
  let redirected = ''
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', role: 'user', status: 'disabled' } } })
  global.wx = { reLaunch: ({ url }) => { redirected = url } }
  const page = loadPage({})
  page.onShow()
  assert.equal(redirected, '/pages/login/index')
})

test('超级管理员保留原有安全 CSV 导出，普通用户不显示导出入口', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } })
  let written = ''
  let shared = ''
  global.wx = {
    env: { USER_DATA_PATH: '/tmp' },
    getFileSystemManager: () => ({
      writeFile({ data, success }) { written = data; success() }
    }),
    shareFileMessage({ filePath }) { shared = filePath }
  }
  const page = loadPage({
    async exportOperationsRows() {
      return {
        items: [{ businessCode: 'BL-1', businessName: '=危险公式' }],
        hasMore: false,
        nextCursor: ''
      }
    }
  })
  page.setData({ startDate: '2026-08-01', endDate: '2026-08-19' })
  await page.exportCsv()
  assert.match(written, /BL-1/)
  assert.doesNotMatch(written, /,=危险公式/)
  assert.match(shared, /运营数据-2026-08-01-2026-08-19\.csv$/)
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-operations/index.wxml'), 'utf8')
  assert.match(wxml, /wx:if="\{\{isAdmin\}\}"/)
  assert.match(wxml, /导出 CSV/)
})

test('超级管理员加载历史图表时保留原有当前运营指标', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } })
  global.wx = { reLaunch: () => assert.fail('活动管理员不应重定向') }
  const page = loadPage({
    async getOperationsDashboard() { return { stats: { businesses: 8, pendingReview: 2 } } },
    async getOperationsAnalyticsFilters(query) {
      return query.templateId
        ? { templateVersions: [], stableNodes: [], businesses: [], processors: [], reviewers: [] }
        : { templates: [{ templateId: 'template-1', templateName: '模板一' }] }
    },
    async getOperationsAnalyticsSummary() {
      return { templateMetrics: {}, nodeSeries: [], trendSeries: [] }
    }
  })
  await page.onShow()
  assert.equal(page.data.currentStats.businesses, 8)
  assert.equal(page.data.currentStats.pendingReview, 2)
})

test('超级管理员当前指标加载失败不阻断历史统计图表', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } })
  global.wx = { reLaunch: () => assert.fail('活动管理员不应重定向') }
  const page = loadPage({
    async getOperationsDashboard() { throw new Error('CURRENT_STATS_UNAVAILABLE') },
    async getOperationsAnalyticsFilters(query) {
      return query.templateId
        ? { templateVersions: [], stableNodes: [], businesses: [], processors: [], reviewers: [] }
        : { templates: [{ templateId: 'template-1', templateName: '模板一' }] }
    },
    async getOperationsAnalyticsSummary() {
      return { templateMetrics: {}, nodeSeries: [], trendSeries: [] }
    }
  })
  await page.onShow()
  assert.notEqual(page.data.summary, null)
  assert.equal(page.data.currentStats, null)
  assert.equal(page.data.errorMessage, '')
})

test('统计样本支持使用服务端游标继续加载且保留既有展开状态', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', role: 'user', status: 'active' } } })
  global.wx = {}
  const cursors = []
  const page = loadPage({
    async listOperationsAnalyticsSamples(query) {
      cursors.push(query.cursor)
      if (!query.cursor) {
        return {
          globalSampleCount: 2, visibleSampleCount: 2,
          statistics: { averageMinutes: 10, medianMinutes: 10 },
          items: [{ businessCode: 'BL-1', businessName: '业务一' }],
          nextCursor: 'cursor-1', hasMore: true
        }
      }
      return {
        globalSampleCount: 2, visibleSampleCount: 2,
        statistics: { averageMinutes: 10, medianMinutes: 10 },
        items: [{ businessCode: 'BL-2', businessName: '业务二' }],
        nextCursor: '', hasMore: false
      }
    }
  })
  page.setData({
    nodeSeries: [{ stableNodeId: 'stable-1', nodeName: '节点一' }],
    templateOptions: [{ label: '模板一', value: 'template-1' }]
  })
  await page.openSamples({ currentTarget: { dataset: { nodeId: 'stable-1', metric: 'node_processing' } } })
  page.toggleSampleItem({ currentTarget: { dataset: { index: 0 } } })
  await page.loadMoreSamples()
  assert.deepEqual(cursors, ['', 'cursor-1'])
  assert.deepEqual(page.data.samples.items.map(item => item.businessCode), ['BL-1', 'BL-2'])
  assert.equal(page.data.samples.items[0].expanded, true)
  assert.equal(page.data.samples.hasMore, false)
})

test('样本下钻等待期间切换账号不会写回旧账号结果', async () => {
  let resolveSamples
  let currentUser = { _id: 'user-1', role: 'user', status: 'active' }
  global.getApp = () => ({ globalData: { currentUser } })
  global.wx = {}
  const page = loadPage({
    listOperationsAnalyticsSamples() { return new Promise(resolve => { resolveSamples = resolve }) }
  })
  page.setData({
    nodeSeries: [{ stableNodeId: 'stable-1', nodeName: '节点一' }],
    templateOptions: [{ label: '模板一', value: 'template-1' }]
  })
  const pending = page.openSamples({ currentTarget: { dataset: { nodeId: 'stable-1', metric: 'node_processing' } } })
  currentUser = { _id: 'user-2', role: 'user', status: 'active' }
  page.onHide()
  resolveSamples({ items: [{ businessCode: 'BL-1' }] })
  await pending
  assert.equal(page.data.samples, null)
})

test('统计明细把合法零分钟与历史未记录明确区分且不显示空值', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', role: 'user', status: 'active' } } })
  global.wx = {}
  const page = loadPage({
    async listOperationsAnalyticsSamples() {
      return {
        globalSampleCount: 1, visibleSampleCount: 1,
        statistics: { averageMinutes: 0, medianMinutes: 0, minimumMinutes: 0, maximumMinutes: 0 },
        items: [{
          businessCode: 'BL-1', businessName: '业务一', workMinutes: 0,
          rounds: [{
            processingRoundNumber: 1, reviewRoundNumber: 1, processingWorkMinutes: null,
            reviewWorkMinutes: 0, votes: [{ responseWorkMinutes: null }]
          }]
        }]
      }
    }
  })
  page.setData({
    nodeSeries: [{ stableNodeId: 'stable-1', nodeName: '节点一' }],
    templateOptions: [{ label: '模板一', value: 'template-1' }]
  })
  await page.openSamples({ currentTarget: { dataset: { nodeId: 'stable-1', metric: 'node_processing' } } })
  assert.equal(page.data.samples.statistics.averageLabel, '0 分钟')
  assert.equal(page.data.samples.items[0].workMinutesLabel, '0 分钟')
  assert.equal(page.data.samples.items[0].rounds[0].processingWorkMinutesLabel, '历史未记录')
  assert.equal(page.data.samples.items[0].rounds[0].reviewWorkMinutesLabel, '0 分钟')
  assert.equal(page.data.samples.items[0].rounds[0].votes[0].responseWorkMinutesLabel, '历史未记录')
})
