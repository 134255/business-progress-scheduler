const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function withFakeModule(relativePath, exports, callback) {
  const modulePath = path.join(root, relativePath)
  const resolved = require.resolve(modulePath)
  const original = require.cache[resolved]
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
  try { return callback() } finally {
    if (original) require.cache[resolved] = original
    else delete require.cache[resolved]
  }
}

function loadPage(service) {
  const pagePath = path.join(root, 'pages/business-list/index.js')
  let definition
  global.Page = value => { definition = value }
  try { withFakeModule('services/business.js', service, () => require(pagePath)) } finally {
    delete global.Page
    delete require.cache[require.resolve(pagePath)]
  }
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(update) { Object.assign(this.data, update) }
  }
}

function loadBusinessService(cloud) {
  const servicePath = path.join(root, 'services/business.js')
  delete require.cache[require.resolve(servicePath)]
  return withFakeModule('utils/cloud.js', cloud, () => require(servicePath))
}

test('检索服务将索引状态和非法查询映射为固定中文提示', async () => {
  const cases = [
    ['BUSINESS_SEARCH_PENDING', '售后检索正在更新，请稍后重试'],
    ['BUSINESS_SEARCH_UNAVAILABLE', '售后检索暂时不可用，请稍后重试'],
    ['INVALID_SEARCH_QUERY', '请调整检索内容后重试']
  ]
  for (const [code, message] of cases) {
    const calls = []
    const service = loadBusinessService({ async callBusinessApi(action, payload, options) {
      calls.push({ action, payload, options })
      const error = new Error('cloud://private errCode=-1')
      error.code = code
      throw error
    } })
    await assert.rejects(service.listBusinessLines({ keyword: '客户' }), error =>
      error.code === code && error.message === message)
    assert.deepEqual(calls[0], {
      action: 'listBusinessLines',
      payload: { keyword: '客户' },
      options: { silent: true }
    })
  }
})

test('关键词检索显示安全命中摘要、展开内容并使用游标续页', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {}, navigateTo() {} }
  const calls = []
  const page = loadPage({ async listBusinessLines(query) {
    calls.push(query)
    if (!query.cursor) return {
      items: [{
        _id: 'line-1', code: 'BL-1', name: '售后甲', status: 'active', currentNodeName: '资料收集',
        matches: [
          { nodeName: '资料收集', label: '客户名称', excerpt: '客户甲' },
          { nodeName: '资料审核', label: '处理说明', excerpt: '合同待确认' },
          { nodeName: '归档', label: '凭证名称', excerpt: '合同.pdf' }
        ],
        fileId: 'cloud://private', tokenHashes: ['secret']
      }], cursor: 'cursor-1', hasMore: true, total: null
    }
    return { items: [{ _id: 'line-2', code: 'BL-2', name: '售后乙', status: 'completed', matches: [] }], cursor: '', hasMore: false, total: null }
  } })
  page._visible = true
  page.setData({ keyword: ' 客户甲 合同 ' })

  await page.search()
  assert.equal(page.data.items[0].matches.length, 3)
  assert.equal(page.data.items[0].visibleMatches.length, 1)
  assert.equal(page.data.items[0].matches[0].label, '客户名称')
  assert.equal(JSON.stringify(page.data).includes('cloud://'), false)
  page.toggleMatches({ currentTarget: { dataset: { id: 'line-1' } } })
  assert.equal(page.data.items[0].visibleMatches.length, 3)
  await page.loadPage(false)
  assert.deepEqual(page.data.items.map(item => item._id), ['line-1', 'line-2'])
  assert.deepEqual(calls, [
    { keyword: '客户甲 合同', startDate: '', endDate: '', pageSize: 20, cursor: '' },
    { keyword: '客户甲 合同', startDate: '', endDate: '', pageSize: 20, cursor: 'cursor-1' }
  ])
})

