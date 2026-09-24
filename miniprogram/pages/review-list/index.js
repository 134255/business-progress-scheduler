const businessService = require('../../services/business')
const { presentBusinessCard } = require('../../utils/business-card')
const { isAccountAccessError, safeErrorMessage } = require('../../utils/safe-error')

function activeUserKey() {
  const user = getApp().globalData.currentUser
  return user && user._id && user.status === 'active' ? JSON.stringify([user._id, user.role || '']) : ''
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
  return presentBusinessCard({
    code: item.businessCode,
    name: item.businessName,
    cardSummary: item.cardSummary,
    cardStatus: item.status === 'pending' ? 'pending_review' : item.status,
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
  })
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
    this.clearCards()
  },

  clearCards() {
    this.loadActorKey = ''
    this.setData({ items: [], page: 1, hasMore: false, loading: false, loadingMore: false })
  },

  requireCardActor() {
    const actorKey = activeUserKey()
    if (this.loadActorKey !== actorKey) this.clearCards()
    if (!actorKey) {
      this.clearCards()
      wx.reLaunch({ url: '/pages/login/index' })
      return ''
    }
    this.loadActorKey = actorKey
    return actorKey
  },

  acceptResponse(sequence, actorKey) {
    if (!this.pageAlive || sequence !== this.requestSequence) return false
    if (activeUserKey() !== actorKey) {
      this.clearCards()
      return false
    }
    return true
  },

  retryCards() {
    if (this.data.loading || this.data.loadingMore) return
    return this.refresh()
  },

  async refresh() {
    const actorKey = this.requireCardActor()
    if (!actorKey) return
    const requestSequence = (this.requestSequence || 0) + 1
    this.requestSequence = requestSequence
    this.setData({ loading: true, loadingMore: false, errorMessage: '' })
    try {
      const result = await businessService.listMyPendingReviews({ page: 1, pageSize: 20 })
      if (!this.acceptResponse(requestSequence, actorKey)) return
      this.setData({ items: (result.items || []).map(present), hasMore: Boolean(result.hasMore), page: 1 })
    } catch (error) {
      if (this.acceptResponse(requestSequence, actorKey)) {
        if (isAccountAccessError(error)) this.clearCards()
        this.setData({ errorMessage: safeErrorMessage(error, '审核待办加载失败，请稍后重试') })
      }
    } finally {
      if (this.acceptResponse(requestSequence, actorKey)) {
        this.setData({ loading: false })
      }
    }
  },

  async loadMore() {
    const actorKey = this.requireCardActor()
    if (!actorKey) return
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const requestSequence = (this.requestSequence || 0) + 1
    this.requestSequence = requestSequence
    const page = this.data.page + 1
    this.setData({ loadingMore: true, errorMessage: '' })
    try {
      const result = await businessService.listMyPendingReviews({ page, pageSize: 20 })
      if (!this.acceptResponse(requestSequence, actorKey)) return
      const byId = new Map(this.data.items.map(item => [item.reviewRoundId, item]))
      for (const item of result.items || []) byId.set(item.reviewRoundId, present(item))
      this.setData({ items: [...byId.values()], hasMore: Boolean(result.hasMore), page })
    } catch (error) {
      if (this.acceptResponse(requestSequence, actorKey)) {
        if (isAccountAccessError(error)) this.clearCards()
        this.setData({ errorMessage: safeErrorMessage(error, '更多审核待办加载失败，请稍后重试') })
      }
    } finally {
      if (this.acceptResponse(requestSequence, actorKey)) {
        this.setData({ loadingMore: false })
      }
    }
  },

  openDetail(event) {
    if (!this.requireCardActor()) return
    const id = String(event.currentTarget.dataset.id || '')
    if (!this.data.items.some(item => item.reviewRoundId === id)) return
    wx.navigateTo({ url: `/pages/review-detail/index?reviewRoundId=${encodeURIComponent(id)}` })
  }
})
