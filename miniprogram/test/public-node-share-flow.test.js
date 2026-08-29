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

function loadPage(businessFake) {
  const pagePath = path.join(root, 'pages/public-node-share/index.js')
  let definition
  global.Page = value => { definition = value }
  try { withFakeModule('services/business.js', businessFake, () => require(pagePath)) } finally {
    delete global.Page
    delete require.cache[require.resolve(pagePath)]
  }
  return { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } }
}

test('公开只读页无需登录即可读取固定快照、分页凭证并使用原生分享', async () => {
  const calls = []
  global.wx = {
    showToast: value => calls.push(['toast', value.title]),
    downloadFile: options => { calls.push(['download', options.url]); options.success({ tempFilePath: '/tmp/a.pdf' }) },
    openDocument: options => calls.push(['open', options.filePath])
  }
  global.getApp = () => assert.fail('公开页面不得读取登录账号')
  const page = loadPage({
    async getPublicNodeShare(query) {
      calls.push(['get', query])
      return query.cursor
        ? { evidences: [{ fileName: '第二份.pdf', category: 'pdf', url: 'https://temp/2' }], hasMore: false, nextCursor: '' }
        : {
            businessName: '固定业务', nodeName: '资料处理', processingComment: '已完成',
            fieldDefinitions: [{ fieldKey: 'summary', name: '摘要' }], fieldValues: { summary: '固定结果' },
            evidences: [{ fileName: '第一份.jpg', category: 'image', url: 'https://temp/1' }],
            hasMore: true, nextCursor: '1', expiresAt: '2026-08-24T10:00:00.000Z'
          }
    }
  })
  await page.onLoad({ token: 'token-safe' })
  assert.equal(page.data.businessName, '固定业务')
  assert.equal(page.data.fields[0].value, '固定结果')
  assert.equal(page.data.evidences.length, 1)
  await page.loadMore()
  assert.equal(page.data.evidences.length, 2)
  await page.openEvidence({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(calls.some(call => call[0] === 'download'), true)
  assert.match(page.onShareAppMessage().path, /token-safe/)
  assert.throws(() => global.getApp(), /公开页面不得读取登录账号/)

  const wxml = fs.readFileSync(path.join(root, 'pages/public-node-share/index.wxml'), 'utf8')
  assert.match(wxml, /公开只读快照/)
  assert.match(wxml, /open-type="share"/)

  const pageConfig = JSON.parse(fs.readFileSync(path.join(root, 'pages/public-node-share/index.json'), 'utf8'))
  assert.equal(Object.hasOwn(pageConfig, 'enableShareAppMessage'), false)
})
