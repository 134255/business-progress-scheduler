const service = require('../../services/business')
const { isAccountAccessError } = require('../../utils/safe-error')

function identity() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? `${user._id}:${user.role}` : ''
}
function dateText(value) {
  const date = value && new Date(value)
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN') : '时间未留存'
}
function valueText(value) {
  if (value === null || value === undefined || value === '') return '未填写'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return Array.isArray(value) ? value.join('、') || '未填写' : String(value)
}
const fields = values => (values || []).map(field => ({ ...field, valueText: valueText(field.value) }))
const votes = values => (values || []).map((vote, index) => ({ ...vote, key: index,
  decisionText: vote.decision === 'approved' ? '通过' : '驳回',
  commentText: vote.comment || '未填写审核意见', timeText: dateText(vote.createdAt) }))
function evidences(values) {
  return (values || []).map(item => {
    const expired = item.purgeDueAt && new Date(item.purgeDueAt).getTime() <= Date.now()
    return { ...item, unavailable: item.storageStatus !== 'available' || Boolean(expired),
      stateText: item.storageStatus === 'purged' ? '已清理' : expired ? '已过期' : item.storageStatus === 'available' ? '查看' : '暂不可用' }
  })
}
function emptySelection() {
  return { selectedId: '', result: null, resultLoading: false, resultError: '', historyOpen: false,
    history: [], historyLoading: false, historyLoaded: false, historyError: '',
    reviewsOpen: false, rounds: [], reviewsLoading: false, reviewsLoaded: false, reviewsError: '',
    hasMore: false, beforeRoundNumber: null, videoPreview: null, previewLoading: false }
}

