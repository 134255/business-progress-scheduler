const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const utilityPath = path.resolve(__dirname, '../utils/option-linkage-import.js')
const logicalKeys = ['category', 'brand', 'model', 'attribute1', 'attribute2', 'attribute3', 'attribute4', 'attribute5']
const names = ['分类', '品牌', '型号', '属性1', '属性2', '属性3', '属性4', '属性5']
const copy = value => JSON.parse(JSON.stringify(value))
function source() {
  const options = [['类别'], ['品牌'], ['型号甲', '型号乙'], ['大,号', '小\n号'], ['红', '蓝'], ['背'], ['扶手'], ['脚']]
  return { schemaVersion: 1, fields: logicalKeys.map((fieldKey, index) => ({
    fieldKey, name: names[index], type: 'single_select', required: true, constraints: { options: options[index] }
  })), optionLinkage: { schemaVersion: 1, fieldKeys: logicalKeys.slice(), rows: [
    [0, 0, 0, 0, 0, null, null, 0], [0, 0, 0, 1, 1, null, null, 0],
    [0, 0, 1, 0, null, 0, 0, null]
  ] }, summary: { rows: 999999, models: 999999 } }
}
function originalNode(version = 2) {
  return { nodeKey: 'node-a', _uiKey: 'node-ui', name: '合成节点', description: 'keep node', workflowMode: 'review',
    processorAssignmentMode: 'fixed_accounts', processorUserIds: ['processor'], reviewerUserIds: [],
    processingSlaWorkHours: 22, reviewSlaWorkHours: 8, requiresEvidence: true, allowedEvidenceTypes: ['pdf'],
    ...(version === 2 ? { next: { mode: 'end' } } : {}), fields: [
      { fieldKey: 'note', name: '备注', type: 'short_text', constraints: {}, required: false },
      { fieldKey: 'cat', name: '分类', type: 'single_select', description: 'keep category', required: false, constraints: { options: ['旧类'] } },
      { fieldKey: 'brand-id', name: '品牌', type: 'single_select', required: true, constraints: { options: ['旧品牌'] }, condition: { parentFieldKey: 'cat', visibleWhen: ['旧类'] } },
      { fieldKey: 'sku-id', name: 'sKu', type: 'short_text', constraints: {} },
      { fieldKey: 'tail', name: '尾部', type: 'short_text', constraints: {}, required: false },
      { fieldKey: 'model-id', name: '型号', type: 'single_select', required: false, constraints: { options: ['旧型号'] } }
    ].map((field, sequence) => ({ ...field, sequence })) }
}
function importer() {
  assert.ok(fs.existsSync(utilityPath), 'structured draft importer must exist')
  return require(utilityPath)
}
function importNode(node = originalNode(), extra = {}) {
  let serial = 0
  const api = importer()
  return api.applyOptionLinkageImport(node, api.parseOptionLinkageImport(JSON.stringify(source())), {
    versionTwo: Boolean(node.next), allocateKey: prefix => `${prefix}-${++serial}`, ...extra
  })
}
function page(relative, fakes = {}) {
  let registered
  global.Page = definition => { registered = definition }
  const cached = []
  for (const [relativePath, exports] of Object.entries(fakes)) {
    const key = require.resolve(path.resolve(__dirname, '..', relativePath))
    cached.push([key, require.cache[key]])
    require.cache[key] = { id: key, filename: key, loaded: true, exports }
  }
  const key = require.resolve(path.resolve(__dirname, '..', relative))
  delete require.cache[key]
  try { require(key) } finally {
    delete global.Page
    for (const [key, previous] of cached) { if (previous) require.cache[key] = previous; else delete require.cache[key] }
  }
  return { ...registered, data: copy(registered.data), updates: [], setData(value) {
    this.updates.push(copy(value))
    for (const [key, item] of Object.entries(value)) {
      const match = /^fields\[(\d+)\]\.(.+)$/.exec(key)
      if (match) this.data.fields[Number(match[1])][match[2]] = item
      else this.data[key] = item
    }
  } }
}
function environment() {
  const app = { globalData: { currentUser: { _id: 'admin', role: 'super_admin', status: 'active' } } }
  global.getApp = () => app
  global.wx = { reLaunch() {}, navigateBack() {}, setNavigationBarTitle() {}, showToast() {} }
  return app
}
function nodePage(node, owner) {
  const editor = page('pages/admin-template-node-edit/index.js')
  global.getCurrentPages = () => [owner || { getNodeEditorContext: () => ({ node: copy(node), flowSchemaVersion: node.next ? 2 : 1, assigneeOptions: [], nodeOptions: [] }) }, editor]
  editor.onLoad({ index: '0' })
  return editor
}
const fieldEvent = (index, value, direction) => ({ currentTarget: { dataset: { index, direction } }, detail: { value } })

