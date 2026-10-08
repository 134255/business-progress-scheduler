// Presentation state only: never replace, truncate or mutate the server history.
function initialCompactState() {
  return { feedbackHistoryOpen: false, reviewHistoryOpen: false, expandedFeedback: {} }
}

function toggleCompactSection(state, section) {
  if (!['feedbackHistoryOpen', 'reviewHistoryOpen'].includes(section)) return {}
  return { [section]: !state[section] }
}

function toggleFeedbackRevision(state, history, feedbackId) {
  if (typeof feedbackId !== 'string' || !Array.isArray(history) ||
      !history.some(item => item && item.feedbackId === feedbackId)) return {}
  const expanded = state.expandedFeedback || {}
  const wasOpen = Object.prototype.hasOwnProperty.call(expanded, feedbackId) && expanded[feedbackId] === true
  return { expandedFeedback: { ...expanded, [feedbackId]: !wasOpen } }
}

function compactValueText(value) {
  if (value === null || value === undefined || value === '') return '未填写'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.length ? value.join('、') : '未填写'
  return String(value)
}

module.exports = { initialCompactState, toggleCompactSection, toggleFeedbackRevision, compactValueText }
