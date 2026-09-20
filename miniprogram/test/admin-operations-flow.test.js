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
  const app = { globalData: { currentUser: { _id: 'user-1', role: 'user', status: 'active' } } }
  global.getApp = () => app
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
        optionalTail: {
          activationCount: 1, decisionCount: 2, activationRatePercent: 50,
          averageDecisionMinutes: 7, pendingCount: 0, unrecordedCount: 0
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
  assert.equal(page.data.summary.optionalTailActivationLabel, '50%')
  assert.equal(page.data.summary.optionalTailDecisionLabel, '7 分钟')
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
  assert.match(wxml, /追加节点启用率/)
  assert.match(wxml, /平均决定工作时长/)
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
  const actor = { _id: 'admin-1', role: 'super_admin', status: 'active' }
  global.getApp = () => ({ globalData: { currentUser: actor } })
  let written = ''
  let shared = ''
  global.wx = {
    env: { USER_DATA_PATH: '/tmp' },
    getFileSystemManager: () => ({
      writeFile({ data, success }) { written = data; success() }
    }),
    shareFileMessage({ fileName, success }) { shared = fileName; if (success) success({ errMsg: 'shareFileMessage:ok' }) }
  }
  const page = loadPage({
    async exportOperationsReportRows() {
      return {
        items: [{ recordType:'运营基础', businessCode: 'BL-1', businessName: '=危险公式' }],
        hasMore: false,
        nextCursor: ''
      }
    }
  })
  page.setData({ startDate: '2026-08-01', endDate: '2026-08-19' })
  await page.exportCsv()
  assert.match(written, /BL-1/)
  assert.doesNotMatch(written, /,=危险公式/)
  assert.equal(shared, '', '生成文件之后不能从异步回调自动发送')
  page.exportCsv()
  assert.match(shared, /运营数据-2026-08-01-2026-08-19\.csv$/)
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-operations/index.wxml'), 'utf8')
  assert.match(wxml, /wx:if="\{\{isAdmin\}\}"/)
  assert.match(wxml, /导出 CSV/)
})

test('无审核节点经真实运营服务生成CSV并在第二次点击交给文件分享入口', async () => {
  const { createCloudOperationsRepository } = require('../../cloudfunctions/businessApi/lib/cloud-operations-repository')
  const { createOperationsService } = require('../../cloudfunctions/businessApi/lib/operations-service')
  const { createFakeCloudDatabase } = require('../../cloudfunctions/businessApi/test/helpers/fake-cloud-database')
  const actor = { _id: 'admin-1', role: 'super_admin', status: 'active' }
  const fake = createFakeCloudDatabase({
    users: [actor],
    business_lines: [{ _id: 'line-1', code: 'BL-CSV', name: '=危险公式', status: 'completed', createdAt: new Date('2026-08-10') }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-CSV-N001', name: '无需审核',
      sequence: 0, status: 'completed', workflowMode: 'review', reviewRoundNumber: 0,
      processorUserIds: ['admin-1'], processorDisplayNames: ['处理人快照'],
      reviewerUserIds: [], reviewerDisplayNames: []
    }]
  })
  const service = createOperationsService({ repository: createCloudOperationsRepository({ db: fake.db }) })
  global.getApp = () => ({ globalData: { currentUser: actor } })
  let written
  let shared
  global.wx = {
    env: { USER_DATA_PATH: '/synthetic' },
    getFileSystemManager: () => ({ writeFile(options) { written = options; options.success() } }),
    shareFileMessage(options) { shared = options; if (options.success) options.success({ errMsg: 'shareFileMessage:ok' }) }
  }
  // Preserve the accepted base-export regression through an explicit typed-row adapter.
  const page = loadPage({ exportOperationsReportRows: async query => {
    const result=await service.exportRows({actor,query:{startDate:query.startDate,endDate:query.endDate,status:query.status,cursor:query.cursor,pageSize:query.pageSize}})
    return {...result,items:result.items.map(row=>({...row,recordType:'运营基础'}))}
  } })
  page.setData({ startDate: '2026-08-01', endDate: '2026-08-19' })
  await page.exportCsv()
  assert.equal(page.data.errorMessage, '')
  assert.equal(page.data.exporting, false)
  assert.equal(written.encoding, 'utf8')
  assert.ok(written.data.startsWith('\uFEFF售后编号,'))
  assert.match(written.data, /BL-CSV,'=危险公式,completed,BL-CSV-N001,无需审核,completed,review,,处理人快照,,0,0,/)
  assert.equal(shared, undefined)
  page.exportCsv()
  assert.equal(shared.filePath, written.filePath)
  assert.equal(shared.fileName, '运营数据-2026-08-01-2026-08-19.csv')
  assert.deepEqual(fake.writeCalls, [], '只导出，不改客户记录')
})

