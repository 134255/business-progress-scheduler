'use strict'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const WORK_START_MINUTE = 9 * 60
const WORK_END_MINUTE = 20 * 60

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
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

function createWorkTimeService({ calendarRepository } = {}) {
  if (!calendarRepository || typeof calendarRepository.getDayRule !== 'function') {
    throw new TypeError('calendarRepository.getDayRule is required')
  }
  async function workingMinutesBetween(startAt, endAt) {
    if (!validDate(startAt) || !validDate(endAt) || endAt.getTime() < startAt.getTime()) {
      throw new TypeError('valid ordered dates are required')
    }
    if (endAt.getTime() === startAt.getTime()) return { status: 'calculated', minutes: 0, calendarVersion: null }
    let elapsedMs = 0
    const versions = new Set()
    const firstDay = localDay(startAt)
    const lastDay = localDay(new Date(endAt.getTime() - 1))
    for (let day = firstDay; day <= lastDay; day += 1) {
      const overlapStart = Math.max(startAt.getTime(), workStart(day))
      const overlapEnd = Math.min(endAt.getTime(), workEnd(day))
      if (overlapEnd <= overlapStart) continue
      const date = dateKey(day)
      const rule = await calendarRepository.getDayRule(date)
      if (!rule || rule.date !== date || typeof rule.isWorkday !== 'boolean') {
        return { status: 'pending_calendar', minutes: null, missingDate: date }
      }
      if (typeof rule.calendarVersion === 'string' && rule.calendarVersion) versions.add(rule.calendarVersion)
      if (rule.isWorkday) elapsedMs += overlapEnd - overlapStart
    }
    return {
      status: 'calculated',
      minutes: Math.floor(elapsedMs / MINUTE_MS),
      calendarVersion: versions.size ? [...versions].sort().join('|') : null
    }
  }
  return { workingMinutesBetween }
}

module.exports = { createWorkTimeService }
