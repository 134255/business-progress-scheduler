const { performance } = require('node:perf_hooks')

const PHASES = new Set([
  'ticket_consume', 'generation_check', 'snapshot_load', 'snapshot_head', 'snapshot_nodes',
  'entries_build', 'generation_publish', 'publish_nodes', 'generation_writes',
  'publication_transaction', 'publication_reads', 'publication_writes'
])
const COUNTERS = new Set([
  'ticket_attempts', 'publication_attempts', 'entry_write_attempts', 'token_write_attempts'
])
const MAX_CALLS = 1000
const MAX_COUNT = 100000
const MAX_MS = 3600000
const NOOP = () => {}

// Request-local diagnostics only. Parents include their children; concurrent
// writes are timed as one wall-clock stage, not a sum of overlapping writes.
// No identifiers, ticket values, payloads or errors are accepted as log fields.
function createIndexTiming({ logger, now = () => performance.now() } = {}) {
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
    if (stage.calls >= MAX_CALLS) return NOOP
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
      schemaVersion: 1, action: 'index', outcome: outcome === 'OK' ? 'OK' : 'ERROR',
      durationMs: elapsed(started, readClock()), stages, counters
    }
    try {
      if (logger && typeof logger.info === 'function') {
        Promise.resolve(logger.info('[businessSearch.indexTiming]', event)).catch(NOOP)
      }
    } catch (_) { /* Diagnostics must never change the indexing result. */ }
  }
  return { start, count, finish }
}

function countIndexOperation(timing, name) {
  if (timing) timing.count(name)
}

async function measureIndexStage(timing, phase, operation) {
  const end = timing ? timing.start(phase) : NOOP
  try {
    const result = await operation()
    end('OK')
    return result
  } catch (error) {
    end('ERROR')
    throw error
  }
}

module.exports = { createIndexTiming, measureIndexStage, countIndexOperation }
