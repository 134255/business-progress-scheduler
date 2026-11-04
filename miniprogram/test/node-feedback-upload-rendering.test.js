const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const pagePath = path.resolve(__dirname, '../pages/node-feedback/index.js')
const sourcePath = process.env.UPLOAD_RENDER_SOURCE || pagePath
const localRequire = createRequire(pagePath)
const plain = value => JSON.parse(JSON.stringify(value))
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function file(index, extra = {}) {
  return { localKey: `synthetic-${index}`, name: `proof-${index}.pdf`,
    path: `wxfile://synthetic-${index}.pdf`, size: 100, category: 'pdf', extension: 'pdf',
    status: 'pending', progressPercent: 0, statusLabel: '待上传', ...extra }
}
function setByPath(target, key, value) {
  const segments = key.replace(/\[(\d+)\]/g, '.$1').split('.')
  let owner = target
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]
    if (owner[segment] === undefined) owner[segment] = /^\d+$/.test(segments[i + 1]) ? [] : {}
    owner = owner[segment]
  }
  owner[segments.at(-1)] = value
}
function setup(files = [file(0)]) {
  let definition
  const app = { globalData: { currentUser: { _id: 'synthetic-actor', status: 'active', role: 'user' } } }
  const calls = []
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    Page: value => { definition = value }, getApp: () => app,
    wx: { reLaunch() {}, showToast() {}, setNavigationBarTitle() {} },
    require: name => name === '../../services/business' ? {} : localRequire(name)
  }, { filename: pagePath })
  const page = { ...definition, data: plain(definition.data), pageAlive: true,
    loadActorId: 'synthetic-actor', identityInvalidated: false, writeSequence: 7,
    loadSequence: 1, reviewHistorySequence: 0, recognitionSequence: 0,
    setData(update) {
      calls.push(plain(update))
      for (const [key, value] of Object.entries(update)) setByPath(this.data, key, value)
    } }
  Object.assign(page.data, { files: plain(files), uploadProgressPercent: 0,
    lineId: 'synthetic-line', nodeId: 'synthetic-node', expectedNodeVersion: 3 })
  const operation = { actorId: 'synthetic-actor', lineId: 'synthetic-line', nodeId: 'synthetic-node',
    nodeVersion: 3, sequence: 7 }
  return { page, app, calls, operation }
}
function snapshot(page) {
  return plain({ files: page.data.files, progress: page.data.uploadProgressPercent })
}

// Each assertion exercises the real page's setData boundary, not a replacement updater.
test('progress refresh transmits only the changed attachment and its weighted total', () => {
  const { page, calls } = setup([file(0), file(1, { size: 300 }), file(2, { size: 600 })])
  const untouched = plain([page.data.files[0], page.data.files[2]])
  page.updateLocalFile(1, { progressPercent: 40, statusLabel: '上传中 40%' })
  assert.equal(page.data.uploadProgressPercent, 12)
  assert.equal(page.data.files[1].statusLabel, '上传中 40%')
  assert.deepEqual([page.data.files[0], page.data.files[2]], untouched)
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['files[1]', 'uploadProgressPercent'])
  assert.equal(calls[0]['files[1]'].localKey, 'synthetic-1')
  assert.equal(JSON.stringify(calls[0]).includes('synthetic-2'), false)
})

test('identical progress and label do not refresh a settled visible row again', () => {
  const { page, calls } = setup()
  page.updateLocalFile(0, { progressPercent: 40, statusLabel: '上传中 40%' })
  const first = snapshot(page)
  for (let i = 0; i < 9; i += 1)
    page.updateLocalFile(0, { progressPercent: 40, statusLabel: '上传中 40%' })
  assert.deepEqual(snapshot(page), first)
  assert.equal(calls.length, 1)
})

test('different file progress with the same rounded total never resends the total', () => {
  const { page, calls } = setup([file(0, { size: 1 }), file(1, { size: 999 })])
  page.updateLocalFile(0, { progressPercent: 20 })
  page.updateLocalFile(0, { progressPercent: 21 })
  assert.equal(page.data.files[0].progressPercent, 21)
  assert.equal(page.data.uploadProgressPercent, 0)
  assert.equal(calls.length, 2)
  for (const call of calls) assert.deepEqual(Object.keys(call), ['files[0]'])
})

test('a retry label at the same percentage is still displayed immediately', () => {
  const { page, calls } = setup()
  page.updateLocalFile(0, { progressPercent: 80, statusLabel: '上传中 80%（第 1/3 次）' })
  page.updateLocalFile(0, { progressPercent: 80, statusLabel: '上传中 80%（第 2/3 次）' })
  assert.equal(calls.length, 2)
  assert.equal(page.data.files[0].statusLabel, '上传中 80%（第 2/3 次）')
  assert.deepEqual(Object.keys(calls[1]), ['files[0]'])
})

