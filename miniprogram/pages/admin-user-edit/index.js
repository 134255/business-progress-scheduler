const adminUsers = require('../../services/admin-users')

const PASSWORD_MESSAGE = '密码须为 8-64 位，并至少包含一个英文字母和一个数字'
const LAST_SUPER_ADMIN_MESSAGE = '必须至少保留一个启用状态的超级管理员'
const TARGET_LOOKUP_MESSAGE = '无法确认用户最新状态，请返回列表重试'

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
    loading: false,
    submitting: false,
    errorMessage: ''
  },

  async onLoad(options = {}) {
    const currentUser = getApp().globalData.currentUser
    if (!currentUser || currentUser.role !== 'super_admin' || currentUser.status !== 'active') {
      this.unavailable = true
      wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
      return
    }
    const editMode = Boolean(options.id)
    const userId = decode(options.id)
    const username = decode(options.username)
    this.setData({
      editMode,
      userId,
      username
    })
    wx.setNavigationBarTitle({ title: editMode ? '编辑用户' : '新建用户' })
    if (!editMode) return

    this.setData({ loading: true })
    try {
      const result = await adminUsers.listUsers({
        keyword: username.trim(),
        status: 'all',
        page: 1,
        pageSize: 100
      })
      const matches = (result.items || []).filter(user => user._id === userId)
      if (matches.length !== 1) throw new Error(TARGET_LOOKUP_MESSAGE)
      this.originalUser = matches[0]
      this.setData({
        username: this.originalUser.username,
        displayName: this.originalUser.displayName,
        role: this.originalUser.role,
        status: this.originalUser.status
      })
    } catch (error) {
      this.unavailable = true
      this.setData({ errorMessage: TARGET_LOOKUP_MESSAGE })
    } finally {
      this.setData({ loading: false })
    }
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

  resetAuthAndLogin() {
    const app = getApp()
    if (typeof app.resetAuthState === 'function') app.resetAuthState()
    else {
      app.globalData.currentUser = null
      app.globalData.loginChallenge = null
    }
    wx.reLaunch({ url: '/pages/login/index' })
  },

  handleCurrentUserMutation(updated) {
    const app = getApp()
    const currentUser = app.globalData.currentUser
    if (!updated || !currentUser || updated._id !== currentUser._id) return false
    if (updated.status !== 'active' || updated.mustChangePassword || updated.openidBound === false) {
      this.resetAuthAndLogin()
      return true
    }
    app.globalData.currentUser = Object.assign({}, currentUser, updated)
    if (updated.role !== 'super_admin') {
      wx.reLaunch({ url: '/pages/dashboard/index' })
      return true
    }
    return false
  },

  async submit() {
    if (this.unavailable || this.data.loading || this.data.submitting) return
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
    const changes = {}
    if (this.data.editMode) {
      if (!this.originalUser) {
        this.setData({ errorMessage: TARGET_LOOKUP_MESSAGE })
        return
      }
      if (displayName !== this.originalUser.displayName) changes.displayName = displayName
      if (this.data.role !== this.originalUser.role) changes.role = this.data.role
      if (this.data.status !== this.originalUser.status) changes.status = this.data.status
      if (Object.keys(changes).length === 0) {
        wx.showToast({ title: '未检测到修改', icon: 'none' })
        return
      }
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'role') ||
        Object.prototype.hasOwnProperty.call(changes, 'status')) {
      const confirmation = await wx.showModal({
        title: '确认变更账号权限',
        content: '角色或启用状态变更后立即生效，是否继续？'
      })
      if (!confirmation.confirm) return
    }

    this.setData({ submitting: true, errorMessage: '' })
    try {
      let updated
      if (this.data.editMode) {
        updated = await adminUsers.updateUser(this.data.userId, changes)
      } else {
        updated = await adminUsers.createUser({
          username,
          displayName,
          role: this.data.role,
          temporaryPassword: this.data.temporaryPassword
        })
      }
      this.clearPassword()
      wx.showToast({ title: '保存成功', icon: 'success' })
      if (this.data.editMode && this.handleCurrentUserMutation(updated)) return
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
