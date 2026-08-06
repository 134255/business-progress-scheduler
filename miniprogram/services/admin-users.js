const { callBusinessApi } = require('../utils/cloud')

function listUsers(query) {
  return callBusinessApi('listUsers', query)
}

function createUser(input) {
  return callBusinessApi('createUser', input)
}

function updateUser(userId, changes) {
  return callBusinessApi('updateUser', { userId, changes })
}

function resetUserPassword(userId, temporaryPassword) {
  return callBusinessApi('resetUserPassword', { userId, temporaryPassword })
}

function unlockUser(userId) {
  return callBusinessApi('unlockUser', { userId })
}

function unbindWechat(userId) {
  return callBusinessApi('unbindWechat', { userId })
}

module.exports = { listUsers, createUser, updateUser, resetUserPassword, unlockUser, unbindWechat }
