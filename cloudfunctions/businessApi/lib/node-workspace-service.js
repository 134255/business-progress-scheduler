const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function createNodeWorkspaceService({ businessService, feedbackService }) {
  if (!businessService || typeof businessService.getBusinessLine !== 'function') {
    throw new TypeError('businessService.getBusinessLine is required')
  }
  if (!feedbackService || typeof feedbackService.getNodeHistory !== 'function') {
    throw new TypeError('feedbackService.getNodeHistory is required')
  }

  async function getNodeWorkspace({ actor, businessLineId, nodeId }) {
    const [detail, historyResult] = await Promise.all([
      businessService.getBusinessLine({ actor, lineId: businessLineId }),
      feedbackService.getNodeHistory({ actor, businessLineId, nodeId })
    ])
    const nodes = Array.isArray(detail && detail.nodes) ? detail.nodes : []
    const node = nodes.find(item => item && item._id === nodeId)
    if (!detail || !detail.line || detail.line._id !== businessLineId || !node ||
        !historyResult || !historyResult.node || historyResult.node.id !== nodeId) {
      throw createError('NOT_FOUND')
    }
    return {
      line: detail.line,
      node,
      canSubmit: Boolean(historyResult.canSubmit),
      history: Array.isArray(historyResult.history) ? historyResult.history : []
    }
  }

  return { getNodeWorkspace }
}

module.exports = { createNodeWorkspaceService }
