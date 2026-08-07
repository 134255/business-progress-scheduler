const accountService = require('../../services/account')

const PASSWORD_MESSAGE = '密码须为 8-64 位，并至少包含一个英文字母和一个数字'
const REQUIRED_MESSAGE = '请完整填写管理员用户名、显示名称、临时密码和恢复码'
const LOGIN_AFTER_INITIALIZATION_MESSAGE = '管理员已创建，请返回登录页使用临时密码登录'

function isValidPassword(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 64 &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
}

Page({
  data: {
    checking: true,
    available: false,
    submitting: false,
    username: '',
    displayName: '',
    temporaryPassword: '',
    confirmPassword: '',
    recoveryCode: '',
    errorMessage: ''
  },

  async onLoad() {
    try {
      const session = await accountService.getSession()
      if (session.authenticated) {
        getApp().globalData.currentUser = session.user
        wx.reLaunch({ url: '/pages/dashboard/index' })
        return
      }
      if (!session.requiresInitialization) {
        wx.reLaunch({ url: '/pages/login/index' })
        return
      }
      this.setData({ available: true })
    } catch (error) {
      this.setData({
        errorMessage: error && error.message ? error.message : '网络异常，请稍后重试'
      })
    } finally {
      this.setData({ checking: false })
    }
  },

  onUsernameInput(event) {
    this.setData({ username: event.detail.value })
  },

  onDisplayNameInput(event) {
    this.setData({ displayName: event.detail.value })
  },

  onTemporaryPasswordInput(event) {
    this.setData({ temporaryPassword: event.detail.value })
  },

  onConfirmPasswordInput(event) {
    this.setData({ confirmPassword: event.detail.value })
  },

  onRecoveryCodeInput(event) {
    this.setData({ recoveryCode: event.detail.value })
  },

  async submit() {
    if (!this.data.available || this.data.submitting) return
    const username = this.data.username.trim()
    const displayName = this.data.displayName.trim()
    const temporaryPassword = this.data.temporaryPassword
    const recoveryCode = this.data.recoveryCode.trim()
    if (!username || !displayName || !temporaryPassword || !recoveryCode) {
      this.setData({ errorMessage: REQUIRED_MESSAGE })
      return
    }
    if (!isValidPassword(temporaryPassword)) {
      this.setData({ errorMessage: PASSWORD_MESSAGE })
      return
    }
    if (temporaryPassword !== this.data.confirmPassword) {
      this.setData({ errorMessage: '两次输入的临时密码不一致' })
      return
    }

    let initialized = false
    this.setData({ submitting: true, errorMessage: '' })
    try {
      await accountService.initializeSuperAdmin(username, displayName, temporaryPassword, recoveryCode)
      initialized = true
      this.clearSensitiveFields()
      const loginResult = await accountService.login(username, temporaryPassword)
      if (!loginResult.passwordChangeRequired || !loginResult.challengeToken) {
        throw new Error(LOGIN_AFTER_INITIALIZATION_MESSAGE)
      }
      getApp().globalData.loginChallenge = loginResult.challengeToken
      wx.navigateTo({ url: '/pages/change-password/index?mode=first' })
    } catch (error) {
      this.clearSensitiveFields()
      if (initialized) {
        await wx.showModal({
          title: '初始化已完成',
          content: LOGIN_AFTER_INITIALIZATION_MESSAGE,
          showCancel: false
        })
        wx.reLaunch({ url: '/pages/login/index' })
        return
      }
      if (error && error.code === 'ALREADY_INITIALIZED') {
        this.clearAllFields()
        wx.reLaunch({ url: '/pages/login/index' })
        return
      }
      this.setData({
        errorMessage: error && error.message ? error.message : '网络异常，请稍后重试'
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  clearSensitiveFields() {
    this.setData({ temporaryPassword: '', confirmPassword: '', recoveryCode: '' })
  },

  clearAllFields() {
    this.setData({
      username: '',
      displayName: '',
      temporaryPassword: '',
      confirmPassword: '',
      recoveryCode: ''
    })
  },

  onUnload() {
    this.clearAllFields()
  }
})
