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
  try {
    withFakeModule('services/business.js', businessFake, () => {
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

test('反馈页只接受标识参数，并以服务端节点快照和权限构建动态表单', async () => {
  const calls = []
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = { setNavigationBarTitle: () => {}, reLaunch: () => assert.fail('有效账号不应被重定向') }
  const page = loadPage({
    getBusinessLine: async id => { calls.push(['line', id]); return businessFixture() },
    getNodeHistory: async (lineId, nodeId) => {
      calls.push(['history', lineId, nodeId])
      return { node: { id: nodeId, name: '资料审核', nodeCode: 'YW-1-N001', status: 'ready' }, canSubmit: true, history: [] }
    }
  })

  await page.onLoad({
    lineId: 'line-1', nodeId: 'node-1',
    nodeName: encodeURIComponent('伪造名称'), canFeedback: '0', expectedNodeVersion: '999'
  })

  assert.deepEqual(calls, [['line', 'line-1'], ['history', 'line-1', 'node-1']])
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

test('图片、PDF 和多个视频可分批选择，单文件与合计大小在上传前校验', async () => {
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

  page.chooseMediaEvidence()
  mediaSuccess({ tempFiles: [{ tempFilePath: 'wxfile://oversize.jpg', size: 6 * mebibyte, fileType: 'image' }] })
  assert.equal(page.data.files.length, 4)
  assert.match(toasts.at(-1).title, /图片.*5 MB/)

  page.choosePdfEvidence()
  pdfSuccess({ tempFiles: [{ path: 'wxfile://more.pdf', name: 'more.pdf', size: 2 * mebibyte }] })
  assert.equal(page.data.files.length, 4)
  assert.match(toasts.at(-1).title, /合计.*20 MB/)
})

test('凭证按顺序上传并立即登记，失败重试不重复上传成功项且只提交 evidenceId', async () => {
  const events = []
  let secondAttempt = false
  let feedbackInput
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: options => events.push(['toast', options.title]),
    cloud: {
      uploadFile: async ({ filePath }) => {
        events.push(['upload', filePath])
        if (filePath === 'wxfile://b.mp4' && !secondAttempt) throw new Error('网络中断')
        return { fileID: `cloud://${filePath.split('//')[1]}` }
      }
    }
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({
      fieldDefinitions: [], requiresEvidence: true, allowedEvidenceTypes: ['pdf', 'mp4']
    })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
    registerEvidenceUpload: async input => {
      events.push(['register', input.fileName, input.fileId])
      return { evidenceId: input.fileName === 'a.pdf' ? 'evidence-a' : 'evidence-b' }
    },
    submitFeedback: async input => { feedbackInput = input; events.push(['submit']) }
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
  page.setData({
    statusIndex: 2,
    files: [
      { localKey: 'a', name: 'a.pdf', path: 'wxfile://a.pdf', size: 1024, category: 'pdf', extension: 'pdf', status: 'pending' },
      { localKey: 'b', name: 'b.mp4', path: 'wxfile://b.mp4', size: 2048, category: 'video', extension: 'mp4', status: 'pending' }
    ],
    selectedTotalBytes: 3072
  })

  await page.submit()
  assert.equal(feedbackInput, undefined)
  assert.equal(page.data.files[0].status, 'registered')
  assert.equal(page.data.files[0].evidenceId, 'evidence-a')
  assert.equal(page.data.files[1].status, 'failed')

  secondAttempt = true
  await page.submit()
  assert.deepEqual(events.filter(item => item[0] === 'upload'), [
    ['upload', 'wxfile://a.pdf'],
    ['upload', 'wxfile://b.mp4'],
    ['upload', 'wxfile://b.mp4']
  ])
  assert.deepEqual(feedbackInput.evidenceIds, ['evidence-a', 'evidence-b'])
  assert.equal(Object.prototype.hasOwnProperty.call(feedbackInput, 'evidences'), false)
})

test('可选空白名单允许七种受支持格式，有限名单仍在本地拒绝未允许格式', async () => {
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
  assert.deepEqual(page.data.allowedEvidenceTypes, ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])
  page.addSelectedFiles(['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'].map(extension => ({
    name: `evidence.${extension}`,
    path: `wxfile://evidence.${extension}`,
    size: 1,
    category: ['jpg', 'jpeg', 'png'].includes(extension) ? 'image' : extension === 'pdf' ? 'pdf' : 'video'
  })))
  assert.deepEqual(page.data.files.map(file => file.extension), ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])
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

test('凭证登记失败仅保存服务层固定中文安全错误', async () => {
  global.getApp = () => ({ globalData: { currentUser: activeUser() } })
  global.wx = {
    setNavigationBarTitle: () => {},
    reLaunch: () => assert.fail('有效账号不应被重定向'),
    showToast: () => {},
    cloud: { uploadFile: async () => ({ fileID: 'cloud://masked/upload' }) }
  }
  const page = loadPage({
    getBusinessLine: async () => businessFixture(nodeFixture({ fieldDefinitions: [], requiresEvidence: false, allowedEvidenceTypes: ['pdf'] })),
    getNodeHistory: async () => ({ node: { id: 'node-1', name: '资料审核' }, canSubmit: true, history: [] }),
    registerEvidenceUpload: async () => { throw Object.assign(new Error('文件格式不受支持，请重新选择'), { code: 'UNSUPPORTED_FILE_TYPE' }) },
    submitFeedback: async () => assert.fail('登记失败时不得提交反馈')
  })
  await page.onLoad({ lineId: 'line-1', nodeId: 'node-1' })
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
