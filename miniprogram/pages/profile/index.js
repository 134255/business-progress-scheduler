const businessService = require('../../services/business')

Page({
  data: {
    loading: true,
    saving: false,
    displayName: '',
    avatarUrl: '',
    pendingAvatarPath: ''
  },

  onLoad() {
    this.loadProfile()
  },

  async loadProfile() {
    this.setData({ loading: true })
    try {
      const profile = await businessService.bootstrap()
      this.setData({ displayName: profile.displayName || '', avatarUrl: profile.avatarUrl || '' })
    } finally {
      this.setData({ loading: false })
    }
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
      getApp().globalData.currentUser = profile
      this.setData({ avatarUrl, pendingAvatarPath: '' })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } finally {
      this.setData({ saving: false })
    }
  }
})
