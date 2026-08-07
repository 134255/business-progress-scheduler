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
    constraints: clone(field.constraints || {})
  }
}

function cleanNode(node, sequence) {
  return {
    ...(node.nodeKey ? { nodeKey: node.nodeKey } : {}),
    sequence,
    name: node.name,
    description: node.description || '',
    assigneeUserIds: (node.assigneeUserIds || []).slice(),
    slaWorkHours: node.slaWorkHours,
    requiresEvidence: Boolean(node.requiresEvidence),
    allowedEvidenceTypes: (node.allowedEvidenceTypes || []).slice(),
    fields: (node.fields || []).map(cleanField)
  }
}

function messageFor(error) {
  if (error && error.code === 'VERSION_CONFLICT') return '模板已被其他管理员更新，已刷新为最新版本'
  if (error && error.code === 'TEMPLATE_NOT_EDITABLE') return '启用中的模板为只读，请先停用模板'
  if (error && error.code === 'ASSIGNEE_INACTIVE') return '节点负责人已停用，请重新选择启用账号'
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
      await this.loadActiveAccounts()
      if (templateId) await this.loadTemplate()
    } catch (error) {
      this.unavailable = true
      this.setData({ errorMessage: messageFor(error) })
    } finally {
      this.setData({ loading: false })
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
    const items = []
    let page = 1
    let hasMore = true
    while (hasMore) {
      const result = await adminUsers.listUsers({ status: 'active', keyword: '', page, pageSize: 100 })
      items.push(...(result.items || []))
      hasMore = Boolean(result.hasMore)
      page += 1
    }
    this.setData({ assigneeOptions: items })
  },

  async loadTemplate() {
    const definition = await templates.getTemplate(this.data.templateId)
    const template = definition.template
    const readOnly = template.status === 'enabled'
    this.setData({
      name: template.name,
      description: template.description || '',
      status: template.status,
      version: template.version,
      nodes: withNodeUiKeys(orderedNodes(clone(definition.nodes || []))),
      readOnly
    })
    return definition
  },

  onNameInput(event) {
    if (!this.data.readOnly) this.setData({ name: event.detail.value })
  },

  onDescriptionInput(event) {
    if (!this.data.readOnly) this.setData({ description: event.detail.value })
  },

  getNodeEditorContext(index) {
    const node = Number.isInteger(index) && index >= 0 ? this.data.nodes[index] : null
    return {
      readOnly: this.data.readOnly,
      assigneeOptions: clone(this.data.assigneeOptions),
      node: node ? clone(node) : null
    }
  },

  openNodeEditor(event) {
    const raw = event && event.currentTarget && event.currentTarget.dataset.index
    const index = raw === undefined ? -1 : Number(raw)
    wx.navigateTo({ url: `/pages/admin-template-node-edit/index?index=${Number.isInteger(index) ? index : -1}` })
  },

  acceptNodeFromEditor(index, node) {
    if (this.data.readOnly || !node) return
    const nodes = this.data.nodes.slice()
    if (Number.isInteger(index) && index >= 0 && index < nodes.length) nodes[index] = clone(node)
    else nodes.push(clone(node))
    this.setData({ nodes: withNodeUiKeys(orderedNodes(nodes)), errorMessage: '' })
  },

  removeNode(event) {
    if (this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.nodes.length) return
    const nodes = this.data.nodes.slice()
    nodes.splice(index, 1)
    this.setData({ nodes: orderedNodes(nodes) })
  },

  moveNode(event) {
    if (this.data.readOnly) return
    const index = Number(event.currentTarget.dataset.index)
    const direction = Number(event.currentTarget.dataset.direction)
    const target = index + direction
    if (!Number.isInteger(index) || ![-1, 1].includes(direction) || target < 0 || target >= this.data.nodes.length) return
    const nodes = this.data.nodes.slice()
    ;[nodes[index], nodes[target]] = [nodes[target], nodes[index]]
    this.setData({ nodes: orderedNodes(nodes) })
  },

  definition() {
    return {
      name: this.data.name.trim(),
      description: this.data.description.trim(),
      nodes: this.data.nodes.map(cleanNode)
    }
  },

  async submit() {
    if (this.unavailable || this.data.loading || this.data.submitting || this.data.readOnly) return
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
      if (this.data.editMode) {
        await templates.updateTemplate(this.data.templateId, this.data.version, definition)
      } else {
        await templates.createTemplate(definition)
      }
      wx.showToast({ title: '保存成功', icon: 'success' })
      wx.navigateBack({ delta: 1 })
    } catch (error) {
      const message = messageFor(error)
      if (error && error.code === 'VERSION_CONFLICT' && this.data.editMode) {
        try { await this.loadTemplate() } catch (reloadError) { this.unavailable = true }
      }
      this.setData({ errorMessage: message })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async changeStatus(nextStatus) {
    if (!this.data.editMode || this.data.loading || this.data.submitting) return
    this.setData({ submitting: true, errorMessage: '' })
    try {
      await templates.changeTemplateStatus(this.data.templateId, this.data.version, nextStatus)
      await this.loadTemplate()
      wx.showToast({ title: nextStatus === 'enabled' ? '模板已启用' : '模板已停用', icon: 'success' })
    } catch (error) {
      const message = messageFor(error)
      if (error && error.code === 'VERSION_CONFLICT') {
        try { await this.loadTemplate() } catch (reloadError) { this.unavailable = true }
      }
      this.setData({ errorMessage: message })
    } finally {
      this.setData({ submitting: false })
    }
  },

  enableTemplate() { return this.changeStatus('enabled') },
  disableTemplate() { return this.changeStatus('disabled') }
})