test('清空关键词恢复页码模式且隐藏或账号切换后丢弃旧响应', async () => {
  let resolveFirst
  let actorId = 'user-1'
  global.getApp = () => ({ globalData: { currentUser: { _id: actorId, status: 'active' } } })
  global.wx = { showToast() {}, navigateTo() {} }
  const calls = []
  const page = loadPage({ async listBusinessLines(query) {
    calls.push(query)
    if (calls.length === 1) return new Promise(resolve => { resolveFirst = resolve })
    return { items: [{ _id: 'fresh', name: '新结果', matches: [] }], page: 1, total: 1, hasMore: false }
  } })
  page._visible = true
  page.setData({ keyword: '旧关键词' })
  const stale = page.search()
  page.onHide()
  actorId = 'user-2'
  page._visible = true
  page.setData({ keyword: '' })
  await page.search()
  resolveFirst({ items: [{ _id: 'stale', name: '旧结果' }], cursor: '', hasMore: false })
  await stale

  assert.deepEqual(page.data.items.map(item => item._id), ['fresh'])
  assert.deepEqual(calls[1], { keyword: '', startDate: '', endDate: '', page: 1, pageSize: 20 })
})

test('页面文案说明可检索节点字段与凭证且包含安全摘要结构', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/business-list/index.wxml'), 'utf8')
  assert.match(wxml, /编号任意字符/)
  assert.match(wxml, /节点名称/)
  assert.match(wxml, /字段名称和内容/)
  assert.match(wxml, /部分匹配/)
  assert.match(wxml, /凭证名称/)
  assert.match(wxml, /search-match/)
  assert.match(wxml, /match\.excerpt/)
})

const nextTurn = () => new Promise(resolve => setImmediate(resolve))

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

// Evaluate the actual page's simple WXML visibility/text expressions against
// its live data. This checks message behavior, not native-device rendering.
function listView(page, className) {
  const wxml = fs.readFileSync(path.join(root, 'pages/business-list/index.wxml'), 'utf8')
  const node = wxml.match(new RegExp(`<view class="${className}" wx:if="\\{\\{(.*?)\\}\\}">(.*?)</view>`))
  if (!node) return null
  const vm = require('node:vm')
  if (!vm.runInNewContext(node[1], { ...page.data })) return null
  return node[2].replace(/\{\{(.*?)\}\}/g, (_, expression) => vm.runInNewContext(expression, { ...page.data }))
}

test('recovery awaits each cursor, keeps loading visible, and eventually shows a partial-field hit', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  const final = deferred()
  const calls = []
  const page = loadPage({ async listBusinessLines(query) {
    calls.push({ ...query })
    if (calls.length === 1) return { items: [], cursor: 'recovery:one', hasMore: true, indexStatus: 'recovering' }
    return final.promise
  } })
  page._visible = true
  page.setData({ keyword: '甲', status: 'completed', scope: 'mine', startDate: '2026-09-01' })
  const pending = page.search()
  try {
    await nextTurn()
    assert.equal(calls.length, 2)
    assert.equal(page.data.loading, true)
    assert.equal(page.data.indexStatus, 'recovering')
    assert.equal(listView(page, 'empty'), null)
    assert.equal(listView(page, 'load-more'), '正在更新检索内容…')
    assert.deepEqual(calls.map(query => query.cursor), ['', 'recovery:one'])
    assert.ok(calls.every(query => query.keyword === '甲' && query.status === 'completed' &&
      query.scope === 'mine' && query.startDate === '2026-09-01'))
    final.resolve({ items: [{ _id: 'field-hit', matches: [{ nodeName: '资料收集', label: '客户名称', excerpt: '客户甲公司' }] }],
      cursor: 'ordinary-next', hasMore: true })
    await pending
    assert.equal(page.data.items[0].matches[0].excerpt, '客户甲公司')
    assert.equal(page.data.indexStatus, '')
    assert.equal(page.data.loading, false)
    assert.equal(calls.length, 2, 'ordinary pagination must not be automatically consumed')
  } finally {
    final.resolve({ items: [], cursor: '', hasMore: false })
    await pending
  }
})

test('single code characters and partial node or field text are passed unchanged by the page', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  const queries = []
  const page = loadPage({ async listBusinessLines(query) {
    queries.push(query)
    return { items: [], cursor: '', hasMore: false }
  } })
  page._visible = true
  for (const value of ['B', '-', '0', '收', '客户', '甲']) await page.onSearchConfirm({ detail: { value } })
  assert.deepEqual(queries.map(query => query.keyword), ['B', '-', '0', '收', '客户', '甲'])
})

