const businessService = require('../../services/business')

Page({
  data: {
    keyword: '',
    startDate: '',
    endDate: '',
    items: [],
    loading: false
  },

  onLoad() {
    this.search()
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
    this.setData({ loading: true })
    try {
      const data = await businessService.listBusinessLines({
        keyword: this.data.keyword.trim(),
        startDate: this.data.startDate,
        endDate: this.data.endDate
      })
      this.setData({ items: data.items || [] })
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

