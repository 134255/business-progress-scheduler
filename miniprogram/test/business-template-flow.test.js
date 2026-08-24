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
  try {
    return callback()
  } finally {
    if (original) require.cache[resolved] = original
    else delete require.cache[resolved]
  }
}

function freshRequire(relativePath) {
  const modulePath = path.join(miniProgramRoot, relativePath)
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

function setByPath(target, key, value) {
  const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.')
  let owner = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]
    if (owner[segment] === undefined) owner[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {}
    owner = owner[segment]
  }
  owner[segments.at(-1)] = value
}

function loadPage(relativePath, fakes = {}) {
  let definition
  global.Page = value => { definition = value }
  const entries = Object.entries(fakes)
  function loadAt(index) {
    if (index === entries.length) return freshRequire(relativePath)
    const [modulePath, fake] = entries[index]
    return withFakeModule(modulePath, fake, () => loadAt(index + 1))
  }
  try { loadAt(0) } finally { delete global.Page }
  assert.ok(definition, `${relativePath} should register a page`)
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      for (const [key, value] of Object.entries(update)) setByPath(this.data, key, value)
    }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function activeUser(id = 'user-1') {
  return { _id: id, role: 'user', status: 'active' }
}

function fakeUnavailableReasonMessage(reason) {
  if (reason === 'ASSIGNEE_INACTIVE') return '模板负责人不可用，请联系管理员'
  if (reason === 'TEMPLATE_LIMIT_EXCEEDED') return '模板节点或负责人过多，请联系管理员调整'
  return '模板当前不可创建业务，请联系管理员'
}

test('business service creates only through the template route and builds dashboard from protected account-aware reads', async () => {
  const calls = []
  const cloud = {
    callBusinessApi: async (action, payload) => {
      calls.push([action, payload])
      if (action === 'listBusinessLines') {
        return {
          items: [
            { _id: 'line-new', status: 'active' },
            { _id: 'line-done', status: 'completed' }
          ],
          total: 2
        }
      }
      if (action === 'getMyDashboardSummary') {
        return {
          stats: { active: 1, completed: 1, pendingProcessing: 2 },
          recent: [
            { _id: 'line-new', status: 'active' },
            { _id: 'line-done', status: 'completed' }
          ],
          complete: true
        }
      }
      if (action === 'listMyPendingReviews' || action === 'listMyNotifications') {
        return { items: [], hasMore: false }
      }
      return { id: 'line-new', code: 'YW-20260807-0001' }
    }
  }
  const service = withFakeModule('utils/cloud.js', cloud, () => freshRequire('services/business.js'))

  const created = await service.createBusinessFromTemplate({
    templateId: 'template-1', name: '交付', description: '',
    plannedStartDate: '2026-08-07', plannedEndDate: '2026-08-08', requestKey: 'attempt-1'
  })
  const dashboard = await service.dashboard()
  await service.updateBusinessMetadata({ businessLineId: 'line-new', expectedVersion: 1, name: '更新' })

  assert.equal(service.createBusinessLine, undefined)
  assert.equal(created.id, 'line-new')
  assert.deepEqual(calls, [
    ['createBusinessFromTemplate', {
      templateId: 'template-1', name: '交付', description: '',
      plannedStartDate: '2026-08-07', plannedEndDate: '2026-08-08', requestKey: 'attempt-1'
    }],
    ['getMyDashboardSummary', {}],
    ['listMyPendingReviews', { page: 1, pageSize: 50 }],
    ['listMyNotifications', { page: 1, pageSize: 50 }],
    ['updateBusinessMetadata', { businessLineId: 'line-new', expectedVersion: 1, name: '更新' }]
  ])
  assert.deepEqual(dashboard, {
    stats: {
      active: 1, pendingMine: 2, pendingMineAvailable: true,
      pendingReviews: 0, unreadNotifications: 0, completed: 1, complete: true
    },
    recent: [{ _id: 'line-new', status: 'active' }, { _id: 'line-done', status: 'completed' }]
  })
})

