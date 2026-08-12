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
  assert.ok(definition)
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      for (const [key, value] of Object.entries(update)) setByPath(this.data, key, value)
    }
  }
}

function activeUser(id = 'account-1') {
  return { _id: id, role: 'user', status: 'active' }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function reviewNode(overrides = {}) {
  return {
    _id: 'node-1', nodeCode: 'YW-1-N001', name: '资料收集', status: 'in_progress', version: 4,
    workflowMode: 'review', canFeedback: true, processorDisplayNames: ['处理甲'],
    reviewerDisplayNames: ['审核甲', '审核乙'], reviewMode: 'all', processingRoundNumber: 1,
    reviewRoundNumber: 0, processingDueStatus: 'calculated', processingDueAt: '2026-08-12T12:00:00.000Z',
    processingOverdueWorkMinutes: 0, reviewDueStatus: 'not_started', reviewDueAt: null,
    requiresEvidence: false, allowedEvidenceTypes: ['jpg', 'pdf', 'mp4'],
    fieldDefinitions: [{ fieldKey: 'summary', sequence: 0, name: '摘要', type: 'short_text', required: true, constraints: {} }],
    ...overrides
  }
}

test('业务服务的六个审核方法只透传业务参数并安全映射错误', async () => {
  const calls = []
  const cloud = {
    callBusinessApi: async (action, payload, options) => {
      calls.push([action, payload, options])
      if (action === 'submitReviewVote') {
        const error = new Error('REVIEW_COMMENT_REQUIRED')
        error.code = 'REVIEW_COMMENT_REQUIRED'
        throw error
      }
      return { ok: true }
    }
  }
  const service = withFakeModule('utils/cloud.js', cloud, () => {
    delete require.cache[require.resolve(path.join(miniProgramRoot, 'services/business.js'))]
    return require(path.join(miniProgramRoot, 'services/business.js'))
  })

  await service.submitNodeForReview({ businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4, requestKey: 'review-1' })
  await assert.rejects(service.submitReviewVote({
    reviewRoundId: 'round-1', expectedRoundVersion: 2, decision: 'reject', comment: '', requestKey: 'vote-1'
  }), error => error.message === '请填写驳回原因')
  await service.listMyPendingReviews({ page: 1, pageSize: 20 })
  await service.getReviewDetail('round-1')
  await service.getEvidenceAccess('evidence-1')
  await service.listMyNotifications({ page: 1, pageSize: 20 })
  await service.markNotificationRead('notice-1')

  assert.deepEqual(calls.map(item => [item[0], item[1]]), [
    ['submitNodeForReview', { businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4, requestKey: 'review-1' }],
    ['submitReviewVote', { reviewRoundId: 'round-1', expectedRoundVersion: 2, decision: 'reject', comment: '', requestKey: 'vote-1' }],
    ['listMyPendingReviews', { page: 1, pageSize: 20 }],
    ['getReviewDetail', { reviewRoundId: 'round-1' }],
    ['getEvidenceAccess', { evidenceId: 'evidence-1' }],
    ['listMyNotifications', { page: 1, pageSize: 20 }],
    ['markNotificationRead', { notificationId: 'notice-1' }]
  ])
  assert.ok(calls.every(item => !Object.keys(item[1]).some(key => ['actor', 'openid', 'role', 'userId'].includes(key))))
  assert.ok(calls.every(item => item[2] && item[2].silent === true))
})

test('审核节点提交先幂等保存处理版本再提交审核，第二步失败时两种请求键稳定复用', async () => {
  const calls = []
  let reviewAttempts = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('有效账号不应跳转登录'),
    showToast: () => {}, navigateBack: () => {}, cloud: { uploadFile: async () => ({}) }
  }
  const node = reviewNode()
  const page = loadPage('pages/node-feedback/index.js', {
    getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 8 }, nodes: [node] }),
    getNodeHistory: async () => ({ node, canSubmit: true, history: [] }),
    submitFeedback: async input => {
      calls.push({ method: 'submitFeedback', input })
      return { feedbackId: 'feedback-1', nodeVersion: 5 }
    },
    submitNodeForReview: async input => {
      calls.push({ method: 'submitNodeForReview', input })
      reviewAttempts += 1
      if (reviewAttempts === 1) throw new Error('临时网络异常')
      return { reviewRoundId: 'round-1' }
    }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({
    'fieldValues.summary': '资料已齐',
    comment: '提交审核',
    files: [{ localKey: 'file-1', status: 'registered', evidenceId: 'evidence-1', size: 10 }]
  })

  await page.onSubmitReview()
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '不应覆盖已保存草稿' } })
  page.removeFile({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(page.data.fieldValues.summary, '资料已齐')
  assert.equal(page.data.files.length, 1)
  await page.onSubmitReview()

  assert.deepEqual(calls.map(item => item.method), [
    'submitFeedback', 'submitNodeForReview', 'submitFeedback', 'submitNodeForReview'
  ])
  assert.equal(calls[0].input.action, 'save_progress')
  assert.equal(calls[0].input.requestKey, calls[2].input.requestKey)
  assert.equal(calls[1].input.requestKey, calls[3].input.requestKey)
  assert.notEqual(calls[0].input.requestKey, calls[1].input.requestKey)
  assert.equal(calls[0].input.expectedNodeVersion, 4)
  assert.equal(calls[2].input.expectedNodeVersion, 4)
  assert.equal(calls[1].input.expectedNodeVersion, 5)
  assert.equal(calls[3].input.expectedNodeVersion, 5)
  assert.equal(page.data.readOnly, true)
})