test('structured import preserves stable IDs and unrelated draft state, replacing only SKU and the group', () => {
  const before = originalNode()
  const result = importNode(before)
  assert.deepEqual(before, originalNode(), 'import must not mutate the source draft')
  assert.deepEqual(result.fields.map(field => field.name), ['备注', ...names, '尾部'])
  assert.deepEqual(result.fields.slice(1, 4).map(field => field.fieldKey), ['cat', 'brand-id', 'model-id'])
  assert.deepEqual(result.fields.slice(1, 4).map(field => field.required), [false, true, false])
  assert.equal(result.fields[1].description, 'keep category')
  assert.deepEqual(result.fields[4].constraints.options, ['大,号', '小\n号'])
  assert.ok(result.fields.slice(1, 9).every(field => !Object.hasOwn(field, 'condition')))
  assert.deepEqual(result.allowedEvidenceTypes, ['pdf'])
  assert.deepEqual(result.fields[0], before.fields[0])
  const again = importNode(result)
  assert.deepEqual(again.fields.map(field => field.fieldKey), result.fields.map(field => field.fieldKey))
  assert.deepEqual(again.fields[1].optionLinkage.fieldKeys, result.fields.slice(1, 9).map(field => field.fieldKey))
})

test('missing category inserts eight members at the earliest brand/model/SKU position, preserving nine unrelated fields', () => {
  const node = originalNode()
  node.fields = [node.fields[2], node.fields[5], node.fields[3],
    { fieldKey: 'warehouse', name: '仓库', type: 'single_select', required: true, constraints: { options: ['仓甲'] } },
    { fieldKey: 'store-warehouse', name: '现货门店仓', type: 'single_select', required: false,
      constraints: { options: ['门店一'] }, condition: { parentFieldKey: 'warehouse', visibleWhen: ['仓甲'] } },
    ...Array.from({ length: 7 }, (_, index) => ({ fieldKey: `extra-${index}`, name: `其他字段${index + 1}`,
      type: 'short_text', required: false, constraints: {} }))]
  delete node.fields[0].condition
  node.fields = node.fields.map((field, sequence) => ({ ...field, sequence }))
  const before = copy(node)
  assert.equal(node.fields.length, 12)
  const imported = importNode(node)
  assert.equal(imported.fields.length, 17)
  assert.deepEqual(imported.fields.slice(0, 8).map(field => field.name), names)
  assert.deepEqual(imported.fields.slice(1, 3).map(field => field.fieldKey), ['brand-id', 'model-id'])
  assert.ok(imported.fields[0].fieldKey && imported.fields.slice(3, 8).every(field => field.fieldKey && field.required))
  assert.deepEqual(imported.fields.slice(8), before.fields.slice(3).map((field, index) => ({ ...field, sequence: index + 8 })))
  assert.deepEqual(node, before)
})

test('import rejects ambiguous names, unrelated attribute collisions and every SKU inbound reference', () => {
  for (const name of ['分类', '品牌', '型号', 'SKU', '属性1']) {
    const node = originalNode()
    node.fields.push({ fieldKey: 'collision', name, type: 'short_text', constraints: {} })
    assert.throws(() => importNode(node), /重复|冲突|歧义/)
  }
  const conditional = originalNode()
  conditional.fields[4].condition = { parentFieldKey: 'sku-id', visibleWhen: ['x'] }
  assert.throws(() => importNode(conditional), /SKU.*引用/)
  const routed = originalNode()
  routed.next = { mode: 'single_select', fieldKey: 'sku-id', optionTargets: { x: 'end' } }
  assert.throws(() => importNode(routed), /SKU.*引用/)
  assert.throws(() => importNode(originalNode(), { cardFields: [{ nodeKey: 'node-a', fieldKey: 'sku-id' }] }), /SKU.*引用/)
})

