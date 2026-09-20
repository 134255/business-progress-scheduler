const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

function withModule(relative, value, fn) {
  const id = require.resolve(path.join(__dirname, '..', relative))
  const prior = require.cache[id]
  require.cache[id] = { id, filename: id, loaded: true, exports: value }
  try { return fn() } finally {
    if (prior) require.cache[id] = prior
    else delete require.cache[id]
  }
}
function fresh(relative) {
  const id = require.resolve(path.join(__dirname, '..', relative))
  delete require.cache[id]
  return require(id)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function harness(t, { confirm = async () => ({ confirm: true }),
  copy = async () => ({ template: { _id: 'new-copy', status: 'draft' } }),
  list = async () => ({ items: [{ _id: 'source', name: '原模板', version: 8, status: 'enabled' }] }) } = {}) {
  const app = { globalData: { currentUser: { _id: 'admin', role: 'super_admin', status: 'active' } } }
  const calls = [], navigations = [], toasts = [], modals = []
  global.getApp = () => app
  global.wx = {
    reLaunch: args => navigations.push(args),
    navigateTo: args => navigations.push(args),
    showToast: args => toasts.push(args),
    showModal: args => { modals.push(args); return confirm() }
  }
  let page
  global.Page = definition => { page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values) } } }
  withModule('services/templates.js', {
    copyTemplate: async (...args) => { calls.push(args); return copy(...args) },
    listTemplates: list
  }, () => fresh('pages/admin-templates/index.js'))
  delete global.Page
  t.after(() => { delete global.getApp; delete global.wx })
  page.setData({ items: [{ _id: 'source', name: '原模板', version: 7, status: 'enabled' }] })
  return { page, app, calls, navigations, toasts, modals,
    click: () => page.copyTemplate({ currentTarget: { dataset: { id: 'source' } } }) }
}

test('copy service sends only template id and expected version', async () => {
  const calls = []
  const service = withModule('utils/cloud.js', { callBusinessApi: async (...args) => calls.push(args) },
    () => fresh('services/templates.js'))
  await service.copyTemplate('source', 7)
  assert.deepEqual(calls[0].slice(0, 2), ['copyTemplate', { templateId: 'source', expectedVersion: 7 }])
})

test('copy button confirms saved definition then opens independent draft even for enabled source', async t => {
  const h = harness(t)
  await h.click()
  assert.match(h.modals[0].content, /已保存/)
  assert.deepEqual(h.calls, [['source', 7]])
  assert.deepEqual(h.navigations, [{ url: '/pages/admin-template-edit/index?id=new-copy' }])
  assert.equal(h.toasts.length, 1)
  assert.equal(h.page.data.copyingId, '')
  assert.equal(h.page.data.items[0].status, 'enabled')
})

test('copy cancellation leaves source untouched and releases button', async t => {
  const h = harness(t, { confirm: async () => ({ confirm: false }) })
  await h.click()
  assert.equal(h.calls.length, 0)
  assert.equal(h.navigations.length, 0)
  assert.equal(h.page.data.copyingId, '')
})

