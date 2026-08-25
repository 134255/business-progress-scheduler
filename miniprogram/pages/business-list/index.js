const businessService = require('../../services/business')

Page({
  data: {
    keyword: '',
    startDate: '',
    endDate: '',
    items: [],
    loading: false,
    page: 1,
    pageSize: 20,
    total: 0,
    cursor: '',
    hasMore: false,
    expandedMatchIds: {},
    requestSequence: 0,
    loadMoreText: ''
  },

  onLoad() {
    this._visible = true
    this._actorId = currentActorId()
    return this.search()
  },

  onShow() {
    const actorId = currentActorId()
    this._visible = true
    if (this._actorId && actorId !== this._actorId) {
      this._invalidateRequests()
      this._actorId = actorId
      return this.search()
    }
    this._actorId = actorId
  },

  onHide() {
    this._visible = false
    this._invalidateRequests()
  },

  onUnload() {
    this._visible = false
    this._invalidateRequests()
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadPage(false)
  },

  onKeyword(event) {
    this.setData({ keyword: event.detail.value })
  },

  onStartDate(event) {
    this.setData({ startDate: event.detail.value })
  },

  onEndDate(event) {
    this.setData({ endDate: event.detail.value })
  },

  async search() {
    return this.loadPage(true)
  },

  async loadPage(reset) {
    if (!reset && this.data.loading) return
    const keyword = normalizeKeyword(this.data.keyword)
    const actorId = currentActorId()
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
    this.setData({ loading: true, requestSequence: sequence })
    try {
      const data = await businessService.listBusinessLines(query)
      if (!this._acceptResponse(sequence, actorId, querySignature)) return
      const incoming = safeItems(data && data.items, this.data.expandedMatchIds)
      const items = reset ? incoming : mergeItems(this.data.items, incoming)
      const hasMore = data && data.hasMore === true
      const total = keyword ? null : safeNonNegativeInteger(data && data.total)
      this.setData({
        items,
        page: keyword ? 1 : safePositiveInteger(data && data.page, query.page),
        total,
        cursor: keyword && typeof data.cursor === 'string' ? data.cursor : '',
        hasMore,
        expandedMatchIds: reset ? {} : this.data.expandedMatchIds,
        loadMoreText: hasMore ? '上拉加载更多' : (keyword ? '已加载全部匹配结果' : `已加载全部 ${total} 条`)
      })
    } catch (error) {
      if (this._acceptResponse(sequence, actorId, querySignature)) {
        wx.showToast({ title: safeMessage(error), icon: 'none' })
      }
    } finally {
      if (this._acceptResponse(sequence, actorId, querySignature)) this.setData({ loading: false })
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
    return JSON.stringify([keyword, this.data.startDate, this.data.endDate])
  },

  _nextRequestSequence() {
    this._requestSequence = safeNonNegativeInteger(this._requestSequence) + 1
    return this._requestSequence
  },

  _invalidateRequests() {
    const sequence = this._nextRequestSequence()
    this.setData({ requestSequence: sequence, loading: false })
  },

  _acceptResponse(sequence, actorId, querySignature) {
    return this._visible === true &&
      this._requestSequence === sequence &&
      currentActorId() === actorId &&
      this._querySignature(normalizeKeyword(this.data.keyword)) === querySignature
  }
})

function currentActorId() {
  try {
    const app = getApp()
    const id = app && app.globalData && app.globalData.currentUser && app.globalData.currentUser._id
    return typeof id === 'string' ? id : ''
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
    return [withVisibleMatches({
      _id: id,
      code: safeString(item.code),
      name: safeString(item.name),
      status: safeString(item.status),
      currentNodeName: safeString(item.currentNodeName),
      plannedStartDate: safeString(item.plannedStartDate),
      matches: safeMatches(item.matches, id)
    }, expandedMatchIds)]
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
  const message = error && typeof error.message === 'string' ? error.message : ''
  return message && message.length <= 40 ? message : '售后列表加载失败，请稍后重试'
}