test('提交审核等待两步响应期间冻结草稿文件并保持不可变请求快照', async () => {
  const progress = deferred()
  const review = deferred()
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {}, reLaunch: () => {}, showToast: () => {}, navigateBack: () => {},
    cloud: { uploadFile: async () => assert.fail('已登记凭证不应重复上传') }
  }
  const node = reviewNode()
  const page = loadPage('pages/node-feedback/index.js', {
    getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 8 }, nodes: [node] }),
    getNodeHistory: async () => ({ node, canSubmit: true, history: [] }),
    submitFeedback: input => { calls.push(['feedback', input]); return progress.promise },
    submitNodeForReview: input => { calls.push(['review', input]); return review.promise }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({
    'fieldValues.summary': '提交前草稿', comment: '提交前说明',
    files: [{ localKey: 'file-1', status: 'registered', evidenceId: 'evidence-1', size: 10 }]
  })

  const pending = page.onSubmitReview()
  const progressKey = page.progressRequestKey
  const reviewKey = page.reviewRequestKey
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '等待期篡改' } })
  page.onComment({ detail: { value: '等待期说明' } })
  page.addSelectedFiles([{ name: 'extra.pdf', path: 'wxfile://extra.pdf', size: 10, category: 'pdf' }])
  page.removeFile({ currentTarget: { dataset: { index: 0 } } })

  assert.equal(page.data.submitting, true)
  assert.equal(page.data.reviewDraftLocked, true)
  assert.equal(page.data.fieldValues.summary, '提交前草稿')
  assert.equal(page.data.comment, '提交前说明')
  assert.equal(page.data.files.length, 1)
  assert.equal(page.progressRequestKey, progressKey)
  assert.equal(page.reviewRequestKey, reviewKey)

  progress.resolve({ feedbackId: 'feedback-1', nodeVersion: 5 })
  await new Promise(resolve => setImmediate(resolve))
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '第二步篡改' } })
  assert.equal(page.data.fieldValues.summary, '提交前草稿')
  assert.equal(page.progressRequestKey, progressKey)
  assert.equal(page.reviewRequestKey, reviewKey)
  assert.deepEqual(calls.map(call => call[0]), ['feedback', 'review'])
  assert.equal(calls[0][1].fieldValues[0].value, '提交前草稿')
  assert.equal(calls[0][1].requestKey, progressKey)
  assert.equal(calls[1][1].requestKey, reviewKey)

  review.resolve({ reviewRoundId: 'round-1' })
  await pending
})

test('三种审核处理操作遇字段校验错误时中文提示且不污染写操作状态', async () => {
  const toasts = []
  let writes = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {}, reLaunch: () => {},
    showToast: options => toasts.push(options), cloud: { uploadFile: async () => assert.fail('校验失败不应上传') }
  }
  const node = reviewNode()
  const page = loadPage('pages/node-feedback/index.js', {
    getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 8 }, nodes: [node] }),
    getNodeHistory: async () => ({ node, canSubmit: true, history: [] }),
    submitFeedback: async () => { writes += 1 }, submitNodeForReview: async () => { writes += 1 }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({ comment: '受阻原因完整' })
  const initialWriteState = {
    progressIntent: page.progressIntent,
    progressRequestKey: page.progressRequestKey,
    reviewRequestKey: page.reviewRequestKey
  }

  for (const action of ['onSaveProgress', 'onMarkBlocked', 'onSubmitReview']) {
    await page[action]()
    assert.equal(page.data.submitting, false, `${action} 不得进入提交态`)
    assert.equal(page.data.reviewDraftLocked, false, `${action} 不得锁定草稿`)
    assert.equal(page.writeSequence, 0, `${action} 不得占用写序号`)
    assert.equal(page.progressIntent, initialWriteState.progressIntent, `${action} 不得建立处理意图`)
    assert.equal(page.progressRequestKey, initialWriteState.progressRequestKey, `${action} 不得生成处理请求键`)
    assert.equal(page.reviewRequestKey, initialWriteState.reviewRequestKey, `${action} 不得生成审核请求键`)
  }

  assert.equal(writes, 0)
  assert.deepEqual(toasts.map(item => item.title), [
    '请填写必填字段：摘要', '请填写必填字段：摘要', '请填写必填字段：摘要'
  ])
})

