const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  processingNotificationId,
  reviewNotificationId
} = require('../../cloudfunctions/workflowReminder/lib/cloud-reminder-repository')

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

function loadPage(relativePath, businessFake) {
  const pagePath = path.join(miniProgramRoot, relativePath)
  let definition
  global.Page = value => { definition = value }
  try {
    withFakeModule('services/business.js', businessFake, () => {
      delete require.cache[require.resolve(pagePath)]
      require(pagePath)
    })
  } finally { delete global.Page }
  assert.ok(definition)
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { Object.assign(this.data, update) }
  }
}

function activeUser(id = 'account-1') { return { _id: id, role: 'user', status: 'active' } }

function deferred() {
  let resolve
  const promise = new Promise(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

test('通知列表分页去重、进入时标记已读且导航只使用服务端标识', async () => {
  const marks = []
  const navigations = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { reLaunch: () => {}, navigateTo: options => navigations.push(options), showToast: () => {} }
  const pages = {
    1: { items: [{ notificationId: 'notice-1', type: 'review_started', read: false, businessLineId: 'line-1', nodeId: 'node-1', reviewRoundId: 'round-1', createdAt: '2026-08-11T01:00:00Z', body: '伪造正文' }], hasMore: true },
    2: { items: [
      { notificationId: 'notice-1', type: 'review_started', read: false, businessLineId: 'line-1', reviewRoundId: 'round-1', createdAt: '2026-08-11T01:00:00Z' },
      { notificationId: 'notice-2', type: 'node_approved', read: true, businessLineId: 'line-2', createdAt: '2026-08-11T02:00:00Z' }
    ], hasMore: false }
  }
  const page = loadPage('pages/notification-list/index.js', {
    listMyNotifications: async ({ page }) => pages[page],
    markNotificationRead: async id => { marks.push(id); return { notificationId: id, read: true } }
  })

  await page.onShow()
  await page.loadMore()
  await page.openNotification({ currentTarget: { dataset: { id: 'notice-1' } } })

  assert.deepEqual(page.data.items.map(item => item.notificationId), ['notice-1', 'notice-2'])
  assert.deepEqual(marks, ['notice-1'])
  assert.equal(page.data.items[0].read, true)
  assert.deepEqual(navigations, [{ url: '/pages/review-detail/index?reviewRoundId=round-1' }])
  assert.equal(page.data.items[0].body, undefined)
})

test('处理、审核和凭证保留提醒采用实际生产编号与类型且不会跨包碰撞', async () => {
  const processingId = processingNotificationId('YW-1-N001', 1)
  const reviewId = reviewNotificationId('round-1', 'user-1', 1)
  const retentionSource = fs.readFileSync(path.resolve(miniProgramRoot,
    '../cloudfunctions/evidenceRetention/lib/cloud-retention-repository.js'), 'utf8')
  const retentionId = 'evidence-retention:line-1:15'

  assert.match(processingId, /^processing-reminder-[a-f0-9]{48}$/)
  assert.match(reviewId, /^review-reminder-[a-f0-9]{48}$/)
  assert.notEqual(processingId, reviewId)
  assert.ok(!processingId.startsWith('evidence-retention:'))
  assert.ok(!reviewId.startsWith('evidence-retention:'))
  assert.match(retentionSource, /`evidence-retention:\$\{candidateLine\._id\}:\$\{days\}`/)

  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { reLaunch: () => {}, navigateTo: () => {}, showToast: () => {} }
  const page = loadPage('pages/notification-list/index.js', {
    listMyNotifications: async () => ({ items: [
      { notificationId: processingId, type: 'processing_reminder', read: false },
      { notificationId: reviewId, type: 'review_reminder', read: false },
      { notificationId: retentionId, type: 'evidence_retention', read: false }
    ], hasMore: false })
  })

  await page.onShow()

  assert.deepEqual(page.data.items.map(item => item.notificationId), [
    processingId, reviewId, retentionId
  ])
})

test('同一通知页面切换账号时新账号刷新可抢占旧加载状态', async () => {
  const first = deferred()
  const app = { globalData: { currentUser: activeUser('account-1') } }
  let calls = 0
  global.getApp = () => app
  global.wx = { reLaunch: () => {} }
  const page = loadPage('pages/notification-list/index.js', {
    listMyNotifications: async () => {
      calls += 1
      if (calls === 1) return first.promise
      return { items: [{ notificationId: 'new-account-note', type: 'review_started', read: false }], hasMore: false }
    }
  })
  const oldLoad = page.onShow()
  app.globalData.currentUser = activeUser('account-2')
  await page.onShow()
  first.resolve({ items: [{ notificationId: 'old-account-note', type: 'review_started', read: false }], hasMore: false })
  await oldLoad

  assert.equal(calls, 2)
  assert.equal(page.data.loading, false)
  assert.deepEqual(page.data.items.map(item => item.notificationId), ['new-account-note'])
})

test('概览从服务端审核与通知分页计算真实数量并提供审核和消息入口', async () => {
  const calls = []
  const cloud = {
    callBusinessApi: async (action, payload) => {
      calls.push([action, payload])
      if (action === 'getMyDashboardSummary') return {
        stats: { active: 1, completed: 1, pendingProcessing: 0 },
        recent: [{ _id: 'line-1', status: 'active' }, { _id: 'line-2', status: 'completed' }],
        complete: true
      }
      if (action === 'listMyPendingReviews') return { items: [{ reviewRoundId: 'round-1' }, { reviewRoundId: 'round-2' }], hasMore: false }
      if (action === 'listMyNotifications') return { items: [{ notificationId: 'n-1', read: false }, { notificationId: 'n-2', read: true }], hasMore: false }
      throw new Error('意外调用')
    }
  }
  const service = withFakeModule('utils/cloud.js', cloud, () => {
    delete require.cache[require.resolve(path.join(miniProgramRoot, 'services/business.js'))]
    return require(path.join(miniProgramRoot, 'services/business.js'))
  })
  const result = await service.dashboard()
  assert.deepEqual(result.stats, {
    active: 1, pendingMine: 0, pendingMineAvailable: true, pendingReviews: 2, unreadNotifications: 1, completed: 1, complete: true
  })

  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  const navigations = []
  global.wx = { reLaunch: () => {}, navigateTo: options => navigations.push(options) }
  const page = loadPage('pages/dashboard/index.js', { dashboard: async () => result })
  await page.onShow()
  page.openReviews()
  page.openNotifications()
  assert.deepEqual(navigations, [
    { url: '/pages/review-list/index' }, { url: '/pages/notification-list/index' }
  ])

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/dashboard/index.wxml'), 'utf8')
  assert.match(wxml, /待我审核/)
  assert.match(wxml, /消息通知/)
  assert.match(wxml, /unreadNotifications/)
})

test('业务详情投影审核节点双时限、轮次和安全显示名，并在刷新后采用服务端下一节点', async () => {
  let calls = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { reLaunch: () => {}, navigateTo: () => {} }
  const page = loadPage('pages/business-detail/index.js', {
    getBusinessLine: async () => {
      calls += 1
      return {
        line: { _id: 'line-1', status: 'active', version: calls, currentNodeId: calls === 1 ? 'node-1' : 'node-2' },
        nodes: [
          { _id: 'node-1', sequence: 0, workflowMode: 'review', status: calls === 1 ? 'pending_review' : 'completed', version: calls, name: '资料收集', processorDisplayNames: ['处理甲'], reviewerDisplayNames: ['审核甲'], processingRoundNumber: 1, reviewRoundNumber: 1, processingDueStatus: 'calculated', processingDueAt: '2026-08-12T01:00:00Z', processingOverdueWorkMinutes: 60, reviewDueStatus: 'calculated', reviewDueAt: '2026-08-13T01:00:00Z', reviewOverdueWorkMinutes: 0, activeReviewRoundId: 'round-1' },
          { _id: 'node-2', sequence: 1, workflowMode: 'review', status: calls === 1 ? 'waiting' : 'ready', version: 1, name: '资料审核', processorDisplayNames: ['处理乙'], reviewerDisplayNames: ['审核乙'], processingRoundNumber: 1, reviewRoundNumber: 0, processingDueStatus: 'calculated', processingDueAt: '2026-08-14T01:00:00Z', processingOverdueWorkMinutes: 0, reviewDueStatus: 'not_started', reviewDueAt: null, reviewOverdueWorkMinutes: 0 }
        ], canManage: false
      }
    }
  })
  page.onLoad({ id: 'line-1' })
  await page.onShow()
  assert.equal(page.data.currentNode._id, 'node-1')
  assert.equal(page.data.nodes[0].processorNamesText, '处理甲')
  assert.equal(page.data.nodes[0].reviewerNamesText, '审核甲')
  assert.match(page.data.nodes[0].processingOverdueText, /1 小时/)
  await page.onShow()
  assert.equal(page.data.currentNode._id, 'node-2')

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/business-detail/index.wxml'), 'utf8')
  assert.match(wxml, /处理轮次/)
  assert.match(wxml, /审核轮次/)
  assert.match(wxml, /处理截止/)
  assert.match(wxml, /审核截止/)
})
