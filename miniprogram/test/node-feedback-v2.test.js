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

function loadPage(businessFake) {
  const pagePath = path.join(miniProgramRoot, 'pages/node-feedback/index.js')
  let definition
  global.Page = value => { definition = value }
  const normalizedFake = { ...businessFake }
  if (!normalizedFake.getNodeWorkspace && normalizedFake.getBusinessLine && normalizedFake.getNodeHistory) {
    normalizedFake.getNodeWorkspace = async (lineId, nodeId) => {
      const [detail, historyResult] = await Promise.all([
        normalizedFake.getBusinessLine(lineId),
        normalizedFake.getNodeHistory(lineId, nodeId)
      ])
      return {
        line: detail.line,
        node: (detail.nodes || []).find(item => item._id === nodeId),
        canSubmit: historyResult.canSubmit,
        history: historyResult.history
      }
    }
  }
  try {
    withFakeModule('services/business.js', normalizedFake, () => {
      delete require.cache[require.resolve(pagePath)]
      require(pagePath)
    })
  } finally {
    delete global.Page
  }
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

function nodeFixture(overrides = {}) {
  return {
    _id: 'node-1',
    businessLineId: 'line-1',
    nodeCode: 'YW-20260810-0001-N001',
    name: '资料审核',
    status: 'ready',
    version: 3,
    requiresEvidence: false,
    allowedEvidenceTypes: ['jpg', 'pdf', 'mp4'],
    fieldDefinitions: [
      { fieldKey: 'summary', sequence: 0, name: '摘要', type: 'short_text', required: true, constraints: { minLength: 2 } },
      { fieldKey: 'detail', sequence: 1, name: '说明', type: 'long_text', required: false, constraints: {} },
      { fieldKey: 'amount', sequence: 2, name: '金额', type: 'number', required: true, constraints: { min: 0, decimalPlaces: 2 } },
      { fieldKey: 'confirmed', sequence: 3, name: '已确认', type: 'boolean', required: true, constraints: {} },
      { fieldKey: 'date', sequence: 4, name: '日期', type: 'date', required: true, constraints: {} },
      { fieldKey: 'level', sequence: 5, name: '级别', type: 'single_select', required: true, constraints: { options: ['高', '低'] } },
      { fieldKey: 'tags', sequence: 6, name: '标签', type: 'multi_select', required: false, constraints: { options: ['甲', '乙'] } }
    ],
    ...overrides
  }
}

function businessFixture(node = nodeFixture(), lineOverrides = {}) {
  return {
    line: { _id: 'line-1', status: 'active', version: 7, ...lineOverrides },
    nodes: [node],
    canManage: false
  }
}

test('当前处理人可粘贴文本识别并预览，确定空字段默认勾选且不覆盖已有值', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, showToast: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向') }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-2'], reviewMode: 'any' })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核', status: 'ready' }, canSubmit: true, history: [] }),
    recognizeNodeText: async input => {
      calls.push(input)
      return { nodeVersion: 3, candidates: [
        { fieldKey: 'summary', value: '自动摘要', confidence: 0.96, sourceExcerpt: '摘要：自动摘要', matchKind: 'direct', requiresConfirmation: false, alternatives: [] },
        { fieldKey: 'level', value: '高', confidence: 0.84, sourceExcerpt: '优先级高', matchKind: 'semantic', requiresConfirmation: false, alternatives: [] }
      ] }
    }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({ 'fieldValues.summary': '手工内容' })
  page.onRecognitionText({ detail: { value: '摘要：自动摘要，优先级高' } })

  await page.onRecognizeText()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].businessLineId, 'line-1')
  assert.equal(calls[0].nodeId, 'node-1')
  assert.equal(calls[0].expectedNodeVersion, 3)
  assert.match(calls[0].requestKey, /^[A-Za-z0-9_-]{16,128}$/)
  assert.deepEqual(page.data.recognitionCandidates.map(item => [item.fieldKey, item.group, item.selected]), [
    ['summary', 'replacement', false],
    ['level', 'direct', true]
  ])

  page.onApplyRecognitionCandidates()
  assert.equal(page.data.fieldValues.summary, '手工内容')
  assert.equal(page.data.fieldValues.level, '高')
  assert.equal(page.data.recognitionText, '')
})

