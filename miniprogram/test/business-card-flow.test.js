const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const root = path.resolve(__dirname, '..')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(t) {
  const app = { globalData: { currentUser: { _id: 'actor-a', status: 'active', role: 'super_admin' } } }
  const navigation = []
  const before = { wx: global.wx, getApp: global.getApp }
  global.getApp = () => app
  global.wx = { reLaunch() {}, showToast() {}, navigateTo: value => navigation.push(value),
    setStorageSync() { assert.fail('customer cards must remain memory-only') } }
  t.after(() => Object.assign(global, before))
  return { app, navigation }
}
function pageFor(name, service) {
  const servicePath = require.resolve(path.join(root, 'services/business.js'))
  const pagePath = require.resolve(path.join(root, `pages/${name}/index.js`))
  const previous = require.cache[servicePath]
  let definition
  global.Page = value => { definition = value }
  require.cache[servicePath] = { exports: service }
  delete require.cache[pagePath]
  try { require(pagePath) } finally {
    if (previous) require.cache[servicePath] = previous
    else delete require.cache[servicePath]
    delete require.cache[pagePath]
    delete global.Page
  }
  return { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } }
}
const fixture = () => ({
  _id: 'line-synthetic', code: 'BL-SYNTHETIC-1', name: '示例-BL-SYNTHETIC-1', status: 'active',
  flowSchemaVersion: 2, completedNodeCount: 2, traversedNodeCount: 3, progress: 66, currentNodeName: '示例节点',
  matches: [{ nodeName: '示例节点', label: '说明', excerpt: '合成命中一' }, { label: '型号', excerpt: '合成命中二' }],
  cardSummary: { state: 'ready', configRevision: 3, fields: [
    { id: 'zero', label: '数量', value: '0' }, { id: 'false', label: '已确认', value: 'false' },
    { id: 'long', label: '说明', value: '🙂中文'.repeat(26) }
  ] }
})
const result = item => ({ items: [item], recent: [item], stats: { active: 1 }, total: 1, hasMore: false, page: 1 })

function protectedCards(app) {
  // Exercise index.js resolveActor and its marked-error boundary, then the real
  // cloud.js/business.js adapters. Only SDK I/O and authorized card reads are fake.
  const apiPath = require.resolve('../../cloudfunctions/businessApi/index')
  const previous = require.cache[apiPath]
  const originalLoad = Module._load
  let createBusinessApi
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'wx-server-sdk') return { init() {}, database: () => ({ command: {} }) }
      return originalLoad.call(this, request, parent, isMain)
    }
    delete require.cache[apiPath]
    ;({ createBusinessApi } = require(apiPath))
  } finally {
    Module._load = originalLoad
    if (previous) require.cache[apiPath] = previous
    else delete require.cache[apiPath]
  }
  const state = {
    actor: { ...app.globalData.currentUser },
    credential: { mustChangePassword: false, lockedUntil: null },
    item: fixture(), readError: null, calls: [], responses: []
  }
  const read = async () => {
    if (state.readError) throw state.readError
    return { ...result(state.item), hasMore: true, cursor: 'synthetic-next' }
  }
  const api = createBusinessApi({
    repository: {
      async findUserByOpenid() { return state.actor },
      async findCredential() { return state.credential }
    },
    getContext: () => ({ OPENID: 'synthetic-binding' }),
    clock: () => 0,
    logger: { error() {} },
    businessService: { listBusinessLines: read },
    dashboardWorkspaceService: { getDashboardWorkspace: read }
  })
  global.wx.cloud = { async callFunction(input) {
    state.calls.push(input.data)
    const response = await api.main(input.data)
    state.responses.push(response)
    return { result: response }
  } }
  return { state, service: require('../services/business') }
}

// These are server state transitions from index.js:590-598, not fabricated
// error envelopes: reset retains the binding; missing credentials fail closed.
const protectedDenials = [
  ['PASSWORD_CHANGE_REQUIRED', state => { state.credential.mustChangePassword = true }],
  ['ACCOUNT_STATE_INVALID', state => { state.credential = null }]
]

