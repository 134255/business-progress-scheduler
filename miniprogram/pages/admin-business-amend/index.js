const businessService = require('../../services/business')

const MEBIBYTE = 1024 * 1024
const TOTAL_LIMIT = 20 * MEBIBYTE
const STATUS_OPTIONS = Object.freeze([
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'closed', label: '已关闭' },
  { value: 'deleted', label: '已删除' }
])

function activeSuperAdmin() {
  const user = getApp().globalData.currentUser
  return user && user.status === 'active' && user.role === 'super_admin' ? user : null
}

function extensionOf(value) {
  const clean = String(value || '').split(/[?#]/)[0]
  return clean.includes('.') ? clean.split('.').pop().toLowerCase() : ''
}

function categoryOf(extension, mediaType) {
  if (mediaType === 'image' || ['jpg', 'jpeg', 'png'].includes(extension)) return 'image'
  if (mediaType === 'video' || ['mp4', 'mov', 'm4v'].includes(extension)) return 'video'
  return extension === 'pdf' ? 'pdf' : ''
}

function formatBytes(value) {
  return value >= MEBIBYTE ? `${(value / MEBIBYTE).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`
}

function dateValue(value) {
  return typeof value === 'string' ? value : ''
}

Page({
  data: {
    keyword: '',
    items: [],
    total: 0,
    searching: false,
    selectedId: '',
    line: null,
    nodes: [],
    amendments: [],
    form: { name: '', description: '', plannedStartDate: '', plannedEndDate: '', status: 'completed' },
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    reason: '',
    files: [],
    totalBytes: 0,
    totalBytesText: '0 KB',
    loading: false,
    submitting: false,
    errorMessage: ''
  },

  async onLoad(query = {}) {
    const actor = activeSuperAdmin()
    if (!actor) {
      wx.reLaunch({ url: getApp().globalData.currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
      return
    }
    this.actorId = actor._id
    wx.setNavigationBarTitle({ title: '冻结业务审计式修订' })
    if (query.id) await this.loadBusiness(String(query.id))
    else await this.search()
  },

  actorStillCurrent() {
    const actor = activeSuperAdmin()
    if (actor && actor._id === this.actorId) return true
    wx.reLaunch({ url: '/pages/dashboard/index' })
    return false
  },

  onKeyword(event) {
    this.setData({ keyword: event.detail.value })
  },

  async search() {
    if (!this.actorStillCurrent()) return
    this.setData({ searching: true, errorMessage: '' })
    try {
      const result = await businessService.listFrozenBusinessesForAdmin({
        keyword: this.data.keyword.trim(), page: 1, pageSize: 20
      })
      if (!this.actorStillCurrent()) return
      this.setData({ items: result.items || [], total: Number(result.total || 0) })
    } catch (error) {
      if (this.actorStillCurrent()) this.setData({ errorMessage: error.message || '冻结业务检索失败' })
    } finally {
      this.setData({ searching: false })
    }
  },

  async selectBusiness(event) {
    return this.loadBusiness(String(event.currentTarget.dataset.id || ''))
  },

  async loadBusiness(id) {
    if (!id || !this.actorStillCurrent()) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const result = await businessService.getFrozenBusinessForAdmin(id)
      if (!this.actorStillCurrent()) return
      const line = result.line
      const form = {
        name: line.name || '',
        description: line.description || '',
        plannedStartDate: dateValue(line.plannedStartDate),
        plannedEndDate: dateValue(line.plannedEndDate),
        status: line.status
      }
      this.originalForm = { ...form }
      this.setData({
        selectedId: id,
        line,
        nodes: result.nodes || [],
        form,
        statusIndex: Math.max(0, STATUS_OPTIONS.findIndex(item => item.value === line.status)),
        amendments: (result.amendments || []).map(item => ({
          ...item,
          beforeText: JSON.stringify(item.before || {}, null, 2),
          afterText: JSON.stringify(item.after || {}, null, 2)
        }))
      })
    } catch (error) {
      if (this.actorStillCurrent()) this.setData({ errorMessage: error.message || '冻结业务加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onFormInput(event) {
    this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value })
  },

  onStatus(event) {
    const index = Number(event.detail.value)
    this.setData({ statusIndex: index, 'form.status': STATUS_OPTIONS[index].value })
  },

  onReason(event) {
    this.setData({ reason: event.detail.value })
  },

  addFiles(selected) {
    const files = this.data.files.slice()
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const source of selected) {
      const extension = extensionOf(source.name || source.path)
      const category = source.category || categoryOf(extension, source.mediaType)
      const limit = category === 'image' ? 5 * MEBIBYTE : 20 * MEBIBYTE
      if (!category || !Number.isFinite(source.size) || source.size < 1 || source.size > limit) {
        wx.showToast({ title: category === 'image' ? '图片不能超过 5 MB' : '文件格式无效或超过 20 MB', icon: 'none' })
        continue
      }
      if (total + source.size > TOTAL_LIMIT) {
        wx.showToast({ title: '修订附件合计不能超过 20 MB', icon: 'none' })
        continue
      }
      total += source.size
      files.push({
        localKey: `amend-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name: source.name,
        path: source.path,
        size: source.size,
        sizeText: formatBytes(source.size),
        extension,
        category,
        status: 'pending',
        evidenceId: ''
      })
    }
    this.setData({ files, totalBytes: total, totalBytesText: formatBytes(total) })
  },

  chooseMedia() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      success: result => this.addFiles((result.tempFiles || []).map((file, index) => {
        let name = (file.tempFilePath || '').split('/').pop() || `media-${index + 1}`
        if (!extensionOf(name)) name += file.fileType === 'image' ? '.jpg' : '.mp4'
        return {
          name,
          path: file.tempFilePath,
          size: Number(file.size),
          mediaType: file.fileType,
          category: file.fileType === 'image' ? 'image' : 'video'
        }
      }))
    })
  },

  choosePdf() {
    wx.chooseMessageFile({
      count: 100,
      type: 'file',
      extension: ['pdf'],
      success: result => this.addFiles((result.tempFiles || []).map((file, index) => ({
        name: file.name || `document-${index + 1}.pdf`, path: file.path, size: Number(file.size), category: 'pdf'
      })))
    })
  },

  removeFile(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (!this.data.files[index] || this.data.files[index].status === 'uploading') return
    const files = this.data.files.slice()
    files.splice(index, 1)
    const total = files.reduce((sum, file) => sum + file.size, 0)
    this.setData({ files, totalBytes: total, totalBytesText: formatBytes(total) })
  },

  async uploadFiles() {
    const files = this.data.files.slice()
    for (let index = 0; index < files.length; index += 1) {
      if (files[index].status === 'registered' && files[index].evidenceId) continue
      try {
        const file = files[index]
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_') || `amendment.${file.extension}`
        const upload = await wx.cloud.uploadFile({
          cloudPath: `amendment/${this.data.selectedId}/${Date.now()}-${index}-${safeName}`,
          filePath: file.path
        })
        const registered = await businessService.registerEvidenceUpload({
          businessLineId: this.data.selectedId,
          nodeId: null,
          purpose: 'audit_amendment',
          fileId: upload.fileID,
          fileName: file.name,
          declaredSize: file.size
        })
        files[index] = { ...file, status: 'registered', evidenceId: registered.evidenceId }
        this.setData({ files: files.slice() })
      } catch (error) {
        files[index] = { ...files[index], status: 'failed' }
        this.setData({ files: files.slice() })
        throw error
      }
    }
    return files.map(file => file.evidenceId)
  },

  changes() {
    const changes = {}
    for (const key of ['name', 'description', 'plannedStartDate', 'plannedEndDate', 'status']) {
      const value = typeof this.data.form[key] === 'string' ? this.data.form[key].trim() : this.data.form[key]
      if (value !== this.originalForm[key]) changes[key] = value
    }
    return changes
  },

  async submit() {
    if (!this.data.line || this.data.submitting) return
    const reason = this.data.reason.trim()
    if (!reason) {
      wx.showToast({ title: '请填写修订原因', icon: 'none' })
      return
    }
    const changes = this.changes()
    if (!Object.keys(changes).length && !this.data.files.length) {
      wx.showToast({ title: '请修改至少一个字段或添加附件', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const evidenceIds = await this.uploadFiles()
      await businessService.amendFrozenBusiness({
        businessLineId: this.data.selectedId,
        expectedVersion: this.data.line.version,
        reason,
        changes,
        evidenceIds
      })
      if (!this.actorStillCurrent()) return
      this.setData({ reason: '', files: [], totalBytes: 0, totalBytesText: '0 KB' })
      wx.showToast({ title: '审计式修订已保存', icon: 'success' })
      await this.loadBusiness(this.data.selectedId)
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') await this.loadBusiness(this.data.selectedId)
      wx.showToast({ title: error.code === 'VERSION_CONFLICT' ? '业务版本已变化，请核对后重试' : (error.message || '修订失败'), icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async previewEvidence(event) {
    const evidenceId = event.currentTarget.dataset.evidenceid
    const status = event.currentTarget.dataset.status
    if (!evidenceId || status !== 'available') return
    const grant = await businessService.getEvidenceAccess(evidenceId)
    if (grant.category === 'image') wx.previewImage({ current: grant.url, urls: [grant.url] })
    else if (grant.category === 'video') this.setData({ videoPreview: grant })
    else {
      const downloaded = await wx.downloadFile({ url: grant.url })
      await wx.openDocument({ filePath: downloaded.tempFilePath, fileType: 'pdf', showMenu: true })
    }
  }
})
