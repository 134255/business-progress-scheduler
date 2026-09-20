const templates = require('../../services/templates')
const adminUsers = require('../../services/admin-users')
const { createKeyAllocator } = require('../../utils/template-editor-keys')
const { templateDefinitionIssue } = require('../../utils/template-definition-diagnostics')
const { presentBusinessCard } = require('../../utils/business-card')
const { isAccountAccessError } = require('../../utils/safe-error')
const { validateLinkedNode, detachNodeLinkage, attachNodeLinkage } = require('../../utils/option-linkage-import')

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
  const allocateKey = createKeyAllocator(nodes.flatMap(node => [node.nodeKey, node._uiKey]))
  return nodes.map(node => ({ ...node, _uiKey: node._uiKey || node.nodeKey || allocateKey('node') }))
}

function cleanField(field, sequence) {
  return {
    ...(field.fieldKey ? { fieldKey: field.fieldKey } : {}),
    ...(field.clientFieldKey ? { clientFieldKey: field.clientFieldKey } : {}),
    sequence,
    name: field.name,
    description: field.description || '',
    type: field.type,
    required: Boolean(field.required),
    constraints: clone(field.constraints || {}),
    ...(field.condition ? { condition: clone(field.condition) } : {}),
    ...(hasOwn(field, 'optionLinkage') ? { optionLinkage: clone(field.optionLinkage) } : {})
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
  if (error && error.code === 'CARD_DISPLAY_INVALID') return '请先调整售后卡片展示配置，再删除引用的节点或字段；展示字段须来自已保存的定义'
  if (error && error.code === 'VERSION_CONFLICT') return '模板已被其他管理员更新，已刷新为最新版本'
  if (error && error.code === 'TEMPLATE_NOT_EDITABLE') return '启用中的模板为只读，请先停用模板'
  if (error && error.code === 'PROCESSOR_INACTIVE') return '节点处理人已停用，请重新选择启用账号'
  if (error && error.code === 'REVIEWER_INACTIVE') return '节点审核人已停用，请重新选择启用账号'
  if (error && error.code === 'ROLE_OVERLAP') return '同一节点的处理人与审核人不能使用同一账号'
  if (error && error.code === 'TEMPLATE_INVALID') return '模板定义不完整，请检查节点、字段和负责人'
  return error && error.message ? error.message : '网络异常，请稍后重试'
}

function cardMessage(error) {
  if (error && error.code === 'CARD_DISPLAY_INVALID') return messageFor(error)
  if (error && error.code === 'VERSION_CONFLICT') return '展示配置已被其他管理员更新，请核对最新配置后重试'
  if (isAccountAccessError(error)) return '当前账号无权编辑展示配置，请重新登录后重试'
  return '展示配置加载或保存失败，请重试；未保存的流程定义不受影响'
}

function cardRowId(nodeKey, fieldKey) { return JSON.stringify([nodeKey, fieldKey]) }

function savedCardNodes(definition) {
  return (definition.nodes || []).filter(node => typeof node.nodeKey === 'string' && node.nodeKey).map(node => ({
    nodeKey: node.nodeKey, name: node.name,
    fields: (node.fields || []).filter(field => typeof field.fieldKey === 'string' && field.fieldKey)
      .map(field => ({ fieldKey: field.fieldKey, name: field.name }))
  }))
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
    errorMessage: '',
    cardLoading: false,
    cardSubmitting: false,
    cardLoaded: false,
    cardError: '',
    cardRevision: 0,
    cardFields: [],
    cardNodeOptions: [],
    cardFieldOptions: [],
    cardNodeIndex: 0,
    cardFieldIndex: -1,
    cardPreview: null
  },

  async onLoad(options = {}) {
    if (!this.requireSuperAdmin()) return
    this._cardOwnerId = getApp().globalData.currentUser._id
    this._cardSequence = 0
    this._cardDisposed = false
    const templateId = decode(options.id)
    this.setData({ editMode: Boolean(templateId), templateId })
    wx.setNavigationBarTitle({ title: templateId ? '编辑模板' : '新建模板' })
    this.setData({ loading: true })
    try {
      if (!await this.loadActiveAccounts()) return
      if (templateId) {
        const definition = await this.loadTemplate()
        if (definition) await this.loadCardDisplay(definition)
      }
    } catch (error) {
      if (!this.requireSuperAdmin()) return
      this.unavailable = true
      this.setData({ errorMessage: messageFor(error) })
    } finally {
      if (this.requireSuperAdmin()) this.setData({ loading: false })
    }
  },

  onShow() {
    if (!this.data.editMode || !this._cardOwnerId) return
    if (!this.requireCardAdmin()) return
    if (this._cardInterrupted) {
      this._cardInterrupted = false
      return this.loadCardDisplay()
    }
  },

  onHide() {
    this._cardInterrupted = this.data.cardLoading || this.data.cardSubmitting
    this._cardSequence = (this._cardSequence || 0) + 1
    this.setData({ cardLoading: false, cardSubmitting: false,
      ...(this._cardInterrupted ? { cardLoaded: false } : {}) })
  },

  onUnload() {
    this._cardDisposed = true
    this.clearCardEditor()
  },

  clearCardEditor() {
    this._cardSequence = (this._cardSequence || 0) + 1
    this._cardSavedNodes = []
    this.setData({ cardFields: [], cardNodeOptions: [], cardFieldOptions: [], cardPreview: null,
      cardRevision: 0, cardLoading: false, cardSubmitting: false, cardLoaded: false })
  },

  requireCardAdmin() {
    const actor = getApp().globalData.currentUser
    if (!this._cardDisposed && this._cardOwnerId && actor && actor._id === this._cardOwnerId &&
        actor.role === 'super_admin' && actor.status === 'active') return true
    this.clearCardEditor()
    return false
  },

  acceptCardResponse(sequence) {
    return this.requireCardAdmin() && sequence === this._cardSequence
  },

  canEditCard() {
    return this.requireCardAdmin() && this.data.editMode && this.data.cardLoaded &&
      !this.data.cardLoading && !this.data.cardSubmitting
  },

  setCardFields(fields, revision = this.data.cardRevision) {
    const rows = fields.map(field => {
      const node = (this._cardSavedNodes || []).find(node => node.nodeKey === field.nodeKey)
      const saved = node && node.fields.find(item => item.fieldKey === field.fieldKey)
      if (!saved) throw Object.assign(new Error('CARD_DISPLAY_INVALID'), { code: 'CARD_DISPLAY_INVALID' })
      return { nodeKey: node.nodeKey, fieldKey: saved.fieldKey, id: cardRowId(node.nodeKey, saved.fieldKey),
        label: saved.name, nodeName: node.name }
    })
    this.setData({ cardFields: rows, cardPreview: presentBusinessCard({
      code: 'BL-DEMO-0001', status: 'active', cardSummary: { state: 'ready', configRevision: revision,
        fields: rows.map(row => ({ id: row.id, label: row.label, value: '示例内容' })) }
    }) })
  },

  applyCardConfig(config) {
    const unique = new Set()
    if (!config || config.templateId !== this.data.templateId || !Number.isSafeInteger(config.revision) ||
        config.revision < 0 || !Array.isArray(config.fields) || config.fields.length > 4 ||
        !config.fields.every(field => {
          if (!field || typeof field.nodeKey !== 'string' || typeof field.fieldKey !== 'string') return false
          const id = cardRowId(field.nodeKey, field.fieldKey)
          if (unique.has(id)) return false
          unique.add(id)
          return true
        })) throw Object.assign(new Error('CARD_DISPLAY_INVALID'), { code: 'CARD_DISPLAY_INVALID' })
    this.setCardFields(config.fields, config.revision)
    this._savedCardFields = clone(config.fields)
    this.setData({ cardRevision: config.revision, cardLoaded: true })
  },

  async loadCardDisplay(savedDefinition) {
    if (!this.data.editMode || !this.requireCardAdmin() || this.data.cardSubmitting) return
    const sequence = ++this._cardSequence
    this.setData({ cardLoading: true, cardLoaded: false, cardError: '' })
    try {
      const [definition, config] = await Promise.all([
        savedDefinition && savedDefinition.template && Array.isArray(savedDefinition.nodes)
          ? savedDefinition : templates.getTemplate(this.data.templateId),
        templates.getTemplateCardDisplay(this.data.templateId)
      ])
      if (!this.acceptCardResponse(sequence)) return
      // These choices deliberately never come from mutable this.data.nodes.
      this._cardSavedNodes = savedCardNodes(definition)
      this.setData({ cardNodeOptions: this._cardSavedNodes.map(({ nodeKey, name }) => ({ nodeKey, name })),
        cardNodeIndex: 0, cardFieldIndex: -1, cardFieldOptions: this._cardSavedNodes[0] ? this._cardSavedNodes[0].fields : [] })
      this.applyCardConfig(config)
    } catch (error) {
      if (!this.acceptCardResponse(sequence)) return
      if (isAccountAccessError(error)) this.clearCardEditor()
      this.setData({ cardError: cardMessage(error) })
    } finally {
      if (this.acceptCardResponse(sequence)) this.setData({ cardLoading: false })
    }
  },

  onCardNodeChange(event) {
    if (!this.canEditCard()) return
    const index = Number(event.detail.value)
    const node = Number.isInteger(index) && (this._cardSavedNodes || [])[index]
    if (node) this.setData({ cardNodeIndex: index, cardFieldIndex: -1, cardFieldOptions: node.fields })
  },

  onCardFieldChange(event) {
    if (!this.canEditCard()) return
    const index = Number(event.detail.value)
    this.setData({ cardFieldIndex: Number.isInteger(index) && this.data.cardFieldOptions[index] ? index : -1 })
  },

  addCardField() {
    if (!this.canEditCard()) return
    const node = this._cardSavedNodes[this.data.cardNodeIndex]
    const field = node && node.fields[this.data.cardFieldIndex]
    if (!field) return
    if (this.data.cardFields.length >= 4) { this.setData({ cardError: '最多选择 4 个展示字段' }); return }
    const id = cardRowId(node.nodeKey, field.fieldKey)
    if (this.data.cardFields.some(row => row.id === id)) { this.setData({ cardError: '该字段已在展示配置中' }); return }
    this.setCardFields([...this.data.cardFields, { nodeKey: node.nodeKey, fieldKey: field.fieldKey }])
    this.setData({ cardError: '' })
  },

  moveCardField(event) {
    if (!this.canEditCard()) return
    const { id, direction } = event.currentTarget.dataset
    const index = this.data.cardFields.findIndex(row => row.id === id)
    const step = Number(direction), target = index + step
    if (index < 0 || ![-1, 1].includes(step) || target < 0 || target >= this.data.cardFields.length) return
    const fields = this.data.cardFields.slice()
    ;[fields[index], fields[target]] = [fields[target], fields[index]]
    this.setCardFields(fields)
  },

  removeCardField(event) {
    if (this.canEditCard()) this.setCardFields(this.data.cardFields.filter(row => row.id !== event.currentTarget.dataset.id))
  },

  clearCardFields() { if (this.canEditCard()) this.setCardFields([]) },

  async saveCardDisplay() {
    if (!this.canEditCard()) return
    const sequence = ++this._cardSequence
    const fields = this.data.cardFields.map(({ nodeKey, fieldKey }) => ({ nodeKey, fieldKey }))
    this.setData({ cardSubmitting: true, cardError: '' })
    try {
      const config = await templates.updateTemplateCardDisplay(this.data.templateId, this.data.cardRevision, fields)
      if (!this.acceptCardResponse(sequence)) return
      this.applyCardConfig(config)
      wx.showToast({ title: '展示配置已保存', icon: 'success' })
    } catch (error) {
      if (!this.acceptCardResponse(sequence)) return
      const message = cardMessage(error)
      if (error && error.code === 'VERSION_CONFLICT') {
        this.setData({ cardSubmitting: false })
        const reload = this.loadCardDisplay()
        const reloadSequence = this._cardSequence
        await reload
        if (!this.acceptCardResponse(reloadSequence)) return
        this.setData({ cardError: this.data.cardError ? `${message}；${this.data.cardError}` : message })
      } else {
        if (isAccountAccessError(error)) this.clearCardEditor()
        this.setData({ cardError: message })
      }
    } finally {
      if (this.acceptCardResponse(sequence)) this.setData({ cardSubmitting: false })
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
    const nodes = withNodeUiKeys(orderedNodes(clone(definition.nodes || [])))
    nodes.forEach(validateLinkedNode)
    this._nodeOptionLinkages = new Map()
    this._loadedDefinitionDigest = template.definitionDigest
    this._loadedHadOptionLinkage = nodes.some(node => node.fields.some(field => hasOwn(field, 'optionLinkage')))
    const renderedNodes = nodes.map(node => this.storeNodeLinkage(node))
    this.setData({
      name: template.name,
      description: template.description || '',
      status: template.status,
      version: template.version,
      flowSchemaVersion: template.flowSchemaVersion === 2 ? 2 : 1,
      entryNodeKey: template.flowSchemaVersion === 2 ? template.entryNodeKey : '',
      nodes: renderedNodes,
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
    if (!this.requireSuperAdmin()) return { readOnly: true, node: null, assigneeOptions: [], nodeOptions: [] }
    const node = Number.isInteger(index) && index >= 0 ? this.data.nodes[index] : null
    return {
      readOnly: this.data.readOnly,
      assigneeOptions: clone(this.data.assigneeOptions),
      node: node ? clone(this.restoreNodeLinkage(node)) : null,
      cardFields: clone(this._savedCardFields || []),
      flowSchemaVersion: this.data.flowSchemaVersion,
      nodeOptions: this.data.nodes.map(item => ({ nodeKey: item.nodeKey || item._uiKey, _uiKey: item._uiKey, name: item.name || '未命名节点' })),
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
    if (this.data.flowSchemaVersion === 2 && !node.nodeKey) {
      const allocateKey = createKeyAllocator(nodes.flatMap(item => [item.nodeKey, item._uiKey]))
      node.nodeKey = node._uiKey || allocateKey('node')
    }
    if (this.data.flowSchemaVersion === 2 && !node.next) node.next = { mode: 'end' }
    if (this.data.flowSchemaVersion !== 2 && node.activationMode === 'optional_tail' && nodes.some((item, itemIndex) =>
      itemIndex !== index && item.activationMode === 'optional_tail')) {
      this.setData({ errorMessage: '每个模板只能设置一个可选追加节点' })
      return
    }
    validateLinkedNode(node)
    const allocateKey = createKeyAllocator(nodes.flatMap(item => [item.nodeKey, item._uiKey]))
    const renderedNode = this.storeNodeLinkage({ ...clone(node),
      _uiKey: node._uiKey || node.nodeKey || allocateKey('node') })
    if (Number.isInteger(index) && index >= 0 && index < nodes.length) nodes[index] = renderedNode
    else nodes.push(renderedNode)
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
      nodes: this.data.nodes.map((node, sequence) => {
        const restored = this.restoreNodeLinkage(node)
        const clean = cleanNode(restored, sequence)
        validateLinkedNode(clean)
        return clean
      })
    }
    if (this.data.flowSchemaVersion === 2) {
      definition.flowSchemaVersion = 2
      definition.entryNodeKey = this.data.entryNodeKey
    }
    if (this._loadedHadOptionLinkage || definition.nodes.some(node => node.fields.some(field => hasOwn(field, 'optionLinkage')))) {
      if (this.data.editMode && !this._loadedDefinitionDigest) throw new Error('商品联动保存缺少已加载的定义摘要，请重新打开模板')
      definition.optionLinkageEdit = { schemaVersion: 1,
        expectedDefinitionDigest: this.data.editMode ? this._loadedDefinitionDigest : null }
    }
    return definition
  },

  storeNodeLinkage(node) {
    if (!this._nodeOptionLinkages) this._nodeOptionLinkages = new Map()
    const detached = detachNodeLinkage(node)
    const key = node.nodeKey || node._uiKey
    if (detached.rule) this._nodeOptionLinkages.set(key, detached.rule)
    else this._nodeOptionLinkages.delete(key)
    return detached.node
  },

  restoreNodeLinkage(node) {
    return attachNodeLinkage(node, this._nodeOptionLinkages && this._nodeOptionLinkages.get(node.nodeKey || node._uiKey))
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
    let definition
    try { definition = this.definition() } catch (error) {
      this.setData({ errorMessage: error.message })
      return
    }
    if (!definition.name) {
      this.setData({ errorMessage: '请填写模板名称' })
      return
    }
    if (!definition.nodes.length) {
      this.setData({ errorMessage: '请至少添加一个节点' })
      return
    }
    const issue = templateDefinitionIssue(definition)
    if (issue) {
      this.setData({ errorMessage: issue })
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
      if (error && error.code === 'VERSION_CONFLICT' && definition.optionLinkageEdit) {
        this.setData({ errorMessage: '模板已被其他管理员更新；已保留本地草稿，请另行核对最新版本后重试' })
        return
      }
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
