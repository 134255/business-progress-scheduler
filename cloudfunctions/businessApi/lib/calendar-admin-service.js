'use strict'

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

function applicationError(code, message) {
  const error = new Error(message)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function createCalendarAdminService({ db, invokeCalendarSync, clock, requestIdFactory } = {}) {
  if (!db || typeof db.collection !== 'function' || typeof invokeCalendarSync !== 'function' ||
      typeof clock !== 'function' || typeof requestIdFactory !== 'function') throw new TypeError('calendar admin dependencies are required')
  async function sync({ actor } = {}) {
    if (!actor || actor.status !== 'active' || actor.role !== 'super_admin') {
      throw applicationError('FORBIDDEN', '仅超级管理员可人工同步工作日历')
    }
    const now = clock()
    const requestId = requestIdFactory()
    if (!(now instanceof Date) || Number.isNaN(now.getTime()) ||
        typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(requestId)) throw new Error('invalid calendar admin dependency result')
    await db.collection('calendar_sync_requests').doc(requestId).set({ data: {
      purpose: 'manual_calendar_sync', status: 'pending', requestedByAccountId: actor._id, createdAt: new Date(now),
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000)
    } })
    try {
      const result = await invokeCalendarSync({ manualRequestId: requestId })
      return result && result.result !== undefined ? result.result : result
    } catch (error) {
      throw new Error('calendar sync invocation failed')
    }
  }
  return { sync }
}

module.exports = { createCalendarAdminService }
