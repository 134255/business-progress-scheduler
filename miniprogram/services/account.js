const { callBusinessApi } = require('../utils/cloud')

function getSession() {
  return callBusinessApi('getSession', {}, { silent: true })
}

function login(username, password) {
  return callBusinessApi('login', { username, password }, { silent: true })
}

function completeFirstLogin(challengeToken, newPassword) {
  return callBusinessApi('completeFirstLogin', { challengeToken, newPassword }, { silent: true })
}

function changePassword(currentPassword, newPassword) {
  return callBusinessApi('changePassword', { currentPassword, newPassword }, { silent: true })
}

function initializeSuperAdmin(username, displayName, temporaryPassword, recoveryCode) {
  return callBusinessApi('initializeSuperAdmin', {
    username,
    displayName,
    temporaryPassword,
    recoveryCode
  }, { silent: true })
}

function recoverSuperAdmin(username, temporaryPassword, recoveryCode) {
  return callBusinessApi('recoverSuperAdmin', {
    username,
    temporaryPassword,
    recoveryCode
  }, { silent: true })
}

module.exports = {
  getSession,
  login,
  completeFirstLogin,
  changePassword,
  initializeSuperAdmin,
  recoverSuperAdmin
}
