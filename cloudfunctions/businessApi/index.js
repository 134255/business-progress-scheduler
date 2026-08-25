const cloud = require('wx-server-sdk')
const crypto = require('node:crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const {
  unique,
  isManager,
  isMember,
  canFeedback,
  canTransitionNode,
  calculateProgress,
  normalizeLineInput
} = require('./lib/domain')
const { createAuthService } = require('./lib/auth-service')
const { createAdminUserService } = require('./lib/admin-user-service')
const { createCloudAccountRepository } = require('./lib/cloud-account-repository')
const { createTemplateService } = require('./lib/template-service')
const { createBusinessService } = require('./lib/business-service')
const { createBusinessLifecycleService } = require('./lib/business-lifecycle-service')
const {
  APPLICATION_ERROR_MARKER,
  createCloudTemplateRepository
} = require('./lib/cloud-template-repository')
const { createCloudBusinessRepository } = require('./lib/cloud-business-repository')
const { createCloudWorkCalendarRepository } = require('./lib/cloud-work-calendar-repository')
const { createWorkTimeService } = require('./lib/work-time-service')
const { createEvidenceService } = require('./lib/evidence-service')
const { createCloudEvidenceRepository } = require('./lib/cloud-evidence-repository')
const { createFeedbackService } = require('./lib/feedback-service')
const { createCloudFeedbackRepository } = require('./lib/cloud-feedback-repository')
const { createReviewService } = require('./lib/review-service')
const { createCloudReviewRepository } = require('./lib/cloud-review-repository')
const { hashPassword } = require('./lib/password')
const { createCalendarAdminService } = require('./lib/calendar-admin-service')
const { createOperationsService } = require('./lib/operations-service')
const { createCloudOperationsRepository } = require('./lib/cloud-operations-repository')
const { createShareService } = require('./lib/share-service')
const { createCloudShareRepository } = require('./lib/cloud-share-repository')
const { createBusinessSearchClient } = require('./lib/business-search-client')

const COLLECTIONS = {
  users: 'users',
  lines: 'business_lines',
  nodes: 'business_nodes',
  feedback: 'node_feedback',
  evidences: 'evidences',
  notifications: 'notifications',
  audit: 'audit_logs'
}

const PUBLIC_ACTIONS = new Set([
  'getSession',
  'bootstrap',
  'login',
  'completeFirstLogin',
  'initializeSuperAdmin',
  'recoverSuperAdmin',
  'getPublicNodeShare'
])

const ACCOUNT_ACTIONS = new Set([
  'getSession',
  'bootstrap',
  'login',
  'completeFirstLogin',
  'initializeSuperAdmin',
  'recoverSuperAdmin',
  'changePassword',
  'listUsers',
  'createUser',
  'updateUser',
  'resetUserPassword',
  'unlockUser',
  'unbindWechat'
])

const ADMIN_TARGET_ACTIONS = new Set([
  'updateUser',
  'resetUserPassword',
  'unlockUser',
  'unbindWechat'
])