test('recovery stops after twenty awaited requests and loadMore resumes from the last cursor', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  const queries = []
  let active = 0, peak = 0, finish = false
  const page = loadPage({ async listBusinessLines(query) {
    queries.push({ ...query }); active += 1; peak = Math.max(peak, active)
    await nextTurn()
    active -= 1
    return finish ? { items: [{ _id: 'recovered' }], cursor: '', hasMore: false }
      : { items: [], cursor: `recovery:${queries.length}`, hasMore: true, indexStatus: 'recovering' }
  } })
  page._visible = true
  page.setData({ keyword: '1' })
  await page.search()
  assert.equal(queries.length, 20)
  assert.equal(peak, 1)
  assert.equal(page.data.loading, false)
  assert.equal(page.data.indexStatus, 'recovering')
  assert.equal(page.data.cursor, 'recovery:20')
  assert.equal(page.data.hasMore, true)
  assert.match(listView(page, 'load-more'), /继续/)
  assert.equal(listView(page, 'empty'), null)
  finish = true
  await page.loadMore()
  assert.equal(queries[20].cursor, 'recovery:20')
  assert.equal(page.data.items[0]._id, 'recovered')
})

test('reach-bottom cannot restart paused recovery; only the explicit button resumes while ordinary scrolling still paginates', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  const queries = []
  let recovering = true
  const page = loadPage({ async listBusinessLines(query) {
    queries.push({ ...query })
    if (recovering) return { items: [], cursor: `recovery:${queries.length}`, hasMore: true, indexStatus: 'recovering' }
    return query.cursor === 'ordinary-next'
      ? { items: [{ _id: 'second' }], cursor: '', hasMore: false }
      : { items: [{ _id: 'first' }], cursor: 'ordinary-next', hasMore: true }
  } })
  page._visible = true
  page.setData({ keyword: '1' })
  await page.search()
  assert.equal(queries.length, 20)
  assert.equal(page.data.indexStatus, 'recovering')
  assert.equal(page.data.loading, false)
  await page.onReachBottom()
  await page.onReachBottom()
  assert.equal(queries.length, 20, 'touching the bottom must not silently restart recovery')
  assert.equal(page.data.cursor, 'recovery:20')
  recovering = false
  const wxml = fs.readFileSync(path.join(root, 'pages/business-list/index.wxml'), 'utf8')
  const buttonHandler = wxml.match(/<button[^>]*wx:if="\{\{hasMore\}\}"[^>]*bindtap="([^"]+)"/)[1]
  await page[buttonHandler]()
  assert.equal(queries.length, 21)
  assert.equal(queries[20].cursor, 'recovery:20')
  assert.equal(page.data.indexStatus, '')
  await page.onReachBottom()
  assert.equal(queries.length, 22)
  assert.equal(queries[21].cursor, 'ordinary-next')
  assert.deepEqual(page.data.items.map(item => item._id), ['first', 'second'])
})

test('recovery rejects repeated cursors and cycles rather than automatically looping', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  for (const cursors of [['a', 'a'], ['a', 'b', 'a']]) {
    let calls = 0
    const page = loadPage({ async listBusinessLines() {
      const cursor = cursors[Math.min(calls++, cursors.length - 1)]
      return { items: [], cursor: `recovery:${cursor}`, hasMore: true, indexStatus: 'recovering' }
    } })
    page._visible = true
    page.setData({ keyword: '1' })
    await page.search()
    assert.equal(calls, cursors.length)
    assert.ok(page.data.errorMessage)
    assert.equal(page.data.loading, false)
    assert.equal(listView(page, 'empty'), null)
  }
})

test('incomplete search never claims an empty or complete result and preserves verified earlier pages', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  let response = { items: [], cursor: '', hasMore: false, indexStatus: 'incomplete' }
  const page = loadPage({ async listBusinessLines() { return response } })
  page._visible = true
  page.setData({ keyword: '甲' })
  await page.search()
  assert.equal(page.data.indexStatus, 'incomplete')
  assert.equal(listView(page, 'empty'), null)
  assert.match(listView(page, 'search-index-status'), /结果可能不完整/)
  assert.equal(page.data.loadMoreText.includes('已加载全部'), false)
  response = { items: [{ _id: 'verified' }], cursor: 'next', hasMore: true }
  await page.search()
  response = { items: [], cursor: 'last', hasMore: true, indexStatus: 'incomplete' }
  await page.loadMore()
  response = { items: [{ _id: 'last-hit' }], cursor: '', hasMore: false }
  await page.loadMore()
  assert.deepEqual(page.data.items.map(item => item._id), ['verified', 'last-hit'])
  assert.equal(page.data.indexStatus, 'incomplete', 'a later unmarked page cannot erase known incompleteness')
  assert.equal(page.data.loadMoreText.includes('已加载全部'), false)
})