test('识别等待期间表单发生变化时丢弃迟到结果且不覆盖用户输入', async () => {
  const pending = deferred()
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, showToast: options => toasts.push(options.title), reLaunch: () => assert.fail('有效账号不应被重定向') }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-2'], reviewMode: 'any' })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核', status: 'ready' }, canSubmit: true, history: [] }),
    recognizeNodeText: async () => pending.promise
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.onRecognitionText({ detail: { value: '摘要：旧内容' } })
  const request = page.onRecognizeText()
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '用户新输入' } })
  pending.resolve({ nodeVersion: 3, candidates: [
    { fieldKey: 'summary', value: '旧内容', confidence: 0.99, sourceExcerpt: '摘要：旧内容', matchKind: 'direct', requiresConfirmation: false, alternatives: [] }
  ] })
  await request

  assert.equal(page.data.fieldValues.summary, '用户新输入')
  assert.deepEqual(page.data.recognitionCandidates, [])
  assert.ok(toasts.includes('表单已变化，识别结果已丢弃，请重试'))
})

test('连续输入不同字段时每次只原子更新一次且保留其他字段内容', async () => {
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, showToast: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向') }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-2'], reviewMode: 'any' })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核', status: 'ready' }, canSubmit: true, history: [] })
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  const originalSetData = page.setData
  const updates = []
  page.setData = function (update) {
    updates.push(update)
    originalSetData.call(this, update)
  }

  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '第一个字段' } })
  assert.equal(updates.length, 1, '一次输入不得分成两次视图更新')
  assert.equal(updates[0].draftDirty, true)
  assert.deepEqual(updates[0].recognitionCandidates, [])
  assert.equal(updates[0]['fieldValues.summary'], '第一个字段')

  updates.length = 0
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'detail' } }, detail: { value: '第二个字段' } })
  assert.equal(updates.length, 1, '切换输入框后仍应单次原子更新')
  assert.equal(updates[0]['fieldValues.detail'], '第二个字段')
  assert.equal(page.data.fieldValues.summary, '第一个字段')
  assert.equal(page.data.fieldValues.detail, '第二个字段')
})

