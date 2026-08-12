const businessService = require('../../services/business')
const { safeErrorMessage } = require('../../utils/safe-error')

function activeUserId() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user._id : ''
}

function newRequestKey() {
  return `vote-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '未填写'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.length ? value.join('、') : '未填写'
  return String(value)
}

function dueText(detail) {
  if (detail.reviewDueStatus === 'pending_calendar') return '待工作日历补算'
  if (detail.reviewDueStatus !== 'calculated' || !detail.reviewDueAt) return '待计算'
  const date = new Date(detail.reviewDueAt)
  if (Number.isNaN(date.getTime())) return '待计算'
  const overdue = Number(detail.reviewOverdueWorkMinutes || 0)
  return overdue > 0
    ? `${date.toLocaleString('zh-CN')}（已逾期 ${overdue} 个工作分钟）`
    : date.toLocaleString('zh-CN')
}

Page({
  data: {
    reviewRoundId: '', roundVersion: 0, businessLineId: '', nodeId: '',
    businessName: '', businessCode: '', nodeName: '', nodeCode: '', status: '',
    reviewModeLabel: '', reviewRoundNumber: 0, processorNamesText: '', reviewerNamesText: '',
    voteProgressText: '', submittedAtText: '', dueText: '待计算', fields: [], evidences: [], votes: [],
    canApprove: false, canReject: false, comment: '', loading: true, submitting: false,
    errorMessage: '', videoPreview: null
  },

  async onLoad(query = {}) {
    const actorId = activeUserId()
    if (!actorId) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.pageAlive = true
    this.actorId = actorId
    this.requestSequence = 0
    this.setData({ reviewRoundId: String(query.reviewRoundId || '') })
    await this.loadDetail()
  },

  onShow() {
    if (this.data.reviewRoundId && this.hasLoaded) return this.loadDetail()
  },

  onUnload() {
    this.pageAlive = false
    this.requestSequence += 1
    this.voteSequence = (this.voteSequence || 0) + 1
  },

  async loadDetail() {
    if (!this.data.reviewRoundId) return
    const requestedActorId = this.actorId
    const requestSequence = ++this.requestSequence
    this.setData({ loading: true, errorMessage: '' })
    try {
      const detail = await businessService.getReviewDetail(this.data.reviewRoundId)
      if (!this.pageAlive || activeUserId() !== requestedActorId || requestSequence !== this.requestSequence) return
      const business = await businessService.getBusinessLine(detail.businessLineId)
      if (!this.pageAlive || activeUserId() !== requestedActorId || requestSequence !== this.requestSequence) return
      const node = (business.nodes || []).find(item => item._id === detail.nodeId) || {}
      const reviewers = Array.isArray(node.reviewerDisplayNames) ? node.reviewerDisplayNames : []
      const votes = (detail.votes || []).map((vote, index) => ({
        ...vote,
        voteKey: `${index}-${vote.createdAt || ''}`,
        decisionLabel: vote.decision === 'approved' ? '通过' : '驳回',
        createdAtText: vote.createdAt ? new Date(vote.createdAt).toLocaleString('zh-CN') : ''
      }))
      this.setData({
        reviewRoundId: detail.reviewRoundId,
        roundVersion: Number(detail.version || 0),
        businessLineId: detail.businessLineId,
        nodeId: detail.nodeId,
        businessName: detail.businessName || '', businessCode: detail.businessCode || '',
        nodeName: detail.nodeName || '', nodeCode: detail.nodeCode || '', status: detail.status,
        reviewModeLabel: detail.reviewMode === 'all' ? '会签' : '或签',
        reviewRoundNumber: Number(detail.reviewRoundNumber || 0),
        processorNamesText: Array.isArray(node.processorDisplayNames) ? node.processorDisplayNames.join('、') : '',
        reviewerNamesText: reviewers.join('、'),
        voteProgressText: `${votes.length}/${reviewers.length}`,
        submittedAtText: detail.submittedAt ? new Date(detail.submittedAt).toLocaleString('zh-CN') : '',
        dueText: dueText(detail),
        fields: (detail.fieldValues || []).map(field => ({ ...field, valueText: valueText(field.value) })),
        evidences: (detail.evidences || []).map((item, index) => ({ ...item, sequence: index + 1 })),
        votes,
        canApprove: Boolean(detail.canApprove), canReject: Boolean(detail.canReject)
      })
      this.hasLoaded = true
      wx.setNavigationBarTitle({ title: detail.nodeName || '审核详情' })
    } catch (error) {
      if (this.pageAlive && activeUserId() === requestedActorId && requestSequence === this.requestSequence) {
        this.setData({
          errorMessage: safeErrorMessage(error, '审核详情加载失败，请稍后重试'),
          canApprove: false,
          canReject: false
        })
      }
    } finally {
      if (this.pageAlive && activeUserId() === requestedActorId && requestSequence === this.requestSequence) {
        this.setData({ loading: false })
      }
    }
  },

  onComment(event) {
    if (this.data.submitting || this.data.status !== 'pending') return
    this.setData({ comment: event.detail.value, errorMessage: '' })
  },

  onApprove() { return this.submitVote('approve') },

  onReject() {
    if (!this.data.comment.trim()) {
      this.setData({ errorMessage: '请填写驳回原因' })
      return
    }
    return this.submitVote('reject')
  },

  async submitVote(decision) {
    const allowed = decision === 'approve' ? this.data.canApprove : this.data.canReject
    if (!allowed || this.data.submitting || this.data.status !== 'pending') return
    const requestedActorId = this.actorId
    const requestedRoundVersion = this.data.roundVersion
    const comment = this.data.comment.trim()
    const voteSequence = (this.voteSequence || 0) + 1
    this.voteSequence = voteSequence
    const intent = JSON.stringify([decision, requestedRoundVersion, comment])
    if (this.voteIntent !== intent) {
      this.voteIntent = intent
      this.voteRequestKey = newRequestKey()
    }
    this.setData({ submitting: true, errorMessage: '' })
    try {
      await businessService.submitReviewVote({
        reviewRoundId: this.data.reviewRoundId,
        expectedRoundVersion: requestedRoundVersion,
        decision,
        comment,
        requestKey: this.voteRequestKey
      })
      if (!this.pageAlive || activeUserId() !== requestedActorId || this.data.roundVersion !== requestedRoundVersion) return
      this.voteIntent = ''
      this.voteRequestKey = ''
      await this.loadDetail()
    } catch (error) {
      if (this.pageAlive && activeUserId() === requestedActorId && this.data.roundVersion === requestedRoundVersion) {
        this.setData({ errorMessage: safeErrorMessage(error, '审核意见提交失败，请稍后重试') })
      }
    } finally {
      if (this.pageAlive && activeUserId() === requestedActorId && this.voteSequence === voteSequence) {
        this.setData({ submitting: false })
      }
    }
  },

  async previewEvidence(event) {
    const evidenceId = String(event.currentTarget.dataset.id || '')
    if (!this.data.evidences.some(item => item.evidenceId === evidenceId)) return
    try {
      const grant = await businessService.getEvidenceAccess(evidenceId)
      if (!this.pageAlive || activeUserId() !== this.actorId) return
      if (grant.category === 'image') wx.previewImage({ current: grant.url, urls: [grant.url] })
      else if (grant.category === 'video') this.setData({ videoPreview: grant })
      else if (grant.category === 'pdf') {
        const downloaded = await wx.downloadFile({ url: grant.url })
        if (!this.pageAlive || activeUserId() !== this.actorId) return
        await wx.openDocument({ filePath: downloaded.tempFilePath, fileType: 'pdf', showMenu: true })
      }
    } catch (error) {
      wx.showToast({ title: '凭证暂时无法打开', icon: 'none' })
    }
  },

  closeVideoPreview() { this.setData({ videoPreview: null }) }
})
