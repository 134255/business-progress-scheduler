const templates = require('../../services/templates')

function messageFor(error) {
  return error && error.message ? error.message : '网络异常，请稍后重试'
}

Page({
  data: {
    loading: false,
    items: [],
    errorMessage: ''
  },

  onShow() {
    const actor = this.requireActiveUser()
    if (!actor) return
    return this.loadTemplates(actor._id)
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

  async loadTemplates(expectedUserId) {
    if (this.data.loading) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const result = await templates.listEnabledTemplates()
      if (!this.requireActiveUser(expectedUserId)) return
      const items = (Array.isArray(result.items) ? result.items : []).map(item => ({
        ...item,
        unavailableMessage: item.available ? '' : templates.unavailableReasonMessage(item.unavailableReason)
      }))
      this.setData({ items })
    } catch (error) {
      if (!this.requireActiveUser(expectedUserId)) return
      this.setData({ items: [], errorMessage: messageFor(error) })
    } finally {
      if (this.requireActiveUser(expectedUserId)) this.setData({ loading: false })
    }
  },

  retry() {
    const actor = this.requireActiveUser()
    if (actor) return this.loadTemplates(actor._id)
  },

  selectTemplate(event) {
    if (!this.requireActiveUser()) return
    const { id } = event.currentTarget.dataset
    const item = this.data.items.find(candidate => candidate._id === id)
    if (!item) return
    if (!item.available) {
      wx.showToast({ title: item.unavailableMessage, icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/business-edit/index?templateId=${encodeURIComponent(id)}` })
  }
})