test('import derives safe counts, rejects malformed data and enforces group and complete-node budgets', () => {
  const api = importer()
  const parsed = api.parseOptionLinkageImport(JSON.stringify(source()))
  assert.equal(parsed.summary.rowCount, 3)
  assert.equal(parsed.summary.modelCount, 2)
  assert.throws(() => api.parseOptionLinkageImport('{bad'), /JSON/)
  const invalid = source(); invalid.optionLinkage.rows[0][0] = 99
  assert.throws(() => api.parseOptionLinkageImport(JSON.stringify(invalid)), /联动|组合/)
  const oversized = source(); oversized.fields[0].constraints.options[0] = 'x'.repeat(256 * 1024)
  assert.throws(() => api.parseOptionLinkageImport(JSON.stringify(oversized)), /联动|组合|256/)
  const node = originalNode(); node.description = 'x'.repeat(512 * 1024)
  assert.throws(() => importNode(node), /512/)
})

test('V1 import uses clientFieldKey, distinct from UI keys, and rewrites all eight references', () => {
  const node = importNode(originalNode(1))
  const attributes = node.fields.slice(4, 9)
  assert.ok(attributes.every(field => !field.fieldKey && field.clientFieldKey && field.clientFieldKey !== field._uiKey))
  assert.deepEqual(node.fields[1].optionLinkage.fieldKeys, node.fields.slice(1, 9).map(field => field.fieldKey || field.clientFieldKey))
})

test('node load/save keeps matrix private and linked literals intact, blocking all individual member mutations', () => {
  environment()
  const node = importNode()
  const editor = nodePage(node)
  assert.ok(editor.updates.every(update => !JSON.stringify(update).includes('"rows"')))
  assert.equal(editor.data.fields[4].linked, true)
  assert.equal(editor.data.fields[4].optionCount, 2)
  const original = copy(editor.data.fields)
  editor.onFieldNameInput(fieldEvent(1, '改名'))
  editor.onFieldDescriptionInput(fieldEvent(1, '说明'))
  editor.onFieldRequiredChange(fieldEvent(1, true))
  editor.onFieldTypeChange(fieldEvent(1, 0))
  editor.onFieldOptionsInput(fieldEvent(4, 'bad'))
  editor.onFieldConditionChange(fieldEvent(4, true))
  editor.removeField(fieldEvent(4))
  editor.moveField(fieldEvent(4, undefined, 1))
  editor.moveField(fieldEvent(0, undefined, 1))
  assert.deepEqual(editor.data.fields, original)
  assert.match(editor.data.errorMessage, /整体|联动/)
  editor.onDescriptionInput({ detail: { value: 'new description' } })
  const saved = editor.buildNodeForSave()
  assert.deepEqual(saved.fields[4].constraints.options, ['大,号', '小\n号'])
  assert.deepEqual(saved.fields[1].optionLinkage.rows, source().optionLinkage.rows)
  assert.ok(saved.fields.slice(1, 9).every(field => !Object.hasOwn(field, 'condition')))
})

test('validate then apply changes only draft, clears stale validation, and rechecks readonly and admin authority', () => {
  const app = environment()
  const editor = nodePage(originalNode())
  assert.equal(typeof editor.onLinkageImportInput, 'function', 'node editor must expose a structured import input')
  editor.onLinkageImportInput({ detail: { value: JSON.stringify(source()) } })
  editor.validateLinkageImport()
  assert.equal(editor.data.linkageImportPreview.rowCount, 3)
  assert.equal(editor.data.fields.length, 6)
  editor.data.readOnly = true
  editor.applyLinkageImport()
  assert.equal(editor.data.fields.length, 6)
  editor.data.readOnly = false
  app.globalData.currentUser.role = 'user'
  editor.applyLinkageImport()
  assert.equal(editor.data.fields.length, 6)
  app.globalData.currentUser.role = 'super_admin'
  editor.onLinkageImportInput({ detail: { value: JSON.stringify(source()) } })
  editor.validateLinkageImport()
  editor.applyLinkageImport()
  assert.equal(editor.data.fields.length, 10)
  assert.ok(editor.updates.every(update => !JSON.stringify(update).includes('"rows"')))
  editor.onLinkageImportInput({ detail: { value: '{broken' } })
  assert.equal(editor.data.linkageImportPreview, null)
  editor.validateLinkageImport()
  assert.match(editor.data.linkageImportError, /JSON/)
})