test('本地草稿未保存时页面重新显示不得用服务端旧草稿覆盖，干净状态仍会刷新', async () => {
  let lineReads = 0
  let historyReads = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, showToast: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向') }
  const page = loadPage({
    getBusinessLine: async () => {
      lineReads += 1
      return businessFixture(nodeFixture({ workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-2'], reviewMode: 'any' }))
    },
    getNodeHistory: async () => {
      historyReads += 1
      return {
        node: { id: 'node-1', name: '资料审核', status: 'ready' },
        canSubmit: true,
        history: historyReads === 1 ? [] : [{
          feedbackId: 'feedback-server', revision: 1, status: 'in_progress', comment: '服务端旧说明',
          fieldValues: [{ fieldKey: 'summary', value: '服务端旧内容' }], evidences: []
        }]
      }
    }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '尚未保存的本地内容' } })

  await page.onShow()
  assert.equal(lineReads, 1)
  assert.equal(historyReads, 1)
  assert.equal(page.data.fieldValues.summary, '尚未保存的本地内容')

  page.setData({ draftDirty: false })
  await page.onShow()
  assert.equal(lineReads, 2)
  assert.equal(historyReads, 2)
  assert.equal(page.data.fieldValues.summary, '服务端旧内容')
  assert.equal(page.data.comment, '服务端旧说明')
})

test('用户可取消识别且页面隐藏会清除原文并丢弃迟到结果', async () => {
  for (const action of ['onCancelRecognition', 'onHide']) {
    const pending = deferred()
    global.getApp = () => ({ globalData: { currentUser: activeUser() } })
    global.wx = { setNavigationBarTitle: () => {}, showToast: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向') }
    const page = loadPage({
      getBusinessLine: async () => businessFixture(nodeFixture({ workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-2'], reviewMode: 'any' })),
      getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核', status: 'ready' }, canSubmit: true, history: [] }),
      recognizeNodeText: async () => pending.promise
    })
    await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
    page.onRecognitionText({ detail: { value: '客户姓名：张三' } })
    const request = page.onRecognizeText()
    page[action]()
    assert.equal(page.data.recognizing, false)
    assert.equal(page.data.recognitionText, '')
    assert.deepEqual(page.data.recognitionCandidates, [])
    pending.resolve({ candidates: [{
      fieldKey: 'summary', value: '张三', confidence: 1, sourceExcerpt: '张三',
      matchKind: 'direct', requiresConfirmation: false, alternatives: []
    }] })
    await request
    assert.deepEqual(page.data.recognitionCandidates, [])
  }
})

test('反馈页只接受标识参数，并以服务端节点快照和权限构建动态表单', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向') }
  const page = loadPage({
    getNodeWorkspace: async (lineId, nodeId) => {
      calls.push(['workspace', lineId, nodeId])
      const detail = businessFixture()
      return { line: detail.line, node: detail.nodes[0], canSubmit: true, history: [] }
    }
  })

  await page.onLoad({
    lineId: 'line-1', nodeId: 'node-1',
    nodeName: encodeURIComponent('伪造名称'), canFeedback: '0', expectedNodeVersion: '999'
  })

  assert.deepEqual(calls, [['workspace', 'line-1', 'node-1']])
  assert.equal(page.data.nodeName, '资料审核')
  assert.equal(page.data.canSubmit, true)
  assert.equal(page.data.expectedNodeVersion, 3)
  assert.deepEqual(page.data.fields.map(item => item.fieldKey), [
    'summary', 'detail', 'amount', 'confirmed', 'date', 'level', 'tags'
  ])
  assert.equal(page.data.fieldValues.confirmed, null, '布尔字段不得把未选择状态伪装成 false')
})

test('七类字段保持类型并按稳定字段标识和顺序提交', async () => {
  const submitted = []
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    showToast: options => toasts.push(options),
    reLaunch: () => assert.fail('有效账号不应被重定向')
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核', status: 'ready' }, canSubmit: true, history: [] }),
    submitFeedback: async input => { submitted.push(input); return { feedbackId: 'feedback-1' } }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '已核对' } })
  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'detail' } }, detail: { value: '补充说明' } })
  page.onNumberInput({ currentTarget: { dataset: { fieldkey: 'amount' } }, detail: { value: '12.50' } })
  page.onBooleanChange({ currentTarget: { dataset: { fieldkey: 'confirmed' } }, detail: { value: false } })
  page.onDateChange({ currentTarget: { dataset: { fieldkey: 'date' } }, detail: { value: '2026-08-10' } })
  page.onSingleSelectChange({ currentTarget: { dataset: { fieldkey: 'level' } }, detail: { value: 1 } })
  page.onMultiSelectChange({ currentTarget: { dataset: { fieldkey: 'tags' } }, detail: { value: ['甲', '乙'] } })
  page.setData({ comment: '本次处理完成', statusIndex: 2 })
  await page.submit()

  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0].fieldValues, [
    { fieldKey: 'summary', value: '已核对' },
    { fieldKey: 'detail', value: '补充说明' },
    { fieldKey: 'amount', value: 12.5 },
    { fieldKey: 'confirmed', value: false },
    { fieldKey: 'date', value: '2026-08-10' },
    { fieldKey: 'level', value: '低' },
    { fieldKey: 'tags', value: ['甲', '乙'] }
  ])
  assert.equal(submitted[0].businessLineId, 'line-1')
  assert.equal(submitted[0].nodeId, 'node-1')
  assert.equal(submitted[0].expectedNodeVersion, 3)
  assert.match(submitted[0].requestKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  assert.deepEqual(toasts.map(item => item.title), ['反馈成功'])
})

test('必填动态字段、数字格式和冻结状态在发起请求前拦截', async () => {
  let submissions = 0
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    showToast: options => toasts.push(options),
    reLaunch: () => assert.fail('有效账号不应被重定向')
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核', status: 'ready' }, canSubmit: true, history: [] }),
    submitFeedback: async () => { submissions += 1 }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  await page.submit()
  assert.equal(submissions, 0)
  assert.match(toasts.at(-1).title, /摘要|必填/)

  page.onFieldInput({ currentTarget: { dataset: { fieldkey: 'summary' } }, detail: { value: '完成' } })
  page.onNumberInput({ currentTarget: { dataset: { fieldkey: 'amount' } }, detail: { value: '不是数字' } })
  await page.submit()
  assert.equal(submissions, 0)
  assert.match(toasts.at(-1).title, /金额|数字/)

  page.setData({ canSubmit: false, frozen: true })
  await page.submit()
  assert.equal(submissions, 0)
  assert.match(toasts.at(-1).title, /冻结|不可提交/)
})

