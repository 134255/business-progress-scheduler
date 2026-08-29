const businessService = require('../../services/business')
const { toCsv } = require('../../utils/csv')

const DAY_MS = 24 * 60 * 60 * 1000
const CSV_COLUMNS = Object.freeze([
  ['businessCode', '售后编号'], ['businessName', '售后名称'], ['businessStatus', '售后状态'],
  ['nodeCode', '节点编号'], ['nodeName', '节点名称'], ['nodeStatus', '节点状态'],
  ['workflowMode', '流程模式'], ['reviewMode', '审核模式'],
  ['processorDisplayNames', '处理人'], ['reviewerDisplayNames', '审核人'],
  ['processingRoundNumber', '处理轮次'], ['reviewRoundNumber', '审核轮次'],
  ['submittedForReviewAt', '提交审核时间'], ['processingDueStatus', '处理截止状态'],
  ['processingDueAt', '处理截止时间'], ['processingOverdueWorkMinutes', '处理逾期工作分钟'],
  ['processingElapsedWorkMinutes', '处理累计工作分钟'], ['reviewDueStatus', '审核截止状态'],
  ['reviewDueAt', '审核截止时间'], ['reviewOverdueWorkMinutes', '审核逾期工作分钟'],
  ['reviewElapsedWorkMinutes', '审核累计工作分钟'], ['businessCreatedAt', '售后创建时间'],
  ['nodeCompletedAt', '节点完成时间']
])

function currentActiveUser() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user : null
}

