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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function loadPage(relativePath, fakes = {}) {
  let definition = null
  global.Page = value => { definition = value }
  const entries = Object.entries(fakes)

  function loadAt(index) {
    if (index === entries.length) return freshRequire(relativePath)
    const [modulePath, fake] = entries[index]
    return withFakeModule(modulePath, fake, () => loadAt(index + 1))
  }

  try {
    loadAt(0)
  } finally {
    delete global.Page
  }
  assert.ok(definition, `${relativePath} should register a page`)
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      for (const [key, value] of Object.entries(update)) {
        const match = /^(\w+)\[(\d+)\]\.(.+)$/.exec(key)
        if (match) this.data[match[1]][Number(match[2])][match[3]] = value
        else this.data[key] = value
      }
    }
  }
}

test('template service forwards all seven protected actions with exact payloads', async () => {
  const calls = []
  const cloud = {
    callBusinessApi: async (action, payload) => {
      calls.push([action, payload])
      return { action }
    }
  }
  const templates = withFakeModule('utils/cloud.js', cloud, () => freshRequire('services/templates.js'))
  const definition = { name: '交付模板', description: '', nodes: [] }

  await templates.listTemplates({ status: 'draft', keyword: '交付' })
  await templates.getTemplate('t1')
  await templates.createTemplate(definition)
  await templates.updateTemplate('t1', 3, definition)
  await templates.changeTemplateStatus('t1', 4, 'enabled')
  await templates.deleteTemplate('t1', 5)
  await templates.listEnabledTemplates()

  assert.deepEqual(calls, [
    ['listTemplates', { status: 'draft', keyword: '交付' }],
    ['getTemplate', { templateId: 't1' }],
    ['createTemplate', definition],
    ['updateTemplate', { templateId: 't1', expectedVersion: 3, definition }],
    ['changeTemplateStatus', { templateId: 't1', expectedVersion: 4, status: 'enabled' }],
    ['deleteTemplate', { templateId: 't1', expectedVersion: 5 }],
    ['listEnabledTemplates', {}]
  ])
})

test('application registers template pages and exposes administrator navigation only to super administrators', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, 'app.json'), 'utf8'))
  const dashboardWxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/dashboard/index.wxml'), 'utf8')
  const dashboard = loadPage('pages/dashboard/index.js', {
    'services/business.js': { dashboard: async () => ({ stats: {}, recent: [] }) }
  })
  const navigations = []
  global.wx = { navigateTo: options => navigations.push(options) }

  assert.deepEqual(appConfig.pages.filter(item => item.startsWith('pages/admin-template')), [
    'pages/admin-templates/index',
    'pages/admin-template-edit/index',
    'pages/admin-template-node-edit/index'
  ])
  assert.match(dashboardWxml, /profile\s*&&\s*profile\.role\s*===\s*'super_admin'[\s\S]*openAdminTemplates/)

  dashboard.data.profile = { role: 'user', status: 'active' }
  dashboard.openAdminTemplates()
  dashboard.data.profile = { role: 'super_admin', status: 'active' }
  dashboard.openAdminTemplates()
  assert.deepEqual(navigations, [{ url: '/pages/admin-templates/index' }])
  delete global.wx
})

test('administrator template list rechecks authorization filters results and confirms lifecycle changes', async () => {
  const serviceCalls = []
  const templates = {
    listTemplates: async query => {
      serviceCalls.push(['list', query])
      return { items: [{ _id: 't1', name: '交付模板', status: 'draft', version: 2, nodeCount: 1 }] }
    },
    changeTemplateStatus: async (...args) => {
      serviceCalls.push(['status', ...args])
      return { template: { _id: 't1', status: 'enabled', version: 3 } }
    },
    deleteTemplate: async (...args) => serviceCalls.push(['delete', ...args])
  }
  const launches = []
  let confirmations = 0
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = {
    reLaunch: options => launches.push(options),
    showModal: async () => ({ confirm: ++confirmations > 1 }),
    showToast: () => {}
  }
  const page = loadPage('pages/admin-templates/index.js', { 'services/templates.js': templates })

  page.setData({ keyword: ' 交付 ', status: 'draft' })
  await page.search()
  assert.deepEqual(serviceCalls[0], ['list', { keyword: '交付', status: 'draft' }])
  assert.equal(page.data.items.length, 1)

  await page.changeStatus({ currentTarget: { dataset: { id: 't1', status: 'draft' } } })
  assert.equal(serviceCalls.some(call => call[0] === 'status'), false, 'cancelled confirmation must not mutate')
  await page.changeStatus({ currentTarget: { dataset: { id: 't1', status: 'draft' } } })
  assert.deepEqual(serviceCalls.find(call => call[0] === 'status'), ['status', 't1', 2, 'enabled'])

  global.getApp = () => ({ globalData: { currentUser: { role: 'user', status: 'active' } } })
  assert.equal(page.requireSuperAdmin(), false)
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])
  delete global.getApp
  delete global.wx
})

