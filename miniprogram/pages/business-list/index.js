const businessService = require('../../services/business')
const { presentBusinessCard } = require('../../utils/business-card')
const { isAccountAccessError } = require('../../utils/safe-error')
const MAX_RECOVERY_REQUESTS = 20

Page({
  data: {
    status: '',
    scope: '',
    filterLabel: '',
    keyword: '',
    startDate: '',
    endDate: '',
    items: [],
    loading: false,
    errorMessage: '',
    indexStatus: '',
    queryDirty: false,
    page: 1,
    pageSize: 20,
    total: 0,
    cursor: '',
    hasMore: false,
    expandedMatchIds: {},
    requestSequence: 0,
    loadMoreText: ''
  },

  onLoad(options) {
    const status = options && (options.status === 'active' || options.status === 'completed') ? options.status : ''
    const scope = options && options.scope === 'mine' ? 'mine' : ''
    const statusLabel = status === 'active' ? '进行中' : (status === 'completed' ? '已完成' : '')
    this.setData({ status, scope, filterLabel: [scope ? '与我相关' : '', statusLabel].filter(Boolean).join(' · ') })
    this._visible = true
    this._actorId = currentActorId()
    this._actorRole = currentActorRole()
    return this.search()
  },

  onShow() {
    const actorId = currentActorId()
    this._visible = true
    if (!actorId) { this._clearCards(); return }
    const changed = this._actorId !== actorId || this._actorRole !== currentActorRole()
    const reload = changed || this._resumeSearch
    this._resumeSearch = false
    if (changed) this._clearCards()
    this._actorId = actorId
    this._actorRole = currentActorRole()
    if (reload && !this.data.queryDirty) {
      this._invalidateRequests()
      return this.search()
    }
  },

  onHide() {
    this._resumeSearch = true
    this._visible = false
    this._invalidateRequests()
  },

  onUnload() {
    this._visible = false
    this._invalidateRequests()
  },

  onReachBottom() {
    if (this.data.indexStatus === 'recovering') return
    return this.loadMore()
  },

  loadMore() {
    if (this.data.hasMore && !this.data.loading && !this.data.queryDirty) return this.loadPage(false)
  },

  onKeyword(event) {
    this._changeCondition('keyword', event && event.detail && event.detail.value)
  },

  onStartDate(event) {
    this._changeCondition('startDate', event && event.detail && event.detail.value)
  },

  onEndDate(event) {
    this._changeCondition('endDate', event && event.detail && event.detail.value)
  },

  onSearchSubmit(event) {
    const values = event && event.detail && event.detail.value
    this._changeCondition('keyword', values && values.keyword)
    return this.search()
  },

  onSearchConfirm(event) {
    this.onKeyword(event)
    return this.search()
  },

  _changeCondition(key, value) {
    if (typeof value !== 'string' || value === this.data[key]) return
    this._invalidateRequests()
    this.setData({ [key]: value, items: [], cursor: '', hasMore: false, total: 0,
      page: 1, expandedMatchIds: {}, loadMoreText: '', errorMessage: '', indexStatus: '', queryDirty: true })
  },

  async search() {
    return this.loadPage(true)
  },

  retryCards() {
    if (!this.data.queryDirty && !this.data.loading) return this.search()
  },

  async onPullDownRefresh() {
    try { await this.retryCards() } finally { wx.stopPullDownRefresh() }
  },

  async loadPage(reset) {
    if (this._visible !== true) return
    if (!reset && (this.data.loading || this.data.queryDirty)) return
    const keyword = normalizeKeyword(this.data.keyword)
    const actorId = currentActorId()
    if (!actorId) { this._clearCards(); return }
    if (!reset && (this._actorId !== actorId || this._actorRole !== currentActorRole())) { this._clearCards(); return }
    if (reset) {
      this._actorId = actorId
      this._actorRole = currentActorRole()
    }
    const querySignature = this._querySignature(keyword)
    const sequence = this._nextRequestSequence()
    const query = keyword
      ? {
          keyword,
          startDate: this.data.startDate,
          endDate: this.data.endDate,
          pageSize: this.data.pageSize,
          cursor: reset ? '' : this.data.cursor
        }
      : {
          keyword: '',
          startDate: this.data.startDate,
          endDate: this.data.endDate,
          page: reset ? 1 : this.data.page + 1,
          pageSize: this.data.pageSize
        }
    if (this.data.status) query.status = this.data.status
    if (this.data.scope) query.scope = this.data.scope
    const recoveryCursors = new Set(reset ? [] : this._recoveryCursors || [])
    if (query.cursor) recoveryCursors.add(query.cursor)
    if (reset) this._recoveryCursors = recoveryCursors
    this.setData({
      ...(reset ? { items: [], cursor: '', hasMore: false, total: 0, page: 1,
        expandedMatchIds: {}, loadMoreText: '', indexStatus: '' } : {}),
      loading: true, requestSequence: sequence, errorMessage: '', queryDirty: false
    })
    try {
      let cursor = query.cursor
      for (let attempt = 0; attempt < MAX_RECOVERY_REQUESTS; attempt += 1) {
        if (!this._acceptResponse(sequence, actorId, querySignature)) return
        const data = await businessService.listBusinessLines({ ...query, ...(keyword ? { cursor } : {}) })
        if (!this._acceptResponse(sequence, actorId, querySignature)) return
        if (!data || !Array.isArray(data.items) ||
            (data.indexStatus !== undefined && data.indexStatus !== 'recovering' && data.indexStatus !== 'incomplete') ||
            (keyword && data.hasMore === true && (typeof data.cursor !== 'string' || !data.cursor.trim()))) {
          throw new Error('INVALID_LIST_RESPONSE')
        }
        if (data.indexStatus === 'recovering') {
          if (!keyword || data.items.length !== 0 || data.hasMore !== true ||
              typeof data.cursor !== 'string' || !data.cursor.trim() || data.cursor.length > 2048 ||
              recoveryCursors.has(data.cursor)) throw new Error('INVALID_LIST_RESPONSE')
          recoveryCursors.add(data.cursor)
          this._recoveryCursors = recoveryCursors
          cursor = data.cursor
          this.setData({ indexStatus: 'recovering', cursor, hasMore: true, total: null,
            loadMoreText: '检索内容尚未更新完成，请点击继续更新' })
          continue
        }
        const incoming = safeItems(data.items, this.data.expandedMatchIds)
        const items = reset ? incoming : mergeItems(this.data.items, incoming)
        const hasMore = data.hasMore === true
        const total = keyword ? null : safeNonNegativeInteger(data.total)
        const incomplete = data.indexStatus === 'incomplete' || (!reset && this.data.indexStatus === 'incomplete')
        this._recoveryCursors = null
        this.setData({
          items,
          page: keyword ? 1 : safePositiveInteger(data.page, query.page),
          total,
          cursor: keyword && typeof data.cursor === 'string' ? data.cursor : '',
          hasMore,
          indexStatus: incomplete ? 'incomplete' : '',
          expandedMatchIds: reset ? {} : this.data.expandedMatchIds,
          loadMoreText: hasMore ? '上拉加载更多' : (incomplete ? '已显示当前可用结果'
            : (keyword ? '已加载全部匹配结果' : `已加载全部 ${total} 条`))
        })
        return
      }
    } catch (error) {
      if (this._acceptResponse(sequence, actorId, querySignature)) {
        const errorMessage = safeMessage(error)
        if (isAccountAccessError(error)) this._clearCards()
        this.setData({ errorMessage })
        wx.showToast({ title: errorMessage, icon: 'none' })
      }
    } finally {
      if (this._acceptResponse(sequence, actorId, querySignature)) {
        this.setData({ loading: false })
      }
    }
  },

  toggleMatches(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id
    if (typeof id !== 'string' || !this.data.items.some(item => item._id === id)) return
    const expandedMatchIds = { ...this.data.expandedMatchIds, [id]: !this.data.expandedMatchIds[id] }
    this.setData({
      expandedMatchIds,
      items: this.data.items.map(item => withVisibleMatches(item, expandedMatchIds))
    })
  },

  createBusiness() {
    wx.navigateTo({ url: '/pages/business-edit/index' })
  },

  openDetail(event) {
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id
    if (typeof id !== 'string' || !this.data.items.some(item => item._id === id)) return
    wx.navigateTo({ url: `/pages/business-detail/index?id=${encodeURIComponent(id)}` })
  },

  _querySignature(keyword) {
    return JSON.stringify([keyword, this.data.startDate, this.data.endDate, this.data.status, this.data.scope])
  },

  _nextRequestSequence() {
    this._requestSequence = safeNonNegativeInteger(this._requestSequence) + 1
    return this._requestSequence
  },

  _invalidateRequests() {
    const sequence = this._nextRequestSequence()
    this.setData({ requestSequence: sequence, loading: false })
  },

  _clearCards() {
    this._invalidateRequests()
    this._recoveryCursors = null
    this.setData({ items: [], cursor: '', hasMore: false, total: 0, page: 1,
      expandedMatchIds: {}, loadMoreText: '', indexStatus: '' })
  },

  _acceptResponse(sequence, actorId, querySignature) {
    if (this._requestSequence !== sequence) return false
    if (currentActorId() !== actorId || currentActorRole() !== this._actorRole) { this._clearCards(); return false }
    return this._visible === true &&
      this._requestSequence === sequence &&
      this._querySignature(normalizeKeyword(this.data.keyword)) === querySignature
  }
})

