const STORAGE_KEY = 'business-progress.manual-login-required.v1'

let sessionOverride = null

function requireManualLogin() {
  sessionOverride = true
  try {
    wx.setStorageSync(STORAGE_KEY, true)
  } catch (_error) {}
}

function isManualLoginRequired() {
  if (sessionOverride !== null) return sessionOverride
  try {
    return wx.getStorageSync(STORAGE_KEY) === true
  } catch (_error) {
    return false
  }
}

function clearManualLoginRequirement() {
  sessionOverride = false
  try {
    wx.removeStorageSync(STORAGE_KEY)
  } catch (_error) {}
}

module.exports = {
  requireManualLogin,
  isManualLoginRequired,
  clearManualLoginRequirement
}
