const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const tick = () => new Promise(resolve => setImmediate(resolve))

async function openPage() {
  const app = { globalData: { currentUser: { _id: 'synthetic-user', status: 'active' } } }
  const calls = { loads: 0, histories: 0, scans: [], modals: [] }
  global.getApp = () => app
  global.wx = {
    setNavigationBarTitle() {}, showToast() {}, reLaunch() {},
    scanCode: options => calls.scans.push(options),
    showModal: options => calls.modals.push(options)
  }
  const servicePath = require.resolve('../services/business')
  const original = require.cache[servicePath]
  require.cache[servicePath] = { exports: {
    getNodeWorkspace: async () => { calls.loads++; return {
      line: { _id: 'line', version: 1, status: 'active' }, canSubmit: true, history: [],
      node: { _id: 'node', name: '测试节点', version: 1, status: 'in_progress', workflowMode: 'review',
        allowedEvidenceTypes: [], fieldDefinitions: [
          { fieldKey: 'serial', name: '商品唯一码', type: 'short_text', scanEnabled: true, sequence: 1, constraints: {} }
        ] }
    } },
    listNodeReviewHistory: async () => { calls.histories++; return { items: [], hasMore: false } }
  } }
  let definition
  global.Page = value => { definition = value }
  const pagePath = path.resolve(__dirname, '../pages/node-feedback/index.js')
  try { delete require.cache[pagePath]; require(pagePath) } finally {
    delete global.Page; delete require.cache[pagePath]
    if (original) require.cache[servicePath] = original
    else delete require.cache[servicePath]
  }
  const page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update) } }
  await page.onLoad({ lineId: 'line', nodeId: 'node' }); await tick()
  return { page, calls, app }
}
const scanEvent = { currentTarget: { dataset: { fieldkey: 'serial' } } }

test('native scanner hide/show does not reload form; confirmed result remains an unsaved draft', async () => {
  const { page, calls } = await openPage()
  const pending = page.onScanField(scanEvent)
  page.onHide(); await page.onShow()
  assert.equal(calls.loads, 1)
  calls.scans[0].success({ result: '0000123Ab' }); await tick()
  await page.onShow(); assert.equal(calls.loads, 1)
  calls.modals[0].success({ confirm: true }); await pending
  assert.equal(page.data.fieldValues.serial, '0000123Ab')
  assert.equal(page.data.draftDirty, true)
  await page.onShow(); assert.equal(calls.loads, 1)
  assert.equal(page.data.fieldValues.serial, '0000123Ab')
})
test('scanner cannot overwrite a concurrently edited field on the actual page', async () => {
  const { page, calls } = await openPage(); const pending = page.onScanField(scanEvent)
  calls.scans[0].success({ result: '0000123Ab' }); await tick()
  page.onFieldInput({ ...scanEvent, detail: { value: 'manual' } })
  calls.modals[0].success({ confirm: true }); await pending
  assert.equal(page.data.fieldValues.serial, 'manual')
})
test('real form guards a delayed linked-field clearing confirmation', async () => {
  const { page, calls } = await openPage()
  page.fieldDefinitions.push({ fieldKey: 'child', sequence: 2, name: '条件字段', type: 'short_text', constraints: {},
    condition: { parentFieldKey: 'serial', visibleWhen: ['existing'] } })
  page.data.fieldValues = { serial: 'existing', child: 'keep' }
  const pending = page.onScanField(scanEvent)
  calls.scans[0].success({ result: 'new' }); await tick()
  calls.modals[0].success({ confirm: true }); await tick()
  assert.equal(calls.modals.length, 2)
  page.data.readOnly = true
  calls.modals[1].success({ confirm: true }); await pending
  assert.deepEqual(page.data.fieldValues, { serial: 'existing', child: 'keep' })
})
test('account change or unload discards a native scan response', async () => {
  for (const mode of ['account', 'unload']) {
    const { page, calls, app } = await openPage(); const pending = page.onScanField(scanEvent)
    if (mode === 'account') app.globalData.currentUser = { _id: 'different', status: 'active' }
    else page.onUnload()
    calls.scans[0].success({ result: '00123' }); await pending
    assert.equal(calls.modals.length, 0); assert.equal(page.data.fieldValues.serial, '')
  }
})

test('history fold actions only change presentation and remain available to readonly readers', async () => {
  const { page } = await openPage()
  const history = [{ feedbackId: 'saved', comment: 'original', fieldValues: [{ value: false }], evidences: [] }]
  page.setData({ readOnly: true, canSubmit: false, history, comment: 'untouched draft' })
  assert.equal(page.data.feedbackHistoryOpen, false)
  assert.equal(page.data.reviewHistoryOpen, false)
  page.onToggleFeedbackHistory(); page.onToggleReviewHistory()
  page.onToggleFeedbackRevision({ currentTarget: { dataset: { id: 'saved' } } })
  assert.equal(page.data.feedbackHistoryOpen, true)
  assert.equal(page.data.reviewHistoryOpen, true)
  assert.equal(page.data.expandedFeedback.saved, true)
  assert.equal(page.data.history, history)
  assert.equal(page.data.comment, 'untouched draft')
  assert.equal(page.data.readOnly, true)
  page.onToggleFeedbackHistory(); assert.equal(page.data.feedbackHistoryOpen, false)
})

test('access loss clears compact saved records and cannot reopen previous account histories', async () => {
  for (const mode of ['account', 'forbidden']) {
    const { page, app } = await openPage()
    page.setData({ history: [{ feedbackId: 'saved', comment: 'sensitive' }], feedbackHistoryOpen: true,
      reviewHistoryOpen: true, expandedFeedback: { saved: true } })
    if (mode === 'account') {
      app.globalData.currentUser = { _id: 'different', status: 'active' }; await page.onShow()
    } else page.clearReviewHistoryOnAccessError({ code: 'FORBIDDEN' })
    assert.deepEqual(page.data.history, [])
    assert.deepEqual(page.data.expandedFeedback, {})
    page.onToggleFeedbackHistory(); page.onToggleReviewHistory()
    assert.equal(page.data.feedbackHistoryOpen, false); assert.equal(page.data.reviewHistoryOpen, false)
  }
})
