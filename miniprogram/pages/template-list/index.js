Page({
  data: {
    templates: [
      { id: 'demo-1', name: '通用三节点流程', nodeCount: 3, builtIn: true }
    ]
  },

  createFromTemplate() {
    wx.navigateTo({ url: '/pages/business-edit/index' })
  }
})

