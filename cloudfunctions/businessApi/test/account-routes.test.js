const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { APPLICATION_ERROR_MARKER } = require('../lib/cloud-template-repository')
const { createFeedbackService } = require('../lib/feedback-service')

const originalLoad = Module._load
const defaultFake = createFakeCloudDatabase({
  system_settings: [{ _id: 'account_admin_state', activeSuperAdminCount: 1, revision: 0 }]
})
Module._load = function loadWithCloudStub(request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database: () => defaultFake.db,
      downloadFile: async () => ({ fileContent: Buffer.from('%PDF') }),
      getTempFileURL: async () => ({ fileList: [] }),
      getWXContext: () => ({ OPENID: 'wx-default', REQUESTID: 'default-request' })
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { createBusinessApi, createDefaultLegacyRoutes, isPublicAction, main } = require('../index')
Module._load = originalLoad

test('部署手册与审核查询、触发器和实际日历集合保持契约一致', () => {
  const repositoryRoot = path.resolve(__dirname, '../../..')
  const manual = fs.readFileSync(path.join(repositoryRoot, 'docs/deployment/template-node-fields-setup.md'), 'utf8')
  const reminderSource = fs.readFileSync(path.join(repositoryRoot,
    'cloudfunctions/workflowReminder/lib/cloud-reminder-repository.js'), 'utf8')
  const reviewSource = fs.readFileSync(path.join(repositoryRoot,
    'cloudfunctions/businessApi/lib/cloud-review-repository.js'), 'utf8')

  assert.doesNotMatch(manual, /evidence-retention-daily|evidenceRetention[\s\S]{0,120}(Cron|timer)/)
  for (const collection of ['work_calendar_entries', 'work_calendar_years', 'calendar_sync_requests']) {
    assert.match(manual, new RegExp('`' + collection + '`'))
  }
  for (const index of [
    'reviewerUserIds` 升序、`status` 升序、`createdAt` 降序、`_id` 升序',
    'reviewRoundId` 升序、`createdAt` 升序、`_id` 升序',
    'workflowMode` 升序、`processingDueStatus` 升序、`_id` 升序',
    'status` 升序、`reviewDueStatus` 升序、`_id` 升序',
    'processingDueStatus` 升序、`_id` 升序',
    'reviewDueStatus` 升序、`_id` 升序',
    'recipientUserIds` 升序、`createdAt` 降序、`_id` 升序',
    'audienceRole` 升序、`createdAt` 降序、`_id` 升序'
  ]) assert.match(manual, new RegExp(index.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  assert.match(reminderSource, /workflowMode: 'review', processingDueStatus: 'calculated'/)
  assert.match(reminderSource, /status: 'pending', reviewDueStatus: 'calculated'/)
  assert.match(reviewSource, /reviewerUserIds: account\._id, status: 'pending'/)
  assert.match(reviewSource, /where\(\{ reviewRoundId \}\)[\s\S]*?orderBy\('createdAt', 'asc'\)[\s\S]*?orderBy\('_id', 'asc'\)/)
})

test('only session and credential-establishment actions are public', () => {
  assert.equal(isPublicAction('getSession'), true)
  assert.equal(isPublicAction('bootstrap'), true)
  assert.equal(isPublicAction('login'), true)
  assert.equal(isPublicAction('completeFirstLogin'), true)
  assert.equal(isPublicAction('initializeSuperAdmin'), true)
  assert.equal(isPublicAction('recoverSuperAdmin'), true)
  assert.equal(isPublicAction('getPublicNodeShare'), true)
  assert.equal(isPublicAction('dashboard'), false)
  assert.equal(isPublicAction('listUsers'), false)
})

test('deployed getSession wiring returns an unauthenticated session without auto-creating a user', async () => {
  const result = await main({ action: 'getSession', payload: {} })
  assert.equal(result.ok, true)
  assert.equal(result.data.authenticated, false)
  assert.equal(defaultFake.documents('users').length, 0)
})

function createRouteHarness({
  user,
  credential,
  protectedRoutes,
  templateService,
  businessService,
  businessLifecycleService,
  evidenceService,
  evidenceUploadService,
  feedbackService,
  reviewService,
  operationsService,
  shareService,
  recognitionService,
  dashboardWorkspaceService,
  calendarAdminService,
  legacyRoutes,
  contextOpenid = 'wx-context'
} = {}) {
  const calls = []
  const errors = []
  const repository = {
    async findUserByOpenid(openid) {
      calls.push(['findUserByOpenid', openid])
      return user === undefined
        ? { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound' }
        : user
    },
    async findCredential(userId) {
      calls.push(['findCredential', userId])
      return credential === undefined
        ? { userId, mustChangePassword: false, lockedUntil: null }
        : credential
    }
  }
  const method = name => async input => {
    calls.push([name, input])
    return { route: name, input }
  }
  const authService = {
    getSession: method('getSession'),
    login: method('login'),
    completeFirstLogin: method('completeFirstLogin'),
    changePassword: method('changePassword'),
    initializeSuperAdmin: method('initializeSuperAdmin'),
    recoverSuperAdmin: method('recoverSuperAdmin')
  }
  const api = createBusinessApi({
    repository,
    authService,
    adminUserService: {
      listUsers: method('listUsers'),
      createUser: method('createUser'),
      updateUser: method('updateUser'),
      resetUserPassword: method('resetUserPassword'),
      unlockUser: method('unlockUser'),
      unbindWechat: method('unbindWechat')
    },
    legacyRoutes: legacyRoutes || {
      dashboard: (openid, payload) => method('dashboard')({ openid, payload })
    },
    templateService,
    businessService,
    businessLifecycleService,
    evidenceService,
    evidenceUploadService,
    feedbackService,
    reviewService,
    operationsService,
    shareService,
    recognitionService,
    dashboardWorkspaceService,
    calendarAdminService,
    protectedRoutes,
    getContext: () => ({ OPENID: contextOpenid, REQUESTID: 'request-1' }),
    clock: () => Date.parse('2026-08-06T00:00:00.000Z'),
    logger: { error: (...args) => errors.push(args) }
  })
  return { api, authService, calls, errors }
}

test('公开分享读取无需登录而创建分享必须使用当前活动账号', async () => {
  const calls = []
  const shareService = {
    async getPublicNodeShare(input) { calls.push(['get', input]); return { title: '公开快照' } },
    async createNodeShareSnapshot(input) { calls.push(['create', input]); return { path: '/share' } }
  }
  const publicHarness = createRouteHarness({ user: null, credential: null, shareService, contextOpenid: '' })
  const publicResult = await publicHarness.api.main({
    action: 'getPublicNodeShare', payload: { token: Buffer.alloc(32, 1).toString('base64url'), cursor: '', pageSize: 40 }
  })
  assert.equal(publicResult.ok, true)
  assert.equal(calls[0][1].actor, undefined)

  const protectedHarness = createRouteHarness({ shareService })
  const created = await protectedHarness.api.main({
    action: 'createNodeShareSnapshot', payload: {
      businessLineId: 'line-1', nodeId: 'node-1', requestKey: 'share-request-1',
      actorId: 'forged', openid: 'wx-forged'
    }
  })
  assert.equal(created.ok, true)
  assert.equal(calls[1][1].actor._id, 'actor-1')
  assert.deepEqual(calls[1][1].input, {
    businessLineId: 'line-1', nodeId: 'node-1', requestKey: 'share-request-1'
  })
})

test('审核与通知路由只传递解析后的当前账号和白名单输入', async () => {
  const calls = []
  const reviewService = Object.fromEntries([
    'submitNodeForReview', 'submitReviewVote', 'listMyPendingReviews',
    'getReviewDetail', 'listMyNotifications', 'markNotificationRead'
  ].map(name => [name, async input => {
    calls.push([name, input])
    return { action: name }
  }]))
  const harness = createRouteHarness({ reviewService })
  const identity = { actorId: 'forged', openid: 'wx-forged', role: 'super_admin' }

  for (const [action, payload] of [
    ['submitNodeForReview', {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4,
      requestKey: 'submit-1', ...identity
    }],
    ['submitReviewVote', {
      reviewRoundId: 'round-1', expectedRoundVersion: 2, decision: 'approve',
      comment: '', requestKey: 'vote-1', ...identity
    }],
    ['listMyPendingReviews', { page: 1, pageSize: 20, ...identity }],
    ['getReviewDetail', { reviewRoundId: 'round-1', ...identity }],
    ['listMyNotifications', { page: 2, pageSize: 10, ...identity }],
    ['markNotificationRead', { notificationId: 'notification-1', ...identity }]
  ]) {
    const result = await harness.api.main({ action, payload })
    assert.equal(result.ok, true)
  }

  const actor = {
    _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
  }
  assert.deepEqual(calls, [
    ['submitNodeForReview', { actor, input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4, requestKey: 'submit-1'
    } }],
    ['submitReviewVote', { actor, input: {
      reviewRoundId: 'round-1', expectedRoundVersion: 2,
      decision: 'approve', comment: '', requestKey: 'vote-1'
    } }],
    ['listMyPendingReviews', { actor, query: { page: 1, pageSize: 20 } }],
    ['getReviewDetail', { actor, reviewRoundId: 'round-1' }],
    ['listMyNotifications', { actor, query: { page: 2, pageSize: 10 } }],
    ['markNotificationRead', { actor, notificationId: 'notification-1' }]
  ])
})

test('节点文本识别路由只传递当前活动账号与白名单输入', async () => {
  const calls = []
  const harness = createRouteHarness({
    recognitionService: {
      async recognize(input) { calls.push(input); return { candidates: [] } }
    }
  })
  const payload = {
    businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
    text: '客户：张三', requestKey: 'request_1234567890123456', actorId: 'forged', openid: 'wx-forged'
  }
  const result = await harness.api.main({ action: 'recognizeNodeText', payload })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{
    actor: { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound' },
    input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
      text: '客户：张三', requestKey: 'request_1234567890123456'
    }
  }])

  const invalid = await harness.api.main({
    action: 'recognizeNodeText', payload: { ...payload, unknown: 'must-fail' }
  })
  assert.equal(invalid.code, 'VALIDATION_ERROR')
})

test('审核路由拒绝身份字段以外的未知输入且未知异常保持通用响应', async () => {
  const reviewService = {
    async getReviewDetail() { throw new Error('collection node_review_rounds index internals') }
  }
  const harness = createRouteHarness({ reviewService })
  const invalid = await harness.api.main({
    action: 'getReviewDetail', payload: { reviewRoundId: 'round-1', secretExtra: 'leak-me' }
  })
  assert.equal(invalid.code, 'VALIDATION_ERROR')
  assert.doesNotMatch(JSON.stringify(harness.errors), /leak-me/)

  const failed = await harness.api.main({
    action: 'getReviewDetail', payload: { reviewRoundId: 'round-1' }
  })
  assert.deepEqual(failed, { ok: false, code: 'INTERNAL_ERROR', message: 'Service error' })
  assert.doesNotMatch(JSON.stringify(harness.errors), /node_review_rounds|index internals/)
})

test('public account routes use trusted context and bootstrap remains only a getSession alias', async () => {
  const harness = createRouteHarness({ user: null, credential: null })
  const bootstrap = await harness.api.main({ action: 'bootstrap', payload: { openid: 'forged' } })
  const login = await harness.api.main({ action: 'login', payload: { openid: 'forged', username: 'user01', password: 'secret' } })
  const recovery = await harness.api.main({ action: 'recoverSuperAdmin', payload: { username: 'root' } })

  assert.equal(bootstrap.ok, true)
  assert.equal(bootstrap.data.route, 'getSession')
  assert.equal(bootstrap.data.input.openid, 'wx-context')
  assert.equal(login.data.input.openid, 'wx-context')
  assert.equal(recovery.data.input.openid, undefined)
  assert.equal(harness.calls.some(call => call[0] === 'findUserByOpenid'), false)
})

test('protected account and legacy routes receive the resolved actor and its bound OpenID', async () => {
  const harness = createRouteHarness()
  const listed = await harness.api.main({ action: 'listUsers', payload: { page: 2, pageSize: 10 } })
  const dashboard = await harness.api.main({ action: 'dashboard', payload: { ignored: true } })

  assert.equal(listed.ok, true)
  assert.equal(listed.data.input.actor._id, 'actor-1')
  assert.deepEqual(listed.data.input.query, { page: 2, pageSize: 10 })
  assert.equal(dashboard.data.input.openid, 'wx-bound')
  assert.deepEqual(dashboard.data.input.payload, { ignored: true })
})

test('changePassword ignores a forged payload actor and uses the trusted resolved account', async () => {
  const harness = createRouteHarness()
  const result = await harness.api.main({
    action: 'changePassword',
    payload: {
      actor: { _id: 'forged-user', username: 'victim' },
      currentPassword: 'KnownPass8',
      newPassword: 'ChangedPass9'
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.input.actor._id, 'actor-1')
  assert.equal(result.data.input.currentPassword, 'KnownPass8')
})

test('人工日历同步路由只传入可信账号且忽略客户端伪造身份与时间', async () => {
  const calls = []
  const harness = createRouteHarness({
    calendarAdminService: { async sync(input) { calls.push(input); return { accepted: true } } }
  })
  const result = await harness.api.main({ action: 'syncWorkCalendar', payload: { actor: { role: 'super_admin' }, now: '2039-01-01' } })
  assert.deepEqual(result, { ok: true, data: { accepted: true } })
  assert.equal(calls[0].actor._id, 'actor-1')
  assert.equal(Object.hasOwn(calls[0], 'now'), false)
})

test('protected domain routes receive the resolved actor and payload separately', async () => {
  const calls = []
  const activeUser = { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active' }
  const harness = createRouteHarness({
    user: activeUser,
    protectedRoutes: {
      listTemplates: async ({ actor, payload }) => {
        calls.push({ actorId: actor._id, forged: payload.actorId })
        return { items: [] }
      }
    }
  })
  const result = await harness.api.main({ action: 'listTemplates', payload: { actorId: 'forged' } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{ actorId: activeUser._id, forged: 'forged' }])
})

test('protected domain routes require an authenticated actor', async () => {
  let called = false
  const harness = createRouteHarness({
    user: null,
    credential: null,
    protectedRoutes: {
      listTemplates: async () => {
        called = true
        return { items: [] }
      }
    }
  })
  const result = await harness.api.main({ action: 'listTemplates', payload: {} })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UNAUTHORIZED')
  assert.equal(called, false)
})

test('default template routes pass trusted actors and exact payload contracts to the service', async () => {
  const serviceCalls = []
  const templateMethod = name => async input => {
    serviceCalls.push([name, input])
    return { name }
  }
  const templateService = {
    listTemplates: templateMethod('listTemplates'),
    getTemplate: templateMethod('getTemplate'),
    createTemplate: templateMethod('createTemplate'),
    updateTemplate: templateMethod('updateTemplate'),
    changeTemplateStatus: templateMethod('changeTemplateStatus'),
    deleteTemplate: templateMethod('deleteTemplate'),
    listEnabledTemplates: templateMethod('listEnabledTemplates')
  }
  const harness = createRouteHarness({ templateService })
  const definition = { name: '模板', nodes: [] }

  for (const [action, payload] of [
    ['listTemplates', { status: 'draft' }],
    ['getTemplate', { templateId: 't1' }],
    ['createTemplate', definition],
    ['updateTemplate', { templateId: 't1', expectedVersion: 2, definition }],
    ['changeTemplateStatus', { templateId: 't1', expectedVersion: 3, status: 'enabled' }],
    ['deleteTemplate', { templateId: 't1', expectedVersion: 4 }],
    ['listEnabledTemplates', { ignored: true }]
  ]) {
    const result = await harness.api.main({ action, payload })
    assert.equal(result.ok, true)
  }

  const actor = { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound' }
  assert.deepEqual(serviceCalls, [
    ['listTemplates', { actor, query: { status: 'draft' } }],
    ['getTemplate', { actor, templateId: 't1' }],
    ['createTemplate', { actor, input: definition }],
    ['updateTemplate', { actor, templateId: 't1', expectedVersion: 2, input: definition }],
    ['changeTemplateStatus', { actor, templateId: 't1', expectedVersion: 3, status: 'enabled' }],
    ['deleteTemplate', { actor, templateId: 't1', expectedVersion: 4 }],
    ['listEnabledTemplates', { actor }]
  ])
})

test('the template-backed business route delegates generated creation to the trusted service boundary', async () => {
  const calls = []
  const businessService = {
    async createFromTemplate(input) {
      calls.push(input)
      return { id: 'business-1', code: 'BL-20260807-0001' }
    }
  }
  const harness = createRouteHarness({ businessService })
  const payload = {
    templateId: 'template-1',
    name: '新业务',
    description: '',
    plannedStartDate: '2026-08-08',
    plannedEndDate: '2026-08-12',
    requestKey: 'request-001',
    actorId: 'forged-actor',
    code: 'CLIENT-CODE',
    nodes: [{ name: '客户端节点' }]
  }
  const result = await harness.api.main({ action: 'createBusinessFromTemplate', payload })

  assert.deepEqual(result, {
    ok: true,
    data: { id: 'business-1', code: 'BL-20260807-0001' }
  })
  assert.deepEqual(calls, [{
    actor: {
      _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
    },
    input: payload
  }])
})

test('business list and detail routes pass the trusted actor to the dual-schema read service', async () => {
  const calls = []
  const businessService = {
    async listBusinessLines(input) {
      calls.push(['listBusinessLines', input])
      return { items: [] }
    },
    async getBusinessLine(input) {
      calls.push(['getBusinessLine', input])
      return { line: { _id: input.lineId }, nodes: [] }
    },
    async createFromTemplate() {
      throw new Error('not called')
    }
  }
  const harness = createRouteHarness({ businessService })
  await harness.api.main({ action: 'listBusinessLines', payload: { page: 2 } })
  await harness.api.main({ action: 'getBusinessLine', payload: { id: 'business-1' } })

  const actor = {
    _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
  }
  assert.deepEqual(calls, [
    ['listBusinessLines', { actor, query: { page: 2 } }],
    ['getBusinessLine', { actor, lineId: 'business-1' }]
  ])
})

test('售后检索路由只传递白名单查询字段和受信账号', async () => {
  const calls = []
  const businessService = {
    async listBusinessLines(input) { calls.push(input); return { items: [], total: null } }
  }
  const harness = createRouteHarness({ businessService })
  await harness.api.main({
    action: 'listBusinessLines',
    payload: {
      keyword: '客户 合同', pageSize: 10, cursor: 'safe',
      actorId: 'forged', role: 'super_admin', visibleBusinessLineIds: ['foreign']
    }
  })
  assert.deepEqual(calls, [{
    actor: {
      _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
    },
    query: { keyword: '客户 合同', pageSize: 10, cursor: 'safe' }
  }])
})

test('待处理与概览路由剥离客户端身份并委托受保护服务', async () => {
  const calls = []
  const businessService = {
    async listMyPendingProcessing(input) {
      calls.push(['listMyPendingProcessing', input])
      return { items: [] }
    },
    async getMyDashboardSummary(input) {
      calls.push(['getMyDashboardSummary', input])
      return { stats: {} }
    }
  }
  const harness = createRouteHarness({ businessService })
  await harness.api.main({
    action: 'listMyPendingProcessing',
    payload: { cursor: '', pageSize: 20, actorId: 'forged' }
  })
  await harness.api.main({ action: 'getMyDashboardSummary', payload: { actor: { _id: 'forged' } } })

  const actor = {
    _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
  }
  assert.deepEqual(calls, [
    ['listMyPendingProcessing', { actor, query: { cursor: '', pageSize: 20 } }],
    ['getMyDashboardSummary', { actor }]
  ])
})

test('运营看板与导出路由只传递受信管理员及白名单日期分页参数', async () => {
  const calls = []
  const operationsService = {
    async getDashboard(input) { calls.push(['getOperationsDashboard', input]); return { stats: {} } },
    async exportRows(input) { calls.push(['exportOperationsRows', input]); return { items: [] } },
    async listTimingDetails(input) { calls.push(['listOperationsTimingDetails', input]); return { items: [] } },
    async getAnalyticsFilters(input) { calls.push(['getOperationsAnalyticsFilters', input]); return { templates: [] } },
    async getAnalyticsSummary(input) { calls.push(['getOperationsAnalyticsSummary', input]); return { nodeSeries: [] } },
    async listAnalyticsSamples(input) { calls.push(['listOperationsAnalyticsSamples', input]); return { items: [] } }
  }
  const harness = createRouteHarness({ operationsService })
  await harness.api.main({
    action: 'getOperationsDashboard',
    payload: { startDate: '2026-08-01', endDate: '2026-08-17', actorId: 'forged' }
  })
  await harness.api.main({
    action: 'exportOperationsRows',
    payload: { startDate: '2026-08-01', endDate: '2026-08-17', cursor: '', pageSize: 50, role: 'forged' }
  })
  await harness.api.main({
    action: 'listOperationsTimingDetails',
    payload: { startDate: '2026-08-01', endDate: '2026-08-17', cursor: '', pageSize: 20, actorId: 'forged' }
  })
  await harness.api.main({
    action: 'getOperationsAnalyticsSummary',
    payload: { templateId: 'template-1', grain: 'week', processorToken: 'a'.repeat(64), actorId: 'forged' }
  })
  const actor = { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound' }
  assert.deepEqual(calls, [
    ['getOperationsDashboard', { actor, query: { startDate: '2026-08-01', endDate: '2026-08-17' } }],
    ['exportOperationsRows', { actor, query: { startDate: '2026-08-01', endDate: '2026-08-17', cursor: '', pageSize: 50 } }],
    ['listOperationsTimingDetails', { actor, query: { startDate: '2026-08-01', endDate: '2026-08-17', cursor: '', pageSize: 20 } }],
    ['getOperationsAnalyticsSummary', { actor, query: { templateId: 'template-1', grain: 'week', processorToken: 'a'.repeat(64) } }]
  ])
})

test('business metadata update route delegates a trusted actor and exact optimistic payload', async () => {
  const calls = []
  const businessService = {
    async updateMetadata(input) {
      calls.push(input)
      return { id: 'business-1', version: 5 }
    }
  }
  const harness = createRouteHarness({ businessService })
  const payload = {
    businessLineId: 'business-1', expectedVersion: 4,
    name: '新名称', description: '', plannedStartDate: '', plannedEndDate: '',
    actorId: 'forged'
  }
  const result = await harness.api.main({ action: 'updateBusinessMetadata', payload })

  assert.deepEqual(result, { ok: true, data: { id: 'business-1', version: 5 } })
  assert.deepEqual(calls, [{
    actor: {
      _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
    },
    input: payload
  }])
})

test('上一节点驳回路由只使用受信账号并原样交给生命周期服务校验', async () => {
  const calls = []
  const businessLifecycleService = {
    async rejectPreviousNode(input) {
      calls.push(input)
      return { businessLineId: 'line-1', previousNodeId: 'node-1', currentNodeId: 'node-2' }
    }
  }
  const harness = createRouteHarness({ businessLifecycleService })
  const payload = {
    businessLineId: 'line-1', currentNodeId: 'node-2',
    expectedCurrentVersion: 3, expectedPreviousVersion: 5,
    reason: '资料需补充', requestKey: 'reject-route-001',
    actor: { _id: 'forged' }
  }

  const result = await harness.api.main({ action: 'rejectPreviousNode', payload })

  assert.deepEqual(result, {
    ok: true,
    data: { businessLineId: 'line-1', previousNodeId: 'node-1', currentNodeId: 'node-2' }
  })
  assert.deepEqual(calls, [{
    actor: {
      _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
    },
    input: payload
  }])
})

test('业务关闭路由只使用受信账号并交由生命周期服务限制终态', async () => {
  const calls = []
  const businessLifecycleService = {
    async closeBusinessLine(input) {
      calls.push(input)
      return { businessLineId: 'line-1', status: 'closed', version: 9 }
    }
  }
  const harness = createRouteHarness({ businessLifecycleService })
  const payload = {
    businessLineId: 'line-1', expectedVersion: 8,
    outcome: 'closed', reason: '业务终止', actorId: 'forged'
  }
  const result = await harness.api.main({ action: 'closeBusinessLine', payload })

  assert.deepEqual(result, {
    ok: true, data: { businessLineId: 'line-1', status: 'closed', version: 9 }
  })
  assert.deepEqual(calls, [{
    actor: {
      _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
    },
    input: payload
  }])
})

test('冻结业务修订路由只使用受信账号并交由专用审计服务处理', async () => {
  const calls = []
  const businessLifecycleService = {
    async amendFrozenBusiness(input) {
      calls.push(input)
      return { businessLineId: 'line-1', amendmentId: 'business-amend-line-1-10', version: 10 }
    }
  }
  const harness = createRouteHarness({ businessLifecycleService })
  const payload = {
    businessLineId: 'line-1', expectedVersion: 9,
    reason: '审计修订', changes: { name: '更正名称' }, evidenceIds: ['evidence-1'],
    actorId: 'forged'
  }
  const result = await harness.api.main({ action: 'amendFrozenBusiness', payload })

  assert.deepEqual(result, {
    ok: true,
    data: { businessLineId: 'line-1', amendmentId: 'business-amend-line-1-10', version: 10 }
  })
  assert.deepEqual(calls, [{
    actor: {
      _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
    },
    input: payload
  }])
})

test('冻结业务管理查询路由只传递受信超级管理员和显式查询参数', async () => {
  const calls = []
  const businessLifecycleService = {
    async listFrozenBusinessesForAdmin(input) {
      calls.push(['list', input])
      return { items: [], total: 0 }
    },
    async getFrozenBusinessForAdmin(input) {
      calls.push(['detail', input])
      return { line: { _id: input.businessLineId }, nodes: [], amendments: [] }
    }
  }
  const harness = createRouteHarness({ businessLifecycleService })
  await harness.api.main({ action: 'listFrozenBusinessesForAdmin', payload: { keyword: '冻结', page: 1, pageSize: 10, actorId: 'forged' } })
  await harness.api.main({ action: 'getFrozenBusinessForAdmin', payload: { businessLineId: 'line-1', actorId: 'forged' } })
  const actor = { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound' }
  assert.deepEqual(calls, [
    ['list', { actor, query: { keyword: '冻结', page: 1, pageSize: 10, actorId: 'forged' } }],
    ['detail', { actor, businessLineId: 'line-1' }]
  ])
})

test('default evidence routes delegate trusted actors and exact registration/access contracts', async () => {
  const calls = []
  const evidenceService = {
    async registerUpload(input) {
      calls.push(['registerUpload', input])
      return {
        evidenceId: 'evidence-1',
        metadata: { fileName: 'report.pdf', category: 'pdf', size: 100 }
      }
    },
    async getAccessGrant(input) {
      calls.push(['getAccessGrant', input])
      return {
        url: 'https://temporary.example/report.pdf', fileName: 'report.pdf', category: 'pdf',
        expiresAt: new Date('2026-08-07T00:05:00.000Z')
      }
    }
  }
  const harness = createRouteHarness({ evidenceService })
  const upload = {
    businessLineId: 'business-1', nodeId: 'node-1',
    fileId: 'cloud://env/evidence/report.pdf', fileName: 'report.pdf', declaredSize: 100,
    actor: { _id: 'forged' }, url: 'https://attacker.example/file'
  }
  const registered = await harness.api.main({ action: 'registerEvidenceUpload', payload: upload })
  const accessed = await harness.api.main({
    action: 'getEvidenceAccess', payload: { evidenceId: 'evidence-1', actorId: 'forged' }
  })

  assert.equal(registered.ok, true)
  assert.equal(accessed.ok, true)
  const actor = {
    _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
  }
  assert.deepEqual(calls, [
    ['registerUpload', { actor, input: upload }],
    ['getAccessGrant', { actor, evidenceId: 'evidence-1' }]
  ])
})

test('聚合概览路由只使用受信账号且拒绝多余参数', async () => {
  const calls = []
  const dashboardWorkspaceService = {
    async getDashboardWorkspace(input) {
      calls.push(input)
      return { stats: {}, recent: [] }
    }
  }
  const harness = createRouteHarness({ dashboardWorkspaceService })
  const result = await harness.api.main({ action: 'getDashboardWorkspace', payload: {} })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{
    actor: {
      _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
    }
  }])

  const rejected = await harness.api.main({
    action: 'getDashboardWorkspace', payload: { actorId: 'forged', unexpected: true }
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'VALIDATION_ERROR')
})

test('scoped evidence upload routes use the trusted actor and an exact safe payload contract', async () => {
  const calls = []
  const evidenceUploadService = {
    async beginEvidenceUpload(input) {
      calls.push(['begin', input])
      return { evidenceId: 'evidence-1', uploadSessionToken: 'opaque' }
    },
    async finalizeEvidenceUpload(input) {
      calls.push(['finalize', input])
      return { evidenceId: 'evidence-1', storageStatus: 'available' }
    }
  }
  const harness = createRouteHarness({ evidenceUploadService })
  const beginPayload = {
    businessLineId: 'business-1', nodeId: 'node-1', expectedNodeVersion: 4,
    fileName: 'proof.mov', declaredSize: 123, actorId: 'forged'
  }
  const finalizePayload = {
    evidenceId: 'evidence-1', uploadSessionToken: 'opaque', expectedNodeVersion: 4,
    actorId: 'forged'
  }
  assert.equal((await harness.api.main({ action: 'beginEvidenceUpload', payload: beginPayload })).ok, true)
  assert.equal((await harness.api.main({ action: 'finalizeEvidenceUpload', payload: finalizePayload })).ok, true)
  const actor = {
    _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
  }
  assert.deepEqual(calls, [
    ['begin', { actor, input: {
      businessLineId: 'business-1', nodeId: 'node-1', expectedNodeVersion: 4,
      fileName: 'proof.mov', declaredSize: 123
    } }],
    ['finalize', { actor, input: {
      evidenceId: 'evidence-1', uploadSessionToken: 'opaque', expectedNodeVersion: 4
    } }]
  ])
  const forged = await harness.api.main({
    action: 'beginEvidenceUpload', payload: { ...beginPayload, objectKey: 'attacker-selected' }
  })
  assert.equal(forged.ok, false)
  assert.equal(forged.code, 'VALIDATION_ERROR')
})

test('default feedback routes use the trusted account and protect both writes and history', async () => {
  const calls = []
  const feedbackService = {
    async submitFeedback(value) { calls.push(['submit', value]); return { feedbackId: 'feedback-1', revision: 1 } },
    async saveNodeProgress(value) { calls.push(['save-progress', value]); return { feedbackId: 'feedback-2', revision: 2 } },
    async getNodeHistory(value) { calls.push(['history', value]); return { history: [] } }
  }
  const harness = createRouteHarness({ feedbackService })
  const payload = {
    businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 2,
    status: 'completed', fieldValues: [], comment: '', evidenceIds: [], requestKey: 'request-1',
    actor: { _id: 'forged' }
  }
  assert.equal((await harness.api.main({ action: 'submitFeedback', payload })).ok, true)
  const progressPayload = {
    businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 2,
    action: 'save_progress', fieldValues: [], comment: '', evidenceIds: [], requestKey: 'request-2'
  }
  assert.equal((await harness.api.main({ action: 'submitFeedback', payload: progressPayload })).ok, true)
  assert.equal((await harness.api.main({ action: 'getNodeHistory', payload: {
    businessLineId: 'line-1', nodeId: 'node-1', actorId: 'forged'
  } })).ok, true)
  const actor = {
    _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound'
  }
  assert.deepEqual(calls, [
    ['submit', { actor, input: payload }],
    ['save-progress', { actor, input: progressPayload }],
    ['history', { actor, businessLineId: 'line-1', nodeId: 'node-1' }]
  ])
})

test('legacy feedback write and history handlers are absent after protected-route replacement', () => {
  const routes = createDefaultLegacyRoutes()
  assert.equal(Object.hasOwn(routes, 'submitNodeFeedback'), false)
  assert.equal(Object.hasOwn(routes, 'getNodeHistory'), false)
})

test('旧节点可继续经真实反馈服务完成，新版审核节点拒绝旧完成和旧驳回入口', async () => {
  const calls = []
  const feedbackService = createFeedbackService({
    repository: {
      async findPublishedFeedback() { return null },
      async getSubmissionContext({ nodeId }) {
        return {
          node: nodeId === 'review-node'
            ? { _id: nodeId, workflowMode: 'review', fieldDefinitions: [], requiresEvidence: false }
            : { _id: nodeId, fieldDefinitions: [], requiresEvidence: false },
          evidences: []
        }
      },
      async commitFeedback(value) {
        calls.push(value)
        return { feedbackId: 'legacy-feedback-1', revision: 1 }
      }
    }
  })
  const harness = createRouteHarness({ feedbackService })
  const legacyResult = await harness.api.main({
    action: 'submitFeedback',
    payload: {
      businessLineId: 'legacy-line', nodeId: 'legacy-node', expectedNodeVersion: 3,
      status: 'completed', fieldValues: [], comment: '', evidenceIds: [], requestKey: 'legacy-feedback'
    }
  })
  const reviewProgress = await harness.api.main({
    action: 'submitFeedback',
    payload: {
      businessLineId: 'new-line', nodeId: 'review-node', expectedNodeVersion: 4,
      action: 'save_progress', fieldValues: [], comment: '', evidenceIds: [], requestKey: 'review-progress'
    }
  })
  const forgedRound = await harness.api.main({
    action: 'createReviewRound', payload: {
      businessLineId: 'new-line', nodeId: 'review-node', expectedNodeVersion: 4, requestKey: 'forged-round'
    }
  })
  const reviewCompletion = await harness.api.main({
    action: 'submitFeedback',
    payload: {
      businessLineId: 'new-line', nodeId: 'review-node', expectedNodeVersion: 4,
      status: 'completed', fieldValues: [], comment: '', evidenceIds: [], requestKey: 'review-complete'
    }
  })

  assert.equal(legacyResult.ok, true)
  assert.equal(reviewProgress.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].input.action, 'save_progress')
  assert.deepEqual(forgedRound, { ok: false, code: 'UNKNOWN_ACTION', message: 'Unsupported action' })
  assert.equal(reviewCompletion.code, 'NODE_PENDING_REVIEW')
})

test('旧业务写入与删除入口在受保护生命周期接口接管后不可部署', () => {
  const routes = createDefaultLegacyRoutes()
  assert.equal(Object.hasOwn(routes, 'updateBusinessLine'), false)
  assert.equal(Object.hasOwn(routes, 'deleteBusinessLine'), false)
})

test('evidence application errors are safe while unmarked storage errors remain generic', async () => {
  for (const code of [
    'UNSUPPORTED_FILE_TYPE', 'FILE_TOO_LARGE', 'EVIDENCE_EXPIRED', 'EVIDENCE_NOT_ATTACHABLE'
  ]) {
    const harness = createRouteHarness({
      evidenceService: {
        async registerUpload() {
          const error = new Error('secret evidence detail')
          error.code = code
          error[APPLICATION_ERROR_MARKER] = true
          throw error
        }
      }
    })
    const result = await harness.api.main({
      action: 'registerEvidenceUpload', payload: { fileName: 'secret-name.pdf' }
    })
    assert.equal(result.code, code)
    assert.doesNotMatch(JSON.stringify(harness.errors), /secret evidence detail|secret-name/)
  }

  const failed = createRouteHarness({
    evidenceService: {
      async getAccessGrant() {
        const error = new Error('storage bucket internals')
        error.code = 'EVIDENCE_EXPIRED'
        throw error
      }
    }
  })
  const result = await failed.api.main({
    action: 'getEvidenceAccess', payload: { evidenceId: 'evidence-1' }
  })
  assert.deepEqual(result, { ok: false, code: 'INTERNAL_ERROR', message: 'Service error' })
  assert.doesNotMatch(JSON.stringify(failed.errors), /storage bucket internals/)
})

test('the deployed legacy route map rejects caller-authored business codes and nodes', async () => {
  const harness = createRouteHarness({ legacyRoutes: createDefaultLegacyRoutes() })
  const result = await harness.api.main({
    action: 'createBusinessLine',
    payload: {
      name: '不应创建',
      code: 'CLIENT-CODE',
      nodes: [{ name: '客户端节点' }]
    }
  })

  assert.deepEqual(result, { ok: false, code: 'UNKNOWN_ACTION', message: 'Unsupported action' })
  assert.equal(defaultFake.documents('business_lines').length, 0)
  assert.equal(defaultFake.documents('business_nodes').length, 0)
})

test('template application errors retain safe codes without logging payload values', async () => {
  for (const code of [
    'TEMPLATE_NOT_EDITABLE', 'TEMPLATE_NOT_ENABLED', 'TEMPLATE_INVALID',
    'TEMPLATE_LIMIT_EXCEEDED', 'ASSIGNEE_INACTIVE', 'PROCESSOR_INACTIVE',
    'REVIEWER_INACTIVE', 'ROLE_OVERLAP', 'INVALID_FIELD_VALUE'
  ]) {
    const harness = createRouteHarness({
      templateService: {
        async createTemplate() {
          const error = new Error('secret-template-payload')
          error.code = code
          error[APPLICATION_ERROR_MARKER] = true
          throw error
        }
      }
    })
    const result = await harness.api.main({
      action: 'createTemplate', payload: { name: 'secret-template-name' }
    })
    assert.equal(result.code, code)
    const logged = JSON.stringify(harness.errors)
    assert.match(logged, new RegExp(code))
    assert.doesNotMatch(logged, /secret-template-payload|secret-template-name/)
  }
})

test('unknown template failures return a generic response without database details', async () => {
  const harness = createRouteHarness({
    templateService: {
      async listTemplates() {
        const error = new Error('database permission denied for templates')
        error.code = 'DATABASE_PERMISSION_DENIED'
        throw error
      }
    }
  })
  const result = await harness.api.main({ action: 'listTemplates', payload: {} })

  assert.deepEqual(result, { ok: false, code: 'INTERNAL_ERROR', message: 'Service error' })
  assert.doesNotMatch(JSON.stringify(harness.errors), /permission denied|DATABASE_PERMISSION_DENIED/)
})

test('unmarked infrastructure failures cannot borrow an allowlisted application code', async () => {
  const harness = createRouteHarness({
    templateService: {
      async getTemplate() {
        const error = new Error('document.get failed for internal collection templates')
        error.code = 'NOT_FOUND'
        throw error
      }
    }
  })
  const result = await harness.api.main({
    action: 'getTemplate', payload: { templateId: 't1' }
  })

  assert.deepEqual(result, { ok: false, code: 'INTERNAL_ERROR', message: 'Service error' })
  assert.doesNotMatch(JSON.stringify(harness.errors), /document\.get|internal collection/)
})

test('protected routes fail closed for missing, disabled, locked, and password-change-required account state', async t => {
  const cases = [
    { name: 'missing user', user: null, credential: null, code: 'UNAUTHORIZED' },
    { name: 'missing credential', user: { _id: 'u-1', status: 'active' }, credential: null, code: 'ACCOUNT_STATE_INVALID' },
    { name: 'disabled user', user: { _id: 'u-1', status: 'disabled' }, credential: { lockedUntil: null }, code: 'ACCOUNT_DISABLED' },
    { name: 'locked user', user: { _id: 'u-1', status: 'active' }, credential: { lockedUntil: Date.parse('2026-08-06T00:30:00.000Z') }, code: 'ACCOUNT_LOCKED' },
    { name: 'temporary credential', user: { _id: 'u-1', status: 'active' }, credential: { mustChangePassword: true }, code: 'PASSWORD_CHANGE_REQUIRED' }
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const harness = createRouteHarness(item)
      const result = await harness.api.main({ action: 'dashboard', payload: {} })
      assert.equal(result.ok, false)
      assert.equal(result.code, item.code)
    })
  }
})

test('route error logging excludes payloads, passwords, identity values, and error messages', async () => {
  const harness = createRouteHarness()
  harness.authService.login = async () => {
    const error = new Error('secret-password wx-sensitive')
    error.code = 'INVALID_CREDENTIALS'
    throw error
  }
  const result = await harness.api.main({
    action: 'login',
    payload: { username: 'secret-user', password: 'secret-password', openid: 'wx-forged', userId: 'target-must-not-log' }
  })

  assert.equal(result.code, 'INVALID_CREDENTIALS')
  assert.equal(harness.errors.length, 1)
  const logged = JSON.stringify(harness.errors)
  assert.doesNotMatch(logged, /secret-password|secret-user|wx-sensitive|wx-forged|target-must-not-log/)
  assert.match(logged, /INVALID_CREDENTIALS/)
  assert.match(logged, /request-1/)
})

test('route error logging preserves known application codes and maps all other codes to INTERNAL_ERROR', async () => {
  for (const { code, loggedCode } of [
    { code: 'INVALID_CREDENTIALS', loggedCode: 'INVALID_CREDENTIALS' },
    { code: 'FEEDBACK_COMMIT_IN_PROGRESS', loggedCode: 'FEEDBACK_COMMIT_IN_PROGRESS' },
    { code: 'SECRET_API_TOKEN', loggedCode: 'INTERNAL_ERROR' },
    { code: 'SDK_RUNTIME_ERROR', loggedCode: 'INTERNAL_ERROR' },
    { code: 'INVALID\nsecret-code', loggedCode: 'INTERNAL_ERROR' }
  ]) {
    const harness = createRouteHarness()
    harness.authService.login = async () => {
      const error = new Error('secret-error-message')
      error.code = code
      throw error
    }

    const result = await harness.api.main({ action: 'login', payload: {} })
    assert.equal(result.ok, false)
    const logged = JSON.stringify(harness.errors)
    assert.match(logged, new RegExp(loggedCode))
    if (loggedCode === 'INTERNAL_ERROR') assert.equal(logged.includes(code), false)
    assert.doesNotMatch(logged, /secret-error-message|secret-code/)
  }
})

test('prototype property names are rejected as unknown actions', async () => {
  for (const action of ['toString', 'constructor', '__proto__']) {
    const harness = createRouteHarness()
    const result = await harness.api.main({ action, payload: {} })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNKNOWN_ACTION')
  }
})

test('unknown actions are sanitized in logs and never contribute a payload target id', async () => {
  const harness = createRouteHarness()
  const result = await harness.api.main({
    action: 'secret-action-name',
    payload: { userId: 'target-must-not-log' }
  })
  assert.equal(result.code, 'UNKNOWN_ACTION')
  const logged = JSON.stringify(harness.errors)
  assert.doesNotMatch(logged, /secret-action-name|target-must-not-log/)
  assert.match(logged, /UNKNOWN_ACTION/)
})

test('only validated admin target actions may add a safe target id to logs', async () => {
  for (const { targetId, expected } of [
    { targetId: 'user_123-safe', expected: true },
    { targetId: '../sensitive', expected: false },
    { targetId: 'x'.repeat(65), expected: false },
    { targetId: 42, expected: false }
  ]) {
    const harness = createRouteHarness({ user: null, credential: null })
    await harness.api.main({ action: 'updateUser', payload: { userId: targetId, changes: { status: 'disabled' } } })
    const logged = JSON.stringify(harness.errors)
    assert.equal(logged.includes(String(targetId)), expected)
  }
})