test('copy double click creates only one request while confirmation or server is pending', async t => {
  const modal = deferred(), server = deferred()
  const h = harness(t, { confirm: () => modal.promise, copy: () => server.promise })
  const first = h.click()
  await h.click()
  assert.equal(h.modals.length, 1)
  modal.resolve({ confirm: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 1)
  await h.click()
  server.resolve({ template: { _id: 'new-copy', status: 'draft' } })
  await first
  assert.equal(h.calls.length, 1)
})

test('copy rejects ordinary accounts before prompting', async t => {
  const h = harness(t)
  h.app.globalData.currentUser.role = 'user'
  await h.click()
  assert.equal(h.calls.length, 0)
  assert.equal(h.modals.length, 0)
})

test('copy rechecks account identity after confirmation even when new account is also admin', async t => {
  const modal = deferred()
  const h = harness(t, { confirm: () => modal.promise })
  const pending = h.click()
  h.app.globalData.currentUser = { _id: 'different-admin', role: 'super_admin', status: 'active' }
  modal.resolve({ confirm: true })
  await pending
  assert.equal(h.calls.length, 0)
  assert.equal(h.navigations.length, 0)
})

for (const reason of ['unload', 'account']) {
  test(`copy ignores late success after ${reason}`, async t => {
    const server = deferred()
    const h = harness(t, { copy: () => server.promise })
    const pending = h.click()
    await new Promise(resolve => setImmediate(resolve))
    if (reason === 'unload') h.page.onUnload()
    else h.app.globalData.currentUser = { _id: 'different-admin', role: 'super_admin', status: 'active' }
    server.resolve({ template: { _id: 'new-copy', status: 'draft' } })
    await pending
    assert.equal(h.toasts.length, 0)
    assert.equal(h.navigations.length, 0)
  })
}

test('copy conflict reloads current version without silently retrying the write', async t => {
  const h = harness(t, { copy: async () => { throw Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT' }) } })
  await h.click()
  assert.equal(h.page.data.items[0].version, 8)
  assert.match(h.page.data.errorMessage, /更新/)
  assert.equal(h.calls.length, 1)
  assert.equal(h.page.data.copyingId, '')
  assert.equal(h.toasts.length, 0)
})

test('copy reports unusable participants and preserves source for correction', async t => {
  const h = harness(t, { copy: async () => { throw Object.assign(new Error('PROCESSOR_INACTIVE'), { code: 'PROCESSOR_INACTIVE' }) } })
  await h.click()
  assert.match(h.page.data.errorMessage, /处理人/)
  assert.equal(h.navigations.length, 0)
  assert.equal(h.page.data.copyingId, '')
})

test('copy transport failure prompts checking list before retry instead of claiming no write occurred', async t => {
  const h = harness(t, { copy: async () => { throw new Error('network lost') } })
  await h.click()
  assert.match(h.page.data.errorMessage, /列表/)
  assert.equal(h.toasts.length, 0)
  assert.equal(h.page.data.copyingId, '')
})

test('navigation failure after a successful copy reports the created draft without another copy request', async t => {
  const h = harness(t)
  global.wx.navigateTo = async () => { throw new Error('navigation failed') }
  await h.click()
  assert.match(h.page.data.errorMessage, /已创建/)
  assert.equal(h.calls.length, 1)
})

test('real cloud wrapper does not toast a late copy failure after the page was unloaded', async t => {
  const server = deferred()
  let service
  const h = harness(t, { copy: (...args) => service.copyTemplate(...args) })
  service = fresh('services/templates.js')
  global.wx.cloud = { callFunction: () => server.promise }
  const pending = h.click()
  await new Promise(resolve => setImmediate(resolve))
  h.page.onUnload()
  server.reject(new Error('network failed after unload'))
  await pending
  assert.equal(h.toasts.length, 0)
})

test('failed conflict refresh does not falsely report refreshed list', async t => {
  const h = harness(t, {
    copy: async () => { throw Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT' }) },
    list: async () => { throw new Error('refresh failed') }
  })
  await h.click()
  assert.equal(h.page.data.items[0].version, 7)
  assert.doesNotMatch(h.page.data.errorMessage, /已刷新/)
  assert.match(h.page.data.errorMessage, /刷新.*失败|未.*刷新|刷新未成功/)
})

test('account switch during list refresh drops stale items but releases loading for a fresh request', async t => {
  const response = deferred()
  const h = harness(t, { list: () => response.promise })
  const pending = h.page.loadTemplates()
  h.app.globalData.currentUser = { _id: 'different-admin', role: 'super_admin', status: 'active' }
  response.resolve({ items: [{ _id: 'old-account-item' }] })
  await pending
  assert.equal(h.page.data.loading, false)
  assert.deepEqual(h.page.data.items, [])
})

test('real cloud wrapper also silences late failures of the conflict refresh', async t => {
  const refresh = deferred()
  let service
  const h = harness(t, {
    copy: (...args) => service.copyTemplate(...args),
    list: (...args) => service.listTemplates(...args)
  })
  service = fresh('services/templates.js')
  global.wx.cloud = { callFunction: ({ data }) => data.action === 'copyTemplate'
    ? Promise.resolve({ result: { ok: false, code: 'VERSION_CONFLICT', message: 'source changed' } })
    : refresh.promise }
  const pending = h.click()
  await new Promise(resolve => setImmediate(resolve))
  h.page.onUnload()
  refresh.reject(new Error('late refresh failed'))
  await pending
  assert.equal(h.toasts.length, 0)
})
