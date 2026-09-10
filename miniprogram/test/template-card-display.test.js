const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const event = dataset => ({ currentTarget: { dataset } })
const pick = value => ({ detail: { value: String(value) } })
const ref = index => ({ nodeKey: 'node-saved', fieldKey: `field-${index}` })
const definition = (status = 'enabled') => ({ template: { _id: 'template-synthetic', name: '示例模板', status, version: 7 }, nodes: [
  { nodeKey: 'node-saved', name: '示例节点', workflowMode: 'review', processorUserIds: ['processor'], reviewerUserIds: [], fields:
    Array.from({ length: 5 }, (_, index) => ({ fieldKey: `field-${index}`, name: `示例字段${index}`, type: 'short_text', constraints: {} })) }
] })
function withModule(file, value, run) {
  const resolved = require.resolve(path.join(root, file)), previous = require.cache[resolved]
  require.cache[resolved] = { exports: value }
  try { return run() } finally { if (previous) require.cache[resolved] = previous; else delete require.cache[resolved] }
}
function setup(t, overrides = {}) {
  const app = { globalData: { currentUser: { _id: 'admin-synthetic', role: 'super_admin', status: 'active' } } }
  const previous = { wx: global.wx, getApp: global.getApp }
  const calls = []
  global.getApp = () => app
  global.wx = { setNavigationBarTitle() {}, reLaunch() {}, showToast: value => calls.push(['toast', value]), navigateBack: () => calls.push(['back']) }
  t.after(() => Object.assign(global, previous))
  const service = {
    getTemplate: async () => definition(),
    getTemplateCardDisplay: async id => { calls.push(['get', id]); return { templateId: id, revision: 2, fields: [] } },
    updateTemplateCardDisplay: async (id, revision, fields) => { calls.push(['save', id, revision, fields]); return { templateId: id, revision: revision + 1, fields } },
    updateTemplate: async () => assert.fail('display editor cannot submit flow draft'),
    changeTemplateStatus: async () => assert.fail('display editor cannot disable template'), ...overrides
  }
  let pageDefinition
  global.Page = value => { pageDefinition = value }
  const file = require.resolve(path.join(root, 'pages/admin-template-edit/index.js'))
  delete require.cache[file]
  try { withModule('services/templates.js', service, () => withModule('services/admin-users.js', { listUsers: async () => ({ items: [], hasMore: false }) }, () => require(file))) }
  finally { delete global.Page; delete require.cache[file] }
  const page = { ...pageDefinition, data: structuredClone(pageDefinition.data), setData(value) { Object.assign(this.data, value) } }
  return { page, app, calls }
}
function choose(page, index) { page.onCardNodeChange(pick(0)); page.onCardFieldChange(pick(index)); page.addCardField() }

test('config service uses independent actions with exact stable references and expectedRevision', async () => {
  const calls = [], file = require.resolve(path.join(root, 'services/templates.js'))
  delete require.cache[file]
  const service = withModule('utils/cloud.js', { callBusinessApi: async (...args) => { calls.push(args); return {} } }, () => require(file))
  assert.equal(typeof service.getTemplateCardDisplay, 'function')
  await service.getTemplateCardDisplay('template-synthetic')
  await service.updateTemplateCardDisplay('template-synthetic', 2, [ref(0)])
  assert.deepEqual(calls, [
    ['getTemplateCardDisplay', { templateId: 'template-synthetic' }],
    ['updateTemplateCardDisplay', { templateId: 'template-synthetic', expectedRevision: 2, fields: [ref(0)] }]
  ])
})

