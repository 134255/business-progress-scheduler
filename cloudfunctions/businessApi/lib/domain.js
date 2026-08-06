const NODE_TRANSITIONS = {
  pending: [],
  ready: ['in_progress', 'blocked', 'completed'],
  in_progress: ['in_progress', 'blocked', 'completed'],
  blocked: ['blocked', 'in_progress', 'completed'],
  completed: []
}
function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function isManager(line, openid) {
  return Boolean(openid) && Array.isArray(line && line.managerIds) && line.managerIds.includes(openid)
}

function isMember(line, openid) {
  return isManager(line, openid) || (Boolean(openid) && Array.isArray(line && line.memberIds) && line.memberIds.includes(openid))
}

function canFeedback(line, node, openid) {
  return isManager(line, openid) || (Boolean(openid) && Array.isArray(node && node.assigneeIds) && node.assigneeIds.includes(openid))
}

function canTransitionNode(currentStatus, nextStatus) {
  const allowed = NODE_TRANSITIONS[currentStatus] || []
  return allowed.includes(nextStatus)
}

function calculateProgress(completedCount, totalCount) {
  const total = Number(totalCount || 0)
  if (total <= 0) return 0
  const completed = Math.max(0, Math.min(Number(completedCount || 0), total))
  return Math.round((completed / total) * 100)
}

function normalizeLineInput(payload) {
  const input = payload || {}
  return {
    name: String(input.name || '').trim(),
    code: String(input.code || '').trim().toUpperCase(),
    description: String(input.description || '').trim(),
    plannedStartDate: input.plannedStartDate || '',
    plannedEndDate: input.plannedEndDate || ''
  }
}

module.exports = {
  NODE_TRANSITIONS,
  unique,
  isManager,
  isMember,
  canFeedback,
  canTransitionNode,
  calculateProgress,
  normalizeLineInput
}