const LOGGABLE_ERROR_CODES = new Set([
  'ACCOUNT_DISABLED',
  'ACCOUNT_LOCKED',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_STATE_INVALID',
  'ALREADY_INITIALIZED',
  'ASSIGNEE_INACTIVE',
  'CREATOR_REVIEWER_CONFLICT',
  'PROCESSOR_INACTIVE',
  'REVIEWER_INACTIVE',
  'ROLE_OVERLAP',
  'BUSINESS_FROZEN',
  'BUSINESS_ERROR',
  'CREDENTIAL_CHANGED',
  'DUPLICATE_CODE',
  'EVIDENCE_EXPIRED',
  'EVIDENCE_NOT_ATTACHABLE',
  'FEEDBACK_COMMIT_IN_PROGRESS',
  'FEEDBACK_TOTAL_TOO_LARGE',
  'FILE_TOO_LARGE',
  'FORBIDDEN',
  'IMMUTABLE_USERNAME',
  'INTERNAL_ERROR',
  'INVALID_CHALLENGE',
  'INVALID_CHANGES',
  'INVALID_CREDENTIALS',
  'INVALID_FIELD_VALUE',
  'INVALID_KEYWORD',
  'INVALID_PAGINATION',
  'INVALID_QUERY',
  'INVALID_RECOVERY_CODE',
  'INVALID_ROLE',
  'INVALID_STATUS',
  'INVALID_TRANSITION',
  'INVALID_USERNAME',
  'INVALID_WECHAT_IDENTITY',
  'LAST_SUPER_ADMIN',
  'NODE_STRUCTURE_LOCKED',
  'NODE_ALREADY_COMPLETED',
  'NODE_NOT_ACTIVE',
  'NODE_PENDING_REVIEW',
  'NOT_FOUND',
  'OPENID_ALREADY_BOUND',
  'PASSWORD_CHANGE_REQUIRED',
  'RANGE_TOO_LARGE',
  'REJECTION_NOT_ALLOWED',
  'REVIEW_COMMENT_REQUIRED',
  'SHARE_UNAVAILABLE',
  'TEMPLATE_INVALID',
  'TEMPLATE_LIMIT_EXCEEDED',
  'TEMPLATE_NOT_EDITABLE',
  'TEMPLATE_NOT_ENABLED',
  'UNAUTHENTICATED',
  'UNAUTHORIZED',
  'UNSUPPORTED_FILE_TYPE',
  'UNKNOWN_ACTION',
  'USERNAME_TAKEN',
  'VALIDATION_ERROR',
  'VERSION_CONFLICT',
  'VOTE_CONFLICT',
  'VOTE_DECISION_INVALID',
  'WEAK_PASSWORD',
  'WECHAT_ALREADY_BOUND'
])

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function safeTargetUserId(action, payload) {
  if (!ADMIN_TARGET_ACTIONS.has(action)) return ''
  const targetUserId = payload.userId || payload.id
  return typeof targetUserId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(targetUserId)
    ? targetUserId
    : ''
}

function safeErrorCode(value) {
  return LOGGABLE_ERROR_CODES.has(value) ? value : 'INTERNAL_ERROR'
}

function isPublicAction(action) {
  return PUBLIC_ACTIONS.has(action)
}

function createTemplateRoutes(templateService) {
  return {
    listTemplates: ({ actor, payload }) => templateService.listTemplates({ actor, query: payload }),
    getTemplate: ({ actor, payload }) => templateService.getTemplate({ actor, templateId: payload.templateId }),
    createTemplate: ({ actor, payload }) => templateService.createTemplate({ actor, input: payload }),
    updateTemplate: ({ actor, payload }) => templateService.updateTemplate({
      actor,
      templateId: payload.templateId,
      expectedVersion: payload.expectedVersion,
      input: payload.definition
    }),
    changeTemplateStatus: ({ actor, payload }) => templateService.changeTemplateStatus({
      actor,
      templateId: payload.templateId,
      expectedVersion: payload.expectedVersion,
      status: payload.status
    }),
    deleteTemplate: ({ actor, payload }) => templateService.deleteTemplate({
      actor,
      templateId: payload.templateId,
      expectedVersion: payload.expectedVersion
    }),
    listEnabledTemplates: ({ actor }) => templateService.listEnabledTemplates({ actor })
  }
}

function createBusinessRoutes(businessService) {
  return {
    listBusinessLines: ({ actor, payload }) => businessService.listBusinessLines({ actor, query: payload }),
    listMyPendingProcessing: ({ actor, payload }) => businessService.listMyPendingProcessing({
      actor,
      query: selectProtectedPayload(payload, new Set(['cursor', 'pageSize']))
    }),
    getMyDashboardSummary: ({ actor, payload }) => {
      selectProtectedPayload(payload, new Set())
      return businessService.getMyDashboardSummary({ actor })
    },
    getBusinessLine: ({ actor, payload }) => businessService.getBusinessLine({ actor, lineId: payload.id }),
    updateBusinessMetadata: ({ actor, payload }) => businessService.updateMetadata({ actor, input: payload }),
    createBusinessFromTemplate: ({ actor, payload }) => businessService.createFromTemplate({
      actor,
      input: payload
    })
  }
}

function createBusinessLifecycleRoutes(businessLifecycleService) {
  return {
    listFrozenBusinessesForAdmin: ({ actor, payload }) => businessLifecycleService.listFrozenBusinessesForAdmin({
      actor,
      query: payload
    }),
    getFrozenBusinessForAdmin: ({ actor, payload }) => businessLifecycleService.getFrozenBusinessForAdmin({
      actor,
      businessLineId: payload.businessLineId
    }),
    rejectPreviousNode: ({ actor, payload }) => businessLifecycleService.rejectPreviousNode({
      actor,
      input: payload
    }),
    closeBusinessLine: ({ actor, payload }) => businessLifecycleService.closeBusinessLine({
      actor,
      input: payload
    }),
    amendFrozenBusiness: ({ actor, payload }) => businessLifecycleService.amendFrozenBusiness({
      actor,
      input: payload
    })
  }
}

