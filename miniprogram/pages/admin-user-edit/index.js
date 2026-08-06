const adminUsers = require('../../services/admin-users')

const PASSWORD_MESSAGE = '密码须为 8-64 位，并至少包含一个英文字母和一个数字'
const LAST_SUPER_ADMIN_MESSAGE = '必须至少保留一个启用状态的超级管理员'

function isValidPassword(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 64 &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
}

function decode(value) {
  return typeof value === 'string' ? decodeURIComponent(value) : ''
}

Page({
  data: {
    editMode: false,
    userId: '',
    username: '',
    displayName: '',
    role: 'user',
    status: 'active',
    temporaryPassword: '',
    submitting: false,
    errorMessage: ''
  },

  onLoad(options = {}) {
    const currentUser = getApp().globalData.currentUser
    if (!currentUser || currentUser.role !== 'super_admin' || currentUser.status !== 'active') {
      this.unavailable = true
      wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
      return
    }
    const editMode = Boolean(options.id)
    this.originalRole = options.role === 'super_admin' ? 'super_admin' : 'user'
    this.originalStatus = options.status === 'disabled' ? 'disabled' : 'active'
    this.setData({
      editMode,
      userId: decode(options.id),
      username: decode(options.username),
      displayName: decode(options.displayName),
      role: this.originalRole,
      status: this.originalStatus
    })
    wx.setNavigationBarTitle({ title: editMode ? '编辑用户' : '新建用户' })
  },

  onUsernameInput(event) {
    if (!this.data.editMode) this.setData({ username: event.detail.value })
  },

  onDisplayNameInput(event) {
    this.setData({ displayName: event.detail.value })
  },

  onRoleChange(event) {
    this.setData({ role: event.detail.value })
  },

  onStatusChange(event) {
    this.setData({ status: event.detail.value })
  },

  onTemporaryPasswordInput(event) {
    this.setData({ temporaryPassword: event.detail.value })
  },

  async submit() {
    if (this.unavailable || this.data.submitting) return
    const username = this.data.username.trim()
    const displayName = this.data.displayName.trim()
    if (!displayName || (!this.data.editMode && !username)) {
      this.setData({ errorMessage: '请完整填写用户名和显示名称' })
      return
    }
    if (!this.data.editMode && !isValidPassword(this.data.temporaryPassword)) {
      this.setData({ errorMessage: PASSWORD_MESSAGE })
      return
    }
    if (this.data.editMode &&
        (this.data.role !== this.originalRole || this.data.status !== this.originalStatus)) {
      const confirmation = await wx.showModal({
        title: '确认变更账号权限',
        content: '角色或启用状态变更后立即生效，是否继续？'
      })
      if (!confirmation.confirm) return
    }

    this.setData({ submitting: true, errorMessage: '' })
    try {
      if (this.data.editMode) {
        await adminUsers.updateUser(this.data.userId, {
          displayName,
          role: this.data.role,
          status: this.data.status
        })
      } else {
        await adminUsers.createUser({
          username,
          displayName,
          role: this.data.role,
          temporaryPassword: this.data.temporaryPassword
        })
      }
      this.clearPassword()
      wx.showToast({ title: '保存成功', icon: 'success' })
      wx.navigateBack({ delta: 1 })
    } catch (error) {
      this.setData({
        errorMessage: error && error.code === 'LAST_SUPER_ADMIN'
          ? LAST_SUPER_ADMIN_MESSAGE
          : (error && error.message ? error.message : '网络异常，请稍后重试')
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  clearPassword() {
    this.setData({ temporaryPassword: '' })
  },

  onUnload() {
    this.clearPassword()
  }
})
