const { callBusinessApi } = require('../utils/cloud')

function listTemplates(query) { return callBusinessApi('listTemplates', query) }
function getTemplate(templateId) { return callBusinessApi('getTemplate', { templateId }) }
function createTemplate(definition) { return callBusinessApi('createTemplate', definition) }
function updateTemplate(templateId, expectedVersion, definition) {
  return callBusinessApi('updateTemplate', { templateId, expectedVersion, definition })
}
function changeTemplateStatus(templateId, expectedVersion, status) {
  return callBusinessApi('changeTemplateStatus', { templateId, expectedVersion, status })
}
function deleteTemplate(templateId, expectedVersion) {
  return callBusinessApi('deleteTemplate', { templateId, expectedVersion })
}
function listEnabledTemplates() { return callBusinessApi('listEnabledTemplates', {}) }

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate,
  changeTemplateStatus, deleteTemplate, listEnabledTemplates
}
