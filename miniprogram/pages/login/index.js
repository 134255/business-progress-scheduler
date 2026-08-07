const accountService = require('../../services/account')

const INITIALIZATION_MESSAGE = '系统尚未初始化，请创建首位超级管理员'

Page({
  data: {
    checking: true,
    submitting: false,
    username: '',
    password: '',
    errorMessage: '',
    requiresInitialization: false
  },

  async onLoad() {
    try {
      const session = await accountService.getSession()
      const app = getApp()
      const manualLoginRequired = typeof app.isManualLoginRequired === 'function' &&
        app.isManualLoginRequired()
      if (session.requiresInitialization) {
        this.setData({
          requiresInitialization: true,
          errorMessage: INITIALIZATION_MESSAGE
        })
        return
      }
      if (session.authenticated && !manualLoginRequired) {
        app.globalData.currentUser = session.user
        wx.reLaunch({ url: '/pages/dashboard/index' })
        return
      }
    } catch (error) {
      this.setData({ errorMessage: error && error.message ? error.message : '网络异常，请稍后重试' })
    } finally {
      this.setData({ checking: false })
    }
  },

  openInitialization() {
    if (!this.data.requiresInitialization) return
    wx.navigateTo({ url: '/pages/admin-initialize/index' })
  },

  onUsernameInput(event) {
    this.setData({ username: event.detail.value })
  },

  onPasswordInput(event) {
    this.setData({ password: event.detail.value })
  },

  async submit() {
    if (this.data.submitting || this.data.requiresInitialization) return
    this.setData({ submitting: true, errorMessage: '' })
    try {
      const result = await accountService.login(this.data.username, this.data.password)
      if (result.passwordChangeRequired) {
        getApp().globalData.loginChallenge = result.challengeToken
        this.setData({ password: '' })
        wx.navigateTo({ url: '/pages/change-password/index?mode=first' })
        return
      }
      if (result.authenticated) {
        const app = getApp()
        if (typeof app.clearManualLoginRequirement === 'function') {
          app.clearManualLoginRequirement()
        }
        app.globalData.currentUser = result.user
        app.globalData.loginChallenge = null
        wx.reLaunch({ url: '/pages/dashboard/index' })
      }
    } catch (error) {
      this.setData({ errorMessage: error && error.message ? error.message : '网络异常，请稍后重试' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  onUnload() {
    this.setData({ username: '', password: '' })
  }
})
