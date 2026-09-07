const test = require('node:test')
const assert = require('node:assert/strict')

function loadEditor() {
  const calls = []
  const servicePath = require.resolve('../services/templates')
  const saved = require.cache[servicePath]
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    createTemplate: async definition => { calls.push(definition) }
  } }
  let page
  global.Page = value => { page = value }
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { showToast() {}, navigateBack() {}, reLaunch() {} }
  const pagePath = require.resolve('../pages/admin-template-edit/index')
  delete require.cache[pagePath]
  try { require(pagePath) } finally {
    if (saved) require.cache[servicePath] = saved
    else delete require.cache[servicePath]
    delete global.Page
  }
  return { calls, page: { ...page, data: JSON.parse(JSON.stringify(page.data)), setData(update) { Object.assign(this.data, update) } } }
}

function setup() {
  const fixture = loadEditor()
  fixture.page.setData({ name: '测试模板', entryNodeKey: 'n1', nodes: [{
    nodeKey: 'n1', _uiKey: 'node-ui-1', name: '信息收集', workflowMode: 'review',
    processorUserIds: ['processor'], reviewerUserIds: [], next: { mode: 'end' },
    fields: [
      { fieldKey: 'model', name: '型号', type: 'single_select', required: true, constraints: { options: ['A', 'B'] } },
      { fieldKey: 'color', name: '颜色', type: 'single_select', required: false, constraints: { options: ['黑', '白'] },
        condition: { parentFieldKey: 'model', visibleWhen: ['A', 'B'], optionsByParentValue: { A: ['黑'], B: ['白'] } } },
      { fieldKey: 'date', name: '购买日期', type: 'date', required: true, constraints: {} }
    ]
  }] })
  return fixture
}

test('template save identifies both colliding field names without changing the draft or sending a request', async () => {
  const { page, calls } = setup()
  page.data.nodes[0].fields[2].fieldKey = 'model'
  const original = JSON.stringify(page.data.nodes)
  await page.submit()
  assert.equal(calls.length, 0)
  assert.match(page.data.errorMessage, /信息收集/)
  assert.match(page.data.errorMessage, /型号/)
  assert.match(page.data.errorMessage, /购买日期/)
  assert.match(page.data.errorMessage, /编号.*重复/)
  assert.equal(JSON.stringify(page.data.nodes), original)
})

test('template save locates an obsolete hidden parent option before the cloud call', async () => {
  const { page, calls } = setup()
  const condition = page.data.nodes[0].fields[1].condition
  condition.visibleWhen.push('旧型号')
  condition.optionsByParentValue['旧型号'] = []
  await page.submit()
  assert.equal(calls.length, 0)
  assert.match(page.data.errorMessage, /信息收集.*颜色.*旧型号/)
  assert.match(page.data.errorMessage, /失效|不存在/)
})

test('template save locates an empty mapping for a still selected parent option', async () => {
  const { page, calls } = setup()
  page.data.nodes[0].fields[1].condition.optionsByParentValue.B = []
  await page.submit()
  assert.equal(calls.length, 0)
  assert.match(page.data.errorMessage, /颜色.*B/)
  assert.match(page.data.errorMessage, /候选.*空|候选.*至少/)
})

test('template save locates an unknown child option and preserves the configuration', async () => {
  const { page, calls } = setup()
  page.data.nodes[0].fields[1].condition.optionsByParentValue.A = ['红']
  const original = JSON.stringify(page.data.nodes)
  await page.submit()
  assert.equal(calls.length, 0)
  assert.match(page.data.errorMessage, /颜色.*A.*红/)
  assert.equal(JSON.stringify(page.data.nodes), original)
})

test('template save rejects missing and nonpreceding conditional parents with a field location', async () => {
  for (const parentKey of ['missing', 'date']) {
    const { page, calls } = setup()
    page.data.nodes[0].fields[1].condition.parentFieldKey = parentKey
    await page.submit()
    assert.equal(calls.length, 0)
    assert.match(page.data.errorMessage, /颜色.*前置.*单选/)
  }
})

test('valid conditional definition and node-local repeated keys across different nodes remain saveable', async () => {
  const { page, calls } = setup()
  const second = JSON.parse(JSON.stringify(page.data.nodes[0]))
  second.nodeKey = 'n2'
  second._uiKey = 'node-ui-2'
  second.name = '复核'
  page.data.nodes[0].next = { mode: 'default', targetNodeKey: 'n2' }
  page.data.nodes.push(second)
  await page.submit()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].nodes.length, 2)
  assert.deepEqual(calls[0].nodes[0].fields[1].condition.optionsByParentValue, { A: ['黑'], B: ['白'] })
  assert.equal(page.data.errorMessage, '')
})

test('template save rejects duplicate node identifiers without silently rewriting routes', async () => {
  const { page, calls } = setup()
  const second = JSON.parse(JSON.stringify(page.data.nodes[0]))
  second.name = '复核'
  page.data.nodes.push(second)
  await page.submit()
  assert.equal(calls.length, 0)
  assert.match(page.data.errorMessage, /信息收集.*复核.*编号.*重复/)
  assert.equal(page.data.nodes[1].nodeKey, 'n1')
})

test('node editor context includes occupied UI identifiers and fallback generation avoids them', () => {
  const { page } = setup()
  assert.equal(page.getNodeEditorContext(-1).nodeOptions[0]._uiKey, 'node-ui-1')
  const extra = { name: '复核', workflowMode: 'review', processorUserIds: ['processor'], reviewerUserIds: [], fields: [] }
  page.acceptNodeFromEditor(-1, extra)
  assert.notEqual(page.data.nodes[1].nodeKey, 'node-ui-1')
  assert.equal(new Set(page.data.nodes.map(node => node._uiKey)).size, 2)
})
