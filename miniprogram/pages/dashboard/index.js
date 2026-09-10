const businessService = require('../../services/business')
const { safeErrorMessage, isAccountAccessError } = require('../../utils/safe-error')
const { presentBusinessCard } = require('../../utils/business-card')

let cachedAccountId = ''
let cachedRole = ''
let cachedDashboard = null

function presentRecent(item) {
  const versionTwo = item && item.flowSchemaVersion === 2
  const terminalCompleted = Boolean(versionTwo && item.status === 'completed')
  const completedNodeCount = Number(item && item.completedNodeCount || 0)
  return presentBusinessCard({
    ...item,
    showProgressPercent: !versionTwo || terminalCompleted,
    displayProgress: terminalCompleted ? 100 : Number(item && item.progress || 0),
    pathSummary: versionTwo
      ? terminalCompleted
        ? `已完成 ${completedNodeCount} 个节点 · 售后已完成`
        : `已完成 ${completedNodeCount} 个节点 · 当前：${item.currentNodeName || '待处理'}`
      : ''
  })
}

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
    if (cachedAccountId !== currentUser._id || cachedRole !== currentUser.role) this.clearDashboard()
    cachedAccountId = currentUser._id
    cachedRole = currentUser.role
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
    this.clearDashboard()
    if (!this.authRedirected) {
      this.authRedirected = true
      wx.reLaunch({ url: '/pages/login/index' })
    }
    return null
  },

  async loadDashboard(expectedUserId) {
    const actor = this.requireActiveUser(expectedUserId)
    if (!actor) return
    expectedUserId = actor._id
    const expectedRole = actor.role
    if (cachedAccountId !== expectedUserId || cachedRole !== expectedRole) this.clearDashboard()
    this.setData({ profile: actor })
    const requestSequence = (this.dashboardSequence || 0) + 1
    this.dashboardSequence = requestSequence
    this.setData({ loading: !cachedDashboard, errorMessage: '' })
    try {
      const data = await businessService.dashboard()
      if (!this.acceptDashboard(requestSequence, expectedUserId, expectedRole)) return
      cachedAccountId = expectedUserId
      cachedRole = expectedRole
      const recent = (data.recent || []).map(presentRecent)
      cachedDashboard = { stats: data.stats, recent }
      this.setData({ stats: data.stats, recent })
    } catch (error) {
      if (this.acceptDashboard(requestSequence, expectedUserId, expectedRole)) {
        if (isAccountAccessError(error)) this.clearDashboard()
        this.setData({ errorMessage: safeErrorMessage(error, '售后概览加载失败，请稍后重试') })
      }
    } finally {
      if (this.acceptDashboard(requestSequence, expectedUserId, expectedRole)) {
        this.setData({ loading: false })
      }
    }
  },

  openList() {
    wx.navigateTo({ url: '/pages/business-list/index' })
  },

  clearDashboard() {
    cachedDashboard = null
    cachedAccountId = ''
    cachedRole = ''
    this.setData({ recent: [], profile: null, loading: false,
      stats: { active: 0, pendingMine: null, pendingMineAvailable: false, completed: 0 } })
  },

  acceptDashboard(sequence, actorId, role) {
    if (sequence !== this.dashboardSequence) return false
    const actor = this.requireActiveUser(actorId)
    if (!actor) return false
    if (actor.role !== role) { this.clearDashboard(); return false }
    return true
  },

  onHide() { this.dashboardSequence = (this.dashboardSequence || 0) + 1 },
  onUnload() { this.onHide() },
  retryCards() {
    const actor = this.requireActiveUser()
    if (actor) return this.loadDashboard(actor._id)
  },
  async onPullDownRefresh() {
    try { await this.retryCards() } finally { wx.stopPullDownRefresh() }
  },

  openStatusList(event) {
    const status = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.status
    if (status !== 'active' && status !== 'completed') return
    if (!this.requireActiveUser()) return
    wx.navigateTo({ url: `/pages/business-list/index?status=${status}&scope=mine` })
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