function createEvidenceRoutes(evidenceService) {
  return {
    registerEvidenceUpload: ({ actor, payload }) => evidenceService.registerUpload({
      actor,
      input: payload
    }),
    getEvidenceAccess: ({ actor, payload }) => evidenceService.getAccessGrant({
      actor,
      evidenceId: payload.evidenceId
    })
  }
}

function createFeedbackRoutes(feedbackService) {
  return {
    submitFeedback: ({ actor, payload }) => {
      const actionDescriptor = payload && Object.getOwnPropertyDescriptor(payload, 'action')
      const method = actionDescriptor && Object.prototype.hasOwnProperty.call(actionDescriptor, 'value')
        ? 'saveNodeProgress'
        : 'submitFeedback'
      return feedbackService[method]({ actor, input: payload })
    },
    getNodeHistory: ({ actor, payload }) => feedbackService.getNodeHistory({
      actor,
      businessLineId: payload.businessLineId,
      nodeId: payload.nodeId
    })
  }
}

function createCalendarAdminRoutes(calendarAdminService) {
  return calendarAdminService ? {
    syncWorkCalendar: ({ actor }) => calendarAdminService.sync({ actor })
  } : null
}

function createOperationsRoutes(operationsService) {
  if (!operationsService) return null
  const keys = new Set(['startDate', 'endDate', 'status', 'cursor', 'pageSize'])
  const analyticsKeys = new Set([
    'startDate', 'endDate', 'grain', 'templateId', 'templateVersion', 'status',
    'businessLineId', 'stableNodeId', 'processorToken', 'reviewerToken',
    'metric', 'cursor', 'pageSize'
  ])
  return {
    getOperationsDashboard: ({ actor, payload }) => operationsService.getDashboard({
      actor,
      query: selectProtectedPayload(payload, keys)
    }),
    exportOperationsRows: ({ actor, payload }) => operationsService.exportRows({
      actor,
      query: selectProtectedPayload(payload, keys)
    }),
    listOperationsTimingDetails: ({ actor, payload }) => operationsService.listTimingDetails({
      actor,
      query: selectProtectedPayload(payload, keys)
    }),
    getOperationsAnalyticsFilters: ({ actor, payload }) => operationsService.getAnalyticsFilters({
      actor,
      query: selectProtectedPayload(payload, analyticsKeys)
    }),
    getOperationsAnalyticsSummary: ({ actor, payload }) => operationsService.getAnalyticsSummary({
      actor,
      query: selectProtectedPayload(payload, analyticsKeys)
    }),
    listOperationsAnalyticsSamples: ({ actor, payload }) => operationsService.listAnalyticsSamples({
      actor,
      query: selectProtectedPayload(payload, analyticsKeys)
    })
  }
}

function createShareRoutes(shareService) {
  if (!shareService) return null
  return {
    createNodeShareSnapshot: ({ actor, payload }) => shareService.createNodeShareSnapshot({
      actor,
      input: selectProtectedPayload(payload, new Set(['businessLineId', 'nodeId', 'requestKey']))
    }),
    getPublicNodeShare: ({ payload }) => shareService.getPublicNodeShare({
      input: selectProtectedPayload(payload, new Set(['token', 'cursor', 'pageSize']))
    })
  }
}

const CLIENT_IDENTITY_KEYS = new Set(['actor', 'actorId', 'openid', 'openId', 'role'])

function selectProtectedPayload(payload, allowedKeys) {
  assert(payload && typeof payload === 'object' && !Array.isArray(payload),
    'Invalid payload', 'VALIDATION_ERROR')
  const result = {}
  for (const key of Reflect.ownKeys(payload)) {
    assert(typeof key === 'string', 'Invalid payload', 'VALIDATION_ERROR')
    const descriptor = Object.getOwnPropertyDescriptor(payload, key)
    assert(descriptor && hasOwn(descriptor, 'value'), 'Invalid payload', 'VALIDATION_ERROR')
    if (CLIENT_IDENTITY_KEYS.has(key)) continue
    assert(allowedKeys.has(key), 'Invalid payload', 'VALIDATION_ERROR')
    result[key] = descriptor.value
  }
  return result
}

