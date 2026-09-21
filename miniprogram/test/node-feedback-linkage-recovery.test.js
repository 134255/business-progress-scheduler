const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const pageFile = path.resolve(__dirname, '../pages/node-feedback/index.js')
const pageRequire = createRequire(pageFile)
const clone = value => JSON.parse(JSON.stringify(value))
const chairValues = { category: '椅', brand: '椅品牌', model: '椅型号', a1: '红', a2: null,
  a3: '软', a4: null, a5: null, note: '本地说明' }
const deskValues = { category: '桌', brand: '桌品牌', model: '桌型号', a1: null, a2: '长',
  a3: null, a4: null, a5: null, note: '服务端说明' }

function linkedFields() {
  const dictionaries = { category: ['椅', '桌'], brand: ['椅品牌', '桌品牌'], model: ['椅型号', '桌型号'],
    a1: ['红'], a2: ['长'], a3: ['软'], a4: ['备用4'], a5: ['备用5'] }
  const fields = Object.entries(dictionaries).map(([fieldKey, options], sequence) => ({
    fieldKey, name: fieldKey, sequence, type: 'single_select', required: true, constraints: { options }
  }))
  fields[0].optionLinkage = { schemaVersion: 1, fieldKeys: Object.keys(dictionaries),
    rows: [[0, 0, 0, 0, null, 0, null, null], [1, 1, 1, null, 0, null, null, null]] }
  return fields.concat({ fieldKey: 'note', name: '说明', sequence: 8, type: 'short_text', required: false, constraints: {} })
}

async function harness({ fields = linkedFields(), storedValues = deskValues, afterConflict } = {}) {
  const app = { globalData: { currentUser: { _id: 'processor-test', status: 'active', role: 'user' } } }
  const workspace = { line: { _id: 'line-test', version: 1, status: 'active' }, canSubmit: true,
    node: { _id: 'node-test', version: 1, name: '测试节点', status: 'in_progress', workflowMode: 'review',
      requiresReview: false, requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: fields },
    history: [{ status: 'in_progress', comment: '服务端进度',
      fieldValues: Object.entries(storedValues).map(([fieldKey, value]) => ({ fieldKey, value })), evidences: [] }] }
  let reads = 0
  const writes = []
  const toasts = []
  const patches = []
  let definition
  const service = {
    async getNodeWorkspace() {
      reads++
      if (reads > 1 && afterConflict) await afterConflict({ app, workspace, page })
      return clone(workspace)
    },
    async listNodeReviewHistory() { return { items: [], hasMore: false } },
    async submitFeedback(input) {
      writes.push(clone(input))
      workspace.node.version++
      throw Object.assign(new Error('VERSION_CONFLICT'), { code: 'VERSION_CONFLICT' })
    }
  }
  vm.compileFunction(fs.readFileSync(pageFile, 'utf8'), ['require', 'Page', 'getApp', 'wx', 'module'])(
    name => name === '../../services/business' ? service : pageRequire(name),
    value => { definition = value }, () => app,
    { setNavigationBarTitle() {}, reLaunch() {}, showToast(value) { toasts.push(value) },
      showModal(options) { options.success({ confirm: true }) } }, { exports: {} })
  const page = { ...definition, data: clone(definition.data),
    setData(patch) { patches.push(clone(patch)); Object.assign(this.data, clone(patch)) } }
  await page.onLoad({ lineId: 'line-test', nodeId: 'node-test' })
  assert.equal(page.data.errorMessage, '')
  return { page, app, workspace, writes, toasts, patches, get reads() { return reads } }
}

function options(page, key) {
  return page.data.visibleFields.find(field => field.fieldKey === key)?.constraints.options
}