test('business creation maps a creator-reviewer conflict to a stable Chinese message', async () => {
  const cloud = {
    async callBusinessApi() {
      const error = new Error('CREATOR_REVIEWER_CONFLICT')
      error.code = 'CREATOR_REVIEWER_CONFLICT'
      throw error
    }
  }
  const service = withFakeModule('utils/cloud.js', cloud, () => freshRequire('services/business.js'))

  await assert.rejects(
    service.createBusinessFromTemplate({
      templateId: 'template-1', name: '冲突业务', description: '',
      plannedStartDate: '', plannedEndDate: '', requestKey: 'attempt-conflict'
    }),
    error => error.code === 'CREATOR_REVIEWER_CONFLICT' && error.message === '业务发起人不能同时担任同一节点的处理人和审核人，请调整模板或由其他账号发起'
  )
})

test('dashboard presents the protected pending assignment count', () => {
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/dashboard/index.wxml'), 'utf8')
  assert.doesNotMatch(wxml, /暂不可用/)
  assert.match(wxml, /stats\.pendingMine/)
})

test('ordinary template list loads server availability and navigates with only an available template id', async () => {
  const navigations = []
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    navigateTo: options => navigations.push(options),
    showToast: options => toasts.push(options),
    reLaunch: () => assert.fail('active user must not be redirected')
  }
  const page = loadPage('pages/template-list/index.js', {
    'services/templates.js': {
      unavailableReasonMessage: fakeUnavailableReasonMessage,
      listEnabledTemplates: async () => ({
        items: [
          { _id: 'template/available', name: '交付流程', description: '标准交付', nodeCount: 3, available: true, unavailableReason: '' },
          { _id: 'template-disabled-owner', name: '归档流程', description: '', nodeCount: 2, available: false, unavailableReason: 'ASSIGNEE_INACTIVE' },
          { _id: 'template-over-limit', name: '大型流程', description: '', nodeCount: 48, available: false, unavailableReason: 'TEMPLATE_LIMIT_EXCEEDED' }
        ]
      })
    }
  })

  await page.onShow()
  page.selectTemplate({ currentTarget: { dataset: { id: 'template-disabled-owner', available: false } } })
  page.selectTemplate({ currentTarget: { dataset: { id: 'template-over-limit', available: false } } })
  page.selectTemplate({ currentTarget: { dataset: { id: 'template/available', available: true } } })

  assert.equal(page.data.loading, false)
  assert.equal(page.data.errorMessage, '')
  assert.equal(page.data.items.length, 3)
  assert.equal(page.data.items[1].unavailableMessage, '模板负责人不可用，请联系管理员')
  assert.equal(page.data.items[2].unavailableMessage, '模板节点或负责人过多，请联系管理员调整')
  assert.deepEqual(toasts.map(item => item.title), [
    '模板负责人不可用，请联系管理员',
    '模板节点或负责人过多，请联系管理员调整'
  ])
  assert.deepEqual(navigations, [{ url: '/pages/business-edit/index?templateId=template%2Favailable' }])
})

test('ordinary template list exposes loading, error, empty, and unavailable states without a demo item', async () => {
  const pending = deferred()
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { reLaunch: () => assert.fail('active user must not be redirected') }
  const page = loadPage('pages/template-list/index.js', {
    'services/templates.js': { listEnabledTemplates: () => pending.promise }
  })

  const loading = page.onShow()
  assert.equal(page.data.loading, true)
  pending.resolve({ items: [] })
  await loading
  assert.deepEqual(page.data.items, [])

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/template-list/index.wxml'), 'utf8')
  const script = fs.readFileSync(path.join(miniProgramRoot, 'pages/template-list/index.js'), 'utf8')
  assert.doesNotMatch(script, /demo-1|内置示例模板/)
  assert.match(wxml, /loading/)
  assert.match(wxml, /errorMessage/)
  assert.match(wxml, /!loading\s*&&\s*!errorMessage\s*&&\s*!items\.length/)
  assert.match(wxml, /unavailableMessage/)
})

