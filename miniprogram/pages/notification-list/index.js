const businessService = require('../../services/business')

const TYPE_LABELS = Object.freeze({
  review_started: '有新的节点等待你审核',
  review_reminder: '节点审核尚未处理',
  node_review_rejected: '节点审核已驳回并进入返工',
  business_completed: '业务线已完成',
  node_processing_started: '有新的节点等待处理',
  processing_reminder: '节点处理尚未完成',
  work_calendar_missing: '工作日历需要管理员处理',
  evidence_retention: '凭证保留期即将结束'
})

function activeUserId() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user._id : ''
}

function present(item) {
  const result = {
    notificationId: item.notificationId,
    type: item.type,
    read: Boolean(item.read),
    title: Object.prototype.hasOwnProperty.call(TYPE_LABELS, item.type)
      ? TYPE_LABELS[item.type]
      : '业务进度有新消息',
    createdAtText: item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''
  }
  for (const key of ['businessLineId', 'nodeId', 'reviewRoundId']) {
    if (typeof item[key] === 'string' && item[key]) result[key] = item[key]
  }
  return result
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
    const actorId = activeUserId()
    if (!actorId) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loading: true, errorMessage: '', page: 1 })
    try {
      const result = await businessService.listMyNotifications({ page: 1, pageSize: 20 })
      if (!this.pageAlive || activeUserId() !== actorId || this.requestSequence !== sequence) return
      this.setData({ items: (result.items || []).map(present), page: 1, hasMore: Boolean(result.hasMore) })
    } catch (error) {
      if (this.pageAlive && activeUserId() === actorId && this.requestSequence === sequence) {
        this.setData({ errorMessage: error.message || '消息通知加载失败，请稍后重试' })
      }
    } finally {
      if (this.pageAlive && activeUserId() === actorId && this.requestSequence === sequence) {
        this.setData({ loading: false })
      }
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const actorId = activeUserId()
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    const page = this.data.page + 1
    this.setData({ loadingMore: true })
    try {
      const result = await businessService.listMyNotifications({ page, pageSize: 20 })
      if (!this.pageAlive || activeUserId() !== actorId || this.requestSequence !== sequence) return
      const byId = new Map(this.data.items.map(item => [item.notificationId, item]))
      for (const item of result.items || []) byId.set(item.notificationId, present(item))
      this.setData({ items: [...byId.values()], page, hasMore: Boolean(result.hasMore) })
    } catch (error) {
      if (this.pageAlive && this.requestSequence === sequence && activeUserId() === actorId) {
        this.setData({ errorMessage: error.message || '更多消息加载失败，请稍后重试' })
      }
    } finally {
      if (this.pageAlive && this.requestSequence === sequence && activeUserId() === actorId) {
        this.setData({ loadingMore: false })
      }
    }
  },

  async markRead(item) {
    if (!item || item.read || this.markingIds && this.markingIds.has(item.notificationId)) return true
    if (!this.markingIds) this.markingIds = new Set()
    this.markingIds.add(item.notificationId)
    const actorId = activeUserId()
    try {
      await businessService.markNotificationRead(item.notificationId)
      if (!this.pageAlive || activeUserId() !== actorId) return false
      this.setData({ items: this.data.items.map(current => current.notificationId === item.notificationId
        ? { ...current, read: true }
        : current) })
      return true
    } catch (error) {
      if (this.pageAlive && activeUserId() === actorId) wx.showToast({ title: error.message || '消息状态更新失败', icon: 'none' })
      return false
    } finally {
      this.markingIds.delete(item.notificationId)
    }
  },

  async openNotification(event) {
    const id = String(event.currentTarget.dataset.id || '')
    const item = this.data.items.find(current => current.notificationId === id)
    if (!item || this.openingId) return
    this.openingId = id
    try {
      if (!await this.markRead(item)) return
      const reviewTypes = new Set(['review_started', 'review_reminder'])
      if (reviewTypes.has(item.type) && item.reviewRoundId) {
        wx.navigateTo({ url: `/pages/review-detail/index?reviewRoundId=${encodeURIComponent(item.reviewRoundId)}` })
      } else if (item.businessLineId) {
        wx.navigateTo({ url: `/pages/business-detail/index?id=${encodeURIComponent(item.businessLineId)}` })
      }
    } finally {
      this.openingId = ''
    }
  },

  async markReadOnly(event) {
    const id = String(event.currentTarget.dataset.id || '')
    return this.markRead(this.data.items.find(item => item.notificationId === id))
  }
})
