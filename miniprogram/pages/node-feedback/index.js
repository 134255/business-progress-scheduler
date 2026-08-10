const businessService = require('../../services/business')

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

function currentUserId() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' ? user._id : ''
}

function requestKey() {
  return `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
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

Page({
  data: {
    lineId: '',
    nodeId: '',
    nodeName: '',
    nodeCode: '',
    expectedNodeVersion: 0,
    lineVersion: 0,
    canSubmit: false,
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
    this.setData({ lineId: String(query.lineId || ''), nodeId: String(query.nodeId || '') })
    await this.loadData()
  },

  actorStillCurrent() {
    if (this.loadActorId && currentUserId() === this.loadActorId) return true
    wx.reLaunch({ url: '/pages/login/index' })
    return false
  },

  async loadData() {
    this.setData({ loadingHistory: true, errorMessage: '' })
    try {
      const detail = await businessService.getBusinessLine(this.data.lineId)
      if (!this.actorStillCurrent()) return
      const node = (detail.nodes || []).find(item => item._id === this.data.nodeId)
      if (!node) throw new Error('未找到节点')
      const historyResult = await businessService.getNodeHistory(this.data.lineId, this.data.nodeId)
      if (!this.actorStillCurrent()) return
      const fields = (Array.isArray(node.fieldDefinitions) ? node.fieldDefinitions : [])
        .slice().sort((left, right) => left.sequence - right.sequence)
        .map(field => ({
          ...field,
          optionItems: field.constraints && Array.isArray(field.constraints.options)
            ? field.constraints.options.map(value => ({ value, selected: false }))
            : []
        }))
      const fieldValues = Object.fromEntries(fields.map(field => [field.fieldKey, initialValue(field)]))
      const frozen = FROZEN_STATUSES.has(detail.line && detail.line.status)
      this.setData({
        nodeName: node.name || (historyResult.node && historyResult.node.name) || '',
        nodeCode: node.nodeCode || (historyResult.node && historyResult.node.nodeCode) || '',
        expectedNodeVersion: node.version,
        lineVersion: detail.line.version,
        fields,
        fieldValues,
        requiresEvidence: Boolean(node.requiresEvidence),
        allowedEvidenceTypes: Array.isArray(node.allowedEvidenceTypes) ? node.allowedEvidenceTypes.slice() : [],
        history: formattedHistory(historyResult.history),
        canSubmit: Boolean(historyResult.canSubmit) && !frozen,
        frozen
      })
      wx.setNavigationBarTitle({ title: node.name || '节点反馈' })
    } catch (error) {
      if (this.actorStillCurrent()) this.setData({ errorMessage: error.message || '节点信息加载失败', canSubmit: false })
    } finally {
      this.setData({ loadingHistory: false })
    }
  },

  async loadHistory() {
    return this.loadData()
  },

  onStatus(event) {
    this.setData({ statusIndex: Number(event.detail.value) })
  },

  onComment(event) {
    this.setData({ comment: event.detail.value })
  },

  onFieldInput(event) {
    this.setData({ [`fieldValues.${event.currentTarget.dataset.fieldkey}`]: event.detail.value })
  },

  onNumberInput(event) {
    this.onFieldInput(event)
  },

  onBooleanChange(event) {
    const raw = event.detail.value
    const value = raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null
    this.setData({ [`fieldValues.${event.currentTarget.dataset.fieldkey}`]: value })
  },

  onDateChange(event) {
    this.onFieldInput(event)
  },

  onSingleSelectChange(event) {
    const key = event.currentTarget.dataset.fieldkey
    const field = this.data.fields.find(item => item.fieldKey === key)
    const options = field && field.constraints && field.constraints.options
    const value = Array.isArray(options) ? options[Number(event.detail.value)] : null
    this.setData({ [`fieldValues.${key}`]: value === undefined ? null : value })
  },

  onMultiSelectChange(event) {
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
    const files = this.data.files.slice()
    let total = files.reduce((sum, file) => sum + Number(file.size || 0), 0)
    for (const source of selected) {
      const size = Number(source.size)
      const extension = extensionOf(source.name || source.path)
      const category = source.category || categoryFor(extension, source.mediaType)
      if (!category || !Number.isFinite(size) || size <= 0) {
        wx.showToast({ title: '文件格式或大小无效', icon: 'none' })
        continue
      }
      if (this.data.allowedEvidenceTypes.length && !this.data.allowedEvidenceTypes.includes(extension)) {
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
    this.setData({ files, selectedTotalBytes: total, selectedTotalText: formatBytes(total) })
  },

  chooseMediaEvidence() {
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
    const index = Number(event.currentTarget.dataset.index)
    const current = this.data.files[index]
    if (!current || current.status === 'uploading') return
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

  async uploadAndRegisterEvidence() {
    for (let index = 0; index < this.data.files.length; index += 1) {
      const file = this.data.files[index]
      if (file.status === 'registered' && file.evidenceId) continue
      this.updateLocalFile(index, { status: 'uploading', statusLabel: '上传中', errorMessage: '' })
      try {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || `evidence.${file.extension}`
        const cloudPath = `evidence/${this.data.lineId}/${this.data.nodeId}/${Date.now()}-${index}-${safeName}`
        const upload = await wx.cloud.uploadFile({ cloudPath, filePath: file.path })
        const registered = await businessService.registerEvidenceUpload({
          businessLineId: this.data.lineId,
          nodeId: this.data.nodeId,
          fileId: upload.fileID,
          fileName: file.name,
          declaredSize: file.size
        })
        this.updateLocalFile(index, {
          status: 'registered', statusLabel: '已登记', evidenceId: registered.evidenceId, errorMessage: ''
        })
      } catch (error) {
        this.updateLocalFile(index, {
          status: 'failed', statusLabel: '上传失败', errorMessage: error.message || '上传失败'
        })
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
    this.setData({ submitting: true })
    try {
      const evidenceIds = await this.uploadAndRegisterEvidence()
      await businessService.submitFeedback({
        businessLineId: this.data.lineId,
        nodeId: this.data.nodeId,
        expectedNodeVersion: this.data.expectedNodeVersion,
        status,
        fieldValues,
        comment: this.data.comment.trim(),
        evidenceIds,
        requestKey: this.feedbackRequestKey
      })
      if (!this.actorStillCurrent()) return
      wx.showToast({ title: '反馈成功', icon: 'success' })
      this.feedbackRequestKey = ''
      this.setData({ comment: '', files: [], selectedTotalBytes: 0, selectedTotalText: '0 B' })
      await this.loadData()
    } catch (error) {
      wx.showToast({ title: error.message || '反馈失败，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
