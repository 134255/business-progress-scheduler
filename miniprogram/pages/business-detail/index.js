const businessService = require('../../services/business')

const FROZEN_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const ACTIVE_NODE_STATUSES = new Set(['ready', 'in_progress', 'blocked'])

function newRequestKey() {
  return `reject-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function activeUser() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user : null
}

Page({
  data: {
    id: '',
    loading: true,
    line: null,
    nodes: [],
    canManage: false,
    frozen: false,
    canClose: false,
    canRejectPrevious: false,
    previousNode: null,
    currentNode: null,
    showAmendmentEntry: false,
    rejectionReason: '',
    rejecting: false,
    closureOptions: [
      { value: 'cancelled', label: '取消业务' },
      { value: 'closed', label: '关闭业务' },
      { value: 'deleted', label: '逻辑删除' }
    ],
    closureIndex: 0,
    closureReason: '',
    closing: false,
    errorMessage: ''
  },

  onLoad(query = {}) {
    const user = activeUser()
    if (!user) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.actorId = user._id
    this.setData({ id: String(query.id || '') })
  },

  onShow() {
    if (this.data.id) return this.loadDetail()
  },

  actorStillCurrent() {
    const user = activeUser()
    if (user && user._id === this.actorId) return user
    wx.reLaunch({ url: '/pages/login/index' })
    return null
  },

  presentDetail(data) {
    const user = activeUser()
    const line = data.line || null
    const nodes = (data.nodes || []).slice().sort((left, right) =>
      Number(left.sequence) - Number(right.sequence))
    const frozen = Boolean(line && FROZEN_STATUSES.has(line.status))
    const currentIndex = line ? nodes.findIndex(node => node._id === line.currentNodeId) : -1
    const currentNode = currentIndex >= 0 ? nodes[currentIndex] : null
    const previousNode = currentIndex > 0 ? nodes[currentIndex - 1] : null
    const accountAssignees = currentNode && Array.isArray(currentNode.assigneeUserIds)
      ? currentNode.assigneeUserIds
      : []
    const isCurrentAssignee = Boolean(user && accountAssignees.includes(user._id))
    const canRejectPrevious = Boolean(
      line && line.status === 'active' && currentNode && previousNode &&
      currentNode._id === line.currentNodeId && ACTIVE_NODE_STATUSES.has(currentNode.status) &&
      previousNode.status === 'completed' && isCurrentAssignee
    )
    const superAdmin = Boolean(user && user.role === 'super_admin')
    return {
      ...data,
      line,
      nodes,
      frozen,
      currentNode,
      previousNode,
      canRejectPrevious,
      canClose: Boolean(line && line.status === 'active' && (data.canManage || superAdmin)),
      showAmendmentEntry: frozen && superAdmin
    }
  },

  async loadDetail() {
    this.setData({ loading: true, errorMessage: '' })
    try {
      const data = await businessService.getBusinessLine(this.data.id)
      if (!this.actorStillCurrent()) return
      this.setData(this.presentDetail(data))
    } catch (error) {
      if (this.actorStillCurrent()) this.setData({ errorMessage: error.message || '业务详情加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  openFeedback(event) {
    const node = this.data.nodes[Number(event.currentTarget.dataset.index)]
    if (!node) return
    wx.navigateTo({
      url: `/pages/node-feedback/index?lineId=${encodeURIComponent(this.data.id)}&nodeId=${encodeURIComponent(node._id)}`
    })
  },

  editLine() {
    if (!this.data.canManage || this.data.frozen) return
    wx.navigateTo({ url: `/pages/business-edit/index?id=${encodeURIComponent(this.data.id)}` })
  },

  onRejectionReason(event) {
    this.setData({ rejectionReason: event.detail.value })
  },

  async rejectPrevious() {
    if (!this.data.canRejectPrevious || this.data.rejecting) return
    const reason = this.data.rejectionReason.trim()
    if (!reason) {
      wx.showToast({ title: '请填写驳回原因', icon: 'none' })
      return
    }
    if (!this.rejectionRequestKey) this.rejectionRequestKey = newRequestKey()
    this.setData({ rejecting: true })
    try {
      await businessService.rejectPreviousNode({
        businessLineId: this.data.id,
        currentNodeId: this.data.currentNode._id,
        expectedCurrentVersion: this.data.currentNode.version,
        expectedPreviousVersion: this.data.previousNode.version,
        reason,
        requestKey: this.rejectionRequestKey
      })
      if (!this.actorStillCurrent()) return
      this.rejectionRequestKey = ''
      this.setData({ rejectionReason: '' })
      wx.showToast({ title: '已驳回上一节点', icon: 'success' })
      await this.loadDetail()
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') {
        await this.loadDetail()
        wx.showToast({ title: '节点版本已变化，请核对后重试', icon: 'none' })
      } else {
        wx.showToast({ title: error.message || '驳回失败', icon: 'none' })
      }
    } finally {
      this.setData({ rejecting: false })
    }
  },

  onClosureOutcome(event) {
    this.setData({ closureIndex: Number(event.detail.value) })
  },

  onClosureReason(event) {
    this.setData({ closureReason: event.detail.value })
  },

  async closeLine() {
    if (!this.data.canClose || this.data.closing) return
    const reason = this.data.closureReason.trim()
    if (!reason) {
      wx.showToast({ title: '请填写关闭原因', icon: 'none' })
      return
    }
    const outcome = this.data.closureOptions[this.data.closureIndex].value
    this.setData({ closing: true })
    try {
      await businessService.closeBusinessLine({
        businessLineId: this.data.id,
        expectedVersion: this.data.line.version,
        outcome,
        reason
      })
      if (!this.actorStillCurrent()) return
      this.setData({ closureReason: '' })
      wx.showToast({ title: '业务状态已更新', icon: 'success' })
      await this.loadDetail()
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') await this.loadDetail()
      wx.showToast({ title: error.code === 'VERSION_CONFLICT' ? '业务版本已变化，请核对后重试' : (error.message || '操作失败'), icon: 'none' })
    } finally {
      this.setData({ closing: false })
    }
  },

  openAmendment() {
    if (!this.data.showAmendmentEntry) return
    wx.navigateTo({ url: `/pages/admin-business-amend/index?id=${encodeURIComponent(this.data.id)}` })
  }
})
