const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function loadPage(name, service = {}) {
  const servicePath = require.resolve(path.join(root, 'services/business.js'))
  const original = require.cache[servicePath]
  const pagePath = require.resolve(path.join(root, `pages/${name}/index.js`))
  let definition
  global.Page = value => { definition = value }
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: service }
  delete require.cache[pagePath]
  try { require(pagePath) } finally {
    if (original) require.cache[servicePath] = original
    else delete require.cache[servicePath]
    delete require.cache[pagePath]
    delete global.Page
  }
  return { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update) } }
}

function setup(t, overrides = {}) {
  const previousWx = global.wx
  const previousApp = global.getApp
  global.wx = { showToast() {}, navigateTo() {}, reLaunch() {}, ...overrides }
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-test', status: 'active' } } })
  t.after(() => { global.wx = previousWx; global.getApp = previousApp })
}

for (const [status, label] of [['active', '进行中'], ['completed', '已完成']]) {
  test(`首页 ${label} 整张卡片点击进入对应的关联售后列表`, t => {
    const navigation = []
    setup(t, { navigateTo: options => navigation.push(options) })
    const page = loadPage('dashboard')
    const wxml = fs.readFileSync(path.join(root, 'pages/dashboard/index.wxml'), 'utf8')
    const card = wxml.match(new RegExp(`<view([^>]*)><text[^>]*>\\{\\{stats\\.${status}\\}\\}</text><text[^>]*>${label}</text></view>`))
    assert.ok(card, 'dashboard status card exists')
    const binding = card[1].match(/bindtap="([^"]+)"/)
    assert.ok(binding, `${label} 卡片必须绑定点击事件`)
    const dataStatus = card[1].match(/data-status="([^"]+)"/)
    assert.equal(dataStatus && dataStatus[1], status)
    page[binding[1]]({ currentTarget: { dataset: { status } } })
    assert.deepEqual(navigation, [{ url: `/pages/business-list/index?status=${status}&scope=mine` }])
  })

  test(`${label} 列表在分页、检索游标、日期及清空检索时保持服务端筛选`, async t => {
    setup(t)
    const queries = []
    const page = loadPage('business-list', { async listBusinessLines(query) {
      queries.push(query)
      return { items: [{ _id: `line-${queries.length}`, status }], page: query.page, total: 23, hasMore: true, cursor: `cursor-${queries.length}` }
    } })
    await page.onLoad({ status, scope: 'mine' })
    assert.equal(page.data.filterLabel, `与我相关 · ${label}`)
    await page.loadPage(false)
    assert.equal(page.data.total, 23)
    assert.equal(page.data.items.length, 2)
    page.onKeyword({ detail: { value: ' 资料 ' } })
    page.onStartDate({ detail: { value: '2026-09-01' } })
    page.onEndDate({ detail: { value: '2026-09-09' } })
    await page.search()
    await page.loadPage(false)
    page.onKeyword({ detail: { value: '' } })
    await page.search()
    assert.deepEqual(queries, [
      { keyword: '', startDate: '', endDate: '', page: 1, pageSize: 20, status, scope: 'mine' },
      { keyword: '', startDate: '', endDate: '', page: 2, pageSize: 20, status, scope: 'mine' },
      { keyword: '资料', startDate: '2026-09-01', endDate: '2026-09-09', pageSize: 20, cursor: '', status, scope: 'mine' },
      { keyword: '资料', startDate: '2026-09-01', endDate: '2026-09-09', pageSize: 20, cursor: 'cursor-3', status, scope: 'mine' },
      { keyword: '', startDate: '2026-09-01', endDate: '2026-09-09', page: 1, pageSize: 20, status, scope: 'mine' }
    ])
  })
}

test('查看全部保持原入口，非法卡片状态和失效账号不能发起状态跳转', t => {
  const navigation = []
  const login = []
  setup(t, { navigateTo: options => navigation.push(options), reLaunch: options => login.push(options) })
  const page = loadPage('dashboard')
  page.openList()
  assert.equal(typeof page.openStatusList, 'function')
  for (const status of ['deleted', 'constructor', '', null, ['active']]) {
    page.openStatusList({ currentTarget: { dataset: { status } } })
  }
  global.getApp = () => ({ globalData: { currentUser: null } })
  page.openStatusList({ currentTarget: { dataset: { status: 'active' } } })
  assert.deepEqual(navigation, [{ url: '/pages/business-list/index' }])
  assert.deepEqual(login, [{ url: '/pages/login/index' }])
})

test('列表忽略未支持的路由筛选值，无筛选入口保持现有请求协议', async t => {
  setup(t)
  for (const options of [undefined, null, {}, { status: 'deleted', scope: 'global' }, { status: ['active'], scope: true }]) {
    const queries = []
    const page = loadPage('business-list', { async listBusinessLines(query) {
      queries.push(query)
      return { items: [], total: 0, hasMore: false }
    } })
    await page.onLoad(options)
    assert.equal(page.data.filterLabel, '')
    assert.deepEqual(queries, [{ keyword: '', startDate: '', endDate: '', page: 1, pageSize: 20 }])
  }
})

test('状态或范围改变后丢弃旧筛选的在途响应', async t => {
  setup(t)
  for (const change of [{ status: 'completed' }, { scope: '' }]) {
    let resolve
    const page = loadPage('business-list', { listBusinessLines: () => new Promise(done => { resolve = done }) })
    const pending = page.onLoad({ status: 'active', scope: 'mine' })
    page.setData(change)
    resolve({ items: [{ _id: 'stale-line', status: 'active' }], total: 1, hasMore: false })
    await pending
    assert.deepEqual(page.data.items, [])
  }
})

test('筛选后的空检索候选页仍可继续加载，不误报没有匹配', async t => {
  setup(t)
  const queries = []
  const page = loadPage('business-list', { async listBusinessLines(query) {
    queries.push(query)
    return queries.length === 1
      ? { items: [], hasMore: true, cursor: 'continue-scan' }
      : { items: [{ _id: 'line-later', status: 'active' }], hasMore: false, cursor: '' }
  } })
  page.setData({ keyword: '资料' })
  await page.onLoad({ status: 'active', scope: 'mine' })
  assert.equal(page.data.hasMore, true)
  await page.loadMore()
  assert.equal(queries[1].cursor, 'continue-scan')
  assert.deepEqual(page.data.items.map(item => item._id), ['line-later'])
  const wxml = fs.readFileSync(path.join(root, 'pages/business-list/index.wxml'), 'utf8')
  assert.match(wxml, /wx:if="\{\{filterLabel\}\}"[^>]*>\{\{filterLabel\}\}/)
  assert.match(wxml, /<button[^>]*wx:if="\{\{hasMore\}\}"[^>]*bindtap="loadMore"/)
  assert.equal(typeof page.loadMore, 'function')
})
