'use strict'

const MAX_RECALCULATION_BATCH = 40

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function shanghaiYear(value) {
  return Number(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric'
  }).format(value))
}

function requireMethod(target, name) {
  if (!target || typeof target[name] !== 'function') throw new TypeError(`${name} is required`)
  return target[name].bind(target)
}

function createCalendarSyncService({ holidayClient, calendarRepository, workTimeService, clock = () => new Date() } = {}) {
  const fetchYear = requireMethod(holidayClient, 'fetchYear')
  const replaceYear = requireMethod(calendarRepository, 'replaceYear')
  const listCandidates = requireMethod(calendarRepository, 'listPendingDueCandidates')
  const applyCalculation = requireMethod(calendarRepository, 'applyDueCalculation')
  const ensureWarning = requireMethod(calendarRepository, 'ensurePendingCalendarWarning')
  const tryAddWorkMinutes = requireMethod(workTimeService, 'tryAddWorkMinutes')
  const workingMinutesBetween = requireMethod(workTimeService, 'workingMinutesBetween')
  if (typeof clock !== 'function') throw new TypeError('clock is required')

  async function run({ mode = 'scheduled', now = clock() } = {}) {
    if (!['scheduled', 'manual'].includes(mode)) throw new TypeError('mode must be scheduled or manual')
    if (!validDate(now)) throw new TypeError('now must be a valid Date')
    const firstYear = shanghaiYear(now)
    const years = []
    for (const year of [firstYear, firstYear + 1]) {
      try {
        const calendar = await fetchYear(year)
        await replaceYear({
          year,
          days: calendar.days,
          sourceVersion: calendar.sourceVersion,
          syncedAt: new Date(now)
        })
        years.push({
          year,
          status: 'synced',
          sourceVersion: calendar.sourceVersion,
          dayCount: calendar.days.length
        })
      } catch (error) {
        years.push({ year, status: 'failed', errorCategory: 'SYNC_FAILED' })
      }
    }

    const candidates = await listCandidates({ limit: MAX_RECALCULATION_BATCH })
    if (!Array.isArray(candidates) || candidates.length > MAX_RECALCULATION_BATCH) {
      throw new TypeError('calendar repository returned an invalid candidate batch')
    }
    const recalculation = { examined: candidates.length, updated: 0, skipped: 0, pending: 0, failed: 0 }
    for (const candidate of candidates) {
      try {
        let calculation
        if (candidate.kind === 'review_processing_carryover') {
          const elapsed = await workingMinutesBetween(candidate.startAt, candidate.endAt)
          if (elapsed && elapsed.status === 'calculated' &&
              Number.isSafeInteger(elapsed.minutes) && elapsed.minutes >= 0 && validDate(candidate.resumeAt)) {
            const totalElapsed = candidate.currentElapsedWorkMinutes + elapsed.minutes
            if (!Number.isSafeInteger(totalElapsed)) throw new TypeError('carryover minutes are invalid')
            const remaining = Math.max(0, candidate.totalWorkMinutes - totalElapsed)
            const due = await tryAddWorkMinutes(candidate.resumeAt, remaining)
            calculation = due && due.status === 'calculated'
              ? {
                  ...elapsed,
                  dueAt: due.dueAt,
                  dueCalendarVersion: due.calendarVersion || null
                }
              : due
          } else {
            calculation = elapsed
          }
        } else {
          calculation = ['review_processing', 'review_timing_carryover', 'review_response']
            .includes(candidate.kind)
            ? await workingMinutesBetween(candidate.startAt, candidate.endAt)
            : await tryAddWorkMinutes(candidate.startAt, candidate.minutes)
        }
        if (!calculation || calculation.status !== 'calculated') {
          recalculation.pending += 1
          await ensureWarning({ candidate, now: new Date(now) })
          continue
        }
        const changed = await applyCalculation({ candidate, calculation, now: new Date(now) })
        if (changed) recalculation.updated += 1
        else recalculation.skipped += 1
      } catch (error) {
        recalculation.failed += 1
      }
    }
    return { mode, years, recalculation }
  }

  return { run }
}

module.exports = { MAX_RECALCULATION_BATCH, createCalendarSyncService }