test('文本、日期、布尔和选项约束在上传前给出字段级提示', async () => {
  let submissions = 0
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    showToast: options => toasts.push(options),
    reLaunch: () => assert.fail('有效账号不应被重定向')
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
    submitFeedback: async () => { submissions += 1 }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({
    fieldValues: {
      summary: '短', detail: '', amount: 1, confirmed: false,
      date: '2026-02-30', level: '不存在', tags: ['甲', '不存在']
    },
    statusIndex: 2
  })

  await page.submit()
  assert.equal(submissions, 0)
  assert.match(toasts.at(-1).title, /摘要.*长度/)

  page.setData({ 'fieldValues.summary': '足够长度' })
  await page.submit()
  assert.equal(submissions, 0)
  assert.match(toasts.at(-1).title, /日期/)
})

test('不可变历史按反馈版本显示字段快照和凭证状态，七类控件均存在', async () => {
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向') }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ status: 'completed' }), { status: 'completed' }),
    getNodeHistory: async () => ({
      node: { id: 'node-1', name: '资料审核', status: 'completed' },
      canSubmit: false,
      history: [{
        feedbackId: 'feedback-2', revision: 2, status: 'completed', comment: '第二版',
        fieldValues: [{ fieldKey: 'summary', name: '摘要', type: 'short_text', value: '已更新' }],
        evidences: [
          { evidenceId: 'ev-live', fileName: '材料.pdf', category: 'pdf', storageStatus: 'available' },
          { evidenceId: 'ev-purged', fileName: '旧视频.mp4', category: 'video', storageStatus: 'purged' }
        ]
      }]
    })
  })

  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  assert.equal(page.data.frozen, true)
  assert.equal(page.data.history[0].revision, 2)
  assert.equal(page.data.history[0].fieldValues[0].valueText, '已更新')
  assert.equal(page.data.history[0].evidences[1].canPreview, false)

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/node-feedback/index.wxml'), 'utf8')
  assert.match(wxml, /short_text/)
  assert.match(wxml, /long_text/)
  assert.match(wxml, /number/)
  assert.match(wxml, /boolean/)
  assert.match(wxml, /date/)
  assert.match(wxml, /single_select/)
  assert.match(wxml, /multi_select/)
  assert.doesNotMatch(wxml, /\.includes\(/)
  assert.match(wxml, /fieldValues/)
  assert.match(wxml, /revision/)
  assert.match(wxml, /已清理/)
})

test('图片、PDF 和多个视频可反复选择，不设产品单文件上限且单轮合计限制为 120 MiB', async () => {
  const mebibyte = 1024 * 1024
  const toasts = []
  let mediaSuccess
  let pdfSuccess
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: options => toasts.push(options),
    chooseMedia: options => { mediaSuccess = options.success },
    chooseMessageFile: options => { pdfSuccess = options.success }
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  page.chooseMediaEvidence()
  mediaSuccess({ tempFiles: [
    { tempFilePath: 'wxfile://image.jpg', size: 4 * mebibyte, fileType: 'image' },
    { tempFilePath: 'wxfile://video-a.mp4', size: 6 * mebibyte, fileType: 'video' },
    { tempFilePath: 'wxfile://video-b.mp4', size: 5 * mebibyte, fileType: 'video' }
  ] })
  page.choosePdfEvidence()
  pdfSuccess({ tempFiles: [{ path: 'wxfile://材料.pdf', name: '材料.pdf', size: 4 * mebibyte, type: 'file' }] })

  assert.deepEqual(page.data.files.map(item => item.category), ['image', 'video', 'video', 'pdf'])
  assert.equal(page.data.selectedTotalBytes, 19 * mebibyte)

  page.choosePdfEvidence()
  pdfSuccess({ tempFiles: [{ path: 'wxfile://large.pdf', name: 'large.pdf', size: 101 * mebibyte }] })
  assert.equal(page.data.files.length, 5)
  assert.equal(page.data.selectedTotalBytes, 120 * mebibyte)

  page.choosePdfEvidence()
  pdfSuccess({ tempFiles: [{ path: 'wxfile://over.pdf', name: 'over.pdf', size: 1 }] })
  assert.equal(page.data.files.length, 5)
  assert.match(toasts.at(-1).title, /合计.*120 MB/)
})