function createReviewRoutes(reviewService) {
  if (!reviewService) return null
  return {
    submitNodeForReview: ({ actor, payload }) => reviewService.submitNodeForReview({
      actor,
      input: selectProtectedPayload(payload, new Set([
        'businessLineId', 'nodeId', 'expectedNodeVersion', 'requestKey'
      ]))
    }),
    submitReviewVote: ({ actor, payload }) => reviewService.submitReviewVote({
      actor,
      input: selectProtectedPayload(payload, new Set([
        'reviewRoundId', 'expectedRoundVersion', 'decision', 'comment', 'requestKey'
      ]))
    }),
    listMyPendingReviews: ({ actor, payload }) => reviewService.listMyPendingReviews({
      actor,
      query: selectProtectedPayload(payload, new Set(['page', 'pageSize']))
    }),
    getReviewDetail: ({ actor, payload }) => reviewService.getReviewDetail({
      actor,
      reviewRoundId: selectProtectedPayload(payload, new Set(['reviewRoundId'])).reviewRoundId
    }),
    listMyNotifications: ({ actor, payload }) => reviewService.listMyNotifications({
      actor,
      query: selectProtectedPayload(payload, new Set(['page', 'pageSize']))
    }),
    markNotificationRead: ({ actor, payload }) => reviewService.markNotificationRead({
      actor,
      notificationId: selectProtectedPayload(payload, new Set(['notificationId'])).notificationId
    })
  }
}

function createBusinessApi({
  repository,
  authService,
  adminUserService,
  templateService,
  businessService,
  businessLifecycleService,
  evidenceService,
  feedbackService,
  reviewService,
  calendarAdminService,
  operationsService,
  shareService,
  businessSearchClient,
  protectedRoutes = Object.create(null),
  legacyRoutes = Object.create(null),
  getContext,
  clock = Date.now,
  logger = console
}) {
  const domainRoutes = Object.assign(
    Object.create(null),
    templateService ? createTemplateRoutes(templateService) : null,
    businessService ? createBusinessRoutes(businessService) : null,
    businessLifecycleService ? createBusinessLifecycleRoutes(businessLifecycleService) : null,
    evidenceService ? createEvidenceRoutes(evidenceService) : null,
    feedbackService ? createFeedbackRoutes(feedbackService) : null,
    createReviewRoutes(reviewService),
    createCalendarAdminRoutes(calendarAdminService),
    createOperationsRoutes(operationsService),
    createShareRoutes(shareService),
    protectedRoutes
  )

  async function resolveActor(openid) {
    assert(openid, 'Unable to identify the current WeChat user', 'UNAUTHORIZED')
    const actor = await repository.findUserByOpenid(openid)
    assert(actor, 'Authentication required', 'UNAUTHORIZED')
    const credential = await repository.findCredential(actor._id)
    assert(credential, 'Account state is invalid', 'ACCOUNT_STATE_INVALID')
    assert(actor.status === 'active', 'Account is disabled', 'ACCOUNT_DISABLED')
    assert(!(credential.lockedUntil && credential.lockedUntil > clock()), 'Account is locked', 'ACCOUNT_LOCKED')
    assert(!credential.mustChangePassword, 'Password change required', 'PASSWORD_CHANGE_REQUIRED')
    return actor
  }

  function accountRoutes(openid, payload, actor) {
    return Object.assign(Object.create(null), {
      getSession: () => authService.getSession({ openid }),
      bootstrap: () => authService.getSession({ openid }),
      login: () => authService.login({ ...payload, openid }),
      completeFirstLogin: () => authService.completeFirstLogin({ ...payload, openid }),
      initializeSuperAdmin: () => authService.initializeSuperAdmin({ ...payload, openid }),
      recoverSuperAdmin: () => authService.recoverSuperAdmin(payload),
      changePassword: () => authService.changePassword({ ...payload, actor }),
      listUsers: () => adminUserService.listUsers({ actor, query: payload }),
      createUser: () => adminUserService.createUser({ actor, input: payload }),
      updateUser: () => adminUserService.updateUser({ actor, userId: payload.userId || payload.id, changes: payload.changes }),
      resetUserPassword: () => adminUserService.resetUserPassword({ actor, userId: payload.userId || payload.id, temporaryPassword: payload.temporaryPassword }),
      unlockUser: () => adminUserService.unlockUser({ actor, userId: payload.userId || payload.id }),
      unbindWechat: () => adminUserService.unbindWechat({ actor, userId: payload.userId || payload.id })
    })
  }

  async function main(event = {}) {
    const context = getContext() || {}
    const openid = context.OPENID
    const action = event.action
    const payload = event.payload || {}
    try {
      const knownAccountAction = ACCOUNT_ACTIONS.has(action)
      const knownProtectedAction = hasOwn(domainRoutes, action) && typeof domainRoutes[action] === 'function'
      const knownLegacyAction = hasOwn(legacyRoutes, action) && typeof legacyRoutes[action] === 'function'
      assert(knownAccountAction || knownProtectedAction || knownLegacyAction, 'Unsupported action', 'UNKNOWN_ACTION')
      const actor = isPublicAction(action) ? null : await resolveActor(openid)
      const routes = accountRoutes(openid, payload, actor)
      const route = hasOwn(routes, action) ? routes[action] : null
      const data = route
        ? await route()
        : knownProtectedAction
          ? await domainRoutes[action]({ actor, payload })
          : await legacyRoutes[action](actor.openid, payload)
      return ok(data)
    } catch (error) {
      const protectedAction = hasOwn(domainRoutes, action) && typeof domainRoutes[action] === 'function'
      const responseCode = protectedAction && error[APPLICATION_ERROR_MARKER] !== true
        ? 'INTERNAL_ERROR'
        : safeErrorCode(error.code)
      logger.error('[businessApi]', {
        action: ACCOUNT_ACTIONS.has(action) || hasOwn(domainRoutes, action) || hasOwn(legacyRoutes, action) ? action : 'UNKNOWN_ACTION',
        code: responseCode,
        requestId: context.REQUESTID || context.requestId || '',
        targetUserId: safeTargetUserId(action, payload)
      })
      return responseCode === 'INTERNAL_ERROR'
        ? fail('Service error', responseCode)
        : fail(error.message || 'Service error', responseCode)
    }
  }

  return { main }
}