test('100 percent transfer, waiting, registration and normalized name remain distinct', () => {
  const { page } = setup([file(0, { name: 'synthetic.jpg', path: 'wxfile://original.jpg' })])
  page.updateLocalFile(0, { status: 'uploading', progressPercent: 100, statusLabel: '上传中 100%' })
  assert.equal(page.data.files[0].evidenceId, undefined)
  page.updateLocalFile(0, { statusLabel: '等待核验登记' })
  assert.equal(page.data.files[0].status, 'uploading')
  assert.equal(page.data.files[0].statusLabel, '等待核验登记')
  page.updateLocalFile(0, { status: 'registered', statusLabel: '已登记', evidenceId: 'synthetic-evidence',
    name: 'synthetic.png', extension: 'png', canRetry: false, errorMessage: '' })
  assert.deepEqual(plain(page.data.files[0]), file(0, { name: 'synthetic.png', path: 'wxfile://original.jpg',
    extension: 'png', status: 'registered', progressPercent: 100, statusLabel: '已登记',
    evidenceId: 'synthetic-evidence', canRetry: false, errorMessage: '' }))
  assert.equal(page.data.uploadProgressPercent, 100)
})

test('registered bytes count as complete even when the stored progress field is zero', () => {
  const { page } = setup([file(0, { status: 'registered', evidenceId: 'done' }),
    file(1, { size: 300, progressPercent: 50 }), file(2, { size: 600 })])
  page.updateLocalFile(2, { progressPercent: 25 })
  assert.equal(page.data.uploadProgressPercent, 40)
})

test('an unchanged row still corrects a total invalidated by replacing the attachment list', () => {
  const { page, calls } = setup([file(0, { progressPercent: 50 })])
  page.updateLocalFile(0, { progressPercent: 50 })
  assert.equal(page.data.uploadProgressPercent, 50)
  assert.deepEqual(calls, [{ uploadProgressPercent: 50 }])
})

test('a fully unchanged row and total produce no bridge payload', () => {
  const { page, calls } = setup()
  page.updateLocalFile(0, {})
  page.updateLocalFile(0, { progressPercent: 0, statusLabel: '待上传' })
  assert.equal(calls.length, 0)
  assert.equal(page.data.files.length, 1)
})

test('zero-byte attachments keep a zero total but still update their visible status', () => {
  const { page, calls } = setup([file(0, { size: 0 }), file(1, { size: 0 })])
  page.updateLocalFile(0, { status: 'registered', progressPercent: 100, statusLabel: '已登记' })
  assert.equal(page.data.uploadProgressPercent, 0)
  assert.equal(page.data.files[0].statusLabel, '已登记')
  assert.deepEqual(Object.keys(calls[0]), ['files[0]'])
})

test('clearing errors and retry flags preserves false, zero and empty strings', () => {
  const { page } = setup([file(0, { progressPercent: 90, status: 'failed',
    canRetry: true, errorMessage: '旧错误', errorCode: 'NetworkError' })])
  page.data.uploadProgressPercent = 90
  page.updateLocalFile(0, { status: 'uploading', progressPercent: 0,
    canRetry: false, errorMessage: '', errorCode: '' })
  assert.equal(page.data.files[0].progressPercent, 0)
  assert.equal(page.data.files[0].canRetry, false)
  assert.equal(page.data.files[0].errorMessage, '')
  assert.equal(page.data.files[0].errorCode, '')
  assert.equal(page.data.uploadProgressPercent, 0)
})

for (const [progress, total] of [[-20, 0], [125, 100], ['50', 50]]) {
  test(`the existing aggregate interpretation of progress ${progress} stays unchanged`, () => {
    const { page } = setup()
    page.updateLocalFile(0, { progressPercent: progress })
    assert.equal(page.data.files[0].progressPercent, progress)
    assert.equal(page.data.uploadProgressPercent, total)
  })
}

test('three interleaved rows retain hand-calculated weighted progress after every event', () => {
  const { page } = setup([file(0), file(1, { size: 300 }), file(2, { size: 600 })])
  const events = [[0, { progressPercent: 50 }, 5], [1, { progressPercent: 50 }, 20],
    [2, { progressPercent: 25 }, 35], [0, { status: 'registered' }, 40],
    [1, { status: 'failed', statusLabel: '上传失败' }, 40],
    [1, { progressPercent: 0, status: 'uploading' }, 25],
    [2, { progressPercent: 100 }, 70], [1, { progressPercent: 100, status: 'registered' }, 100]]
  for (const [index, changes, total] of events) {
    page.updateLocalFile(index, changes)
    assert.equal(page.data.uploadProgressPercent, total)
    assert.deepEqual(page.data.files.map(item => item.localKey), ['synthetic-0', 'synthetic-1', 'synthetic-2'])
  }
})