for (const invalidate of ['keyword', 'date', 'account', 'hide', 'unload', 'new-search']) {
  test(`recovery stops continuation and ignores the old response after ${invalidate}`, async () => {
    let actorId = 'user-1'
    global.getApp = () => ({ globalData: { currentUser: { _id: actorId, status: 'active' } } })
    global.wx = { showToast() {} }
    const waiting = deferred()
    let calls = 0, fresh = false
    const page = loadPage({ async listBusinessLines() {
      calls += 1
      if (fresh) return { items: [{ _id: 'fresh' }], cursor: '', hasMore: false }
      if (calls === 1) return { items: [], cursor: 'recovery:one', hasMore: true, indexStatus: 'recovering' }
      return waiting.promise
    } })
    page._visible = true
    page.setData({ keyword: '旧' })
    const pending = page.search()
    try {
      await nextTurn()
      assert.equal(calls, 2)
      if (invalidate === 'keyword') page.onKeyword({ detail: { value: '新' } })
      if (invalidate === 'date') page.onStartDate({ detail: { value: '2026-09-01' } })
      if (invalidate === 'account') actorId = 'user-2'
      if (invalidate === 'hide') page.onHide()
      if (invalidate === 'unload') page.onUnload()
      if (invalidate === 'new-search') { fresh = true; await page.search() }
      const afterInvalidation = structuredClone(page.data)
      waiting.resolve({ items: [], cursor: 'recovery:two', hasMore: true, indexStatus: 'recovering' })
      await pending
      assert.equal(calls, invalidate === 'new-search' ? 3 : 2)
      if (invalidate === 'account') {
        assert.deepEqual(page.data.items, [], 'account change removes cached customer fields')
        assert.equal(page.data.cursor, '', 'account-bound recovery cursor must be discarded')
        assert.equal(page.data.hasMore, false)
        assert.equal(page.data.loading, false)
        assert.equal(page.data.keyword, afterInvalidation.keyword, 'pending input is preserved')
      } else assert.deepEqual(page.data, afterInvalidation, 'stale response must not write page state')
      if (invalidate !== 'new-search') {
        await page.loadMore()
        assert.equal(calls, 2, 'invalidated page cannot resume an old recovery cursor')
      }
    } finally {
      waiting.resolve({ items: [], cursor: '', hasMore: false })
      await pending
    }
  })
}

test('malformed recovering envelopes are errors, not empty results or endless continuation', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  for (const response of [
    { items: [], cursor: '', hasMore: true, indexStatus: 'recovering' },
    { items: [], cursor: 'recovery:next', hasMore: false, indexStatus: 'recovering' },
    { items: [{ _id: 'invalid' }], cursor: 'recovery:next', hasMore: true, indexStatus: 'recovering' },
    { items: [], cursor: '', hasMore: false, indexStatus: 'unknown' }
  ]) {
    let calls = 0
    const page = loadPage({ async listBusinessLines() { calls += 1; return response } })
    page._visible = true
    page.setData({ keyword: '1' })
    await page.search()
    assert.equal(calls, 1)
    assert.ok(page.data.errorMessage)
    assert.deepEqual(page.data.items, [])
    assert.equal(listView(page, 'empty'), null)
  }
})

test('新检索失败时移除旧完整列表并保留可重试的错误状态', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  let fail = false
  const page = loadPage({ async listBusinessLines() {
    if (fail) throw Object.assign(new Error('internal private failure'), { code: 'BUSINESS_SEARCH_UNAVAILABLE' })
    return { items: [{ _id: 'old-list' }], page: 1, total: 1, hasMore: false }
  } })
  await page.onLoad()
  fail = true
  page.onKeyword({ detail: { value: '新关键词' } })
  await page.search()
  assert.deepEqual(page.data.items, [])
  assert.equal(page.data.loading, false)
  assert.equal(page.data.hasMore, false)
  assert.ok(page.data.errorMessage)
  assert.equal(page.data.errorMessage.includes('private'), false)
  fail = false
  await page.search()
  assert.equal(page.data.errorMessage, '')
  assert.equal(page.data.items.length, 1)
})