function ok(data) {
  return { ok: true, data }
}

function fail(message, code) {
  return { ok: false, code: code || 'BUSINESS_ERROR', message }
}

function assert(condition, message, code) {
  if (!condition) {
    const error = new Error(message)
    error.code = code || 'VALIDATION_ERROR'
    error[APPLICATION_ERROR_MARKER] = true
    throw error
  }
}

function now() {
  return db.serverDate()
}

async function getLine(id) {
  assert(id, '缺少售后线 ID')
  const result = await db.collection(COLLECTIONS.lines).doc(id).get()
  assert(result.data && result.data.status !== 'deleted', '售后线不存在', 'NOT_FOUND')
  return result.data
}

async function writeAudit(openid, action, targetType, targetId, snapshot) {
  await db.collection(COLLECTIONS.audit).add({
    data: { openid, action, targetType, targetId, snapshot: snapshot || null, createdAt: now() }
  })
}

async function updateUserProfile(openid, payload) {
  const displayName = String(payload.displayName || '').trim()
  const avatarUrl = String(payload.avatarUrl || '').trim()
  assert(displayName.length >= 1 && displayName.length <= 30, '昵称长度需为 1-30 个字符')
  assert(!avatarUrl || avatarUrl.startsWith('cloud://') || avatarUrl.startsWith('https://'), '头像地址不合法')

  const users = db.collection(COLLECTIONS.users)
  const existing = await users.where({ openid }).limit(1).get()
  assert(existing.data.length, '用户档案不存在', 'NOT_FOUND')
  await users.doc(existing.data[0]._id).update({ data: { displayName, avatarUrl, updatedAt: now() } })
  await writeAudit(openid, 'update_profile', 'user', existing.data[0]._id, { displayName })
  return Object.assign({}, existing.data[0], { displayName, avatarUrl })
}