test('the real upload worker keeps three lanes, registration order and failed-file-only retry', async () => {
  const { page, operation } = setup([file(0), file(1), file(2), file(3)])
  const gates = Array.from({ length: 4 }, deferred)
  const started = []
  let active = 0, peak = 0
  page.createEvidenceUploader = () => ({ upload: async input => {
    const index = Number(input.file.localKey.split('-').at(-1))
    started.push(index)
    active += 1; peak = Math.max(peak, active)
    try {
      input.onStatus({ stage: 'transfer', attempt: 1, maxAttempts: 3 })
      input.onProgress(50); input.onProgress(50); input.onProgress(100)
      input.onStatus({ stage: 'finalize', attempt: 0, maxAttempts: 3 })
      return await gates[index].promise
    } finally { active -= 1 }
  } })
  const result = page.uploadAndRegisterEvidence(operation).then(value => ({ value }), error => ({ error }))
  await turn()
  assert.deepEqual(started, [0, 1, 2])
  assert.equal(page.data.files[0].statusLabel, '等待核验登记')
  assert.equal(page.data.files[0].evidenceId, undefined)
  assert.equal(page.data.files[3].status, 'pending')
  gates[0].resolve({ evidenceId: 'e0', fileName: 'normalized.pdf' })
  gates[1].reject(Object.assign(new Error('synthetic network failure'), { code: 'NetworkError' }))
  gates[2].resolve({ evidenceId: 'e2' })
  await turn()
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[3].resolve({ evidenceId: 'e3' })
  assert.ok((await result).error)
  assert.equal(peak, 3)
  assert.deepEqual(page.data.files.map(item => item.status), ['registered', 'failed', 'registered', 'registered'])
  assert.equal(page.data.files[0].name, 'normalized.pdf')
  assert.equal(page.data.files[0].path, 'wxfile://synthetic-0.pdf')
  page.createEvidenceUploader = () => ({ upload: async input => {
    started.push(Number(input.file.localKey.split('-').at(-1)))
    assert.equal(input.file.localKey, 'synthetic-1')
    input.onProgress(50)
    return { evidenceId: 'e1' }
  } })
  assert.deepEqual(plain(await page.uploadAndRegisterEvidence(operation)), ['e0', 'e1', 'e2', 'e3'])
  assert.deepEqual(started, [0, 1, 2, 3, 1])
  assert.equal(page.data.files[1].canRetry, false)
  assert.equal(page.data.files[1].errorMessage, '')
})

for (const transition of ['account', 'node', 'version', 'operation', 'unload']) {
  test(`existing ${transition} invalidation still blocks late progress and registration`, async () => {
    const { page, app, calls, operation } = setup()
    const gate = deferred()
    let callbacks
    page.createEvidenceUploader = () => ({ upload: input => { callbacks = input; return gate.promise } })
    const result = page.uploadAndRegisterEvidence(operation).then(value => ({ value }), error => ({ error }))
    if (transition === 'account') app.globalData.currentUser = { _id: 'other-synthetic', status: 'active' }
    if (transition === 'node') page.data.nodeId = 'different-synthetic-node'
    if (transition === 'version') page.data.expectedNodeVersion += 1
    if (transition === 'operation') page.writeSequence += 1
    if (transition === 'unload') page.onUnload()
    const before = snapshot(page)
    calls.length = 0
    callbacks.onProgress(90)
    callbacks.onStatus({ stage: 'transfer', attempt: 2, maxAttempts: 3 })
    gate.resolve({ evidenceId: 'late-synthetic' })
    assert.ok((await result).error)
    assert.deepEqual(snapshot(page), before)
    assert.equal(calls.some(call => Object.keys(call).some(key => key === 'files' || key.startsWith('files['))), false)
  })
}

test('hiding the original page does not add a new upload cancellation or delayed terminal state', async () => {
  const { page, operation } = setup()
  const gate = deferred()
  let callbacks
  page.createEvidenceUploader = () => ({ upload: input => { callbacks = input; return gate.promise } })
  const result = page.uploadAndRegisterEvidence(operation)
  page.onHide()
  callbacks.onProgress(90)
  assert.equal(page.data.files[0].progressPercent, 90)
  gate.resolve({ evidenceId: 'synthetic-done' })
  assert.deepEqual(plain(await result), ['synthetic-done'])
  assert.equal(page.data.files[0].status, 'registered')
})

for (const count of [1, 3, 30, 100]) {
  test(`${count} synthetic attachments do not inflate the progress bridge payload`, t => {
    const { page, calls } = setup(Array.from({ length: count }, (_, index) => file(index)))
    const sequence = [20, 20, 20, 40, 40, 100, 100]
    for (const progressPercent of sequence)
      page.updateLocalFile(0, { progressPercent, statusLabel: `上传中 ${progressPercent}%` })
    const bytes = calls.map(call => Buffer.byteLength(JSON.stringify(call)))
    t.diagnostic(JSON.stringify({ attachments: count, callbacks: sequence.length,
      setDataCalls: calls.length, payloadBytes: bytes.reduce((sum, value) => sum + value, 0),
      maxPayloadBytes: Math.max(...bytes), finalProgress: page.data.uploadProgressPercent }))
    assert.equal(page.data.uploadProgressPercent, Math.round(100 / count))
    assert.equal(calls.length, 3)
    assert.ok(bytes.every(value => value < 400), 'Only one synthetic row should cross the bridge')
    assert.equal(calls.some(call => Object.hasOwn(call, 'files')), false)
  })
}
