const businessService = require('../../services/business')

function activeUserId() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user._id : ''
}

function dueText(item) {
  if (item.reviewDueStatus === 'pending_calendar') return '审核截止待工作日历补算'
  if (item.reviewDueStatus !== 'calculated' || !item.reviewDueAt) return '审核截止待计算'
  const date = new Date(item.reviewDueAt)
  if (Number.isNaN(date.getTime())) return '审核截止待计算'
  const suffix = Number(item.reviewOverdueWorkMinutes || 0) > 0
    ? ` · 已逾期 ${item.reviewOverdueWorkMinutes} 个工作分钟`
    : ''
  return `审核截止 ${date.toLocaleString('zh-CN')}${suffix}`
}

function present(item) {
  return {
    reviewRoundId: item.reviewRoundId,
    businessLineId: item.businessLineId,
    businessCode: item.businessCode || '',
    businessName: item.businessName || '未命名售后',
    nodeId: item.nodeId,
    nodeCode: item.nodeCode || '',
    nodeName: item.nodeName || '未命名节点',
    reviewRoundNumber: Number(item.reviewRoundNumber || 0),
    status: item.status,
    reviewModeLabel: item.reviewMode === 'all' ? '会签' : '或签',
    dueText: dueText(item),
    createdAtText: item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''
  }
}

Page({
  data: { items: [], page: 1, hasMore: false, loading: false, loadingMore: false, errorMessage: '' },

  onShow() {
    this.pageAlive = true
    return this.refresh()
  },

  onUnload() {
    this.pageAlive = false
    this.requestSequence = (this.requestSequence || 0) + 1
  },

  async refresh() {
    const requestedActorId = activeUserId()
    if (!requestedActorId) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.loadActorId = requestedActorId
    const requestSequence = (this.requestSequence || 0) + 1
    this.requestSequence = requestSequence
    this.setData({ loading: true, errorMessage: '', page: 1 })
    try {
      const result = await businessService.listMyPendingReviews({ page: 1, pageSize: 20 })
      if (!this.pageAlive || this.requestSequence !== requestSequence || activeUserId() !== requestedActorId) return
      this.setData({ items: (result.items || []).map(present), hasMore: Boolean(result.hasMore), page: 1 })
    } catch (error) {
      if (this.pageAlive && this.requestSequence === requestSequence && activeUserId() === requestedActorId) {
        this.setData({ errorMessage: error.message || '审核待办加载失败，请稍后重试' })
      }
    } finally {
      if (this.pageAlive && this.requestSequence === requestSequence && activeUserId() === requestedActorId) {
        this.setData({ loading: false })
      }
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const requestedActorId = activeUserId()
    const requestSequence = (this.requestSequence || 0) + 1
    this.requestSequence = requestSequence
    const page = this.data.page + 1
    this.setData({ loadingMore: true })
    try {
      const result = await businessService.listMyPendingReviews({ page, pageSize: 20 })
      if (!this.pageAlive || this.requestSequence !== requestSequence || activeUserId() !== requestedActorId) return
      const byId = new Map(this.data.items.map(item => [item.reviewRoundId, item]))
      for (const item of result.items || []) byId.set(item.reviewRoundId, present(item))
      this.setData({ items: [...byId.values()], hasMore: Boolean(result.hasMore), page })
    } catch (error) {
      if (this.pageAlive && this.requestSequence === requestSequence && activeUserId() === requestedActorId) {
        this.setData({ errorMessage: error.message || '更多审核待办加载失败，请稍后重试' })
      }
    } finally {
      if (this.pageAlive && this.requestSequence === requestSequence && activeUserId() === requestedActorId) {
        this.setData({ loadingMore: false })
      }
    }
  },

  openDetail(event) {
    const id = String(event.currentTarget.dataset.id || '')
    if (!this.data.items.some(item => item.reviewRoundId === id)) return
    wx.navigateTo({ url: `/pages/review-detail/index?reviewRoundId=${encodeURIComponent(id)}` })
  }
})
