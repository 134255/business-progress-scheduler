const businessService = require('../../services/business')
const { toCsv } = require('../../utils/csv')

const COLUMNS = Object.freeze([
  ['businessCode', '业务编号'], ['businessName', '业务名称'], ['businessStatus', '业务状态'],
  ['nodeCode', '节点编号'], ['nodeName', '节点名称'], ['nodeStatus', '节点状态'],
  ['workflowMode', '流程模式'], ['reviewMode', '审核模式'],
  ['processorDisplayNames', '处理人'], ['reviewerDisplayNames', '审核人'],
  ['processingRoundNumber', '处理轮次'], ['reviewRoundNumber', '审核轮次'],
  ['submittedForReviewAt', '提交审核时间'], ['processingDueStatus', '处理截止状态'],
  ['processingDueAt', '处理截止时间'], ['processingOverdueWorkMinutes', '处理逾期工作分钟'],
  ['processingElapsedWorkMinutes', '处理累计工作分钟'],
  ['reviewDueStatus', '审核截止状态'], ['reviewDueAt', '审核截止时间'],
  ['reviewOverdueWorkMinutes', '审核逾期工作分钟'], ['reviewElapsedWorkMinutes', '审核累计工作分钟'],
  ['businessCreatedAt', '业务创建时间'],
  ['nodeCompletedAt', '节点完成时间']
])

function currentAdminId() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' && user.role === 'super_admin' ? user._id : ''
}

function dateText(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

function writeFile(filePath, data) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({ filePath, data, encoding: 'utf8', success: resolve, fail: reject })
  })
}