test('请求中编辑条件立即丢弃旧列表和游标，旧响应结束后不锁死加载', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  let resolve
  let calls = 0
  const page = loadPage({ listBusinessLines() {
    calls += 1
    return new Promise(done => { resolve = done })
  } })
  const loading = page.onLoad()
  page.setData({ items: [{ _id: 'old' }], hasMore: true, cursor: 'old-cursor' })
  page.onKeyword({ detail: { value: '新值' } })
  assert.equal(page.data.loading, false)
  assert.equal(page.data.queryDirty, true)
  assert.deepEqual(page.data.items, [])
  await page.onReachBottom()
  assert.equal(calls, 1)
  resolve({ items: [{ _id: 'stale' }], total: 1, hasMore: false })
  await loading
  assert.deepEqual(page.data.items, [])
  assert.equal(page.data.loading, false)
})

test('表单检索和键盘确认使用控件最后值，不依赖之前的 input 事件', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  const queries = []
  const page = loadPage({ async listBusinessLines(query) {
    queries.push(query)
    return { items: [], cursor: '', hasMore: false }
  } })
  page._visible = true
  page.setData({ keyword: '旧输入', status: 'active', scope: 'mine' })
  assert.equal(typeof page.onSearchSubmit, 'function')
  assert.equal(typeof page.onSearchConfirm, 'function')
  await page.onSearchSubmit({ detail: { value: { keyword: ' 最后输入 ' } } })
  await page.onSearchConfirm({ detail: { value: '键盘确认' } })
  assert.deepEqual(queries.map(q => q.keyword), ['最后输入', '键盘确认'])
  assert.ok(queries.every(q => q.status === 'active' && q.scope === 'mine'))
})

test('重复失焦值不废弃当前检索，改变日期才使旧响应失效', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  let resolve
  const page = loadPage({ listBusinessLines: () => new Promise(done => { resolve = done }) })
  page._visible = true
  page.onKeyword({ detail: { value: '关键词' } })
  const pending = page.search()
  page.onKeyword({ detail: { value: '关键词' } })
  resolve({ items: [{ _id: 'accepted' }], cursor: '', hasMore: false })
  await pending
  assert.equal(page.data.items[0]._id, 'accepted')
  page.onStartDate({ detail: { value: '2026-09-01' } })
  assert.deepEqual(page.data.items, [])
  assert.equal(page.data.queryDirty, true)
})

test('无效响应不能伪装为无匹配，续页失败保留已验证结果和原游标供重试', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  let response = null
  const queries = []
  const page = loadPage({ async listBusinessLines(query) {
    queries.push(query)
    return response
  } })
  page._visible = true
  page.setData({ keyword: '测试' })
  await page.search()
  assert.ok(page.data.errorMessage)
  response = { items: [{ _id: 'first' }], hasMore: true, cursor: 'next' }
  await page.search()
  response = null
  await page.loadMore()
  assert.deepEqual(page.data.items.map(item => item._id), ['first'])
  assert.equal(page.data.cursor, 'next')
  assert.ok(page.data.errorMessage)
  response = { items: [{ _id: 'second' }], hasMore: false, cursor: '' }
  await page.loadMore()
  assert.equal(queries.at(-1).cursor, 'next')
  assert.deepEqual(page.data.items.map(item => item._id), ['first', 'second'])
  assert.equal(page.data.errorMessage, '')
})

test('检索中切到后台再回来会重查，不将被丢弃的请求显示成无匹配', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  global.wx = { showToast() {} }
  let resolve
  let calls = 0
  const page = loadPage({ async listBusinessLines() {
    calls += 1
    if (calls === 1) return new Promise(done => { resolve = done })
    return { items: [{ _id: 'fresh' }], cursor: '', hasMore: false }
  } })
  page.setData({ keyword: '查询' })
  const old = page.onLoad()
  page.onHide()
  await page.onShow()
  assert.equal(calls, 2)
  assert.deepEqual(page.data.items.map(item => item._id), ['fresh'])
  resolve({ items: [{ _id: 'stale' }], cursor: '', hasMore: false })
  await old
  assert.deepEqual(page.data.items.map(item => item._id), ['fresh'])
  page.onHide()
  await page.onShow()
  assert.equal(calls, 3, '已完成检索的普通返回重新校验展示配置')
})