for (const item of [
  { name: '账号变化', invalidate: ({ app }) => { app.globalData.currentUser = activeUser('other-account') } },
  { name: '页面卸载', invalidate: ({ page }) => page.onUnload() },
  { name: '操作序号变化', invalidate: ({ page }) => { page.writeSequence += 1 } },
  { name: '节点版本变化', invalidate: ({ page }) => page.setData({ expectedNodeVersion: 99 }) }
]) {
  test(`凭证上传失败在${item.name}后不写回旧文件状态`, async () => {
    const app = { globalData: { currentUser: activeUser() } }
    global.getApp = () => app
    global.wx = {
      setNavigationBarTitle: () => {}, reLaunch: () => {}, showToast: () => {},
      cloud: { uploadFile: async () => {
        item.invalidate({ app, page })
        throw new Error('模拟上传失败')
      } }
    }
    const node = reviewNode()
    const page = loadPage('pages/node-feedback/index.js', {
      getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 8 }, nodes: [node] }),
      getNodeHistory: async () => ({ node, canSubmit: true, history: [] }),
      registerEvidenceUpload: async () => assert.fail('上传失败后不应登记'),
      submitFeedback: async () => assert.fail('上传失败后不应提交')
    })
    await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
    page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '有效草稿' } })
    page.addSelectedFiles([{ name: 'proof.pdf', path: 'wxfile://proof.pdf', size: 10, category: 'pdf' }])
    await page.onSaveProgress()

    assert.equal(page.data.files[0].status, 'uploading', `${item.name}后旧异步失败不得写回`)
    assert.equal(page.data.files[0].errorMessage, '')
  })
}

test('待审核节点禁止字段、文件和所有处理写操作', async () => {
  let writes = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => {}, showToast: () => {} }
  const node = reviewNode({ status: 'pending_review', activeReviewRoundId: 'round-1', reviewRoundNumber: 1 })
  const page = loadPage('pages/node-feedback/index.js', {
    getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 9 }, nodes: [node] }),
    getNodeHistory: async () => ({ node, canSubmit: false, history: [] }),
    submitFeedback: async () => { writes += 1 }, submitNodeForReview: async () => { writes += 1 }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '伪造覆盖' } })
  page.addSelectedFiles([{ name: 'a.pdf', path: 'wxfile://a.pdf', size: 10, category: 'pdf' }])
  await page.onSaveProgress()
  await page.onMarkBlocked()
  await page.onSubmitReview()

  assert.equal(page.data.readOnly, true)
  assert.equal(page.data.fieldValues.summary, '')
  assert.deepEqual(page.data.files, [])
  assert.equal(writes, 0)
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/node-feedback/index.wxml'), 'utf8')
  assert.match(wxml, /保存处理进度/)
  assert.match(wxml, /标记受阻/)
  assert.match(wxml, /提交审核/)
  assert.match(wxml, /legacyMode/)
})

test('新版审核节点页面不展示旧直接完成或旧驳回入口', () => {
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/node-feedback/index.wxml'), 'utf8')
  assert.doesNotMatch(wxml, /完成节点|直接完成|驳回上一节点/)
  assert.match(wxml, /提交审核/)
})