function displayDate(value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '未记录'
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 16)}`
}

function timingLabel(timing) {
  if (!timing || timing.recorded !== true) return '历史未记录'
  if (timing.status === 'pending_calendar') return '日历待补算'
  if (timing.status === 'calculated' && Number.isSafeInteger(timing.workMinutes) && timing.workMinutes >= 0) {
    return `${timing.workMinutes} 个工作分钟`
  }
  return '数据暂不可用'
}

function formatTimingItem(item) {
  const roundId = typeof item.roundId === 'string' ? item.roundId : ''
  return {
    ...item,
    roundId,
    assignmentModeLabel: item.processorAssignmentMode === 'business_creator'
      ? '业务发起人'
      : item.processorAssignmentMode === 'fixed_accounts' ? '固定候选处理人' : '历史未记录',
    processingTimingLabel: timingLabel(item.processingTiming),
    processingOverdueLabel: item.processingTiming && item.processingTiming.recorded &&
      Number.isSafeInteger(item.processingTiming.overdueWorkMinutes)
      ? `${item.processingTiming.overdueWorkMinutes} 个工作分钟`
      : '历史未记录',
    reviewStartedAtLabel: displayDate(item.reviewStartedAt),
    expanded: Boolean(item.expanded),
    votes: (Array.isArray(item.votes) ? item.votes : []).map((vote, index) => ({
      ...vote,
      voteKey: `${roundId}-${index}`,
      decisionLabel: vote.decision === 'approved' ? '通过' : vote.decision === 'rejected' ? '驳回' : '未知',
      votedAtLabel: displayDate(vote.votedAt),
      responseTimingLabel: timingLabel(vote.responseTiming)
    }))
  }
}

Page({
  data: {
    startDate: '', endDate: '', statusIndex: 0,
    statusOptions: [
      { label: '全部状态', value: '' }, { label: '进行中', value: 'active' },
      { label: '已完成', value: 'completed' }, { label: '已取消', value: 'cancelled' },
      { label: '已关闭', value: 'closed' }, { label: '已删除', value: 'deleted' }
    ],
    stats: {}, loading: false, exporting: false, errorMessage: '',
    timingItems: [], timingCursor: '', timingHasMore: false,
    timingLoading: false, timingLoadingMore: false, timingError: ''
  },

  onShow() {
    const adminId = currentAdminId()
    if (!adminId) {
      wx.reLaunch({ url: '/pages/dashboard/index' })
      return
    }
    if (!this.data.endDate) {
      const now = new Date()
      this.setData({ endDate: dateText(now), startDate: dateText(new Date(now.getTime() - 29 * 86400000)) })
    }
    return this.refresh(adminId)
  },

  onHide() {
    this.requestSequence = (this.requestSequence || 0) + 1
  },

  onStartDateChange(event) { this.setData({ startDate: event.detail.value }) },
  onEndDateChange(event) { this.setData({ endDate: event.detail.value }) },
  onStatusChange(event) { this.setData({ statusIndex: Number(event.detail.value) || 0 }) },
  applyRange() { return this.refresh(currentAdminId()) },

  currentStatus() {
    const selected = this.data.statusOptions[this.data.statusIndex]
    return selected ? selected.value : ''
  },

  async refresh(adminId = currentAdminId()) {
    if (!adminId) return
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loading: true, timingLoading: true, errorMessage: '', timingError: '' })
    const query = { startDate: this.data.startDate, endDate: this.data.endDate, status: this.currentStatus() }
    const [dashboardResult, timingResult] = await Promise.allSettled([
      businessService.getOperationsDashboard(query),
      businessService.listOperationsTimingDetails({ ...query, cursor: '', pageSize: 20 })
    ])
    if (sequence !== this.requestSequence || currentAdminId() !== adminId) return
    const update = { loading: false, timingLoading: false }
    if (dashboardResult.status === 'fulfilled') update.stats = dashboardResult.value.stats || {}
    else update.errorMessage = '运营看板加载失败，请稍后重试'
    if (timingResult.status === 'fulfilled') {
      update.timingItems = (timingResult.value.items || []).map(formatTimingItem)
      update.timingCursor = timingResult.value.nextCursor || ''
      update.timingHasMore = timingResult.value.hasMore === true
      update.timingError = ''
    } else {
      update.timingError = '个人工时明细加载失败，请稍后重试'
    }
    this.setData(update)
  },

  async loadMoreTiming() {
    if (this.timingPromise) return this.timingPromise
    if (!this.data.timingHasMore || !this.data.timingCursor) return
    const adminId = currentAdminId()
    if (!adminId) return
    const sequence = this.requestSequence || 0
    this.setData({ timingLoadingMore: true, timingError: '' })
    const request = businessService.listOperationsTimingDetails({
      startDate: this.data.startDate, endDate: this.data.endDate, status: this.currentStatus(),
      cursor: this.data.timingCursor, pageSize: 20
    })
    this.timingPromise = request
    try {
      const result = await request
      if (sequence !== this.requestSequence || currentAdminId() !== adminId) return
      const byId = new Map(this.data.timingItems.map(item => [item.roundId, item]))
      for (const item of result.items || []) {
        const formatted = formatTimingItem(item)
        if (formatted.roundId && !byId.has(formatted.roundId)) byId.set(formatted.roundId, formatted)
      }
      this.setData({
        timingItems: [...byId.values()], timingCursor: result.nextCursor || '',
        timingHasMore: result.hasMore === true
      })
    } catch (error) {
      if (sequence === this.requestSequence && currentAdminId() === adminId) {
        this.setData({ timingError: '个人工时明细加载失败，请稍后重试' })
      }
    } finally {
      if (this.timingPromise === request) this.timingPromise = null
      if (sequence === this.requestSequence && currentAdminId() === adminId) {
        this.setData({ timingLoadingMore: false })
      }
    }
  },

  toggleTimingDetail(event) {
    const roundId = event && event.currentTarget && event.currentTarget.dataset.roundId
    if (typeof roundId !== 'string') return
    this.setData({ timingItems: this.data.timingItems.map(item =>
      item.roundId === roundId ? { ...item, expanded: !item.expanded } : item) })
  },

  async exportCsv() {
    if (this.data.exporting) return
    const adminId = currentAdminId()
    if (!adminId) return
    this.setData({ exporting: true, errorMessage: '' })
    try {
      const rows = []
      let cursor = ''
      for (let page = 0; page < 100; page += 1) {
        const result = await businessService.exportOperationsRows({
          startDate: this.data.startDate, endDate: this.data.endDate,
          status: this.currentStatus(), cursor, pageSize: 50
        })
        if (currentAdminId() !== adminId) return
        rows.push(...(result.items || []))
        if (!result.hasMore) break
        if (!result.nextCursor || result.nextCursor === cursor) throw new Error('导出游标异常')
        cursor = result.nextCursor
        if (page === 99) throw new Error('导出数据过多，请缩小日期范围')
      }
      const filePath = `${wx.env.USER_DATA_PATH}/运营数据-${this.data.startDate}-${this.data.endDate}.csv`
      await writeFile(filePath, toCsv(rows, COLUMNS))
      if (currentAdminId() !== adminId) return
      wx.shareFileMessage({ filePath, fileName: `运营数据-${this.data.startDate}-${this.data.endDate}.csv` })
    } catch (error) {
      if (currentAdminId() === adminId) this.setData({ errorMessage: '运营数据导出失败，请稍后重试' })
    } finally {
      if (currentAdminId() === adminId) this.setData({ exporting: false })
    }
  }
})