function currentActorId() {
  try {
    const app = getApp()
    const actor = app && app.globalData && app.globalData.currentUser
    return actor && actor.status === 'active' && typeof actor._id === 'string' ? actor._id : ''
  } catch (_) {
    return ''
  }
}

function normalizeKeyword(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function safeString(value) {
  return typeof value === 'string' ? value : ''
}

function safeMatches(value, lineId) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 3).map((match, index) => ({
    id: `${lineId}-${index}`,
    nodeName: safeString(match && match.nodeName),
    label: safeString(match && match.label),
    excerpt: safeString(match && match.excerpt)
  }))
}

function safeItems(value, expandedMatchIds) {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const id = safeString(item && item._id)
    if (!id) return []
    return [withVisibleMatches(presentBusinessCard({
      _id: id,
      code: safeString(item.code),
      name: safeString(item.name),
      status: safeString(item.status),
      currentNodeName: safeString(item.currentNodeName),
      plannedStartDate: safeString(item.plannedStartDate),
      flowSchemaVersion: item.flowSchemaVersion === 2 ? 2 : 1,
      completedNodeCount: safeNonNegativeInteger(item.completedNodeCount),
      traversedNodeCount: safeNonNegativeInteger(item.traversedNodeCount),
      progress: typeof item.progress === 'number' && Number.isFinite(item.progress) ? item.progress : 0,
      cardSummary: item.cardSummary,
      matches: safeMatches(item.matches, id)
    }), expandedMatchIds)]
  })
}

