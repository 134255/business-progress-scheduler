const businessService = require('../../services/business')
const { safeErrorMessage } = require('../../utils/safe-error')

const FROZEN_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const ACTIVE_NODE_STATUSES = new Set(['ready', 'in_progress', 'blocked'])

function newRequestKey(prefix = 'reject') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function activeUser() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user : null
}

function dateTimeText(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

function workMinutesText(value) {
  const minutes = Number(value || 0)
  if (!Number.isFinite(minutes) || minutes <= 0) return '未逾期'
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (!hours) return `${remainder} 个工作分钟`
  return remainder ? `${hours} 小时 ${remainder} 个工作分钟` : `${hours} 小时`
}

function dueText(status, value) {
  if (status === 'pending_calendar') return '待工作日历补算'
  if (status === 'not_started') return '尚未开始'
  if (status !== 'calculated') return '待计算'
  return dateTimeText(value) || '待计算'
}

Page({
  data: {
    id: '',
    loading: true,
    refreshing: false,
    line: null,
    nodes: [],
    canManage: false,
    frozen: false,
    canClose: false,
    canRejectPrevious: false,
    previousNode: null,
    currentNode: null,
    displayProgress: 0,
    showProgressPercent: true,
    pathSummary: '',
    optionalTailSummary: '',
    optionalDecisionPanelOpen: false,
    optionalDecision: '',
    optionalDecisionComment: '',
    optionalDecisionSubmitting: false,
    routeDecisionPanelOpen: false,
    routeDecision: '',
    routeDecisionComment: '',
    routeDecisionSubmitting: false,
    showAmendmentEntry: false,
    rejectionReason: '',
    rejecting: false,
    closureOptions: [
      { value: 'cancelled', label: '取消售后' },
      { value: 'closed', label: '关闭售后' },
      { value: 'deleted', label: '逻辑删除' }
    ],
    closureIndex: 0,
    closureReason: '',
    closing: false,
    shareCreatingNodeId: '',
    errorMessage: ''
  },

  onLoad(query = {}) {
    const user = activeUser()
    if (!user) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.actorId = user._id
    this.pageAlive = true
    this.detailSequence = 0
    this.setData({ id: String(query.id || '') })
  },

  onUnload() {
    this.pageAlive = false
    this.detailSequence += 1
  },

  onShow() {
    if (!this.actorStillCurrent()) return
    if (this.data.id) return this.loadDetail()
  },

  actorStillCurrent() {
    const user = activeUser()
    if (user && user._id === this.actorId) return user
    this.detailSequence += 1
    this.setData({
      loading: false,
      refreshing: false,
      line: null,
      nodes: [],
      canManage: false,
      frozen: false,
      canClose: false,
      canRejectPrevious: false,
      previousNode: null,
      currentNode: null,
      displayProgress: 0,
      showProgressPercent: true,
      pathSummary: '',
      optionalTailSummary: '',
      optionalDecisionPanelOpen: false,
      optionalDecision: '',
      optionalDecisionComment: '',
      optionalDecisionSubmitting: false,
      routeDecisionPanelOpen: false,
      routeDecision: '',
      routeDecisionComment: '',
      routeDecisionSubmitting: false,
      showAmendmentEntry: false,
      shareCreatingNodeId: '',
      errorMessage: ''
    })
    wx.reLaunch({ url: '/pages/login/index' })
    return null
  },

  presentDetail(data) {
    const user = activeUser()
    const line = data.line || null
    const versionTwo = Boolean(line && line.flowSchemaVersion === 2)
    const nodes = (data.nodes || []).filter(node => !versionTwo ||
      ['active', 'completed', 'awaiting_manual_decision'].includes(node.routeState)).slice().sort((left, right) =>
      Number(left.sequence) - Number(right.sequence)).map(node => node.workflowMode === 'review'
      ? (() => {
        const decisionParts = []
        if (node.decisionActorDisplayName) decisionParts.push(node.decisionActorDisplayName)
        if (node.decisionAt) decisionParts.push(dateTimeText(node.decisionAt))
        if (node.decisionComment) decisionParts.push(node.decisionComment)
        return {
          ...node,
          processorNamesText: Array.isArray(node.processorDisplayNames) ? node.processorDisplayNames.join('、') : '',
          reviewerNamesText: Array.isArray(node.reviewerDisplayNames) ? node.reviewerDisplayNames.join('、') : '',
          reviewModeLabel: node.reviewMode === 'all' ? '会签' : '或签',
          processingDueText: dueText(node.processingDueStatus, node.processingDueAt),
          reviewDueText: dueText(node.reviewDueStatus, node.reviewDueAt),
          reviewStartedText: dateTimeText(node.reviewStartedAt),
          processingOverdueText: workMinutesText(node.processingOverdueWorkMinutes),
          reviewOverdueText: workMinutesText(node.reviewOverdueWorkMinutes),
          optionalDecisionText: node.status === 'skipped' ? '未启用' : '',
          decisionMetadataText: decisionParts.join(' · ')
        }
      })()
      : node)
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
      currentNode.workflowMode !== 'review' &&
      currentNode._id === line.currentNodeId && ACTIVE_NODE_STATUSES.has(currentNode.status) &&
      previousNode.status === 'completed' && isCurrentAssignee
    )
    const superAdmin = Boolean(user && user.role === 'super_admin')
    const pendingOptional = Boolean(line && line.optionalTailState === 'pending')
    const activatedOptional = Boolean(line && line.optionalTailState === 'activated')
    const completedNodeCount = Number(line && line.completedNodeCount || 0)
    const terminalCompleted = Boolean(versionTwo && line.status === 'completed')
    return {
      ...data,
      line,
      nodes,
      frozen,
      currentNode,
      previousNode,
      displayProgress: terminalCompleted
        ? 100
        : pendingOptional ? Math.min(99, Number(line && line.progress || 0)) : Number(line && line.progress || 0),
      showProgressPercent: !versionTwo || terminalCompleted,
      pathSummary: versionTwo
        ? line.status === 'completed'
          ? `已完成 ${completedNodeCount} 个节点 · 售后已完成`
          : `已完成 ${completedNodeCount} 个节点 · 当前：${currentNode && currentNode.name || line.currentNodeName || '待处理'}`
        : '',
      optionalTailSummary: pendingOptional
        ? '必经流程已完成 · 待决定'
        : activatedOptional ? '必经流程已完成 · 追加处理中' : '',
      canRejectPrevious,
      canClose: Boolean(line && line.status === 'active' && (data.canManage || superAdmin)),
      showAmendmentEntry: frozen && superAdmin
    }
  },

  openRouteDecision(event) {
    const decision = String(event.currentTarget.dataset.decision || '')
    if (!['activate', 'skip'].includes(decision) || !this.data.currentNode ||
        !this.data.currentNode.canDecideNodeRoute || this.data.routeDecisionSubmitting) return
    this.routeDecisionRequestKey = ''
    this.setData({ routeDecisionPanelOpen: true, routeDecision: decision, routeDecisionComment: '' })
  },

  onRouteDecisionComment(event) {
    if (!this.data.routeDecisionSubmitting) {
      this.setData({ routeDecisionComment: String(event.detail.value || '') })
    }
  },

  cancelRouteDecision() {
    if (this.data.routeDecisionSubmitting) return
    this.routeDecisionRequestKey = ''
    this.setData({ routeDecisionPanelOpen: false, routeDecision: '', routeDecisionComment: '' })
  },

  async confirmRouteDecision() {
    if (this.data.routeDecisionSubmitting || !this.data.routeDecisionPanelOpen) return false
    const node = this.data.currentNode
    const line = this.data.line
    const decision = this.data.routeDecision
    const comment = this.data.routeDecisionComment.trim()
    if (!node || !line || !node.canDecideNodeRoute || !['activate', 'skip'].includes(decision)) return false
    if (decision === 'skip' && !comment) {
      wx.showToast({ title: '请填写跳过原因', icon: 'none' })
      return false
    }
    if (!this.routeDecisionRequestKey) this.routeDecisionRequestKey = newRequestKey('node-route')
    const actorId = this.actorId
    const lineId = line._id
    this.setData({ routeDecisionSubmitting: true })
    try {
      await businessService.decideNodeRoute({
        businessLineId: lineId,
        nodeId: node._id,
        expectedLineVersion: line.version,
        expectedNodeVersion: node.version,
        decision,
        comment,
        requestKey: this.routeDecisionRequestKey
      })
      if (!this.pageAlive || !this.actorStillCurrent() || this.actorId !== actorId || this.data.id !== lineId) return false
      this.routeDecisionRequestKey = ''
      this.setData({ routeDecisionPanelOpen: false, routeDecision: '', routeDecisionComment: '' })
      wx.showToast({ title: decision === 'activate' ? '后续节点已开启' : '已按跳过路径继续', icon: 'success' })
      await this.loadDetail()
      return true
    } catch (error) {
      if (this.pageAlive && this.actorStillCurrent() && this.actorId === actorId && this.data.id === lineId) {
        if (error.code === 'VERSION_CONFLICT') await this.loadDetail()
        wx.showToast({ title: safeErrorMessage(error, '节点分支决定失败，请稍后重试'), icon: 'none' })
      }
      return false
    } finally {
      if (this.pageAlive && activeUser() && activeUser()._id === actorId && this.data.id === lineId) {
        this.setData({ routeDecisionSubmitting: false })
      }
    }
  },

  async loadDetail() {
    if (!this.actorStillCurrent()) return
    const requestSequence = ++this.detailSequence
    const requestedActorId = this.actorId
    const hasRenderedDetail = Boolean(this.data.line && this.data.line._id === this.data.id)
    this.setData({ loading: !hasRenderedDetail, refreshing: hasRenderedDetail, errorMessage: '' })
    try {
      const data = await businessService.getBusinessLine(this.data.id)
      if (!this.pageAlive || requestSequence !== this.detailSequence ||
          !this.actorStillCurrent() || activeUser()._id !== requestedActorId) return
      this.setData(this.presentDetail(data))
    } catch (error) {
      if (this.pageAlive && requestSequence === this.detailSequence && this.actorStillCurrent()) {
        this.setData({ errorMessage: safeErrorMessage(error, '售后详情加载失败，请稍后重试') })
      }
    } finally {
      if (this.pageAlive && requestSequence === this.detailSequence && activeUser() &&
          activeUser()._id === requestedActorId) this.setData({ loading: false, refreshing: false })
    }
  },

  openFeedback(event) {
    const node = this.data.nodes[Number(event.currentTarget.dataset.index)]
    if (!node) return
    wx.navigateTo({
      url: `/pages/node-feedback/index?lineId=${encodeURIComponent(this.data.id)}&nodeId=${encodeURIComponent(node._id)}`
    })
  },

  openOptionalDecision(event) {
    const decision = String(event.currentTarget.dataset.decision || '')
    if (!['activate', 'skip'].includes(decision) || !this.data.currentNode ||
        !this.data.currentNode.canDecideOptionalTail || this.data.optionalDecisionSubmitting) return
    this.optionalDecisionRequestKey = ''
    this.setData({
      optionalDecisionPanelOpen: true,
      optionalDecision: decision,
      optionalDecisionComment: ''
    })
  },

  onOptionalDecisionComment(event) {
    if (!this.data.optionalDecisionSubmitting) {
      this.setData({ optionalDecisionComment: String(event.detail.value || '') })
    }
  },

  cancelOptionalDecision() {
    if (this.data.optionalDecisionSubmitting) return
    this.optionalDecisionRequestKey = ''
    this.setData({
      optionalDecisionPanelOpen: false,
      optionalDecision: '',
      optionalDecisionComment: ''
    })
  },

  async confirmOptionalDecision() {
    if (this.data.optionalDecisionSubmitting || !this.data.optionalDecisionPanelOpen) return false
    const node = this.data.currentNode
    const line = this.data.line
    const decision = this.data.optionalDecision
    const comment = this.data.optionalDecisionComment.trim()
    if (!node || !line || !node.canDecideOptionalTail || !['activate', 'skip'].includes(decision)) return false
    if (decision === 'skip' && !comment) {
      wx.showToast({ title: '请填写不启用原因', icon: 'none' })
      return false
    }
    if (!this.optionalDecisionRequestKey) this.optionalDecisionRequestKey = newRequestKey('optional-tail')
    const actorId = this.actorId
    const lineId = line._id
    const lineVersion = line.version
    const nodeId = node._id
    const nodeVersion = node.version
    this.setData({ optionalDecisionSubmitting: true })
    try {
      await businessService.decideOptionalTailNode({
        businessLineId: lineId,
        nodeId,
        expectedLineVersion: lineVersion,
        expectedNodeVersion: nodeVersion,
        decision,
        comment,
        requestKey: this.optionalDecisionRequestKey
      })
      if (!this.pageAlive || !this.actorStillCurrent() || this.actorId !== actorId || this.data.id !== lineId) return false
      this.optionalDecisionRequestKey = ''
      this.setData({ optionalDecisionPanelOpen: false, optionalDecision: '', optionalDecisionComment: '' })
      wx.showToast({ title: decision === 'activate' ? '追加节点已启用' : '售后已完成', icon: 'success' })
      await this.loadDetail()
      return true
    } catch (error) {
      if (this.pageAlive && this.actorStillCurrent() && this.actorId === actorId && this.data.id === lineId) {
        if (error.code === 'VERSION_CONFLICT') await this.loadDetail()
        wx.showToast({ title: safeErrorMessage(error, '追加节点决定失败，请稍后重试'), icon: 'none' })
      }
      return false
    } finally {
      if (this.pageAlive && activeUser() && activeUser()._id === actorId && this.data.id === lineId) {
        this.setData({ optionalDecisionSubmitting: false })
      }
    }
  },

  async createNodeShare(event) {
    const index = Number(event.currentTarget.dataset.index)
    const node = this.data.nodes[index]
    if (!node || !node.canShareResult || this.data.shareCreatingNodeId) return
    const actorId = this.actorId
    const lineId = this.data.id
    if (!this.shareRequestKeys) this.shareRequestKeys = new Map()
    const requestKey = this.shareRequestKeys.get(node._id) || newRequestKey('share')
    this.shareRequestKeys.set(node._id, requestKey)
    this.setData({ shareCreatingNodeId: node._id })
    try {
      const result = await businessService.createNodeShareSnapshot({
        businessLineId: lineId, nodeId: node._id, requestKey
      })
      if (!this.pageAlive || !this.actorStillCurrent() || this.actorId !== actorId || this.data.id !== lineId) return
      this.shareRequestKeys.delete(node._id)
      wx.navigateTo({ url: result.path })
    } catch (error) {
      if (this.pageAlive && this.actorStillCurrent() && this.actorId === actorId && this.data.id === lineId) {
        wx.showToast({ title: safeErrorMessage(error, '生成分享快照失败，请稍后重试'), icon: 'none' })
      }
    } finally {
      if (this.pageAlive && activeUser() && activeUser()._id === actorId && this.data.id === lineId) {
        this.setData({ shareCreatingNodeId: '' })
      }
    }
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
    const requestedActorId = this.actorId
    const requestedBusinessLineId = this.data.id
    const requestedCurrentVersion = this.data.currentNode.version
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
      if (!this.pageAlive || !this.actorStillCurrent() || activeUser()._id !== requestedActorId ||
          this.data.id !== requestedBusinessLineId || this.data.currentNode.version !== requestedCurrentVersion) return
      this.rejectionRequestKey = ''
      this.setData({ rejectionReason: '' })
      wx.showToast({ title: '已驳回上一节点', icon: 'success' })
      await this.loadDetail()
    } catch (error) {
      if (!this.pageAlive || !activeUser() || activeUser()._id !== requestedActorId ||
          this.data.id !== requestedBusinessLineId) return
      if (error.code === 'VERSION_CONFLICT') {
        await this.loadDetail()
        wx.showToast({ title: '节点版本已变化，请核对后重试', icon: 'none' })
      } else {
        wx.showToast({ title: safeErrorMessage(error, '驳回失败，请稍后重试'), icon: 'none' })
      }
    } finally {
      if (this.pageAlive && activeUser() && activeUser()._id === requestedActorId &&
          this.data.id === requestedBusinessLineId) this.setData({ rejecting: false })
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
    const requestedActorId = this.actorId
    const requestedBusinessLineId = this.data.id
    const requestedLineVersion = this.data.line.version
    this.setData({ closing: true })
    try {
      await businessService.closeBusinessLine({
        businessLineId: this.data.id,
        expectedVersion: this.data.line.version,
        outcome,
        reason
      })
      if (!this.pageAlive || !this.actorStillCurrent() || activeUser()._id !== requestedActorId ||
          this.data.id !== requestedBusinessLineId || this.data.line.version !== requestedLineVersion) return
      this.setData({ closureReason: '' })
      wx.showToast({ title: '售后状态已更新', icon: 'success' })
      await this.loadDetail()
    } catch (error) {
      if (!this.pageAlive || !activeUser() || activeUser()._id !== requestedActorId ||
          this.data.id !== requestedBusinessLineId) return
      if (error.code === 'VERSION_CONFLICT') await this.loadDetail()
      wx.showToast({
        title: error.code === 'VERSION_CONFLICT'
          ? '售后版本已变化，请核对后重试'
          : safeErrorMessage(error, '操作失败，请稍后重试'),
        icon: 'none'
      })
    } finally {
      if (this.pageAlive && activeUser() && activeUser()._id === requestedActorId &&
          this.data.id === requestedBusinessLineId) this.setData({ closing: false })
    }
  },

  openAmendment() {
    if (!this.data.showAmendmentEntry) return
    wx.navigateTo({ url: `/pages/admin-business-amend/index?id=${encodeURIComponent(this.data.id)}` })
  }
})
