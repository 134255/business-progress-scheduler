const { callBusinessApi } = require('../utils/cloud')

function bootstrap() {
  return callBusinessApi('bootstrap')
}

function updateUserProfile(input) {
  return callBusinessApi('updateUserProfile', input)
}

async function dashboard() {
  const result = await callBusinessApi('listBusinessLines', { page: 1, pageSize: 20 })
  const items = Array.isArray(result.items) ? result.items : []
  return {
    stats: {
      active: items.filter(item => item.status === 'active').length,
      pendingMine: null,
      pendingMineAvailable: false,
      completed: items.filter(item => item.status === 'completed').length
    },
    recent: items.slice(0, 5)
  }
}

function listBusinessLines(filters) {
  return callBusinessApi('listBusinessLines', filters)
}

function getBusinessLine(id) {
  return callBusinessApi('getBusinessLine', { id })
}

function createBusinessFromTemplate(input) {
  return callBusinessApi('createBusinessFromTemplate', input)
}

function updateBusinessLine(input) {
  return callBusinessApi('updateBusinessLine', input)
}

function updateBusinessMetadata(input) {
  return callBusinessApi('updateBusinessMetadata', input)
}

function deleteBusinessLine(id) {
  return callBusinessApi('deleteBusinessLine', { id })
}

function submitNodeFeedback(input) {
  return callBusinessApi('submitNodeFeedback', input)
}

function getNodeHistory(businessLineId, nodeId) {
  return callBusinessApi('getNodeHistory', { businessLineId, nodeId })
}

function registerEvidenceUpload(input) {
  return callBusinessApi('registerEvidenceUpload', input)
}

function getEvidenceAccess(evidenceId) {
  return callBusinessApi('getEvidenceAccess', { evidenceId })
}

function submitFeedback(input) {
  return callBusinessApi('submitFeedback', input)
}

function rejectPreviousNode(input) {
  return callBusinessApi('rejectPreviousNode', input)
}

function closeBusinessLine(input) {
  return callBusinessApi('closeBusinessLine', input)
}

function listFrozenBusinessesForAdmin(query) {
  return callBusinessApi('listFrozenBusinessesForAdmin', query)
}

function getFrozenBusinessForAdmin(businessLineId) {
  return callBusinessApi('getFrozenBusinessForAdmin', { businessLineId })
}

function amendFrozenBusiness(input) {
  return callBusinessApi('amendFrozenBusiness', input)
}

module.exports = {
  bootstrap,
  updateUserProfile,
  dashboard,
  listBusinessLines,
  getBusinessLine,
  createBusinessFromTemplate,
  updateBusinessLine,
  updateBusinessMetadata,
  deleteBusinessLine,
  submitNodeFeedback,
  getNodeHistory,
  registerEvidenceUpload,
  getEvidenceAccess,
  submitFeedback,
  rejectPreviousNode,
  closeBusinessLine,
  listFrozenBusinessesForAdmin,
  getFrozenBusinessForAdmin,
  amendFrozenBusiness
}