test('单独保存处理进度后清除已登记本地文件并恢复服务端最新字段草稿', async () => {
  let historyReads = 0
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => {}, showToast: () => {} }
  const node = reviewNode({ requiresEvidence: true })
  const savedHistory = [{
    feedbackId: 'feedback-1', revision: 1, status: 'in_progress', comment: '已保存说明',
    fieldValues: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '服务端草稿' }],
    evidences: [{ evidenceId: 'evidence-1', storageStatus: 'available' }]
  }]
  const page = loadPage('pages/node-feedback/index.js', {
    getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 8 }, nodes: [node] }),
    getNodeHistory: async () => {
      historyReads += 1
      return {
        node,
        canSubmit: true,
        history: historyReads === 1 ? [] : savedHistory
      }
    },
    submitFeedback: async input => { calls.push(['feedback', input]); return { feedbackId: 'feedback-1', nodeVersion: 5 } },
    submitNodeForReview: async input => { calls.push(['review', input]); return { reviewRoundId: 'round-1' } }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({
    'fieldValues.summary': '本地草稿',
    files: [{ localKey: 'file-1', status: 'registered', evidenceId: 'evidence-1', size: 10 }]
  })

  await page.onSaveProgress()

  assert.equal(page.data.fieldValues.summary, '服务端草稿')
  assert.equal(page.data.comment, '已保存说明')
  assert.deepEqual(page.data.files, [])

  const reloadedNode = reviewNode({ requiresEvidence: true, version: 5 })
  const reloadedPage = loadPage('pages/node-feedback/index.js', {
    getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 9 }, nodes: [reloadedNode] }),
    getNodeHistory: async () => ({ node: reloadedNode, canSubmit: true, history: savedHistory }),
    submitFeedback: async () => assert.fail('重新进入后不应伪造新的空凭证处理反馈'),
    submitNodeForReview: async input => { calls.push(['review', input]); return { reviewRoundId: 'round-1' } }
  })
  await reloadedPage.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  await reloadedPage.onSubmitReview()
  assert.equal(calls.length, 2)
  assert.equal(calls[1][0], 'review')
  assert.equal(calls[1][1].expectedNodeVersion, 5)
})

test('重新进入后修改服务端草稿会先保存新内容再提交审核', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => {}, showToast: () => {}, navigateBack: () => {} }
  const node = reviewNode({ requiresEvidence: true, version: 5 })
  const savedHistory = [{
    feedbackId: 'feedback-1', revision: 1, status: 'in_progress', comment: '原说明',
    fieldValues: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '原草稿' }],
    evidences: [{ evidenceId: 'evidence-1', storageStatus: 'available' }]
  }]
  const page = loadPage('pages/node-feedback/index.js', {
    getBusinessLine: async () => ({ line: { _id: 'line-1', status: 'active', version: 9 }, nodes: [node] }),
    getNodeHistory: async () => ({ node, canSubmit: true, history: savedHistory }),
    submitFeedback: async input => {
      calls.push(['feedback', input])
      return { feedbackId: 'feedback-2', nodeVersion: 6 }
    },
    submitNodeForReview: async input => {
      calls.push(['review', input])
      return { reviewRoundId: 'round-1' }
    }
  })

  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '修改后的草稿' } })
  page.onComment({ detail: { value: '修改后的说明' } })
  await page.onSubmitReview()

  assert.deepEqual(calls.map(call => call[0]), ['feedback', 'review'])
  assert.equal(calls[0][1].fieldValues[0].value, '修改后的草稿')
  assert.equal(calls[0][1].comment, '修改后的说明')
  assert.deepEqual(calls[0][1].evidenceIds, [])
  assert.equal(calls[1][1].expectedNodeVersion, 6)
})

test('投票失败后未改意见复用请求键，修改意见生成新请求键', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => {} }
  const page = loadPage('pages/review-detail/index.js', {
    getReviewDetail: async () => ({
      reviewRoundId: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', version: 2,
      status: 'pending', reviewMode: 'any', fieldValues: [], evidences: [], votes: [], canApprove: true, canReject: true
    }),
    getBusinessLine: async () => ({ nodes: [{ _id: 'node-1', reviewerDisplayNames: ['审核员'] }] }),
    submitReviewVote: async input => { calls.push(input); throw new Error('临时失败') }
  })
  await page.onLoad({ reviewRoundId: 'round-1' })
  page.onComment({ detail: { value: '意见甲' } })
  await page.onReject()
  await page.onReject()
  page.onComment({ detail: { value: '意见乙' } })
  await page.onReject()

  assert.equal(calls[0].requestKey, calls[1].requestKey)
  assert.notEqual(calls[1].requestKey, calls[2].requestKey)
})

