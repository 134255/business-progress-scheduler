const businessService = require('../../services/business')

Page({
  data: {
    loading: true,
    profile: null,
    stats: { active: 0, pendingMine: 0, completed: 0 },
    recent: []
  },

  onShow() {
    this.loadDashboard()
  },

  async loadDashboard() {
    this.setData({ loading: true })
    try {
      const [profile, data] = await Promise.all([
        businessService.bootstrap(),
        businessService.dashboard()
      ])
      getApp().globalData.currentUser = profile
      this.setData({ profile, stats: data.stats, recent: data.recent || [] })
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

  openDetail(event) {
    wx.navigateTo({ url: `/pages/business-detail/index?id=${event.currentTarget.dataset.id}` })
  }
})