test('Mac 使用本地文件选择器选择图片视频，移动端继续使用相册接口', async () => {
  const desktopFiles = []
  let desktopPicker
  let mobilePicker
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: () => {},
    getDeviceInfo: () => ({ platform: 'mac' }),
    chooseMedia: () => assert.fail('Mac 不应调用手机相册接口'),
    chooseMessageFile: options => { desktopPicker = options }
  }
  const desktopPage = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({
      fieldDefinitions: [], allowedEvidenceTypes: ['jpg', 'jpeg', 'png', 'mp4', 'mov', 'm4v']
    })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })
  await desktopPage.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  desktopPage.chooseMediaEvidence()
  assert.equal(desktopPicker.type, 'all')
  assert.equal(Object.hasOwn(desktopPicker, 'extension'), false)
  desktopPicker.success({ tempFiles: [
    { path: 'wxfile://desktop.png', name: 'desktop.png', size: 1024, type: 'file' }
  ] })
  desktopFiles.push(...desktopPage.data.files)
  assert.deepEqual(desktopFiles.map(file => [file.path, file.category]), [['wxfile://desktop.png', 'image']])

  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: () => {},
    getDeviceInfo: () => ({ platform: 'ios' }),
    chooseMedia: options => { mobilePicker = options },
    chooseMessageFile: () => assert.fail('移动端不应改走本地文件接口')
  }
  const mobilePage = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })
  await mobilePage.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  mobilePage.chooseMediaEvidence()
  assert.deepEqual(mobilePicker.mediaType, ['image', 'video'])
})

test('凭证最多三个并发上传，失败重试不重复上传成功项且只提交 evidenceId', async () => {
  const events = []
  let secondAttempt = false
  let feedbackInput
  let active = 0
  let maximumActive = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: options => events.push(['toast', options.title]),
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({
      fieldDefinitions: [], requiresEvidence: true, allowedEvidenceTypes: ['pdf', 'mp4']
    })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
    submitFeedback: async input => { feedbackInput = input; events.push(['submit']) }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({
    statusIndex: 2,
    files: [
      { localKey: 'a', name: 'a.pdf', path: 'wxfile://a.pdf', size: 1024, category: 'pdf', extension: 'pdf', status: 'pending' },
      { localKey: 'b', name: 'b.mp4', path: 'wxfile://b.mp4', size: 2048, category: 'video', extension: 'mp4', status: 'pending' },
      { localKey: 'c', name: 'c.pdf', path: 'wxfile://c.pdf', size: 1024, category: 'pdf', extension: 'pdf', status: 'pending' },
      { localKey: 'd', name: 'd.pdf', path: 'wxfile://d.pdf', size: 1024, category: 'pdf', extension: 'pdf', status: 'pending' }
    ],
    selectedTotalBytes: 5120
  })
  page.createEvidenceUploader = () => ({
    upload: async ({ file, onProgress }) => {
      events.push(['upload', file.path])
      active += 1
      maximumActive = Math.max(maximumActive, active)
      onProgress(50)
      await new Promise(resolve => setImmediate(resolve))
      active -= 1
      if (file.path === 'wxfile://b.mp4' && !secondAttempt) throw new Error('网络中断')
      return { evidenceId: `evidence-${file.localKey}`, storageStatus: 'available' }
    }
  })

  await page.submit()
  assert.equal(feedbackInput, undefined)
  assert.equal(page.data.files[0].status, 'registered')
  assert.equal(page.data.files[0].evidenceId, 'evidence-a')
  assert.equal(page.data.files[1].status, 'failed')
  assert.equal(page.data.files[2].status, 'registered')
  assert.equal(page.data.files[3].status, 'registered')
  assert.equal(maximumActive, 3)

  secondAttempt = true
  await page.submit()
  assert.deepEqual(events.filter(item => item[0] === 'upload').map(item => item[1]), [
    'wxfile://a.pdf', 'wxfile://b.mp4', 'wxfile://c.pdf', 'wxfile://d.pdf', 'wxfile://b.mp4'
  ])
  assert.deepEqual(feedbackInput.evidenceIds, ['evidence-a', 'evidence-b', 'evidence-c', 'evidence-d'])
  assert.equal(Object.prototype.hasOwnProperty.call(feedbackInput, 'evidences'), false)
})

