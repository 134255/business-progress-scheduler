const businessService = require('../../services/business')

Page({
  data: {
    loading: true,
    profile: null,
    stats: { active: 0, pendingMine: null, pendingMineAvailable: false, completed: 0 },
    recent: []
  },

  onShow() {
    const currentUser = this.requireActiveUser()
    if (!currentUser) return
    this.setData({ profile: currentUser })
    return this.loadDashboard(currentUser._id)
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

  async loadDashboard(expectedUserId) {
    this.setData({ loading: true })
    try {
      const data = await businessService.dashboard()
      if (!this.requireActiveUser(expectedUserId)) return
      this.setData({ stats: data.stats, recent: data.recent || [] })
    } finally {
      if (this.requireActiveUser(expectedUserId)) this.setData({ loading: false })
    }
  },

  openList() {
    wx.navigateTo({ url: '/pages/business-list/index' })
  },

  createBusiness() {
    wx.navigateTo({ url: '/pages/business-edit/index' })
  },

  openTemplates() {
    wx.navigateTo({ url: '/pages/template-list/index' })
  },

  openAdminUsers() {
    if (!this.data.profile || this.data.profile.role !== 'super_admin' || this.data.profile.status !== 'active') return
    wx.navigateTo({ url: '/pages/admin-users/index' })
  },

  openAdminTemplates() {
    if (!this.data.profile || this.data.profile.role !== 'super_admin' || this.data.profile.status !== 'active') return
    wx.navigateTo({ url: '/pages/admin-templates/index' })
  },

  openProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/business-detail/index?id=${event.currentTarget.dataset.id}` })
  }
})
