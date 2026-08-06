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
    hasMore: false
  },

  onLoad() {
    this.search()
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
    this.setData({ loading: true })
    try {
      const page = reset ? 1 : this.data.page + 1
      const data = await businessService.listBusinessLines({
        keyword: this.data.keyword.trim(),
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        page,
        pageSize: this.data.pageSize
      })
      this.setData({
        items: reset ? (data.items || []) : this.data.items.concat(data.items || []),
        page: data.page,
        total: data.total,
        hasMore: data.hasMore
      })
    } finally {
      this.setData({ loading: false })
    }
  },

  createBusiness() {
    wx.navigateTo({ url: '/pages/business-edit/index' })
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/business-detail/index?id=${event.currentTarget.dataset.id}` })
  }
})