test('可选空白名单允许全部十种受支持格式，有限名单仍在本地拒绝未允许格式', async () => {
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: options => toasts.push(options)
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  const supported = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'mov', 'm4v']
  assert.deepEqual(page.data.allowedEvidenceTypes, supported)
  page.addSelectedFiles(supported.map(extension => ({
    name: `evidence.${extension}`,
    path: `wxfile://evidence.${extension}`,
    size: 1,
    category: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(extension) ? 'image' : extension === 'pdf' ? 'pdf' : 'video'
  })))
  assert.deepEqual(page.data.files.map(file => file.extension), supported)
  assert.ok(page.data.files.every(file => file.status === 'pending'))

  const restricted = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: ['pdf'] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })
  await restricted.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  restricted.addSelectedFiles([{ name: 'evidence.jpg', path: 'wxfile://evidence.jpg', size: 1, category: 'image' }])
  assert.equal(restricted.data.files.length, 0)
  assert.equal(toasts.at(-1).title, '当前节点不允许 JPG 格式')
})

test('必传空白名单与损坏格式快照均失败关闭为只读', async () => {
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: options => toasts.push(options)
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [], requiresEvidence: true, allowedEvidenceTypes: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  assert.equal(page.data.readOnly, true)
  assert.equal(page.data.canSubmit, false)
  assert.equal(page.data.errorMessage, '当前节点凭证配置无效，请联系管理员')
  page.addSelectedFiles([{ name: 'evidence.jpg', path: 'wxfile://evidence.jpg', size: 1, category: 'image' }])
  assert.equal(page.data.files.length, 0)

  const malformed = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: ['pdf', 'pdf'] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })
  await malformed.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  assert.equal(malformed.data.readOnly, true)
  assert.equal(malformed.data.errorMessage, '当前节点凭证配置无效，请联系管理员')

  for (const invalidNode of [
    nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: 'pdf' }),
    nodeFixture({ fieldDefinitions: [], requiresEvidence: 'false', allowedEvidenceTypes: ['pdf'] }),
    nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: ['exe'] }),
    Object.create(nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: ['pdf'] }))
  ]) {
    const candidate = loadPage({
      getBusinessLine: async () => businessFixture(invalidNode),
      getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
    })
    await candidate.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
    assert.equal(candidate.data.readOnly, true)
    assert.equal(candidate.data.errorMessage, '当前节点凭证配置无效，请联系管理员')
  }
  assert.equal(toasts.length, 0)
})

test('继承或访问器凭证配置以及稀疏白名单均在真实页面加载时失败关闭', async () => {
  const writes = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: () => {}
  }
  const inheritedRequired = Object.create(nodeFixture({ fieldDefinitions: [], requiresEvidence: true }))
  Object.defineProperty(inheritedRequired, 'allowedEvidenceTypes', { value: [], enumerable: true })
  const accessorRequired = nodeFixture({ fieldDefinitions: [], allowedEvidenceTypes: [] })
  delete accessorRequired.requiresEvidence
  Object.defineProperty(accessorRequired, 'requiresEvidence', { get: () => true, enumerable: true })
  const sparseAllowedTypes = nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: new Array(1) })

  for (const node of [inheritedRequired, accessorRequired, sparseAllowedTypes]) {
    const page = loadPage({
      getBusinessLine: async () => businessFixture(node),
      getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
      submitFeedback: async () => writes.push('submit')
    })
    await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
    assert.equal(page.data.readOnly, true)
    assert.equal(page.data.canSubmit, false)
    assert.equal(page.data.errorMessage, '当前节点凭证配置无效，请联系管理员')
    page.addSelectedFiles([{ name: 'evidence.jpg', path: 'wxfile://evidence.jpg', size: 1, category: 'image' }])
    await page.submit()
    assert.equal(page.data.files.length, 0)
  }
  assert.deepEqual(writes, [])
})

test('白名单索引访问器不执行且在真实页面加载时失败关闭', async () => {
  let getterCalls = 0
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: () => {}
  }
  const allowedEvidenceTypes = []
  Object.defineProperty(allowedEvidenceTypes, '0', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'pdf'
    }
  })
  allowedEvidenceTypes.length = 1
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({
      fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes
    })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] })
  })

  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  assert.equal(getterCalls, 0)
  assert.equal(page.data.readOnly, true)
  assert.equal(page.data.canSubmit, false)
  assert.equal(page.data.errorMessage, '当前节点凭证配置无效，请联系管理员')
})

