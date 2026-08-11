'use strict'

const { createHolidayApiClient } = require('./lib/holiday-api-client')
const { createCalendarSyncService } = require('./lib/calendar-sync-service')
const { createCloudCalendarRepository } = require('./lib/cloud-calendar-repository')
const { createWorkTimeService } = require('./lib/work-time-service')

function safeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createCalendarSyncHandler({
  service,
  manualAuthorizer = null,
  getContext = () => ({}),
  clock = () => new Date(),
  logger = console
} = {}) {
  if (!service || typeof service.run !== 'function') throw new TypeError('service.run is required')
  if (typeof clock !== 'function') throw new TypeError('clock is required')
  return async function calendarSyncHandler(event = {}) {
    const context = getContext() || {}
    if (typeof context.OPENID === 'string' && context.OPENID) throw safeError('FORBIDDEN', '禁止客户端直接调用日历同步')
    const now = clock()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid Date')
    let mode
    if (context.TRIGGER_SRC === 'timer' && !event.manualRequestId) {
      mode = 'scheduled'
    } else if (event && typeof event.manualRequestId === 'string' && event.manualRequestId && manualAuthorizer &&
        await manualAuthorizer.consume(event.manualRequestId, now)) {
      mode = 'manual'
    } else {
      throw safeError('FORBIDDEN', '日历同步调用未经授权')
    }
    try {
      return await service.run({ mode, now })
    } catch (error) {
      logger.error('[calendarSync]', { code: 'CALENDAR_SYNC_FAILED', mode })
      throw safeError('CALENDAR_SYNC_FAILED', '工作日历同步失败，请稍后重试')
    }
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
  const manualAuthorizer = {
    async consume(requestId, now) {
      return db.runTransaction(async transaction => {
        const ref = transaction.collection('calendar_sync_requests').doc(requestId)
        let result
        try { result = await ref.get() } catch (error) { return false }
        const request = result && result.data
        if (!request || request.purpose !== 'manual_calendar_sync' || request.status !== 'pending' || !(request.expiresAt instanceof Date) ||
            request.expiresAt.getTime() <= now.getTime()) return false
        await ref.update({ data: { status: 'consumed', consumedAt: db.serverDate() } })
        return true
      })
    }
  }
  return createCalendarSyncHandler({ service, manualAuthorizer, getContext: () => cloud.getWXContext() })
}

let defaultHandler

exports.main = async function main(event) {
  if (!defaultHandler) defaultHandler = createDefaultHandler()
  return defaultHandler(event)
}

exports.createCalendarSyncHandler = createCalendarSyncHandler