async function dashboard(openid) {
  const lines = await db.collection(COLLECTIONS.lines)
    .where({ memberIds: openid, status: _.neq('deleted') })
    .orderBy('updatedAt', 'desc')
    .limit(20)
    .get()

  const mine = await db.collection(COLLECTIONS.nodes)
    .where({ assigneeIds: openid, status: _.in(['ready', 'in_progress', 'blocked']) })
    .count()

  const items = lines.data
  return {
    stats: {
      active: items.filter(item => item.status === 'active').length,
      pendingMine: mine.total,
      completed: items.filter(item => item.status === 'completed').length
    },
    recent: items.slice(0, 5)
  }
}

function dateText(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function getNodeHistory(openid, payload) {
  const line = await getLine(payload.businessLineId)
  assert(isMember(line, openid), '你不是该售后线的关联成员', 'FORBIDDEN')
  const nodeResult = await db.collection(COLLECTIONS.nodes).doc(payload.nodeId).get()
  const node = nodeResult.data
  assert(node && node.businessLineId === line._id, '节点不存在', 'NOT_FOUND')

  const [feedbackResult, evidenceResult] = await Promise.all([
    db.collection(COLLECTIONS.feedback).where({ nodeId: node._id }).orderBy('createdAt', 'desc').limit(100).get(),
    db.collection(COLLECTIONS.evidences).where({ nodeId: node._id }).orderBy('createdAt', 'desc').limit(100).get()
  ])
  const labels = { in_progress: '处理中', blocked: '受阻', completed: '已完成' }
  return {
    canFeedback: canFeedback(line, node, openid),
    history: feedbackResult.data.map(item => Object.assign({}, item, { statusLabel: labels[item.status] || item.status, createdAtText: dateText(item.createdAt) })),
    evidences: evidenceResult.data.map(item => Object.assign({}, item, { createdAtText: dateText(item.createdAt) }))
  }
}

async function updateBusinessLine(openid, payload) {
  const line = await getLine(payload.id)
  assert(isManager(line, openid), '只有售后线管理员可以编辑', 'FORBIDDEN')
  assert(Number(payload.version) === Number(line.version), '售后线已被其他人更新，请刷新后重试', 'VERSION_CONFLICT')

  const normalized = normalizeLineInput(payload)
  assert(normalized.name, '售后线名称不能为空')
  assert(normalized.code, '售后线编号不能为空')
  const duplicate = await db.collection(COLLECTIONS.lines).where({ code: normalized.code, status: _.neq('deleted') }).limit(5).get()
  assert(!duplicate.data.some(item => item._id !== line._id), '售后线编号已存在', 'DUPLICATE_CODE')

  const nodes = Array.isArray(payload.nodes) ? payload.nodes : []
  const replaceNodes = Boolean(payload.replaceNodes)
  if (replaceNodes) {
    assert(Number(line.progress || 0) === 0, '售后已开始流转，不能再修改节点结构', 'NODE_STRUCTURE_LOCKED')
    assert(nodes.length > 0 && nodes.every(node => String(node.name || '').trim()), '至少需要一个有效售后节点')
    const existingNodes = await db.collection(COLLECTIONS.nodes).where({ businessLineId: line._id }).get()
    assert(existingNodes.data.every(node => ['pending', 'ready'].includes(node.status) && !node.latestComment), '节点已有反馈，不能修改节点结构', 'NODE_STRUCTURE_LOCKED')
  }

  const nextVersion = Number(line.version || 1) + 1
  const lineChanges = Object.assign({}, normalized, { version: nextVersion, updatedAt: now() })
  if (replaceNodes) {
    lineChanges.nodeCount = nodes.length
    lineChanges.currentNodeIndex = 0
    lineChanges.currentNodeName = String(nodes[0].name).trim()
  }
  const updated = await db.collection(COLLECTIONS.lines).where({ _id: line._id, version: line.version }).update({ data: lineChanges })
  assert(updated.stats && updated.stats.updated === 1, '售后线已被其他人更新，请刷新后重试', 'VERSION_CONFLICT')

  if (replaceNodes) {
    await db.collection(COLLECTIONS.nodes).where({ businessLineId: line._id }).remove()
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      await db.collection(COLLECTIONS.nodes).add({
        data: {
          businessLineId: line._id,
          sequence: index,
          name: String(node.name).trim(),
          status: index === 0 ? 'ready' : 'pending',
          assigneeIds: unique(node.assigneeIds),
          assigneeNames: unique(node.assigneeNames),
          watcherIds: unique(node.watcherIds),
          requiresEvidence: Boolean(node.requiresEvidence),
          evidenceTypes: node.evidenceTypes || ['pdf', 'png', 'jpg', 'jpeg'],
          dueDate: node.dueDate || '',
          createdAt: now(),
          updatedAt: now()
        }
      })
    }
  }

  await writeAudit(openid, 'update', 'business_line', line._id, { beforeVersion: line.version, afterVersion: nextVersion, replaceNodes })
  return { id: line._id, version: nextVersion }
}