test('parent-node roundtrip preserves private rules, literal dictionaries, client references and loaded save intent', async () => {
  environment()
  for (const version of [1, 2]) {
    const node = importNode(originalNode(version))
    const requests = []
    const parent = page('pages/admin-template-edit/index.js', { 'services/templates.js': {
      getTemplate: async () => ({ template: { name: '模板', status: 'draft', version: 3,
        definitionDigest: 'loaded-digest', flowSchemaVersion: version, entryNodeKey: 'node-a' }, nodes: [node] }),
      updateTemplate: async (...args) => requests.push(args)
    } })
    parent.data.editMode = true; parent.data.templateId = 'template-a'
    await parent.loadTemplate()
    assert.ok(parent.updates.every(update => !JSON.stringify(update).includes('"rows"')))
    const editor = nodePage(null, parent)
    editor.onDescriptionInput({ detail: { value: 'edited metadata' } })
    parent.acceptNodeFromEditor(0, editor.buildNodeForSave())
    const reopened = nodePage(null, parent)
    assert.deepEqual(reopened.buildNodeForSave().fields[1].optionLinkage.rows, source().optionLinkage.rows)
    const payload = parent.definition()
    assert.deepEqual(payload.optionLinkageEdit, { schemaVersion: 1, expectedDefinitionDigest: 'loaded-digest' })
    assert.deepEqual(payload.nodes[0].fields[4].constraints.options, ['大,号', '小\n号'])
    assert.deepEqual(payload.nodes[0].fields[1].optionLinkage.fieldKeys,
      payload.nodes[0].fields.slice(1, 9).map(field => field.fieldKey || field.clientFieldKey))
    assert.ok(!JSON.stringify(payload).includes('_uiKey'))
    assert.ok(parent.updates.every(update => !JSON.stringify(update).includes('"rows"')))
    await parent.submit()
    assert.equal(requests.length, 1, parent.data.errorMessage)
    const removed = parent.getNodeEditorContext(0).node
    removed.fields = removed.fields.filter(field => !payload.nodes[0].fields[1].optionLinkage.fieldKeys.includes(field.fieldKey || field.clientFieldKey))
    parent.acceptNodeFromEditor(0, removed)
    assert.deepEqual(parent.definition().optionLinkageEdit, { schemaVersion: 1, expectedDefinitionDigest: 'loaded-digest' })
  }
})

test('new template linkage save intent has explicit null digest', () => {
  environment()
  const parent = page('pages/admin-template-edit/index.js')
  parent.acceptNodeFromEditor(-1, importNode())
  assert.deepEqual(parent.definition().optionLinkageEdit, { schemaVersion: 1, expectedDefinitionDigest: null })
})

test('keyless V1 node handoff strips the matrix before rendering and keeps it through another node edit', () => {
  environment()
  const parent = page('pages/admin-template-edit/index.js')
  parent.data.flowSchemaVersion = 1
  const linked = importNode(originalNode(1))
  delete linked._uiKey; delete linked.nodeKey
  parent.acceptNodeFromEditor(-1, linked)
  assert.ok(parent.updates.every(update => !JSON.stringify(update).includes('"rows"')))
  parent.acceptNodeFromEditor(-1, { ...originalNode(1), nodeKey: 'other-node', _uiKey: 'other-ui' })
  parent.moveNode({ currentTarget: { dataset: { index: 0, direction: 1 } } })
  const linkedContext = parent.getNodeEditorContext(1)
  assert.deepEqual(linkedContext.node.fields[1].optionLinkage.rows, source().optionLinkage.rows)
  assert.deepEqual(parent.definition().nodes[1].fields[1].optionLinkage.rows, source().optionLinkage.rows)
})

test('parent supplies saved card references, not unsaved display choices, and apply revalidates new references', async () => {
  environment()
  const parent = page('pages/admin-template-edit/index.js')
  parent.data.templateId = 'template-a'
  parent._cardSavedNodes = [{ nodeKey: 'node-a', name: '合成节点', fields: [{ fieldKey: 'sku-id', name: 'SKU' }] }]
  parent.applyCardConfig({ templateId: 'template-a', revision: 1, fields: [{ nodeKey: 'node-a', fieldKey: 'sku-id' }] })
  parent.acceptNodeFromEditor(-1, originalNode())
  parent.data.cardFields = []
  const editor = nodePage(null, parent)
  editor.onLinkageImportInput({ detail: { value: JSON.stringify(source()) } })
  editor.validateLinkageImport()
  assert.match(editor.data.linkageImportError, /SKU.*引用/)
  parent.applyCardConfig({ templateId: 'template-a', revision: 2, fields: [] })
  editor.validateLinkageImport()
  assert.equal(editor.data.linkageImportPreview.rowCount, 3)
  parent.applyCardConfig({ templateId: 'template-a', revision: 3, fields: [{ nodeKey: 'node-a', fieldKey: 'sku-id' }] })
  editor.applyLinkageImport()
  assert.match(editor.data.linkageImportError, /SKU.*引用/)
  assert.equal(editor.data.fields.length, 6)
})

