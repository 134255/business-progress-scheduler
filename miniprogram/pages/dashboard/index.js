const businessService = require('../../services/business')

Page({
  data: {
    loading: true,
    profile: null,
    stats: { active: 0, pendingMine: 0, completed: 0 },
    recent: []
  },

  onShow() {
    const currentUser = getApp().globalData.currentUser
    if (!currentUser) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.setData({ profile: currentUser })
    return this.loadDashboard()
  },

  async loadDashboard() {
    this.setData({ loading: true })
    try {
      const data = await businessService.dashboard()
      this.setData({ stats: data.stats, recent: data.recent || [] })
    } finally {
      this.setData({ loading: false })
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

  openProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/business-detail/index?id=${event.currentTarget.dataset.id}` })
  }
})
