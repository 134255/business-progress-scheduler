'use strict'

const { createHolidayApiClient } = require('./lib/holiday-api-client')
const { createCalendarSyncService } = require('./lib/calendar-sync-service')
const { createCloudCalendarRepository } = require('./lib/cloud-calendar-repository')
const { createWorkTimeService } = require('./lib/work-time-service')

function normalizeNow(value, clock) {
  if (value === undefined) return clock()
  if (value instanceof Date) return new Date(value)
  if (typeof value === 'string' || typeof value === 'number') return new Date(value)
  return new Date(Number.NaN)
}

function createCalendarSyncHandler({ service, clock = () => new Date() } = {}) {
  if (!service || typeof service.run !== 'function') throw new TypeError('service.run is required')
  if (typeof clock !== 'function') throw new TypeError('clock is required')
  return async function calendarSyncHandler(event = {}) {
    const mode = event.mode === undefined ? 'scheduled' : event.mode
    if (!['scheduled', 'manual'].includes(mode)) throw new TypeError('mode must be scheduled or manual')
    const now = normalizeNow(event.now, clock)
    if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date')
    return service.run({ mode, now })
  }
}

function createDefaultHandler() {
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const db = cloud.database()
  const repository = createCloudCalendarRepository({ db })
  const service = createCalendarSyncService({
    holidayClient: createHolidayApiClient(),
    calendarRepository: repository,
    workTimeService: createWorkTimeService({ calendarRepository: repository })
  })
  return createCalendarSyncHandler({ service })
}

let defaultHandler

exports.main = async function main(event) {
  if (!defaultHandler) defaultHandler = createDefaultHandler()
  return defaultHandler(event)
}

exports.createCalendarSyncHandler = createCalendarSyncHandler
