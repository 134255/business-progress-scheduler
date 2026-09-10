const CAUSES = new Set([
  'SEARCH_SOURCE_INVALID', 'SEARCH_STATE_INVALID', 'SEARCH_CONFIGURATION_INVALID',
  'SEARCH_SECRET_INVALID', 'SEARCH_GENERATION_INVALID', 'SEARCH_CURSOR_INVALID',
  'INVALID_SEARCH_QUERY', 'INVALID_SEARCH_CYCLE', 'VERSION_CONFLICT', 'FORBIDDEN'
])
const PHASES = new Set(['load_snapshot', 'build_entries', 'publish_generation', 'recovery', 'query'])
const OPERATIONS = new Set(['index', 'query', 'recovery', 'cycle'])

function ownValue(object, key) {
  if (!object || typeof object !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined
}

function reportSearchFailure(logger, error, operation) {
  const cause = ownValue(error, 'code')
  const phase = ownValue(error, 'searchPhase')
  // Never log raw exceptions, messages, stack traces, tickets, IDs or source data.
  try {
    logger.error('[businessSearch]', {
      code: 'BUSINESS_SEARCH_FAILED',
      causeCode: CAUSES.has(cause) ? cause : 'UNKNOWN',
      phase: PHASES.has(phase) ? phase : 'unknown',
      operation: OPERATIONS.has(operation) ? operation : 'unknown'
    })
  } catch (_) {
    // Diagnostics must not change the authoritative operation outcome.
  }
}

module.exports = { reportSearchFailure }