test('import refuses broken old conditional references and existing member routing without collateral changes', () => {
  const node = originalNode()
  node.fields[4].condition = { parentFieldKey: 'cat', visibleWhen: ['旧类'] }
  assert.throws(() => importNode(node), /父选项/)
  const moved = originalNode()
  moved.fields[0].condition = { parentFieldKey: 'model-id', visibleWhen: ['型号甲'] }
  assert.throws(() => importNode(moved), /前置/)
  const routed = originalNode()
  routed.next = { mode: 'single_select', fieldKey: 'cat', optionTargets: { 旧类: 'end' } }
  assert.throws(() => importNode(routed), /流程分支/)
  const tooMany = source()
  tooMany.optionLinkage.rows = Array.from({ length: 5001 }, (_, index) => [0, 0, index, 0, 0, null, null, 0])
  assert.throws(() => importer().parseOptionLinkageImport(JSON.stringify(tooMany)), /5000/)
})

test('node and parent save enforce the full node budget after ordinary metadata edits', async () => {
  environment()
  const editor = nodePage(importNode())
  editor.onDescriptionInput({ detail: { value: '字'.repeat(180000) } })
  await editor.submit()
  assert.match(editor.data.errorMessage, /512/)
  const parent = page('pages/admin-template-edit/index.js')
  parent.acceptNodeFromEditor(-1, importNode())
  parent.data.nodes[0].description = '字'.repeat(180000)
  await parent.submit()
  assert.match(parent.data.errorMessage, /512/)
})

test('linkage conflict retains the local draft and original loaded digest', async () => {
  environment()
  let reads = 0
  const parent = page('pages/admin-template-edit/index.js', { 'services/templates.js': {
    getTemplate: async () => { reads++; return { template: { name: '模板', status: 'draft', version: 3,
      definitionDigest: 'loaded-digest', flowSchemaVersion: 2, entryNodeKey: 'node-a' }, nodes: [importNode()] } },
    updateTemplate: async () => { throw Object.assign(new Error('conflict'), { code: 'VERSION_CONFLICT' }) }
  } })
  parent.data.editMode = true; parent.data.templateId = 'template-a'
  await parent.loadTemplate()
  parent.onDescriptionInput({ detail: { value: 'unsaved draft' } })
  await parent.submit()
  assert.equal(reads, 1)
  assert.equal(parent.data.description, 'unsaved draft')
  assert.equal(parent.definition().optionLinkageEdit.expectedDefinitionDigest, 'loaded-digest')
  assert.match(parent.data.errorMessage, /保留本地草稿/)
})

test('V1 and V2 editor payloads normalize in the real in-memory service with remapped keys and no client IDs', async () => {
  environment()
  const { createTemplateHarness } = require('../../cloudfunctions/businessApi/test/helpers/template-harness')
  for (const version of [1, 2]) {
    const parent = page('pages/admin-template-edit/index.js')
    parent.data.flowSchemaVersion = version; parent.data.name = '合成模板'
    const h = createTemplateHarness({ users: [{ _id: 'processor', status: 'active' }] })
    const original = originalNode(version)
    const initial = page('pages/admin-template-edit/index.js')
    initial.data.flowSchemaVersion = version; initial.data.name = '合成模板'
    initial.acceptNodeFromEditor(-1, original)
    const stored = await h.service.createTemplate({ actor: h.admin, input: initial.definition() })
    parent.data.editMode = true; parent.data.templateId = stored.template._id
    parent.data.entryNodeKey = stored.template.entryNodeKey || ''
    parent._loadedDefinitionDigest = stored.template.definitionDigest
    const editor = nodePage(stored.nodes[0])
    editor.onLinkageImportInput({ detail: { value: JSON.stringify(source()) } })
    editor.validateLinkageImport()
    assert.equal(editor.data.linkageImportError, '')
    editor.applyLinkageImport()
    parent.acceptNodeFromEditor(-1, editor.buildNodeForSave())
    const updated = await h.service.updateTemplate({ actor: h.admin, templateId: stored.template._id,
      expectedVersion: stored.template.version, input: parent.definition() })
    const fields = updated.nodes[0].fields
    assert.deepEqual(fields[1].optionLinkage.fieldKeys, fields.slice(1, 9).map(field => field.fieldKey))
    assert.deepEqual(fields.slice(1, 4).map(field => field.fieldKey),
      [stored.nodes[0].fields[1], stored.nodes[0].fields[2], stored.nodes[0].fields[5]].map(field => field.fieldKey))
    assert.deepEqual(fields[4].constraints.options, ['大,号', '小\n号'])
    assert.ok(fields.every(field => !Object.hasOwn(field, 'clientFieldKey')))
  }
})

