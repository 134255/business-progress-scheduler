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

function errorMessage(error) {
  if (error && error.code === 'LAST_SUPER_ADMIN') return LAST_SUPER_ADMIN_MESSAGE
  return error && error.message ? error.message : '网络异常，请稍后重试'
}

Page({
  data: {
    loading: false,
    keyword: '',
    status: 'all',
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    items: []
  },

  onShow() {
    if (!this.requireSuperAdmin()) return
    return this.loadUsers(false)
  },

  requireSuperAdmin() {
    const currentUser = getApp().globalData.currentUser
    if (currentUser && currentUser.role === 'super_admin' && currentUser.status === 'active') return true
    wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
    return false
  },

  onKeywordInput(event) {
    this.setData({ keyword: event.detail.value })
  },

  onStatusChange(event) {
    const statuses = ['all', 'active', 'disabled']
    this.setData({ status: statuses[Number(event.detail.value)] || 'all' })
    return this.search()
  },

  search() {
    return this.loadUsers(false, 1)
  },

  async loadUsers(append, requestedPage = this.data.page) {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const result = await adminUsers.listUsers({
        keyword: this.data.keyword.trim(),
        status: this.data.status,
        page: requestedPage,
        pageSize: this.data.pageSize
      })
      this.setData({
        items: append ? this.data.items.concat(result.items || []) : (result.items || []),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        hasMore: result.hasMore
      })
    } catch (error) {
      if (error && error.code === 'FORBIDDEN') {
        wx.reLaunch({ url: '/pages/dashboard/index' })
      }
    } finally {
      this.setData({ loading: false })
    }
  },

  loadMore() {
    if (this.data.loading || !this.data.hasMore) return
    return this.loadUsers(true, this.data.page + 1)
  },

  openCreate() {
    wx.navigateTo({ url: '/pages/admin-user-edit/index' })
  },

  openEdit(event) {
    const item = this.data.items.find(user => user._id === event.currentTarget.dataset.id)
    if (!item) return
    const query = [
      `id=${encodeURIComponent(item._id)}`,
      `username=${encodeURIComponent(item.username)}`
    ].join('&')
    wx.navigateTo({ url: `/pages/admin-user-edit/index?${query}` })
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

  async runConfirmed(options, action) {
    const result = await wx.showModal(options)
    if (!result.confirm) return false
    try {
      const updated = await action(result)
      wx.showToast({ title: '操作成功', icon: 'success' })
      if (this.handleCurrentUserMutation(updated)) return true
      await this.loadUsers(false)
      return true
    } catch (error) {
      wx.showToast({ title: errorMessage(error), icon: 'none' })
      return false
    }
  },

  toggleStatus(event) {
    const userId = event.currentTarget.dataset.id
    const nextStatus = event.currentTarget.dataset.status === 'active' ? 'disabled' : 'active'
    const verb = nextStatus === 'active' ? '启用' : '停用'
    return this.runConfirmed({
      title: `确认${verb}账号`,
      content: `账号${verb}后立即生效，是否继续？`
    }, () => adminUsers.updateUser(userId, { status: nextStatus }))
  },

  async resetPassword(event) {
    const userId = event.currentTarget.dataset.id
    const result = await wx.showModal({
      title: '重置临时密码',
      content: '',
      editable: true,
      placeholderText: '输入 8-64 位临时密码',
      confirmText: '确认重置'
    })
    if (!result.confirm) return
    const temporaryPassword = result.content
    if (!isValidPassword(temporaryPassword)) {
      wx.showToast({ title: PASSWORD_MESSAGE, icon: 'none' })
      return
    }
    try {
      const updated = await adminUsers.resetUserPassword(userId, temporaryPassword)
      wx.showToast({ title: '密码已重置', icon: 'success' })
      if (this.handleCurrentUserMutation(updated)) return
      await this.loadUsers(false)
    } catch (error) {
      wx.showToast({ title: errorMessage(error), icon: 'none' })
    }
  },

  unlock(event) {
    const userId = event.currentTarget.dataset.id
    return this.runConfirmed({
      title: '确认解锁账号',
      content: '解锁后用户可立即重新尝试登录，是否继续？'
    }, () => adminUsers.unlockUser(userId))
  },

  unbindWechat(event) {
    const userId = event.currentTarget.dataset.id
    return this.runConfirmed({
      title: '确认解绑微信',
      content: '解绑后该用户需重新使用账号密码登录并绑定微信，是否继续？',
      confirmColor: '#be123c'
    }, () => adminUsers.unbindWechat(userId))
  }
})