for (const [code, deny] of protectedDenials) {
  for (const name of ['dashboard', 'business-list']) {
    test(`${name} actual API ${code} clears active-profile cards and continuation/cache state`, async t => {
      const { app } = setup(t)
      const localProfile = structuredClone(app.globalData.currentUser)
      const { state, service } = protectedCards(app)
      const page = pageFor(name, service)
      const dashboard = name === 'dashboard'
      if (dashboard) await page.onShow()
      else {
        page.setData({ keyword: '合成' })
        await page.onLoad({})
        page.toggleMatches({ currentTarget: { dataset: { id: state.item._id } } })
        assert.equal(page.data.items[0].visibleMatches.length, 2)
        assert.deepEqual(page.data.expandedMatchIds, { 'line-synthetic': true })
        assert.equal(page.data.cursor, 'synthetic-next')
        assert.equal(page.data.hasMore, true)
      }
      assert.equal((dashboard ? page.data.recent : page.data.items)[0].cardRows.length, 3)
      deny(state)
      if (dashboard) await page.onShow()
      else await page.loadMore()
      assert.equal(state.responses.at(-1).ok, false)
      assert.equal(state.responses.at(-1).code, code)
      assert.deepEqual(app.globalData.currentUser, localProfile)
      assert.deepEqual(dashboard ? page.data.recent : page.data.items, [], 'denied session must clear visible cards')
      assert.equal(page.data.loading, false)
      assert.ok(page.data.errorMessage)
      if (dashboard) {
        assert.deepEqual(page.data.stats, { active: 0, pendingMine: null, pendingMineAvailable: false, completed: 0 })
        const again = page.onShow()
        // Check synchronously, before another rejection can hide cache replay.
        assert.deepEqual(page.data.recent, [], 'onShow must not replay the denied module cache')
        await again
        assert.equal(state.calls.length, 3)
      } else {
        assert.equal(state.calls[1].payload.cursor, 'synthetic-next')
        assert.deepEqual(page.data.expandedMatchIds, {})
        assert.equal(page.data.cursor, '')
        assert.equal(page.data.hasMore, false)
        assert.equal(page.data.total, 0)
        assert.equal(page.data.page, 1)
        assert.equal(page.data.indexStatus, '')
        assert.equal(page.data.loadMoreText, '')
        await page.onReachBottom()
        await page.loadMore()
        assert.equal(state.calls.length, 2, 'denied continuation cannot auto-resume')
      }
    })
  }
}

for (const failure of ['NETWORK_ERROR', 'uncoded transport failure', 'INTERNAL_ERROR']) {
  for (const name of ['dashboard', 'business-list']) {
    test(`${name} ${failure} retains prior cards and cache/continuation for explicit retry`, async t => {
      const { app } = setup(t)
      const { state, service } = protectedCards(app)
      const page = pageFor(name, service)
      const dashboard = name === 'dashboard'
      if (dashboard) await page.onShow()
      else {
        page.setData({ keyword: '合成' })
        await page.onLoad({})
        page.toggleMatches({ currentTarget: { dataset: { id: state.item._id } } })
      }
      const before = structuredClone(page.data)
      const transport = global.wx.cloud.callFunction
      if (failure === 'INTERNAL_ERROR') {
        // An unmarked internal exception with an auth-like code must be sanitized
        // by the real API boundary, not mistaken for a protected-session denial.
        state.readError = Object.assign(new Error('synthetic private detail'), { code: 'PASSWORD_CHANGE_REQUIRED' })
      } else {
        global.wx.cloud.callFunction = async () => {
          const error = new Error('synthetic private detail')
          if (failure === 'NETWORK_ERROR') error.code = failure
          throw error
        }
      }
      if (dashboard) await page.onShow()
      else await page.loadMore()
      if (failure === 'INTERNAL_ERROR') assert.equal(state.responses.at(-1).code, 'INTERNAL_ERROR')
      assert.equal(page.data.loading, false)
      assert.ok(page.data.errorMessage)
      assert.equal(JSON.stringify(page.data).includes('synthetic private detail'), false)
      if (dashboard) {
        assert.deepEqual(page.data.recent, before.recent)
        assert.deepEqual(page.data.stats, before.stats)
        // Drop only visible rows to distinguish retained module cache from UI state.
        page.setData({ recent: [] })
        const again = page.onShow()
        assert.deepEqual(page.data.recent, before.recent)
        await again
      } else {
        for (const key of ['items', 'expandedMatchIds', 'cursor', 'hasMore', 'total', 'page', 'indexStatus', 'loadMoreText']) {
          assert.deepEqual(page.data[key], before[key], key)
        }
      }
      state.readError = null
      global.wx.cloud.callFunction = transport
      state.item = { ...fixture(), _id: 'synthetic-retry' }
      await page.retryCards()
      assert.equal((dashboard ? page.data.recent : page.data.items)[0]._id, 'synthetic-retry')
    })
  }
}

