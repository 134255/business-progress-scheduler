import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FULL_COLLECTION_TARGETS = Object.freeze([
  'templates',
  'template_nodes',
  'business_lines',
  'business_nodes',
  'node_feedback',
  'node_review_rounds',
  'node_review_votes',
  'evidences',
  'notifications',
  'public_node_shares',
  'public_node_share_chunks',
  'business_search_requests',
  'business_search_documents',
  'operations_analytics_facts',
  'operations_analytics_daily',
  'node_text_parse_requests'
])

export const PRESERVED_COLLECTIONS = Object.freeze([
  'users',
  'user_credentials',
  'wechat_bindings',
  'sequence_counters',
  'audit_logs',
  'system_settings',
  'node_text_parse_usage',
  'work_calendar_years',
  'work_calendar_entries',
  'calendar_sync_requests'
])

export const SCOPED_SYSTEM_SETTING_IDS = Object.freeze([
  'business-search-backfill-cursor',
  'business-search-recovery-cursor',
  'business-search-cleanup-cursor',
  'operations-analytics-node-cursor',
  'operations-analytics-decision-cursor',
  'operations-analytics-business-cursor',
  'operations-analytics-refresh-cursor',
  'workflow-reminder-processing-cursor',
  'workflow-reminder-review-cursor',
  'workflow-reminder-optional-tail-decision-cursor',
  'calendar-review-processing-cursor',
  'calendar-review-carryover-cursor',
  'calendar-review-timing-carryover-cursor',
  'calendar-review-vote-response-cursor',
  'calendar-optional-tail-decision-cursor',
  'calendar-direct-processing-completion-cursor',
  'evidence-retention:reminders',
  'evidence-retention:due-evidence',
  'evidence-retention:orphans',
  'evidence-retention:feedback-reservations',
  'evidence-retention:amendment-reservations'
])

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const EVIDENCE_ID = /^evidence-[a-f0-9]{64}$/
const CLOUD_PREFIX = /^cloud:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const OBJECT_KEY = /^evidence-uploads\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/(evidence-[a-f0-9]{64})\.([a-z0-9]+)$/
const MANAGED_STORAGE_STATUSES = new Set(['uploading', 'available', 'purge_failed'])

function configurationError() {
  return new TypeError('invalid dry-run configuration')
}

function exactPositiveInteger(value, fallback, maximum) {
  const normalized = value === undefined ? fallback : value
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw configurationError()
  }
  return normalized
}

function ownValue(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined
}

async function scanCollection({ listPage, collection, pageSize, visit }) {
  let afterId = ''
  let count = 0
  for (;;) {
    const page = await listPage(collection, afterId, pageSize)
    if (!Array.isArray(page) || page.length > pageSize) throw new Error('invalid read-only page')
    if (!page.length) return count
    let previous = afterId
    for (const row of page) {
      const id = ownValue(row, '_id')
      if (typeof id !== 'string' || !id || id <= previous) throw new Error('invalid read-only page')
      previous = id
      count += 1
      if (!Number.isSafeInteger(count)) throw new Error('inventory count overflow')
      if (visit) await visit(row)
    }
    afterId = previous
    if (page.length < pageSize) return count
  }
}

function managedObject(evidence, cloudFilePrefix) {
  const evidenceId = ownValue(evidence, '_id')
  const businessLineId = ownValue(evidence, 'businessLineId')
  const nodeId = ownValue(evidence, 'nodeId')
  const extension = ownValue(evidence, 'extension')
  const storageStatus = ownValue(evidence, 'storageStatus')
  const purgedAt = ownValue(evidence, 'purgedAt')
  if (!EVIDENCE_ID.test(evidenceId || '') || !DOCUMENT_ID.test(businessLineId || '') ||
      !DOCUMENT_ID.test(nodeId || '') || typeof extension !== 'string' || !/^[a-z0-9]+$/.test(extension) ||
      !MANAGED_STORAGE_STATUSES.has(storageStatus) || purgedAt !== null && purgedAt !== undefined) return null

  const rawObjectKey = ownValue(evidence, 'objectKey')
  const fileId = ownValue(evidence, 'fileId')
  let objectKey = typeof rawObjectKey === 'string' ? rawObjectKey : ''
  if (!objectKey && typeof fileId === 'string' && fileId.startsWith(`${cloudFilePrefix}/`)) {
    objectKey = fileId.slice(cloudFilePrefix.length + 1)
  }
  const match = OBJECT_KEY.exec(objectKey)
  if (!match || match[1] !== businessLineId || match[2] !== nodeId ||
      match[3] !== evidenceId || match[4] !== extension) return null

  const size = storageStatus === 'uploading'
    ? ownValue(evidence, 'declaredSize')
    : ownValue(evidence, 'size')
  if (!Number.isSafeInteger(size) || size < 1) return null
  return { evidenceId, objectKey, size }
}

