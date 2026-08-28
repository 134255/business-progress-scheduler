const businessService = require('../../services/business')
const { safeErrorMessage } = require('../../utils/safe-error')

let cachedAccountId = ''
let cachedDashboard = null

Page({
  data: {
    loading: true,
    errorMessage: '',
    profile: null,
    stats: { active: 0, pendingMine: null, pendingMineAvailable: false, completed: 0 },
    recent: []
  },

  onShow() {
    const currentUser = this.requireActiveUser()
    if (!currentUser) return
    if (cachedAccountId && cachedAccountId !== currentUser._id) cachedDashboard = null
    cachedAccountId = currentUser._id
    this.setData({ profile: currentUser })
    if (cachedDashboard) {
      this.setData({
        stats: cachedDashboard.stats,
        recent: cachedDashboard.recent || [],
        loading: false,
        errorMessage: ''
      })
    }
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
    const requestSequence = (this.dashboardSequence || 0) + 1
    this.dashboardSequence = requestSequence
    this.setData({ loading: !cachedDashboard, errorMessage: '' })
    try {
      const data = await businessService.dashboard()
      if (requestSequence !== this.dashboardSequence || !this.requireActiveUser(expectedUserId)) return
      cachedAccountId = expectedUserId
      cachedDashboard = { stats: data.stats, recent: data.recent || [] }
      this.setData({ stats: data.stats, recent: data.recent || [] })
    } catch (error) {
      if (requestSequence === this.dashboardSequence && this.requireActiveUser(expectedUserId)) {
        this.setData({ errorMessage: safeErrorMessage(error, '售后概览加载失败，请稍后重试') })
      }
    } finally {
      if (requestSequence === this.dashboardSequence && this.requireActiveUser(expectedUserId)) {
        this.setData({ loading: false })
      }
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

  openReviews() {
    wx.navigateTo({ url: '/pages/review-list/index' })
  },

  openPendingProcessing() {
    wx.navigateTo({ url: '/pages/pending-processing/index' })
  },

  openNotifications() {
    wx.navigateTo({ url: '/pages/notification-list/index' })
  },

  openAdminUsers() {
    if (!this.data.profile || this.data.profile.role !== 'super_admin' || this.data.profile.status !== 'active') return
    wx.navigateTo({ url: '/pages/admin-users/index' })
  },

  openAdminTemplates() {
    if (!this.data.profile || this.data.profile.role !== 'super_admin' || this.data.profile.status !== 'active') return
    wx.navigateTo({ url: '/pages/admin-templates/index' })
  },

  openAdminOperations() {
    if (!this.data.profile || this.data.profile.status !== 'active') return
    wx.navigateTo({ url: '/pages/admin-operations/index' })
  },

  openProfile() {
    wx.navigateTo({ url: '/pages/profile/index' })
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/business-detail/index?id=${event.currentTarget.dataset.id}` })
  }
})
