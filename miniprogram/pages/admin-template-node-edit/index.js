const FIELD_TYPE_OPTIONS = Object.freeze([
  ['short_text', '短文本'], ['long_text', '长文本'], ['number', '数字'],
  ['boolean', '布尔'], ['date', '日期'], ['single_select', '单选'],
  ['multi_select', '多选']
])
const EVIDENCE_TYPE_OPTIONS = Object.freeze([
  ['jpg', 'JPG'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['pdf', 'PDF'],
  ['mp4', 'MP4'], ['mov', 'MOV'], ['m4v', 'M4V']
])
const NEXT_MODE_OPTIONS = Object.freeze([
  ['end', '结束售后'], ['default', '固定进入下一节点'],
  ['single_select', '按本节点单选字段分支'], ['manual', '完成后由处理人决定']
])

let uiKeySequence = 0
function nextUiKey(prefix) {
  uiKeySequence += 1
  return `${prefix}-ui-${uiKeySequence}`
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key) }
function uniqueTexts(value) {
  return [...new Set(String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
}
function newField(versionTwo = false) {
  return {
    _uiKey: nextUiKey('field'), sequence: 0, name: '', description: '',
    ...(versionTwo ? { fieldKey: nextUiKey('field-key') } : {}),
    type: 'short_text', required: false, constraints: {}, optionText: '', conditionEnabled: false
  }
}
function newNode(versionTwo = false) {
  return {
    _uiKey: nextUiKey('node'), ...(versionTwo ? { nodeKey: nextUiKey('node-key'), next: { mode: 'end' } } : {}),
    sequence: 0, name: '', description: '', workflowMode: 'review',
    activationMode: 'required',
    processorAssignmentMode: 'fixed_accounts',
    includeBusinessCreatorAsProcessor: false,
    processorUserIds: [], reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: [], reviewMode: 'any', processingSlaWorkHours: 22, reviewSlaWorkHours: 8,
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
    flowSchemaVersion: 1,
    includeBusinessCreatorAsProcessor: false,
    accountOptions: [],
    processorAssignmentMode: 'fixed_accounts',
    processorUserIds: [],
    reviewerAssignmentMode: 'fixed_accounts',
    reviewerUserIds: [],
    activationMode: 'required',
    optionalTailExistsOutsideCurrentNode: false,
    reviewMode: 'any',
    processingSlaWorkHours: 22,
    reviewSlaWorkHours: 8,
    requiresEvidence: false,
    allowedEvidenceTypes: [],
    fields: [],
    nodeOptions: [],
    targetOptions: [],
    nodeTargetOptions: [],
    nextMode: 'end',
    nextModeLabels: NEXT_MODE_OPTIONS.map(item => item[1]),
    defaultTarget: '',
    routingFieldKey: '',
    routingFieldOptions: [],
    routeOptionRows: [],
    manualActivateTarget: '',
    manualSkipTarget: 'end',
    fieldTypeOptions: FIELD_TYPE_OPTIONS,
    fieldTypeLabels: FIELD_TYPE_OPTIONS.map(item => item[1]),
    evidenceTypeOptions: EVIDENCE_TYPE_OPTIONS.map(item => ({ value: item[0], label: item[1], selected: false })),
    errorMessage: '',
    submitting: false
  },

  decorateField(field, sequence, allFields) {
    const condition = field.condition ? clone(field.condition) : null
    const conditionParentOptions = (allFields || []).slice(0, sequence)
      .filter(item => item.type === 'single_select' && item.fieldKey)
      .map(item => ({ fieldKey: item.fieldKey, name: item.name || `字段 ${item.sequence + 1}` }))
    const parent = condition && (allFields || []).find(item => item.fieldKey === condition.parentFieldKey)
    const parentValues = parent && parent.constraints && Array.isArray(parent.constraints.options)
      ? parent.constraints.options : []
    const childOptions = field.constraints && Array.isArray(field.constraints.options) ? field.constraints.options : []
    return {
      ...field,
      _uiKey: field._uiKey || field.fieldKey || nextUiKey('field'),
      sequence,
      optionText: field.optionText !== undefined
        ? field.optionText
        : field.constraints && Array.isArray(field.constraints.options) ? field.constraints.options.join(', ') : '',
      conditionEnabled: Boolean(condition),
      condition: condition || null,
      conditionParentOptions,
      conditionParentIndex: Math.max(0, conditionParentOptions.findIndex(item =>
        condition && item.fieldKey === condition.parentFieldKey)),
      conditionParentValueRows: parentValues.map(value => ({
        fieldIndex: sequence,
        value,
        visible: Boolean(condition && condition.visibleWhen && condition.visibleWhen.includes(value)),
        optionText: condition && condition.optionsByParentValue && condition.optionsByParentValue[value]
          ? condition.optionsByParentValue[value].join(', ') : childOptions.join(', ')
      }))
    }
  },

  refreshFields(fields, extra = {}) {
    const decorated = fields.map((field, sequence) => this.decorateField(field, sequence, fields))
    const routingFieldOptions = decorated
      .filter(field => field.type === 'single_select' && field.required && !field.condition)
      .map(field => ({ fieldKey: field.fieldKey, name: field.name || `字段 ${field.sequence + 1}` }))
    const routingFieldKey = routingFieldOptions.some(item => item.fieldKey === this.data.routingFieldKey)
      ? this.data.routingFieldKey : (routingFieldOptions[0] && routingFieldOptions[0].fieldKey) || ''
    const routeField = decorated.find(field => field.fieldKey === routingFieldKey)
    const routeOptions = routeField && routeField.constraints && Array.isArray(routeField.constraints.options)
      ? routeField.constraints.options : []
    const previousTargets = new Map((this.data.routeOptionRows || []).map(item => [item.option, item.target]))
    const routeOptionRows = routeOptions.map(option => {
      const target = previousTargets.get(option) || 'end'
      return {
        option,
        target,
        targetIndex: Math.max(0, this.data.targetOptions.findIndex(item => item.nodeKey === target))
      }
    })
    this.setData({ fields: decorated, routingFieldOptions, routingFieldKey, routeOptionRows, ...extra })
  },

  onLoad(options = {}) {
    if (!this.requireSuperAdmin()) return
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
    const versionTwo = context.flowSchemaVersion === 2 || Boolean(context.node && context.node.next)
    const node = context.node || newNode(versionTwo)
    const isLegacyNode = !hasOwn(node, 'workflowMode')
    const processorUserIds = clone(isLegacyNode ? (node.assigneeUserIds || []) : (node.processorUserIds || []))
    const reviewerUserIds = clone(isLegacyNode ? [] : (node.reviewerUserIds || []))
    const processorAssignmentMode = !versionTwo && !isLegacyNode && node.processorAssignmentMode === 'business_creator'
      ? 'business_creator'
      : 'fixed_accounts'
    const reviewerAssignmentMode = !isLegacyNode && node.reviewerAssignmentMode === 'business_creator'
      ? 'business_creator'
      : 'fixed_accounts'
    this.fixedProcessorUserIds = processorAssignmentMode === 'fixed_accounts' ? processorUserIds.slice() : []
    this.nodeKey = node.nodeKey
    this.uiKey = node._uiKey || node.nodeKey || nextUiKey('node')
    const nodeOptions = clone(context.nodeOptions || [])
    const targetOptions = [{ nodeKey: 'end', name: '结束售后' }, ...nodeOptions.filter(item => item.nodeKey !== node.nodeKey)]
    const fields = clone(node.fields || []).map((field, sequence) => this.decorateField(field, sequence, node.fields || []))
    const next = versionTwo && node.next ? clone(node.next) : { mode: 'end' }
    const routingFieldOptions = fields.filter(field => field.type === 'single_select' && field.required && !field.condition)
      .map(field => ({ fieldKey: field.fieldKey, name: field.name }))
    const routingFieldKey = next.mode === 'single_select' ? next.fieldKey : (routingFieldOptions[0] && routingFieldOptions[0].fieldKey) || ''
    const routeField = fields.find(field => field.fieldKey === routingFieldKey)
    const routeOptions = routeField && routeField.constraints && Array.isArray(routeField.constraints.options)
      ? routeField.constraints.options : []
    this.setData({
      index,
      editMode: Boolean(context.node),
      readOnly: Boolean(context.readOnly),
      flowSchemaVersion: versionTwo ? 2 : 1,
      name: node.name || '',
      description: node.description || '',
      accountOptions: clone(context.assigneeOptions || []).map(item => ({
        _id: item._id,
        displayName: item.displayName,
        username: item.username,
        processorSelected: processorUserIds.includes(item._id),
        reviewerSelected: reviewerUserIds.includes(item._id)
      })),
      processorAssignmentMode,
      processorUserIds,
      includeBusinessCreatorAsProcessor: versionTwo && node.includeBusinessCreatorAsProcessor === true ||
        (!versionTwo && processorAssignmentMode === 'business_creator'),
      reviewerAssignmentMode,
      reviewerUserIds,
      activationMode: !isLegacyNode && node.activationMode === 'optional_tail' ? 'optional_tail' : 'required',
      optionalTailExistsOutsideCurrentNode: Boolean(
        context.optionalTailExistsOutsideCurrentNode || options.optionalTailExistsOutsideCurrentNode === '1'
      ),
      reviewMode: !isLegacyNode && node.reviewMode === 'all' ? 'all' : 'any',
      processingSlaWorkHours: !isLegacyNode && node.processingSlaWorkHours !== undefined ? node.processingSlaWorkHours : 22,
      reviewSlaWorkHours: !isLegacyNode && node.reviewSlaWorkHours !== undefined ? node.reviewSlaWorkHours : 8,
      requiresEvidence: Boolean(node.requiresEvidence),
      allowedEvidenceTypes: clone(node.allowedEvidenceTypes || []),
      evidenceTypeOptions: EVIDENCE_TYPE_OPTIONS.map(item => ({
        value: item[0], label: item[1], selected: (node.allowedEvidenceTypes || []).includes(item[0])
      })),
      fields,
      nodeOptions,
      targetOptions,
      nodeTargetOptions: targetOptions.filter(item => item.nodeKey !== 'end'),
      nextMode: next.mode,
      defaultTarget: next.targetNodeKey || (targetOptions.find(item => item.nodeKey !== 'end') || {}).nodeKey || '',
      routingFieldKey,
      routingFieldOptions,
      routeOptionRows: routeOptions.map(option => ({
        option, target: next.optionTargets && next.optionTargets[option] || 'end',
        targetIndex: Math.max(0, targetOptions.findIndex(item => item.nodeKey ===
          (next.optionTargets && next.optionTargets[option] || 'end')))
      })),
      manualActivateTarget: next.activateTarget || (targetOptions.find(item => item.nodeKey !== 'end') || {}).nodeKey || '',
      manualSkipTarget: next.skipTarget || 'end'
    })
    wx.setNavigationBarTitle({ title: context.node ? (context.readOnly ? '查看节点' : '编辑节点') : '新增节点' })
  },

  requireSuperAdmin() {
    const currentUser = getApp().globalData.currentUser
    if (currentUser && currentUser.role === 'super_admin' && currentUser.status === 'active') return true
    this.unavailable = true
    wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
    return false
  },

  onNameInput(event) {
    if (this.requireSuperAdmin() && !this.data.readOnly) this.setData({ name: event.detail.value })
  },
  onDescriptionInput(event) {
    if (this.requireSuperAdmin() && !this.data.readOnly) this.setData({ description: event.detail.value })
  },
  onProcessingSlaInput(event) {
    if (this.requireSuperAdmin() && !this.data.readOnly) this.setData({ processingSlaWorkHours: event.detail.value })
  },
  onReviewSlaInput(event) {
    if (this.requireSuperAdmin() && !this.data.readOnly) this.setData({ reviewSlaWorkHours: event.detail.value })
  },
  toggleAccountRole(role, event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    if (role === 'processor' && this.data.processorAssignmentMode === 'business_creator') return
    if (role === 'reviewer' && this.data.reviewerAssignmentMode === 'business_creator') return
    const id = event && event.currentTarget && event.currentTarget.dataset.id
    if (typeof id !== 'string' || !this.data.accountOptions.some(item => item._id === id)) return
    const dataKey = role === 'processor' ? 'processorUserIds' : 'reviewerUserIds'
    const selected = this.data[dataKey].includes(id)
      ? this.data[dataKey].filter(item => item !== id)
      : [...this.data[dataKey], id]
    this.setData({
      [dataKey]: selected,
      accountOptions: this.data.accountOptions.map(item => ({
        ...item,
        processorSelected: role === 'processor' ? selected.includes(item._id) : item.processorSelected,
        reviewerSelected: role === 'reviewer' ? selected.includes(item._id) : item.reviewerSelected
      }))
    })
  },
  onProcessorToggle(event) { this.toggleAccountRole('processor', event) },
  onReviewerToggle(event) { this.toggleAccountRole('reviewer', event) },
  onIncludeBusinessCreatorAsProcessorChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly || this.data.flowSchemaVersion !== 2) return
    const include = Boolean(event && event.detail && event.detail.value)
    if (include && this.data.reviewerAssignmentMode === 'business_creator') {
      this.setData({ errorMessage: '售后发起人不能同时作为本节点处理人和审核人' })
      return
    }
    this.setData({ includeBusinessCreatorAsProcessor: include, errorMessage: '' })
  },
  onProcessorAssignmentModeChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const processorAssignmentMode = event && event.detail && event.detail.value
      ? 'business_creator'
      : 'fixed_accounts'
    if (processorAssignmentMode === this.data.processorAssignmentMode) return
    if (processorAssignmentMode === 'business_creator' && this.data.reviewerAssignmentMode === 'business_creator') {
      this.setData({ errorMessage: '售后发起人不能同时作为本节点处理人和审核人' })
      return
    }
    if (processorAssignmentMode === 'business_creator') {
      this.fixedProcessorUserIds = this.data.processorUserIds.slice()
    }
    const processorUserIds = processorAssignmentMode === 'business_creator'
      ? []
      : (this.fixedProcessorUserIds || []).slice()
    this.setData({
      processorAssignmentMode,
      processorUserIds,
      errorMessage: '',
      accountOptions: this.data.accountOptions.map(item => ({
        ...item,
        processorSelected: processorUserIds.includes(item._id)
      }))
    })
  },
  onReviewerAssignmentModeChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const reviewerAssignmentMode = event && event.detail && event.detail.value
      ? 'business_creator'
      : 'fixed_accounts'
    if (reviewerAssignmentMode === this.data.reviewerAssignmentMode) return
    if (reviewerAssignmentMode === 'business_creator' &&
        (this.data.processorAssignmentMode === 'business_creator' || this.data.includeBusinessCreatorAsProcessor)) {
      this.setData({ errorMessage: '售后发起人不能同时作为本节点处理人和审核人' })
      return
    }
    this.setData({
      reviewerAssignmentMode,
      reviewerUserIds: [],
      errorMessage: '',
      accountOptions: this.data.accountOptions.map(item => ({
        ...item,
        reviewerSelected: false
      }))
    })
  },
  onReviewModeChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const reviewMode = event && event.detail && event.detail.value
    if (reviewMode === 'any' || reviewMode === 'all') this.setData({ reviewMode })
  },
  onOptionalTailChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const wantsOptionalTail = Boolean(event && event.detail && event.detail.value)
    if (wantsOptionalTail && this.data.optionalTailExistsOutsideCurrentNode) {
      this.setData({ errorMessage: '每个模板只能设置一个可选追加节点' })
      return
    }
    this.setData({
      activationMode: wantsOptionalTail ? 'optional_tail' : 'required',
      errorMessage: ''
    })
  },
  onNextModeChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly || this.data.flowSchemaVersion !== 2) return
    const item = NEXT_MODE_OPTIONS[Number(event.detail.value)]
    if (item) this.setData({ nextMode: item[0], errorMessage: '' })
  },
  onDefaultTargetChange(event) {
    const target = this.data.nodeTargetOptions[Number(event.detail.value)]
    if (target && this.requireSuperAdmin() && !this.data.readOnly) this.setData({ defaultTarget: target.nodeKey })
  },
  onRoutingFieldChange(event) {
    const selected = this.data.routingFieldOptions[Number(event.detail.value)]
    if (!selected || !this.requireSuperAdmin() || this.data.readOnly) return
    this.setData({ routingFieldKey: selected.fieldKey })
    this.refreshFields(this.data.fields)
  },
  onRouteOptionTargetChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const option = event.currentTarget.dataset.option
    const target = this.data.targetOptions[Number(event.detail.value)]
    if (!target) return
    const rows = this.data.routeOptionRows.map(item => item.option === option
      ? { ...item, target: target.nodeKey, targetIndex: Number(event.detail.value) }
      : item)
    this.setData({ routeOptionRows: rows })
  },
  onManualActivateTargetChange(event) {
    const target = this.data.nodeTargetOptions[Number(event.detail.value)]
    if (target && this.requireSuperAdmin() && !this.data.readOnly) this.setData({ manualActivateTarget: target.nodeKey })
  },
  onManualSkipTargetChange(event) {
    const target = this.data.targetOptions[Number(event.detail.value)]
    if (target && this.requireSuperAdmin() && !this.data.readOnly) this.setData({ manualSkipTarget: target.nodeKey })
  },
  onRequiresEvidenceChange(event) {
    if (this.requireSuperAdmin() && !this.data.readOnly) {
      this.setData({ requiresEvidence: Boolean(event.detail.value) })
    }
  },
  onEvidenceTypesChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const selected = event.detail.value.slice()
    this.setData({
      allowedEvidenceTypes: selected,
      evidenceTypeOptions: this.data.evidenceTypeOptions.map(item => ({
        ...item, selected: selected.includes(item.value)
      }))
    })
  },

  updateField(index, changes) {
    if (!this.requireSuperAdmin() || this.data.readOnly || !this.data.fields[index]) return
    const fields = this.data.fields.slice()
    fields[index] = { ...fields[index], ...changes }
    this.refreshFields(fields)
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
  onFieldConditionChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    const field = this.data.fields[index]
    if (!field) return
    if (!event.detail.value) {
      this.updateField(index, { condition: null, conditionEnabled: false })
      return
    }
    const parent = field.conditionParentOptions[0]
    if (!parent) {
      this.setData({ errorMessage: '条件字段前必须先配置一个单选字段' })
      return
    }
    this.setFieldParent(index, parent.fieldKey)
  },
  setFieldParent(index, parentFieldKey) {
    const parent = this.data.fields.find(item => item.fieldKey === parentFieldKey)
    const values = parent && parent.constraints && Array.isArray(parent.constraints.options)
      ? parent.constraints.options.slice() : []
    const field = this.data.fields[index]
    const condition = { parentFieldKey, visibleWhen: values }
    if (field && field.type === 'single_select') {
      const options = field.constraints && Array.isArray(field.constraints.options) ? field.constraints.options.slice() : []
      condition.optionsByParentValue = Object.fromEntries(values.map(value => [value, options.slice()]))
    }
    this.updateField(index, { condition, conditionEnabled: true })
  },
  onFieldConditionParentChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    const field = this.data.fields[index]
    const parent = field && field.conditionParentOptions[Number(event.detail.value)]
    if (parent) this.setFieldParent(index, parent.fieldKey)
  },
  onFieldVisibleWhenChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    const field = this.data.fields[index]
    if (!field || !field.condition) return
    const visibleWhen = event.detail.value.slice()
    const condition = { ...field.condition, visibleWhen }
    if (condition.optionsByParentValue) {
      condition.optionsByParentValue = Object.fromEntries(visibleWhen.map(value => [
        value, condition.optionsByParentValue[value] || (field.constraints.options || []).slice()
      ]))
    }
    this.updateField(index, { condition })
  },
  onFieldConditionalOptionsInput(event) {
    const index = Number(event.currentTarget.dataset.index)
    const parentValue = event.currentTarget.dataset.parentValue
    const field = this.data.fields[index]
    if (!field || !field.condition || field.type !== 'single_select') return
    const allowed = new Set(field.constraints.options || [])
    const options = uniqueTexts(event.detail.value).filter(option => allowed.has(option))
    this.updateField(index, {
      condition: {
        ...field.condition,
        optionsByParentValue: { ...(field.condition.optionsByParentValue || {}), [parentValue]: options }
      }
    })
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
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    this.refreshFields(this.data.fields.concat({
      ...newField(this.data.flowSchemaVersion === 2), sequence: this.data.fields.length
    }))
  },
  removeField(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.fields.length) return
    const key = this.data.fields[index].fieldKey
    if (key && this.data.fields.some((field, fieldIndex) =>
      fieldIndex !== index && field.condition && field.condition.parentFieldKey === key)) {
      this.setData({ errorMessage: '该字段仍被后续条件字段依赖，请先解除依赖' })
      return
    }
    const fields = this.data.fields.slice()
    fields.splice(index, 1)
    this.refreshFields(fields.map((field, sequence) => ({ ...field, sequence })), { errorMessage: '' })
  },
  moveField(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    const direction = Number(event.currentTarget.dataset.direction)
    const target = index + direction
    if (!Number.isInteger(index) || ![-1, 1].includes(direction) || target < 0 || target >= this.data.fields.length) return
    const fields = this.data.fields.slice()
    ;[fields[index], fields[target]] = [fields[target], fields[index]]
    const moved = fields.map((field, sequence) => ({ ...field, sequence }))
    const positions = new Map(moved.map((field, position) => [field.fieldKey, position]))
    if (moved.some((field, position) => field.condition && positions.get(field.condition.parentFieldKey) >= position)) {
      this.setData({ errorMessage: '条件字段必须位于其依赖的单选字段之后' })
      return
    }
    this.refreshFields(moved, { errorMessage: '' })
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
    if (field.condition) normalized.condition = clone(field.condition)
    return normalized
  },

  buildNext(fields) {
    if (this.data.flowSchemaVersion !== 2) return null
    if (this.data.nextMode === 'end') return { mode: 'end' }
    if (this.data.nextMode === 'default') {
      return { mode: 'default', targetNodeKey: this.data.defaultTarget }
    }
    if (this.data.nextMode === 'manual') {
      return {
        mode: 'manual', activateTarget: this.data.manualActivateTarget,
        skipTarget: this.data.manualSkipTarget
      }
    }
    const field = fields.find(item => item.fieldKey === this.data.routingFieldKey)
    const options = field && field.constraints && Array.isArray(field.constraints.options)
      ? field.constraints.options : []
    const targets = new Map(this.data.routeOptionRows.map(item => [item.option, item.target]))
    return {
      mode: 'single_select', fieldKey: this.data.routingFieldKey,
      optionTargets: Object.fromEntries(options.map(option => [option, targets.get(option) || 'end']))
    }
  },

  buildNodeForSave() {
    const fields = this.data.fields.map((field, sequence) => this.normalizedField(field, sequence))
    const node = {
      _uiKey: this.uiKey,
      ...(this.nodeKey ? { nodeKey: this.nodeKey } : {}),
      sequence: this.data.index >= 0 ? this.data.index : 0,
      name: this.data.name.trim(),
      description: this.data.description.trim(),
      workflowMode: 'review',
      activationMode: this.data.activationMode,
      processorAssignmentMode: this.data.processorAssignmentMode,
      processorUserIds: this.data.processorUserIds.slice(),
      reviewerAssignmentMode: this.data.reviewerAssignmentMode,
      reviewerUserIds: this.data.reviewerUserIds.slice(),
      reviewMode: this.data.reviewMode,
      processingSlaWorkHours: Number(this.data.processingSlaWorkHours),
      reviewSlaWorkHours: Number(this.data.reviewSlaWorkHours),
      requiresEvidence: this.data.requiresEvidence,
      allowedEvidenceTypes: this.data.allowedEvidenceTypes.slice(),
      fields
    }
    if (this.data.flowSchemaVersion === 2) {
      node.includeBusinessCreatorAsProcessor = this.data.includeBusinessCreatorAsProcessor
      node.next = this.buildNext(fields)
      node.activationMode = 'required'
      node.processorAssignmentMode = 'fixed_accounts'
    }
    return node
  },

  async submit() {
    if (!this.requireSuperAdmin() || this.unavailable || this.data.readOnly || this.committed || this.data.submitting) return
    const node = this.buildNodeForSave()
    if (!node.name) {
      this.setData({ errorMessage: '请填写节点名称' })
      return
    }
    if (!Number.isSafeInteger(node.processingSlaWorkHours * 60) || node.processingSlaWorkHours <= 0 ||
      !Number.isSafeInteger(node.reviewSlaWorkHours * 60) || node.reviewSlaWorkHours <= 0) {
      this.setData({ errorMessage: '处理与审核 SLA 必须是可精确换算为整分钟的正数小时' })
      return
    }
    if (node.processorAssignmentMode === 'fixed_accounts' && !node.processorUserIds.length &&
        !node.includeBusinessCreatorAsProcessor) {
      this.setData({ errorMessage: '请至少选择一名处理人' })
      return
    }
    if ((node.processorAssignmentMode === 'business_creator' || node.includeBusinessCreatorAsProcessor) &&
        node.reviewerAssignmentMode === 'business_creator') {
      this.setData({ errorMessage: '售后发起人不能同时作为本节点处理人和审核人' })
      return
    }
    if (node.processorUserIds.some(id => node.reviewerUserIds.includes(id))) {
      this.setData({ errorMessage: '处理人与审核人不能为同一账号' })
      return
    }
    if (node.fields.some(field => !field.name ||
      ((field.type === 'single_select' || field.type === 'multi_select') && !field.constraints.options.length))) {
      this.setData({ errorMessage: '请完整填写字段名称和选项' })
      return
    }
    if (this.data.flowSchemaVersion === 2 && (
      node.next.mode === 'default' && !node.next.targetNodeKey ||
      node.next.mode === 'single_select' && (!node.next.fieldKey || Object.values(node.next.optionTargets).some(value => !value)) ||
      node.next.mode === 'manual' && (!node.next.activateTarget || !node.next.skipTarget))) {
      this.setData({ errorMessage: '请完整配置本节点的后续规则' })
      return
    }
    if (this.data.flowSchemaVersion === 2 && node.next.mode === 'manual' &&
        node.next.activateTarget === node.next.skipTarget) {
      this.setData({ errorMessage: '开启目标与跳过目标不能相同' })
      return
    }
    if (this.data.requiresEvidence && !this.data.allowedEvidenceTypes.length) {
      this.setData({ errorMessage: '要求凭证时至少选择一种凭证类型' })
      return
    }
    if (!this.requireSuperAdmin()) return
    this.committed = true
    this.setData({ submitting: true, errorMessage: '' })
    try {
      this.ownerPage.acceptNodeFromEditor(this.data.index, node)
      wx.navigateBack({ delta: 1 })
    } catch (error) {
      this.committed = false
      this.setData({ submitting: false, errorMessage: '保存节点失败，请重试' })
    }
  }
})

module.exports = { FIELD_TYPE_OPTIONS }
