const { normalizeOptionLinkageInput, buildOptionLinkageContext, jsonByteLength, MAX_NODE_BYTES } = require('./option-linkage-domain')

const KEYS = ['category', 'brand', 'model', 'attribute1', 'attribute2', 'attribute3', 'attribute4', 'attribute5']
const NAMES = ['分类', '品牌', '型号', '属性1', '属性2', '属性3', '属性4', '属性5']
const clone = value => JSON.parse(JSON.stringify(value))
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const fieldReference = field => field.fieldKey || field.clientFieldKey
function fail(message) { throw new Error(message) }

function validateLinkedNode(node) {
  const fields = node.fields || []
  if (!fields.some(field => hasOwn(field, 'optionLinkage'))) return null
  const canonical = fields.map((field, sequence) => ({ ...field, sequence, fieldKey: fieldReference(field) }))
  let context
  try {
    const keys = canonical.map(field => field.fieldKey).filter(Boolean)
    if (new Set(keys).size !== keys.length) fail('duplicate keys')
    context = buildOptionLinkageContext(canonical)
  } catch (error) { fail('商品联动规则无效：请检查八个单选字段、选项、组合索引和 256 KiB / 5000 行限制') }
  const members = [...context.members.keys()]
  const start = canonical.findIndex(field => field.fieldKey === members[0])
  if (members.some((key, column) => !canonical[start + column] || canonical[start + column].fieldKey !== key)) {
    fail('商品联动字段必须按分类、品牌、型号、属性1至属性5连续排列，请整体更新')
  }
  for (const [index, field] of canonical.entries()) {
    if (!field.condition) continue
    const parentIndex = canonical.findIndex(parent => parent.fieldKey === field.condition.parentFieldKey)
    if (parentIndex < 0 || parentIndex >= index || canonical[parentIndex].type !== 'single_select') {
      fail('原条件字段的父字段必须是唯一的前置单选字段，请先调整显示条件')
    }
    const options = canonical[parentIndex].constraints.options || []
    if (!Array.isArray(field.condition.visibleWhen) || !field.condition.visibleWhen.length ||
        field.condition.visibleWhen.some(value => !options.includes(value))) {
      fail('原条件字段引用的父选项已改变，请先调整显示条件')
    }
  }
  if (node.next && node.next.mode === 'single_select' && context.members.has(node.next.fieldKey)) {
    fail('商品联动成员不能作为流程分支控制字段，请先调整路由')
  }
  if (jsonByteLength(node) > MAX_NODE_BYTES) fail('完整节点超过 512 KiB，无法应用或保存商品联动')
  return context
}

function linkageSummary(fields, rule) {
  if (!rule) return null
  return {
    rowCount: rule.rows.length,
    modelCount: new Set(rule.rows.map(row => JSON.stringify(row.slice(0, 3)))).size,
    fieldCount: rule.fieldKeys.length,
    fields: rule.fieldKeys.map((key, column) => {
      const field = fields.find(item => fieldReference(item) === key)
      return { name: field.name, optionCount: field.constraints.options.length,
        applicableCount: rule.rows.filter(row => row[column] !== null).length }
    })
  }
}

function parseOptionLinkageImport(text) {
  let input
  try { input = JSON.parse(text) } catch (error) { fail('JSON 格式错误，请粘贴完整的结构化导入内容') }
  try {
    if (!input || input.schemaVersion !== 1 || !Array.isArray(input.fields) || input.fields.length !== 8) fail('shape')
    const rule = normalizeOptionLinkageInput(input.optionLinkage)
    if (rule.fieldKeys.some((key, index) => key !== KEYS[index])) fail('keys')
    const fields = input.fields.map((field, sequence) => {
      if (!field || field.fieldKey !== KEYS[sequence] || field.name !== NAMES[sequence] ||
          field.type !== 'single_select' || typeof field.required !== 'boolean' || hasOwn(field, 'condition')) fail('field')
      return { fieldKey: field.fieldKey, name: field.name, type: field.type, required: field.required,
        sequence, constraints: field.constraints }
    })
    fields[0].optionLinkage = rule
    validateLinkedNode({ fields })
    return { fields, optionLinkage: rule, summary: linkageSummary(fields, rule) }
  } catch (error) { fail('商品联动导入无效：需要八个有序单选字段、合法组合及字典（最多 5000 行 / 256 KiB）') }
}

