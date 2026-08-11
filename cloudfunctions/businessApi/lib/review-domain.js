const crypto = require('node:crypto')

const WORKFLOW_MODE = 'review'
const REVIEW_MODES = new Set(['any', 'all'])
const WORK_ACTIONS = new Set(['save_progress', 'mark_blocked', 'submit_review'])
const VOTE_DECISIONS = new Set(['approved', 'rejected'])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeReviewMode(value) {
  if (typeof value !== 'string' || !REVIEW_MODES.has(value)) throw createError('REVIEW_MODE_INVALID')
  return value
}

function normalizeWorkAction(value) {
  if (typeof value !== 'string' || !WORK_ACTIONS.has(value)) throw createError('WORK_ACTION_INVALID')
  return value
}

function normalizeVoteInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !VOTE_DECISIONS.has(input.decision)) {
    throw createError('VOTE_DECISION_INVALID')
  }
  const comment = typeof input.comment === 'string' ? input.comment.trim() : ''
  if (input.decision === 'rejected' && !comment) throw createError('REVIEW_COMMENT_REQUIRED')
  return { decision: input.decision, comment }
}

function deterministicVoteId(roundId, reviewerUserId) {
  const digest = crypto.createHash('sha256').update(`${roundId}\0${reviewerUserId}`).digest('hex')
  return `review-vote-${digest}`
}

module.exports = {
  WORKFLOW_MODE,
  REVIEW_MODES,
  WORK_ACTIONS,
  normalizeReviewMode,
  normalizeWorkAction,
  normalizeVoteInput,
  deterministicVoteId
}
