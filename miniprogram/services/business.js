const { callBusinessApi } = require('../utils/cloud')

function bootstrap() {
  return callBusinessApi('bootstrap')
}

function updateUserProfile(input) {
  return callBusinessApi('updateUserProfile', input)
}

const SAFE_ERROR_MESSAGES = Object.freeze({
  REVIEWER_INACTIVE: '审核账号已停用，请联系管理员',
  PROCESSOR_INACTIVE: '处理账号已停用，请联系管理员',
  ROLE_OVERLAP: '处理人与审核人不能重复',
  REVIEW_NOT_PENDING: '该审核已不在待处理状态，请刷新后查看',
  REVIEW_ALREADY_FINISHED: '该审核已结束，请刷新后查看',
  REVIEW_ALREADY_VOTED: '你已经提交过本轮审核意见',
  REVIEW_COMMENT_REQUIRED: '请填写驳回原因',
  NODE_PENDING_REVIEW: '节点正在审核中，暂不能修改',
  NODE_VERSION_CONFLICT: '节点信息已变化，请刷新后重试',
  VERSION_CONFLICT: '数据已变化，请刷新后重试',
  BUSINESS_NOT_ACTIVE: '业务已结束，不能继续操作',
  BLOCKED_REASON_REQUIRED: '请填写受阻原因',
  FORBIDDEN: '你没有权限执行此操作',
  VALIDATION_ERROR: '提交内容不符合要求，请检查后重试',
  UNSUPPORTED_FILE_TYPE: '文件格式不受支持，请重新选择',
  FILE_TOO_LARGE: '文件大小超过限制，请重新选择',
  EVIDENCE_NOT_ATTACHABLE: '当前凭证无法登记，请刷新后重试'
})

function safeServiceError(error, fallback) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const safe = new Error(SAFE_ERROR_MESSAGES[code] || fallback)
  safe.code = code || 'BUSINESS_ERROR'
  return safe
}

async function callProtected(action, payload, fallback) {
  try {
    return await callBusinessApi(action, payload, { silent: true })
  } catch (error) {
    throw safeServiceError(error, fallback)
  }
}

async function listAll(method, pageSize = 50) {
  const items = []
  for (let page = 1; page <= 2; page += 1) {
    const result = await method({ page, pageSize })
    items.push(...(Array.isArray(result.items) ? result.items : []))
    if (!result.hasMore) break
  }
  return items
}

async function dashboard() {
  const [result, pendingReviews, notifications] = await Promise.all([
    callBusinessApi('listBusinessLines', { page: 1, pageSize: 20 }),
    listAll(listMyPendingReviews),
    listAll(listMyNotifications)
  ])
  const items = Array.isArray(result.items) ? result.items : []
  return {
    stats: {
      active: items.filter(item => item.status === 'active').length,
      pendingMine: null,
      pendingMineAvailable: false,
      pendingReviews: pendingReviews.length,
      unreadNotifications: notifications.filter(item => !item.read).length,
      completed: items.filter(item => item.status === 'completed').length
    },
    recent: items.slice(0, 5)
  }
}

function listBusinessLines(filters) {
  return callBusinessApi('listBusinessLines', filters)
}

function getBusinessLine(id) {
  return callBusinessApi('getBusinessLine', { id })
}

function createBusinessFromTemplate(input) {
  return callBusinessApi('createBusinessFromTemplate', input)
}

function updateBusinessLine(input) {
  return callBusinessApi('updateBusinessLine', input)
}

function updateBusinessMetadata(input) {
  return callBusinessApi('updateBusinessMetadata', input)
}

function deleteBusinessLine(id) {
  return callBusinessApi('deleteBusinessLine', { id })
}

function submitNodeFeedback(input) {
  return callBusinessApi('submitNodeFeedback', input)
}

function getNodeHistory(businessLineId, nodeId) {
  return callBusinessApi('getNodeHistory', { businessLineId, nodeId })
}

function registerEvidenceUpload(input) {
  return callProtected('registerEvidenceUpload', input, '凭证上传失败，请重试')
}

function getEvidenceAccess(evidenceId) {
  return callProtected(
    'getEvidenceAccess',
    { evidenceId },
    '凭证暂时无法打开'
  )
}

function submitFeedback(input) {
  return callBusinessApi('submitFeedback', input)
}

function rejectPreviousNode(input) {
  return callBusinessApi('rejectPreviousNode', input)
}

function closeBusinessLine(input) {
  return callBusinessApi('closeBusinessLine', input)
}

function listFrozenBusinessesForAdmin(query) {
  return callBusinessApi('listFrozenBusinessesForAdmin', query)
}

function getFrozenBusinessForAdmin(businessLineId) {
  return callBusinessApi('getFrozenBusinessForAdmin', { businessLineId })
}

function amendFrozenBusiness(input) {
  return callBusinessApi('amendFrozenBusiness', input)
}

function submitNodeForReview(input) {
  return callProtected('submitNodeForReview', input, '提交审核失败，请稍后重试')
}

function submitReviewVote(input) {
  return callProtected('submitReviewVote', input, '提交审核意见失败，请稍后重试')
}

function listMyPendingReviews(query) {
  return callProtected('listMyPendingReviews', query, '审核待办加载失败，请稍后重试')
}

function getReviewDetail(reviewRoundId) {
  return callProtected('getReviewDetail', { reviewRoundId }, '审核详情加载失败，请稍后重试')
}

function listMyNotifications(query) {
  return callProtected('listMyNotifications', query, '消息通知加载失败，请稍后重试')
}

function markNotificationRead(notificationId) {
  return callProtected('markNotificationRead', { notificationId }, '消息状态更新失败，请稍后重试')
}

module.exports = {
  bootstrap,
  updateUserProfile,
  dashboard,
  listBusinessLines,
  getBusinessLine,
  createBusinessFromTemplate,
  updateBusinessLine,
  updateBusinessMetadata,
  deleteBusinessLine,
  submitNodeFeedback,
  getNodeHistory,
  registerEvidenceUpload,
  getEvidenceAccess,
  submitFeedback,
  rejectPreviousNode,
  closeBusinessLine,
  listFrozenBusinessesForAdmin,
  getFrozenBusinessForAdmin,
  amendFrozenBusiness,
  submitNodeForReview,
  submitReviewVote,
  listMyPendingReviews,
  getReviewDetail,
  listMyNotifications,
  markNotificationRead
}
