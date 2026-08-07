const accountService = require('../../services/account')

Page({
  data: {
    firstLogin: false,
    submitting: false,
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    errorMessage: ''
  },

  onLoad(options = {}) {
    const firstLogin = options.mode === 'first'
    this.setData({ firstLogin })
    const app = getApp()
    if ((firstLogin && !app.globalData.loginChallenge) || (!firstLogin && !app.globalData.currentUser)) {
      this.unavailable = true
      wx.reLaunch({ url: '/pages/login/index' })
    }
  },

  onCurrentPasswordInput(event) {
    this.setData({ currentPassword: event.detail.value })
  },

  onNewPasswordInput(event) {
    this.setData({ newPassword: event.detail.value })
  },

  onConfirmPasswordInput(event) {
    this.setData({ confirmPassword: event.detail.value })
  },

  async submit() {
    if (this.unavailable || this.data.submitting) return
    if (this.data.newPassword !== this.data.confirmPassword) {
      this.setData({ errorMessage: '两次输入的新密码不一致' })
      return
    }

    this.setData({ submitting: true, errorMessage: '' })
    try {
      const app = getApp()
      const result = this.data.firstLogin
        ? await accountService.completeFirstLogin(app.globalData.loginChallenge, this.data.newPassword)
        : await accountService.changePassword(this.data.currentPassword, this.data.newPassword)

      if (this.data.firstLogin) {
        if (typeof app.resetAuthState === 'function') app.resetAuthState()
        else app.globalData.loginChallenge = null
      }
      if (typeof app.clearManualLoginRequirement === 'function') {
        app.clearManualLoginRequirement()
      }
      app.globalData.currentUser = result.user
      this.clearPasswordFields()
      wx.reLaunch({ url: '/pages/dashboard/index' })
    } catch (error) {
      this.setData({ errorMessage: error && error.message ? error.message : '网络异常，请稍后重试' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  clearPasswordFields() {
    this.setData({ currentPassword: '', newPassword: '', confirmPassword: '' })
  },

  onUnload() {
    this.clearPasswordFields()
  }
})
