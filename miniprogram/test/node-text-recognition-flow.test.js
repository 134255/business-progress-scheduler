const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildRecognitionPreview,
  applyRecognitionPreview,
  recognitionSnapshotStillCurrent
} = require('../utils/node-text-recognition')

const fields = [
  { fieldKey: 'model', name: '型号', type: 'single_select', constraints: { options: ['A款', 'B款'] } },
  { fieldKey: 'date', name: '购买日期', type: 'date', constraints: {} },
  { fieldKey: 'tags', name: '标签', type: 'multi_select', constraints: { options: ['加急', '返修'] } },
  { fieldKey: 'amount', name: '金额', type: 'number', constraints: { min: 0, max: 100, decimalPlaces: 2 } },
  { fieldKey: 'code', name: '编号', type: 'short_text', constraints: { minLength: 2, maxLength: 5, pattern: '^[A-Z]{2,5}$' } }
]

test('识别预览默认只选择空字段的确定候选，已有值与待确认候选保持未选', () => {
  const preview = buildRecognitionPreview(fields, { model: 'A款', date: '', tags: [] }, [
    { fieldKey: 'model', value: 'B款', confidence: 0.98, sourceExcerpt: '型号B款', matchKind: 'exact', requiresConfirmation: false, alternatives: [] },
    { fieldKey: 'date', value: '2026-08-26', confidence: 0.94, sourceExcerpt: '8月26日购买', matchKind: 'direct', requiresConfirmation: false, alternatives: [] },
    { fieldKey: 'tags', value: ['加急'], confidence: 0.61, sourceExcerpt: '比较着急', matchKind: 'semantic', requiresConfirmation: true, alternatives: [] }
  ])

  assert.deepEqual(preview.map(item => ({ key: item.fieldKey, group: item.group, selected: item.selected })), [
    { key: 'model', group: 'replacement', selected: false },
    { key: 'date', group: 'direct', selected: true },
    { key: 'tags', group: 'manual', selected: false }
  ])
  assert.equal(preview[1].candidateText, '2026-08-26')
})

test('应用预览只写入用户选中的候选并同步多选项状态', () => {
  const preview = buildRecognitionPreview(fields, { model: 'A款', date: '', tags: [] }, [
    { fieldKey: 'model', value: 'B款', confidence: 0.98, sourceExcerpt: '型号B款', matchKind: 'exact', requiresConfirmation: false, alternatives: [] },
    { fieldKey: 'date', value: '2026-08-26', confidence: 0.94, sourceExcerpt: '8月26日购买', matchKind: 'direct', requiresConfirmation: false, alternatives: [] },
    { fieldKey: 'tags', value: ['加急'], confidence: 0.88, sourceExcerpt: '加急处理', matchKind: 'exact', requiresConfirmation: false, alternatives: [] }
  ]).map(item => ({ ...item, selected: item.fieldKey !== 'model' }))

  const applied = applyRecognitionPreview(fields, { model: 'A款', date: '', tags: [] }, preview)
  assert.deepEqual(applied.fieldValues, { model: 'A款', date: '2026-08-26', tags: ['加急'] })
  assert.deepEqual(applied.fields[2].optionItems, [
    { value: '加急', selected: true },
    { value: '返修', selected: false }
  ])
})

test('账号、节点版本、字段摘要或表单修订任一变化都会丢弃迟到识别结果', () => {
  const snapshot = { actorId: 'user-1', lineId: 'line-1', nodeId: 'node-1', nodeVersion: 3, schemaDigest: 'schema-1', formRevision: 7 }
  assert.equal(recognitionSnapshotStillCurrent(snapshot, { ...snapshot }), true)
  for (const key of ['actorId', 'lineId', 'nodeId', 'nodeVersion', 'schemaDigest', 'formRevision']) {
    assert.equal(recognitionSnapshotStillCurrent(snapshot, { ...snapshot, [key]: `${snapshot[key]}-changed` }), false)
  }
})

test('客户端预览和应用都拒绝越界数字、非法日期及违反文本约束的候选', () => {
  const values = { model: '', date: '', tags: [], amount: null, code: '' }
  const invalid = [
    { fieldKey: 'amount', value: 999, confidence: 1, sourceExcerpt: '999' },
    { fieldKey: 'amount', value: 1.234, confidence: 1, sourceExcerpt: '1.234' },
    { fieldKey: 'date', value: '2026-99-99', confidence: 1, sourceExcerpt: '错误日期' },
    { fieldKey: 'code', value: 'a', confidence: 1, sourceExcerpt: 'a' }
  ]
  assert.deepEqual(buildRecognitionPreview(fields, values, invalid), [])
  const applied = applyRecognitionPreview(fields, values, invalid.map(item => ({ ...item, selected: true })))
  assert.deepEqual(applied.fieldValues, values)
})
