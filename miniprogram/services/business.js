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
  CREATOR_REVIEWER_CONFLICT: '售后发起人不能同时担任同一节点的处理人和审核人，请调整模板或由其他账号发起',
  ROLE_OVERLAP: '处理人与审核人不能重复',
  REVIEW_NOT_PENDING: '该审核已不在待处理状态，请刷新后查看',
  REVIEW_ALREADY_FINISHED: '该审核已结束，请刷新后查看',
  REVIEW_ALREADY_VOTED: '你已经提交过本轮审核意见',
  REVIEW_COMMENT_REQUIRED: '请填写驳回原因',
  NODE_PENDING_REVIEW: '节点正在审核中，暂不能修改',
  NODE_VERSION_CONFLICT: '节点信息已变化，请刷新后重试',
  VERSION_CONFLICT: '数据已变化，请刷新后重试',
  BUSINESS_NOT_ACTIVE: '售后已结束，不能继续操作',
  BLOCKED_REASON_REQUIRED: '请填写受阻原因',
  FORBIDDEN: '你没有权限执行此操作',
  VALIDATION_ERROR: '提交内容不符合要求，请检查后重试',
  UNSUPPORTED_FILE_TYPE: '文件格式不受支持，请重新选择',
  FILE_TOO_LARGE: '文件大小超过限制，请重新选择',
  EVIDENCE_NOT_ATTACHABLE: '当前凭证无法登记，请刷新后重试',
  EVIDENCE_UPLOAD_EXPIRED: '上传授权已过期，正在重新尝试',
  EVIDENCE_UPLOAD_UNAVAILABLE: '上传服务暂时不可用，请稍后重试',
  FEEDBACK_TOTAL_TOO_LARGE: '本轮凭证合计不能超过 120 MB',
  BUSINESS_SEARCH_PENDING: '售后检索正在更新，请稍后重试',
  BUSINESS_SEARCH_UNAVAILABLE: '售后检索暂时不可用，请稍后重试',
  INVALID_SEARCH_QUERY: '请调整检索内容后重试',
  NODE_TEXT_BUSY: '已有文本正在识别，请稍后重试',
  NODE_TEXT_CONFIG_INVALID: '文本识别配置异常，请联系管理员',
  NODE_TEXT_DAILY_LIMITED: '今日文本识别次数已用完，请明日再试',
  NODE_TEXT_PARSE_FAILED: '文本识别失败，请稍后重试',
  NODE_TEXT_RATE_LIMITED: '识别操作过于频繁，请稍后重试',
  NODE_TEXT_STALE: '节点字段已变化，请刷新后重试'
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
  const [summary, pendingReviews, notifications] = await Promise.all([
    callBusinessApi('getMyDashboardSummary', {}),
    listAll(listMyPendingReviews),
    listAll(listMyNotifications)
  ])
  const stats = summary && summary.stats || {}
  return {
    stats: {
      active: Number(stats.active || 0),
      pendingMine: Number(stats.pendingProcessing || 0),
      pendingMineAvailable: true,
      pendingReviews: pendingReviews.length,
      unreadNotifications: notifications.filter(item => !item.read).length,
      completed: Number(stats.completed || 0),
      complete: summary && summary.complete !== false
    },
    recent: Array.isArray(summary && summary.recent) ? summary.recent : []
  }
}

function listMyPendingProcessing(query) {
  return callProtected('listMyPendingProcessing', query || {}, '待处理任务加载失败，请稍后重试')
}

function getOperationsDashboard(query) {
  return callProtected('getOperationsDashboard', query || {}, '运营看板加载失败，请稍后重试')
}

function exportOperationsRows(query) {
  return callProtected('exportOperationsRows', query || {}, '运营数据导出失败，请稍后重试')
}

function listOperationsTimingDetails(query) {
  return callProtected('listOperationsTimingDetails', query || {}, '个人工时明细加载失败，请稍后重试')
}

function getOperationsAnalyticsFilters(query) {
  return callProtected('getOperationsAnalyticsFilters', query || {}, '统计筛选项加载失败，请稍后重试')
}

function getOperationsAnalyticsSummary(query) {
  return callProtected('getOperationsAnalyticsSummary', query || {}, '历史统计加载失败，请稍后重试')
}

function listOperationsAnalyticsSamples(query) {
  return callProtected('listOperationsAnalyticsSamples', query || {}, '统计明细加载失败，请稍后重试')
}

function createNodeShareSnapshot(input) {
  return callProtected('createNodeShareSnapshot', input, '生成分享快照失败，请稍后重试')
}

function getPublicNodeShare(query) {
  return callProtected('getPublicNodeShare', query, '分享内容已失效或暂时无法查看')
}

function listBusinessLines(filters) {
  return callProtected('listBusinessLines', filters, '售后列表加载失败，请稍后重试')
}

function getBusinessLine(id) {
  return callBusinessApi('getBusinessLine', { id })
}

function createBusinessFromTemplate(input) {
  return callProtected('createBusinessFromTemplate', input, '售后创建失败，请稍后重试')
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

function beginEvidenceUpload(input) {
  return callProtected('beginEvidenceUpload', input, '凭证上传授权失败，请重试')
}

function finalizeEvidenceUpload(input) {
  return callProtected('finalizeEvidenceUpload', input, '凭证上传确认失败，请重试')
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

function recognizeNodeText(input) {
  return callProtected('recognizeNodeText', input, '文本识别失败，请稍后重试')
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
  listMyPendingProcessing,
  getOperationsDashboard,
  exportOperationsRows,
  listOperationsTimingDetails,
  getOperationsAnalyticsFilters,
  getOperationsAnalyticsSummary,
  listOperationsAnalyticsSamples,
  createNodeShareSnapshot,
  getPublicNodeShare,
  listBusinessLines,
  getBusinessLine,
  createBusinessFromTemplate,
  updateBusinessLine,
  updateBusinessMetadata,
  deleteBusinessLine,
  submitNodeFeedback,
  getNodeHistory,
  registerEvidenceUpload,
  beginEvidenceUpload,
  finalizeEvidenceUpload,
  getEvidenceAccess,
  submitFeedback,
  rejectPreviousNode,
  closeBusinessLine,
  listFrozenBusinessesForAdmin,
  getFrozenBusinessForAdmin,
  amendFrozenBusiness,
  recognizeNodeText,
  submitNodeForReview,
  submitReviewVote,
  listMyPendingReviews,
  getReviewDetail,
  listMyNotifications,
  markNotificationRead
}