test('enabled definition stays readonly while independent display chooses/sorts/removes/clears up to four', async t => {
  const { page, calls } = setup(t)
  await page.onLoad({ id: 'template-synthetic' })
  assert.equal(page.data.readOnly, true)
  assert.equal(page.data.cardRevision, 2)
  const before = structuredClone(page.data.nodes)
  for (let index = 0; index < 5; index++) choose(page, index)
  assert.equal(page.data.cardFields.length, 4)
  const ids = page.data.cardFields.map(row => row.id)
  choose(page, 0)
  assert.equal(page.data.cardFields.length, 4)
  page.moveCardField(event({ id: ids[3], direction: -1 }))
  assert.deepEqual(page.data.cardFields.map(row => row.fieldKey), ['field-0', 'field-1', 'field-3', 'field-2'])
  page.removeCardField(event({ id: ids[1] }))
  await page.saveCardDisplay()
  assert.deepEqual(calls.find(call => call[0] === 'save'), ['save', 'template-synthetic', 2, [ref(0), ref(3), ref(2)]])
  assert.equal(page.data.cardRevision, 3)
  assert.equal(page.data.cardPreview.cardSummary.configRevision, 3)
  assert.equal(page.data.version, 7)
  assert.deepEqual(page.data.nodes, before)
  assert.equal(page.data.cardPreview.cardTitle, 'BL-DEMO-0001')
  assert.equal(page.data.cardPreview.cardRows[0].value, '示例内容')
  page.clearCardFields()
  await page.saveCardDisplay()
  assert.deepEqual(calls.filter(call => call[0] === 'save')[1], ['save', 'template-synthetic', 3, []])
  assert.equal(calls.some(call => call[0] === 'back'), false)
})

test('config reload reads saved choices without replacing unsaved name/node/field flow draft', async t => {
  const { page } = setup(t, { getTemplate: async () => definition('disabled') })
  await page.onLoad({ id: 'template-synthetic' })
  page.onNameInput({ detail: { value: '未保存流程名' } })
  page.acceptNodeFromEditor(0, { ...page.data.nodes[0], name: '未保存节点名', fields: [...page.data.nodes[0].fields, { fieldKey: 'unsaved', name: '未保存字段', type: 'short_text' }] })
  const draft = structuredClone(page.data.nodes)
  await page.loadCardDisplay()
  assert.equal(page.data.name, '未保存流程名')
  assert.deepEqual(page.data.nodes, draft)
  assert.equal(page.data.cardNodeOptions[0].name, '示例节点')
  assert.equal(page.data.cardFieldOptions.some(field => field.fieldKey === 'unsaved'), false)
  choose(page, 5)
  assert.deepEqual(page.data.cardFields, [])
})

test('new templates do not read/save a display configuration or implicitly persist a definition', async t => {
  const { page, calls } = setup(t)
  await page.onLoad({})
  assert.equal(typeof page.saveCardDisplay, 'function')
  await page.loadCardDisplay()
  await page.saveCardDisplay()
  assert.equal(calls.length, 0)
  assert.deepEqual(page.data.cardFields, [])
})

test('config conflict reloads only configuration/saved choices and preserves useful error plus flow draft', async t => {
  let reads = 0
  const { page } = setup(t, {
    getTemplate: async () => definition('disabled'),
    getTemplateCardDisplay: async () => ({ templateId: 'template-synthetic', revision: ++reads, fields: reads === 1 ? [] : [ref(3)] }),
    updateTemplateCardDisplay: async () => { throw Object.assign(new Error('synthetic private detail'), { code: 'VERSION_CONFLICT' }) }
  })
  await page.onLoad({ id: 'template-synthetic' })
  page.onNameInput({ detail: { value: '保留草稿' } })
  choose(page, 0)
  await page.saveCardDisplay()
  assert.equal(page.data.cardRevision, 2)
  assert.deepEqual(page.data.cardFields.map(row => row.fieldKey), ['field-3'])
  assert.equal(page.data.name, '保留草稿')
  assert.equal(page.data.version, 7)
  assert.match(page.data.cardError, /其他管理员/)
  assert.equal(page.data.cardSubmitting, false)
})