test('create mode loads a server-backed preview and blocks unavailable or missing templates', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('active user must not be redirected'),
    redirectTo: options => calls.push(['redirect', options])
  }
  const page = loadPage('pages/business-edit/index.js', {
    'services/templates.js': {
      unavailableReasonMessage: fakeUnavailableReasonMessage,
      listEnabledTemplates: async () => ({
        items: [{ _id: 'template-1', name: '交付流程', description: '标准交付', nodeCount: 3, available: false, unavailableReason: 'ASSIGNEE_INACTIVE' }]
      })
    },
    'services/business.js': { createBusinessFromTemplate: async input => calls.push(['create', input]) }
  })

  await page.onLoad({ templateId: 'template-1' })
  await page.save()

  assert.equal(page.data.templatePreview.name, '交付流程')
  assert.equal(page.data.templateAvailable, false)
  assert.equal(page.data.templatePreview.unavailableMessage, '模板负责人不可用，请联系管理员')
  assert.equal(page.data.errorMessage, '模板负责人不可用，请联系管理员')
  assert.deepEqual(calls, [])
})

test('create mode validates real planned dates before sending a request', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('must stay authenticated') }
  const page = loadPage('pages/business-edit/index.js', {
    'services/templates.js': { listEnabledTemplates: async () => ({ items: [{ _id: 'template-1', name: '交付', nodeCount: 1, available: true }] }) },
    'services/business.js': { createBusinessFromTemplate: async input => calls.push(input) }
  })
  await page.onLoad({ templateId: 'template-1' })
  page.setData({
    'form.name': '交付任务',
    'form.plannedStartDate': '2026-02-30',
    'form.plannedEndDate': '2026-02-01'
  })

  await page.save()
  assert.deepEqual(calls, [])
  assert.match(page.data.errorMessage, /日期/)
})

test('template unavailability uses a prototype-safe string fallback consistently in list and create preview', async () => {
  const templatesService = freshRequire('services/templates.js')
  const fallback = '模板当前不可创建业务，请联系管理员'
  const item = {
    _id: 'template-unknown', name: '未知限制模板', description: '', nodeCount: 1,
    available: false, unavailableReason: 'constructor'
  }
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    showToast: options => toasts.push(options),
    reLaunch: () => assert.fail('must stay authenticated')
  }
  const templateFake = {
    listEnabledTemplates: async () => ({ items: [item] }),
    unavailableReasonMessage: templatesService.unavailableReasonMessage
  }
  const listPage = loadPage('pages/template-list/index.js', { 'services/templates.js': templateFake })
  await listPage.onShow()
  listPage.selectTemplate({ currentTarget: { dataset: { id: item._id, available: false } } })

  const createPage = loadPage('pages/business-edit/index.js', {
    'services/templates.js': templateFake,
    'services/business.js': {}
  })
  await createPage.onLoad({ templateId: item._id })

  for (const reason of [
    'toString', 'constructor', '__proto__', 'UNKNOWN_REASON',
    null, undefined, 42, true, {}, [], Symbol('reason')
  ]) {
    const message = templatesService.unavailableReasonMessage(reason)
    assert.equal(typeof message, 'string')
    assert.equal(message, fallback)
  }
  assert.equal(listPage.data.items[0].unavailableMessage, fallback)
  assert.equal(toasts[0].title, fallback)
  assert.equal(createPage.data.templatePreview.unavailableMessage, fallback)
  assert.equal(createPage.data.errorMessage, fallback)
})

test('create mode uses one request key across retry, prevents rapid duplicates, and redirects by returned id', async () => {
  const first = deferred()
  const calls = []
  const redirects = []
  let invocation = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('must stay authenticated'),
    redirectTo: options => redirects.push(options),
    showToast: () => {}
  }
  const page = loadPage('pages/business-edit/index.js', {
    'services/templates.js': { listEnabledTemplates: async () => ({ items: [{ _id: 'template-1', name: '交付', nodeCount: 1, available: true }] }) },
    'services/business.js': {
      createBusinessFromTemplate: input => {
        calls.push(input)
        invocation += 1
        if (invocation === 1) return first.promise
        return Promise.resolve({ id: 'line-1', code: 'YW-20260807-0001' })
      }
    }
  })
  await page.onLoad({ templateId: 'template-1' })
  page.setData({
    'form.name': ' 交付任务 ',
    'form.description': ' 说明 ',
    'form.plannedStartDate': '2026-08-07',
    'form.plannedEndDate': '2026-08-08'
  })

  const firstSave = page.save()
  const duplicateSave = page.save()
  assert.equal(calls.length, 1)
  const networkError = new Error('network')
  first.reject(networkError)
  await firstSave
  await duplicateSave
  await page.save()

  assert.equal(calls.length, 2)
  assert.equal(calls[0].requestKey, calls[1].requestKey)
  assert.match(calls[0].requestKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  assert.deepEqual(calls[1], {
    templateId: 'template-1',
    name: '交付任务',
    description: '说明',
    plannedStartDate: '2026-08-07',
    plannedEndDate: '2026-08-08',
    requestKey: calls[0].requestKey
  })
  assert.deepEqual(redirects, [{ url: '/pages/business-detail/index?id=line-1' }])
})