function applyOptionLinkageImport(node, imported, { versionTwo, allocateKey, cardFields = [] } = {}) {
  const fields = node.fields || []
  const existingContext = validateLinkedNode(node)
  const existingMembers = existingContext ? existingContext.members : new Map()
  const byName = name => fields.filter(field => String(field.name || '').trim() === name)
  const skuFields = fields.filter(field => /^sku$/i.test(String(field.name || '').trim()))
  if (skuFields.length > 1 || NAMES.some(name => byName(name).length > 1)) fail('字段名称重复或有歧义，无法安全导入商品联动')
  if (NAMES.slice(3).some(name => byName(name).some(field => !existingMembers.has(fieldReference(field))))) {
    fail('属性字段名称与无关字段冲突，无法安全替换')
  }
  if (existingMembers.size && NAMES.some((name, column) =>
    !byName(name)[0] || [...existingMembers.keys()][column] !== fieldReference(byName(name)[0]))) {
    fail('现有商品联动字段名称冲突，无法安全替换')
  }
  const sku = skuFields[0]
  const skuKey = sku && fieldReference(sku)
  if (skuKey && (fields.some(field => field.condition && field.condition.parentFieldKey === skuKey) ||
      node.next && node.next.fieldKey === skuKey || cardFields.some(field => field.fieldKey === skuKey &&
        (!field.nodeKey || field.nodeKey === (node.nodeKey || node._uiKey))))) {
    fail('SKU 仍被条件、路由或已保存卡片展示引用，请先明确调整引用，再导入')
  }
  const members = imported.fields.map((incoming, column) => {
    const previous = byName(NAMES[column])[0]
    const member = previous ? clone(previous) : { name: NAMES[column], description: '', required: true, _uiKey: allocateKey('field') }
    if (!fieldReference(member)) {
      if (versionTwo) member.fieldKey = allocateKey('field-key')
      else member.clientFieldKey = allocateKey('field-key')
    }
    member.type = 'single_select'
    member.constraints = clone(incoming.constraints)
    for (const key of ['condition', 'conditionEnabled', 'conditionalOptionTexts', 'optionText', 'optionLinkage']) delete member[key]
    return member
  })
  const rule = normalizeOptionLinkageInput({ ...imported.optionLinkage, fieldKeys: members.map(fieldReference) })
  members[0].optionLinkage = rule
  const replaced = new Set([...NAMES.flatMap(byName), ...skuFields])
  const category = byName(NAMES[0])[0]
  const insertionAnchor = category || fields.find(field => replaced.has(field))
  const resultFields = []
  for (const field of fields) {
    if (field === insertionAnchor) resultFields.push(...members)
    if (!replaced.has(field)) resultFields.push(clone(field))
  }
  if (!insertionAnchor) resultFields.push(...members)
  const result = { ...clone(node), fields: resultFields.map((field, sequence) => ({ ...field, sequence })) }
  validateLinkedNode(result)
  return result
}

// Only the compact ordinary field projection crosses setData; the rule stays in page memory.
function detachNodeLinkage(node) {
  const anchor = (node.fields || []).find(field => hasOwn(field, 'optionLinkage'))
  const rule = anchor ? clone(anchor.optionLinkage) : null
  const members = new Set(rule ? rule.fieldKeys : [])
  const fields = (node.fields || []).map(field => {
    const { optionLinkage, ...ordinary } = field
    return { ...ordinary, ...(members.has(fieldReference(field)) ? { linked: true } : {}) }
  })
  return { node: { ...node, fields }, rule }
}

function attachNodeLinkage(node, rule) {
  if (!rule) return node
  return { ...node, fields: (node.fields || []).map(field => fieldReference(field) === rule.fieldKeys[0]
    ? { ...field, optionLinkage: clone(rule) } : field) }
}

module.exports = { fieldReference, validateLinkedNode, linkageSummary, parseOptionLinkageImport,
  applyOptionLinkageImport, detachNodeLinkage, attachNodeLinkage }
