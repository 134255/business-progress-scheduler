const businessService = require('../../services/business')

Page({
  data: {
    lineId: '',
    nodeId: '',
    nodeName: '',
    canFeedback: false,
    history: [],
    evidences: [],
    loadingHistory: true,
    statusOptions: [
      { value: 'in_progress', label: '处理中' },
      { value: 'blocked', label: '受阻' },
      { value: 'completed', label: '已完成' }
    ],
    statusIndex: 0,
    comment: '',
    files: [],
    submitting: false
  },

  onLoad(query) {
    this.setData({
      lineId: query.lineId,
      nodeId: query.nodeId,
      nodeName: decodeURIComponent(query.nodeName || ''),
      canFeedback: query.canFeedback === '1'
    })
    this.loadHistory()
  },

  async loadHistory() {
    this.setData({ loadingHistory: true })
    try {
      const data = await businessService.getNodeHistory(this.data.lineId, this.data.nodeId)
      this.setData({ history: data.history || [], evidences: data.evidences || [], canFeedback: data.canFeedback })
    } finally {
      this.setData({ loadingHistory: false })
    }
  },

  onStatus(event) {
    this.setData({ statusIndex: Number(event.detail.value) })
  },

  onComment(event) {
    this.setData({ comment: event.detail.value })
  },

  chooseEvidence() {
    wx.chooseMessageFile({
      count: 9 - this.data.files.length,
      type: 'file',
      extension: ['pdf', 'png', 'jpg', 'jpeg'],
      success: result => {
        const selected = (result.tempFiles || []).map(file => ({
          name: file.name,
          path: file.path,
          size: file.size,
          type: file.type || ''
        }))
        this.setData({ files: this.data.files.concat(selected) })
      }
    })
  },

  removeFile(event) {
    const files = this.data.files.slice()
    files.splice(event.currentTarget.dataset.index, 1)
    this.setData({ files })
  },

  async previewEvidence(event) {
    const fileId = event.currentTarget.dataset.fileid
    const fileName = event.currentTarget.dataset.filename || ''
    const extension = fileName.split('.').pop().toLowerCase()
    if (['png', 'jpg', 'jpeg'].includes(extension)) {
      wx.previewImage({ current: fileId, urls: [fileId] })
      return
    }
    wx.showLoading({ title: '打开文件中' })
    try {
      const result = await wx.cloud.downloadFile({ fileID: fileId })
      await wx.openDocument({ filePath: result.tempFilePath, fileType: extension === 'pdf' ? 'pdf' : undefined, showMenu: true })
    } finally {
      wx.hideLoading()
    }
  },

  async uploadFiles() {
    const uploaded = []
    for (const file of this.data.files) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const cloudPath = `evidence/${this.data.lineId}/${this.data.nodeId}/${Date.now()}-${safeName}`
      const result = await wx.cloud.uploadFile({ cloudPath, filePath: file.path })
      uploaded.push({ fileId: result.fileID, fileName: file.name, size: file.size, mimeType: file.type })
    }
    return uploaded
  },

  async submit() {
    const status = this.data.statusOptions[this.data.statusIndex].value
    if (!this.data.comment.trim() && status !== 'completed') {
      wx.showToast({ title: '请填写进度说明', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    try {
      const evidences = await this.uploadFiles()
      await businessService.submitNodeFeedback({
        businessLineId: this.data.lineId,
        nodeId: this.data.nodeId,
        status,
        comment: this.data.comment.trim(),
        evidences
      })
      wx.showToast({ title: '反馈成功', icon: 'success' })
      this.setData({ comment: '', files: [] })
      await this.loadHistory()
    } finally {
      this.setData({ submitting: false })
    }
  }
})