for (const [code, deny] of protectedDenials) {
  for (const name of ['dashboard', 'business-list']) {
    test(`${name} late actual API ${code} cannot clear a newer generation or account`, async t => {
      const { app } = setup(t)
      const { state, service } = protectedCards(app)
      const page = pageFor(name, service)
      const dashboard = name === 'dashboard'
      if (dashboard) await page.onShow()
      else await page.onLoad({})
      const transport = global.wx.cloud.callFunction
      for (const switchAccount of [false, true]) {
        const captured = deferred(), delivery = deferred()
        global.wx.cloud.callFunction = async input => {
          const response = await transport(input)
          if (!response.result.ok) { captured.resolve(response); return delivery.promise }
          return response
        }
        deny(state)
        const old = dashboard ? page.onShow() : page.loadMore()
        const response = await captured.promise
        assert.equal(response.result.code, code)
        state.credential = { mustChangePassword: false, lockedUntil: null }
        if (switchAccount) {
          app.globalData.currentUser = { _id: 'synthetic-new-actor', status: 'active', role: 'user' }
          state.actor = { ...app.globalData.currentUser }
        }
        state.item = { ...fixture(), _id: switchAccount ? 'synthetic-new-account' : 'synthetic-new-generation' }
        if (dashboard) await page.onShow()
        else await page.search()
        const current = structuredClone(page.data)
        delivery.resolve(response)
        await old
        assert.deepEqual(page.data, current, 'late denial must not mutate accepted newer data')
        if (dashboard) {
          page.setData({ recent: [] })
          const again = page.onShow()
          assert.deepEqual(page.data.recent, current.recent, 'late denial must not clear the newer module cache')
          await again
        }
      }
    })
  }
}

test('presenter prefers code, preserves metadata and ordered string 0/false/Unicode without mutating input', () => {
  const { presentBusinessCard } = require('../utils/business-card')
  const item = fixture(), before = structuredClone(item)
  const card = presentBusinessCard(item)
  assert.equal(card.cardTitle, 'BL-SYNTHETIC-1')
  assert.equal(card.cardState, 'ready')
  assert.deepEqual(card.cardRows.map(row => [row.id, row.label, row.value]), [
    ['zero', '数量', '0'], ['false', '已确认', 'false'], ['long', '说明', '🙂中文'.repeat(26)]
  ])
  for (const key of ['_id', 'matches', 'flowSchemaVersion', 'traversedNodeCount', 'progress', 'currentNodeName']) {
    assert.deepEqual(card[key], item[key])
  }
  assert.deepEqual(item, before)
  assert.equal(presentBusinessCard({ name: '旧售后', code: '  ' }).cardTitle, '旧售后')
})