function exportHarness(overrides = {}) {
  let actor = { _id: 'export-admin', status: 'active', role: 'super_admin' }
  global.getApp = () => ({ globalData: { currentUser: actor } })
  const reads = [], writes = [], shares = []
  global.wx = {
    env: { USER_DATA_PATH: '/synthetic' },
    getFileSystemManager: () => ({ writeFile(options) {
      writes.push(options)
      if (overrides.write) return overrides.write(options)
      options.success()
    } }),
    shareFileMessage(options) {
      shares.push(options)
      if (overrides.share) return overrides.share(options)
      if (options.success) options.success({ errMsg: 'shareFileMessage:ok' })
    }
  }
  const page = loadPage({ async exportOperationsReportRows(query) {
    reads.push({ ...query })
    return overrides.read ? overrides.read(query) : {
      items: [{ recordType:'运营基础', businessCode: 'BL-EXPORT', businessName: '合成数据' }], hasMore: false, nextCursor: ''
    }
  } })
  page.setData({ startDate: '2026-09-01', endDate: '2026-09-11' })
  return { page, reads, writes, shares, setActor(value) { actor = value } }
}

test('CSV生成有反馈且第二次点击在当前点击栈直接发送，不再重新请求数据', async () => {
  const h = exportHarness()
  const preparing = h.page.exportCsv()
  assert.equal(h.page.data.exporting, true)
  await preparing
  assert.equal(h.shares.length, 0)
  assert.equal(h.page.data.exportReady, true)
  assert.match(h.page.data.exportNotice, /已生成.*1.*发送/)
  h.page.exportCsv()
  assert.equal(h.shares.length, 1, '禁止先 await 网络、文件检查或微任务再调用发送')
  assert.equal(h.reads.length, 1)
  assert.equal(h.writes.length, 1)
  assert.match(h.page.data.exportNotice, /已发送/)
})

test('CSV发送的异步失败显示提示，并可用原文件直接重试', async () => {
  const h = exportHarness({ share() {} })
  await h.page.exportCsv()
  h.page.exportCsv()
  assert.equal(typeof h.shares[0].fail, 'function')
  h.shares[0].fail({ errMsg: 'shareFileMessage:fail can only be invoked by user TAP gesture.' })
  assert.match(h.page.data.exportErrorMessage, /发送.*失败/)
  assert.equal(h.page.data.exportSending, false)
  assert.equal(h.page.data.exportReady, true)
  h.page.exportCsv()
  assert.equal(h.shares.length, 2)
  assert.equal(h.shares[1].filePath, h.shares[0].filePath)
  assert.equal(h.reads.length, 1)
  h.shares[1].success({ errMsg: 'shareFileMessage:ok' })
  assert.equal(h.page.data.exportErrorMessage, '')
})

test('CSV取消发送有反馈且不把取消当作成功或丢弃文件', async () => {
  const h = exportHarness({ share() {} })
  await h.page.exportCsv()
  h.page.exportCsv()
  assert.equal(typeof h.shares[0].fail, 'function')
  h.shares[0].fail({ errMsg: 'shareFileMessage:fail cancel' })
  assert.match(h.page.data.exportNotice, /取消/)
  assert.equal(h.page.data.exportErrorMessage, '')
  assert.equal(h.page.data.exportSending, false)
  assert.equal(h.page.data.exportReady, true)
})