function storedNode(overrides = {}) {
  return {
    nodeKey: 'node-stable-1',
    sequence: 0,
    name: '需求确认',
    description: '',
    assigneeUserIds: ['account-1'],
    slaWorkHours: 22,
    requiresEvidence: false,
    allowedEvidenceTypes: [],
    fields: [{
      fieldKey: 'field-stable-1', sequence: 0, name: '结论', description: '',
      type: 'short_text', required: true, constraints: { maxLength: 80 }
    }],
    ...overrides
  }
}

function createNodeEditor({ users, node = null, readOnly = false, acceptNodeFromEditor = () => {} }) {
  const previousPage = {
    getNodeEditorContext: () => ({ readOnly, assigneeOptions: users, node }),
    acceptNodeFromEditor
  }
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.getCurrentPages = () => [previousPage, {}]
  global.wx = { setNavigationBarTitle: () => {}, navigateBack: () => {}, reLaunch: () => {} }
  const page = loadPage('pages/admin-template-node-edit/index.js')
  page.onLoad({ index: node ? '0' : '-1' })
  return page
}

test('node editor saves separate processor reviewer mode and dual SLA fields', () => {
  const processor = { _id: 'processor-1', displayName: '处理人', username: 'processor' }
  const reviewer = { _id: 'reviewer-1', displayName: '审核人', username: 'reviewer' }
  const page = createNodeEditor({
    users: [processor, reviewer],
    node: storedNode({ assigneeUserIds: [processor._id] })
  })

  page.onReviewerToggle({ currentTarget: { dataset: { id: reviewer._id } } })
  page.onReviewModeChange({ detail: { value: 'all' } })
  page.onProcessingSlaInput({ detail: { value: '22' } })
  page.onReviewSlaInput({ detail: { value: '8' } })
  const node = page.buildNodeForSave()

  assert.equal(node.workflowMode, 'review')
  assert.deepEqual(node.processorUserIds, [processor._id])
  assert.deepEqual(node.reviewerUserIds, [reviewer._id])
  assert.equal(node.reviewMode, 'all')
  assert.equal(node.processingSlaWorkHours, 22)
  assert.equal(node.reviewSlaWorkHours, 8)
  assert.equal(Object.hasOwn(node, 'assigneeUserIds'), false)
  assert.equal(Object.hasOwn(node, 'slaWorkHours'), false)
  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('node editor maps legacy assignees only when workflowMode is absent', () => {
  const processor = { _id: 'processor-1', displayName: '处理人', username: 'processor' }
  const reviewer = { _id: 'reviewer-1', displayName: '审核人', username: 'reviewer' }
  const page = createNodeEditor({
    users: [processor, reviewer],
    node: storedNode({
      workflowMode: 'future_mode', assigneeUserIds: ['legacy-1'],
      processorUserIds: [processor._id], reviewerUserIds: [reviewer._id],
      reviewMode: 'all', processingSlaWorkHours: 4, reviewSlaWorkHours: 2
    })
  })

  assert.deepEqual(page.data.processorUserIds, [processor._id])
  assert.deepEqual(page.data.reviewerUserIds, [reviewer._id])
  assert.equal(page.data.reviewMode, 'all')
  assert.equal(page.data.processingSlaWorkHours, 4)
  assert.equal(page.data.reviewSlaWorkHours, 2)
  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('node editor rejects overlapping roles and a missing reviewer before commit', async () => {
  const processor = { _id: 'processor-1', displayName: '处理人', username: 'processor' }
  let accepted = 0
  const page = createNodeEditor({
    users: [processor],
    acceptNodeFromEditor: () => { accepted += 1 }
  })
  page.setData({ name: '需求确认' })
  page.onProcessorToggle({ currentTarget: { dataset: { id: processor._id } } })
  page.onReviewerToggle({ currentTarget: { dataset: { id: processor._id } } })
  await page.submit()
  assert.equal(accepted, 0)
  assert.equal(page.data.errorMessage, '处理人与审核人不能为同一账号')

  page.setData({ reviewerUserIds: [] })
  await page.submit()
  assert.equal(accepted, 0)
  assert.match(page.data.errorMessage, /至少选择一名审核人/)
  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('node editor rejects SLA hours that cannot be represented as whole minutes', async () => {
  const processor = { _id: 'processor-1', displayName: 'P', username: 'processor' }
  const reviewer = { _id: 'reviewer-1', displayName: 'R', username: 'reviewer' }
  let accepted = 0
  const page = createNodeEditor({ users: [processor, reviewer], acceptNodeFromEditor: () => { accepted += 1 } })
  page.setData({ name: 'node', processorUserIds: [processor._id], reviewerUserIds: [reviewer._id], processingSlaWorkHours: '0.333', reviewSlaWorkHours: '0.1' })
  await page.submit()
  assert.equal(accepted, 0)
  assert.equal(page.data.errorMessage, '处理与审核 SLA 必须是可精确换算为整分钟的正数小时')
  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('node editor preserves optional evidence formats and rejects a required empty format list', async () => {
  const processor = { _id: 'processor-1', displayName: '处理人', username: 'processor' }
  const reviewer = { _id: 'reviewer-1', displayName: '审核人', username: 'reviewer' }
  const optionalAll = createNodeEditor({ users: [processor, reviewer] })
  optionalAll.setData({
    name: '可选全部格式', processorUserIds: [processor._id], reviewerUserIds: [reviewer._id],
    requiresEvidence: false, allowedEvidenceTypes: []
  })
  assert.deepEqual(optionalAll.buildNodeForSave().allowedEvidenceTypes, [])

  const optionalPdf = createNodeEditor({ users: [processor, reviewer] })
  optionalPdf.setData({
    name: '可选 PDF', processorUserIds: [processor._id], reviewerUserIds: [reviewer._id],
    requiresEvidence: false, allowedEvidenceTypes: ['pdf']
  })
  assert.deepEqual(optionalPdf.buildNodeForSave().allowedEvidenceTypes, ['pdf'])

  let accepted = 0
  const requiredWithoutFormats = createNodeEditor({
    users: [processor, reviewer],
    acceptNodeFromEditor: () => { accepted += 1 }
  })
  requiredWithoutFormats.setData({
    name: '必传凭证', processorUserIds: [processor._id], reviewerUserIds: [reviewer._id],
    requiresEvidence: true, allowedEvidenceTypes: []
  })
  await requiredWithoutFormats.submit()
  assert.equal(requiredWithoutFormats.data.errorMessage, '要求凭证时至少选择一种凭证类型')
  assert.equal(accepted, 0)

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-node-edit/index.wxml'), 'utf8')
  assert.match(wxml, /提交审核时必须上传凭证/)
  assert.doesNotMatch(wxml, /checkbox-group[^>]*wx:if="{{requiresEvidence}}"/)
  assert.match(wxml, /不限格式（仅限系统已支持格式）/)

  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('node editor keeps enabled-template nodes read-only', async () => {
  const processor = { _id: 'processor-1', displayName: '处理人', username: 'processor' }
  const reviewer = { _id: 'reviewer-1', displayName: '审核人', username: 'reviewer' }
  let accepted = 0
  const page = createNodeEditor({
    users: [processor, reviewer],
    node: {
      ...storedNode(), workflowMode: 'review', processorUserIds: [processor._id], reviewerUserIds: [reviewer._id],
      reviewMode: 'any', processingSlaWorkHours: 22, reviewSlaWorkHours: 8
    },
    readOnly: true,
    acceptNodeFromEditor: () => { accepted += 1 }
  })
  const original = JSON.parse(JSON.stringify(page.data))
  page.onProcessorToggle({ currentTarget: { dataset: { id: reviewer._id } } })
  page.onReviewModeChange({ detail: { value: 'all' } })
  page.onProcessingSlaInput({ detail: { value: '4' } })
  await page.submit()
  assert.equal(accepted, 0)
  assert.deepEqual(page.data.processorUserIds, original.processorUserIds)
  assert.deepEqual(page.data.reviewerUserIds, original.reviewerUserIds)
  assert.equal(page.data.reviewMode, original.reviewMode)
  assert.equal(page.data.processingSlaWorkHours, original.processingSlaWorkHours)
  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('template editor fails closed when a selected processor becomes inactive during save', async () => {
  const navigations = []
  const inactive = new Error('inactive')
  inactive.code = 'PROCESSOR_INACTIVE'
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { showToast: () => {}, navigateBack: options => navigations.push(options), reLaunch: () => {} }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': { updateTemplate: async () => { throw inactive } },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  page.setData({
    editMode: true, templateId: 't1', version: 1, name: '交付模板',
    nodes: [{
      ...storedNode(), workflowMode: 'review', processorUserIds: ['processor-1'], reviewerUserIds: ['reviewer-1'],
      reviewMode: 'any', processingSlaWorkHours: 22, reviewSlaWorkHours: 8
    }]
  })
  await page.submit()
  assert.equal(page.data.errorMessage, '节点处理人已停用，请重新选择启用账号')
  assert.deepEqual(navigations, [])
  delete global.getApp
  delete global.wx
})

test('template editor fails closed when a selected reviewer becomes inactive during save', async () => {
  const navigations = []
  const inactive = new Error('inactive')
  inactive.code = 'REVIEWER_INACTIVE'
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { showToast: () => {}, navigateBack: options => navigations.push(options), reLaunch: () => {} }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': { updateTemplate: async () => { throw inactive } },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  page.setData({
    editMode: true, templateId: 't1', version: 1, name: '交付模板',
    nodes: [{
      ...storedNode(), workflowMode: 'review', processorUserIds: ['processor-1'], reviewerUserIds: ['reviewer-1'],
      reviewMode: 'any', processingSlaWorkHours: 22, reviewSlaWorkHours: 8
    }]
  })
  await page.submit()
  assert.equal(page.data.errorMessage, '节点审核人已停用，请重新选择启用账号')
  assert.deepEqual(navigations, [])
  delete global.getApp
  delete global.wx
})

test('template editor loads every active account and preserves stable keys through node edits and reorder', async () => {
  const userQueries = []
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { setNavigationBarTitle: () => {}, navigateTo: () => {} }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': {
      getTemplate: async () => ({
        template: { _id: 't1', name: '交付模板', description: '', status: 'disabled', version: 7 },
        nodes: [storedNode(), storedNode({ nodeKey: 'node-stable-2', sequence: 1, name: '交付' })]
      })
    },
    'services/admin-users.js': {
      listUsers: async query => {
        userQueries.push(query)
        return query.page === 1
          ? { items: [{ _id: 'account-1', displayName: '甲', username: 'alpha', status: 'active' }], hasMore: true }
          : { items: [{ _id: 'account-2', displayName: '乙', username: 'beta', status: 'active' }], hasMore: false }
      }
    }
  })

  await page.onLoad({ id: 't1' })
  assert.deepEqual(userQueries, [
    { status: 'active', keyword: '', page: 1, pageSize: 100 },
    { status: 'active', keyword: '', page: 2, pageSize: 100 }
  ])
  assert.deepEqual(page.data.assigneeOptions.map(item => item._id), ['account-1', 'account-2'])

  page.acceptNodeFromEditor(0, {
    ...page.data.nodes[0],
    name: '更新后的需求确认',
    fields: [{ ...page.data.nodes[0].fields[0], name: '更新后的结论' }]
  })
  page.moveNode({ currentTarget: { dataset: { index: 0, direction: 1 } } })

  assert.deepEqual(page.data.nodes.map(node => node.nodeKey), ['node-stable-2', 'node-stable-1'])
  assert.equal(page.data.nodes[1].fields[0].fieldKey, 'field-stable-1')
  assert.deepEqual(page.data.nodes.map(node => node.sequence), [0, 1])
  delete global.getApp
  delete global.wx
})

test('template editor rejects an empty definition and refreshes stale versions without losing a server limit message', async () => {
  const updates = []
  let loads = 0
  const limit = new Error('Template definitions support at most 48 nodes and must fit the transaction operation budget')
  limit.code = 'TEMPLATE_LIMIT_EXCEEDED'
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { setNavigationBarTitle: () => {}, navigateBack: () => {}, showToast: () => {} }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': {
      getTemplate: async () => ({
        template: { _id: 't1', name: '交付模板', description: '', status: 'disabled', version: ++loads + 3 },
        nodes: [storedNode()]
      }),
      updateTemplate: async (...args) => {
        updates.push(args)
        const conflict = new Error('conflict')
        conflict.code = 'VERSION_CONFLICT'
        throw conflict
      },
      changeTemplateStatus: async () => { throw limit }
    },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  await page.onLoad({ id: 't1' })

  page.setData({ nodes: [] })
  await page.submit()
  assert.match(page.data.errorMessage, /至少添加一个节点/)
  assert.equal(updates.length, 0)

  page.setData({ nodes: [storedNode()] })
  await page.submit()
  assert.equal(loads, 2, 'a version conflict must reload the latest definition')
  assert.equal(page.data.version, 5)
  assert.match(page.data.errorMessage, /其他管理员/)

  await page.enableTemplate()
  assert.equal(page.data.errorMessage, limit.message)
  delete global.getApp
  delete global.wx
})

test('enabled template definitions are fully read-only in page behavior and markup', async () => {
  const navigations = []
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { setNavigationBarTitle: () => {}, navigateTo: options => navigations.push(options) }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': {
      getTemplate: async () => ({
        template: { _id: 't1', name: '启用模板', description: '只读', status: 'enabled', version: 2 },
        nodes: [storedNode()]
      })
    },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  await page.onLoad({ id: 't1' })
  const original = JSON.parse(JSON.stringify(page.data.nodes))
  page.onNameInput({ detail: { value: '不应写入' } })
  page.removeNode({ currentTarget: { dataset: { index: 0 } } })
  page.openNodeEditor({ currentTarget: { dataset: { index: 0 } } })

  assert.equal(page.data.readOnly, true)
  assert.equal(page.data.name, '启用模板')
  assert.deepEqual(page.data.nodes, original)
  assert.deepEqual(navigations, [{ url: '/pages/admin-template-node-edit/index?index=0' }])
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-edit/index.wxml'), 'utf8')
  assert.match(wxml, /disabled="{{readOnly[^}]*}}"/)
  assert.match(wxml, /wx:if="{{!readOnly}}"[\s\S]*保存/)
  delete global.getApp
  delete global.wx
})

test('node editor returns normalized stable-key data through the previous page without identities in URLs', async () => {
  let accepted
  const previousPage = {
    getNodeEditorContext: () => ({
      readOnly: false,
      assigneeOptions: [
        { _id: 'account-1', displayName: '甲', username: 'alpha' },
        { _id: 'account-2', displayName: '乙', username: 'beta' }
      ],
      node: storedNode()
    }),
    acceptNodeFromEditor(index, node) { accepted = [index, node] }
  }
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.getCurrentPages = () => [previousPage, {}]
  global.wx = { setNavigationBarTitle: () => {}, navigateBack: () => {} }
  const page = loadPage('pages/admin-template-node-edit/index.js')

  page.onLoad({ index: '0' })
  page.addField()
  page.onFieldNameInput({ currentTarget: { dataset: { index: 1 } }, detail: { value: '验收项' } })
  page.onFieldTypeChange({ currentTarget: { dataset: { index: 1 } }, detail: { value: '5' } })
  page.onFieldOptionsInput({ currentTarget: { dataset: { index: 1 } }, detail: { value: '通过, 退回,通过' } })
  page.onProcessorToggle({ currentTarget: { dataset: { id: 'account-1' } } })
  page.onProcessorToggle({ currentTarget: { dataset: { id: 'account-2' } } })
  page.onReviewerToggle({ currentTarget: { dataset: { id: 'account-1' } } })
  await page.submit()

  assert.equal(accepted[0], 0)
  assert.equal(accepted[1].nodeKey, 'node-stable-1')
  assert.equal(accepted[1].fields[0].fieldKey, 'field-stable-1')
  assert.equal(Object.hasOwn(accepted[1].fields[1], 'fieldKey'), false)
  assert.deepEqual(accepted[1].fields[1].constraints.options, ['通过', '退回'])
  assert.equal(accepted[1].workflowMode, 'review')
  assert.deepEqual(accepted[1].processorUserIds, ['account-2'])
  assert.deepEqual(accepted[1].reviewerUserIds, ['account-1'])
  assert.deepEqual(accepted[1].fields.map(field => field.sequence), [0, 1])

  const templateSource = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-edit/index.js'), 'utf8')
  assert.doesNotMatch(templateSource, /navigateTo\([^)]*(?:assigneeUserIds|fields|nodeKey)/s)
  assert.match(templateSource, /admin-template-node-edit\/index\?index=/)
  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('node editor precomputes checkbox and option display state for WXML compatibility', () => {
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-node-edit/index.wxml'), 'utf8')
  assert.doesNotMatch(wxml, /\.(?:includes|join)\s*\(/)
  assert.match(wxml, /checked="{{item\.selected}}"/)
  assert.match(wxml, /value="{{item\.optionText}}"/)
})

test('unsaved nodes and fields keep unique client keys that never enter template API payloads', async () => {
  let submittedDefinition
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { setNavigationBarTitle: () => {}, navigateBack: () => {}, showToast: () => {} }
  const templatePage = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': {
      getTemplate: async () => ({
        template: { _id: 't1', name: '交付模板', description: '', status: 'disabled', version: 1 },
        nodes: [storedNode()]
      }),
      updateTemplate: async (id, version, definition) => { submittedDefinition = definition }
    },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  await templatePage.onLoad({ id: 't1' })
  templatePage.acceptNodeFromEditor(-1, {
    sequence: 1, name: '新增一', description: '', assigneeUserIds: ['account-1'],
    slaWorkHours: 22, requiresEvidence: false, allowedEvidenceTypes: [], fields: []
  })
  templatePage.acceptNodeFromEditor(-1, {
    sequence: 2, name: '新增二', description: '', assigneeUserIds: ['account-1'],
    slaWorkHours: 22, requiresEvidence: false, allowedEvidenceTypes: [], fields: []
  })
  const newNodeKeys = templatePage.data.nodes.slice(1).map(node => node._uiKey)
  assert.equal(new Set(newNodeKeys).size, 2)

  await templatePage.submit()
  assert.doesNotMatch(JSON.stringify(submittedDefinition), /_uiKey/)

  const previousPage = {
    getNodeEditorContext: () => ({ readOnly: false, assigneeOptions: [], node: null }),
    acceptNodeFromEditor: () => {}
  }
  global.getCurrentPages = () => [previousPage, {}]
  const nodePage = loadPage('pages/admin-template-node-edit/index.js')
  nodePage.onLoad({ index: '-1' })
  nodePage.addField()
  nodePage.addField()
  const fieldKeys = nodePage.data.fields.map(field => field._uiKey)
  assert.equal(new Set(fieldKeys).size, 2)
  nodePage.moveField({ currentTarget: { dataset: { index: 0, direction: 1 } } })
  assert.deepEqual(nodePage.data.fields.map(field => field._uiKey), fieldKeys.slice().reverse())

  const templateWxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-edit/index.wxml'), 'utf8')
  const nodeWxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-node-edit/index.wxml'), 'utf8')
  assert.match(templateWxml, /wx:key="_uiKey"/)
  assert.match(nodeWxml, /wx:key="_uiKey"/)
  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('template pages recheck active super-administrator authority at every load and mutation boundary', async () => {
  let currentUser = { role: 'super_admin', status: 'active' }
  let listCalls = 0
  let statusCalls = 0
  let updateCalls = 0
  let acceptedNodes = 0
  const launches = []
  global.getApp = () => ({ globalData: { currentUser } })
  global.wx = {
    reLaunch: options => launches.push(options),
    setNavigationBarTitle: () => {},
    navigateBack: () => {},
    showToast: () => {},
    showModal: async () => {
      currentUser = { role: 'user', status: 'active' }
      return { confirm: true }
    }
  }

  const listPage = loadPage('pages/admin-templates/index.js', {
    'services/templates.js': {
      listTemplates: async () => { listCalls += 1; return { items: [] } },
      changeTemplateStatus: async () => { statusCalls += 1 }
    }
  })
  listPage.setData({ items: [{ _id: 't1', status: 'draft', version: 1 }] })
  currentUser = { role: 'user', status: 'active' }
  await listPage.search()
  assert.equal(listCalls, 0, 'demoted users must not start a template load')

  currentUser = { role: 'super_admin', status: 'active' }
  await listPage.changeStatus({ currentTarget: { dataset: { id: 't1' } } })
  assert.equal(statusCalls, 0, 'authority must be checked again after modal confirmation')

  const editPage = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': {
      updateTemplate: async () => { updateCalls += 1 }
    },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  editPage.setData({
    editMode: true,
    templateId: 't1',
    version: 1,
    name: '交付模板',
    nodes: [storedNode()]
  })
  currentUser = { role: 'user', status: 'active' }
  await editPage.submit()
  assert.equal(updateCalls, 0, 'demoted users must not save template definitions')

  currentUser = { role: 'super_admin', status: 'active' }
  const previousPage = {
    getNodeEditorContext: () => ({
      readOnly: false,
      assigneeOptions: [
        { _id: 'account-1', displayName: '甲', username: 'alpha' },
        { _id: 'account-2', displayName: '乙', username: 'beta' }
      ],
      node: null
    }),
    acceptNodeFromEditor: () => { acceptedNodes += 1 }
  }
  global.getCurrentPages = () => [previousPage, {}]
  const nodePage = loadPage('pages/admin-template-node-edit/index.js')
  nodePage.onLoad({ index: '-1' })
  nodePage.setData({ name: '新增节点', assigneeUserIds: ['account-1'] })
  currentUser = { role: 'user', status: 'active' }
  nodePage.addField()
  await nodePage.submit()
  assert.equal(nodePage.data.fields.length, 0, 'demoted users must not mutate node draft state')
  assert.equal(acceptedNodes, 0, 'demoted users must not commit a node to the owner page')
  assert.ok(launches.length >= 4)

  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})

test('template list discards a pending load when the administrator is demoted', async () => {
  const pendingList = deferred()
  let currentUser = { role: 'super_admin', status: 'active' }
  const launches = []
  global.getApp = () => ({ globalData: { currentUser } })
  global.wx = {
    reLaunch: options => launches.push(options),
    showToast: () => {}
  }
  const page = loadPage('pages/admin-templates/index.js', {
    'services/templates.js': { listTemplates: () => pendingList.promise }
  })
  const originalItems = [{ _id: 'old', name: 'existing template' }]
  page.setData({ items: originalItems })

  const loading = page.loadTemplates()
  currentUser = { role: 'user', status: 'active' }
  pendingList.resolve({ items: [{ _id: 'new', name: 'stale response' }] })
  await loading

  assert.deepEqual(page.data.items, originalItems)
  assert.ok(launches.length >= 1)
  delete global.getApp
  delete global.wx
})

test('template list suppresses success and refresh after a pending lifecycle action loses authority', async () => {
  const pendingStatus = deferred()
  let currentUser = { role: 'super_admin', status: 'active' }
  let listCalls = 0
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser } })
  global.wx = {
    reLaunch: () => {},
    showModal: async () => ({ confirm: true }),
    showToast: options => toasts.push(options)
  }
  const page = loadPage('pages/admin-templates/index.js', {
    'services/templates.js': {
      listTemplates: async () => { listCalls += 1; return { items: [] } },
      changeTemplateStatus: () => pendingStatus.promise
    }
  })
  page.setData({ items: [{ _id: 't1', status: 'draft', version: 1 }] })

  const changing = page.changeStatus({ currentTarget: { dataset: { id: 't1' } } })
  await Promise.resolve()
  currentUser = { role: 'user', status: 'active' }
  pendingStatus.resolve({ template: { _id: 't1', status: 'enabled', version: 2 } })
  await changing

  assert.equal(toasts.length, 0)
  assert.equal(listCalls, 0)
  delete global.getApp
  delete global.wx
})

test('template editor discards active-account pages returned after demotion', async () => {
  const pendingUsers = deferred()
  let currentUser = { role: 'super_admin', status: 'active' }
  global.getApp = () => ({ globalData: { currentUser } })
  global.wx = { reLaunch: () => {} }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': {},
    'services/admin-users.js': { listUsers: () => pendingUsers.promise }
  })
  const originalOptions = [{ _id: 'old', displayName: 'existing user' }]
  page.setData({ assigneeOptions: originalOptions })

  const loading = page.loadActiveAccounts()
  currentUser = { role: 'user', status: 'active' }
  pendingUsers.resolve({ items: [{ _id: 'new', displayName: 'stale user' }], hasMore: false })
  const loaded = await loading

  assert.equal(loaded, false)
  assert.deepEqual(page.data.assigneeOptions, originalOptions)
  delete global.getApp
  delete global.wx
})

test('template editor discards a definition returned after demotion', async () => {
  const pendingTemplate = deferred()
  let currentUser = { role: 'super_admin', status: 'active' }
  global.getApp = () => ({ globalData: { currentUser } })
  global.wx = { reLaunch: () => {} }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': { getTemplate: () => pendingTemplate.promise },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  page.setData({ templateId: 't1', name: 'existing definition' })

  const loading = page.loadTemplate()
  currentUser = { role: 'user', status: 'active' }
  pendingTemplate.resolve({
    template: { _id: 't1', name: 'stale definition', description: '', status: 'disabled', version: 2 },
    nodes: [storedNode()]
  })
  const loaded = await loading

  assert.equal(loaded, null)
  assert.equal(page.data.name, 'existing definition')
  delete global.getApp
  delete global.wx
})

test('template editor suppresses success navigation when a pending save loses authority', async () => {
  const pendingSave = deferred()
  let currentUser = { role: 'super_admin', status: 'active' }
  const toasts = []
  const navigations = []
  global.getApp = () => ({ globalData: { currentUser } })
  global.wx = {
    reLaunch: () => {},
    showToast: options => toasts.push(options),
    navigateBack: options => navigations.push(options)
  }
  const page = loadPage('pages/admin-template-edit/index.js', {
    'services/templates.js': { updateTemplate: () => pendingSave.promise },
    'services/admin-users.js': { listUsers: async () => ({ items: [], hasMore: false }) }
  })
  page.setData({
    editMode: true,
    templateId: 't1',
    version: 1,
    name: 'valid template',
    nodes: [storedNode()]
  })

  const saving = page.submit()
  currentUser = { role: 'user', status: 'active' }
  pendingSave.resolve({ template: { _id: 't1', version: 2 } })
  await saving

  assert.equal(toasts.length, 0)
  assert.equal(navigations.length, 0)
  delete global.getApp
  delete global.wx
})

test('node editor commits a new node only once across rapid submit calls', async () => {
  let acceptedNodes = 0
  const navigations = []
  const previousPage = {
    getNodeEditorContext: () => ({
      readOnly: false,
      assigneeOptions: [{ _id: 'account-1', displayName: '甲', username: 'alpha' }],
      node: null
    }),
    acceptNodeFromEditor: () => { acceptedNodes += 1 }
  }
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.getCurrentPages = () => [previousPage, {}]
  global.wx = {
    setNavigationBarTitle: () => {},
    navigateBack: options => navigations.push(options),
    reLaunch: () => {}
  }
  const page = loadPage('pages/admin-template-node-edit/index.js')
  page.onLoad({ index: '-1' })
  page.setData({ name: '新增节点', processorUserIds: ['account-1'], reviewerUserIds: ['account-2'] })

  const first = page.submit()
  const second = page.submit()
  await Promise.all([first, second])

  assert.equal(acceptedNodes, 1)
  assert.deepEqual(navigations, [{ delta: 1 }])
  assert.equal(page.data.submitting, true)
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-node-edit/index.wxml'), 'utf8')
  assert.match(wxml, /bindtap="submit"[^>]*loading="{{submitting}}"[^>]*disabled="{{submitting}}"/)

  delete global.getApp
  delete global.getCurrentPages
  delete global.wx
})