Component({
  properties: { businessLineId: String, nodeId: String, enabled: Boolean,
    returnLabel: { type: String, value: '返回当前填写' } },
  data: { opened: false, nodes: [], listLoading: false, listError: '', ...emptySelection() },
  observers: {
    'businessLineId, nodeId, enabled'() { if (this.alive) this.reset() }
  },
  lifetimes: {
    attached() { this.alive = true; this.hidden = false; this.actor = identity(); this.sequence = 0 },
    detached() { this.reset(); this.alive = false }
  },
  pageLifetimes: {
    hide() { this.hidden = true; this.reset() },
    show() { this.hidden = false; this.checkAccess() }
  },
  methods: {
    reset(callback) {
      this.sequence = (this.sequence || 0) + 1
      this.previewSequence = (this.previewSequence || 0) + 1
      this.setData({ opened: false, nodes: [], listLoading: false, listError: '', ...emptySelection() }, callback)
    },
    checkAccess() {
      if (!this.alive || this.hidden || !this.data.enabled || !this.actor || identity() !== this.actor) {
        this.reset()
        return false
      }
      return true
    },
    current(sequence) { return this.checkAccess() && sequence === this.sequence },
    handleError(error, update) {
      if (isAccountAccessError(error)) this.reset()
      else this.setData(update)
    },
    async toggleSection() {
      if (!this.checkAccess()) return
      if (this.data.opened) return this.reset()
      this.setData({ opened: true })
      await this.loadNodes()
    },
    returnToCurrent() {
      if (!this.checkAccess()) return
      this.reset(() => { if (this.checkAccess()) this.triggerEvent('returntocurrent') })
    },
    async loadNodes() {
      if (!this.checkAccess() || this.data.listLoading) return
      const sequence = ++this.sequence
      this.setData({ listLoading: true, listError: '' })
      try {
        const detail = await service.getBusinessLine(this.data.businessLineId)
        if (!this.current(sequence)) return
        let nodes = (detail.nodes || []).slice()
        if (detail.line.flowSchemaVersion === 2) {
          const route = (detail.line.traversedNodeIds || []).slice()
          if (!route.includes(detail.line.currentNodeId)) route.push(detail.line.currentNodeId)
          const byId = new Map(nodes.map(node => [node._id, node]))
          nodes = route.map(id => byId.get(id)).filter(Boolean)
        } else nodes.sort((left, right) => left.sequence - right.sequence)
        const anchor = nodes.findIndex(node => node._id === this.data.nodeId)
        if (anchor < 0 || detail.line._id !== this.data.businessLineId) throw new Error('invalid route')
        this.setData({ nodes: nodes.slice(0, anchor).filter(node => node.status === 'completed' &&
          (detail.line.flowSchemaVersion !== 2 || node.routeState === 'completed'))
          .map(node => ({ _id: node._id, name: node.name, nodeCode: node.nodeCode, workflowMode: node.workflowMode })) })
      } catch (error) {
        if (this.current(sequence)) this.handleError(error, { listError: '前序节点加载失败，请重试' })
      } finally { if (this.current(sequence)) this.setData({ listLoading: false }) }
    },
    async toggleNode(event) {
      if (!this.checkAccess()) return
      const id = event.currentTarget.dataset.id
      if (!this.data.nodes.some(node => node._id === id)) return
      this.sequence += 1
      this.setData({ ...emptySelection(), selectedId: this.data.selectedId === id ? '' : id })
      if (this.data.selectedId) await this.loadResult()
    },
    async loadResult() {
      if (!this.checkAccess() || !this.data.selectedId || this.data.resultLoading) return
      const sequence = this.sequence
      this.setData({ resultLoading: true, resultError: '' })
      try {
        const result = await service.getPreviousNodeResult({ businessLineId: this.data.businessLineId,
          anchorNodeId: this.data.nodeId, nodeId: this.data.selectedId })
        if (!this.current(sequence)) return
        if (!result || result.nodeId !== this.data.selectedId) throw new Error('invalid result')
        this.setData({ result: { ...result, fields: fields(result.fieldValues), evidences: evidences(result.evidences),
          votes: votes(result.votes), submittedAtText: dateText(result.submittedAt), completedAtText: dateText(result.completedAt) } })
      } catch (error) {
        if (this.current(sequence)) this.handleError(error, { result: null, resultError: '最终结果暂时无法查看。可重试或展开历史记录，不将草稿当作最终结果。' })
      } finally { if (this.current(sequence)) this.setData({ resultLoading: false }) }
    },
    async toggleHistory() {
      if (!this.checkAccess() || !this.data.selectedId) return
      this.closeVideo()
      this.setData({ historyOpen: !this.data.historyOpen })
      if (this.data.historyOpen && !this.data.historyLoaded) await this.loadHistory()
    },
    toggleEntry(event) {
      if (!this.checkAccess() || !this.data.historyOpen) return
      this.closeVideo()
      const id = event.currentTarget.dataset.id
      this.setData({ history: this.data.history.map(entry => entry.feedbackId === id ? { ...entry, opened: !entry.opened } : entry) })
    },
    async loadHistory() {
      if (!this.checkAccess() || !this.data.selectedId || this.data.historyLoading) return
      const sequence = this.sequence
      this.setData({ historyLoading: true, historyError: '' })
      try {
        const history = await service.getNodeHistory(this.data.businessLineId, this.data.selectedId)
        if (!this.current(sequence)) return
        this.setData({ historyLoaded: true, history: (history.history || []).map(item => ({
          feedbackId: item.feedbackId, opened: false, comment: item.comment || '暂无处理说明', submittedByLabel: item.submittedByLabel || '处理人姓名未留存',
          timeText: dateText(item.submittedAt), statusText: ({ completed: '完成', in_progress: '保存进度', blocked: '受阻' })[item.status] || item.status,
          fields: fields(item.fieldValues), evidences: evidences(item.evidences) })) })
      } catch (error) {
        if (this.current(sequence)) this.handleError(error, { historyError: '历史记录加载失败，请重试' })
      } finally { if (this.current(sequence)) this.setData({ historyLoading: false }) }
    },
    formatRounds(items) {
      return (items || []).map(item => ({ ...item, opened: false, votes: votes(item.votes), timeText: dateText(item.submittedAt),
        statusText: ({ approved: '通过', rejected: '驳回', pending: '审核中', cancelled: '已取消', superseded: '已被替代' })[item.status] || item.status }))
    },
    async toggleReviews() {
      if (!this.checkAccess() || !this.data.selectedId) return
      const selected = this.data.nodes.find(node => node._id === this.data.selectedId)
      if (!selected || selected.workflowMode !== 'review') return
      this.setData({ reviewsOpen: !this.data.reviewsOpen })
      if (this.data.reviewsOpen && !this.data.reviewsLoaded) await this.loadReviews()
    },
    toggleRound(event) {
      if (!this.checkAccess() || !this.data.reviewsOpen) return
      const id = event.currentTarget.dataset.id
      this.setData({ rounds: this.data.rounds.map(round => round.reviewRoundId === id ? { ...round, opened: !round.opened } : round) })
    },
    async loadMoreReviews() {
      if (!this.data.reviewsLoaded || !this.data.hasMore) return
      await this.loadReviews()
    },
    async loadReviews() {
      if (!this.checkAccess() || !this.data.reviewsOpen || this.data.reviewsLoading ||
          this.data.reviewsLoaded && !this.data.hasMore) return
      const sequence = this.sequence
      const beforeRoundNumber = this.data.reviewsLoaded ? this.data.beforeRoundNumber : undefined
      this.setData({ reviewsLoading: true, reviewsError: '' })
      try {
        const result = await service.listNodeReviewHistory({ businessLineId: this.data.businessLineId, nodeId: this.data.selectedId,
          pageSize: 5, ...(beforeRoundNumber !== undefined ? { beforeRoundNumber } : {}) })
        if (!this.current(sequence)) return
        const existing = new Set(this.data.rounds.map(round => round.reviewRoundId))
        this.setData({ reviewsLoaded: true, rounds: this.data.rounds.concat(this.formatRounds(result.items).filter(round => !existing.has(round.reviewRoundId))),
          hasMore: Boolean(result.hasMore), beforeRoundNumber: result.nextBeforeRoundNumber })
      } catch (error) {
        if (this.current(sequence)) this.handleError(error, { reviewsError: '审核记录加载失败，请重试' })
      } finally { if (this.current(sequence)) this.setData({ reviewsLoading: false }) }
    },
    async previewEvidence(event) {
      if (!this.checkAccess()) return
      const id = event.currentTarget.dataset.id
      const allowed = [...(this.data.result && this.data.result.evidences || []),
        ...(this.data.historyOpen ? this.data.history.filter(item => item.opened).flatMap(item => item.evidences) : [])]
      if (!allowed.some(item => item.evidenceId === id && !item.unavailable)) return
      const sequence = this.sequence
      const previewSequence = this.previewSequence = (this.previewSequence || 0) + 1
      const current = () => this.current(sequence) && this.previewSequence === previewSequence
      this.setData({ previewLoading: true, videoPreview: null })
      try {
        const grant = await service.getEvidenceAccess(id)
        if (!current()) return
        if (grant.category === 'image') wx.previewImage({ current: grant.url, urls: [grant.url] })
        else if (grant.category === 'video') this.setData({ videoPreview: grant })
        else if (grant.category === 'pdf') {
          const file = await wx.downloadFile({ url: grant.url })
          if (current() && file.statusCode === 200) await wx.openDocument({ filePath: file.tempFilePath, fileType: 'pdf', showMenu: true })
        }
      } catch (error) {
        // Cancelling display does not cancel an authoritative access denial for
        // this node/session. Unrelated old-node responses must still be ignored.
        if (this.current(sequence) && isAccountAccessError(error)) this.reset()
        else if (current()) { this.setData({ videoPreview: null }); wx.showToast({ title: '凭证暂时无法打开或已过期', icon: 'none' }) }
      } finally { if (current()) this.setData({ previewLoading: false }) }
    },
    closeVideo() { this.previewSequence = (this.previewSequence || 0) + 1; this.setData({ videoPreview: null, previewLoading: false }) },
    onVideoError() {
      if (!this.checkAccess() || !this.data.videoPreview) return
      this.closeVideo()
      wx.showToast({ title: '视频暂时无法播放，请重试', icon: 'none' })
    },
    stopTouchMove() {}
  }
})