test('审核待办页展示或签会签中文和安全时限，旧响应不得覆盖新账号', async () => {
  const pending = deferred()
  const app = { globalData: { currentUser: activeUser('reviewer-before') } }
  global.getApp = () => app
  global.wx = { reLaunch: () => {}, navigateTo: () => {} }
  const page = loadPage('pages/review-list/index.js', { listMyPendingReviews: () => pending.promise })

  const loading = page.onShow()
  app.globalData.currentUser = activeUser('reviewer-after')
  pending.resolve({ items: [{ reviewRoundId: 'stale', reviewMode: 'all', reviewDueStatus: 'calculated' }], hasMore: false })
  await loading
  assert.deepEqual(page.data.items, [])

  app.globalData.currentUser = activeUser('reviewer-after')
  page.loadActorId = ''
  page.requestSequence = 0
  page.businessService = undefined
  const fresh = loadPage('pages/review-list/index.js', {
    listMyPendingReviews: async () => ({
      items: [
        { reviewRoundId: 'round-any', businessName: '业务甲', nodeName: '节点甲', reviewMode: 'any', reviewDueStatus: 'pending_calendar', createdAt: '2026-08-11T01:00:00Z' },
        { reviewRoundId: 'round-all', businessName: '业务乙', nodeName: '节点乙', reviewMode: 'all', reviewDueStatus: 'calculated', reviewDueAt: '2026-08-12T01:00:00Z' }
      ], hasMore: false
    })
  })
  await fresh.onShow()
  assert.deepEqual(fresh.data.items.map(item => item.reviewModeLabel), ['或签', '会签'])
  assert.match(fresh.data.items[0].dueText, /待工作日历/)
})

test('审核详情驳回必填、投票单飞并使用轮次版本和稳定请求键刷新服务端结果', async () => {
  const calls = []
  const pendingVote = deferred()
  global.getApp = () => ({ globalData: { currentUser: activeUser('reviewer-1') } })
  global.wx = { reLaunch: () => {}, showToast: () => {}, setNavigationBarTitle: () => {} }
  let detailVersion = 2
  const page = loadPage('pages/review-detail/index.js', {
    getReviewDetail: async id => ({
      reviewRoundId: id, businessLineId: 'line-1', businessName: '业务甲', businessCode: 'YW-1',
      nodeId: 'node-1', nodeName: '资料审核', nodeCode: 'YW-1-N001', reviewMode: 'all',
      reviewRoundNumber: 1, version: detailVersion, status: detailVersion === 2 ? 'pending' : 'rejected', fieldValues: [], evidences: [], votes: [],
      processorDisplayNames: ['处理甲'], reviewerDisplayNames: ['审核甲', '审核乙'], canApprove: true, canReject: true
    }),
    getBusinessLine: async () => assert.fail('审核详情不得追加调用成员专用业务详情'),
    submitReviewVote: input => { calls.push(input); return pendingVote.promise }
  })
  await page.onLoad({ reviewRoundId: 'round-1', businessName: '伪造业务' })
  await page.onReject()
  assert.equal(page.data.errorMessage, '请填写驳回原因')

  page.onComment({ detail: { value: '资料有误' } })
  const first = page.onReject()
  const duplicate = page.onReject()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reviewRoundId, 'round-1')
  assert.equal(calls[0].expectedRoundVersion, 2)
  assert.equal(calls[0].decision, 'reject')
  assert.match(calls[0].requestKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  detailVersion = 3
  pendingVote.resolve({ status: 'rejected' })
  await first
  await duplicate
  assert.equal(page.data.status, 'rejected')
  assert.equal(page.data.submitting, false)
})

test('非业务成员超级管理员只凭审核详情安全投影加载且原始权限码不出现在页面', async () => {
  global.getApp = () => ({ globalData: { currentUser: { ...activeUser('root-1'), role: 'super_admin' } } })
  global.wx = { reLaunch: () => {}, setNavigationBarTitle: () => {} }
  let businessReads = 0
  const page = loadPage('pages/review-detail/index.js', {
    getReviewDetail: async () => ({
      reviewRoundId: 'round-1', businessLineId: 'line-1', businessName: '业务甲', businessCode: 'YW-1',
      nodeId: 'node-1', nodeName: '资料审核', nodeCode: 'YW-1-N001', reviewMode: 'any',
      reviewRoundNumber: 1, version: 2, status: 'pending', fieldValues: [], evidences: [], votes: [],
      processorDisplayNames: ['处理甲'], reviewerDisplayNames: ['审核甲'], canApprove: false, canReject: false
    }),
    getBusinessLine: async () => { businessReads += 1; throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }) }
  })

  await page.onLoad({ reviewRoundId: 'round-1' })

  assert.equal(businessReads, 0)
  assert.equal(page.data.loading, false)
  assert.equal(page.data.errorMessage, '')
  assert.equal(page.data.processorNamesText, '处理甲')
  assert.equal(page.data.reviewerNamesText, '审核甲')
  assert.doesNotMatch(JSON.stringify(page.data), /FORBIDDEN/)
})
