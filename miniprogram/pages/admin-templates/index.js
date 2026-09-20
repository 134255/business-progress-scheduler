const templates = require('../../services/templates')

function errorMessage(error) {
  if (error && error.code === 'TEMPLATE_NOT_EDITABLE') return '启用中的模板为只读，请先停用模板'
  if (error && error.code === 'VERSION_CONFLICT') return '模板已被其他管理员更新，已刷新为最新版本'
  return error && error.message ? error.message : '网络异常，请稍后重试'
}

function copyErrorMessage(error) {
  const messages = {
    PROCESSOR_INACTIVE: '原模板中有已停用的处理人，请调整后再复制',
    REVIEWER_INACTIVE: '原模板中有已停用的审核人，请调整后再复制',
    ASSIGNEE_INACTIVE: '原模板中有已停用的负责人，请调整后再复制',
    PARTICIPANT_INACTIVE: '模板参与人状态已变化，请核对后再复制',
    TEMPLATE_LIMIT_EXCEEDED: '模板节点或参与人过多，超出安全复制上限，请先调整模板',
    TEMPLATE_INVALID: '原模板配置不完整，请检查节点、字段及流程后再复制',
    CARD_DISPLAY_INVALID: '原模板卡片展示配置不完整，请调整后再复制',
    ROLE_OVERLAP: '原模板处理人与审核人存在冲突，请调整后再复制',
    NOT_FOUND: '原模板不存在或已删除，请刷新列表',
    FORBIDDEN: '当前账号无权复制模板，请重新登录后重试',
    VERSION_CONFLICT: '模板或展示配置已更新，已刷新列表，请核对后重新复制'
  }
  return error && Object.prototype.hasOwnProperty.call(messages, error.code)
    ? messages[error.code] : '复制结果未确认，请刷新列表检查是否已有副本，再决定是否重试'
}

