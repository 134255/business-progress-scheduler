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
  const pagePath = path.join(miniProgramRoot, 'pages/pending-processing/index.js')
  let definition
  global.Page = value => { definition = value }
  try {
    withFakeModule('services/business.js', businessFake, () => require(pagePath))
  } finally {
    delete global.Page
    delete require.cache[require.resolve(pagePath)]
  }
  assert.ok(definition)
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(update) { Object.assign(this.data, update) }
  }
}

test('待我处理页面分页去重、展示截止时间并仅导航服务端返回的节点', async () => {
  global.getApp = () => ({ globalData: { currentUser: { _id: 'user-1', status: 'active' } } })
  const navigations = []
  global.wx = {
    reLaunch: () => assert.fail('活动账号不应跳转登录'),
    navigateTo: options => navigations.push(options)
  }
  const calls = []
  const page = loadPage({
    async listMyPendingProcessing(query) {
      calls.push(query)
      if (!query.cursor) return {
        items: [{
          nodeId: 'node-1', businessLineId: 'line-1', businessCode: 'BL-1', businessName: '业务一',
          nodeCode: 'BL-1-N001', nodeName: '资料处理', status: 'ready', processingRoundNumber: 1,
          processingDueAt: '2026-08-18T02:00:00.000Z', processingOverdueWorkMinutes: 0
        }],
        cursor: 'cursor-1', hasMore: true
      }
      return {
        items: [
          { nodeId: 'node-1', businessLineId: 'line-1', businessName: '重复项' },
          { nodeId: 'node-2', businessLineId: 'line-2', businessName: '业务二', nodeName: '复核', status: 'blocked', actionKind: 'process_node' },
          { nodeId: 'node-3', businessLineId: 'line-3', businessName: '业务三', nodeName: '追加回访', status: 'awaiting_decision', actionKind: 'optional_tail_decision' },
          { nodeId: 'node-4', businessLineId: 'line-4', businessName: '业务四', nodeName: '分支决定', status: 'awaiting_decision', actionKind: 'node_route_decision' }
        ],
        cursor: 'cursor-2', hasMore: false
      }
    }
  })

  await page.onShow()
  await page.loadMore()
  page.openItem({ currentTarget: { dataset: { lineId: 'line-2', nodeId: 'node-2' } } })
  page.openItem({ currentTarget: { dataset: { lineId: 'line-3', nodeId: 'node-3' } } })
  page.openItem({ currentTarget: { dataset: { lineId: 'line-4', nodeId: 'node-4' } } })
  page.openItem({ currentTarget: { dataset: { lineId: 'forged', nodeId: 'forged' } } })

  assert.deepEqual(calls, [{ cursor: '', pageSize: 20 }, { cursor: 'cursor-1', pageSize: 20 }])
  assert.deepEqual(page.data.items.map(item => item.nodeId), ['node-1', 'node-2', 'node-3', 'node-4'])
  assert.equal(page.data.items[2].actionText, '决定是否开启追加节点 →')
  assert.equal(page.data.items[3].actionText, '决定后续节点走向 →')
  assert.match(page.data.items[0].dueText, /处理截止/)
  assert.deepEqual(navigations, [
    { url: '/pages/node-feedback/index?lineId=line-2&nodeId=node-2' },
    { url: '/pages/business-detail/index?id=line-3' },
    { url: '/pages/business-detail/index?id=line-4' }
  ])
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/pending-processing/index.wxml'), 'utf8')
  assert.match(wxml, /待我处理/)
  assert.match(wxml, /加载更多/)
})
