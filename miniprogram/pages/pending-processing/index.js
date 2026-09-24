const businessService = require('../../services/business')
const { presentBusinessCard } = require('../../utils/business-card')
const { isAccountAccessError, safeErrorMessage } = require('../../utils/safe-error')

function activeUserKey() {
  const user = getApp().globalData.currentUser
  return user && user._id && user.status === 'active' ? JSON.stringify([user._id, user.role || '']) : ''
}

function dueText(item) {
  if (item.actionKind === 'node_route_decision') return '等待决定后续节点走向'
  if (item.actionKind === 'optional_tail_decision') return '等待决定是否开启追加节点'
  if (!item.processingDueAt) return '处理截止待计算'
  const date = new Date(item.processingDueAt)
  if (Number.isNaN(date.getTime())) return '处理截止待计算'
  const overdue = Number(item.processingOverdueWorkMinutes || 0)
  return `处理截止 ${date.toLocaleString('zh-CN')}${overdue > 0 ? ` · 已逾期 ${overdue} 个工作分钟` : ''}`
}

function present(item) {
  const actionKind = ['optional_tail_decision', 'node_route_decision'].includes(item.actionKind)
    ? item.actionKind
    : 'process_node'
  return presentBusinessCard({
    code: item.businessCode,
    name: item.businessName,
    cardSummary: item.cardSummary,
    nodeId: item.nodeId,
    businessLineId: item.businessLineId,
    businessCode: item.businessCode || '',
    businessName: item.businessName || '未命名售后',
    nodeCode: item.nodeCode || '',
    nodeName: item.nodeName || '未命名节点',
    status: item.status,
    actionKind,
    actionText: actionKind === 'optional_tail_decision'
      ? '决定是否开启追加节点 →'
      : actionKind === 'node_route_decision'
        ? '决定后续节点走向 →'
        : '继续处理 →',
    processingRoundNumber: Number(item.processingRoundNumber || 0),
    dueText: dueText(item)
  })
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
    this.clearCards()
  },

  clearCards() {
    this.loadActorKey = ''
    this.setData({ items: [], cursor: '', hasMore: false, loading: false, loadingMore: false })
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
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loading: true, loadingMore: false, errorMessage: '' })
    try {
      const result = await businessService.listMyPendingProcessing({ cursor: '', pageSize: 20 })
      if (!this.acceptResponse(sequence, actorKey)) return
      this.setData({
        items: (result.items || []).map(present),
        cursor: result.cursor || '',
        hasMore: Boolean(result.hasMore)
      })
    } catch (error) {
      if (this.acceptResponse(sequence, actorKey)) {
        if (isAccountAccessError(error)) this.clearCards()
        this.setData({ errorMessage: safeErrorMessage(error, '待处理任务加载失败，请稍后重试') })
      }
    } finally {
      if (this.acceptResponse(sequence, actorKey)) {
        this.setData({ loading: false })
      }
    }
  },

  async loadMore() {
    const actorKey = this.requireCardActor()
    if (!actorKey) return
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loadingMore: true, errorMessage: '' })
    try {
      const result = await businessService.listMyPendingProcessing({
        cursor: this.data.cursor,
        pageSize: 20
      })
      if (!this.acceptResponse(sequence, actorKey)) return
      const byId = new Map(this.data.items.map(item => [item.nodeId, item]))
      for (const item of result.items || []) byId.set(item.nodeId, present(item))
      this.setData({
        items: [...byId.values()],
        cursor: result.cursor || '',
        hasMore: Boolean(result.hasMore)
      })
    } catch (error) {
      if (this.acceptResponse(sequence, actorKey)) {
        if (isAccountAccessError(error)) this.clearCards()
        this.setData({ errorMessage: safeErrorMessage(error, '更多待处理任务加载失败，请稍后重试') })
      }
    } finally {
      if (this.acceptResponse(sequence, actorKey)) {
        this.setData({ loadingMore: false })
      }
    }
  },

  openItem(event) {
    if (!this.requireCardActor()) return
    const lineId = String(event.currentTarget.dataset.lineId || '')
    const nodeId = String(event.currentTarget.dataset.nodeId || '')
    if (!this.data.items.some(item => item.businessLineId === lineId && item.nodeId === nodeId)) return
    const item = this.data.items.find(current =>
      current.businessLineId === lineId && current.nodeId === nodeId)
    wx.navigateTo({ url: ['optional_tail_decision', 'node_route_decision'].includes(item.actionKind)
      ? `/pages/business-detail/index?id=${encodeURIComponent(lineId)}`
      : `/pages/node-feedback/index?lineId=${encodeURIComponent(lineId)}&nodeId=${encodeURIComponent(nodeId)}` })
  }
})
