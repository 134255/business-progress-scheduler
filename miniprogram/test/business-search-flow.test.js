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
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1' } } })
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
  global.getApp = () => ({ globalData: { currentUser: { _id: actorId } } })
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
  assert.match(wxml, /可检索售后、节点、字段和凭证名称/)
  assert.match(wxml, /search-match/)
  assert.match(wxml, /match\.excerpt/)
})