test('applying or updating a group preserves unrelated in-progress option and conditional text buffers', () => {
  environment()
  const node = originalNode()
  node.fields.push({ fieldKey: 'select-extra', name: '其他单选', type: 'single_select', required: false,
    constraints: { options: ['甲', '乙'] }, sequence: 6 })
  node.fields.push({ fieldKey: 'child-extra', name: '其他子项', type: 'single_select', required: false,
    constraints: { options: ['一', '二'] }, sequence: 7,
    condition: { parentFieldKey: 'select-extra', visibleWhen: ['甲'], optionsByParentValue: { 甲: ['一'] } } })
  const editor = nodePage(node)
  editor.onFieldOptionsInput(fieldEvent(6, '甲, 乙, '))
  editor.onFieldConditionalOptionsInput({ currentTarget: { dataset: { index: 7, parentValue: '甲' } }, detail: { value: '一, ' } })
  for (let round = 0; round < 2; round++) {
    editor.onLinkageImportInput({ detail: { value: JSON.stringify(source()) } })
    editor.validateLinkageImport()
    assert.equal(editor.data.linkageImportError, '')
    editor.applyLinkageImport()
    assert.equal(editor.data.fields.find(field => field.fieldKey === 'select-extra').optionText, '甲, 乙, ')
    assert.equal(editor.data.fields.find(field => field.fieldKey === 'child-extra').conditionalOptionTexts.甲, '一, ')
  }
})

const payloadBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
function largeConditionalNode(modelCount = 229, explicit = false) {
  const input = source(), node = originalNode()
  input.fields[2].constraints.options = Array.from({ length: modelCount }, (_, index) => `M${index}`)
  input.optionLinkage.rows = Array.from({ length: modelCount }, (_, index) => [0, 0, index, 0, null, null, null, null])
  const options = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, '0') + 'x'.repeat(97))
  const visibleWhen = explicit ? input.fields[2].constraints.options.slice(0, 20) : ['M0']
  node.fields.push({ fieldKey: 'other', name: 'Other', type: 'single_select', required: false, constraints: { options },
    condition: { parentFieldKey: 'model-id', visibleWhen,
      ...(explicit ? { optionsByParentValue: Object.fromEntries(visibleWhen.map(value => [value, options.slice()])) } : {}) } })
  let serial = 0
  return importer().applyOptionLinkageImport(node, importer().parseOptionLinkageImport(JSON.stringify(input)), {
    versionTwo: true, allocateKey: prefix => `${prefix}${++serial}`
  })
}

for (const modelCount of [229, 2495]) test(`F1 ${modelCount} models: accepted small node has bounded load and name-edit payloads`, async t => {
  environment()
  const editor = nodePage(largeConditionalNode(modelCount))
  const parent = page('pages/admin-template-edit/index.js'); parent.data.name = 'Synthetic'
  parent.acceptNodeFromEditor(-1, editor.buildNodeForSave())
  const { createTemplateHarness } = require('../../cloudfunctions/businessApi/test/helpers/template-harness')
  const h = createTemplateHarness({ users: [{ _id: 'processor', status: 'active' }] })
  const saved = await h.service.createTemplate({ actor: h.admin, input: parent.definition() })
  assert.ok(saved.template)
  const initialBytes = Math.max(...editor.updates.map(payloadBytes))
  editor.onFieldNameInput(fieldEvent(editor.data.fields.length - 1, 'Renamed'))
  const mutationBytes = payloadBytes(editor.updates.at(-1))
  t.diagnostic(JSON.stringify({ modelCount, normalizedNodeBytes: payloadBytes(editor.buildNodeForSave()), initialBytes, mutationBytes }))
  assert.ok(initialBytes < 128 * 1024, `initial setData ${initialBytes} bytes must stay below 128 KiB`)
  assert.ok(mutationBytes < 1024, `name edit ${mutationBytes} bytes must not resend dictionaries/mappings`)
  assert.ok(editor.data.fields.at(-1).conditionParentValueRows.length <= 20)
  assert.ok(editor.updates.every(update => !JSON.stringify(update).includes('"rows"')))
})

