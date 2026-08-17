'use strict'

const ORDINARY_NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,128}$/
const EVIDENCE_RETENTION_NOTIFICATION_ID = /^evidence-retention:[A-Za-z0-9_-]{1,128}:(?:1|7|15)$/

function isNotificationId(value) {
  return typeof value === 'string' &&
    (ORDINARY_NOTIFICATION_ID.test(value) || EVIDENCE_RETENTION_NOTIFICATION_ID.test(value))
}

module.exports = { isNotificationId }
