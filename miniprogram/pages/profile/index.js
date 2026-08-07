const businessService = require('../../services/business')

Page({
  data: {
    loading: true,
    saving: false,
    username: '',
    roleLabel: '',
    displayName: '',
    avatarUrl: '',
    pendingAvatarPath: ''
  },

  onLoad() {
    const profile = getApp().globalData.currentUser
    if (!profile) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.setData({
      username: profile.username || '',
      roleLabel: profile.role === 'super_admin' ? '超级管理员' : '普通用户',
      displayName: profile.displayName || '',
      avatarUrl: profile.avatarUrl || '',
      loading: false
    })
  },

  onName(event) {
    this.setData({ displayName: event.detail.value })
  },

  onChooseAvatar(event) {
    const path = event.detail.avatarUrl
    this.setData({ pendingAvatarPath: path, avatarUrl: path })
  },

  async uploadAvatarIfNeeded() {
    if (!this.data.pendingAvatarPath) return this.data.avatarUrl
    const extension = (this.data.pendingAvatarPath.split('.').pop() || 'jpg').toLowerCase()
    const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`
    const result = await wx.cloud.uploadFile({ cloudPath, filePath: this.data.pendingAvatarPath })
    return result.fileID
  },

  async save() {
    const displayName = this.data.displayName.trim()
    if (!displayName || displayName.length > 30) {
      wx.showToast({ title: '昵称长度需为 1-30 个字符', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    try {
      const avatarUrl = await this.uploadAvatarIfNeeded()
      const profile = await businessService.updateUserProfile({ displayName, avatarUrl })
      getApp().globalData.currentUser = Object.assign({}, getApp().globalData.currentUser, profile)
      this.setData({ avatarUrl, pendingAvatarPath: '' })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } finally {
      this.setData({ saving: false })
    }
  },

  openChangePassword() {
    wx.navigateTo({ url: '/pages/change-password/index' })
  },

  async logout() {
    const result = await wx.showModal({
      title: '退出登录',
      content: '退出后需重新输入账号密码。当前微信绑定不会解除；如需切换账号，请先由超级管理员解除微信绑定。',
      confirmText: '退出'
    })
    if (!result.confirm) return
    const app = getApp()
    if (typeof app.requireManualLogin === 'function') app.requireManualLogin()
    if (typeof app.resetAuthState === 'function') app.resetAuthState()
    else {
      app.globalData.currentUser = null
      app.globalData.loginChallenge = null
    }
    wx.reLaunch({ url: '/pages/login/index' })
  }
})
