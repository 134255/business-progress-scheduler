const { callBusinessApi } = require('../utils/cloud')

function bootstrap() {
  return callBusinessApi('bootstrap')
}

function dashboard() {
  return callBusinessApi('dashboard')
}

function listBusinessLines(filters) {
  return callBusinessApi('listBusinessLines', filters)
}

function getBusinessLine(id) {
  return callBusinessApi('getBusinessLine', { id })
}

function createBusinessLine(input) {
  return callBusinessApi('createBusinessLine', input)
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

module.exports = {
  bootstrap,
  dashboard,
  listBusinessLines,
  getBusinessLine,
  createBusinessLine,
  deleteBusinessLine,
  submitNodeFeedback,
  getNodeHistory
}