function dateText(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

function metricText(metric) {
  return metric && metric.averageMinutes !== null && metric.averageMinutes !== undefined
    ? `${metric.averageMinutes} 分钟`
    : '暂无有效样本'
}

function minuteLabel(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${value} 分钟`
    : '历史未记录'
}

function formatSampleResult(result) {
  const statistics = result && result.statistics && typeof result.statistics === 'object'
    ? result.statistics
    : {}
  const items = Array.isArray(result && result.items) ? result.items : []
  return {
    ...result,
    statistics: {
      ...statistics,
      averageLabel: minuteLabel(statistics.averageMinutes),
      medianLabel: minuteLabel(statistics.medianMinutes),
      minimumLabel: minuteLabel(statistics.minimumMinutes),
      maximumLabel: minuteLabel(statistics.maximumMinutes)
    },
    items: items.map(item => ({
      ...item,
      workMinutesLabel: minuteLabel(item.workMinutes),
      rounds: (Array.isArray(item.rounds) ? item.rounds : []).map(round => ({
        ...round,
        processingWorkMinutesLabel: minuteLabel(round.processingWorkMinutes),
        reviewWorkMinutesLabel: minuteLabel(round.reviewWorkMinutes),
        votes: (Array.isArray(round.votes) ? round.votes : []).map(vote => ({
          ...vote,
          responseWorkMinutesLabel: minuteLabel(vote.responseWorkMinutes)
        }))
      }))
    }))
  }
}

function barWidth(value, maximum) {
  const number = Number(value || 0)
  if (!(number > 0) || !(maximum > 0)) return '0%'
  return `${Math.max(4, Math.round(number * 100 / maximum))}%`
}

function option(label, value) { return { label, value } }

function writeFile(filePath, data) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({ filePath, data, encoding: 'utf8', success: resolve, fail: reject })
  })
}

Page({
  data: {
    isAdmin: false,
    currentStats: null,
    exporting: false,
    loading: false,
    errorMessage: '',
    startDate: '',
    endDate: '',
    grainIndex: 1,
    grainOptions: [option('按日', 'day'), option('按周', 'week'), option('按月', 'month')],
    templateIndex: 0,
    templateOptions: [],
    versionIndex: 0,
    versionOptions: [option('合并全部版本', '')],
    statusIndex: 0,
    statusOptions: [
      option('全部状态', ''), option('进行中', 'active'), option('已完成', 'completed'),
      option('已取消', 'cancelled'), option('已关闭', 'closed'), option('已删除', 'deleted')
    ],
    nodeIndex: 0,
    nodeOptions: [option('全部节点', '')],
    businessIndex: 0,
    businessOptions: [option('全部可访问售后', '')],
    processorIndex: 0,
    processorOptions: [option('全部处理人', '')],
    reviewerIndex: 0,
    reviewerOptions: [option('全部审核人', '')],
    advancedOpen: false,
    advancedFilterCount: 0,
    advancedFilterLabel: '',
    summary: null,
    nodeSeries: [],
    trendSeries: [],
    samples: null,
    sampleTitle: '',
    sampleLoading: false
  },

  onShow() {
    const user = currentActiveUser()
    if (!user) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.sampleSequence = (this.sampleSequence || 0) + 1
    this.setData({ isAdmin: user.role === 'super_admin', sampleLoading: false, samples: null })
    if (!this.data.endDate) {
      const now = new Date()
      this.setData({ endDate: dateText(now), startDate: dateText(new Date(now.getTime() - 29 * DAY_MS)) })
    }
    return this.loadInitial(user._id)
  },

  onHide() {
    this.requestSequence = (this.requestSequence || 0) + 1
    this.sampleSequence = (this.sampleSequence || 0) + 1
  },

  selected(options, index) {
    const item = options[index]
    return item ? item.value : ''
  },

  query(overrides = {}) {
    const version = this.selected(this.data.versionOptions, this.data.versionIndex)
    return {
      startDate: this.data.startDate,
      endDate: this.data.endDate,
      grain: this.selected(this.data.grainOptions, this.data.grainIndex) || 'week',
      templateId: this.selected(this.data.templateOptions, this.data.templateIndex),
      ...(version ? { templateVersion: Number(version) } : {}),
      status: this.selected(this.data.statusOptions, this.data.statusIndex),
      stableNodeId: this.selected(this.data.nodeOptions, this.data.nodeIndex),
      businessLineId: this.selected(this.data.businessOptions, this.data.businessIndex),
      processorToken: this.selected(this.data.processorOptions, this.data.processorIndex),
      reviewerToken: this.selected(this.data.reviewerOptions, this.data.reviewerIndex),
      ...overrides
    }
  },

  async loadInitial(userId) {
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loading: true, errorMessage: '' })
    try {
      if (this.data.isAdmin) {
        try {
          const current = await businessService.getOperationsDashboard({
            startDate: this.data.startDate, endDate: this.data.endDate, status: ''
          })
          if (!this.isCurrentRequest(sequence, userId)) return
          this.setData({ currentStats: current.stats || null })
        } catch (error) {
          if (!this.isCurrentRequest(sequence, userId)) return
          this.setData({ currentStats: null })
        }
      }
      const first = await businessService.getOperationsAnalyticsFilters({
        startDate: this.data.startDate, endDate: this.data.endDate, grain: 'week'
      })
      if (!this.isCurrentRequest(sequence, userId)) return
      const templates = (first.templates || []).map(item => option(item.templateName, item.templateId))
      this.setData({ templateOptions: templates, templateIndex: 0 })
      if (!templates.length) {
        this.setData({ loading: false, summary: null, nodeSeries: [], trendSeries: [] })
        return
      }
      await this.loadTemplateFilters(sequence, userId)
      await this.loadSummary(sequence, userId)
    } catch (error) {
      if (this.isCurrentRequest(sequence, userId)) {
        this.setData({ loading: false, errorMessage: '历史统计加载失败，请稍后重试' })
      }
    }
  },

  isCurrentRequest(sequence, userId) {
    const user = currentActiveUser()
    return sequence === this.requestSequence && user && user._id === userId
  },

  async loadTemplateFilters(sequence = this.requestSequence, userId = currentActiveUser() && currentActiveUser()._id) {
    const result = await businessService.getOperationsAnalyticsFilters(this.query())
    if (!this.isCurrentRequest(sequence, userId)) return
    this.setData({
      versionOptions: [option('合并全部版本', ''), ...(result.templateVersions || []).map(value => option(`第 ${value} 版`, String(value)))],
      versionIndex: 0,
      nodeOptions: [option('全部节点', ''), ...(result.stableNodes || []).map(item => option(item.nodeName, item.stableNodeId))],
      nodeIndex: 0,
      businessOptions: [option('全部可访问售后', ''), ...(result.businesses || []).map(item => option(`${item.businessCode} · ${item.businessName}`, item.businessLineId))],
      businessIndex: 0,
      processorOptions: [option('全部处理人', ''), ...(result.processors || []).map(item => option(item.displayName, item.token))],
      processorIndex: 0,
      reviewerOptions: [option('全部审核人', ''), ...(result.reviewers || []).map(item => option(item.displayName, item.token))],
      reviewerIndex: 0,
      advancedFilterCount: 0,
      advancedFilterLabel: ''
    })
  },

  formatSeries(summary) {
    const nodes = Array.isArray(summary.nodeSeries) ? summary.nodeSeries : []
    const maximum = Math.max(1, ...nodes.flatMap(item => [
      Number(item.processing && item.processing.averageMinutes || 0),
      Number(item.review && item.review.averageMinutes || 0)
    ]))
    return nodes.map(item => ({
      ...item,
      processingLabel: metricText(item.processing),
      reviewLabel: metricText(item.review),
      processingWidth: barWidth(item.processing && item.processing.averageMinutes, maximum),
      reviewWidth: barWidth(item.review && item.review.averageMinutes, maximum)
    }))
  },

  formatTrend(summary) {
    const rows = Array.isArray(summary.trendSeries) ? summary.trendSeries : []
    const maximum = Math.max(1, ...rows.flatMap(item => [
      Number(item.processing && item.processing.averageMinutes || 0),
      Number(item.review && item.review.averageMinutes || 0)
    ]))
    return rows.map(item => ({
      ...item,
      processingLabel: metricText(item.processing),
      reviewLabel: metricText(item.review),
      processingWidth: barWidth(item.processing && item.processing.averageMinutes, maximum),
      reviewWidth: barWidth(item.review && item.review.averageMinutes, maximum)
    }))
  },

  async loadSummary(sequence = this.requestSequence, userId = currentActiveUser() && currentActiveUser()._id) {
    const result = await businessService.getOperationsAnalyticsSummary(this.query())
    if (!this.isCurrentRequest(sequence, userId)) return
    const metrics = result.templateMetrics || {}
    this.setData({
      loading: false,
      errorMessage: '',
      summary: {
        ...result,
        businessCompletionLabel: metricText(metrics.businessCompletion),
        businessCompletionSampleLabel: `样本 ${Number(metrics.businessCompletion && metrics.businessCompletion.sampleCount || 0)}`,
        nodeProcessingLabel: metricText(metrics.nodeProcessingPerBusiness),
        nodeProcessingSampleLabel: `样本 ${Number(metrics.nodeProcessingPerBusiness && metrics.nodeProcessingPerBusiness.sampleCount || 0)}`,
        reviewLabel: metricText(metrics.reviewPerBusiness),
        reviewSampleLabel: `样本 ${Number(metrics.reviewPerBusiness && metrics.reviewPerBusiness.sampleCount || 0)}`,
        optionalTailActivationLabel: result.optionalTail && result.optionalTail.activationRatePercent !== null &&
          result.optionalTail.activationRatePercent !== undefined
          ? `${result.optionalTail.activationRatePercent}%`
          : '暂无有效样本',
        optionalTailActivationSampleLabel: `决定 ${Number(result.optionalTail && result.optionalTail.decisionCount || 0)} 次`,
        optionalTailDecisionLabel: result.optionalTail && result.optionalTail.averageDecisionMinutes !== null &&
          result.optionalTail.averageDecisionMinutes !== undefined
          ? `${result.optionalTail.averageDecisionMinutes} 分钟`
          : '暂无有效样本',
        optionalTailDecisionSampleLabel: `有效样本 ${Number(result.optionalTail && result.optionalTail.decisionCount || 0)}`
      },
      nodeSeries: this.formatSeries(result),
      trendSeries: this.formatTrend(result),
      samples: null
    })
  },

  async applyFilters() {
    const user = currentActiveUser()
    if (!user || this.data.loading) return
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loading: true, errorMessage: '' })
    try { await this.loadSummary(sequence, user._id) } catch (error) {
      if (this.isCurrentRequest(sequence, user._id)) {
        this.setData({ loading: false, errorMessage: '历史统计加载失败，请稍后重试' })
      }
    }
  },

  async onTemplateChange(event) {
    this.setData({ templateIndex: Number(event.detail.value) || 0 })
    const user = currentActiveUser()
    if (!user) return
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loading: true })
    try {
      await this.loadTemplateFilters(sequence, user._id)
      await this.loadSummary(sequence, user._id)
    } catch (error) {
      if (this.isCurrentRequest(sequence, user._id)) {
        this.setData({ loading: false, errorMessage: '模板统计加载失败，请稍后重试' })
      }
    }
  },

  onStartDateChange(event) { this.setData({ startDate: event.detail.value }) },
  onEndDateChange(event) { this.setData({ endDate: event.detail.value }) },
  onGrainChange(event) { this.setData({ grainIndex: Number(event.detail.value) || 0 }) },
  updateAdvancedCount() {
    const count = [
      this.data.versionIndex, this.data.statusIndex, this.data.nodeIndex,
      this.data.businessIndex, this.data.processorIndex, this.data.reviewerIndex
    ].filter(Boolean).length
    this.setData({ advancedFilterCount: count, advancedFilterLabel: count ? `（已启用 ${count} 项）` : '' })
  },
  onVersionChange(event) { this.setData({ versionIndex: Number(event.detail.value) || 0 }); this.updateAdvancedCount() },
  onStatusChange(event) { this.setData({ statusIndex: Number(event.detail.value) || 0 }); this.updateAdvancedCount() },
  onNodeChange(event) { this.setData({ nodeIndex: Number(event.detail.value) || 0 }); this.updateAdvancedCount() },
  onBusinessChange(event) { this.setData({ businessIndex: Number(event.detail.value) || 0 }); this.updateAdvancedCount() },
  onProcessorChange(event) { this.setData({ processorIndex: Number(event.detail.value) || 0 }); this.updateAdvancedCount() },
  onReviewerChange(event) { this.setData({ reviewerIndex: Number(event.detail.value) || 0 }); this.updateAdvancedCount() },
  toggleAdvanced() { this.setData({ advancedOpen: !this.data.advancedOpen }) },

  currentStatus() { return this.selected(this.data.statusOptions, this.data.statusIndex) },

  async exportCsv() {
    const user = currentActiveUser()
    if (!user || user.role !== 'super_admin' || this.data.exporting) return
    const adminId = user._id
    this.setData({ exporting: true, errorMessage: '' })
    try {
      const rows = []
      let cursor = ''
      for (let page = 0; page < 100; page += 1) {
        const result = await businessService.exportOperationsRows({
          startDate: this.data.startDate,
          endDate: this.data.endDate,
          status: this.currentStatus(),
          cursor,
          pageSize: 50
        })
        const current = currentActiveUser()
        if (!current || current._id !== adminId || current.role !== 'super_admin') return
        rows.push(...(result.items || []))
        if (!result.hasMore) break
        if (!result.nextCursor || result.nextCursor === cursor) throw new Error('INVALID_CURSOR')
        cursor = result.nextCursor
        if (page === 99) throw new Error('RANGE_TOO_LARGE')
      }
      const fileName = `运营数据-${this.data.startDate}-${this.data.endDate}.csv`
      const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`
      await writeFile(filePath, toCsv(rows, CSV_COLUMNS))
      const current = currentActiveUser()
      if (current && current._id === adminId && current.role === 'super_admin') {
        wx.shareFileMessage({ filePath, fileName })
      }
    } catch (error) {
      const current = currentActiveUser()
      if (current && current._id === adminId) this.setData({ errorMessage: '运营数据导出失败，请稍后重试' })
    } finally {
      const current = currentActiveUser()
      if (current && current._id === adminId) this.setData({ exporting: false })
    }
  },

  async openSamples(event) {
    if (this.data.sampleLoading) return
    const metric = event.currentTarget.dataset.metric
    const stableNodeId = event.currentTarget.dataset.nodeId
    const node = this.data.nodeSeries.find(item => item.stableNodeId === stableNodeId)
    const user = currentActiveUser()
    if (!['node_processing', 'node_review'].includes(metric) || !node || !user) return
    const sequence = (this.sampleSequence || 0) + 1
    this.sampleSequence = sequence
    this.activeSample = { metric, stableNodeId }
    this.setData({
      sampleLoading: true,
      samples: null,
      sampleTitle: `${node.nodeName} · ${metric === 'node_processing' ? '处理' : '审核'}`
    })
    try {
      const result = await businessService.listOperationsAnalyticsSamples(
        this.query({ metric, stableNodeId, cursor: '', pageSize: 20 })
      )
      const current = currentActiveUser()
      if (sequence !== this.sampleSequence || !current || current._id !== user._id) return
      const formatted = formatSampleResult(result)
      this.setData({ samples: {
        ...formatted,
        items: formatted.items.map(item => ({ ...item, expanded: false }))
      } })
    } catch (error) {
      const current = currentActiveUser()
      if (sequence === this.sampleSequence && current && current._id === user._id) {
        this.setData({ errorMessage: '统计明细加载失败，请稍后重试' })
      }
    } finally {
      const current = currentActiveUser()
      if (sequence === this.sampleSequence && current && current._id === user._id) {
        this.setData({ sampleLoading: false })
      }
    }
  },

  async loadMoreSamples() {
    const user = currentActiveUser()
    const currentSamples = this.data.samples
    const activeSample = this.activeSample
    if (!user || this.data.sampleLoading || !currentSamples || !currentSamples.hasMore ||
        !currentSamples.nextCursor || !activeSample) return
    const sequence = this.sampleSequence
    this.setData({ sampleLoading: true })
    try {
      const result = await businessService.listOperationsAnalyticsSamples(this.query({
        ...activeSample, cursor: currentSamples.nextCursor, pageSize: 20
      }))
      const current = currentActiveUser()
      if (sequence !== this.sampleSequence || !current || current._id !== user._id) return
      const existing = this.data.samples && Array.isArray(this.data.samples.items)
        ? this.data.samples.items
        : []
      const formatted = formatSampleResult(result)
      this.setData({ samples: {
        ...formatted,
        items: [...existing, ...formatted.items.map(item => ({ ...item, expanded: false }))]
      } })
    } catch (error) {
      const current = currentActiveUser()
      if (sequence === this.sampleSequence && current && current._id === user._id) {
        this.setData({ errorMessage: '统计明细继续加载失败，请稍后重试' })
      }
    } finally {
      const current = currentActiveUser()
      if (sequence === this.sampleSequence && current && current._id === user._id) {
        this.setData({ sampleLoading: false })
      }
    }
  },

  toggleSampleItem(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (!this.data.samples || !Number.isSafeInteger(index) || !this.data.samples.items[index]) return
    const items = this.data.samples.items.map((item, itemIndex) => itemIndex === index
      ? { ...item, expanded: !item.expanded }
      : item)
    this.setData({ samples: { ...this.data.samples, items } })
  },

  closeSamples() {
    this.sampleSequence = (this.sampleSequence || 0) + 1
    this.activeSample = null
    this.setData({ samples: null, sampleTitle: '', sampleLoading: false })
  }
})
