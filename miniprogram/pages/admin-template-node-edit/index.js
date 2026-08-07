const FIELD_TYPE_OPTIONS = Object.freeze([
  ['short_text', '短文本'], ['long_text', '长文本'], ['number', '数字'],
  ['boolean', '布尔'], ['date', '日期'], ['single_select', '单选'],
  ['multi_select', '多选']
])
const EVIDENCE_TYPE_OPTIONS = Object.freeze([
  ['jpg', 'JPG'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['pdf', 'PDF'],
  ['mp4', 'MP4'], ['mov', 'MOV'], ['m4v', 'M4V']
])

let uiKeySequence = 0
function nextUiKey(prefix) {
  uiKeySequence += 1
  return `${prefix}-ui-${uiKeySequence}`
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function uniqueTexts(value) {
  return [...new Set(String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
}
function newField() {
  return {
    _uiKey: nextUiKey('field'), sequence: 0, name: '', description: '',
    type: 'short_text', required: false, constraints: {}, optionText: ''
  }
}
function newNode() {
  return {
    _uiKey: nextUiKey('node'), sequence: 0, name: '', description: '', assigneeUserIds: [], slaWorkHours: 22,
    requiresEvidence: false, allowedEvidenceTypes: [], fields: []
  }
}

Page({
  data: {
    index: -1,
    editMode: false,
    readOnly: false,
    name: '',
    description: '',
    assigneeOptions: [],
    assigneeUserIds: [],
    slaWorkHours: 22,
    requiresEvidence: false,
    allowedEvidenceTypes: [],
    fields: [],
    fieldTypeOptions: FIELD_TYPE_OPTIONS,
    fieldTypeLabels: FIELD_TYPE_OPTIONS.map(item => item[1]),
    evidenceTypeOptions: EVIDENCE_TYPE_OPTIONS.map(item => ({ value: item[0], label: item[1], selected: false })),
    errorMessage: ''
  },

  onLoad(options = {}) {
    const currentUser = getApp().globalData.currentUser
    if (!currentUser || currentUser.role !== 'super_admin' || currentUser.status !== 'active') {
      this.unavailable = true
      wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
      return
    }
    const pages = getCurrentPages()
    this.ownerPage = pages.length > 1 ? pages[pages.length - 2] : null
    if (!this.ownerPage || typeof this.ownerPage.getNodeEditorContext !== 'function') {
      this.unavailable = true
      wx.navigateBack({ delta: 1 })
      return
    }
    const parsed = Number(options.index)
    const index = Number.isInteger(parsed) ? parsed : -1
    const context = this.ownerPage.getNodeEditorContext(index)
    const node = context.node || newNode()
    this.nodeKey = node.nodeKey
    this.uiKey = node._uiKey || node.nodeKey || nextUiKey('node')
    this.setData({
      index,
      editMode: Boolean(context.node),
      readOnly: Boolean(context.readOnly),
      name: node.name || '',
      description: node.description || '',
      assigneeOptions: clone(context.assigneeOptions || []).map(item => ({
        ...item, selected: (node.assigneeUserIds || []).includes(item._id)
      })),
      assigneeUserIds: clone(node.assigneeUserIds || []),
      slaWorkHours: node.slaWorkHours === undefined ? 22 : node.slaWorkHours,
      requiresEvidence: Boolean(node.requiresEvidence),
      allowedEvidenceTypes: clone(node.allowedEvidenceTypes || []),
      evidenceTypeOptions: EVIDENCE_TYPE_OPTIONS.map(item => ({
        value: item[0], label: item[1], selected: (node.allowedEvidenceTypes || []).includes(item[0])
      })),
      fields: clone(node.fields || []).map((field, sequence) => ({
        ...field,
        _uiKey: field._uiKey || field.fieldKey || nextUiKey('field'),
        sequence,
        optionText: field.constraints && Array.isArray(field.constraints.options)
          ? field.constraints.options.join(', ') : ''
      }))
    })
    wx.setNavigationBarTitle({ title: context.node ? (context.readOnly ? '查看节点' : '编辑节点') : '新增节点' })
  },

  onNameInput(event) { if (!this.data.readOnly) this.setData({ name: event.detail.value }) },
  onDescriptionInput(event) { if (!this.data.readOnly) this.setData({ description: event.detail.value }) },
  onSlaInput(event) { if (!this.data.readOnly) this.setData({ slaWorkHours: event.detail.value }) },
  onAssigneesChange(event) {
    if (this.data.readOnly) return
    const selected = event.detail.value.slice()
    this.setData({
      assigneeUserIds: selected,
      assigneeOptions: this.data.assigneeOptions.map(item => ({ ...item, selected: selected.includes(item._id) }))
    })
  },
  onRequiresEvidenceChange(event) {
    if (!this.data.readOnly) this.setData({ requiresEvidence: Boolean(event.detail.value) })
  },
  onEvidenceTypesChange(event) {
    if (this.data.readOnly) return
    const selected = event.detail.value.slice()
    this.setData({
      allowedEvidenceTypes: selected,
      evidenceTypeOptions: this.data.evidenceTypeOptions.map(item => ({
        ...item, selected: selected.includes(item.value)
      }))
    })
  },

  updateField(index, changes) {
    if (this.data.readOnly || !this.data.fields[index]) return
    const fields = this.data.fields.slice()
    fields[index] = { ...fields[index], ...changes }
    this.setData({ fields })
  },
  onFieldNameInput(event) { this.updateField(Number(event.currentTarget.dataset.index), { name: event.detail.value }) },
  onFieldDescriptionInput(event) { this.updateField(Number(event.currentTarget.dataset.index), { description: event.detail.value }) },
  onFieldRequiredChange(event) { this.updateField(Number(event.currentTarget.dataset.index), { required: Boolean(event.detail.value) }) },
  onFieldTypeChange(event) {
    const type = FIELD_TYPE_OPTIONS[Number(event.detail.value)] && FIELD_TYPE_OPTIONS[Number(event.detail.value)][0]
    if (!type) return
    const constraints = type === 'single_select' || type === 'multi_select' ? { options: [] } : {}
    this.updateField(Number(event.currentTarget.dataset.index), { type, constraints, optionText: '' })
  },
  onFieldOptionsInput(event) {
    const index = Number(event.currentTarget.dataset.index)
    const field = this.data.fields[index]
    if (field) this.updateField(index, {
      optionText: event.detail.value,
      constraints: { ...field.constraints, options: uniqueTexts(event.detail.value) }
    })
  },
  onFieldMinLengthInput(event) { this.updateTextConstraint(event, 'minLength') },
  onFieldMaxLengthInput(event) { this.updateTextConstraint(event, 'maxLength') },
  onFieldPatternInput(event) { this.updateRawConstraint(event, 'pattern') },
  onFieldMinInput(event) { this.updateNumberConstraint(event, 'min') },
  onFieldMaxInput(event) { this.updateNumberConstraint(event, 'max') },
  onFieldDecimalPlacesInput(event) { this.updateNumberConstraint(event, 'decimalPlaces') },

  updateRawConstraint(event, name) {
    const index = Number(event.currentTarget.dataset.index)
    const field = this.data.fields[index]
    if (field) this.updateField(index, { constraints: { ...field.constraints, [name]: event.detail.value } })
  },
  updateTextConstraint(event, name) { this.updateRawConstraint(event, name) },
  updateNumberConstraint(event, name) { this.updateRawConstraint(event, name) },

  addField() {
    if (this.data.readOnly) return
    this.setData({ fields: this.data.fields.concat({ ...newField(), sequence: this.data.fields.length }) })
  },
  removeField(event) {
    if (this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.fields.length) return
    const fields = this.data.fields.slice()
    fields.splice(index, 1)
    this.setData({ fields: fields.map((field, sequence) => ({ ...field, sequence })) })
  },
  moveField(event) {
    if (this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    const direction = Number(event.currentTarget.dataset.direction)
    const target = index + direction
    if (!Number.isInteger(index) || ![-1, 1].includes(direction) || target < 0 || target >= this.data.fields.length) return
    const fields = this.data.fields.slice()
    ;[fields[index], fields[target]] = [fields[target], fields[index]]
    this.setData({ fields: fields.map((field, sequence) => ({ ...field, sequence })) })
  },

  normalizedField(field, sequence) {
    const normalized = {
      _uiKey: field._uiKey || nextUiKey('field'),
      ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
      sequence,
      name: String(field.name || '').trim(),
      description: String(field.description || '').trim(),
      type: field.type,
      required: Boolean(field.required),
      constraints: {}
    }
    const constraints = field.constraints || {}
    if (field.type === 'short_text' || field.type === 'long_text') {
      for (const key of ['minLength', 'maxLength']) {
        if (constraints[key] !== '' && constraints[key] !== undefined) normalized.constraints[key] = Number(constraints[key])
      }
      if (constraints.pattern !== '' && constraints.pattern !== undefined) normalized.constraints.pattern = constraints.pattern
    } else if (field.type === 'number') {
      for (const key of ['min', 'max', 'decimalPlaces']) {
        if (constraints[key] !== '' && constraints[key] !== undefined) normalized.constraints[key] = Number(constraints[key])
      }
    } else if (field.type === 'single_select' || field.type === 'multi_select') {
      normalized.constraints.options = uniqueTexts(constraints.options && constraints.options.join
        ? constraints.options.join(',') : constraints.options)
    }
    return normalized
  },

  async submit() {
    if (this.unavailable || this.data.readOnly) return
    const name = this.data.name.trim()
    const slaWorkHours = Number(this.data.slaWorkHours)
    const fields = this.data.fields.map((field, sequence) => this.normalizedField(field, sequence))
    if (!name || !Number.isFinite(slaWorkHours) || slaWorkHours <= 0 || !this.data.assigneeUserIds.length) {
      this.setData({ errorMessage: '请填写节点名称、正数 SLA，并至少选择一名负责人' })
      return
    }
    if (fields.some(field => !field.name ||
      ((field.type === 'single_select' || field.type === 'multi_select') && !field.constraints.options.length))) {
      this.setData({ errorMessage: '请完整填写字段名称和选项' })
      return
    }
    if (this.data.requiresEvidence && !this.data.allowedEvidenceTypes.length) {
      this.setData({ errorMessage: '要求凭证时至少选择一种凭证类型' })
      return
    }
    const node = {
      _uiKey: this.uiKey,
      ...(this.nodeKey ? { nodeKey: this.nodeKey } : {}),
      sequence: this.data.index >= 0 ? this.data.index : 0,
      name,
      description: this.data.description.trim(),
      assigneeUserIds: this.data.assigneeUserIds.slice(),
      slaWorkHours,
      requiresEvidence: this.data.requiresEvidence,
      allowedEvidenceTypes: this.data.allowedEvidenceTypes.slice(),
      fields
    }
    this.ownerPage.acceptNodeFromEditor(this.data.index, node)
    wx.navigateBack({ delta: 1 })
  }
})

module.exports = { FIELD_TYPE_OPTIONS }