test('large selected conditional mappings are lazy, page safely, preserve buffers and still validate strictly', t => {
  const app = environment()
  const linked = largeConditionalNode(229, true)
  const editor = nodePage(linked)
  const index = editor.data.fields.length - 1
  const initialBytes = Math.max(...editor.updates.map(payloadBytes))
  t.diagnostic(JSON.stringify({ explicitMappingNodeBytes: payloadBytes(editor.buildNodeForSave()), initialBytes }))
  assert.ok(initialBytes < 128 * 1024)
  assert.equal(typeof editor.onConditionalEditorOpen, 'function')
  assert.deepEqual(editor.buildNodeForSave().fields[index].condition, linked.fields[index].condition)
  assert.deepEqual(editor.normalizedField(editor.data.fields[index], index).condition, linked.fields[index].condition)
  const event = { currentTarget: { dataset: { index, parentValue: 'M0' } }, detail: {} }
  editor.onConditionalEditorOpen(event)
  const originalText = editor.data.fields[index].conditionParentValueRows.find(row => row.value === 'M0').optionText
  editor.onFieldConditionalOptionsInput({ ...event, detail: { value: originalText + ', ' } })
  editor.onConditionalParentPageChange(fieldEvent(index, undefined, 1))
  editor.onFieldVisibleWhenChange(fieldEvent(index, ['M20']))
  editor.onConditionalParentPageChange(fieldEvent(index, undefined, -1))
  editor.onConditionalEditorOpen(event)
  assert.equal(editor.data.fields[index].conditionParentValueRows.find(row => row.value === 'M0').optionText, originalText + ', ')
  const normalized = editor.buildNodeForSave()
  assert.equal(normalized.fields[index].condition.visibleWhen.length, 21, 'page checkbox changes preserve off-page selections')
  assert.deepEqual(normalized.fields[index].condition.optionsByParentValue.M0, linked.fields[index].constraints.options)
  assert.ok(editor.updates.every(update => payloadBytes(update) < 128 * 1024))
  editor.onFieldConditionalOptionsInput({ ...event, detail: { value: 'unknown, ' } })
  assert.match(editor.conditionalOptionsError(), /选项/)
  const before = copy(editor.data)
  editor.data.readOnly = true
  editor.onConditionalParentPageChange(fieldEvent(index, undefined, 1))
  editor.onConditionalEditorOpen(event)
  assert.deepEqual(editor.data.fields, before.fields)
  editor.data.readOnly = false; app.globalData.currentUser.role = 'user'
  editor.onConditionalParentPageChange(fieldEvent(index, undefined, 1))
  assert.deepEqual(editor.data.fields, before.fields)
})

function trialSelect(editor, key, option) {
  const field = editor.data.linkageTrialFields.find(field => field.fieldKey === key)
  assert.ok(field, `trial field ${key} must be effective`)
  const index = field.options.indexOf(option)
  assert.ok(index >= 0, `trial option for ${key} must be offered`)
  editor.onLinkageTrialChange({ currentTarget: { dataset: { fieldKey: key } }, detail: { value: String(index + 1) } })
}

test('trial picker has an explicit placeholder so confirming a sole option is a real selection', () => {
  environment()
  const editor = nodePage(importNode())
  editor.openLinkageTrial()
  editor.onLinkageTrialChange({ currentTarget: { dataset: { fieldKey: 'cat' } }, detail: { value: '0' } })
  assert.deepEqual(editor.data.linkageTrialFields.map(field => [field.fieldKey, field.value]), [['cat', '']])
  editor.onLinkageTrialChange({ currentTarget: { dataset: { fieldKey: 'cat' } }, detail: { value: '1' } })
  assert.equal(editor.data.linkageTrialFields[0].value, '类别')
})