test('云文件上传中文前缀异常不会进入文件状态', async () => {
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: () => {}
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: ['pdf'] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
    submitFeedback: async () => assert.fail('上传失败时不得提交反馈')
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.createEvidenceUploader = () => ({
    upload: async () => { throw new Error('网络异常 errCode=600001 cloud://private/upload') }
  })
  page.setData({ statusIndex: 2, files: [{ localKey: 'one', name: 'evidence.pdf', path: 'wxfile://evidence.pdf', size: 1, category: 'pdf', extension: 'pdf', status: 'pending' }] })

  await page.submit()

  assert.equal(page.data.files[0].status, 'failed')
  assert.equal(page.data.files[0].errorMessage, '上传失败，请重试')
  assert.doesNotMatch(page.data.files[0].errorMessage, /errCode|cloud:\/\//)
})

test('审核处理上传异常不会向保存进度或提交审核的外层提示泄漏详情', async () => {
  for (const action of ['onSaveProgress', 'onSubmitReview']) {
    const toasts = []
    global.getApp = () => ({ globalData: { currentUser: activeUser() } })
    global.wx = {
      setNavigationBarTitle: () => {},
      reLaunch: () => assert.fail('有效账号不应被重定向'),
      showToast: options => toasts.push(options)
    }
    const page = loadPage({
      getBusinessLine: async () => businessFixture(nodeFixture({
        fieldDefinitions: [], workflowMode: 'review', status: 'in_progress',
        allowedEvidenceTypes: ['pdf']
      })),
      getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
      submitFeedback: async () => assert.fail('上传失败时不得保存处理进度'),
      submitNodeForReview: async () => assert.fail('上传失败时不得提交审核')
    })
    await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
    page.createEvidenceUploader = () => ({
      upload: async () => { throw new Error('网络异常 errCode=600001 cloud://private/upload') }
    })
    page.setData({ files: [{ localKey: 'one', name: 'evidence.pdf', path: 'wxfile://evidence.pdf', size: 1, category: 'pdf', extension: 'pdf', status: 'pending' }] })

    await page[action]()

    assert.equal(page.data.files[0].errorMessage, '上传失败，请重试')
    assert.equal(toasts.at(-1).title, '上传失败，请重试')
    assert.doesNotMatch(toasts.at(-1).title, /errCode|cloud:\/\//)
  }
})

test('凭证下载中文前缀异常只显示固定安全提示', async () => {
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showLoading: () => {},
    hideLoading: () => {},
    showToast: options => toasts.push(options),
    downloadFile: async () => {
      throw new Error('下载异常 errCode=600001 cloud://private/download')
    }
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: false, history: [] }),
    getEvidenceAccess: async () => ({
      url: 'https://temporary.example/evidence.pdf', fileName: 'evidence.pdf', category: 'pdf'
    })
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  await page.previewEvidence({ currentTarget: { dataset: { evidenceid: 'pdf-1', category: 'pdf', status: 'available' } } })

  assert.equal(toasts.at(-1).title, '凭证暂时无法打开')
  assert.doesNotMatch(toasts.at(-1).title, /errCode|cloud:\/\//)
})

test('凭证登记失败仅保存服务层固定中文安全错误', async () => {
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: () => {}
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: ['pdf'] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
    submitFeedback: async () => assert.fail('登记失败时不得提交反馈')
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.createEvidenceUploader = () => ({
    upload: async () => { throw Object.assign(new Error('文件格式不受支持，请重新选择'), { code: 'UNSUPPORTED_FILE_TYPE' }) }
  })
  page.setData({ statusIndex: 2, files: [{ localKey: 'one', name: 'evidence.pdf', path: 'wxfile://evidence.pdf', size: 1, category: 'pdf', extension: 'pdf', status: 'pending' }] })
  await page.submit()
  assert.equal(page.data.files[0].status, 'failed')
  assert.equal(page.data.files[0].errorMessage, '文件格式不受支持，请重新选择')
})

test('凭证预览先获取短期授权，图片、PDF、视频分别使用安全查看方式', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: options => calls.push(['toast', options.title]),
    showLoading: () => {},
    hideLoading: () => {},
    previewImage: options => calls.push(['image', options.current]),
    downloadFile: async options => { calls.push(['download', options.url]); return { tempFilePath: 'wxfile://temporary.pdf' } },
    openDocument: async options => calls.push(['pdf', options.filePath])
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: false, history: [] }),
    getEvidenceAccess: async evidenceId => {
      calls.push(['grant', evidenceId])
      return { url: `https://temporary.example/${evidenceId}`, fileName: `${evidenceId}.bin`, category: evidenceId.split('-')[0], expiresAt: '2026-08-10T12:00:00.000Z' }
    }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  await page.previewEvidence({ currentTarget: { dataset: { evidenceid: 'image-1', category: 'image', status: 'available' } } })
  await page.previewEvidence({ currentTarget: { dataset: { evidenceid: 'pdf-1', category: 'pdf', status: 'available' } } })
  await page.previewEvidence({ currentTarget: { dataset: { evidenceid: 'video-1', category: 'video', status: 'available' } } })
  await page.previewEvidence({ currentTarget: { dataset: { evidenceid: 'video-purged', category: 'video', status: 'purged' } } })

  assert.deepEqual(calls, [
    ['grant', 'image-1'], ['image', 'https://temporary.example/image-1'],
    ['grant', 'pdf-1'], ['download', 'https://temporary.example/pdf-1'], ['pdf', 'wxfile://temporary.pdf'],
    ['grant', 'video-1']
  ])
  assert.equal(page.data.videoPreview.url, 'https://temporary.example/video-1')

  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/node-feedback/index.wxml'), 'utf8')
  assert.match(wxml, /chooseMediaEvidence/)
  assert.match(wxml, /choosePdfEvidence/)
  assert.match(wxml, /<video\b/)
  assert.match(wxml, /data-evidenceid/)
  assert.doesNotMatch(wxml, /data-fileid|item\.fileId/)
})

