const { createKeyAllocator } = require('../../utils/template-editor-keys')
const { fieldReference, validateLinkedNode, linkageSummary, parseOptionLinkageImport,
  applyOptionLinkageImport, detachNodeLinkage } = require('../../utils/option-linkage-import')
const { buildOptionLinkageContext } = require('../../utils/option-linkage-domain')
const CONDITIONAL_PAGE_SIZE = 20

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

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key) }
function uniqueTexts(value) {
  return [...new Set(String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
}
function newField(versionTwo, allocateKey) {
  return {
    _uiKey: allocateKey('field'), sequence: 0, name: '', description: '',
    ...(versionTwo ? { fieldKey: allocateKey('field-key') } : {}),
    type: 'short_text', required: false, constraints: {}, optionText: '', conditionEnabled: false
  }
}
function newNode(versionTwo, allocateKey) {
  return {
    _uiKey: allocateKey('node'), ...(versionTwo ? { nodeKey: allocateKey('node-key'), next: { mode: 'end' } } : {}),
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
    linkageSummary: null,
    linkageImportOpen: false,
    linkageImportPreview: null,
    linkageImportError: '',
    linkageTrialOpen: false,
    linkageTrialFields: [],
    linkageTrialSource: '',
    linkageTrialComplete: false,
    submitting: false
  },

  decorateField(field, sequence, allFields) {
    const linked = this.isLinkedField(field)
    if (linked) {
      const { optionLinkage, condition, ...ordinary } = field
      return { ...ordinary, _uiKey: field._uiKey || fieldReference(field) || this.allocateKey('field'),
        sequence, linked: true, optionText: '', optionCount: field.constraints.options.length,
        conditionEnabled: false, conditionParentOptions: [], conditionParentValueRows: [] }
    }
    const condition = field.condition ? clone(field.condition) : null
    const conditionParentOptions = (allFields || []).slice(0, sequence)
      .filter(item => item.type === 'single_select' && item.fieldKey)
      .map(item => ({ fieldKey: item.fieldKey, name: item.name || `字段 ${item.sequence + 1}` }))
    const parent = condition && (allFields || []).find(item => item.fieldKey === condition.parentFieldKey)
    const parentValues = parent && parent.constraints && Array.isArray(parent.constraints.options)
      ? parent.constraints.options : []
    const childOptions = field.constraints && Array.isArray(field.constraints.options) ? field.constraints.options : []
    const optionText = field.optionText !== undefined ? field.optionText : childOptions.join(', ')
    const uiKey = field._uiKey || field.fieldKey || this.allocateKey('field')
    if (condition && this.isLinkedField(parent)) {
      if (!this._conditionalDrafts) this._conditionalDrafts = new Map()
      if (!this._conditionalWindows) this._conditionalWindows = new Map()
      this._conditionalDrafts.set(uiKey, { ...field, _uiKey: uiKey, sequence })
      const window = this._conditionalWindows.get(uiKey) || { page: 0, editingValue: null }
      const pageCount = Math.max(1, Math.ceil(parentValues.length / CONDITIONAL_PAGE_SIZE))
      const page = Math.min(window.page, pageCount - 1)
      this._conditionalWindows.set(uiKey, { ...window, page })
      const { conditionalOptionTexts, ...ordinary } = field
      return { ...ordinary, _uiKey: uiKey, sequence, lazyConditional: true, optionText,
        optionCount: uniqueTexts(optionText).length, conditionEnabled: true,
        condition: { parentFieldKey: condition.parentFieldKey, visibleWhen: condition.visibleWhen.slice() },
        conditionParentOptions,
        conditionParentIndex: Math.max(0, conditionParentOptions.findIndex(item => item.fieldKey === condition.parentFieldKey)),
        conditionalPage: page, conditionalPageCount: pageCount,
        conditionParentValueRows: parentValues.slice(page * CONDITIONAL_PAGE_SIZE, (page + 1) * CONDITIONAL_PAGE_SIZE).map(value => {
          const visible = condition.visibleWhen.includes(value)
          const editing = visible && window.editingValue === value
          const row = { fieldIndex: sequence, value, visible, editing }
          if (editing) {
            row.optionText = conditionalOptionTexts && hasOwn(conditionalOptionTexts, value) ? conditionalOptionTexts[value]
              : condition.optionsByParentValue && condition.optionsByParentValue[value]
                ? condition.optionsByParentValue[value].join(', ') : childOptions.join(', ')
            row.optionCount = uniqueTexts(row.optionText).length
          }
          return row
        }) }
    }
    return {
      ...field,
      _uiKey: field._uiKey || field.fieldKey || this.allocateKey('field'),
      sequence,
      optionText,
      optionCount: uniqueTexts(optionText).length,
      conditionEnabled: Boolean(condition),
      condition: condition || null,
      conditionParentOptions,
      conditionParentIndex: Math.max(0, conditionParentOptions.findIndex(item =>
        condition && item.fieldKey === condition.parentFieldKey)),
      conditionParentValueRows: parentValues.map(value => {
        const conditionalOptionText = field.conditionalOptionTexts && hasOwn(field.conditionalOptionTexts, value)
          ? field.conditionalOptionTexts[value]
          : condition && condition.optionsByParentValue && condition.optionsByParentValue[value]
            ? condition.optionsByParentValue[value].join(', ') : childOptions.join(', ')
        return {
          fieldIndex: sequence,
          value,
          visible: Boolean(condition && condition.visibleWhen && condition.visibleWhen.includes(value)),
          optionText: conditionalOptionText,
          optionCount: uniqueTexts(conditionalOptionText).length
        }
      })
    }
  },

  refreshFields(fields, extra = {}) {
    fields = fields.map(field => this.draftField(field))
    const decorated = fields.map((field, sequence) => this.decorateField(field, sequence, fields))
    const routingFieldOptions = decorated
      .filter(field => field.type === 'single_select' && field.required && !field.condition && !field.linked)
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
    const update = { routingFieldOptions, routingFieldKey, routeOptionRows,
      linkageSummary: linkageSummary(decorated, this._optionLinkage), ...extra }
    // Send only changed properties when identity/order are stable. A rename must
    // not retransmit every option dictionary or even the current mapping window.
    if (decorated.length !== this.data.fields.length || decorated.some((field, index) =>
      field._uiKey !== this.data.fields[index]._uiKey || Object.keys(this.data.fields[index]).some(key => !hasOwn(field, key)))) {
      update.fields = decorated
    } else {
      decorated.forEach((field, index) => Object.keys(field).forEach(key => {
        if (JSON.stringify(field[key]) !== JSON.stringify(this.data.fields[index][key])) update[`fields[${index}].${key}`] = field[key]
      }))
    }
    for (const key of Object.keys(update)) {
      if (!key.startsWith('fields[') && JSON.stringify(update[key]) === JSON.stringify(this.data[key])) delete update[key]
    }
    if (Object.keys(update).length) this.setData(update)
  },

  draftField(field) {
    return field && field.lazyConditional && this._conditionalDrafts && this._conditionalDrafts.get(field._uiKey) || field
  },

  draftFields() { return this.data.fields.map(field => this.draftField(field)) },

  onConditionalParentPageChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const field = this.data.fields[Number(event.currentTarget.dataset.index)]
    const direction = Number(event.currentTarget.dataset.direction)
    if (!field || !field.lazyConditional || ![-1, 1].includes(direction)) return
    const page = field.conditionalPage + direction
    if (page < 0 || page >= field.conditionalPageCount) return
    this._conditionalWindows.set(field._uiKey, { page, editingValue: null })
    this.refreshFields(this.draftFields())
  },

  onConditionalEditorOpen(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const field = this.data.fields[Number(event.currentTarget.dataset.index)]
    const value = event.currentTarget.dataset.parentValue
    if (!field || !field.lazyConditional || !field.conditionParentValueRows.some(row => row.value === value && row.visible)) return
    this._conditionalWindows.set(field._uiKey, { page: field.conditionalPage, editingValue: value })
    this.refreshFields(this.draftFields())
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
    const existing = context.node || {}
    this.allocateKey = createKeyAllocator([
      ...(context.nodeOptions || []).flatMap(item => [item.nodeKey, item._uiKey]),
      existing.nodeKey, existing._uiKey,
      ...(existing.fields || []).flatMap(field => [field.fieldKey, field.clientFieldKey, field._uiKey])
    ])
    const originalNode = context.node || newNode(versionTwo, this.allocateKey)
    try { validateLinkedNode(originalNode) } catch (error) {
      this.unavailable = true
      this.setData({ readOnly: true, errorMessage: error.message })
      return
    }
    const detached = detachNodeLinkage(originalNode)
    this._optionLinkage = detached.rule
    this._cardFields = clone(context.cardFields || [])
    const node = detached.node
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
    this.uiKey = node._uiKey || node.nodeKey || this.allocateKey('node')
    const nodeOptions = clone(context.nodeOptions || [])
    const targetOptions = [{ nodeKey: 'end', name: '结束售后' }, ...nodeOptions.filter(item => item.nodeKey !== node.nodeKey)]
    const fields = clone(node.fields || []).map((field, sequence) => this.decorateField(field, sequence, node.fields || []))
    const next = versionTwo && node.next ? clone(node.next) : { mode: 'end' }
    const routingFieldOptions = fields.filter(field => field.type === 'single_select' && field.required && !field.condition && !field.linked)
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
      linkageSummary: linkageSummary(fields, this._optionLinkage),
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

  isLinkedField(field) {
    return Boolean(field && this._optionLinkage && this._optionLinkage.fieldKeys.includes(fieldReference(field)))
  },

  blockLinkedField(index) {
    if (!this.isLinkedField(this.data.fields[index])) return false
    this.setData({ errorMessage: '商品联动成员不能单独修改、删除或重排，请使用结构化导入整体更新' })
    return true
  },

  canImportLinkage() {
    return this.requireSuperAdmin() && !this.data.readOnly && !this.committed && !this.data.submitting &&
      !(this.ownerPage && this.ownerPage.data && this.ownerPage.data.readOnly)
  },

  openLinkageImport() {
    if (this.canImportLinkage()) this.setData({ linkageImportOpen: true, linkageImportError: '' })
  },

  onLinkageImportInput(event) {
    if (!this.canImportLinkage()) return
    this._linkageImportText = event.detail.value
    this._validatedLinkageImport = null
    this._linkageTrial = null
    this.setData({ linkageImportPreview: null, linkageImportError: '',
      linkageTrialOpen: false, linkageTrialFields: [], linkageTrialComplete: false })
  },

  buildImportedNode(imported) {
    const context = this.ownerPage && typeof this.ownerPage.getNodeEditorContext === 'function'
      ? this.ownerPage.getNodeEditorContext(this.data.index) : null
    return applyOptionLinkageImport(this.buildNodeForSave(), imported, {
      versionTwo: this.data.flowSchemaVersion === 2, allocateKey: this.allocateKey,
      cardFields: context && context.cardFields || this._cardFields || []
    })
  },

  validateLinkageImport() {
    if (!this.canImportLinkage()) return
    this._validatedLinkageImport = null
    try {
      const imported = parseOptionLinkageImport(this._linkageImportText || '')
      this.buildImportedNode(imported)
      this._validatedLinkageImport = imported
      this.setData({ linkageImportPreview: imported.summary, linkageImportError: '' })
    } catch (error) {
      this.setData({ linkageImportPreview: null, linkageImportError: error.message })
    }
  },

  applyLinkageImport() {
    if (!this.canImportLinkage() || !this._validatedLinkageImport) return
    try {
      const importedNode = this.buildImportedNode(this._validatedLinkageImport)
      const detached = detachNodeLinkage(importedNode)
      const previousFields = new Map(this.draftFields().map(field => [field._uiKey, field]))
      this._optionLinkage = detached.rule
      this._validatedLinkageImport = null
      this._linkageImportText = ''
      this._linkageTrial = null
      // Import is not an ordinary field save: keep unrelated IME/delimiter drafts verbatim.
      const fields = detached.node.fields.map(field => !this.isLinkedField(field) && previousFields.has(field._uiKey)
        ? { ...previousFields.get(field._uiKey), sequence: field.sequence } : field)
      this.refreshFields(fields, { linkageImportOpen: false, linkageImportPreview: null,
        linkageTrialOpen: false, linkageTrialFields: [], linkageTrialComplete: false,
        linkageImportError: '', errorMessage: '商品联动已应用到节点草稿；保存节点后，还需保存模板才会生效' })
    } catch (error) { this.setData({ linkageImportError: error.message }) }
  },

  openLinkageTrial() {
    if (!this.requireSuperAdmin()) return
    const imported = this._validatedLinkageImport
    const rule = imported ? imported.optionLinkage : this._optionLinkage
    if (!rule) return
    const sourceFields = imported ? imported.fields : this.draftFields()
    // Trial definitions and selections are intentionally separate from both
    // the editable fields and the imported draft; never feed them to save.
    const fields = rule.fieldKeys.map((key, sequence) => {
      const field = sourceFields.find(item => fieldReference(item) === key)
      return { fieldKey: key, sequence, name: field.name, type: 'single_select', required: field.required,
        constraints: clone(field.constraints), ...(sequence === 0 ? { optionLinkage: clone(rule) } : {}) }
    })
    this._linkageTrial = { fields, context: buildOptionLinkageContext(fields), values: new Map() }
    this.refreshLinkageTrial({ linkageTrialOpen: true,
      linkageTrialSource: imported ? '已校验的待导入配置' : '当前节点商品联动' })
  },

  refreshLinkageTrial(extra = {}) {
    const trial = this._linkageTrial
    if (!trial) return
    const fields = []
    for (const field of trial.fields) {
      const effective = trial.context.project(field, trial.values)
      if (!effective) { trial.values.delete(field.fieldKey); continue }
      const options = effective.constraints.options
      if (!options.includes(trial.values.get(field.fieldKey))) trial.values.delete(field.fieldKey)
      const value = trial.values.get(field.fieldKey)
      fields.push({ fieldKey: field.fieldKey, name: field.name, options, choiceLabels: ['请选择', ...options],
        value: value === undefined ? '' : value, valueIndex: value === undefined ? -1 : options.indexOf(value) })
    }
    this.setData({ linkageTrialFields: fields,
      linkageTrialComplete: fields.length > 0 && fields.every(field => field.valueIndex >= 0), ...extra })
  },

  onLinkageTrialChange(event) {
    if (!this.requireSuperAdmin() || !this._linkageTrial || !this.data.linkageTrialOpen) return
    const trial = this._linkageTrial
    const field = trial.fields.find(item => item.fieldKey === event.currentTarget.dataset.fieldKey)
    const effective = field && trial.context.project(field, trial.values)
    const index = Number(event.detail.value) - 1
    if (!effective || !Number.isSafeInteger(index) || index < 0 || index >= effective.constraints.options.length) return
    trial.values.set(field.fieldKey, effective.constraints.options[index])
    this.refreshLinkageTrial()
  },

  resetLinkageTrial() {
    if (!this.requireSuperAdmin() || !this._linkageTrial || !this.data.linkageTrialOpen) return
    this._linkageTrial.values.clear()
    this.refreshLinkageTrial()
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
    if (this.blockLinkedField(index)) return
    const fields = this.draftFields()
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
    this.updateField(Number(event.currentTarget.dataset.index), { type, constraints, optionText: '', conditionalOptionTexts: {} })
  },
  onFieldConditionChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    if (this.blockLinkedField(index)) return
    const field = this.data.fields[index]
    if (!field) return
    if (!event.detail.value) {
      this.updateField(index, { condition: null, conditionEnabled: false, conditionalOptionTexts: {} })
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
    const parent = this.draftFields().find(item => item.fieldKey === parentFieldKey)
    const values = parent && parent.constraints && Array.isArray(parent.constraints.options)
      ? parent.constraints.options.slice() : []
    const field = this.draftField(this.data.fields[index])
    const condition = { parentFieldKey, visibleWhen: values }
    if (field && field.type === 'single_select' && !this.isLinkedField(parent)) {
      const options = field.constraints && Array.isArray(field.constraints.options) ? field.constraints.options.slice() : []
      condition.optionsByParentValue = Object.fromEntries(values.map(value => [value, options.slice()]))
    }
    this.updateField(index, { condition, conditionEnabled: true, conditionalOptionTexts: {} })
  },
  onFieldConditionParentChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    const field = this.data.fields[index]
    const parent = field && field.conditionParentOptions[Number(event.detail.value)]
    if (parent) this.setFieldParent(index, parent.fieldKey)
  },
  onFieldVisibleWhenChange(event) {
    const index = Number(event.currentTarget.dataset.index)
    const rendered = this.data.fields[index]
    const field = this.draftField(rendered)
    if (!field || !field.condition) return
    const pageValues = rendered.lazyConditional ? rendered.conditionParentValueRows.map(row => row.value) : []
    const visibleWhen = rendered.lazyConditional
      ? [...field.condition.visibleWhen.filter(value => !pageValues.includes(value)), ...event.detail.value.filter(value => pageValues.includes(value))]
      : event.detail.value.slice()
    const condition = { ...field.condition, visibleWhen }
    if (condition.optionsByParentValue) {
      condition.optionsByParentValue = Object.fromEntries(visibleWhen.map(value => [
        value, condition.optionsByParentValue[value] || (field.constraints.options || []).slice()
      ]))
    }
    const conditionalOptionTexts = Object.fromEntries(Object.entries(field.conditionalOptionTexts || {})
      .filter(([value]) => visibleWhen.includes(value)))
    this.updateField(index, { condition, conditionalOptionTexts })
  },
  onFieldConditionalOptionsInput(event) {
    const index = Number(event.currentTarget.dataset.index)
    const parentValue = event.currentTarget.dataset.parentValue
    const rendered = this.data.fields[index]
    const field = this.draftField(rendered)
    if (!field || !field.condition || field.type !== 'single_select') return
    if (!rendered.conditionParentValueRows.some(row => row.value === parentValue && row.visible && (!rendered.lazyConditional || row.editing))) return
    this.updateField(index, {
      // Keep the editing buffer separate from canonical options: incomplete words,
      // IME text and delimiters must not be replaced by filtered values on input.
      conditionalOptionTexts: { ...(field.conditionalOptionTexts || {}), [parentValue]: event.detail.value }
    })
  },
  onFieldOptionsInput(event) {
    const index = Number(event.currentTarget.dataset.index)
    const field = this.draftField(this.data.fields[index])
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
    const field = this.draftField(this.data.fields[index])
    if (field) this.updateField(index, { constraints: { ...field.constraints, [name]: event.detail.value } })
  },
  updateTextConstraint(event, name) { this.updateRawConstraint(event, name) },
  updateNumberConstraint(event, name) { this.updateRawConstraint(event, name) },

  addField() {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    this.refreshFields(this.data.fields.concat({
      ...newField(this.data.flowSchemaVersion === 2, this.allocateKey), sequence: this.data.fields.length
    }))
  },
  removeField(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.fields.length) return
    if (this.blockLinkedField(index)) return
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
    if (this.blockLinkedField(index) || this.blockLinkedField(target)) return
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

  fieldsForSave() {
    // Reconcile only at the save boundary: partial parent-option input must not
    // erase dependent configuration that may become valid again while typing.
    return this.draftFields().map((field, index, fields) => {
      if (!field.condition) return field
      const parents = fields.filter(item => item.fieldKey === field.condition.parentFieldKey)
      const parent = parents.length === 1 ? parents[0] : null
      if (!parent || fields.indexOf(parent) >= index || parent.type !== 'single_select') return field
      const options = new Set(parent.constraints.options || [])
      const visibleWhen = field.condition.visibleWhen.filter(value => options.has(value))
      const condition = { ...field.condition, visibleWhen }
      if (condition.optionsByParentValue) {
        condition.optionsByParentValue = Object.fromEntries(Object.entries(condition.optionsByParentValue)
          .filter(([value]) => options.has(value)))
      }
      return {
        ...field,
        condition,
        conditionalOptionTexts: Object.fromEntries(Object.entries(field.conditionalOptionTexts || {})
          .filter(([value]) => options.has(value)))
      }
    })
  },

  normalizedField(field, sequence) {
    field = this.draftField(field)
    const normalized = {
      _uiKey: field._uiKey || this.allocateKey('field'),
      ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
      ...(field.clientFieldKey ? { clientFieldKey: field.clientFieldKey } : {}),
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
      normalized.constraints.options = this.isLinkedField(field) ? constraints.options.slice()
        : uniqueTexts(constraints.options && constraints.options.join ? constraints.options.join(',') : constraints.options)
    }
    if (this.isLinkedField(field)) {
      if (fieldReference(field) === this._optionLinkage.fieldKeys[0]) normalized.optionLinkage = clone(this._optionLinkage)
    } else if (field.condition) {
      normalized.condition = clone(field.condition)
      if (field.type === 'single_select' && field.conditionalOptionTexts &&
          field.condition.visibleWhen.some(value => hasOwn(field.conditionalOptionTexts, value))) {
        const hasExplicitMapping = hasOwn(normalized.condition, 'optionsByParentValue')
        const mapping = { ...(normalized.condition.optionsByParentValue || {}) }
        for (const value of field.condition.visibleWhen) {
          if (hasOwn(field.conditionalOptionTexts, value)) mapping[value] = uniqueTexts(field.conditionalOptionTexts[value])
          else if (!hasExplicitMapping) mapping[value] = normalized.constraints.options.slice()
        }
        normalized.condition.optionsByParentValue = mapping
      }
    }
    return normalized
  },

  conditionalOptionsError(fields = this.fieldsForSave().map((field, sequence) => this.normalizedField(field, sequence))) {
    for (const [index, field] of fields.entries()) {
      if (!field.condition) continue
      const parents = fields.filter(item => item.fieldKey === field.condition.parentFieldKey)
      const parent = parents.length === 1 ? parents[0] : null
      if (!parent || fields.indexOf(parent) >= index || parent.type !== 'single_select') {
        return `字段「${field.name || '未命名字段'}」的父字段必须是唯一的前置单选字段，请重新配置显示条件`
      }
      if (!field.condition.visibleWhen.length) {
        return `字段「${field.name || '未命名字段'}」的显示条件没有有效父选项，请至少选择一个当前父选项`
      }
      if (!field.condition.optionsByParentValue) continue
      if (field.type !== 'single_select') {
        return `字段「${field.name || '未命名字段'}」只有单选字段才能配置条件候选项，请重新配置显示条件`
      }
      const extraValue = Object.keys(field.condition.optionsByParentValue)
        .find(value => !field.condition.visibleWhen.includes(value))
      if (extraValue !== undefined) {
        return `字段「${field.name || '未命名字段'}」在未选择的父选项「${extraValue}」下仍有候选项配置，请重新配置显示条件`
      }
      const allowed = new Set(field.constraints.options || [])
      for (const value of field.condition.visibleWhen) {
        const options = field.condition.optionsByParentValue[value] || []
        if (!options.length || options.some(option => !allowed.has(option))) {
          return `字段「${field.name || '未命名字段'}」在「${value}」下的可选项未填完整或不在本字段选项中，请检查后保存`
        }
      }
    }
    return ''
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
    const fields = this.fieldsForSave().map((field, sequence) => this.normalizedField(field, sequence))
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
    validateLinkedNode(node)
    return node
  },

  async submit() {
    if (!this.requireSuperAdmin() || this.unavailable || this.data.readOnly || this.committed || this.data.submitting) return
    let node
    try { node = this.buildNodeForSave() } catch (error) {
      this.setData({ errorMessage: error.message })
      return
    }
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
    const conditionalError = this.conditionalOptionsError(node.fields)
    if (conditionalError) {
      this.setData({ errorMessage: conditionalError })
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
      this.refreshFields(this.fieldsForSave())
      wx.navigateBack({ delta: 1 })
    } catch (error) {
      this.committed = false
      this.setData({ submitting: false, errorMessage: '保存节点失败，请重试' })
    }
  }
})

module.exports = { FIELD_TYPE_OPTIONS }
