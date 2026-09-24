const { ownDataValue } = require('./account-relationship-schema')
const { isStableId } = require('./business-card-summary')
const { boundedMap } = require('./bounded-map')

const MUTATIONS = new Set([
  'createBusinessFromTemplate', 'updateBusinessMetadata', 'submitFeedback',
  'saveAndSubmitNodeForReview', 'submitNodeForReview', 'submitReviewVote',
  'rejectPreviousNode', 'closeBusinessLine', 'amendFrozenBusiness',
  'decideOptionalTailNode', 'decideNodeRoute'
])
const NODE_MUTATIONS = new Set(['submitFeedback', 'saveAndSubmitNodeForReview', 'submitNodeForReview',
  'decideOptionalTailNode', 'decideNodeRoute', 'rejectPreviousNode'])
function id(object, key) {
  const value = ownDataValue(object, key)
  return value.valid && isStableId(value.value) ? value.value : null
}

function createBusinessCardService({ repository }) {
  if (!repository) throw new TypeError('repository is required')
  async function decorateItems({ actor, items, lineIdKey = '_id' }) {
    const session = repository.createRequestSession({ actor })
    const summaries = new Map()
    return boundedMap(items, async item => {
      // Task _id identifies a node/round, never the owning business line.
      const businessLineId = id(item, lineIdKey)
      if (!summaries.has(businessLineId)) summaries.set(businessLineId, session.getSummary({ businessLineId }))
      return { ...item, cardSummary: await summaries.get(businessLineId) }
    })
  }
  async function refreshBusinessLine({ actor, businessLineId }) {
    try { await repository.getSummary({ actor, businessLineId }) } catch (_) { /* Derived only; never log values. */ }
  }
  async function refreshAfterMutation({ actor, action, payload, result }) {
    try {
      if (!MUTATIONS.has(action)) return
      let businessLineId = id(result, 'businessLineId')
      if (!businessLineId && ['createBusinessFromTemplate', 'updateBusinessMetadata'].includes(action)) {
        businessLineId = id(result, 'id')
      }
      if (!businessLineId && action === 'submitReviewVote') {
        const reviewRoundId = id(payload, 'reviewRoundId') || id(result, 'reviewRoundId')
        if (!reviewRoundId) return
        businessLineId = await repository.resolveMutationLine({ reviewRoundId })
      }
      if (!businessLineId && action !== 'createBusinessFromTemplate') businessLineId = id(payload, 'businessLineId')
      if (!businessLineId && NODE_MUTATIONS.has(action)) {
        const nodeId = id(payload, action === 'rejectPreviousNode' ? 'currentNodeId' : 'nodeId')
        if (!nodeId) return
        businessLineId = await repository.resolveMutationLine({ nodeId })
      }
      if (businessLineId) await refreshBusinessLine({ actor, businessLineId })
    } catch (_) { /* Does not change the original business result/error. */ }
  }
  return { decorateItems, refreshBusinessLine, refreshAfterMutation }
}

module.exports = { createBusinessCardService }
