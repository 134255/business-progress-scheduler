'use strict'

const crypto = require('node:crypto')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const {
  exactAccountIds,
  hasAccountRelationshipMarker,
  ownDataValue,
  ownExactAccountIds
} = require('./account-relationship-schema')

const ACTIVE_NODE = new Set(['ready', 'in_progress', 'blocked'])
const ID = /^[A-Za-z0-9_-]{1,128}$/

function createError(code, message) {
  const error = new Error(message || code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex') }
function dateKey(now) { return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) }
function minuteKey(now) { return Math.floor(now.getTime() / 60000) }

function validDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1970 || month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function readData(result) { return result && result.data }

function isMissingDocumentError(error) {
  const codes = [error && error.code, error && error.errCode].map(value => String(value || '').toUpperCase())
  if (codes.includes('DOCUMENT_NOT_FOUND')) return true
  const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
  return text.includes('document.get:fail') && text.includes('document with _id') && text.includes('does not exist')
}

function ownValue(object, key) {
  if (!object || typeof object !== 'object') return { valid: false }
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { valid: true, value: descriptor.value }
    : { valid: false }
}

function storedTime(value) {
  if (value instanceof Date) return value.getTime()
  if (value && typeof value.toDate === 'function') return value.toDate().getTime()
  return Number.NaN
}

function normalizeStoredUsage(usage, expectedActorHash) {
  if (!usage) return null
  const stored = Object.fromEntries([
    'actorHash', 'dateKey', 'dailyCount', 'minuteKey', 'minuteCount',
    'inflightUntil', 'lockToken', 'revision'
  ].map(key => [key, ownValue(usage, key)]))
  const inflight = stored.inflightUntil.valid && stored.inflightUntil.value !== null
    ? storedTime(stored.inflightUntil.value)
    : 0
  const hasInflight = stored.inflightUntil.valid && stored.inflightUntil.value !== null
  const hasLock = stored.lockToken.valid && stored.lockToken.value !== ''
  if (Object.values(stored).some(entry => !entry.valid) || stored.actorHash.value !== expectedActorHash ||
      !validDateKey(stored.dateKey.value) ||
      !Number.isSafeInteger(stored.dailyCount.value) || stored.dailyCount.value < 0 ||
      !Number.isSafeInteger(stored.minuteKey.value) || stored.minuteKey.value < 0 ||
      !Number.isSafeInteger(stored.minuteCount.value) || stored.minuteCount.value < 0 ||
      stored.inflightUntil.value !== null && !Number.isFinite(inflight) ||
      typeof stored.lockToken.value !== 'string' || stored.lockToken.value !== '' && !/^[a-f0-9]{48}$/.test(stored.lockToken.value) ||
      hasInflight !== hasLock ||
      !Number.isSafeInteger(stored.revision.value) || stored.revision.value < 0 || stored.revision.value === Number.MAX_SAFE_INTEGER) {
    throw createError('NODE_TEXT_CONFIG_INVALID', '文本识别配置异常')
  }
  return {
    actorHash: stored.actorHash.value,
    dateKey: stored.dateKey.value,
    dailyCount: stored.dailyCount.value,
    minuteKey: stored.minuteKey.value,
    minuteCount: stored.minuteCount.value,
    inflightUntil: inflight,
    lockToken: stored.lockToken.value,
    revision: stored.revision.value
  }
}

function accountSchema(line, node) {
  if (!hasAccountRelationshipMarker(line) || !hasAccountRelationshipMarker(node)) return false
  const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
  const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
  const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
  const reviewers = ownExactAccountIds(node, 'reviewerUserIds', { nonEmpty: true })
  return Boolean(managers && members && processors && reviewers &&
    !processors.some(id => reviewers.includes(id)))
}

function accountMember(line, actorId) {
  const managerField = ownDataValue(line, 'managerUserIds')
  const memberField = ownDataValue(line, 'memberUserIds')
  const managers = managerField.valid ? exactAccountIds(managerField.value, { nonEmpty: true }) : null
  const members = memberField.valid ? exactAccountIds(memberField.value, { nonEmpty: true }) : null
  return Boolean(managers && members && [...managers, ...members].includes(actorId))
}

function assertAuthorized(actor, line, node, input) {
  if (!actor || actor.status !== 'active' || !line || line.status !== 'active' || !node || node.businessLineId !== line._id ||
      line.currentNodeId !== node._id || node.workflowMode !== 'review' || !ACTIVE_NODE.has(node.status) || node.version !== input.expectedNodeVersion) {
    throw createError('NODE_TEXT_STALE', '当前节点已变化，请刷新后重试')
  }
  if (!accountSchema(line, node) || !accountMember(line, actor._id)) {
    throw createError('FORBIDDEN', '你没有权限识别当前节点文本')
  }
  const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
  if (!processors || !processors.includes(actor._id)) throw createError('FORBIDDEN', '你没有权限识别当前节点文本')
  if (!Array.isArray(node.fieldDefinitions) || !node.fieldDefinitions.length) throw createError('NODE_TEXT_STALE', '当前节点没有可识别字段')
  return node
}

function createCloudNodeTextRecognitionRepository({ db, randomBytes = crypto.randomBytes } = {}) {
  if (!db || typeof db.runTransaction !== 'function') throw new TypeError('db is required')
  return {
    async authorizeRecognition(input) {
      if (!input || !ID.test(input.actorId || '') || !ID.test(input.businessLineId || '') || !ID.test(input.nodeId || '')) {
        throw createError('VALIDATION_ERROR', '请求参数不正确')
      }
      const [actorResult, lineResult, nodeResult] = await Promise.all([
        db.collection('users').doc(input.actorId).get(),
        db.collection('business_lines').doc(input.businessLineId).get(),
        db.collection('business_nodes').doc(input.nodeId).get()
      ])
      const node = assertAuthorized(readData(actorResult), readData(lineResult), readData(nodeResult), input)
      return { fieldDefinitions: node.fieldDefinitions }
    },
    async claimUsageAndCreateTicket(input) {
      const actorHash = hash(input.actorId)
      const usageId = `ntu_${actorHash}`
      const lockToken = randomBytes(24).toString('hex')
      const ticketId = `ntp_${randomBytes(24).toString('hex')}`
      const now = input.now
      if (!(now instanceof Date) || Number.isNaN(now.getTime()) || !Number.isSafeInteger(input.dailyLimit)) throw createError('NODE_TEXT_CONFIG_INVALID', '文本识别配置异常')
      return db.runTransaction(async transaction => {
        const actor = readData(await transaction.collection('users').doc(input.actorId).get())
        const line = readData(await transaction.collection('business_lines').doc(input.businessLineId).get())
        const node = readData(await transaction.collection('business_nodes').doc(input.nodeId).get())
        assertAuthorized(actor, line, node, input)
        const usageRef = transaction.collection('node_text_parse_usage').doc(usageId)
        let usage = null
        try {
          usage = readData(await usageRef.get())
        } catch (error) {
          if (!isMissingDocumentError(error)) throw error
        }
        usage = normalizeStoredUsage(usage, actorHash)
        const currentDate = dateKey(now)
        const currentMinute = minuteKey(now)
        if (usage && (usage.dateKey > currentDate || usage.minuteKey > currentMinute)) {
          throw createError('NODE_TEXT_CONFIG_INVALID', '文本识别配置异常')
        }
        const dailyCount = usage && usage.dateKey === currentDate ? usage.dailyCount : 0
        const minuteCount = usage && usage.minuteKey === currentMinute ? usage.minuteCount : 0
        const inflightUntil = usage ? usage.inflightUntil : 0
        if (inflightUntil > now.getTime()) throw createError('NODE_TEXT_BUSY', '已有文本识别正在进行，请稍后重试')
        if (minuteCount >= 10) throw createError('NODE_TEXT_RATE_LIMITED', '文本识别过于频繁，请稍后重试')
        if (dailyCount >= input.dailyLimit) throw createError('NODE_TEXT_DAILY_LIMITED', '今日文本识别次数已用完')
        const revision = usage ? usage.revision : 0
        await usageRef.set({ data: {
          actorHash, dateKey: currentDate, dailyCount: dailyCount + 1, minuteKey: currentMinute, minuteCount: minuteCount + 1,
          inflightUntil: new Date(now.getTime() + 60 * 1000), lockToken, revision: revision + 1, updatedAt: now
        } })
        await transaction.collection('node_text_parse_requests').doc(ticketId).set({ data: {
          status: 'pending', actorHash, businessLineId: input.businessLineId, nodeId: input.nodeId,
          expectedNodeVersion: input.expectedNodeVersion, schemaDigest: input.schemaDigest, textDigest: input.textDigest,
          requestKeyHash: input.requestKeyHash, expiresAt: new Date(now.getTime() + 5 * 60 * 1000), revision: 0, createdAt: now
        } })
        return { ticketId, actorHash, lockToken }
      })
    },
    async releaseUsage({ actorHash, lockToken, now }) {
      const usageRef = db.collection('node_text_parse_usage').doc(`ntu_${actorHash}`)
      try {
        await db.runTransaction(async transaction => {
          const ref = transaction.collection('node_text_parse_usage').doc(`ntu_${actorHash}`)
          const usage = readData(await ref.get())
          if (usage && usage.lockToken === lockToken && Number.isSafeInteger(usage.revision) && usage.revision < Number.MAX_SAFE_INTEGER) {
            await ref.update({ data: { lockToken: '', inflightUntil: null, revision: usage.revision + 1, updatedAt: now } })
          }
        })
      } catch (_) {
        void usageRef
      }
    }
  }
}

module.exports = { createCloudNodeTextRecognitionRepository, dateKey, minuteKey }