for (const [label, share] of [
  ['同步抛错', () => { throw new Error('synthetic platform failure') }],
  ['Promise拒绝', () => Promise.reject({ errMsg: 'shareFileMessage:fail' })]
]) {
  test(`CSV发送${label}也不会静默失败`, async () => {
    const h = exportHarness({ share })
    await h.page.exportCsv()
    await h.page.exportCsv()
    assert.match(h.page.data.exportErrorMessage, /发送.*失败/)
    assert.equal(h.page.data.exportSending, false)
    assert.equal(h.page.data.exportReady, true)
  })
}

test('CSV接口返回Promise成功时有明确反馈', async () => {
  const h = exportHarness({ share: () => Promise.resolve({ errMsg: 'shareFileMessage:ok' }) })
  await h.page.exportCsv()
  await h.page.exportCsv()
  assert.match(h.page.data.exportNotice, /已发送/)
  assert.equal(h.page.data.exportSending, false)
})

test('CSV文件失效后重新生成，不在失效文件上循环发送', async () => {
  const h = exportHarness({ share() {} })
  await h.page.exportCsv()
  h.page.exportCsv()
  h.shares[0].fail({ errMsg: 'shareFileMessage:fail no such file or directory' })
  assert.equal(h.page.data.exportReady, false)
  assert.match(h.page.data.exportErrorMessage, /失效.*重新导出/)
  await h.page.exportCsv()
  assert.equal(h.reads.length, 2)
  assert.equal(h.shares.length, 1)
})

for (const [label, override] of [
  ['数据读取', { read: async () => { throw new Error('synthetic read failure') } }],
  ['本地写入', { write: options => options.fail({ errMsg: 'writeFile:fail' }) }],
  ['损坏返回', { read: async () => ({ items: null, hasMore: false }) }],
  ['重复游标', { read: async () => ({ items: [], hasMore: true, nextCursor: 'repeated' }) }]
]) {
  test(`CSV${label}失败必须显示错误且不得发送残缺文件`, async () => {
    const h = exportHarness(override)
    await h.page.exportCsv()
    assert.match(h.page.data.exportErrorMessage, /失败/)
    assert.equal(h.page.data.exportReady, false)
    assert.equal(h.page.data.exporting, false)
    assert.equal(h.shares.length, 0)
    if (label !== '本地写入') assert.equal(h.writes.length, 0)
  })
}

for (const handler of ['onStartDateChange', 'onEndDateChange', 'onStatusChange', 'onTemplateChange',
  'onVersionChange', 'onGrainChange', 'onNodeChange', 'onBusinessChange', 'onProcessorChange', 'onReviewerChange']) {
  test(`CSV已生成后${handler}清除旧文件发送状态`, async () => {
    const h = exportHarness()
    await h.page.exportCsv()
    await h.page[handler]({ detail: { value: handler.includes('Date') ? '2026-09-02' : '1' } })
    assert.equal(h.page.data.exportReady, false)
    assert.equal(h.page.data.exportNotice, '')
    assert.equal(h.shares.length, 0)
  })
}

test('CSV读取期间切换筛选不会用新筛选给旧数据命名或保存', async () => {
  let completeRead
  const h = exportHarness({ read: () => new Promise(resolve => { completeRead = resolve }) })
  const pending = h.page.exportCsv()
  h.page.onEndDateChange({ detail: { value: '2026-09-10' } })
  assert.equal(h.page.data.exporting, false)
  completeRead({ items: [], hasMore: false })
  await pending
  assert.equal(h.writes.length, 0)
  assert.equal(h.page.data.exportReady, false)
})

test('CSV已生成后退出页面清除可发送引用', async () => {
  const h = exportHarness()
  await h.page.exportCsv()
  h.page.onHide()
  assert.equal(h.page.data.exportReady, false)
  assert.equal(h.shares.length, 0)
})

test('CSV原生发送窗口导致页面隐藏时仍能接收取消回调', async () => {
  const h = exportHarness({ share() {} })
  await h.page.exportCsv()
  h.page.exportCsv()
  h.page.onHide()
  h.shares[0].fail({ errMsg: 'shareFileMessage:fail cancel' })
  assert.match(h.page.data.exportNotice, /取消/)
  assert.equal(h.page.data.exportReady, true)
  assert.equal(h.page.data.exportSending, false)
})

