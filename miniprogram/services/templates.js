const { callBusinessApi } = require('../utils/cloud')

const UNAVAILABLE_MESSAGES = Object.freeze({
  ASSIGNEE_INACTIVE: '模板负责人不可用，请联系管理员',
  TEMPLATE_LIMIT_EXCEEDED: '模板节点或负责人过多，请联系管理员调整'
})
const DEFAULT_UNAVAILABLE_MESSAGE = '模板当前不可创建售后，请联系管理员'

function unavailableReasonMessage(reason) {
  if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(UNAVAILABLE_MESSAGES, reason)) {
    return UNAVAILABLE_MESSAGES[reason]
  }
  return DEFAULT_UNAVAILABLE_MESSAGE
}

function listTemplates(query, options) { return callBusinessApi('listTemplates', query, options) }
function getTemplate(templateId) { return callBusinessApi('getTemplate', { templateId }) }
function getTemplateCardDisplay(templateId) { return callBusinessApi('getTemplateCardDisplay', { templateId }) }
function updateTemplateCardDisplay(templateId, expectedRevision, fields) {
  return callBusinessApi('updateTemplateCardDisplay', { templateId, expectedRevision, fields })
}
function createTemplate(definition) { return callBusinessApi('createTemplate', definition) }
function copyTemplate(templateId, expectedVersion) {
  return callBusinessApi('copyTemplate', { templateId, expectedVersion }, { silent: true })
}
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
  listTemplates, getTemplate, createTemplate, copyTemplate, updateTemplate, getTemplateCardDisplay, updateTemplateCardDisplay,
  changeTemplateStatus, deleteTemplate, listEnabledTemplates, unavailableReasonMessage
}
