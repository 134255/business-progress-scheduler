const businessService = require('../../services/business')
const templates = require('../../services/templates')

const FROZEN_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
let requestSequence = 0

function decode(value) {
  if (typeof value !== 'string') return ''
  try { return decodeURIComponent(value) } catch (error) { return '' }
}

function validDate(value) {
  if (!value) return true
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
}

function nextRequestKey() {
  requestSequence += 1
  return `create-${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function messageFor(error) {
  if (error && error.code === 'BUSINESS_FROZEN') return '业务已完成或关闭，结构化信息已冻结'
  if (error && error.code === 'VERSION_CONFLICT') return '业务已被其他人更新，请返回详情后重试'
  if (error && error.code === 'TEMPLATE_NOT_ENABLED') return '模板已停用，请重新选择'
  if (error && error.code === 'ASSIGNEE_INACTIVE') return '模板负责人不可用，请联系管理员'
  if (error && error.code === 'TEMPLATE_INVALID') return '模板定义不完整，请联系管理员'
  return error && error.message ? error.message : '网络异常，请稍后重试'
}

Page({
  data: {
    id: '',
    templateId: '',
    editMode: false,
    loading: false,
    saving: false,
    canManage: false,
    frozen: false,
    lineCode: '',
    lineStatus: '',
    nodes: [],
    templatePreview: null,
    templateAvailable: false,
    errorMessage: '',
    form: {
      version: 0,
      name: '',
      description: '',
      plannedStartDate: '',
      plannedEndDate: ''
    }
  },

  async onLoad(query = {}) {
    const actor = this.requireActiveUser()
    if (!actor) return
    const id = decode(query.id)
    const templateId = decode(query.templateId)
    const editMode = Boolean(id)
    this.setData({ id, templateId, editMode, loading: true, errorMessage: '' })
    wx.setNavigationBarTitle({ title: editMode ? '编辑业务线' : '从模板创建业务' })
    if (!editMode && !templateId) {
      this.setData({ loading: false })
      wx.redirectTo({ url: '/pages/template-list/index' })
      return
    }
    try {
      if (editMode) await this.loadBusinessLine(actor._id)
      else await this.loadTemplatePreview(actor._id)
    } catch (error) {
      if (!this.requireActiveUser(actor._id)) return
      this.setData({ errorMessage: messageFor(error) })
    } finally {
      if (this.requireActiveUser(actor._id)) this.setData({ loading: false })
    }
  },

  requireActiveUser(expectedUserId) {
    const currentUser = getApp().globalData.currentUser
    if (currentUser && currentUser.status === 'active' &&
        (!expectedUserId || currentUser._id === expectedUserId)) {
      this.authRedirected = false
      return currentUser
    }
    if (!this.authRedirected) {
      this.authRedirected = true
      wx.reLaunch({ url: '/pages/login/index' })
    }
    return null
  },

  async loadTemplatePreview(expectedUserId) {
    const result = await templates.listEnabledTemplates()
    if (!this.requireActiveUser(expectedUserId)) return
    const preview = (Array.isArray(result.items) ? result.items : [])
      .find(item => item._id === this.data.templateId)
    if (!preview) {
      this.setData({ templatePreview: null, templateAvailable: false, errorMessage: '模板不可用或已停用，请重新选择' })
      return
    }
    this.setData({
      templatePreview: preview,
      templateAvailable: Boolean(preview.available),
      errorMessage: preview.available ? '' : (preview.unavailableReason || '模板当前不可创建业务')
    })
  },

  async loadBusinessLine(expectedUserId) {
    const data = await businessService.getBusinessLine(this.data.id)
    if (!this.requireActiveUser(expectedUserId)) return
    const line = data.line || {}
    const frozen = FROZEN_STATUSES.has(line.status)
    this.setData({
      canManage: Boolean(data.canManage),
      frozen,
      lineCode: line.code || '',
      lineStatus: line.status || '',
      nodes: Array.isArray(data.nodes) ? data.nodes : [],
      form: {
        version: Number(line.version || 1),
        name: line.name || '',
        description: line.description || '',
        plannedStartDate: line.plannedStartDate || '',
        plannedEndDate: line.plannedEndDate || ''
      },
      errorMessage: frozen
        ? '业务已完成或关闭，结构化信息已冻结'
        : (data.canManage ? '' : '只有业务线管理员可以编辑')
    })
  },

  updateField(event) {
    if (this.data.editMode && (this.data.frozen || !this.data.canManage)) return
    const field = event.currentTarget.dataset.field
    if (!['name', 'description'].includes(field)) return
    this.pendingRequestKey = ''
    this.setData({ [`form.${field}`]: event.detail.value, errorMessage: '' })
  },

  updateDate(event) {
    if (this.data.editMode && (this.data.frozen || !this.data.canManage)) return
    const field = event.currentTarget.dataset.field
    if (!['plannedStartDate', 'plannedEndDate'].includes(field)) return
    this.pendingRequestKey = ''
    this.setData({ [`form.${field}`]: event.detail.value, errorMessage: '' })
  },

  normalizedMetadata() {
    return {
      name: String(this.data.form.name || '').trim(),
      description: String(this.data.form.description || '').trim(),
      plannedStartDate: this.data.form.plannedStartDate || '',
      plannedEndDate: this.data.form.plannedEndDate || ''
    }
  },

  validate(metadata) {
    if (!metadata.name) return '请填写业务线名称'
    if (!validDate(metadata.plannedStartDate) || !validDate(metadata.plannedEndDate)) return '计划日期格式无效'
    if (metadata.plannedStartDate && metadata.plannedEndDate &&
        metadata.plannedStartDate > metadata.plannedEndDate) return '计划结束日期不能早于开始日期'
    return ''
  },

  async save() {
    const actor = this.requireActiveUser()
    if (!actor || this.data.loading || this.data.saving) return
    if (this.data.editMode && (!this.data.canManage || this.data.frozen)) return
    if (!this.data.editMode && !this.data.templateAvailable) return
    const metadata = this.normalizedMetadata()
    const validationMessage = this.validate(metadata)
    if (validationMessage) {
      this.setData({ errorMessage: validationMessage })
      return
    }

    this.setData({ saving: true, errorMessage: '' })
    try {
      if (this.data.editMode) {
        const result = await businessService.updateBusinessMetadata({
          businessLineId: this.data.id,
          expectedVersion: this.data.form.version,
          ...metadata
        })
        if (!this.requireActiveUser(actor._id)) return
        this.setData({ 'form.version': result.version })
        wx.showToast({ title: '保存成功', icon: 'success' })
        if (!this.requireActiveUser(actor._id)) return
        wx.navigateBack({ delta: 1 })
      } else {
        if (!this.pendingRequestKey) this.pendingRequestKey = nextRequestKey()
        const result = await businessService.createBusinessFromTemplate({
          templateId: this.data.templateId,
          ...metadata,
          requestKey: this.pendingRequestKey
        })
        if (!this.requireActiveUser(actor._id)) return
        wx.showToast({ title: '创建成功', icon: 'success' })
        if (!this.requireActiveUser(actor._id)) return
        wx.redirectTo({ url: `/pages/business-detail/index?id=${encodeURIComponent(result.id)}` })
      }
    } catch (error) {
      if (!this.requireActiveUser(actor._id)) return
      const frozen = error && error.code === 'BUSINESS_FROZEN'
      this.setData({ frozen: this.data.frozen || frozen, errorMessage: messageFor(error) })
    } finally {
      if (this.requireActiveUser(actor._id)) this.setData({ saving: false })
    }
  }
})