test('presenter distinguishes empty/missing/unavailable and fails closed on malformed or excessive rows', () => {
  const { presentBusinessCard } = require('../utils/business-card')
  for (const [summary, state] of [
    [undefined, 'none'], [{ state: 'ready', configRevision: 0, fields: [] }, 'ready'],
    [{ state: 'unavailable', fields: fixture().cardSummary.fields }, 'unavailable'],
    [{ state: 'ready', fields: [{ id: 'x', label: '值', value: false }] }, 'unavailable'],
    [{ state: 'ready', fields: Array.from({ length: 5 }, (_, id) => ({ id: String(id), label: '值', value: '示例' })) }, 'unavailable']
  ]) {
    const card = presentBusinessCard({ _id: 'old', cardSummary: summary })
    assert.equal(card.cardState, state)
    assert.deepEqual(card.cardRows, [])
  }
})

for (const entry of ['dashboard', 'active', 'completed', 'all', 'keyword']) {
  test(`${entry} entry presents summary while preserving navigation, progress and search expansion`, async t => {
    const { navigation } = setup(t)
    const item = fixture()
    const page = pageFor(entry === 'dashboard' ? 'dashboard' : 'business-list', {
      dashboard: async () => result(item), listBusinessLines: async () => result(item)
    })
    if (entry === 'dashboard') await page.onShow()
    else {
      if (entry === 'keyword') page.setData({ keyword: '合成' })
      await page.onLoad(entry === 'active' || entry === 'completed' ? { status: entry, scope: 'mine' } : {})
    }
    let card = (entry === 'dashboard' ? page.data.recent : page.data.items)[0]
    assert.equal(card.cardTitle, item.code)
    assert.equal(card.cardRows[0].value, '0')
    if (entry === 'dashboard') {
      assert.equal(card.showProgressPercent, false)
      assert.equal(card.pathSummary, '已完成 2 个节点 · 当前：示例节点')
    } else {
      page.toggleMatches({ currentTarget: { dataset: { id: item._id } } })
      card = page.data.items[0]
      assert.equal(card.visibleMatches.length, 2)
      assert.equal(card.cardRows[1].value, 'false')
      assert.equal(card.flowSchemaVersion, 2)
    }
    page.openDetail({ currentTarget: { dataset: { id: item._id } } })
    assert.deepEqual(navigation, [{ url: '/pages/business-detail/index?id=line-synthetic' }])
  })
}

test('list loads once at initial onLoad/onShow and revalidates only submitted conditions on return', async t => {
  setup(t)
  const calls = []
  const page = pageFor('business-list', { listBusinessLines: async query => { calls.push(query); return result(fixture()) } })
  const pending = page.onLoad({ status: 'active', scope: 'mine' })
  await page.onShow()
  await pending
  assert.equal(calls.length, 1)
  page.onHide()
  await page.onShow()
  assert.equal(calls.length, 2)
  page.onKeyword({ detail: { value: '尚未提交' } })
  page.onHide()
  await page.onShow()
  await page.retryCards()
  assert.equal(calls.length, 2)
  assert.equal(page.data.keyword, '尚未提交')
  assert.equal(page.data.queryDirty, true)
  assert.deepEqual(page.data.items, [])
})

test('list same-ID local disablement discards an in-flight page and clears already shown field values', async t => {
  const { app } = setup(t)
  const pending = deferred()
  let calls = 0
  const page = pageFor('business-list', { listBusinessLines: () => ++calls === 1 ? result(fixture()) : pending.promise })
  await page.onLoad({})
  const request = page.loadPage(false)
  app.globalData.currentUser.status = 'disabled'
  pending.resolve(result({ ...fixture(), _id: 'stale' }))
  await request
  assert.deepEqual(page.data.items, [])
  assert.equal(page.data.loading, false)
  await page.onShow()
  assert.equal(calls, 2)
})

