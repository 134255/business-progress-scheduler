const businessService = require('../../services/business')

function activeUserId() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user._id : ''
}

function dueText(item) {
  if (!item.processingDueAt) return '处理截止待计算'
  const date = new Date(item.processingDueAt)
  if (Number.isNaN(date.getTime())) return '处理截止待计算'
  const overdue = Number(item.processingOverdueWorkMinutes || 0)
  return `处理截止 ${date.toLocaleString('zh-CN')}${overdue > 0 ? ` · 已逾期 ${overdue} 个工作分钟` : ''}`
}

function present(item) {
  return {
    nodeId: item.nodeId,
    businessLineId: item.businessLineId,
    businessCode: item.businessCode || '',
    businessName: item.businessName || '未命名业务',
    nodeCode: item.nodeCode || '',
    nodeName: item.nodeName || '未命名节点',
    status: item.status,
    processingRoundNumber: Number(item.processingRoundNumber || 0),
    dueText: dueText(item)
  }
}

Page({
  data: { items: [], cursor: '', hasMore: false, loading: false, loadingMore: false, errorMessage: '' },

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
    this.setData({ loading: true, errorMessage: '', cursor: '' })
    try {
      const result = await businessService.listMyPendingProcessing({ cursor: '', pageSize: 20 })
      if (!this.pageAlive || sequence !== this.requestSequence || activeUserId() !== actorId) return
      this.setData({
        items: (result.items || []).map(present),
        cursor: result.cursor || '',
        hasMore: Boolean(result.hasMore)
      })
    } catch (error) {
      if (this.pageAlive && sequence === this.requestSequence && activeUserId() === actorId) {
        this.setData({ errorMessage: error.message || '待处理任务加载失败，请稍后重试' })
      }
    } finally {
      if (this.pageAlive && sequence === this.requestSequence && activeUserId() === actorId) {
        this.setData({ loading: false })
      }
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const actorId = activeUserId()
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loadingMore: true })
    try {
      const result = await businessService.listMyPendingProcessing({
        cursor: this.data.cursor,
        pageSize: 20
      })
      if (!this.pageAlive || sequence !== this.requestSequence || activeUserId() !== actorId) return
      const byId = new Map(this.data.items.map(item => [item.nodeId, item]))
      for (const item of result.items || []) byId.set(item.nodeId, present(item))
      this.setData({
        items: [...byId.values()],
        cursor: result.cursor || '',
        hasMore: Boolean(result.hasMore)
      })
    } catch (error) {
      if (this.pageAlive && sequence === this.requestSequence && activeUserId() === actorId) {
        this.setData({ errorMessage: error.message || '更多待处理任务加载失败，请稍后重试' })
      }
    } finally {
      if (this.pageAlive && sequence === this.requestSequence && activeUserId() === actorId) {
        this.setData({ loadingMore: false })
      }
    }
  },

  openItem(event) {
    const lineId = String(event.currentTarget.dataset.lineId || '')
    const nodeId = String(event.currentTarget.dataset.nodeId || '')
    if (!this.data.items.some(item => item.businessLineId === lineId && item.nodeId === nodeId)) return
    wx.navigateTo({
      url: `/pages/node-feedback/index?lineId=${encodeURIComponent(lineId)}&nodeId=${encodeURIComponent(nodeId)}`
    })
  }
})
