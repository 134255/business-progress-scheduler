const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const cases = [
  ['pending-processing', 'listMyPendingProcessing', 'nodeId'],
  ['review-list', 'listMyPendingReviews', 'reviewRoundId']
]
const summary = { state: 'ready', configRevision: 3, fields: [
  { id: 'brand', label: '品牌', value: '合成品牌' },
  { id: 'model', label: '型号', value: '合成型号' },
  { id: 'order', label: '订单编号', value: '0' },
  { id: 'name', label: '姓名', value: '合成姓名' }
] }
function fixture(key, id = 'task-1') {
  return { [key]: id, businessLineId: 'line-1', businessCode: 'BL-SYNTHETIC-1',
    businessName: '示例模板-BL-SYNTHETIC-1', nodeId: key === 'nodeId' ? id : 'node-1',
    nodeCode: 'SYNTHETIC-N002', nodeName: '示例节点', status: key === 'nodeId' ? 'ready' : 'pending',
    processingRoundNumber: 2, reviewRoundNumber: 3, reviewMode: 'all',
    processingDueAt: '2026-09-24T02:00:00Z', reviewDueAt: '2026-09-24T02:00:00Z',
    reviewDueStatus: 'calculated', cardSummary: structuredClone(summary) }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(t, name, method, read) {
  const app = { globalData: { currentUser: { _id: 'actor-1', status: 'active', role: 'user' } } }
  const previous = { wx: global.wx, getApp: global.getApp, Page: global.Page }
  const navigations = [], calls = []
  global.getApp = () => app
  global.wx = { reLaunch() {}, navigateTo: input => navigations.push(input),
    setStorageSync() { assert.fail('summaries must remain memory-only') } }
  const servicePath = require.resolve('../services/business')
  const pagePath = require.resolve(path.join('..', 'pages', name, 'index'))
  const oldService = require.cache[servicePath]
  let definition
  global.Page = value => { definition = value }
  require.cache[servicePath] = { exports: { [method]: query => { calls.push(query); return read(query) } } }
  delete require.cache[pagePath]
  try { require(pagePath) } finally {
    if (oldService) require.cache[servicePath] = oldService
    else delete require.cache[servicePath]
    delete require.cache[pagePath]
    global.Page = previous.Page
  }
  t.after(() => Object.assign(global, previous))
  const page = { ...definition, data: structuredClone(definition.data), setData(data) { Object.assign(this.data, data) } }
  return { page, app, calls, navigations }
}
const response = items => ({ items, hasMore: true, cursor: 'next-page' })

for (const [name, method, key] of cases) {
  test(`${name} renders homepage fields in order and keeps task context/navigation`, async t => {
    const { page, navigations } = setup(t, name, method, async () => response([fixture(key)]))
    await page.onShow()
    const item = page.data.items[0]
    assert.equal(item.cardTitle, 'BL-SYNTHETIC-1')
    assert.equal(item.cardState, 'ready')
    assert.deepEqual(item.cardRows.map(row => [row.label, row.value]), [
      ['品牌', '合成品牌'], ['型号', '合成型号'], ['订单编号', '0'], ['姓名', '合成姓名']
    ])
    assert.equal(item.nodeName, '示例节点')
    assert.match(item.dueText, /截止/)
    if (name === 'pending-processing') {
      assert.equal(item.status, 'ready')
      assert.equal(item.processingRoundNumber, 2)
      page.openItem({ currentTarget: { dataset: { lineId: 'line-1', nodeId: 'task-1' } } })
      assert.deepEqual(navigations, [{ url: '/pages/node-feedback/index?lineId=line-1&nodeId=task-1' }])
    } else {
      assert.equal(item.cardStatus, 'pending_review')
      assert.equal(item.status, 'pending')
      assert.equal(item.reviewRoundNumber, 3)
      assert.equal(item.reviewModeLabel, '会签')
      page.openDetail({ currentTarget: { dataset: { id: 'task-1' } } })
      assert.deepEqual(navigations, [{ url: '/pages/review-detail/index?reviewRoundId=task-1' }])
    }
  })
  test(`${name} retry refreshes configured summaries; empty and legacy responses are safe`, async t => {
    let cardSummary = { state: 'unavailable', fields: [] }
    const { page } = setup(t, name, method, async () => response([{ ...fixture(key), cardSummary }]))
    await page.onShow()
    assert.equal(page.data.items[0].cardState, 'unavailable')
    cardSummary = summary
    await page.retryCards()
    assert.equal(page.data.items[0].cardRows.length, 4)
    cardSummary = { state: 'ready', fields: [], configRevision: 4 }
    await page.retryCards()
    assert.deepEqual(page.data.items[0].cardRows, [])
    assert.equal(page.data.items[0].cardState, 'ready')
    cardSummary = undefined
    await page.retryCards()
    assert.equal(page.data.items[0].cardState, 'none')
  })
  test(`${name} pagination decorates new cards and updates duplicate tasks without losing context`, async t => {
    let count = 0
    const { page, calls } = setup(t, name, method, async () => ++count === 1
      ? response([fixture(key)]) : response([
        { ...fixture(key), cardSummary: { state: 'ready', fields: [], configRevision: 4 } }, fixture(key, 'task-2')
      ]))
    await page.onShow()
    await page.loadMore()
    assert.deepEqual(page.data.items.map(item => item[key]), ['task-1', 'task-2'])
    assert.equal(page.data.items[0].cardRows.length, 0)
    assert.equal(page.data.items[1].cardRows.length, 4)
    assert.deepEqual(calls[1], name === 'pending-processing' ? { cursor: 'next-page', pageSize: 20 } : { page: 2, pageSize: 20 })
  })
  for (const code of ['FORBIDDEN', 'UNAUTHORIZED', 'ACCOUNT_DISABLED', 'ACCOUNT_LOCKED', 'PASSWORD_CHANGE_REQUIRED', 'ACCOUNT_STATE_INVALID']) {
    test(`${name} ${code} clears visible fields and pagination`, async t => {
      let fail = false
      const { page } = setup(t, name, method, async () => {
        if (fail) throw Object.assign(new Error('synthetic'), { code })
        return response([fixture(key)])
      })
      await page.onShow()
      fail = true
      await page.loadMore()
      assert.deepEqual(page.data.items, [])
      assert.equal(page.data.hasMore, false)
      assert.equal(page.data.loadingMore, false)
      assert.ok(page.data.errorMessage)
    })
  }
  for (const change of ['account', 'role', 'logout']) {
    test(`${name} ${change} clears old fields immediately and rejects in-flight response`, async t => {
      const pending = deferred()
      let count = 0
      const { page, app } = setup(t, name, method, async () => ++count === 1 ? response([fixture(key)]) : pending.promise)
      await page.onShow()
      const loading = page.loadMore()
      if (change === 'account') app.globalData.currentUser._id = 'actor-2'
      if (change === 'role') app.globalData.currentUser.role = 'super_admin'
      if (change === 'logout') app.globalData.currentUser = null
      const refresh = page.onShow()
      assert.deepEqual(page.data.items, [])
      pending.resolve(response([]))
      await Promise.all([loading, refresh])
      assert.deepEqual(page.data.items, [])
      assert.equal(page.data.loadingMore, false)
    })
  }
  test(`${name} network refresh failure keeps same-user cards and continuation for retry`, async t => {
    let fail = false
    const { page } = setup(t, name, method, async () => {
      if (fail) throw Object.assign(new Error('synthetic'), { code: 'NETWORK_ERROR' })
      return response([fixture(key)])
    })
    await page.onShow()
    const before = structuredClone(page.data)
    fail = true
    await page.refresh()
    assert.deepEqual(page.data.items, before.items)
    assert.equal(page.data.cursor, before.cursor)
    assert.equal(page.data.page, before.page)
    assert.equal(page.data.hasMore, before.hasMore)
    assert.ok(page.data.errorMessage)
    fail = false
    await page.retryCards()
    assert.equal(page.data.errorMessage, '')
  })
}