test('validated import trial is interactive, strict/non-Cartesian, skips null gaps and never changes draft', () => {
  environment()
  const editor = nodePage(originalNode())
  const before = copy(editor.buildNodeForSave())
  editor.onLinkageImportInput({ detail: { value: JSON.stringify(source()) } })
  editor.validateLinkageImport()
  assert.equal(typeof editor.openLinkageTrial, 'function')
  editor.openLinkageTrial()
  assert.deepEqual(editor.data.linkageTrialFields.map(field => [field.fieldKey, field.value]), [['category', '']])
  trialSelect(editor, 'category', '类别'); trialSelect(editor, 'brand', '品牌'); trialSelect(editor, 'model', '型号甲')
  trialSelect(editor, 'attribute1', '大,号')
  assert.deepEqual(editor.data.linkageTrialFields.find(field => field.fieldKey === 'attribute2').options, ['红'])
  assert.equal(editor.data.linkageTrialFields.find(field => field.fieldKey === 'attribute2').value, '', 'sole option stays explicit')
  trialSelect(editor, 'attribute2', '红'); trialSelect(editor, 'attribute5', '脚')
  assert.ok(!editor.data.linkageTrialFields.some(field => ['attribute3', 'attribute4'].includes(field.fieldKey)))
  assert.equal(editor.data.linkageTrialComplete, true)
  trialSelect(editor, 'attribute1', '小\n号')
  assert.deepEqual(editor.data.linkageTrialFields.find(field => field.fieldKey === 'attribute2').options, ['蓝'])
  assert.equal(editor.data.linkageTrialFields.find(field => field.fieldKey === 'attribute2').value, '')
  assert.ok(!editor.data.linkageTrialFields.some(field => field.fieldKey === 'attribute5'))
  assert.equal(editor.data.linkageTrialComplete, false)
  trialSelect(editor, 'attribute1', '大,号'); trialSelect(editor, 'model', '型号乙')
  assert.equal(editor.data.linkageTrialFields.find(field => field.fieldKey === 'attribute1').value, '大,号', 'still-legal descendant is retained')
  assert.ok(!editor.data.linkageTrialFields.some(field => field.fieldKey === 'attribute2'))
  trialSelect(editor, 'attribute3', '背'); trialSelect(editor, 'attribute4', '扶手')
  assert.equal(editor.data.linkageTrialComplete, true)
  assert.deepEqual(editor.buildNodeForSave(), before)
  assert.ok(editor.updates.every(update => !JSON.stringify(update).includes('"rows"')))
  editor.onLinkageImportInput({ detail: { value: '{bad' } })
  assert.equal(editor.data.linkageTrialOpen, false, 'new unvalidated input invalidates the imported trial')
})

test('existing-group trial works readonly, rejects forged choices, rechecks authority and sends only trial projections', () => {
  const app = environment()
  const editor = nodePage(importNode())
  editor.data.readOnly = true
  const before = copy(editor.buildNodeForSave())
  assert.equal(typeof editor.openLinkageTrial, 'function')
  editor.updates.length = 0
  editor.openLinkageTrial()
  trialSelect(editor, 'cat', '类别')
  const trialBefore = copy(editor.data.linkageTrialFields)
  editor.onLinkageTrialChange({ currentTarget: { dataset: { fieldKey: 'model-id' } }, detail: { value: '999' } })
  assert.deepEqual(editor.data.linkageTrialFields, trialBefore)
  app.globalData.currentUser.role = 'user'
  editor.resetLinkageTrial()
  editor.onLinkageTrialChange({ currentTarget: { dataset: { fieldKey: 'brand-id' } }, detail: { value: '0' } })
  assert.deepEqual(editor.data.linkageTrialFields, trialBefore)
  app.globalData.currentUser.role = 'super_admin'
  editor.resetLinkageTrial()
  assert.deepEqual(editor.data.linkageTrialFields.map(field => field.fieldKey), ['cat'])
  assert.ok(editor.updates.every(update => Object.keys(update).every(key => key.startsWith('linkageTrial'))))
  assert.ok(editor.updates.every(update => payloadBytes(update) < 4096 && !JSON.stringify(update).includes('"rows"')))
  assert.deepEqual(editor.buildNodeForSave(), before)
})
