const businessService = require('../../services/business')
const { toCsv } = require('../../utils/csv')
const { FIELD_CSV_COLUMNS,formatFieldSummary,mergeFieldFilters,fieldErrorMessage,validReportPage,reportCsvRows,utf8Bytes } = require('../../utils/operations-field-report')

const DAY_MS = 24 * 60 * 60 * 1000
const settle = promise => Promise.resolve(promise).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}))
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
  ['nodeCompletedAt', '节点完成时间'], ...FIELD_CSV_COLUMNS
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
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('EXPORT_WRITE_TIMEOUT')), 30000)
    try {
      wx.getFileSystemManager().writeFile({
        filePath, data, encoding: 'utf8', success: () => finish(), fail: error => finish(error || new Error('EXPORT_WRITE_FAILED'))
      })
    } catch (error) { finish(error) }
  })
}

Page({
  data: {
    isAdmin: false,
    currentStats: null,
    exporting: false,
    exportSending: false,
    exportReady: false,
    exportNotice: '',
    exportErrorMessage: '',
    loading: false,
    fieldGroups: [],
    fieldLoading: false,
    fieldIncomplete: false,
    fieldNotice: '',
    fieldScopeNotice: '',
    fieldErrorMessage: '',
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
    this.invalidateFields()
    const user = currentActiveUser()
    if (this.csvExport && !this.isCurrentCsvExport(this.csvExport)) this.resetCsvExport()
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
    this.invalidateFields()
    this.requestSequence = (this.requestSequence || 0) + 1
    this.sampleSequence = (this.sampleSequence || 0) + 1
    // A native file-send window can hide this page before its result callback.
    if (!this.csvExport || this.csvExport.stage !== 'sending') this.resetCsvExport()
  },

  onUnload() {
    this.invalidateFields()
    this.requestSequence = (this.requestSequence || 0) + 1
    this.sampleSequence = (this.sampleSequence || 0) + 1
    this.resetCsvExport()
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
      const first = await this.loadMergedFilters({
        startDate: this.data.startDate, endDate: this.data.endDate, grain: 'week'
      })
      if (!this.isCurrentRequest(sequence, userId)) return
      const templates = (first.templates || []).map(item => option(item.templateName || `历史模板 ${item.templateId}`, item.templateId))
      this.setData({ templateOptions: templates, templateIndex: 0 })
      if (!templates.length) {
        this.setData({ loading: false, summary: null, nodeSeries: [], trendSeries: [] })
        await this.loadFieldSummary(sequence,userId)
        return
      }
      if (!await this.loadTemplateFilters(sequence, userId)) return
      await this.loadCharts(sequence, userId)
    } catch (error) {
      if (this.isCurrentRequest(sequence, userId)) {
        this.setData({ loading: false, errorMessage: '历史统计加载失败，请稍后重试' })
      }
    } finally {
      if (this.isCurrentRequest(sequence,userId)) this.setData({loading:false})
    }
  },

  isCurrentRequest(sequence, userId) {
    const user = currentActiveUser()
    return sequence === this.requestSequence && user && user._id === userId
  },

  async loadTemplateFilters(sequence = this.requestSequence, userId = currentActiveUser() && currentActiveUser()._id, preserve = false) {
    if (!this.isCurrentRequest(sequence,userId)) return false
    const user=currentActiveUser(),queryKey=JSON.stringify(this.query()),fieldSequence=this.fieldSequence
    const result = await this.loadMergedFilters(this.query())
    if (!this.isCurrentRequest(sequence,userId) || currentActiveUser()!==user ||
        JSON.stringify(this.query())!==queryKey || fieldSequence!==this.fieldSequence) return false
    const selected=this.query()
    const update={
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
    }
    if(preserve) {
      for(const [optionsKey,indexKey,queryKey] of [
        ['versionOptions','versionIndex','templateVersion'],['nodeOptions','nodeIndex','stableNodeId'],
        ['businessOptions','businessIndex','businessLineId'],['processorOptions','processorIndex','processorToken'],
        ['reviewerOptions','reviewerIndex','reviewerToken']]) {
        update[indexKey]=Math.max(0,update[optionsKey].findIndex(item=>String(item.value)===String(selected[queryKey] || '')))
      }
      update.advancedFilterCount=[update.versionIndex,this.data.statusIndex,update.nodeIndex,update.businessIndex,
        update.processorIndex,update.reviewerIndex].filter(Boolean).length
      update.advancedFilterLabel=update.advancedFilterCount ? `（已启用 ${update.advancedFilterCount} 项）` : ''
    }
    this.setData(update)
    return true
  },

  async refreshFilterOptions(sequence,userId) {
    if(!this.isCurrentRequest(sequence,userId)) return false
    const user=currentActiveUser(),before=this.query(),queryKey=JSON.stringify(before),fieldSequence=this.fieldSequence
    const first=await this.loadMergedFilters({startDate:before.startDate,endDate:before.endDate,grain:before.grain})
    if(!this.isCurrentRequest(sequence,userId) || currentActiveUser()!==user ||
        JSON.stringify(this.query())!==queryKey || fieldSequence!==this.fieldSequence) return false
    const templates=(first.templates||[]).map(item=>option(item.templateName || `历史模板 ${item.templateId}`,item.templateId))
    const index=Math.max(0,templates.findIndex(item=>item.value===before.templateId))
    this.setData({templateOptions:templates,templateIndex:index})
    const preserve=templates[index] && templates[index].value===before.templateId
    const refreshed=await this.loadTemplateFilters(sequence,userId,preserve)
    if(refreshed && this.csvExport && !this.isCurrentCsvExport(this.csvExport)) this.resetCsvExport()
    return refreshed
  },

  async loadMergedFilters(query) {
    const user=currentActiveUser()
    const queryKey=JSON.stringify(this.query())
    const [timing,fields]=await Promise.all([
      Promise.resolve().then(()=>businessService.getOperationsAnalyticsFilters(query)),
      Promise.resolve().then(()=>businessService.getOperationsFieldFilters(query))
    ].map(settle))
    if(timing.status==='rejected' && fields.status==='rejected') throw timing.reason
    return mergeFieldFilters(timing.status==='fulfilled'?timing.value:{},
      fields.status==='fulfilled' && currentActiveUser()===user && JSON.stringify(this.query())===queryKey ? fields.value : {})
  },

  invalidateFields() {
    this.fieldSequence=(this.fieldSequence||0)+1
    this.setData({fieldGroups:[],fieldLoading:false,fieldIncomplete:false,fieldNotice:'',fieldScopeNotice:'',fieldErrorMessage:''})
  },

  async loadFieldSummary(sequence,userId) {
    if (!this.isCurrentRequest(sequence,userId)) return
    const user=currentActiveUser()
    const query=this.query(), queryKey=JSON.stringify(query)
    const fieldSequence=(this.fieldSequence||0)+1
    this.fieldSequence=fieldSequence
    const current=()=>this.isCurrentRequest(sequence,userId) && currentActiveUser()===user &&
      fieldSequence===this.fieldSequence && JSON.stringify(this.query())===queryKey
    this.setData({fieldLoading:true,fieldErrorMessage:'',fieldGroups:[],fieldNotice:'',fieldIncomplete:false})
    try {
      const result=await businessService.getOperationsFieldSummary(query)
      if(current()) this.setData(formatFieldSummary(result,this.data.templateOptions))
    } catch(error) {
      if(current()) this.setData({fieldErrorMessage:fieldErrorMessage(error,'字段统计加载失败，请稍后重试。')})
    } finally {
      if(current()) this.setData({fieldLoading:false})
      else if(fieldSequence===this.fieldSequence && currentActiveUser()!==user) this.invalidateFields()
    }
  },

  async loadCharts(sequence,userId) {
    if (!this.isCurrentRequest(sequence,userId)) return
    const [timing]=await Promise.all([this.loadSummary(sequence,userId),this.loadFieldSummary(sequence,userId)].map(settle))
    if(timing.status==='rejected') throw timing.reason
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
    try {
      if(!await this.refreshFilterOptions(sequence,user._id)) return
      if(!this.data.templateOptions.length) {
        this.setData({summary:null,nodeSeries:[],trendSeries:[]})
        await this.loadFieldSummary(sequence,user._id)
        return
      }
      await this.loadCharts(sequence, user._id)
    } catch (error) {
      if (this.isCurrentRequest(sequence, user._id)) {
        this.setData({ loading: false, errorMessage: '历史统计加载失败，请稍后重试' })
      }
    } finally {
      if(this.isCurrentRequest(sequence,user._id)) this.setData({loading:false})
    }
  },

  async onTemplateChange(event) {
    this.invalidateFields()
    this.resetCsvExport()
    this.setData({ templateIndex: Number(event.detail.value) || 0 })
    const user = currentActiveUser()
    if (!user) return
    const sequence = (this.requestSequence || 0) + 1
    this.requestSequence = sequence
    this.setData({ loading: true })
    try {
      if (!await this.loadTemplateFilters(sequence, user._id)) return
      await this.loadCharts(sequence, user._id)
    } catch (error) {
      if (this.isCurrentRequest(sequence, user._id)) {
        this.setData({ loading: false, errorMessage: '模板统计加载失败，请稍后重试' })
      }
    } finally {
      if (this.isCurrentRequest(sequence,user._id)) this.setData({loading:false})
    }
  },

  onStartDateChange(event) { this.invalidateFields(); this.resetCsvExport(); this.setData({ startDate: event.detail.value }) },
  onEndDateChange(event) { this.invalidateFields(); this.resetCsvExport(); this.setData({ endDate: event.detail.value }) },
  onGrainChange(event) { this.invalidateFields(); this.resetCsvExport(); this.setData({ grainIndex: Number(event.detail.value) || 0 }) },
  updateAdvancedCount() {
    this.invalidateFields()
    this.resetCsvExport()
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

  csvQuery() {
    return this.query()
  },

  isCurrentCsvExport(task) {
    const user = currentActiveUser()
    return this.csvExport === task && user === task.user && user.role === 'super_admin' &&
      JSON.stringify(this.csvQuery()) === task.queryKey
  },

  resetCsvExport() {
    if (this.csvExport && this.csvExport.attempt) clearTimeout(this.csvExport.attempt.timer)
    this.csvExport = null
    this.setData({ exporting: false, exportSending: false, exportReady: false, exportNotice: '', exportErrorMessage: '' })
  },

  setCsvExportStage(task, stage, notice, errorMessage = '') {
    task.stage = stage
    this.setData({
      exporting: stage === 'preparing', exportSending: stage === 'sending',
      exportReady: stage === 'ready' || stage === 'sending',
      exportNotice: notice, exportErrorMessage: errorMessage
    })
  },

  sendCsvExport(task) {
    const attempt = {}
    task.attempt = attempt
    this.setCsvExportStage(task, 'sending', '正在打开文件发送窗口…')
    const finish = (ok, result) => {
      if (attempt.finished) return
      attempt.finished = true
      clearTimeout(attempt.timer)
      if (!this.isCurrentCsvExport(task)) {
        if (this.csvExport === task) this.resetCsvExport()
        return
      }
      if (task.attempt !== attempt) return
      const message = String(result && result.errMsg || '')
      if (!ok && /no such file|not exist|not found|ENOENT/i.test(message)) {
        this.resetCsvExport()
        this.setData({ exportErrorMessage: '导出文件已失效，请重新导出。' })
        return
      }
      const cancelled = !ok && /cancel/i.test(message)
      this.setCsvExportStage(task, 'ready', ok ? 'CSV 文件已发送，可再次点击发送。' :
        cancelled ? '已取消发送，文件已生成，可再次点击发送。' : '文件已生成，可再次点击发送。',
      ok || cancelled ? '' : '文件发送失败，请点击“发送 CSV”重试。')
    }
    attempt.timer = setTimeout(() => {
      if (attempt.finished || task.attempt !== attempt) return
      if (!this.isCurrentCsvExport(task)) {
        if (this.csvExport === task) this.resetCsvExport()
        return
      }
      // A slow native picker is not a terminal result; keep accepting its callbacks.
      this.setCsvExportStage(task, 'ready', '文件已生成。',
        '暂未收到发送结果，请先确认文件是否已发送；如未发送可点击“发送 CSV”重试。')
    }, 30000)
    try {
      // Must be called in the button's tap stack, before any await/file/network work.
      const result = wx.shareFileMessage({
        filePath: task.filePath, fileName: task.fileName,
        success: value => finish(true, value), fail: value => finish(false, value)
      })
      if (result && typeof result.then === 'function') result.then(value => finish(true, value), value => finish(false, value))
    } catch (error) { finish(false, error) }
  },

  async exportCsv() {
    const user = currentActiveUser()
    if (this.csvExport && !this.isCurrentCsvExport(this.csvExport)) this.resetCsvExport()
    if (!user || user.role !== 'super_admin') {
      this.resetCsvExport()
      this.setData({ exportErrorMessage: '当前账号无权导出运营文件。' })
      return
    }
    if (this.data.exporting || this.data.exportSending) return
    if (this.csvExport && this.csvExport.filePath) {
      this.sendCsvExport(this.csvExport)
      return
    }
    const query = this.csvQuery()
    const task = { user, query, queryKey: JSON.stringify(query) }
    this.csvExport = task
    this.setCsvExportStage(task, 'preparing', '正在读取导出数据…')
    try {
      const rows = []
      const cursors=new Set()
      let cursor = ''
      for (let page = 0; page < 1000; page += 1) {
        const result = await businessService.exportOperationsReportRows({
          ...query, cursor, pageSize: 50
        })
        if (!this.isCurrentCsvExport(task)) return
        if (!validReportPage(result)) throw new Error('INVALID_EXPORT_ROWS')
        rows.push(...result.items)
        if(rows.length>50000) throw Object.assign(new Error('RANGE_TOO_LARGE'),{code:'RANGE_TOO_LARGE'})
        this.setCsvExportStage(task, 'preparing', `正在读取导出数据（已读取 ${rows.length} 条）…`)
        if (!result.hasMore) break
        if (cursors.has(result.nextCursor)) throw new Error('INVALID_CURSOR')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
        if (page === 999) throw Object.assign(new Error('RANGE_TOO_LARGE'),{code:'RANGE_TOO_LARGE'})
      }
      task.fileName = `运营数据-${query.startDate}-${query.endDate}.csv`
      task.writing = true
      this.setCsvExportStage(task, 'preparing', `正在生成 CSV（${rows.length} 条）…`)
      const filePath = `${wx.env.USER_DATA_PATH}/operations-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`
      const csv=toCsv(reportCsvRows(rows),CSV_COLUMNS)
      if(utf8Bytes(csv)>12*1024*1024) throw Object.assign(new Error('RANGE_TOO_LARGE'),{code:'RANGE_TOO_LARGE'})
      await writeFile(filePath, csv)
      if (!this.isCurrentCsvExport(task)) return
      task.filePath = filePath
      this.setCsvExportStage(task, 'ready', `CSV 已生成（${rows.length} 条），请点击“发送 CSV”取得文件。`)
    } catch (error) {
      if (this.isCurrentCsvExport(task)) {
        this.resetCsvExport()
        this.setData({ exportErrorMessage: fieldErrorMessage(error,task.writing ? 'CSV 文件生成失败，请重新导出。' : '导出数据读取失败，请重试或缩小日期范围。') })
      }
    } finally {
      if (this.csvExport === task && !this.isCurrentCsvExport(task)) this.resetCsvExport()
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