test('edit mode renders immutable code and nodes and submits metadata with expected version only', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('must stay authenticated'),
    navigateBack: () => {},
    showToast: () => {}
  }
  const page = loadPage('pages/business-edit/index.js', {
    'services/templates.js': {},
    'services/business.js': {
      getBusinessLine: async () => ({
        canManage: true,
        line: {
          _id: 'line-1', code: 'YW-20260807-0001', name: '旧名称', description: '',
          plannedStartDate: '2026-08-07', plannedEndDate: '2026-08-08', version: 4, status: 'active'
        },
        nodes: [{ _id: 'node-1', nodeCode: 'YW-20260807-0001-N001', name: '资料准备', status: 'ready' }]
      }),
      updateBusinessMetadata: async input => { calls.push(input); return { id: 'line-1', version: 5 } }
    }
  })
  await page.onLoad({ id: 'line-1' })
  page.setData({ 'form.name': '新名称', 'form.description': '新说明' })
  await page.save()

  assert.equal(page.data.lineCode, 'YW-20260807-0001')
  assert.equal(page.data.nodes[0].nodeCode, 'YW-20260807-0001-N001')
  assert.deepEqual(calls, [{
    businessLineId: 'line-1',
    expectedVersion: 4,
    name: '新名称',
    description: '新说明',
    plannedStartDate: '2026-08-07',
    plannedEndDate: '2026-08-08'
  }])

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/business-edit/index.wxml'), 'utf8')
  assert.doesNotMatch(wxml, /data-field="code"|bindinput="updateNodeName"|bindchange="toggleEvidence"|bindtap="addNode"|bindtap="removeNode"/)
  assert.match(wxml, /lineCode/)
  assert.match(wxml, /nodes/)
})

test('edit mode surfaces frozen state and never sends frozen metadata', async () => {
  let updates = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('must stay authenticated') }
  const page = loadPage('pages/business-edit/index.js', {
    'services/templates.js': {},
    'services/business.js': {
      getBusinessLine: async () => ({
        canManage: true,
        line: { _id: 'line-1', code: 'YW-1', name: '已完成', version: 5, status: 'completed' },
        nodes: []
      }),
      updateBusinessMetadata: async () => { updates += 1 }
    }
  })
  await page.onLoad({ id: 'line-1' })
  await page.save()

  assert.equal(page.data.frozen, true)
  assert.match(page.data.errorMessage, /冻结|完成/)
  assert.equal(updates, 0)
})

test('business edit registers every custom component used by its WXML', () => {
  const config = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, 'pages/business-edit/index.json'), 'utf8'))
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/business-edit/index.wxml'), 'utf8')
  assert.match(wxml, /<status-pill\b/)
  assert.equal(config.usingComponents && config.usingComponents['status-pill'], '/components/status-pill/index')
})

test('pending server reads fail closed when the authenticated account changes', async () => {
  const pending = deferred()
  const app = { globalData: { currentUser: activeUser('user-before') } }
  const launches = []
  global.getApp = () => app
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/template-list/index.js', {
    'services/templates.js': { listEnabledTemplates: () => pending.promise }
  })

  const load = page.onShow()
  app.globalData.currentUser = null
  pending.resolve({ items: [{ _id: 'stale', available: true }] })
  await load

  assert.deepEqual(page.data.items, [])
  assert.deepEqual(launches, [{ url: '/pages/login/index' }])
})
