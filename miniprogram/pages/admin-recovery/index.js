const accountService = require('../../services/account')

const REQUIRED_MESSAGE = '请完整填写管理员用户名、临时密码、确认密码和一次性恢复码'
const PASSWORD_MESSAGE = '临时密码须为 8-64 位，并至少包含一个英文字母和一个数字'
const MISMATCH_MESSAGE = '两次输入的临时密码不一致'
const RECOVERY_COMPLETED_MESSAGE = '恢复已完成，请返回登录页使用刚才设置的临时密码登录'

function isValidPassword(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 64 &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
}

Page({
  data: {
    submitting: false,
    username: '',
    temporaryPassword: '',
    confirmPassword: '',
    recoveryCode: '',
    errorMessage: ''
  },

  onUsernameInput(event) {
    this.setData({ username: event.detail.value })
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
    if (this.data.submitting || this.recoveryCompleted) return
    const username = this.data.username.trim()
    const temporaryPassword = this.data.temporaryPassword
    const recoveryCode = this.data.recoveryCode.trim()

    if (!username || !temporaryPassword || !this.data.confirmPassword || !recoveryCode) {
      this.setData({ errorMessage: REQUIRED_MESSAGE })
      return
    }
    if (!isValidPassword(temporaryPassword)) {
      this.setData({ errorMessage: PASSWORD_MESSAGE })
      return
    }
    if (temporaryPassword !== this.data.confirmPassword) {
      this.setData({ errorMessage: MISMATCH_MESSAGE })
      return
    }

    this.setData({ submitting: true, errorMessage: '' })
    try {
      await accountService.recoverSuperAdmin(username, temporaryPassword, recoveryCode)
    } catch (error) {
      this.clearSensitiveFields()
      this.setData({
        submitting: false,
        errorMessage: error && error.message ? error.message : '网络异常，请稍后重试'
      })
      return
    }

    this.recoveryCompleted = true
    this.clearSensitiveFields()
    try {
      const result = await accountService.login(username, temporaryPassword)
      if (!result.passwordChangeRequired || !result.challengeToken) {
        throw new Error(RECOVERY_COMPLETED_MESSAGE)
      }
      getApp().globalData.loginChallenge = result.challengeToken
      wx.navigateTo({ url: '/pages/change-password/index?mode=first' })
    } catch (_error) {
      try {
        await wx.showModal({
          title: '恢复已完成',
          content: RECOVERY_COMPLETED_MESSAGE,
          showCancel: false
        })
      } catch (_modalError) {
      } finally {
        wx.reLaunch({ url: '/pages/login/index' })
      }
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
      temporaryPassword: '',
      confirmPassword: '',
      recoveryCode: ''
    })
  },

  onUnload() {
    this.clearAllFields()
  }
})
