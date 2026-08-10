const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const miniProgramRoot = path.resolve(__dirname, '..')

function withFakeModule(relativePath, exports, callback) {
  const resolved = require.resolve(path.join(miniProgramRoot, relativePath))
  const original = require.cache[resolved]
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
  try { return callback() } finally {
    if (original) require.cache[resolved] = original
    else delete require.cache[resolved]
  }
}

function setByPath(target, key, value) {
  const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.')
  let owner = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (owner[segments[index]] === undefined) owner[segments[index]] = {}
    owner = owner[segments[index]]
  }
  owner[segments.at(-1)] = value
}

function loadPage(relativePath, businessFake) {
  const pagePath = path.join(miniProgramRoot, relativePath)
  let definition
  global.Page = value => { definition = value }
  try {
    withFakeModule('services/business.js', businessFake, () => {
      delete require.cache[require.resolve(pagePath)]
      require(pagePath)
    })
  } finally { delete global.Page }
  assert.ok(definition, `${relativePath} 应注册页面`)
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      for (const [key, value] of Object.entries(update)) setByPath(this.data, key, value)
    }
  }
}

function activeUser(role = 'user', id = 'account-current') {
  return { _id: id, role, status: 'active' }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function activeDetail() {
  return {
    line: {
      _id: 'line-1', code: 'YW-20260810-0001', name: '开户业务', description: '',
      status: 'active', version: 8, currentNodeId: 'node-2', progress: 50
    },
    nodes: [
      { _id: 'node-1', nodeCode: 'YW-20260810-0001-N001', name: '资料收集', sequence: 0, status: 'completed', version: 5 },
      { _id: 'node-2', nodeCode: 'YW-20260810-0001-N002', name: '资料审核', sequence: 1, status: 'ready', version: 3, assigneeUserIds: ['account-current'], canFeedback: true }
    ],
    canManage: true
  }
}

test('业务服务仅调用受保护的反馈、驳回、关闭和冻结修订动作', async () => {
  const calls = []
  const service = withFakeModule('utils/cloud.js', {
    callBusinessApi: async (action, payload) => { calls.push([action, payload]); return { ok: true } }
  }, () => {
    const file = path.join(miniProgramRoot, 'services/business.js')
    delete require.cache[require.resolve(file)]
    return require(file)
  })

  await service.registerEvidenceUpload({ fileId: 'cloud://e/a' })
  await service.getEvidenceAccess('evidence-1')
  await service.submitFeedback({ nodeId: 'node-1' })
  await service.rejectPreviousNode({ currentNodeId: 'node-2' })
  await service.closeBusinessLine({ businessLineId: 'line-1' })
  await service.listFrozenBusinessesForAdmin({ keyword: '开户' })
  await service.getFrozenBusinessForAdmin('line-1')
  await service.amendFrozenBusiness({ businessLineId: 'line-1' })

  assert.deepEqual(calls, [
    ['registerEvidenceUpload', { fileId: 'cloud://e/a' }],
    ['getEvidenceAccess', { evidenceId: 'evidence-1' }],
    ['submitFeedback', { nodeId: 'node-1' }],
    ['rejectPreviousNode', { currentNodeId: 'node-2' }],
    ['closeBusinessLine', { businessLineId: 'line-1' }],
    ['listFrozenBusinessesForAdmin', { keyword: '开户' }],
    ['getFrozenBusinessForAdmin', { businessLineId: 'line-1' }],
    ['amendFrozenBusiness', { businessLineId: 'line-1' }]
  ])
})

test('业务详情只用标识打开节点，并仅向当前节点负责人显示紧邻驳回表单', async () => {
  const navigations = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { navigateTo: options => navigations.push(options), showToast: () => {} }
  const page = loadPage('pages/business-detail/index.js', {
    getBusinessLine: async () => activeDetail()
  })
  page.onLoad({ id: 'line-1' })
  await page.loadDetail()

  page.openFeedback({ currentTarget: { dataset: { index: 1 } } })
  assert.deepEqual(navigations, [{ url: '/pages/node-feedback/index?lineId=line-1&nodeId=node-2' }])
  assert.equal(page.data.canRejectPrevious, true)
  assert.equal(page.data.previousNode._id, 'node-1')

  const notAssignee = activeDetail()
  notAssignee.nodes[1].assigneeUserIds = ['another-account']
  page.setData(page.presentDetail(notAssignee))
  assert.equal(page.data.canRejectPrevious, false)
})

test('驳回原因必填，成功后清空；版本冲突先刷新再允许重试', async () => {
  const calls = []
  const toasts = []
  let detail = activeDetail()
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { showToast: options => toasts.push(options) }
  const page = loadPage('pages/business-detail/index.js', {
    getBusinessLine: async () => { calls.push(['reload']); return detail },
    rejectPreviousNode: async input => {
      calls.push(['reject', input])
      if (calls.filter(item => item[0] === 'reject').length === 1) {
        detail = activeDetail()
        detail.line.version = 9
        detail.nodes[0].version = 6
        detail.nodes[1].version = 4
        const error = new Error('版本已变化')
        error.code = 'VERSION_CONFLICT'
        throw error
      }
      return { lineVersion: 10 }
    }
  })
  page.onLoad({ id: 'line-1' })
  await page.loadDetail()
  await page.rejectPrevious()
  assert.match(toasts.at(-1).title, /原因/)

  page.onRejectionReason({ detail: { value: ' 上一步材料存在疑问 ' } })
  await page.rejectPrevious()
  assert.equal(calls.at(-1)[0], 'reload')
  assert.equal(page.data.rejectionReason, ' 上一步材料存在疑问 ')

  await page.rejectPrevious()
  const rejectionCalls = calls.filter(item => item[0] === 'reject')
  assert.equal(rejectionCalls[0][1].expectedCurrentVersion, 3)
  assert.equal(rejectionCalls[0][1].expectedPreviousVersion, 5)
  assert.equal(rejectionCalls[1][1].expectedCurrentVersion, 4)
  assert.equal(rejectionCalls[1][1].expectedPreviousVersion, 6)
  assert.equal(rejectionCalls[0][1].requestKey, rejectionCalls[1][1].requestKey)
  assert.equal(page.data.rejectionReason, '')
})

test('业务线管理员以必填原因关闭进行中业务，冻结业务仅超级管理员出现修订入口', async () => {
  const calls = []
  const toasts = []
  const navigations = []
  const app = { globalData: { currentUser: activeUser() } }
  global.getApp = () => app
  global.wx = { showToast: options => toasts.push(options), navigateTo: options => navigations.push(options) }
  const page = loadPage('pages/business-detail/index.js', {
    getBusinessLine: async () => activeDetail(),
    closeBusinessLine: async input => { calls.push(input); return { status: input.outcome, version: 9 } }
  })
  page.onLoad({ id: 'line-1' })
  await page.loadDetail()
  await page.closeLine()
  assert.match(toasts.at(-1).title, /原因/)

  page.onClosureOutcome({ detail: { value: 1 } })
  page.onClosureReason({ detail: { value: '客户终止办理' } })
  await page.closeLine()
  assert.deepEqual(calls, [{ businessLineId: 'line-1', expectedVersion: 8, outcome: 'closed', reason: '客户终止办理' }])

  const frozen = activeDetail()
  frozen.line.status = 'completed'
  frozen.line.version = 9
  app.globalData.currentUser = activeUser('super_admin', 'root')
  page.setData(page.presentDetail(frozen))
  assert.equal(page.data.frozen, true)
  assert.equal(page.data.showAmendmentEntry, true)
  page.openAmendment()
  assert.deepEqual(navigations, [{ url: '/pages/admin-business-amend/index?id=line-1' }])
})

test('超级管理员可全局检索冻结业务、查看修订前后值并提交专用修订', async () => {
  const calls = []
  const navigations = []
  global.getApp = () => ({ globalData: { currentUser: activeUser('super_admin', 'root') } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: options => navigations.push(options),
    showToast: () => {},
    navigateBack: () => {}
  }
  const page = loadPage('pages/admin-business-amend/index.js', {
    listFrozenBusinessesForAdmin: async query => {
      calls.push(['list', query])
      return { items: [{ _id: 'line-frozen', code: 'YW-1', name: '冻结业务', status: 'completed', version: 9 }], total: 1 }
    },
    getFrozenBusinessForAdmin: async id => {
      calls.push(['detail', id])
      return {
        line: { _id: id, code: 'YW-1', name: '冻结业务', description: '原说明', plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-05', status: 'completed', version: 9 },
        amendments: [{ amendmentId: 'amend-9', reason: '历史更正', before: { description: '旧说明' }, after: { description: '原说明' }, beforeVersion: 8, afterVersion: 9 }]
      }
    },
    amendFrozenBusiness: async input => { calls.push(['amend', input]); return { version: 10 } }
  })

  await page.onLoad({})
  page.onKeyword({ detail: { value: '冻结' } })
  await page.search()
  await page.selectBusiness({ currentTarget: { dataset: { id: 'line-frozen' } } })
  assert.equal(page.data.amendments[0].beforeText.includes('旧说明'), true)
  assert.equal(page.data.amendments[0].afterText.includes('原说明'), true)

  page.onFormInput({ currentTarget: { dataset: { field: 'description' } }, detail: { value: '审计更正后的说明' } })
  page.onReason({ detail: { value: '核对纸质材料后更正' } })
  await page.submit()
  const amendment = calls.find(item => item[0] === 'amend')[1]
  assert.deepEqual(amendment, {
    businessLineId: 'line-frozen', expectedVersion: 9,
    reason: '核对纸质材料后更正',
    changes: { description: '审计更正后的说明' },
    evidenceIds: []
  })
  assert.equal(page.data.reason, '')

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-business-amend/index.wxml'), 'utf8')
  assert.match(wxml, /修订前/)
  assert.match(wxml, /修订后/)
  assert.match(wxml, /reason/)
  assert.match(wxml, /冻结业务/)
})

test('超级管理员修订附件使用专用用途登记并只提交凭证标识', async () => {
  let amendment
  const registrations = []
  global.getApp = () => ({ globalData: { currentUser: activeUser('super_admin', 'root') } })
  global.wx = {
    setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('超级管理员不应重定向'), showToast: () => {},
    cloud: { uploadFile: async () => ({ fileID: 'cloud://env/amendment.pdf' }) }
  }
  const page = loadPage('pages/admin-business-amend/index.js', {
    getFrozenBusinessForAdmin: async id => ({
      line: { _id: id, code: 'YW-1', name: '冻结业务', description: '', plannedStartDate: '', plannedEndDate: '', status: 'completed', version: 9 },
      nodes: [], amendments: []
    }),
    registerEvidenceUpload: async input => { registrations.push(input); return { evidenceId: 'evidence-amend' } },
    amendFrozenBusiness: async input => { amendment = input; return { version: 10 } }
  })
  await page.onLoad({ id: 'line-frozen' })
  page.setData({
    reason: '追加审计附件',
    files: [{ localKey: 'f-1', name: '更正.pdf', path: 'wxfile://更正.pdf', size: 1024, category: 'pdf', extension: 'pdf', status: 'pending', evidenceId: '' }],
    totalBytes: 1024
  })
  await page.submit()

  assert.deepEqual(registrations, [{
    businessLineId: 'line-frozen', nodeId: null, purpose: 'audit_amendment',
    fileId: 'cloud://env/amendment.pdf', fileName: '更正.pdf', declaredSize: 1024
  }])
  assert.deepEqual(amendment.evidenceIds, ['evidence-amend'])
  assert.deepEqual(amendment.changes, {})
})

test('普通用户不能打开超级管理员冻结修订页', async () => {
  const launches = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/admin-business-amend/index.js', {})
  await page.onLoad({ id: 'line-frozen' })
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])
})

test('驳回和审计修订等待期间账号降权时不写回旧账号成功状态', async () => {
  const rejectPending = deferred()
  const amendPending = deferred()
  const launches = []
  const toasts = []
  const app = { globalData: { currentUser: activeUser('user', 'account-current') } }
  global.getApp = () => app
  global.wx = {
    reLaunch: options => launches.push(options),
    showToast: options => toasts.push(options),
    setNavigationBarTitle: () => {}
  }
  const detailPage = loadPage('pages/business-detail/index.js', {
    getBusinessLine: async () => activeDetail(),
    rejectPreviousNode: () => rejectPending.promise
  })
  detailPage.onLoad({ id: 'line-1' })
  await detailPage.loadDetail()
  detailPage.setData({ rejectionReason: '需要返工' })
  const rejection = detailPage.rejectPrevious()
  app.globalData.currentUser = activeUser('user', 'another-account')
  rejectPending.resolve({ lineVersion: 9 })
  await rejection
  assert.equal(toasts.some(item => item.title === '已驳回上一节点'), false)

  app.globalData.currentUser = activeUser('super_admin', 'root')
  const amendPage = loadPage('pages/admin-business-amend/index.js', {
    getFrozenBusinessForAdmin: async id => ({
      line: { _id: id, name: '冻结业务', description: '', status: 'completed', version: 9 }, nodes: [], amendments: []
    }),
    amendFrozenBusiness: () => amendPending.promise
  })
  await amendPage.onLoad({ id: 'line-frozen' })
  amendPage.setData({ reason: '更正', 'form.description': '新说明' })
  const amendment = amendPage.submit()
  app.globalData.currentUser = activeUser('user', 'root')
  amendPending.resolve({ version: 10 })
  await amendment
  assert.equal(toasts.some(item => item.title === '审计式修订已保存'), false)
  assert.equal(launches.length >= 2, true)
})
