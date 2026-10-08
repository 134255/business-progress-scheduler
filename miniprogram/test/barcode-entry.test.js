const test = require('node:test')
const assert = require('node:assert/strict')
const { scanIntoField } = require('../utils/barcode-entry')

function fixture(overrides = {}) {
  const events = { scans: [], modals: [], notices: [], applied: [] }
  const page = {
    pageAlive: true, loadSequence: 1, formRevision: 0, loadActorId: 'test-user',
    definitionSchemaFingerprint: 'schema', actorStillCurrent: () => true,
    data: { lineId: 'line', nodeId: 'node', expectedNodeVersion: 2, canSubmit: true,
      readOnly: false, reviewDraftLocked: false, submitting: false, loadingHistory: false,
      visibleFields: [{ fieldKey: 'serial', name: '唯一码', type: 'short_text', scanEnabled: true, constraints: {} }],
      fieldValues: { serial: '' }, ...overrides },
    setData(update) { Object.assign(this.data, update) },
    applyConditionalValues(values, update, callback, isCurrent) {
      if (!isCurrent()) return false
      events.applied.push(values); this.data.fieldValues = values; this.formRevision++; return true
    }
  }
  const api = {
    scanCode(options) { events.scans.push(options) },
    showModal(options) { events.modals.push(options) },
    showToast(options) { events.notices.push(options.title) }
  }
  return { page, api, events, start: () => scanIntoField(page, 'serial', api) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('scan previews literal text including leading zero and case, only fills after confirmation', async () => {
  const f = fixture(); const pending = f.start()
  assert.deepEqual(f.events.scans[0].scanType, ['barCode', 'qrCode', 'datamatrix', 'pdf417'])
  f.events.scans[0].success({ result: '001AbC-09' }); await tick()
  assert.equal(f.events.applied.length, 0)
  assert.match(f.events.modals[0].content, /001AbC-09/)
  f.events.modals[0].success({ confirm: true }); await pending
  assert.equal(f.page.data.fieldValues.serial, '001AbC-09')
  assert.equal(f.page.data.scanningFieldKey, '')
  assert.equal(f.page.scanRequestActive, false)
})

for (const cancelAt of ['scan', 'preview']) test(`cancel ${cancelAt} preserves existing content`, async () => {
  const f = fixture({ fieldValues: { serial: 'existing' } }); const pending = f.start()
  if (cancelAt === 'scan') f.events.scans[0].fail({ errMsg: 'scanCode:fail cancel' })
  else { f.events.scans[0].success({ result: '00012' }); await tick()
    assert.match(f.events.modals[0].content, /替换/)
    f.events.modals[0].success({ confirm: false }) }
  await pending; assert.equal(f.page.data.fieldValues.serial, 'existing'); assert.equal(f.events.applied.length, 0)
})

for (const state of ['readOnly', 'reviewDraftLocked', 'submitting', 'loadingHistory']) {
  test(`no scanner while ${state}`, async () => {
    const f = fixture({ [state]: true }); await f.start(); assert.equal(f.events.scans.length, 0)
  })
}
test('no scanner without explicit visible short-text opt-in', async () => {
  for (const field of [null, { type: 'short_text' }, { type: 'number', scanEnabled: true }, { type: 'short_text', scanEnabled: 'true' }]) {
    const f = fixture({ visibleFields: field ? [{ fieldKey: 'serial', ...field }] : [] })
    await f.start(); assert.equal(f.events.scans.length, 0)
  }
})
test('unsupported API or device shows manual fallback; failure does not leak raw errors', async () => {
  for (const mode of ['missing', 'unsupported', 'throw', 'reject']) {
    const f = fixture()
    if (mode === 'missing') delete f.api.scanCode
    if (mode === 'unsupported') f.api.canIUse = () => false
    if (mode === 'throw') f.api.scanCode = () => { throw new Error('private') }
    const pending = f.start()
    if (mode === 'reject') f.events.scans[0].fail({ errMsg: 'private' })
    await pending
    assert.match(f.events.notices.join(' '), /手动|粘贴/)
    assert.doesNotMatch(f.events.notices.join(' '), /private/)
    assert.equal(f.events.applied.length, 0)
  }
})
test('duplicate taps share no additional scanner and never submit data', async () => {
  const f = fixture(); const pending = f.start(); await f.start()
  assert.equal(f.events.scans.length, 1)
  f.events.scans[0].fail({ errMsg: 'cancel' }); await pending
  assert.equal(f.events.applied.length, 0)
})
for (const stage of ['scan', 'preview']) {
  for (const change of [
    p => { p.pageAlive = false }, p => { p.actorStillCurrent = () => false },
    p => { p.data.nodeId = 'another' }, p => { p.data.expectedNodeVersion++ },
    p => { p.formRevision++ }, p => { p.loadSequence++ },
    p => { p.data.visibleFields = [] }, p => { p.data.readOnly = true },
    p => { p.data.reviewDraftLocked = true }, p => { p.data.fieldValues.serial = 'manual' }
  ]) test(`stale ${stage} response cannot modify draft: ${change.toString()}`, async () => {
    const f = fixture(); const pending = f.start()
    if (stage === 'scan') change(f.page)
    f.events.scans[0].success({ result: '00123' }); await tick()
    if (stage === 'preview') { change(f.page); f.events.modals[0].success({ confirm: true }) }
    await pending; assert.equal(f.events.applied.length, 0)
  })
}
test('rejects empty, non-text, overlength, controls and constraint mismatch without truncating', async () => {
  for (const result of ['', 123, 'a'.repeat(4097), 'a\nb', '123456', 'ab']) {
    const f = fixture(); f.page.data.visibleFields[0].constraints = { minLength: 3, maxLength: 5, pattern: '^0[0-9]+$' }
    const pending = f.start(); f.events.scans[0].success({ result }); await pending
    assert.equal(f.events.modals.length, 0); assert.equal(f.events.applied.length, 0)
    assert.match(f.events.notices.join(''), /手动|粘贴/)
  }
})
test('conditional clearing dialog receives freshness guard until actual commit', async () => {
  const f = fixture(); let guard
  f.page.applyConditionalValues = async (values, update, callback, isCurrent) => { guard = isCurrent; return false }
  const pending = f.start(); f.events.scans[0].success({ result: '00123' }); await tick()
  f.events.modals[0].success({ confirm: true }); await pending
  assert.equal(guard(), true); f.page.formRevision++; assert.equal(guard(), false)
})
