const { performance } = require('node:perf_hooks')

const PHASES = new Set([
  'authorize', 'existing_lookup', 'template_read', 'template_validate', 'calendar_due',
  'snapshot_prepare', 'reservation_transaction', 'reservation_template_read',
  'reservation_template_validate', 'reservation_participants', 'reservation_write',
  'publication_transaction', 'calendar_warning', 'search_sync', 'card_refresh',
  'search_ticket_save', 'search_function_call'
])
const COUNTERS = new Set(['reservation_attempts', 'publication_attempts', 'calendar_attempts'])
const NOOP = () => {}
const MAX_COUNT = 1000
const MAX_MS = 3600000

// Request-local, fixed-schema diagnostics. Never accept payloads, identifiers,
// errors, result objects or user-supplied phase names as log fields.
function createCreationTiming({ logger, now = () => performance.now() } = {}) {
  const readClock = () => {
    try { const value = now(); return Number.isFinite(value) ? value : null } catch (_) { return null }
  }
  const elapsed = (from, to) => from === null || to === null || to < from
    ? null : Math.min(MAX_MS, Math.round(to - from))
  const started = readClock()
  const stages = {}
  const counters = {}
  const pending = new Set()
  let finished = false

  function start(phase) {
    if (finished || !PHASES.has(phase)) return NOOP
    const stage = stages[phase] || (stages[phase] = {
      durationMs: 0, calls: 0, failedCalls: 0, incompleteCalls: 0
    })
    if (stage.calls >= MAX_COUNT) return NOOP
    stage.calls++
    const from = readClock()
    const close = outcome => {
      if (!pending.delete(close)) return
      const duration = elapsed(from, readClock())
      stage.durationMs = duration === null || stage.durationMs === null
        ? null : Math.min(MAX_MS, stage.durationMs + duration)
      if (outcome === 'INCOMPLETE') stage.incompleteCalls++
      else if (outcome !== 'OK') stage.failedCalls++
    }
    pending.add(close)
    return (outcome = 'OK') => close(outcome)
  }

  function count(name) {
    if (!finished && COUNTERS.has(name)) counters[name] = Math.min(MAX_COUNT, (counters[name] || 0) + 1)
  }

  function finish(outcome) {
    if (finished) return
    finished = true
    for (const close of pending) close('INCOMPLETE')
    const event = {
      schemaVersion: 1, action: 'createBusinessFromTemplate',
      outcome: outcome === 'OK' ? 'OK' : 'ERROR', durationMs: elapsed(started, readClock()), stages, counters
    }
    try {
      if (logger && typeof logger.info === 'function') {
        // Do not await logging or let a rejected custom sink affect creation.
        Promise.resolve(logger.info('[businessApi.creationTiming]', event)).catch(NOOP)
      }
    } catch (_) { /* Logging is strictly non-authoritative. */ }
  }
  return { start, count, finish }
}

function startCreationStage(timing, phase) {
  return timing ? timing.start(phase) : NOOP
}

function countCreationAttempt(timing, name) {
  if (timing) timing.count(name)
}

async function measureCreationStage(timing, phase, operation) {
  const end = startCreationStage(timing, phase)
  try {
    const result = await operation()
    end('OK')
    return result
  } catch (error) {
    end('ERROR')
    throw error
  }
}

module.exports = { createCreationTiming, startCreationStage, measureCreationStage, countCreationAttempt }