for (const operation of ['load', 'save']) {
  for (const change of ['demote', 'switch', 'disable', 'unload']) {
    test(`config ${operation} rejects stale completion after ${change}`, async t => {
      const pending = deferred()
      let wait = false
      const { page, app, calls } = setup(t, {
        getTemplateCardDisplay: async () => wait ? pending.promise : { templateId: 'template-synthetic', revision: 2, fields: [ref(0)] },
        updateTemplateCardDisplay: () => pending.promise
      })
      await page.onLoad({ id: 'template-synthetic' })
      assert.equal(typeof page.loadCardDisplay, 'function')
      wait = true
      const request = operation === 'load' ? page.loadCardDisplay() : page.saveCardDisplay()
      if (change === 'demote') app.globalData.currentUser.role = 'user'
      if (change === 'switch') app.globalData.currentUser._id = 'admin-other'
      if (change === 'disable') app.globalData.currentUser.status = 'disabled'
      if (change === 'unload') page.onUnload()
      pending.resolve({ templateId: 'template-synthetic', revision: 9, fields: [ref(1)] })
      await request
      assert.notEqual(page.data.cardRevision, 9)
      assert.deepEqual(page.data.cardFields, [])
      assert.equal(calls.some(call => call[0] === 'toast'), false)
    })
  }
}

test('overlapping config reloads discard the older generation', async t => {
  const first = deferred(), second = deferred()
  let count = 0
  const { page } = setup(t, { getTemplateCardDisplay: () => ++count === 1
    ? { templateId: 'template-synthetic', revision: 0, fields: [] } : count === 2 ? first.promise : second.promise })
  await page.onLoad({ id: 'template-synthetic' })
  const old = page.loadCardDisplay(), fresh = page.loadCardDisplay()
  second.resolve({ templateId: 'template-synthetic', revision: 4, fields: [ref(4)] })
  await fresh
  first.resolve({ templateId: 'template-synthetic', revision: 3, fields: [ref(0)] })
  await old
  assert.equal(page.data.cardRevision, 4)
  assert.deepEqual(page.data.cardFields.map(row => row.fieldKey), ['field-4'])
})

test('CARD_DISPLAY_INVALID is useful/safe, keeps selected draft and does not reload flow', async t => {
  const { page } = setup(t, { updateTemplateCardDisplay: async () => { throw Object.assign(new Error('synthetic private detail'), { code: 'CARD_DISPLAY_INVALID' }) } })
  await page.onLoad({ id: 'template-synthetic' })
  choose(page, 0)
  await page.saveCardDisplay()
  assert.match(page.data.cardError, /展示.*字段|展示.*配置/)
  assert.equal(page.data.cardError.includes('private'), false)
  assert.equal(page.data.cardFields.length, 1)
  assert.equal(page.data.cardRevision, 2)
})

for (const operation of ['load', 'save']) {
  test(`config server permission failure during ${operation} clears all config data without touching flow draft`, async t => {
    let fail = false
    const denied = () => { throw Object.assign(new Error('synthetic private'), { code: 'FORBIDDEN' }) }
    const { page } = setup(t, {
      getTemplate: async () => definition('disabled'),
      getTemplateCardDisplay: async () => fail ? denied() : { templateId: 'template-synthetic', revision: 2, fields: [ref(0)] },
      updateTemplateCardDisplay: denied
    })
    await page.onLoad({ id: 'template-synthetic' })
    page.onNameInput({ detail: { value: '保留流程草稿' } })
    fail = true
    if (operation === 'load') await page.loadCardDisplay()
    else await page.saveCardDisplay()
    assert.deepEqual(page.data.cardFields, [])
    assert.deepEqual(page.data.cardNodeOptions, [])
    assert.equal(page.data.cardPreview, null)
    assert.equal(page.data.cardLoaded, false)
    assert.equal(page.data.name, '保留流程草稿')
    assert.match(page.data.cardError, /无权/)
  })
}

test('CARD_DISPLAY_INVALID on normal definition save explains selected-ref removal without losing draft', async t => {
  const { page } = setup(t, {
    getTemplate: async () => definition('disabled'),
    updateTemplate: async () => { throw Object.assign(new Error('synthetic private'), { code: 'CARD_DISPLAY_INVALID' }) }
  })
  await page.onLoad({ id: 'template-synthetic' })
  const before = structuredClone(page.data.nodes)
  await page.submit()
  assert.match(page.data.errorMessage, /先调整售后卡片展示配置/)
  assert.deepEqual(page.data.nodes, before)
})