for (const name of ['dashboard', 'business-list']) {
  for (const code of ['FORBIDDEN', 'ACCOUNT_DISABLED', 'ACCOUNT_LOCKED', 'UNAUTHORIZED']) {
    test(`${name} server ${code} clears visible/cache data despite locally active profile`, async t => {
      setup(t)
      let fail = false
      const read = async () => { if (fail) throw Object.assign(new Error('synthetic private server detail'), { code }); return result(fixture()) }
      const page = pageFor(name, { dashboard: read, listBusinessLines: read })
      if (name === 'dashboard') await page.onShow()
      else await page.onLoad({})
      fail = true
      if (name === 'dashboard') await page.onShow()
      else await page.loadPage(false)
      assert.deepEqual(name === 'dashboard' ? page.data.recent : page.data.items, [])
      if (name === 'dashboard') {
        const again = page.onShow()
        assert.deepEqual(page.data.recent, [])
        await again
      }
      assert.equal(JSON.stringify(page.data).includes('private server detail'), false)
    })
  }
}

test('dashboard account/demotion change clears cached rows before a pending refresh and ignores older errors', async t => {
  const { app } = setup(t)
  let pending
  const page = pageFor('dashboard', { dashboard: () => pending ? pending.promise : result(fixture()) })
  await page.onShow()
  pending = deferred()
  app.globalData.currentUser.role = 'user'
  const demoted = page.onShow()
  assert.deepEqual(page.data.recent, [])
  pending.resolve(result({ ...fixture(), cardSummary: { state: 'ready', configRevision: 3, fields: [] } }))
  await demoted
  const old = pending = deferred()
  const oldRequest = page.onShow()
  app.globalData.currentUser = { _id: 'actor-b', role: 'user', status: 'active' }
  pending = deferred()
  const fresh = page.onShow()
  assert.deepEqual(page.data.recent, [])
  pending.resolve(result({ ...fixture(), _id: 'new-account' }))
  await fresh
  old.reject(Object.assign(new Error('revoked'), { code: 'FORBIDDEN' }))
  await oldRequest
  assert.equal(page.data.recent[0]._id, 'new-account')
})

test('unavailable summaries keep fixed cards and explicit retries reload without navigation', async t => {
  const { navigation } = setup(t)
  for (const name of ['dashboard', 'business-list']) {
    let count = 0
    const read = async () => { count++; return result({ ...fixture(), cardSummary: { state: 'unavailable', fields: [] } }) }
    const page = pageFor(name, { dashboard: read, listBusinessLines: read })
    if (name === 'dashboard') await page.onShow()
    else await page.onLoad({})
    assert.equal((name === 'dashboard' ? page.data.recent : page.data.items)[0].cardState, 'unavailable')
    await page.retryCards()
    assert.equal(count, 2)
  }
  assert.deepEqual(navigation, [])
})

test('dashboard manual refresh safely finishes after logout and demotion retry clears previous role cache', async t => {
  const { app } = setup(t)
  const pending = deferred()
  let wait = false, stopped = 0
  global.wx.stopPullDownRefresh = () => stopped++
  const page = pageFor('dashboard', { dashboard: () => wait ? pending.promise : result(fixture()) })
  await page.onShow()
  app.globalData.currentUser.role = 'user'
  wait = true
  const retry = page.retryCards()
  assert.deepEqual(page.data.recent, [])
  pending.resolve(result(fixture()))
  await retry
  app.globalData.currentUser = null
  await page.onPullDownRefresh()
  assert.equal(stopped, 1)
  assert.deepEqual(page.data.recent, [])
})

test('list role transition rejects old response but active member can refresh with server-authorized rows', async t => {
  const { app } = setup(t)
  const pending = deferred()
  let count = 0
  const page = pageFor('business-list', { listBusinessLines: () => ++count === 2 ? pending.promise : result(fixture()) })
  await page.onLoad({})
  const request = page.loadPage(false)
  app.globalData.currentUser.role = 'user'
  pending.resolve(result({ ...fixture(), _id: 'old-role' }))
  await request
  assert.deepEqual(page.data.items, [])
  await page.onShow()
  assert.equal(count, 3)
  assert.equal(page.data.items[0]._id, 'line-synthetic')
})
