const templates = require('../../services/templates')
const adminUsers = require('../../services/admin-users')

let uiKeySequence = 0
function nextUiKey(prefix) {
  uiKeySequence += 1
  return `${prefix}-ui-${uiKeySequence}`
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function decode(value) {
  if (typeof value !== 'string') return ''
  try { return decodeURIComponent(value) } catch (error) { return '' }
}

function orderedNodes(nodes) {
  return nodes.map((node, sequence) => ({
    ...node,
    sequence,
    fields: (node.fields || []).map((field, fieldSequence) => ({ ...field, sequence: fieldSequence }))
  }))
}

function withNodeUiKeys(nodes) {
  return nodes.map(node => ({ ...node, _uiKey: node._uiKey || node.nodeKey || nextUiKey('node') }))
}

function cleanField(field, sequence) {
  return {
    ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
    sequence,
    name: field.name,
    description: field.description || '',
    type: field.type,
    required: Boolean(field.required),
    constraints: clone(field.constraints || {}),
    ...(field.condition ? { condition: clone(field.condition) } : {})
  }
}

function cleanNode(node, sequence) {
  const isLegacyNode = !hasOwn(node, 'workflowMode')
  const versionTwo = Boolean(node.next)
  return {
    ...(node.nodeKey ? { nodeKey: node.nodeKey } : {}),
    sequence,
    name: node.name,
    description: node.description || '',
    workflowMode: 'review',
    activationMode: !isLegacyNode && node.activationMode === 'optional_tail' ? 'optional_tail' : 'required',
    processorAssignmentMode: versionTwo ? 'fixed_accounts' : !isLegacyNode && node.processorAssignmentMode === 'business_creator'
      ? 'business_creator'
      : 'fixed_accounts',
    processorUserIds: (isLegacyNode ? node.assigneeUserIds : node.processorUserIds || []).slice(),
    reviewerAssignmentMode: !isLegacyNode && node.reviewerAssignmentMode === 'business_creator'
      ? 'business_creator'
      : 'fixed_accounts',
    reviewerUserIds: (isLegacyNode ? [] : node.reviewerUserIds || []).slice(),
    ...(versionTwo ? {
      includeBusinessCreatorAsProcessor: node.includeBusinessCreatorAsProcessor === true,
      next: clone(node.next)
    } : {}),
    reviewMode: !isLegacyNode && node.reviewMode === 'all' ? 'all' : 'any',
    processingSlaWorkHours: !isLegacyNode && node.processingSlaWorkHours !== undefined ? node.processingSlaWorkHours : 22,
    reviewSlaWorkHours: !isLegacyNode && node.reviewSlaWorkHours !== undefined ? node.reviewSlaWorkHours : 8,
    requiresEvidence: Boolean(node.requiresEvidence),
    allowedEvidenceTypes: (node.allowedEvidenceTypes || []).slice(),
    fields: (node.fields || []).map(cleanField)
  }
}

function messageFor(error) {
  if (error && error.code === 'VERSION_CONFLICT') return '模板已被其他管理员更新，已刷新为最新版本'
  if (error && error.code === 'TEMPLATE_NOT_EDITABLE') return '启用中的模板为只读，请先停用模板'
  if (error && error.code === 'PROCESSOR_INACTIVE') return '节点处理人已停用，请重新选择启用账号'
  if (error && error.code === 'REVIEWER_INACTIVE') return '节点审核人已停用，请重新选择启用账号'
  if (error && error.code === 'ROLE_OVERLAP') return '同一节点的处理人与审核人不能使用同一账号'
  if (error && error.code === 'TEMPLATE_INVALID') return '模板定义不完整，请检查节点、字段和负责人'
  return error && error.message ? error.message : '网络异常，请稍后重试'
}

Page({
  data: {
    editMode: false,
    templateId: '',
    loading: false,
    submitting: false,
    name: '',
    description: '',
    status: 'draft',
    version: 0,
    flowSchemaVersion: 2,
    entryNodeKey: '',
    nodes: [],
    assigneeOptions: [],
    readOnly: false,
    errorMessage: ''
  },

  async onLoad(options = {}) {
    if (!this.requireSuperAdmin()) return
    const templateId = decode(options.id)
    this.setData({ editMode: Boolean(templateId), templateId })
    wx.setNavigationBarTitle({ title: templateId ? '编辑模板' : '新建模板' })
    this.setData({ loading: true })
    try {
      if (!await this.loadActiveAccounts()) return
      if (templateId) await this.loadTemplate()
    } catch (error) {
      if (!this.requireSuperAdmin()) return
      this.unavailable = true
      this.setData({ errorMessage: messageFor(error) })
    } finally {
      if (this.requireSuperAdmin()) this.setData({ loading: false })
    }
  },

  requireSuperAdmin() {
    const currentUser = getApp().globalData.currentUser
    if (currentUser && currentUser.role === 'super_admin' && currentUser.status === 'active') return true
    this.unavailable = true
    wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
    return false
  },

  async loadActiveAccounts() {
    if (!this.requireSuperAdmin()) return false
    const items = []
    let page = 1
    let hasMore = true
    while (hasMore) {
      if (!this.requireSuperAdmin()) return false
      const result = await adminUsers.listUsers({ status: 'active', keyword: '', page, pageSize: 100 })
      if (!this.requireSuperAdmin()) return false
      items.push(...(result.items || []))
      hasMore = Boolean(result.hasMore)
      page += 1
    }
    if (!this.requireSuperAdmin()) return false
    this.setData({ assigneeOptions: items })
    return true
  },

  async loadTemplate() {
    if (!this.requireSuperAdmin()) return null
    const definition = await templates.getTemplate(this.data.templateId)
    if (!this.requireSuperAdmin()) return null
    const template = definition.template
    const readOnly = template.status === 'enabled'
    this.setData({
      name: template.name,
      description: template.description || '',
      status: template.status,
      version: template.version,
      flowSchemaVersion: template.flowSchemaVersion === 2 ? 2 : 1,
      entryNodeKey: template.flowSchemaVersion === 2 ? template.entryNodeKey : '',
      nodes: withNodeUiKeys(orderedNodes(clone(definition.nodes || []))),
      readOnly
    })
    return definition
  },

  onNameInput(event) {
    if (this.requireSuperAdmin() && !this.data.readOnly) this.setData({ name: event.detail.value })
  },

  onDescriptionInput(event) {
    if (this.requireSuperAdmin() && !this.data.readOnly) this.setData({ description: event.detail.value })
  },

  getNodeEditorContext(index) {
    const node = Number.isInteger(index) && index >= 0 ? this.data.nodes[index] : null
    return {
      readOnly: this.data.readOnly,
      assigneeOptions: clone(this.data.assigneeOptions),
      node: node ? clone(node) : null,
      flowSchemaVersion: this.data.flowSchemaVersion,
      nodeOptions: this.data.nodes.map(item => ({ nodeKey: item.nodeKey || item._uiKey, name: item.name || '未命名节点' })),
      optionalTailExistsOutsideCurrentNode: this.data.nodes.some((item, itemIndex) =>
        itemIndex !== index && item.activationMode === 'optional_tail')
    }
  },

  openNodeEditor(event) {
    if (!this.requireSuperAdmin()) return
    const raw = event && event.currentTarget && event.currentTarget.dataset.index
    const index = raw === undefined ? -1 : Number(raw)
    const safeIndex = Number.isInteger(index) ? index : -1
    const optionalTailExistsOutsideCurrentNode = this.data.nodes.some((node, nodeIndex) =>
      nodeIndex !== safeIndex && node.activationMode === 'optional_tail')
    wx.navigateTo({
      url: `/pages/admin-template-node-edit/index?index=${safeIndex}&optionalTailExistsOutsideCurrentNode=${optionalTailExistsOutsideCurrentNode ? '1' : '0'}`
    })
  },

  acceptNodeFromEditor(index, node) {
    if (!this.requireSuperAdmin() || this.data.readOnly || !node) return
    const nodes = this.data.nodes.slice()
    if (this.data.flowSchemaVersion === 2 && !node.nodeKey) node.nodeKey = node._uiKey || nextUiKey('node')
    if (this.data.flowSchemaVersion === 2 && !node.next) node.next = { mode: 'end' }
    if (this.data.flowSchemaVersion !== 2 && node.activationMode === 'optional_tail' && nodes.some((item, itemIndex) =>
      itemIndex !== index && item.activationMode === 'optional_tail')) {
      this.setData({ errorMessage: '每个模板只能设置一个可选追加节点' })
      return
    }
    if (Number.isInteger(index) && index >= 0 && index < nodes.length) nodes[index] = clone(node)
    else nodes.push(clone(node))
    const ordered = orderedNodes(nodes)
    const optionalIndex = this.data.flowSchemaVersion === 2 ? -1 : ordered.findIndex(item => item.activationMode === 'optional_tail')
    if (optionalIndex >= 0 && optionalIndex !== ordered.length - 1) {
      const [optionalTail] = ordered.splice(optionalIndex, 1)
      ordered.push(optionalTail)
    }
    const keyed = withNodeUiKeys(orderedNodes(ordered))
    this.setData({
      nodes: keyed,
      entryNodeKey: this.data.entryNodeKey || (keyed[0] && (keyed[0].nodeKey || keyed[0]._uiKey)) || '',
      errorMessage: ''
    })
  },

  removeNode(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.nodes.length) return
    const selected = this.data.nodes[index]
    const key = selected.nodeKey || selected._uiKey
    if (this.data.flowSchemaVersion === 2 && this.data.nodes.some((node, nodeIndex) =>
      nodeIndex !== index && JSON.stringify(node.next || {}).includes(`\"${key}\"`))) {
      this.setData({ errorMessage: '该节点仍被其他节点的后续规则引用，请先调整分支' })
      return
    }
    const nodes = this.data.nodes.slice()
    nodes.splice(index, 1)
    this.setData({
      nodes: orderedNodes(nodes),
      entryNodeKey: this.data.entryNodeKey === key
        ? ((nodes[0] && (nodes[0].nodeKey || nodes[0]._uiKey)) || '')
        : this.data.entryNodeKey,
      errorMessage: ''
    })
  },

  moveNode(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    const direction = Number(event.currentTarget.dataset.direction)
    const target = index + direction
    if (!Number.isInteger(index) || ![-1, 1].includes(direction) || target < 0 || target >= this.data.nodes.length) return
    const nodes = this.data.nodes.slice()
    if (this.data.flowSchemaVersion !== 2 &&
        (nodes[index].activationMode === 'optional_tail' || nodes[target].activationMode === 'optional_tail')) {
      this.setData({ errorMessage: '可选追加节点必须位于模板最后' })
      return
    }
    ;[nodes[index], nodes[target]] = [nodes[target], nodes[index]]
    this.setData({ nodes: orderedNodes(nodes) })
  },

  definition() {
    const definition = {
      name: this.data.name.trim(),
      description: this.data.description.trim(),
      nodes: this.data.nodes.map(cleanNode)
    }
    if (this.data.flowSchemaVersion === 2) {
      definition.flowSchemaVersion = 2
      definition.entryNodeKey = this.data.entryNodeKey
    }
    return definition
  },

  onEntryNodeChange(event) {
    if (!this.requireSuperAdmin() || this.data.readOnly || this.data.flowSchemaVersion !== 2) return
    const node = this.data.nodes[Number(event.detail.value)]
    if (node) this.setData({ entryNodeKey: node.nodeKey || node._uiKey, errorMessage: '' })
  },

  openFlowPreview() {
    if (!this.requireSuperAdmin() || !this.data.editMode || !this.data.templateId) return
    wx.navigateTo({ url: `/pages/admin-template-flow/index?id=${encodeURIComponent(this.data.templateId)}` })
  },

  async submit() {
    if (!this.requireSuperAdmin() || this.unavailable || this.data.loading || this.data.submitting || this.data.readOnly) return
    const definition = this.definition()
    if (!definition.name) {
      this.setData({ errorMessage: '请填写模板名称' })
      return
    }
    if (!definition.nodes.length) {
      this.setData({ errorMessage: '请至少添加一个节点' })
      return
    }
    this.setData({ submitting: true, errorMessage: '' })
    try {
      if (!this.requireSuperAdmin()) return
      if (this.data.editMode) {
        await templates.updateTemplate(this.data.templateId, this.data.version, definition)
      } else {
        await templates.createTemplate(definition)
      }
      if (!this.requireSuperAdmin()) return
      wx.showToast({ title: '保存成功', icon: 'success' })
      if (!this.requireSuperAdmin()) return
      wx.navigateBack({ delta: 1 })
    } catch (error) {
      if (!this.requireSuperAdmin()) return
      const message = messageFor(error)
      if (error && error.code === 'VERSION_CONFLICT' && this.data.editMode) {
        try { await this.loadTemplate() } catch (reloadError) { this.unavailable = true }
        if (!this.requireSuperAdmin()) return
      }
      this.setData({ errorMessage: message })
    } finally {
      if (this.requireSuperAdmin()) this.setData({ submitting: false })
    }
  },

  async changeStatus(nextStatus) {
    if (!this.requireSuperAdmin() || !this.data.editMode || this.data.loading || this.data.submitting) return
    this.setData({ submitting: true, errorMessage: '' })
    try {
      if (!this.requireSuperAdmin()) return
      await templates.changeTemplateStatus(this.data.templateId, this.data.version, nextStatus)
      if (!this.requireSuperAdmin()) return
      await this.loadTemplate()
      if (!this.requireSuperAdmin()) return
      wx.showToast({ title: nextStatus === 'enabled' ? '模板已启用' : '模板已停用', icon: 'success' })
    } catch (error) {
      if (!this.requireSuperAdmin()) return
      const message = messageFor(error)
      if (error && error.code === 'VERSION_CONFLICT') {
        try { await this.loadTemplate() } catch (reloadError) { this.unavailable = true }
        if (!this.requireSuperAdmin()) return
      }
      this.setData({ errorMessage: message })
    } finally {
      if (this.requireSuperAdmin()) this.setData({ submitting: false })
    }
  },

  enableTemplate() { return this.changeStatus('enabled') },
  disableTemplate() { return this.changeStatus('disabled') }
})