export async function buildResetInventory(options = {}) {
  const { listPage, cloudFilePrefix } = options
  if (typeof listPage !== 'function' || typeof cloudFilePrefix !== 'string' ||
      !CLOUD_PREFIX.test(cloudFilePrefix)) throw configurationError()
  const pageSize = exactPositiveInteger(options.pageSize, 100, 100)
  const sampleLimit = exactPositiveInteger(options.sampleLimit, 20, 100)
  const objectLimit = exactPositiveInteger(options.objectLimit, 100, 1000)
  const collections = []
  const managedObjects = new Map()
  let invalidEvidenceCount = 0
  const invalidEvidenceIds = []

  for (const name of FULL_COLLECTION_TARGETS) {
    const sampleIds = []
    const count = await scanCollection({
      listPage,
      collection: name,
      pageSize,
      visit: row => {
        const id = ownValue(row, '_id')
        if (sampleIds.length < sampleLimit) sampleIds.push(id)
        if (name !== 'evidences') return
        const managed = managedObject(row, cloudFilePrefix)
        if (!managed) {
          invalidEvidenceCount += 1
          if (invalidEvidenceIds.length < sampleLimit && typeof id === 'string') invalidEvidenceIds.push(id)
          return
        }
        if (!managedObjects.has(managed.objectKey)) managedObjects.set(managed.objectKey, managed)
      }
    })
    collections.push({ name, count, sampleIds, truncated: count > sampleIds.length })
  }

  const scopedIdSet = new Set(SCOPED_SYSTEM_SETTING_IDS)
  const scopedIds = []
  const settingsCount = await scanCollection({
    listPage,
    collection: 'system_settings',
    pageSize,
    visit: row => {
      const id = ownValue(row, '_id')
      if (scopedIdSet.has(id)) scopedIds.push(id)
    }
  })
  scopedIds.sort()
  const objects = [...managedObjects.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey))
  const totalDeclaredBytes = objects.reduce((total, item) => {
    const next = total + item.size
    if (!Number.isSafeInteger(next)) throw new Error('inventory byte count overflow')
    return next
  }, 0)

  return {
    schemaVersion: 1,
    destructive: false,
    collections,
    scopedSystemSettings: {
      count: scopedIds.length,
      ids: scopedIds.slice(0, sampleLimit),
      truncated: scopedIds.length > sampleLimit,
      scannedCount: settingsCount
    },
    cosObjects: {
      count: objects.length,
      totalDeclaredBytes,
      keys: objects.slice(0, objectLimit).map(item => item.objectKey),
      truncated: objects.length > objectLimit,
      invalidEvidenceCount,
      invalidEvidenceIds,
      invalidEvidenceIdsTruncated: invalidEvidenceCount > invalidEvidenceIds.length
    }
  }
}

function createCloudReader(db) {
  return async function listPage(collection, afterId, limit) {
    let query = db.collection(collection)
    if (afterId) query = query.where({ _id: db.command.gt(afterId) })
    const result = await query.orderBy('_id', 'asc').limit(limit).get()
    return Array.isArray(result && result.data) ? result.data : []
  }
}

async function runCli() {
  const envId = process.env.BRANCH_RESET_ENV_ID
  const cloudFilePrefix = process.env.EVIDENCE_CLOUD_FILE_PREFIX
  if (typeof envId !== 'string' || !DOCUMENT_ID.test(envId) ||
      typeof cloudFilePrefix !== 'string' || !CLOUD_PREFIX.test(cloudFilePrefix)) {
    throw configurationError()
  }
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
  const defaultSdkPath = path.resolve(currentDirectory, '..', 'cloudfunctions', 'businessApi', 'node_modules', 'wx-server-sdk')
  const sdkPath = process.env.BRANCH_RESET_WX_SERVER_SDK_PATH || defaultSdkPath
  const require = createRequire(import.meta.url)
  const cloud = require(sdkPath)
  cloud.init({ env: envId })
  const inventory = await buildResetInventory({
    listPage: createCloudReader(cloud.database()),
    cloudFilePrefix
  })
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedAsScript) {
  runCli().catch(() => {
    process.stderr.write('只读重置清单生成失败；未执行任何删除或写入。\n')
    process.exitCode = 1
  })
}