Page({
  data: { loading: false, copyingId: '', keyword: '', status: 'all', items: [], errorMessage: '' },

  onShow() {
    if (!this.requireSuperAdmin()) return
    return this.loadTemplates()
  },

  onUnload() {
    this._copyDisposed = true
    this._copyOperation = null
  },

  requireSuperAdmin() {
    const currentUser = getApp().globalData.currentUser
    if (currentUser && currentUser.role === 'super_admin' && currentUser.status === 'active') return true
    wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
    return false
  },

  onKeywordInput(event) { this.setData({ keyword: event.detail.value }) },

  onStatusChange(event) {
    const statuses = ['all', 'draft', 'enabled', 'disabled']
    this.setData({ status: statuses[Number(event.detail.value)] || 'all' })
    return this.search()
  },

  search() { return this.loadTemplates() },

  async loadTemplates() {
    if (!this.requireSuperAdmin() || this._copyDisposed || this.data.loading) return false
    const ownerId = getApp().globalData.currentUser._id
    const current = () => !this._copyDisposed && this.requireSuperAdmin() &&
      getApp().globalData.currentUser._id === ownerId
    this.setData({ loading: true, errorMessage: '' })
    try {
      const query = { keyword: this.data.keyword.trim() }
      if (this.data.status !== 'all') query.status = this.data.status
      const result = await templates.listTemplates(query, { silent: true })
      if (!current()) return
      this.setData({ items: result.items || [] })
      return true
    } catch (error) {
      if (!current()) return
      if (error && error.code === 'FORBIDDEN') {
        wx.reLaunch({ url: '/pages/dashboard/index' })
        return
      }
      this.setData({ errorMessage: errorMessage(error) })
      return false
    } finally {
      if (!this._copyDisposed) {
        const actor = getApp().globalData.currentUser
        const sameAccount = actor && actor._id === ownerId
        this.setData({ loading: false, ...(sameAccount ? {} : { items: [] }) })
      }
    }
  },

  openCreate() {
    if (!this.requireSuperAdmin() || this.data.copyingId) return
    wx.navigateTo({ url: '/pages/admin-template-edit/index' })
  },

  openEdit(event) {
    if (!this.requireSuperAdmin() || this.data.copyingId) return
    const templateId = event.currentTarget.dataset.id
    if (templateId) wx.navigateTo({ url: `/pages/admin-template-edit/index?id=${encodeURIComponent(templateId)}` })
  },

  async runConfirmed(options, action) {
    if (!this.requireSuperAdmin() || this.data.copyingId) return false
    const confirmation = await wx.showModal(options)
    if (!confirmation.confirm) return false
    if (!this.requireSuperAdmin()) return false
    try {
      await action()
      if (!this.requireSuperAdmin()) return false
      wx.showToast({ title: '操作成功', icon: 'success' })
      if (!this.requireSuperAdmin()) return false
      await this.loadTemplates()
      if (!this.requireSuperAdmin()) return false
      return true
    } catch (error) {
      if (!this.requireSuperAdmin()) return false
      const message = errorMessage(error)
      if (error && error.code === 'VERSION_CONFLICT') {
        await this.loadTemplates()
        if (!this.requireSuperAdmin()) return false
        this.setData({ errorMessage: message })
      } else this.setData({ errorMessage: message })
      return false
    }
  },

  async copyTemplate(event) {
    if (!this.requireSuperAdmin() || this._copyDisposed || this.data.loading || this.data.copyingId) return
    const item = this.data.items.find(candidate => candidate._id === event.currentTarget.dataset.id)
    if (!item || item.status === 'deleted') return
    const ownerId = getApp().globalData.currentUser._id
    const operation = {}
    this._copyOperation = operation
    const current = () => !this._copyDisposed && this._copyOperation === operation &&
      this.requireSuperAdmin() && getApp().globalData.currentUser._id === ownerId
    this.setData({ copyingId: item._id, errorMessage: '' })
    let created = false
    try {
      const confirmation = await wx.showModal({
        title: '复制模板',
        content: `将“${item.name}”已保存的节点、字段联动、流程和卡片展示复制为独立草稿；不复制已有售后，也不提交未保存的编辑。是否继续？`,
        confirmText: '复制'
      })
      if (!confirmation.confirm || !current()) return
      const result = await templates.copyTemplate(item._id, item.version)
      if (!current()) return
      const templateId = result && result.template && result.template._id
      if (typeof templateId !== 'string' || !templateId) throw new Error('COPY_RESULT_INVALID')
      created = true
      wx.showToast({ title: '副本已创建', icon: 'success' })
      await wx.navigateTo({ url: `/pages/admin-template-edit/index?id=${encodeURIComponent(templateId)}` })
    } catch (error) {
      if (!current()) return
      if (error && error.code === 'VERSION_CONFLICT') {
        const refreshed = await this.loadTemplates()
        if (!current()) return
        if (!refreshed) {
          this.setData({ errorMessage: '模板或展示配置已更新，但列表刷新未成功，请点击搜索刷新后再复制' })
          return
        }
      }
      this.setData({ errorMessage: created ? '副本已创建，但打开失败；请刷新列表后进入副本编辑' : copyErrorMessage(error) })
    } finally {
      if (this._copyOperation === operation) {
        this._copyOperation = null
        if (!this._copyDisposed) this.setData({ copyingId: '' })
      }
    }
  },

  changeStatus(event) {
    const item = this.data.items.find(candidate => candidate._id === event.currentTarget.dataset.id)
    if (!item) return
    const nextStatus = item.status === 'enabled' ? 'disabled' : 'enabled'
    const verb = nextStatus === 'enabled' ? '启用' : '停用'
    return this.runConfirmed({
      title: `确认${verb}模板`,
      content: nextStatus === 'enabled' ? '启用后模板定义将变为只读，是否继续？' : '停用后不能用此模板创建新售后，是否继续？'
    }, () => templates.changeTemplateStatus(item._id, item.version, nextStatus))
  },

  deleteTemplate(event) {
    const item = this.data.items.find(candidate => candidate._id === event.currentTarget.dataset.id)
    if (!item || item.status === 'enabled') return
    return this.runConfirmed({
      title: '确认删除模板',
      content: '模板将被逻辑删除，历史售后不受影响。是否继续？',
      confirmColor: '#be123c'
    }, () => templates.deleteTemplate(item._id, item.version))
  }
})
