const businessService = require('../../services/business')
const { safeErrorMessage } = require('../../utils/safe-error')

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
const FEEDBACK_TOTAL_LIMIT = 20 * MEBIBYTE
const CATEGORY_LIMITS = Object.freeze({ image: 5 * MEBIBYTE, pdf: 20 * MEBIBYTE, video: 20 * MEBIBYTE })
const ALL_EVIDENCE_TYPES = Object.freeze(['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])

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
  if (mediaType === 'image' || ['jpg', 'jpeg', 'png'].includes(extension)) return 'image'
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

function isDesktopPlatform() {
  try {
    const info = typeof wx.getDeviceInfo === 'function'
      ? wx.getDeviceInfo()
      : typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : {}
    const platform = typeof info.platform === 'string' ? info.platform.toLowerCase() : ''
    return platform === 'mac' || platform === 'windows'
  } catch (error) {
    return false
  }
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
    fieldValues: {},
    history: [],
    loadingHistory: true,
    errorMessage: '',
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    comment: '',
    files: [],
    selectedTotalBytes: 0,
    selectedTotalText: '0 B',
    requiresEvidence: false,
    allowedEvidenceTypes: [],
    videoPreview: null,
    downloading: false,
    submitting: false
  },

  async onLoad(query = {}) {
    const actorId = currentUserId()
    if (!actorId) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.loadActorId = actorId
    this.pageAlive = true
    this.loadSequence = 0
    this.writeSequence = 0
    this.progressExpectedNodeVersion = null
    this.reviewExpectedNodeVersion = null
    this.setData({ lineId: String(query.lineId || ''), nodeId: String(query.nodeId || '') })
    await this.loadData()
  },

  onShow() {
    if (this.data.lineId && this.hasLoaded) return this.loadData()
  },

  onUnload() {
    this.pageAlive = false
    this.loadSequence += 1
  },

  actorStillCurrent() {
    if (this.loadActorId && currentUserId() === this.loadActorId) return true
    wx.reLaunch({ url: '/pages/login/index' })
    return false
  },

  async loadData() {
    const requestSequence = ++this.loadSequence
    const requestedActorId = this.loadActorId || currentUserId()
    this.setData({ loadingHistory: true, errorMessage: '' })
    try {
      const detail = await businessService.getBusinessLine(this.data.lineId)
      if (!this.pageAlive || requestSequence !== this.loadSequence || currentUserId() !== requestedActorId) return
      const node = (detail.nodes || []).find(item => item._id === this.data.nodeId)
      if (!node) throw new Error('未找到节点')
      const historyResult = await businessService.getNodeHistory(this.data.lineId, this.data.nodeId)
      if (!this.pageAlive || requestSequence !== this.loadSequence || currentUserId() !== requestedActorId) return
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
      const latestDraft = !legacyMode && Array.isArray(historyResult.history) ? historyResult.history[0] : null
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
      for (const field of fields) {
        if (field.type !== 'multi_select') continue
        const selected = Array.isArray(fieldValues[field.fieldKey]) ? fieldValues[field.fieldKey] : []
        field.optionItems = field.optionItems.map(option => ({ ...option, selected: selected.includes(option.value) }))
      }
      const frozen = FROZEN_STATUSES.has(detail.line && detail.line.status)
      const canSubmit = Boolean(historyResult.canSubmit) && !frozen
      const readOnly = frozen || !canSubmit || !legacyMode && node.status === 'pending_review'
      this.setData({
        nodeName: node.name || (historyResult.node && historyResult.node.name) || '',
        nodeCode: node.nodeCode || (historyResult.node && historyResult.node.nodeCode) || '',
        expectedNodeVersion: node.version,
        lineVersion: detail.line.version,
        fields,
        fieldValues,
        requiresEvidence,
        allowedEvidenceTypes,
        history: formattedHistory(historyResult.history),
        canSubmit,
        frozen,
        legacyMode,
        workflowMode: legacyMode ? 'legacy' : 'review',
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
        readOnly
      })
      this.hasLoaded = true
      wx.setNavigationBarTitle({ title: node.name || '节点反馈' })
    } catch (error) {
      if (this.pageAlive && requestSequence === this.loadSequence && this.actorStillCurrent()) {
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

  onStatus(event) {
    if (this.data.submitting || this.data.readOnly) return
    this.setData({ statusIndex: Number(event.detail.value) })
  },

  markDraftDirty() {
    if (this.data.submitting || this.data.reviewDraftLocked) return false
    this.savedProgress = null
    this.progressIntent = ''
    this.progressRequestKey = ''
    this.progressExpectedNodeVersion = null
    this.reviewRequestKey = ''
    this.reviewExpectedNodeVersion = null
    this.setData({ draftDirty: true })
    return true
  },

  onComment(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    if (!this.markDraftDirty()) return
    this.setData({ comment: event.detail.value })
  },

  onFieldInput(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    if (!this.markDraftDirty()) return
    this.setData({ [`fieldValues.${event.currentTarget.dataset.fieldkey}`]: event.detail.value })
  },

  onNumberInput(event) {
    this.onFieldInput(event)
  },

  onBooleanChange(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    if (!this.markDraftDirty()) return
    const raw = event.detail.value
    const value = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null
    this.setData({ [`fieldValues.${event.currentTarget.dataset.fieldkey}`]: value })
  },

  onDateChange(event) {
    this.onFieldInput(event)
  },

  onSingleSelectChange(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    if (!this.markDraftDirty()) return
    const key = event.currentTarget.dataset.fieldkey
    const field = this.data.fields.find(item => item.fieldKey === key)
    const options = field && field.constraints && field.constraints.options
    const value = Array.isArray(options) ? options[Number(event.detail.value)] : null
    this.setData({ [`fieldValues.${key}`]: value === undefined ? null : value })
  },

  onMultiSelectChange(event) {
    if (this.data.readOnly || this.data.reviewDraftLocked) return
    if (!this.markDraftDirty()) return
    const key = event.currentTarget.dataset.fieldkey
    const selected = event.detail.value.slice()
    const fields = this.data.fields.map(field => field.fieldKey === key
      ? { ...field, optionItems: field.optionItems.map(option => ({ ...option, selected: selected.includes(option.value) })) }
      : field)
    this.setData({ [`fieldValues.${key}`]: selected, fields })
  },

  normalizedFieldValues() {
    return this.data.fields.map(field => {
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
      if (size > CATEGORY_LIMITS[category]) {
        const limit = category === 'image' ? '5 MB' : '20 MB'
        const label = category === 'image' ? '图片' : category === 'video' ? '视频' : 'PDF'
        wx.showToast({ title: `${label}单文件不能超过 ${limit}`, icon: 'none' })
        continue
      }
      if (total + size > FEEDBACK_TOTAL_LIMIT) {
        wx.showToast({ title: '单次反馈文件合计不能超过 20 MB', icon: 'none' })
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
        evidenceId: '',
        errorMessage: ''
      })
    }
    if (files.length !== originalCount && !this.markDraftDirty()) return
    this.setData({ files, selectedTotalBytes: total, selectedTotalText: formatBytes(total) })
  },

  chooseMediaEvidence() {
    if (this.data.readOnly || this.data.reviewDraftLocked || this.data.submitting) return
    if (isDesktopPlatform()) {
      wx.chooseMessageFile({
        count: 9,
        type: 'file',
        extension: ['jpg', 'jpeg', 'png', 'mp4', 'mov', 'm4v'],
        success: result => this.addSelectedFiles((result.tempFiles || []).map((file, index) => ({
          name: displayName(file, `media-${index + 1}`),
          path: file.path || file.tempFilePath,
          size: file.size
        })))
      })
      return
    }
    wx.chooseMedia({
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
    wx.chooseMessageFile({
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
    if (!this.markDraftDirty()) return
    const files = this.data.files.slice()
    files.splice(index, 1)
    const total = files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    this.setData({ files, selectedTotalBytes: total, selectedTotalText: formatBytes(total) })
  },

  updateLocalFile(index, changes) {
    const files = this.data.files.slice()
    files[index] = { ...files[index], ...changes }
    this.setData({ files })
  },

  writeStillCurrent(operation) {
    return Boolean(operation) && this.pageAlive && currentUserId() === operation.actorId &&
      this.writeSequence === operation.sequence && this.data.lineId === operation.lineId &&
      this.data.nodeId === operation.nodeId && this.data.expectedNodeVersion === operation.nodeVersion
  },

  operationStillOwnsPage(operation) {
    return Boolean(operation) && this.pageAlive && currentUserId() === operation.actorId &&
      this.writeSequence === operation.sequence && this.data.lineId === operation.lineId &&
      this.data.nodeId === operation.nodeId
  },

  async uploadAndRegisterEvidence(operation) {
    for (let index = 0; index < this.data.files.length; index += 1) {
      const file = this.data.files[index]
      if (file.status === 'registered' && file.evidenceId) continue
      if (!this.writeStillCurrent(operation)) throw new Error('页面状态已变化')
      this.updateLocalFile(index, { status: 'uploading', statusLabel: '上传中', errorMessage: '' })
      let upload
      try {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || `evidence.${file.extension}`
        const cloudPath = `evidence/${operation.lineId}/${operation.nodeId}/${Date.now()}-${index}-${safeName}`
        upload = await wx.cloud.uploadFile({ cloudPath, filePath: file.path })
        if (!this.writeStillCurrent(operation)) throw new Error('页面状态已变化')
      } catch (error) {
        if (this.writeStillCurrent(operation)) {
          this.updateLocalFile(index, {
            status: 'failed', statusLabel: '上传失败', errorMessage: '上传失败，请重试'
          })
        }
        throw Object.assign(new Error('上传失败，请重试'), { code: 'EVIDENCE_UPLOAD_FAILED' })
      }
      try {
        const registered = await businessService.registerEvidenceUpload({
          businessLineId: operation.lineId,
          nodeId: operation.nodeId,
          fileId: upload.fileID,
          fileName: file.name,
          declaredSize: file.size
        })
        if (!this.writeStillCurrent(operation)) throw new Error('页面状态已变化')
        this.updateLocalFile(index, {
          status: 'registered', statusLabel: '已登记', evidenceId: registered.evidenceId, errorMessage: ''
        })
      } catch (error) {
        if (this.writeStillCurrent(operation)) {
          this.updateLocalFile(index, {
            status: 'failed', statusLabel: '上传失败', errorMessage: safeErrorMessage(error, '上传失败，请重试')
          })
        }
        throw error
      }
    }
    return this.data.files.map(file => file.evidenceId)
  },

  async previewEvidence(event) {
    const { evidenceid, category, status } = event.currentTarget.dataset
    if (status !== 'available' || !evidenceid) return
    wx.showLoading({ title: '正在获取访问授权' })
    try {
      const grant = await businessService.getEvidenceAccess(evidenceid)
      const safeCategory = grant.category || category
      if (safeCategory === 'image') {
        wx.previewImage({ current: grant.url, urls: [grant.url] })
      } else if (safeCategory === 'video') {
        this.setData({ videoPreview: { evidenceId: evidenceid, url: grant.url, fileName: grant.fileName } })
      } else if (safeCategory === 'pdf') {
        const downloaded = await wx.downloadFile({ url: grant.url })
        await wx.openDocument({ filePath: downloaded.tempFilePath, fileType: 'pdf', showMenu: true })
      }
    } catch (error) {
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
      wx.showToast({ title: `已下载 ${completed} 个，后续失败`, icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ downloading: false })
    }
  },

  canWriteReviewNode() {
    return this.data.workflowMode === 'review' && this.data.canSubmit && !this.data.frozen && !this.data.readOnly
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
      const payload = await this.progressPayload(operation)
      if (!this.writeStillCurrent(operation)) return false
      const usedRequestKey = this.progressRequestKey
      const progressResult = await businessService.submitFeedback({ ...payload, action, requestKey: usedRequestKey })
      if (!this.writeStillCurrent(operation)) return false
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
      this.setData({ files: [], selectedTotalBytes: 0, selectedTotalText: '0 B' })
      wx.showToast({ title: action === 'mark_blocked' ? '已标记受阻' : '处理进度已保存', icon: 'success' })
      await this.loadData()
      return true
    } catch (error) {
      if (this.writeStillCurrent(operation)) {
        wx.showToast({ title: safeErrorMessage(error, '处理进度保存失败，请重试'), icon: 'none' })
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
    this.setData({ submitting: true, reviewDraftLocked: true, errorMessage: '' })
    let reviewNodeVersion = operation.reviewExpectedNodeVersion
    try {
      if (!useStoredDraft) {
        const payload = savedProgress ? operation.draftPayload : await this.progressPayload(operation)
        if (!this.writeStillCurrent(operation)) return
        const progressResult = await businessService.submitFeedback({
          ...payload,
          expectedNodeVersion: operation.progressExpectedNodeVersion,
          action: 'save_progress',
          requestKey: operation.progressRequestKey
        })
        if (!this.writeStillCurrent(operation)) return
        if (!Number.isSafeInteger(progressResult && progressResult.nodeVersion) ||
            progressResult.nodeVersion <= operation.progressExpectedNodeVersion) {
          throw new Error('处理进度保存结果无效，请刷新后重试')
        }
        if (Number.isSafeInteger(operation.reviewExpectedNodeVersion) &&
            operation.reviewExpectedNodeVersion !== progressResult.nodeVersion) {
          throw new Error('节点版本已变化，请刷新后重试')
        }
        reviewNodeVersion = progressResult.nodeVersion
        this.reviewExpectedNodeVersion = reviewNodeVersion
        this.savedProgress = {
          payload: { ...payload },
          requestKey: operation.progressRequestKey,
          expectedNodeVersion: operation.progressExpectedNodeVersion,
          nodeVersion: progressResult.nodeVersion
        }
      }
      await businessService.submitNodeForReview({
        businessLineId: operation.lineId,
        nodeId: operation.nodeId,
        expectedNodeVersion: reviewNodeVersion,
        requestKey: operation.reviewRequestKey
      })
      if (!this.writeStillCurrent(operation)) {
        this.actorStillCurrent()
        return
      }
      this.progressRequestKey = ''
      this.progressIntent = ''
      this.reviewRequestKey = ''
      this.progressExpectedNodeVersion = null
      this.reviewExpectedNodeVersion = null
      this.savedProgress = null
      this.setData({ readOnly: true, reviewDraftLocked: true, canSubmit: false })
      wx.showToast({ title: '已提交审核', icon: 'success' })
      if (typeof wx.navigateBack === 'function') wx.navigateBack()
    } catch (error) {
      if (this.writeStillCurrent(operation)) {
        wx.showToast({ title: safeErrorMessage(error, '提交审核失败，请重试'), icon: 'none' })
      }
    } finally {
      if (this.writeStillCurrent(operation)) this.setData({ submitting: false })
    }
  },

  async submit() {
    if (!this.data.canSubmit || this.data.frozen) {
      wx.showToast({ title: this.data.frozen ? '业务已冻结，不可提交' : '当前节点不可提交', icon: 'none' })
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
      this.setData({ comment: '', files: [], selectedTotalBytes: 0, selectedTotalText: '0 B' })
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
