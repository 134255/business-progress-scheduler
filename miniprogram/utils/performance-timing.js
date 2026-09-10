const ACTIONS = new Set([
  'getDashboardWorkspace', 'listBusinessLines', 'getBusinessLine', 'getNodeWorkspace',
  'createBusinessFromTemplate', 'submitFeedback', 'submitNodeFeedback', 'updateBusinessMetadata',
  'submitNodeForReview', 'saveAndSubmitNodeForReview', 'submitReviewVote',
  'beginEvidenceUpload', 'refreshEvidenceUploadAuthorization', 'finalizeEvidenceUpload',
  'evidenceUpload'
])
const STAGES = new Set(['authorize', 'transfer', 'finalize'])

function readTimingClock(clock) {
  try { return Number(clock()) } catch (error) { return NaN }
}

function notifyTiming(observer, event) {
  try {
    if (typeof observer === 'function') Promise.resolve(observer(event)).catch(() => {})
  } catch (error) {}
}

// Explicit opt-in, memory only. No payloads, identifiers, file names, URLs or credentials.
function recordPerformanceTiming(event) {
  try {
    if (typeof getApp !== 'function') return
    const app = getApp()
    const state = app && app.globalData
    if (!state) return
    if (state.performanceDiagnostics !== true) {
      delete state.performanceTimings
      return
    }
    if (!event || !ACTIONS.has(event.action) || !Number.isFinite(event.durationMs)) return
    if (event.stage !== undefined && !STAGES.has(event.stage)) return
    const safe = {
      action: event.action,
      ...(event.stage === undefined ? {} : { stage: event.stage }),
      durationMs: Math.max(0, Math.round(event.durationMs)),
      outcomeCode: event.outcomeCode === 'OK' ? 'OK' : 'ERROR'
    }
    const samples = Array.isArray(state.performanceTimings) ? state.performanceTimings : []
    state.performanceTimings = [...samples.slice(-99), safe]
  } catch (error) {
    // Diagnostics must never change the result of a business operation.
  }
}

module.exports = { recordPerformanceTiming, readTimingClock, notifyTiming }