test('CSV页面销毁后迟到发送回调不再写回页面', async () => {
  const h = exportHarness({ share() {} })
  await h.page.exportCsv()
  h.page.exportCsv()
  assert.equal(typeof h.page.onUnload, 'function')
  h.page.onUnload()
  const state = structuredClone(h.page.data)
  h.shares[0].success({ errMsg: 'shareFileMessage:ok' })
  assert.deepEqual(h.page.data, state)
  assert.equal(h.page.data.exportReady, false)
})

test('CSV发送期间账号变更后迟到结果清除旧文件引用', async () => {
  const h = exportHarness({ share() {} })
  await h.page.exportCsv()
  h.page.exportCsv()
  h.setActor({ _id: 'other-admin', role: 'super_admin', status: 'active' })
  h.shares[0].success({ errMsg: 'shareFileMessage:ok' })
  assert.equal(h.page.data.exportReady, false)
  assert.equal(h.page.data.exportNotice, '')
})

test('CSV同编号账号重新登录也不会发送旧会话文件', async () => {
  const h = exportHarness()
  await h.page.exportCsv()
  h.setActor({ _id: 'export-admin', role: 'super_admin', status: 'active' })
  await h.page.exportCsv()
  assert.equal(h.shares.length, 0)
  assert.equal(h.reads.length, 2)
})

test('CSV已生成后失去管理员角色不能发送缓存文件', async () => {
  const h = exportHarness()
  await h.page.exportCsv()
  h.setActor({ _id: 'export-admin', role: 'user', status: 'active' })
  await h.page.exportCsv()
  assert.equal(h.shares.length, 0)
  assert.equal(h.page.data.exportReady, false)
})

function exportClock(t) {
  const timers = new Map()
  const originalSet = global.setTimeout, originalClear = global.clearTimeout
  global.setTimeout = (callback, delay) => { const token = {}; timers.set(token, { callback, delay }); return token }
  global.clearTimeout = token => timers.delete(token)
  t.after(() => { global.setTimeout = originalSet; global.clearTimeout = originalClear })
  return { expire() { for (const [token, timer] of [...timers]) { timers.delete(token); timer.callback() } } }
}

test('CSV发送没有回调时解除等待并提示可重试，旧回调不覆盖新操作', async t => {
  const clock = exportClock(t)
  const h = exportHarness({ share() {} })
  await h.page.exportCsv()
  h.page.exportCsv()
  clock.expire()
  assert.equal(h.page.data.exportSending, false)
  assert.match(h.page.data.exportErrorMessage, /未收到|超时/)
  h.page.exportCsv()
  h.shares[0].success({ errMsg: 'shareFileMessage:ok' })
  assert.equal(h.page.data.exportSending, true)
  h.shares[1].fail({ errMsg: 'shareFileMessage:fail cancel' })
  assert.match(h.page.data.exportNotice, /取消/)
})

test('CSV本地写入没有回调时也显示失败，不永久停在生成中', async t => {
  const clock = exportClock(t)
  const h = exportHarness({ write() {} })
  const pending = h.page.exportCsv()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.writes.length, 1)
  clock.expire()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.page.data.exporting, false)
  assert.match(h.page.data.exportErrorMessage, /生成失败/)
  await pending
})

for (const outcome of ['success', 'cancel']) {
  test(`CSV发送超过等待时间但尚未重试时仍接受原窗口的${outcome}结果`, async t => {
    const clock = exportClock(t)
    const h = exportHarness({ share() {} })
    await h.page.exportCsv()
    h.page.exportCsv()
    h.page.onHide()
    clock.expire()
    if (outcome === 'success') h.shares[0].success({ errMsg: 'shareFileMessage:ok' })
    else h.shares[0].fail({ errMsg: 'shareFileMessage:fail cancel' })
    assert.equal(h.page.data.exportErrorMessage, '')
    assert.match(h.page.data.exportNotice, outcome === 'success' ? /已发送/ : /取消/)
    assert.equal(h.page.data.exportReady, true)
    assert.equal(h.page.data.exportSending, false)
  })
}

test('超级管理员加载历史图表时保留原有当前运营指标', async () => {
  const app = { globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } }
  global.getApp = () => app
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
  const app = { globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } }
  global.getApp = () => app
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
