const templates = require('../../services/templates')

function errorMessage(error) {
  if (error && error.code === 'TEMPLATE_NOT_EDITABLE') return '启用中的模板为只读，请先停用模板'
  if (error && error.code === 'VERSION_CONFLICT') return '模板已被其他管理员更新，已刷新为最新版本'
  return error && error.message ? error.message : '网络异常，请稍后重试'
}

Page({
  data: { loading: false, keyword: '', status: 'all', items: [], errorMessage: '' },

  onShow() {
    if (!this.requireSuperAdmin()) return
    return this.loadTemplates()
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
    if (!this.requireSuperAdmin() || this.data.loading) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const query = { keyword: this.data.keyword.trim() }
      if (this.data.status !== 'all') query.status = this.data.status
      const result = await templates.listTemplates(query)
      if (!this.requireSuperAdmin()) return
      this.setData({ items: result.items || [] })
    } catch (error) {
      if (!this.requireSuperAdmin()) return
      if (error && error.code === 'FORBIDDEN') {
        wx.reLaunch({ url: '/pages/dashboard/index' })
        return
      }
      this.setData({ errorMessage: errorMessage(error) })
    } finally {
      if (this.requireSuperAdmin()) this.setData({ loading: false })
    }
  },

  openCreate() {
    if (!this.requireSuperAdmin()) return
    wx.navigateTo({ url: '/pages/admin-template-edit/index' })
  },

  openEdit(event) {
    if (!this.requireSuperAdmin()) return
    const templateId = event.currentTarget.dataset.id
    if (templateId) wx.navigateTo({ url: `/pages/admin-template-edit/index?id=${encodeURIComponent(templateId)}` })
  },

  async runConfirmed(options, action) {
    if (!this.requireSuperAdmin()) return false
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