function withVisibleMatches(item, expandedMatchIds) {
  const expanded = expandedMatchIds && expandedMatchIds[item._id] === true
  return {
    ...item,
    visibleMatches: expanded ? item.matches : item.matches.slice(0, 1),
    hasHiddenMatches: item.matches.length > 1,
    matchesExpanded: expanded
  }
}

function mergeItems(current, incoming) {
  const merged = []
  const seen = new Set()
  for (const item of [].concat(current || [], incoming || [])) {
    if (!item || seen.has(item._id)) continue
    seen.add(item._id)
    merged.push(item)
  }
  return merged
}

function safeMessage(error) {
  const messages = {
    BUSINESS_SEARCH_PENDING: '售后检索正在更新，请稍后重试',
    BUSINESS_SEARCH_UNAVAILABLE: '售后检索暂时不可用，请稍后重试',
    INVALID_SEARCH_QUERY: '请调整检索内容后重试',
    VALIDATION_ERROR: '请检查检索条件和日期范围',
    FORBIDDEN: '你没有权限执行此操作'
  }
  const code = error && error.code
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(messages, code)
    ? messages[code] : '售后列表加载失败，请稍后重试'
}

function currentActorRole() {
  try {
    const actor = getApp().globalData.currentUser
    return actor && typeof actor.role === 'string' ? actor.role : ''
  } catch (_) { return '' }
}