async function deleteBusinessLine(openid, payload) {
  const line = await getLine(payload.id)
  assert(isManager(line, openid), '只有售后线管理员可以删除', 'FORBIDDEN')

  await db.collection(COLLECTIONS.lines).doc(line._id).update({
    data: { status: 'deleted', deletedAt: now(), deletedBy: openid, updatedAt: now() }
  })
  await writeAudit(openid, 'delete', 'business_line', line._id, { name: line.name, code: line.code })
  return { id: line._id }
}

async function submitNodeFeedback(openid, payload) {
  assert(payload.businessLineId && payload.nodeId, '缺少售后线或节点 ID')
  assert(['in_progress', 'blocked', 'completed'].includes(payload.status), '不支持的节点状态')

  const line = await getLine(payload.businessLineId)
  const nodeResult = await db.collection(COLLECTIONS.nodes).doc(payload.nodeId).get()
  const node = nodeResult.data
  assert(node && node.businessLineId === line._id, '节点不存在', 'NOT_FOUND')
  assert(canFeedback(line, node, openid), '只有节点负责人或售后线管理员可以反馈', 'FORBIDDEN')
  assert(canTransitionNode(node.status, payload.status), '当前节点状态不允许执行该操作', 'INVALID_TRANSITION')

  const evidences = Array.isArray(payload.evidences) ? payload.evidences : []
  if (payload.status === 'completed' && node.requiresEvidence) {
    assert(evidences.length > 0, '该节点完成时必须上传凭证')
  }

  const evidenceIds = []
  for (const evidence of evidences) {
    assert(evidence.fileId && evidence.fileName, '凭证信息不完整')
    const stored = await db.collection(COLLECTIONS.evidences).add({
      data: {
        businessLineId: line._id,
        nodeId: node._id,
        fileId: evidence.fileId,
        fileName: evidence.fileName,
        mimeType: evidence.mimeType || '',
        size: Number(evidence.size || 0),
        uploadedBy: openid,
        createdAt: now()
      }
    })
    evidenceIds.push(stored._id)
  }

  await db.collection(COLLECTIONS.feedback).add({
    data: {
      businessLineId: line._id,
      nodeId: node._id,
      status: payload.status,
      comment: String(payload.comment || '').trim(),
      evidenceIds,
      submittedBy: openid,
      createdAt: now()
    }
  })

  await db.collection(COLLECTIONS.nodes).doc(node._id).update({
    data: {
      status: payload.status,
      latestComment: String(payload.comment || '').trim(),
      latestEvidenceIds: evidenceIds,
      updatedAt: now(),
      completedAt: payload.status === 'completed' ? now() : null
    }
  })

  if (payload.status === 'completed') {
    const nextResult = await db.collection(COLLECTIONS.nodes)
      .where({ businessLineId: line._id, sequence: node.sequence + 1 })
      .limit(1)
      .get()
    const next = nextResult.data[0]

    if (next) {
      await db.collection(COLLECTIONS.nodes).doc(next._id).update({ data: { status: 'ready', activatedAt: now(), updatedAt: now() } })
      const progress = calculateProgress(node.sequence + 1, line.nodeCount || node.sequence + 2)
      await db.collection(COLLECTIONS.lines).doc(line._id).update({
        data: { currentNodeIndex: next.sequence, currentNodeName: next.name, progress, updatedAt: now() }
      })
      for (const recipientId of next.assigneeIds || []) {
        await db.collection(COLLECTIONS.notifications).add({
          data: {
            recipientId,
            businessLineId: line._id,
            nodeId: next._id,
            type: 'node_activated',
            status: 'pending',
            createdAt: now()
          }
        })
      }
    } else {
      await db.collection(COLLECTIONS.lines).doc(line._id).update({
        data: { status: 'completed', progress: 100, currentNodeName: node.name, completedAt: now(), updatedAt: now() }
      })
    }
  } else {
    await db.collection(COLLECTIONS.lines).doc(line._id).update({
      data: { status: payload.status === 'blocked' ? 'blocked' : 'active', updatedAt: now() }
    })
  }

  await writeAudit(openid, 'feedback', 'business_node', node._id, { status: payload.status, evidenceCount: evidenceIds.length })
  return { id: node._id, status: payload.status }
}