for (const action of ['save_progress', 'mark_blocked', 'complete_node']) {
  test(`${action} conflict restores the local linked choices, not the server category's choices`, async t => {
    const h = await harness()
    t.after(() => h.page.onUnload())
    await h.page.applyConditionalValues(chairValues)
    h.page.onComment({ detail: { value: '本地进度' } })
    const files = [{ localKey: 'file-test', name: 'test.jpg', size: 100,
      status: 'registered', evidenceId: 'evidence-test' }]
    h.page.setData({ files, selectedTotalBytes: 100, selectedTotalText: '100 B' })
    assert.deepEqual(options(h.page, 'brand'), ['椅品牌'])

    assert.equal(await h.page.performProgressAction(action), false)
    assert.equal(h.writes.length, 1, 'must not automatically overwrite the conflicting server draft')
    assert.equal(h.writes[0].action, action)
    assert.equal(h.reads, 2)
    assert.equal(h.page.data.expectedNodeVersion, 2)
    assert.deepEqual(h.page.data.fieldValues, chairValues)
    assert.deepEqual(options(h.page, 'brand'), ['椅品牌'])
    assert.deepEqual(options(h.page, 'model'), ['椅型号'])
    assert.deepEqual(h.page.data.visibleFields.map(field => field.fieldKey), ['category', 'brand', 'model', 'a1', 'a3', 'note'])
    assert.deepEqual(options(h.page, 'a1'), ['红'])
    assert.deepEqual(options(h.page, 'a3'), ['软'])
    assert.equal(h.page.data.comment, '本地进度')
    assert.deepEqual(h.page.data.files, files)
    assert.equal(h.page.data.selectedTotalBytes, 100)
    assert.equal(h.page.data.selectedTotalText, '100 B')
    assert.equal(h.page.data.draftDirty, true)
    assert.equal(h.page.data.submitting, false)
    assert.equal(h.toasts.at(-1).icon, 'none', 'conflict must still be reported as a failure')
    const restoration = h.patches.findLast(patch => patch.draftDirty && patch.comment === '本地进度')
    assert.deepEqual(restoration.visibleFields.map(field => field.fieldKey), ['category', 'brand', 'model', 'a1', 'a3', 'note'])
    assert.equal(restoration.visibleFields.some(field => 'optionLinkage' in field), false)
  })
}

test('conflict with an empty server draft restores the entire locally selected chain', async t => {
  const h = await harness({ storedValues: {} })
  t.after(() => h.page.onUnload())
  await h.page.applyConditionalValues(chairValues)
  await h.page.onSaveProgress()
  assert.deepEqual(h.page.data.visibleFields.map(field => field.fieldKey), ['category', 'brand', 'model', 'a1', 'a3', 'note'])
  assert.deepEqual(options(h.page, 'brand'), ['椅品牌'])
  assert.deepEqual(h.page.data.fieldValues, chairValues)
})

test('single-parent conditional choices and checkbox selection are also restored from the local draft', async t => {
  const fields = [
    { fieldKey: 'kind', sequence: 0, name: '类型', type: 'single_select', required: true, constraints: { options: ['A', 'B'] } },
    { fieldKey: 'choices', sequence: 1, name: '选项', type: 'multi_select', required: false,
      constraints: { options: ['红', '蓝'] }, condition: { parentFieldKey: 'kind', visibleWhen: ['A', 'B'],
        optionsByParentValue: { A: ['红'], B: ['蓝'] } } },
    { fieldKey: 'detail', sequence: 2, name: '详情', type: 'short_text', required: false, constraints: {},
      condition: { parentFieldKey: 'kind', visibleWhen: ['A'] } }
  ]
  const h = await harness({ fields, storedValues: { kind: 'B', choices: ['蓝'], detail: '' } })
  t.after(() => h.page.onUnload())
  await h.page.applyConditionalValues({ kind: 'A', choices: ['红'], detail: '保留' })
  await h.page.onSaveProgress()
  assert.deepEqual(options(h.page, 'choices'), ['红'])
  assert.deepEqual(h.page.data.visibleFields[1].optionItems, [{ value: '红', selected: true }])
  assert.equal(h.page.data.visibleFields[2].fieldKey, 'detail')
  assert.equal(h.page.data.fieldValues.detail, '保留')
})

for (const invalidation of ['unload', 'account-change']) {
  test(`a late conflict refresh does not restore the draft after ${invalidation}`, async () => {
    const h = await harness({ afterConflict: ({ page, app }) => {
      if (invalidation === 'unload') page.onUnload()
      else app.globalData.currentUser = { _id: 'different-user', status: 'active', role: 'user' }
    } })
    await h.page.applyConditionalValues(chairValues)
    const start = h.patches.length
    await h.page.onSaveProgress()
    assert.equal(h.patches.slice(start).some(patch => patch.draftDirty && patch.fieldValues), false)
    assert.equal(h.page.data.expectedNodeVersion, 1)
    if (invalidation === 'account-change') assert.equal(h.page.data.readOnly, true)
    h.page.onUnload()
  })
}
