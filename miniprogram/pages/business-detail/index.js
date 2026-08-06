const businessService = require('../../services/business')

Page({
  data: {
    id: '',
    loading: true,
    line: null,
    nodes: [],
    canManage: false
  },

  onLoad(query) {
    this.setData({ id: query.id || '' })
  },

  onShow() {
    if (this.data.id) this.loadDetail()
  },

  async loadDetail() {
    this.setData({ loading: true })
    try {
      const data = await businessService.getBusinessLine(this.data.id)
      this.setData(data)
    } finally {
      this.setData({ loading: false })
    }
  },

  openFeedback(event) {
    const node = this.data.nodes[event.currentTarget.dataset.index]
    wx.navigateTo({ url: `/pages/node-feedback/index?lineId=${this.data.id}&nodeId=${node._id}&nodeName=${encodeURIComponent(node.name)}&canFeedback=${node.canFeedback ? '1' : '0'}` })
  },

  editLine() {
    wx.navigateTo({ url: `/pages/business-edit/index?id=${this.data.id}` })
  },

  async deleteLine() {
    const confirm = await new Promise(resolve => {
      wx.showModal({
        title: '删除业务线',
        content: '业务线将被移入逻辑删除状态并从列表隐藏。是否继续？',
        success: result => resolve(result.confirm)
      })
    })
    if (!confirm) return
    await businessService.deleteBusinessLine(this.data.id)
    wx.showToast({ title: '已删除', icon: 'success' })
    setTimeout(() => wx.navigateBack({ delta: 1 }), 500)
  }
})
