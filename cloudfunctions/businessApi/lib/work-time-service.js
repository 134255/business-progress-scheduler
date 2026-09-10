'use strict'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const WORK_START_MINUTE = 9 * 60
const WORK_END_MINUTE = 20 * 60
const MINUTES_PER_WORKDAY = WORK_END_MINUTE - WORK_START_MINUTE
const MAX_CALENDAR_ATTEMPTS = 3

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function requireDate(value, name) {
  if (!validDate(value)) throw new TypeError(`${name} must be a valid Date`)
}

function localDay(value) {
  return Math.floor((value.getTime() + SHANGHAI_OFFSET_MS) / DAY_MS)
}

function dateKey(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function workStart(day) {
  return day * DAY_MS - SHANGHAI_OFFSET_MS + WORK_START_MINUTE * MINUTE_MS
}

function workEnd(day) {
  return day * DAY_MS - SHANGHAI_OFFSET_MS + WORK_END_MINUTE * MINUTE_MS
}

function pendingDue(missingDate) {
  return { status: 'pending_calendar', dueAt: null, missingDate }
}

function combinedVersion(versions) {
  const values = [...versions].sort()
  return values.length ? values.join('|') : null
}

function createWorkTimeService({ calendarRepository } = {}) {
  if (!calendarRepository || typeof calendarRepository.getDayRule !== 'function') {
    throw new TypeError('calendarRepository.getDayRule is required')
  }

  async function withCalendarSession(calculate, pending) {
    // Older/injected repositories keep their getDayRule-only contract.
    if (typeof calendarRepository.createReadSession !== 'function') return calculate(calendarRepository)
    for (let attempt = 0; attempt < MAX_CALENDAR_ATTEMPTS; attempt += 1) {
      const session = calendarRepository.createReadSession()
      const result = await calculate(session)
      const changedDate = await session.findChangedDate()
      if (changedDate === null) return result
      // Discard all dates, versions and partial arithmetic on a generation switch.
      if (attempt === MAX_CALENDAR_ATTEMPTS - 1) return pending(changedDate)
    }
  }

  async function readRule(calendar, day) {
    const key = dateKey(day)
    const rule = await calendar.getDayRule(key)
    if (!rule || rule.date !== key || typeof rule.isWorkday !== 'boolean') return null
    return rule
  }

  function recordVersion(versions, rule) {
    if (typeof rule.calendarVersion === 'string' && rule.calendarVersion) {
      versions.add(rule.calendarVersion)
    }
  }

  async function tryAddWorkMinutes(calendar, startAt, minutes) {
    requireDate(startAt, 'startAt')
    if (!Number.isSafeInteger(minutes) || minutes < 0) {
      throw new TypeError('minutes must be a non-negative safe integer')
    }
    if (minutes === 0) {
      return { status: 'calculated', dueAt: new Date(startAt), calendarVersion: null }
    }

    let cursor = startAt.getTime()
    let remaining = minutes
    const versions = new Set()
    for (;;) {
      let day = Math.floor((cursor + SHANGHAI_OFFSET_MS) / DAY_MS)
      if (cursor >= workEnd(day)) {
        day += 1
        cursor = workStart(day)
      }
      const rule = await readRule(calendar, day)
      if (!rule) return pendingDue(dateKey(day))
      recordVersion(versions, rule)
      if (!rule.isWorkday) {
        cursor = workStart(day + 1)
        continue
      }
      cursor = Math.max(cursor, workStart(day))
      const available = (workEnd(day) - cursor) / MINUTE_MS
      if (remaining <= available) {
        return {
          status: 'calculated',
          dueAt: new Date(cursor + remaining * MINUTE_MS),
          calendarVersion: combinedVersion(versions)
        }
      }
      remaining -= available
      cursor = workStart(day + 1)
    }
  }

  async function nextWorkInstant(calendar, at) {
    requireDate(at, 'at')
    let cursor = at.getTime()
    const versions = new Set()
    for (;;) {
      let day = Math.floor((cursor + SHANGHAI_OFFSET_MS) / DAY_MS)
      if (cursor >= workEnd(day)) {
        day += 1
        cursor = workStart(day)
      }
      const rule = await readRule(calendar, day)
      if (!rule) return pendingDue(dateKey(day))
      recordVersion(versions, rule)
      if (rule.isWorkday) {
        return {
          status: 'calculated',
          dueAt: new Date(Math.max(cursor, workStart(day))),
          calendarVersion: combinedVersion(versions)
        }
      }
      cursor = workStart(day + 1)
    }
  }

  async function workingMinutesBetween(calendar, startAt, endAt) {
    requireDate(startAt, 'startAt')
    requireDate(endAt, 'endAt')
    if (endAt.getTime() < startAt.getTime()) throw new RangeError('endAt must not be before startAt')
    if (endAt.getTime() === startAt.getTime()) {
      return { status: 'calculated', minutes: 0, calendarVersion: null }
    }
    const versions = new Set()
    let minutes = 0
    const firstDay = localDay(startAt)
    const lastDay = localDay(new Date(endAt.getTime() - 1))
    for (let day = firstDay; day <= lastDay; day += 1) {
      const overlapStart = Math.max(startAt.getTime(), workStart(day))
      const overlapEnd = Math.min(endAt.getTime(), workEnd(day))
      if (overlapEnd <= overlapStart) continue
      const rule = await readRule(calendar, day)
      if (!rule) {
        return { status: 'pending_calendar', minutes: null, missingDate: dateKey(day) }
      }
      recordVersion(versions, rule)
      if (rule.isWorkday) minutes += (overlapEnd - overlapStart) / MINUTE_MS
    }
    const completeMinutes = Math.floor(minutes)
    if (!Number.isSafeInteger(completeMinutes) || completeMinutes < 0) {
      throw new RangeError('working minutes exceed the safe integer range')
    }
    return {
      status: 'calculated',
      minutes: completeMinutes,
      calendarVersion: combinedVersion(versions)
    }
  }

  return {
    tryAddWorkMinutes: (startAt, minutes) => withCalendarSession(
      calendar => tryAddWorkMinutes(calendar, startAt, minutes), pendingDue),
    workingMinutesBetween: (startAt, endAt) => withCalendarSession(
      calendar => workingMinutesBetween(calendar, startAt, endAt),
      missingDate => ({ status: 'pending_calendar', minutes: null, missingDate })),
    nextWorkInstant: at => withCalendarSession(calendar => nextWorkInstant(calendar, at), pendingDue)
  }
}

module.exports = {
  WORK_START_MINUTE,
  WORK_END_MINUTE,
  MINUTES_PER_WORKDAY,
  createWorkTimeService
}
