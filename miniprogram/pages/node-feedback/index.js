const businessService = require('../../services/business')
const { safeErrorMessage, isAccountAccessError } = require('../../utils/safe-error')
const { createEvidenceUploader } = require('../../utils/evidence-upload')
const { prepareEvidenceFile } = require('../../utils/evidence-file')
const {
  buildRecognitionPreview,
  applyRecognitionPreview,
  recognitionSnapshotStillCurrent
} = require('../../utils/node-text-recognition')
const { deriveConditionalForm, nonemptyVisibleValues } = require('../../utils/conditional-form')

const FROZEN_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])
const STATUS_OPTIONS = Object.freeze([
  { value: 'in_progress', label: '处理中' },
  { value: 'blocked', label: '受阻' },
  { value: 'completed', label: '已完成' }
])
const STATUS_LABELS = Object.freeze({
  in_progress: '处理中', blocked: '受阻', completed: '已完成'
})
const MEBIBYTE = 1024 * 1024
const FEEDBACK_TOTAL_LIMIT = 120 * MEBIBYTE
const ALL_EVIDENCE_TYPES = Object.freeze([
  'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'mov', 'm4v'
])
const UPLOAD_CONCURRENCY = 3
const SAFE_UPLOAD_ERROR_CODES = new Set([
  'UNSUPPORTED_FILE_TYPE', 'EVIDENCE_TOTAL_LIMIT_EXCEEDED', 'EVIDENCE_UPLOAD_EXPIRED',
  'EVIDENCE_UPLOAD_MISMATCH', 'EVIDENCE_UPLOAD_NOT_FOUND', 'EVIDENCE_UPLOAD_CANCELLED', 'EVIDENCE_FILE_READ_FAILED'
])
const UPLOAD_DIAGNOSTIC_CODES = new Set([
  ...SAFE_UPLOAD_ERROR_CODES, 'EVIDENCE_UPLOAD_FAILED', 'EVIDENCE_UPLOAD_UNAVAILABLE',
  'FORBIDDEN', 'VERSION_CONFLICT', 'NODE_VERSION_CONFLICT', 'BUSINESS_NOT_ACTIVE',
  'FEEDBACK_TOTAL_TOO_LARGE', 'AccessDenied', 'SignatureDoesNotMatch',
  'RequestError', 'NetworkError', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UPLOAD_FAILED',
  'ExpiredToken', 'ExpiredTokenException', 'InvalidSecurityToken', 'RequestTimeTooSkewed'
])
const UPLOAD_STAGE_LABELS = Object.freeze({ prepare: '文件读取', authorize: '申请上传授权', transfer: '文件传输', finalize: '文件核验' })

function safeUploadError(error) {
  const code = error && UPLOAD_DIAGNOSTIC_CODES.has(error.code) ? error.code : 'EVIDENCE_UPLOAD_FAILED'
  const message = SAFE_UPLOAD_ERROR_CODES.has(code)
    ? safeErrorMessage(error, '上传失败，请重试')
    : '上传失败，请重试'
  const stage = error && Object.prototype.hasOwnProperty.call(UPLOAD_STAGE_LABELS, error.uploadStage)
    ? UPLOAD_STAGE_LABELS[error.uploadStage] : ''
  const status = error && error.statusCode
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? ` · HTTP ${status}` : ''
  const detail = stage ? `（${stage} · ${code}${httpStatus}）` : ''
  return Object.assign(new Error(message + detail), { code })
}

function effectiveClientEvidenceTypes(requiresEvidence, allowedTypes) {
  if (typeof requiresEvidence !== 'boolean' || !Array.isArray(allowedTypes)) return null
  const lengthDescriptor = Object.getOwnPropertyDescriptor(allowedTypes, 'length')
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) return null
  const types = []
  const seenTypes = new Set()
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(allowedTypes, String(index))
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'string' || !ALL_EVIDENCE_TYPES.includes(descriptor.value) ||
        seenTypes.has(descriptor.value)) return null
    seenTypes.add(descriptor.value)
    types.push(descriptor.value)
  }
  if (types.length) return types
  return requiresEvidence ? null : ALL_EVIDENCE_TYPES.slice()
}

function ownDataValue(record, key) {
  if (!record || typeof record !== 'object') return { state: 'invalid', value: undefined }
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { state: 'value', value: descriptor.value }
    : descriptor || key in record
      ? { state: 'invalid', value: undefined }
      : { state: 'missing', value: undefined }
}

function currentUserId() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user._id : ''
}

function requestKey(prefix = 'feedback') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function schemaFingerprint(fields) {
  return JSON.stringify((Array.isArray(fields) ? fields : []).map(field => ({
    fieldKey: field.fieldKey,
    name: field.name,
    type: field.type,
    required: field.required,
    constraints: field.constraints,
    condition: field.condition || null,
    ...(field.optionLinkage ? { optionLinkage:field.optionLinkage } : {})
  })))
}