function createDefaultLegacyRoutes() {
  return {
    updateUserProfile,
    dashboard
  }
}

function createDefaultBusinessApi() {
  const repository = createCloudAccountRepository({ db, clock: () => new Date() })
  const templateRepository = createCloudTemplateRepository({ db })
  const businessRepository = createCloudBusinessRepository({ db, clock: () => new Date() })
  const workTimeService = createWorkTimeService({
    calendarRepository: createCloudWorkCalendarRepository({ db })
  })
  const evidenceRepository = createCloudEvidenceRepository({ db, cloud, clock: () => new Date() })
  const feedbackRepository = createCloudFeedbackRepository({ db, clock: () => new Date() })
  const reviewRepository = createCloudReviewRepository({ db, clock: () => new Date() })
  const clock = Date.now
  const authService = createAuthService({
    repository,
    clock,
    randomToken: () => crypto.randomBytes(32).toString('hex'),
    sha256: value => crypto.createHash('sha256').update(String(value)).digest('hex'),
    recoveryCodeHash: process.env.ADMIN_RECOVERY_CODE_SHA256 || ''
  })
  const adminUserService = createAdminUserService({ repository, hashPassword, clock })
  const templateService = createTemplateService({
    repository: templateRepository,
    clock: () => new Date(),
    keyFactory: prefix => `${prefix}_${crypto.randomBytes(16).toString('hex')}`
  })
  const businessService = createBusinessService({
    repository: businessRepository,
    workTimeService,
    clock: () => new Date()
  })
  const businessLifecycleService = createBusinessLifecycleService({ repository: businessRepository })
  const evidenceService = createEvidenceService({ repository: evidenceRepository })
  const feedbackService = createFeedbackService({ repository: feedbackRepository })
  const reviewService = createReviewService({
    feedbackRepository,
    reviewRepository,
    workTimeService,
    clock: () => new Date()
  })
  const calendarAdminService = createCalendarAdminService({
    db,
    invokeCalendarSync: data => cloud.callFunction({ name: 'calendarSync', data }),
    clock: () => new Date(),
    requestIdFactory: () => crypto.randomBytes(24).toString('hex')
  })
  const operationsService = createOperationsService({
    repository: createCloudOperationsRepository({ db }),
    clock: () => new Date()
  })
  const shareService = createShareService({
    repository: createCloudShareRepository({ db, cloud, clock: () => new Date() }),
    clock: () => new Date(),
    tokenFactory: () => crypto.randomBytes(32).toString('base64url')
  })
  let configuredBusinessSearchClient
  const getBusinessSearchClient = () => {
    if (!configuredBusinessSearchClient) {
      configuredBusinessSearchClient = createBusinessSearchClient({
        db,
        callFunction: data => cloud.callFunction(data),
        secret: process.env.BUSINESS_SEARCH_HMAC_SECRET,
        clock: () => new Date(),
        randomBytes: crypto.randomBytes
      })
    }
    return configuredBusinessSearchClient
  }
  const businessSearchClient = {
    ensureIndexed: (...args) => getBusinessSearchClient().ensureIndexed(...args),
    query: (...args) => getBusinessSearchClient().query(...args)
  }
  return createBusinessApi({
    repository,
    authService,
    adminUserService,
    templateService,
    businessService,
    businessLifecycleService,
    evidenceService,
    feedbackService,
    reviewService,
    calendarAdminService,
    operationsService,
    shareService,
    businessSearchClient,
    getContext: () => cloud.getWXContext(),
    clock,
    legacyRoutes: createDefaultLegacyRoutes()
  })
}

let defaultBusinessApi
exports.main = event => {
  if (!defaultBusinessApi) defaultBusinessApi = createDefaultBusinessApi()
  return defaultBusinessApi.main(event)
}

exports.isPublicAction = isPublicAction
exports.createBusinessApi = createBusinessApi
exports.createDefaultLegacyRoutes = createDefaultLegacyRoutes
