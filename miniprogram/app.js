App({
  globalData: {
    currentUser: null,
    cloudReady: false
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请升级微信客户端或在开发者工具中选择较新的调试基础库。',
        showCancel: false
      })
      return
    }

    wx.cloud.init({
      env: 'cloud1-d5gxt99rh492670d9',
      traceUser: true
    })
    this.globalData.cloudReady = true
  }
})