function dateTimeText(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

function dueText(status, value, overdueMinutes) {
  if (status === 'pending_calendar') return '待工作日历补算'
  if (status === 'not_started') return '尚未开始'
  if (status !== 'calculated') return '待计算'
  const text = dateTimeText(value) || '待计算'
  const minutes = Number(overdueMinutes || 0)
  return minutes > 0 ? `${text}（已逾期 ${minutes} 个工作分钟）` : text
}

function initialValue(field) {
  if (field.type === 'multi_select') return []
  if (field.type === 'short_text' || field.type === 'long_text') return ''
  return null
}

function valueText(value) {
  if (value === null || value === undefined || value === '') return '未填写'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.length ? value.join('、') : '未填写'
  return String(value)
}

function formattedHistory(history) {
  return (Array.isArray(history) ? history : []).map(item => ({
    ...item,
    statusLabel: STATUS_LABELS[item.status] || item.status || '未知状态',
    submittedAtText: item.submittedAt ? new Date(item.submittedAt).toLocaleString('zh-CN') : '',
    fieldValues: (Array.isArray(item.fieldValues) ? item.fieldValues : []).map(field => ({
      ...field,
      valueText: valueText(field.value)
    })),
    evidences: (Array.isArray(item.evidences) ? item.evidences : []).map(evidence => ({
      ...evidence,
      canPreview: evidence.storageStatus === 'available',
      downloadOnly: ['heic', 'heif'].includes(extensionOf(evidence.fileName)),
      storageStatusLabel: evidence.storageStatus === 'purged' ? '已清理' :
        evidence.storageStatus === 'available' ? '可查看' : '暂不可用'
    }))
  }))
}

function respectsDecimalPlaces(value, places) {
  if (places === undefined) return true
  const scaled = value * (10 ** places)
  return Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function extensionOf(name) {
  const clean = String(name || '').split(/[?#]/)[0]
  const extension = clean.includes('.') ? clean.split('.').pop().toLowerCase() : ''
  return extension === 'jpeg' ? 'jpeg' : extension
}

function categoryFor(extension, mediaType) {
  if (mediaType === 'image' || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(extension)) return 'image'
  if (mediaType === 'video' || ['mp4', 'mov', 'm4v'].includes(extension)) return 'video'
  if (extension === 'pdf') return 'pdf'
  return ''
}

function displayName(file, fallback) {
  if (file.name) return file.name
  const path = file.tempFilePath || file.path || ''
  const part = path.split('/').pop()
  return part || fallback
}

function formatBytes(bytes) {
  if (bytes >= MEBIBYTE) return `${(bytes / MEBIBYTE).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function devicePlatform() {
  try {
    const info = typeof wx.getDeviceInfo === 'function'
      ? wx.getDeviceInfo()
      : typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : {}
    const platform = typeof info.platform === 'string' ? info.platform.toLowerCase() : ''
    return platform
  } catch (error) {
    return ''
  }
}

function formattedReviewHistory(items) {
  const statusLabels = { pending: '审核中', approved: '已通过', rejected: '已驳回' }
  return items.map(round => ({
    reviewRoundId: round.reviewRoundId,
    reviewRoundNumber: round.reviewRoundNumber,
    processingRoundNumber: round.processingRoundNumber,
    statusLabel: statusLabels[round.status] || '未知状态',
    submittedAtText: dateTimeText(round.submittedAt),
    votes: round.votes.map((vote, index) => ({
      voteKey: `${index}-${vote.createdAt || ''}`,
      reviewerDisplayName: vote.reviewerDisplayName,
      decisionLabel: vote.decision === 'approved' ? '通过' : '驳回',
      commentText: typeof vote.comment === 'string' && vote.comment.trim() ? vote.comment : '未填写审核意见',
      createdAtText: dateTimeText(vote.createdAt)
    }))
  }))
}

function supportsOriginalMediaVideo() {
  try {
    if (typeof wx.chooseMedia !== 'function' || typeof wx.canIUse === 'function' && !wx.canIUse('chooseMedia')) return false
    const info = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(info.SDKVersion || '')
    return Boolean(version && (Number(version[1]) > 2 || Number(version[1]) === 2 && Number(version[2]) >= 25))
  } catch (error) { return false }
}

Page({
  data: {
    lineId: '',
    nodeId: '',
    nodeName: '',
    nodeCode: '',
    expectedNodeVersion: 0,
    lineVersion: 0,
    canSubmit: false,
    legacyMode: true,
    workflowMode: 'legacy',
    requiresReview: true,
    primaryActionLabel: '提交审核',
    reviewMode: '',
    reviewModeLabel: '',
    processorNamesText: '',
    reviewerNamesText: '',
    processingRoundNumber: 0,
    reviewRoundNumber: 0,
    processingDueText: '待计算',
    reviewDueText: '尚未开始',
    reviewStartedText: '',
    readOnly: true,
    reviewDraftLocked: false,
    serverDraftAvailable: false,
    serverDraftHasEvidence: false,
    draftDirty: false,
    frozen: false,
    fields: [],
    hasProductOptionLinkage: false,
    visibleFields: [],
    fieldValues: {},
    history: [],
    loadingHistory: true,
    reviewHistory: [],
    reviewHistoryLoading: false,
    reviewHistoryLoaded: false,
    reviewHistoryError: '',
    reviewHistoryHasMore: false,
    reviewHistoryBeforeRoundNumber: null,
    errorMessage: '',
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    comment: '',
    files: [],
    selectedTotalBytes: 0,
    selectedTotalText: '0 B',
    uploadProgressPercent: 0,
    requiresEvidence: false,
    allowedEvidenceTypes: [],
    videoPreview: null,
    downloading: false,
    submitting: false,
    recognitionText: '',
    recognitionCandidates: [],
    recognizing: false
  },

  async onLoad(query = {}) {
    const actorId = currentUserId()
    if (!actorId) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.loadActorId = actorId
    this.identityInvalidated = false
    this.pageAlive = true
    this.loadSequence = 0
    this.reviewHistorySequence = 0
    this.writeSequence = 0
    this.recognitionSequence = 0
    this.formRevision = 0
    this.progressExpectedNodeVersion = null
    this.reviewExpectedNodeVersion = null
    this.setData({ lineId: String(query.lineId || ''), nodeId: String(query.nodeId || '') })
    await this.loadData()
  },

  onShow() {
    if (!this.actorStillCurrent()) return
    if (!this.data.lineId || !this.hasLoaded || this.evidencePickerPending > 0 || this.data.submitting) return
    if (this.data.draftDirty || this.data.reviewDraftLocked) return this.loadReviewHistory()
    return this.loadData()
  },

  onHide() {
    this.recognitionSequence += 1
    this.setData({ recognizing: false, recognitionText: '', recognitionCandidates: [] })
  },

  onUnload() {
    this.pageAlive = false
    this.clearReviewHistory()
    this.fieldDefinitions = null
    this.definitionSchemaFingerprint = null
    this.loadSequence += 1
    this.recognitionSequence += 1
  },

  actorStillCurrent() {
    if (this.identityInvalidated) return false
    if (this.loadActorId && currentUserId() === this.loadActorId) return true
    this.identityInvalidated = true
    this.clearReviewHistory()
    this.loadSequence += 1
    this.setData({ canSubmit: false, readOnly: true })
    wx.reLaunch({ url: '/pages/login/index' })
    return false
  },

  async loadData() {
    if (!this.pageAlive || !this.actorStillCurrent()) return
    const requestSequence = ++this.loadSequence
    const requestedActorId = this.loadActorId || currentUserId()
    this.setData({ loadingHistory: true, errorMessage: '' })
    try {
      const workspace = await businessService.getNodeWorkspace(this.data.lineId, this.data.nodeId)
      if (!this.pageAlive || requestSequence !== this.loadSequence || !this.actorStillCurrent() || currentUserId() !== requestedActorId) return
      const node = workspace && workspace.node
      if (!node) throw new Error('未找到节点')
      const requiresEvidenceField = ownDataValue(node, 'requiresEvidence')
      const allowedEvidenceTypesField = ownDataValue(node, 'allowedEvidenceTypes')
      const requiresEvidence = requiresEvidenceField.state === 'missing' ? false : requiresEvidenceField.value
      const allowedEvidenceTypes = requiresEvidenceField.state === 'invalid' || allowedEvidenceTypesField.state !== 'value'
        ? null
        : effectiveClientEvidenceTypes(requiresEvidence, allowedEvidenceTypesField.value)
      if (!allowedEvidenceTypes) throw new Error('当前节点凭证配置无效，请联系管理员')
      const fields = (Array.isArray(node.fieldDefinitions) ? node.fieldDefinitions : [])
        .slice().sort((left, right) => left.sequence - right.sequence)
        .map(field => ({
          ...field,
          optionItems: field.constraints && Array.isArray(field.constraints.options)
            ? field.constraints.options.map(value => ({ value, selected: false }))
            : []
        }))
      const legacyMode = node.workflowMode !== 'review'
      const latestDraft = !legacyMode && Array.isArray(workspace.history) ? workspace.history[0] : null
      const latestValues = new Map(
        latestDraft && Array.isArray(latestDraft.fieldValues)
          ? latestDraft.fieldValues
            .filter(field => field && typeof field.fieldKey === 'string')
            .map(field => [field.fieldKey, field.value])
          : []
      )
      const fieldValues = Object.fromEntries(fields.map(field => [
        field.fieldKey,
        latestValues.has(field.fieldKey) ? latestValues.get(field.fieldKey) : initialValue(field)
      ]))
      const conditionalForm = deriveConditionalForm(fields, fieldValues)
      this.fieldDefinitions = fields
      this.definitionSchemaFingerprint = schemaFingerprint(fields)
      const frozen = FROZEN_STATUSES.has(workspace.line && workspace.line.status)
      const canSubmit = Boolean(workspace.canSubmit) && !frozen
      const requiresReview = legacyMode ? true : node.requiresReview !== false
      const readOnlyStatuses = new Set(['pending_review', 'awaiting_decision', 'skipped', 'completed'])
      const readOnly = frozen || !canSubmit || !legacyMode && readOnlyStatuses.has(node.status)
      this.setData({
        nodeName: node.name || '',
        nodeCode: node.nodeCode || '',
        expectedNodeVersion: node.version,
        lineVersion: workspace.line.version,
        fields: fields.map(({ optionLinkage, ...field }) => field),
        hasProductOptionLinkage: fields.some(field => Boolean(field.optionLinkage)),
        visibleFields: conditionalForm.visibleFields,
        fieldValues: conditionalForm.fieldValues,
        requiresEvidence,
        allowedEvidenceTypes,
        history: formattedHistory(workspace.history),
        canSubmit,
        frozen,
        legacyMode,
        workflowMode: legacyMode ? 'legacy' : 'review',
        requiresReview,
        primaryActionLabel: requiresReview ? '提交审核' : '完成节点',
        reviewMode: legacyMode ? '' : node.reviewMode,
        reviewModeLabel: node.reviewMode === 'all' ? '会签' : node.reviewMode === 'any' ? '或签' : '',
        processorNamesText: Array.isArray(node.processorDisplayNames) ? node.processorDisplayNames.join('、') : '',
        reviewerNamesText: Array.isArray(node.reviewerDisplayNames) ? node.reviewerDisplayNames.join('、') : '',
        processingRoundNumber: Number(node.processingRoundNumber || 0),
        reviewRoundNumber: Number(node.reviewRoundNumber || 0),
        processingDueText: dueText(node.processingDueStatus, node.processingDueAt, node.processingOverdueWorkMinutes),
        reviewDueText: dueText(node.reviewDueStatus, node.reviewDueAt, node.reviewOverdueWorkMinutes),
        reviewStartedText: dateTimeText(node.reviewStartedAt),
        comment: latestDraft && typeof latestDraft.comment === 'string' ? latestDraft.comment : this.data.comment,
        serverDraftAvailable: Boolean(latestDraft && ['in_progress', 'blocked'].includes(latestDraft.status)),
        serverDraftHasEvidence: Boolean(latestDraft && Array.isArray(latestDraft.evidences) &&
          latestDraft.evidences.some(evidence => evidence && evidence.storageStatus === 'available')),
        draftDirty: false,
        recognitionText: '',
        recognitionCandidates: [],
        recognizing: false,
        readOnly
      })
      this.formRevision += 1
      this.hasLoaded = true
      wx.setNavigationBarTitle({ title: node.name || '节点反馈' })
      // History has its own read lifecycle; it must never delay or overwrite the progress form.
      if (!legacyMode) this.loadReviewHistory()
      else this.clearReviewHistory()
    } catch (error) {
      if (this.pageAlive && requestSequence === this.loadSequence && this.actorStillCurrent()) {
        this.clearReviewHistoryOnAccessError(error)
        this.setData({
          errorMessage: safeErrorMessage(error, '节点信息加载失败，请稍后重试'),
          canSubmit: false,
          readOnly: true
        })
      }
    } finally {
      if (this.pageAlive && requestSequence === this.loadSequence && currentUserId() === requestedActorId) {
        this.setData({ loadingHistory: false })
      }
    }
  },

  async loadHistory() {
    return this.loadData()
  },

  clearReviewHistory(errorMessage = '') {
    this.reviewHistorySequence = (this.reviewHistorySequence || 0) + 1
    this.reviewHistoryRetryAppend = false
    this.setData({
      reviewHistory: [], reviewHistoryLoading: false, reviewHistoryLoaded: false,
      reviewHistoryError: errorMessage, reviewHistoryHasMore: false, reviewHistoryBeforeRoundNumber: null
    })
  },

  clearReviewHistoryOnAccessError(error, operation) {
    if (operation && (this.data.lineId !== operation.lineId || this.data.nodeId !== operation.nodeId)) return
    if (isAccountAccessError(error) && this.pageAlive && this.actorStillCurrent()) {
      this.clearReviewHistory('审核历史暂时无法查看，请重试')
      this.loadSequence += 1
      this.setData({ canSubmit: false, readOnly: true, loadingHistory: false })
    }
  },

  reviewHistoryRequestCurrent(sequence, actorId, lineId, nodeId) {
    return this.pageAlive && sequence === this.reviewHistorySequence && this.actorStillCurrent() &&
      currentUserId() === actorId && this.data.lineId === lineId && this.data.nodeId === nodeId
  },

  async loadReviewHistory(append = false) {
    if (!this.pageAlive || !this.actorStillCurrent() || this.data.workflowMode !== 'review') return
    if (append && (this.data.reviewHistoryLoading || !this.data.reviewHistoryHasMore)) return
    const sequence = (this.reviewHistorySequence || 0) + 1
    this.reviewHistorySequence = sequence
    const actorId = this.loadActorId
    const { lineId, nodeId } = this.data
    const query = { businessLineId: lineId, nodeId, pageSize: 5 }
    if (append) query.beforeRoundNumber = this.data.reviewHistoryBeforeRoundNumber
    const isCurrent = () => this.reviewHistoryRequestCurrent(sequence, actorId, lineId, nodeId)
    this.setData({ reviewHistoryLoading: true, reviewHistoryError: '' })
    try {
      const result = await businessService.listNodeReviewHistory(query)
      if (!isCurrent()) return
      if (!result || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean' ||
          result.hasMore && (!Number.isSafeInteger(result.nextBeforeRoundNumber) || result.nextBeforeRoundNumber < 1)) {
        throw new Error('Invalid review history response')
      }
      const items = formattedReviewHistory(result.items)
      this.reviewHistoryRetryAppend = false
      this.setData({
        reviewHistory: append ? this.data.reviewHistory.concat(items) : items,
        reviewHistoryLoaded: true,
        reviewHistoryHasMore: result.hasMore,
        reviewHistoryBeforeRoundNumber: result.hasMore ? result.nextBeforeRoundNumber : null
      })
    } catch (error) {
      if (!isCurrent()) return
      const message = safeErrorMessage(error, '审核历史加载失败，请稍后重试')
      if (isAccountAccessError(error)) this.clearReviewHistoryOnAccessError(error)
      else {
        this.reviewHistoryRetryAppend = append
        this.setData({ reviewHistoryError: message })
      }
    } finally {
      if (isCurrent()) this.setData({ reviewHistoryLoading: false })
    }
  },

  onRetryReviewHistory() {
    if (!this.data.reviewHistoryLoading) return this.loadReviewHistory(Boolean(this.reviewHistoryRetryAppend))
  },

  onLoadMoreReviewHistory() { return this.loadReviewHistory(true) },

  onStatus(event) {
    if (this.data.submitting || this.data.readOnly) return
    this.setData({ statusIndex: Number(event.detail.value) })
  },

  markDraftDirty(update = {}) {
    if (this.data.submitting || this.data.reviewDraftLocked) return false
    this.formRevision += 1
    this.savedProgress = null
    this.progressIntent = ''
    this.progressRequestKey = ''
    this.progressExpectedNodeVersion = null
    this.reviewRequestKey = ''
    this.reviewExpectedNodeVersion = null
    this.setData({ draftDirty: true, recognitionCandidates: [], ...update })
    return true
  },

  onRecognitionText(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked || this.data.recognizing) return
    this.setData({ recognitionText: String(event.detail.value || '').slice(0, 8000), recognitionCandidates: [] })
  },

  currentRecognitionSnapshot() {
    return {
      actorId: currentUserId(),
      lineId: this.data.lineId,
      nodeId: this.data.nodeId,
      nodeVersion: this.data.expectedNodeVersion,
      schemaDigest: `${this.definitionSchemaFingerprint || ''}\n${schemaFingerprint(this.data.visibleFields)}`,
      formRevision: this.formRevision
    }
  },

  async onRecognizeText() {
    const text = String(this.data.recognitionText || '').trim()
    if (this.data.readOnly || this.data.reviewDraftLocked || this.data.recognizing) return
    if (!text) {
      wx.showToast({ title: '请粘贴需要识别的文本', icon: 'none' })
      return
    }
    const sequence = ++this.recognitionSequence
    const snapshot = this.currentRecognitionSnapshot()
    this.setData({ recognizing: true, recognitionCandidates: [] })
    try {
      const result = await businessService.recognizeNodeText({
        businessLineId: snapshot.lineId,
        nodeId: snapshot.nodeId,
        expectedNodeVersion: snapshot.nodeVersion,
        text,
        fieldValues: nonemptyVisibleValues(this.data.visibleFields, this.data.fieldValues),
        requestKey: requestKey('recognize').replace(/[^A-Za-z0-9_-]/g, '_')
      })
      if (!this.pageAlive || sequence !== this.recognitionSequence ||
          !recognitionSnapshotStillCurrent(snapshot, this.currentRecognitionSnapshot())) {
        wx.showToast({ title: '表单已变化，识别结果已丢弃，请重试', icon: 'none' })
        return
      }
      const candidates = buildRecognitionPreview(this.data.visibleFields, this.data.fieldValues, result && result.candidates)
      this.setData({ recognitionCandidates: candidates })
      wx.showToast({ title: candidates.length ? '识别完成，请确认结果' : '未识别到可填写内容', icon: 'none' })
    } catch (error) {
      if (this.pageAlive && sequence === this.recognitionSequence && this.actorStillCurrent()) {
        this.clearReviewHistoryOnAccessError(error)
        wx.showToast({ title: safeErrorMessage(error, '文本识别失败，请稍后重试'), icon: 'none' })
      }
    } finally {
      if (this.pageAlive && sequence === this.recognitionSequence) this.setData({ recognizing: false })
    }
  },

  onCancelRecognition() {
    if (!this.data.recognizing) return
    this.recognitionSequence += 1
    this.setData({ recognizing: false, recognitionText: '', recognitionCandidates: [] })
    wx.showToast({ title: '已取消文本识别', icon: 'none' })
  },

  onRecognitionCandidateToggle(event) {
    if (this.data.recognizing || this.data.readOnly || this.data.reviewDraftLocked) return
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.data.recognitionCandidates.length) return
    this.setData({ [`recognitionCandidates[${index}].selected`]: Boolean(event.detail.value.length) })
  },

  onApplyRecognitionCandidates() {
    if (this.data.recognizing || this.data.readOnly || this.data.reviewDraftLocked) return
    const selected = this.data.recognitionCandidates.filter(item => item.selected)
    if (!selected.length) {
      wx.showToast({ title: '请先选择需要填入的识别结果', icon: 'none' })
      return
    }
    const applied = applyRecognitionPreview(this.data.visibleFields, this.data.fieldValues, selected)
    return this.applyConditionalValues(applied.fieldValues, {
      recognitionText: '', recognitionCandidates: []
    }, () => {
      wx.showToast({ title: '已填入选中字段', icon: 'success' })
    })
  },

  onComment(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    this.markDraftDirty({ comment: event.detail.value })
  },

  onFieldInput(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    // Keep internal boolean/Promise results out of the native bindinput return channel.
    this.applyFieldValue(event.currentTarget.dataset.fieldkey, event.detail.value)
  },

  onNumberInput(event) {
    this.onFieldInput(event)
  },

  onBooleanChange(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    const raw = event.detail.value
    const value = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null
    return this.applyFieldValue(event.currentTarget.dataset.fieldkey, value)
  },

  onDateChange(event) {
    this.onFieldInput(event)
  },

  onSingleSelectChange(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    const key = event.currentTarget.dataset.fieldkey
    const field = this.data.visibleFields.find(item => item.fieldKey === key)
    const options = field && field.constraints && field.constraints.options
    const value = Array.isArray(options) ? options[Number(event.detail.value)] : null
    return this.applyFieldValue(key, value === undefined ? null : value)
  },

  onMultiSelectChange(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    const key = event.currentTarget.dataset.fieldkey
    const selected = event.detail.value.slice()
    return this.applyFieldValue(key, selected)
  },

  applyFieldValue(fieldKey, value) {
    return this.applyConditionalValues({ ...this.data.fieldValues, [fieldKey]: value })
  },

  applyConditionalValues(values, extraUpdate = {}, onApplied) {
    const derived = deriveConditionalForm(this.fieldDefinitions || this.data.fields, values)
    const commit = () => {
      if (!this.markDraftDirty({
        fieldValues: derived.fieldValues,
        visibleFields: derived.visibleFields,
        ...extraUpdate
      })) return false
      if (typeof onApplied === 'function') onApplied()
      return true
    }
    if (!derived.clearedFieldKeys.length) return commit()
    return new Promise(resolve => {
      wx.showModal({
        title: '切换后将清空字段',
        content: `将清空 ${derived.clearedFieldKeys.length} 个不再适用的已填字段，是否继续？`,
        confirmText: '继续切换',
        success: result => resolve(result.confirm ? commit() : false),
        fail: () => resolve(false)
      })
    })
  },

  normalizedFieldValues() {
    return this.data.visibleFields.map(field => {
      let value = this.data.fieldValues[field.fieldKey]
      const label = field.name || '动态字段'
      const missing = value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
      if (field.required && missing) throw new Error(`请填写必填字段：${label}`)
      const constraints = field.constraints || {}
      if (!missing && (field.type === 'short_text' || field.type === 'long_text')) {
        if (typeof value !== 'string') throw new Error(`${label}必须填写文本`)
        if (constraints.minLength !== undefined && value.length < constraints.minLength) {
          throw new Error(`${label}长度不能少于${constraints.minLength}个字符`)
        }
        if (constraints.maxLength !== undefined && value.length > constraints.maxLength) {
          throw new Error(`${label}长度不能超过${constraints.maxLength}个字符`)
        }
        if (constraints.pattern && !(new RegExp(constraints.pattern)).test(value)) {
          throw new Error(`${label}格式不符合要求`)
        }
      } else if (field.type === 'number' && !missing) {
        const number = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(number)) throw new Error(`${label}必须填写数字`)
        if (constraints.min !== undefined && number < constraints.min) throw new Error(`${label}不能小于${constraints.min}`)
        if (constraints.max !== undefined && number > constraints.max) throw new Error(`${label}不能大于${constraints.max}`)
        if (!respectsDecimalPlaces(number, constraints.decimalPlaces)) throw new Error(`${label}小数位数不符合要求`)
        value = number
      } else if (!missing && field.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`${label}必须选择是或否`)
      } else if (!missing && field.type === 'date' && !isValidDate(value)) {
        throw new Error(`${label}日期无效`)
      } else if (!missing && field.type === 'single_select' &&
          (!Array.isArray(constraints.options) || !constraints.options.includes(value))) {
        throw new Error(`${label}选项无效`)
      } else if (!missing && field.type === 'multi_select' &&
          (!Array.isArray(value) || !Array.isArray(constraints.options) ||
            new Set(value).size !== value.length || value.some(item => !constraints.options.includes(item)))) {
        throw new Error(`${label}选项无效`)
      }
      return { fieldKey: field.fieldKey, value: missing ? null : value }
    })
  },

  addSelectedFiles(selected) {
    if (this.data.readOnly || this.data.reviewDraftLocked || this.data.submitting) return
    const files = this.data.files.slice()
    const originalCount = files.length
    let total = files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    for (const source of selected) {
      const size = Number(source.size)
      const extension = extensionOf(source.name || source.path)
      const category = source.category || categoryFor(extension, source.mediaType)
      if (!category || !Number.isFinite(size) || size <= 0) {
        wx.showToast({ title: '文件格式或大小无效', icon: 'none' })
        continue
      }
      if (!this.data.allowedEvidenceTypes.includes(extension)) {
        wx.showToast({ title: `当前节点不允许 ${extension.toUpperCase()} 格式`, icon: 'none' })
        continue
      }
      if (total + size > FEEDBACK_TOTAL_LIMIT) {
        wx.showToast({ title: '本轮凭证文件合计不能超过 120 MB', icon: 'none' })
        continue
      }
      total += size
      files.push({
        localKey: `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name: source.name,
        path: source.path,
        size,
        sizeText: formatBytes(size),
        category,
        extension,
        status: 'pending',
        statusLabel: '待上传',
        progressPercent: 0,
        evidenceId: '',
        errorMessage: '',
        errorCode: '',
        canRetry: false
      })
    }
    if (files.length !== originalCount) {
      this.markDraftDirty({ files, selectedTotalBytes: total, selectedTotalText: formatBytes(total) })
    }
  },

  invokeEvidencePicker(api, options) {
    const actorId = currentUserId()
    const { lineId, nodeId, expectedNodeVersion } = this.data
    let pending = false
    const release = () => {
      if (!pending) return
      pending = false
      this.evidencePickerPending -= 1
    }
    const stillCurrent = () => this.pageAlive && actorId === currentUserId() && actorId === this.loadActorId &&
      lineId === this.data.lineId && nodeId === this.data.nodeId && expectedNodeVersion === this.data.expectedNodeVersion &&
      !this.data.readOnly && !this.data.reviewDraftLocked && !this.data.submitting
    if (!stillCurrent()) return
    const fail = error => {
      release()
      if (!stillCurrent()) return
      const message = error && typeof error.errMsg === 'string' ? error.errMsg : ''
      if (/\bcancel(?:led)?\b/i.test(message)) return
      wx.showToast({ title: '无法完成文件选择，请检查微信版本及系统授权后重试', icon: 'none' })
    }
    try {
      if (typeof wx[api] !== 'function' || typeof wx.canIUse === 'function' && !wx.canIUse(api)) {
        fail()
        return
      }
      this.evidencePickerPending = (this.evidencePickerPending || 0) + 1
      pending = true
      wx[api]({ ...options, success: result => { release(); if (stillCurrent()) options.success(result) }, fail })
    } catch (error) {
      fail()
    }
  },

  chooseMediaEvidence() {
    if (this.data.readOnly || this.data.reviewDraftLocked || this.data.submitting) return
    const platform = devicePlatform()
    if (platform === 'mac' || platform === 'windows') {
      // chooseMessageFile selects chat attachments, not local media.
      this.invokeEvidencePicker('showActionSheet', {
        itemList: ['选择本机图片', '选择本机视频'],
        success: result => {
          if (result.tapIndex === 0) {
            this.invokeEvidencePicker('chooseImage', {
              count: 9,
              sourceType: ['album'],
              sizeType: ['original'],
              success: selected => this.addSelectedFiles((selected.tempFiles || []).map((file, index) => ({
                name: displayName(file, `image-${index + 1}.jpg`),
                path: file.path,
                size: file.size,
                category: 'image'
              })))
            })
          } else if (result.tapIndex === 1) {
            if (platform === 'mac' && supportsOriginalMediaVideo()) {
              this.invokeEvidencePicker('chooseMedia', {
                count: 1, mediaType: ['video'], sourceType: ['album'], sizeType: ['original'],
                success: selected => this.addSelectedFiles((selected.tempFiles || []).map(file => ({
                  name: displayName(file, ''), path: file.tempFilePath, size: file.size, category: 'video'
                })))
              })
              return
            }
            this.invokeEvidencePicker('chooseVideo', {
              sourceType: ['album'],
              compressed: false,
              success: selected => this.addSelectedFiles([{
                name: displayName(selected, 'video.mp4'),
                path: selected.tempFilePath,
                size: selected.size,
                category: 'video'
              }])
            })
          }
        }
      })
      return
    }
    this.invokeEvidencePicker('chooseMedia', {
      count: 9,
      mediaType: ['image', 'video'],
      sourceType: ['album', 'camera'],
      success: result => this.addSelectedFiles((result.tempFiles || []).map((file, index) => {
        let name = displayName(file, `${file.fileType || 'media'}-${index + 1}`)
        if (!extensionOf(name)) name += file.fileType === 'image' ? '.jpg' : '.mp4'
        return {
          name,
          path: file.tempFilePath,
          size: file.size,
          mediaType: file.fileType,
          category: file.fileType === 'image' ? 'image' : 'video'
        }
      }))
    })
  },

  choosePdfEvidence() {
    if (this.data.readOnly || this.data.reviewDraftLocked || this.data.submitting) return
    this.invokeEvidencePicker('chooseMessageFile', {
      count: 100,
      type: 'file',
      extension: ['pdf'],
      success: result => this.addSelectedFiles((result.tempFiles || []).map((file, index) => ({
        name: displayName(file, `document-${index + 1}.pdf`),
        path: file.path,
        size: file.size,
        category: 'pdf'
      })))
    })
  },

  removeFile(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked || this.data.submitting) return
    const index = Number(event.currentTarget.dataset.index)
    const current = this.data.files[index]
    if (!current || current.status === 'uploading') return
    const files = this.data.files.slice()
    files.splice(index, 1)
    const total = files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    this.markDraftDirty({ files, selectedTotalBytes: total, selectedTotalText: formatBytes(total) })
  },

  updateLocalFile(index, changes) {
    const files = this.data.files.slice()
    files[index] = { ...files[index], ...changes }
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    const uploadedBytes = files.reduce((sum, file) => {
      const progress = file.status === 'registered' ? 100 : Number(file.progressPercent || 0)
      return sum + Number(file.size || 0) * Math.max(0, Math.min(100, progress)) / 100
    }, 0)
    const uploadProgressPercent = totalBytes ? Math.round(uploadedBytes * 100 / totalBytes) : 0
    this.setData({ files, uploadProgressPercent })
  },

  createEvidenceUploader() {
    return createEvidenceUploader({
      prepareFile: prepareEvidenceFile,
      beginUpload: input => businessService.beginEvidenceUpload(input),
      refreshUpload: input => businessService.refreshEvidenceUploadAuthorization(input),
      finalizeUpload: input => businessService.finalizeEvidenceUpload(input),
      cosFactory: options => {
        if (typeof globalThis === 'object' && typeof globalThis.window === 'undefined') globalThis.window = globalThis
        const COS = require('../../vendor/cos-wx-sdk-v5')
        return new COS({
          // The scoped server grant permits PutObject, not PostObject.
          SimpleUploadMethod: 'putObject',
          getAuthorization: (request, callback) => {
            Promise.resolve(options.getAuthorization()).then(callback).catch(error => {
              options.onAuthorizationError(error)
              callback({})
            })
          }
        })
      }
    })
  },

  writeStillCurrent(operation) {
    return Boolean(operation) && this.pageAlive && this.actorStillCurrent() && currentUserId() === operation.actorId &&
      this.writeSequence === operation.sequence && this.data.lineId === operation.lineId &&
      this.data.nodeId === operation.nodeId && this.data.expectedNodeVersion === operation.nodeVersion
  },

  operationStillOwnsPage(operation) {
    return Boolean(operation) && this.pageAlive && this.actorStillCurrent() && currentUserId() === operation.actorId &&
      this.writeSequence === operation.sequence && this.data.lineId === operation.lineId &&
      this.data.nodeId === operation.nodeId
  },

  async uploadAndRegisterEvidence(operation) {
    const indexes = this.data.files.map((file, index) => ({ file, index }))
      .filter(item => item.file.status !== 'registered' || !item.file.evidenceId)
      .map(item => item.index)
    const uploader = this.createEvidenceUploader()
    let cursor = 0
    let firstError = null
    const worker = async () => {
      while (cursor < indexes.length) {
        const index = indexes[cursor++]
        const file = this.data.files[index]
        if (!this.writeStillCurrent(operation)) throw new Error('页面状态已变化')
        this.updateLocalFile(index, {
          status: 'uploading', statusLabel: '上传中 0%', progressPercent: 0,
          errorMessage: '', errorCode: '', canRetry: false
        })
        try {
          const registered = await uploader.upload({
            businessLineId: operation.lineId,
            nodeId: operation.nodeId,
            expectedNodeVersion: operation.nodeVersion,
            file,
            isCurrent: () => this.writeStillCurrent(operation),
            onProgress: progressPercent => {
              if (this.writeStillCurrent(operation)) this.updateLocalFile(index, {
                progressPercent,
                statusLabel: `上传中 ${progressPercent}%`
              })
            }
          })
          if (!this.writeStillCurrent(operation)) throw new Error('页面状态已变化')
          this.updateLocalFile(index, {
            name: registered.fileName || file.name,
            extension: extensionOf(registered.fileName || file.name),
            status: 'registered', statusLabel: '已登记', progressPercent: 100,
            evidenceId: registered.evidenceId, errorMessage: '', errorCode: '', canRetry: false
          })
        } catch (error) {
          this.clearReviewHistoryOnAccessError(error, operation)
          const safeError = safeUploadError(error)
          if (this.writeStillCurrent(operation)) this.updateLocalFile(index, {
            status: 'failed', statusLabel: '上传失败',
            errorMessage: safeError.message,
            errorCode: safeError.code,
            canRetry: true
          })
          if (!firstError) firstError = safeError
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, indexes.length) }, () => worker()))
    if (firstError) throw firstError
    return this.data.files.map(file => file.evidenceId)
  },

  async previewEvidence(event) {
    const { evidenceid, category, status, filename } = event.currentTarget.dataset
    if (status !== 'available' || !evidenceid) return
    wx.showLoading({ title: '正在获取访问授权' })
    try {
      const grant = await businessService.getEvidenceAccess(evidenceid)
      const safeCategory = grant.category || category
      const extension = extensionOf(grant.fileName || filename)
      if (safeCategory === 'image' && ['heic', 'heif'].includes(extension)) {
        const downloaded = await wx.downloadFile({ url: grant.url })
        if (typeof wx.saveFile === 'function') await wx.saveFile({ tempFilePath: downloaded.tempFilePath })
        wx.showToast({ title: '文件已下载，请从下载记录打开', icon: 'none' })
      } else if (safeCategory === 'image') {
        wx.previewImage({ current: grant.url, urls: [grant.url] })
      } else if (safeCategory === 'video') {
        this.setData({ videoPreview: { evidenceId: evidenceid, url: grant.url, fileName: grant.fileName } })
      } else if (safeCategory === 'pdf') {
        const downloaded = await wx.downloadFile({ url: grant.url })
        await wx.openDocument({ filePath: downloaded.tempFilePath, fileType: 'pdf', showMenu: true })
      }
    } catch (error) {
      this.clearReviewHistoryOnAccessError(error)
      wx.showToast({ title: error.code === 'EVIDENCE_EXPIRED' ? '凭证已到期或已清理' : '凭证暂时无法打开', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  closeVideoPreview() {
    this.setData({ videoPreview: null })
  },

  async downloadAllEvidence() {
    if (this.data.downloading) return
    const evidences = this.data.history.flatMap(item => item.evidences || []).filter(item => item.canPreview)
    if (!evidences.length) {
      wx.showToast({ title: '暂无可下载凭证', icon: 'none' })
      return
    }
    this.setData({ downloading: true })
    let completed = 0
    try {
      for (const evidence of evidences) {
        const grant = await businessService.getEvidenceAccess(evidence.evidenceId)
        const downloaded = await wx.downloadFile({ url: grant.url })
        if (typeof wx.saveFile === 'function') await wx.saveFile({ tempFilePath: downloaded.tempFilePath })
        completed += 1
        wx.showLoading({ title: `已下载 ${completed}/${evidences.length}` })
      }
      wx.showToast({ title: `已完成 ${completed} 个文件`, icon: 'success' })
    } catch (error) {
      this.clearReviewHistoryOnAccessError(error)
      wx.showToast({ title: `已下载 ${completed} 个，后续失败`, icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ downloading: false })
    }
  },

  canWriteReviewNode() {
    return this.pageAlive && this.actorStillCurrent() && this.data.workflowMode === 'review' &&
      this.data.canSubmit && !this.data.frozen && !this.data.readOnly
  },

  primaryActionLabel() {
    return this.data.requiresReview === false ? '完成节点' : '提交审核'
  },

  onPrimaryAction() {
    return this.data.requiresReview === false
      ? this.performProgressAction('complete_node')
      : this.onSubmitReview()
  },

  async refreshPreservingDraft(operation) {
    const fieldValues = { ...this.data.fieldValues }
    const comment = this.data.comment
    const files = this.data.files.slice()
    const selectedTotalBytes = this.data.selectedTotalBytes
    const selectedTotalText = this.data.selectedTotalText
    await this.loadData()
    if (!this.operationStillOwnsPage(operation)) return
    // Restore the draft and its dependent choices together, not the server draft's choices.
    const restoredForm = deriveConditionalForm(this.fieldDefinitions || this.data.fields, fieldValues)
    this.formRevision += 1
    this.setData({
      fieldValues: restoredForm.fieldValues, visibleFields: restoredForm.visibleFields,
      comment, files, selectedTotalBytes, selectedTotalText, draftDirty: true
    })
  },

  async progressPayload(operation) {
    const draftPayload = operation.draftPayload || {
      fieldValues: this.normalizedFieldValues(),
      comment: this.data.comment.trim()
    }
    const evidenceIds = await this.uploadAndRegisterEvidence(operation)
    return {
      businessLineId: operation.lineId,
      nodeId: operation.nodeId,
      expectedNodeVersion: operation.nodeVersion,
      fieldValues: draftPayload.fieldValues,
      comment: draftPayload.comment,
      evidenceIds
    }
  },

  async performProgressAction(action) {
    if (!this.canWriteReviewNode() || this.data.submitting || this.data.reviewDraftLocked) return false
    if (action === 'mark_blocked' && !this.data.comment.trim()) {
      wx.showToast({ title: '请填写受阻原因', icon: 'none' })
      return false
    }
    let fieldValues
    try {
      fieldValues = this.normalizedFieldValues()
    } catch (error) {
      wx.showToast({ title: safeErrorMessage(error, '请检查字段内容'), icon: 'none' })
      return false
    }
    const requestedActorId = currentUserId()
    const operation = Object.freeze({
      actorId: requestedActorId,
      sequence: ++this.writeSequence,
      lineId: this.data.lineId,
      nodeId: this.data.nodeId,
      nodeVersion: this.data.expectedNodeVersion,
      draftPayload: Object.freeze({
        fieldValues: Object.freeze(fieldValues.map(item => Object.freeze({ ...item }))),
        comment: this.data.comment.trim()
      })
    })
    const intent = `progress:${action}`
    if (this.progressIntent !== intent) {
      this.progressIntent = intent
      this.progressRequestKey = requestKey('progress')
    }
    this.setData({ submitting: true, errorMessage: '' })
    try {
      const needsUpload = this.data.files.some(file => file.status !== 'registered' || !file.evidenceId)
      const payload = needsUpload
        ? await this.progressPayload(operation)
        : {
            businessLineId: operation.lineId,
            nodeId: operation.nodeId,
            expectedNodeVersion: operation.nodeVersion,
            fieldValues: operation.draftPayload.fieldValues,
            comment: operation.draftPayload.comment,
            evidenceIds: this.data.files.map(file => file.evidenceId).filter(Boolean)
          }
      if (!this.writeStillCurrent(operation)) return false
      const usedRequestKey = this.progressRequestKey
      const progressResult = await businessService.submitFeedback({ ...payload, action, requestKey: usedRequestKey })
      if (!this.writeStillCurrent(operation)) return false
      const completedStatusAccepted = progressResult && (progressResult.nodeStatus === 'completed' ||
        progressResult.nodeStatus === 'awaiting_decision' && progressResult.routeTransition &&
          progressResult.routeTransition.kind === 'await_manual_decision')
      if (action === 'complete_node' && (!completedStatusAccepted ||
          !Number.isSafeInteger(progressResult.nodeVersion) ||
          progressResult.nodeVersion <= payload.expectedNodeVersion)) {
        throw new Error('完成节点结果无效，请刷新后重试')
      }
      if (action === 'save_progress') {
        if (!Number.isSafeInteger(progressResult && progressResult.nodeVersion) ||
            progressResult.nodeVersion <= payload.expectedNodeVersion) {
          throw new Error('处理进度保存结果无效，请刷新后重试')
        }
        this.savedProgress = {
          payload: { ...payload },
          requestKey: usedRequestKey,
          expectedNodeVersion: payload.expectedNodeVersion,
          nodeVersion: progressResult.nodeVersion
        }
      }
      this.progressRequestKey = ''
      this.progressIntent = ''
      this.setData({ files: [], selectedTotalBytes: 0, selectedTotalText: '0 B', uploadProgressPercent: 0 })
      wx.showToast({
        title: action === 'mark_blocked' ? '已标记受阻' : action === 'complete_node' ? '节点已完成' : '处理进度已保存',
        icon: 'success'
      })
      await this.loadData()
      return true
    } catch (error) {
      this.clearReviewHistoryOnAccessError(error, operation)
      if (this.writeStillCurrent(operation)) {
        if (error.code === 'VERSION_CONFLICT') await this.refreshPreservingDraft(operation)
        wx.showToast({ title: safeErrorMessage(error, action === 'complete_node' ? '完成节点失败，请重试' : '处理进度保存失败，请重试'), icon: 'none' })
      }
      return false
    } finally {
      if (this.operationStillOwnsPage(operation)) this.setData({ submitting: false })
    }
  },

  onSaveProgress() {
    return this.performProgressAction('save_progress')
  },

  onMarkBlocked() {
    return this.performProgressAction('mark_blocked')
  },

  finishReviewSubmission(operation) {
    if (!this.operationStillOwnsPage(operation)) return false
    this.progressRequestKey = ''
    this.progressIntent = ''
    this.reviewRequestKey = ''
    this.progressExpectedNodeVersion = null
    this.reviewExpectedNodeVersion = null
    this.savedProgress = null
    this.setData({ readOnly: true, reviewDraftLocked: true, canSubmit: false })
    wx.showToast({ title: '已提交审核', icon: 'success' })
    if (typeof wx.navigateBack === 'function') wx.navigateBack()
    return true
  },

  async reviewSubmissionVisible(operation) {
    try {
      const workspace = await businessService.getNodeWorkspace(operation.lineId, operation.nodeId)
      if (!this.operationStillOwnsPage(operation)) return false
      const node = workspace && workspace.node
      return Boolean(node && node._id === operation.nodeId && node.status === 'pending_review')
    } catch (error) {
      this.clearReviewHistoryOnAccessError(error, operation)
      return false
    }
  },

  async onSubmitReview() {
    if (!this.canWriteReviewNode() || this.data.submitting) return
    const savedProgress = this.savedProgress && !this.data.files.length ? this.savedProgress : null
    const storedDraftReady = this.data.serverDraftAvailable &&
      (!this.data.requiresEvidence || this.data.serverDraftHasEvidence)
    const useStoredDraft = !this.data.draftDirty && !savedProgress && !this.data.files.length && storedDraftReady
    const currentRoundHasEvidence = this.data.files.length || savedProgress || this.data.serverDraftHasEvidence
    if (this.data.requiresEvidence && !currentRoundHasEvidence) {
      wx.showToast({ title: '提交审核前必须上传凭证', icon: 'none' })
      return
    }
    let fieldValues = null
    if (!savedProgress) {
      try {
        fieldValues = this.normalizedFieldValues()
      } catch (error) {
        wx.showToast({ title: safeErrorMessage(error, '请检查字段内容'), icon: 'none' })
        return
      }
    }
    if (this.progressIntent !== 'review-draft') {
      this.progressIntent = 'review-draft'
      this.progressRequestKey = useStoredDraft ? '' : savedProgress ? savedProgress.requestKey : requestKey('progress')
      this.progressExpectedNodeVersion = useStoredDraft
        ? null
        : savedProgress ? savedProgress.expectedNodeVersion : null
      this.reviewExpectedNodeVersion = useStoredDraft
        ? this.data.expectedNodeVersion
        : savedProgress ? savedProgress.nodeVersion : null
    }
    if (!this.reviewRequestKey) this.reviewRequestKey = requestKey('review')
    if (!Number.isSafeInteger(this.progressExpectedNodeVersion)) {
      this.progressExpectedNodeVersion = this.data.expectedNodeVersion
    }
    const reviewDraft = savedProgress
      ? { ...savedProgress.payload, fieldValues: savedProgress.payload.fieldValues.map(item => ({ ...item })) }
      : {
          fieldValues: fieldValues.map(item => ({ ...item })),
          comment: this.data.comment.trim()
        }
    const operation = Object.freeze({
      actorId: currentUserId(),
      sequence: ++this.writeSequence,
      lineId: this.data.lineId,
      nodeId: this.data.nodeId,
      nodeVersion: this.data.expectedNodeVersion,
      draftPayload: Object.freeze({
        ...reviewDraft,
        fieldValues: Object.freeze(reviewDraft.fieldValues.map(item => Object.freeze({ ...item })))
      }),
      progressRequestKey: this.progressRequestKey,
      reviewRequestKey: this.reviewRequestKey,
      progressExpectedNodeVersion: this.progressExpectedNodeVersion,
      reviewExpectedNodeVersion: this.reviewExpectedNodeVersion
    })
    const previouslyLocked = this.data.reviewDraftLocked
    let reviewRequestDispatched = false
    this.setData({ submitting: true, reviewDraftLocked: true, errorMessage: '' })
    try {
      if (!useStoredDraft) {
        const payload = savedProgress ? operation.draftPayload : await this.progressPayload(operation)
        if (!this.writeStillCurrent(operation)) return
        reviewRequestDispatched = true
        const result = await businessService.saveAndSubmitNodeForReview({
          businessLineId: operation.lineId,
          nodeId: operation.nodeId,
          expectedNodeVersion: operation.progressExpectedNodeVersion,
          fieldValues: payload.fieldValues,
          comment: payload.comment,
          evidenceIds: payload.evidenceIds,
          progressRequestKey: operation.progressRequestKey,
          reviewRequestKey: operation.reviewRequestKey
        })
        if (!this.writeStillCurrent(operation)) return
        if (!result || result.nodeStatus !== 'pending_review' ||
            !Number.isSafeInteger(result.nodeVersion) ||
            result.nodeVersion <= operation.progressExpectedNodeVersion) {
          throw new Error('提交审核结果无效，请刷新后重试')
        }
      } else {
        reviewRequestDispatched = true
        await businessService.submitNodeForReview({
          businessLineId: operation.lineId,
          nodeId: operation.nodeId,
          expectedNodeVersion: operation.reviewExpectedNodeVersion,
          requestKey: operation.reviewRequestKey
        })
      }
      if (!this.writeStillCurrent(operation)) {
        this.actorStillCurrent()
        return
      }
      this.finishReviewSubmission(operation)
    } catch (error) {
      this.clearReviewHistoryOnAccessError(error, operation)
      if (this.writeStillCurrent(operation)) {
        // Upload failure cannot have submitted a new review. Keep the local
        // draft editable; only an already-dispatched write needs replay locks.
        if (!reviewRequestDispatched && !previouslyLocked) {
          this.setData({ reviewDraftLocked: false, draftDirty: true })
        }
        const committed = reviewRequestDispatched && await this.reviewSubmissionVisible(operation)
        if (committed) this.finishReviewSubmission(operation)
        else if (this.writeStillCurrent(operation)) {
          wx.showToast({ title: safeErrorMessage(error, '提交审核失败，请重试'), icon: 'none' })
        }
      }
    } finally {
      if (this.writeStillCurrent(operation)) this.setData({ submitting: false })
    }
  },

  async submit() {
    if (!this.data.canSubmit || this.data.frozen) {
      wx.showToast({ title: this.data.frozen ? '售后已冻结，不可提交' : '当前节点不可提交', icon: 'none' })
      return
    }
    let fieldValues
    try {
      fieldValues = this.normalizedFieldValues()
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
      return
    }
    const status = this.data.statusOptions[this.data.statusIndex].value
    if (!this.data.comment.trim() && status !== 'completed') {
      wx.showToast({ title: '请填写进度说明', icon: 'none' })
      return
    }
    if (this.data.submitting) return
    if (status === 'completed' && this.data.requiresEvidence && !this.data.files.length) {
      wx.showToast({ title: '完成节点前必须上传凭证', icon: 'none' })
      return
    }
    if (!this.feedbackRequestKey) this.feedbackRequestKey = requestKey()
    const operation = Object.freeze({
      actorId: currentUserId(),
      sequence: ++this.writeSequence,
      lineId: this.data.lineId,
      nodeId: this.data.nodeId,
      nodeVersion: this.data.expectedNodeVersion,
      status,
      fieldValues: Object.freeze(fieldValues.map(item => Object.freeze({ ...item }))),
      comment: this.data.comment.trim(),
      requestKey: this.feedbackRequestKey
    })
    this.setData({ submitting: true })
    try {
      const evidenceIds = await this.uploadAndRegisterEvidence(operation)
      if (!this.writeStillCurrent(operation)) {
        this.actorStillCurrent()
        return
      }
      await businessService.submitFeedback({
        businessLineId: operation.lineId,
        nodeId: operation.nodeId,
        expectedNodeVersion: operation.nodeVersion,
        status: operation.status,
        fieldValues: operation.fieldValues,
        comment: operation.comment,
        evidenceIds,
        requestKey: operation.requestKey
      })
      if (!this.writeStillCurrent(operation)) {
        this.actorStillCurrent()
        return
      }
      wx.showToast({ title: '反馈成功', icon: 'success' })
      this.feedbackRequestKey = ''
      this.setData({ comment: '', files: [], selectedTotalBytes: 0, selectedTotalText: '0 B', uploadProgressPercent: 0 })
      await this.loadData()
    } catch (error) {
      if (this.writeStillCurrent(operation)) {
        wx.showToast({ title: safeErrorMessage(error, '反馈失败，请重试'), icon: 'none' })
      }
    } finally {
      if (this.writeStillCurrent(operation)) this.setData({ submitting: false })
    }
  }
})