test('HEIC 和 HEIF 历史凭证使用受保护的下载兜底而不调用图片预览', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showLoading: () => {},
    hideLoading: () => {},
    showToast: options => calls.push(['toast', options.title]),
    previewImage: () => assert.fail('HEIC 不应直接进入图片预览'),
    downloadFile: async options => { calls.push(['download', options.url]); return { tempFilePath: 'wxfile://evidence.heic' } },
    saveFile: async options => calls.push(['save', options.tempFilePath])
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: false, history: [] }),
    getEvidenceAccess: async () => ({
      url: 'https://temporary.example/evidence.heic', fileName: 'evidence.heic', category: 'image'
    })
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })

  await page.previewEvidence({ currentTarget: { dataset: {
    evidenceid: 'image-heic', category: 'image', status: 'available', filename: 'evidence.heic'
  } } })

  assert.deepEqual(calls, [
    ['download', 'https://temporary.example/evidence.heic'],
    ['save', 'wxfile://evidence.heic'],
    ['toast', '文件已下载，请从下载记录打开']
  ])
})

test('批量下载逐个申请授权并按历史顺序保存，单项失败后停止并报告进度', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向'),
    showLoading: () => {}, hideLoading: () => {}, showToast: options => calls.push(['toast', options.title]),
    downloadFile: async ({ url }) => { calls.push(['download', url]); return { tempFilePath: `wxfile://${url.split('/').pop()}` } },
    saveFile: async ({ tempFilePath }) => calls.push(['save', tempFilePath])
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [] })),
    getNodeHistory: async () => ({
      node: { id: 'node-1', name: '资料审核' }, canSubmit: false,
      history: [{ feedbackId: 'f-1', evidences: [
        { evidenceId: 'e-1', fileName: '一.pdf', category: 'pdf', storageStatus: 'available' },
        { evidenceId: 'e-2', fileName: '二.mp4', category: 'video', storageStatus: 'available' }
      ] }]
    }),
    getEvidenceAccess: async id => { calls.push(['grant', id]); return { url: `https://temporary/${id}` } }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  await page.downloadAllEvidence()
  assert.deepEqual(calls, [
    ['grant', 'e-1'], ['download', 'https://temporary/e-1'], ['save', 'wxfile://e-1'],
    ['grant', 'e-2'], ['download', 'https://temporary/e-2'], ['save', 'wxfile://e-2'],
    ['toast', '已完成 2 个文件']
  ])
})

test('提交反馈等待期间账号切换时丢弃旧结果且不显示成功提示', async () => {
  const pending = deferred()
  const launches = []
  const toasts = []
  const app = { globalData: { currentUser: activeUser('account-before') } }
  global.getApp = () => app
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: options => launches.push(options),
    showToast: options => toasts.push(options)
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
    submitFeedback: () => pending.promise
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({ statusIndex: 2 })
  const submission = page.submit()
  app.globalData.currentUser = activeUser('account-after')
  pending.resolve({ feedbackId: 'feedback-1' })
  await submission

  assert.deepEqual(launches, [{ url: '/pages/login/index' }])
  assert.equal(toasts.some(item => item.title === '反馈成功'), false)
})
