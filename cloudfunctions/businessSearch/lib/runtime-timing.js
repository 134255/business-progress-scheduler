const { performance } = require('node:perf_hooks')

const PHASES = new Set(['sdk_load', 'sdk_init', 'database_create', 'handler_create', 'handler_execute'])
const NOOP = () => {}
const MAX_MS = 3600000

// Covers main's first-use bootstrap, not the platform's pre-main cold start.
// Each phase runs once; no payloads, IDs, errors or SDK objects are recorded.
function createRuntimeTiming({ handlerReused, logger = console, now = () => performance.now() } = {}) {
  const readClock = () => {
    try {
      const value = now()
      if (Number.isFinite(value)) return value
      Promise.resolve(value).catch(NOOP)
      return null
    } catch (_) { return null }
  }
  const elapsed = (from, to) => from === null || to === null || to < from
    ? null : Math.min(MAX_MS, Math.round(to - from))
  const started = readClock()
  const stages = {}
  let finished = false
  function start(phase) {
    if (finished || !PHASES.has(phase) || Object.hasOwn(stages, phase)) return NOOP
    const from = readClock()
    const stage = { durationMs: null, failed: false }
    stages[phase] = stage
    return failed => { stage.durationMs = elapsed(from, readClock()); stage.failed = failed === true }
  }
  function finish(outcome) {
    if (finished) return
    finished = true
    const event = { schemaVersion: 1, action: 'index', handlerReused: handlerReused === true,
      outcome: outcome === 'OK' ? 'OK' : 'ERROR', durationMs: elapsed(started, readClock()), stages }
    try {
      if (logger && typeof logger.info === 'function') {
        Promise.resolve(logger.info('[businessSearch.runtimeTiming]', event)).catch(NOOP)
      }
    } catch (_) { /* Ignore sink failures; asynchronous sinks are never awaited. */ }
  }
  return { start, finish }
}

function measureRuntimeStage(timing, phase, operation) {
  const end = timing ? timing.start(phase) : NOOP
  try { const result = operation(); end(false); return result } catch (error) { end(true); throw error }
}

async function measureRuntimeStageAsync(timing, phase, operation) {
  const end = timing ? timing.start(phase) : NOOP
  try { const result = await operation(); end(false); return result } catch (error) { end(true); throw error }
}

module.exports = { createRuntimeTiming, measureRuntimeStage, measureRuntimeStageAsync }
