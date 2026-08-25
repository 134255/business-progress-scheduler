const businessService = require('../../services/business')

function valueText(value) {
  if (Array.isArray(value)) return value.join('、')
  if (value === true) return '是'
  if (value === false) return '否'
  if (value === null || value === undefined || value === '') return '未填写'
  return String(value)
}

function dateText(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

Page({
  data: {
    loading: true,
    loadingMore: false,
    errorMessage: '',
    token: '',
    businessName: '',
    businessCode: '',
    nodeName: '',
    nodeCode: '',
    processingComment: '',
    completedAtText: '',
    expiresAtText: '',
    fields: [],
    evidences: [],
    nextCursor: '',
    hasMore: false
  },

  async onLoad(query = {}) {
    const token = typeof query.token === 'string' ? query.token : ''
    this.setData({ token })
    await this.loadPage('')
  },

  async loadPage(cursor) {
    if (!this.data.token) {
      this.setData({ loading: false, errorMessage: '分享链接无效' })
      return
    }
    try {
      const result = await businessService.getPublicNodeShare({ token: this.data.token, cursor, pageSize: 40 })
      const fields = (result.fieldDefinitions || []).map(item => ({
        fieldKey: item.fieldKey,
        name: item.name || item.fieldKey,
        value: valueText((result.fieldValues || {})[item.fieldKey])
      }))
      this.setData({
        businessName: result.businessName || this.data.businessName,
        businessCode: result.businessCode || this.data.businessCode,
        nodeName: result.nodeName || this.data.nodeName,
        nodeCode: result.nodeCode || this.data.nodeCode,
        processingComment: result.processingComment || this.data.processingComment,
        completedAtText: dateText(result.completedAt) || this.data.completedAtText,
        expiresAtText: dateText(result.expiresAt) || this.data.expiresAtText,
        fields: fields.length ? fields : this.data.fields,
        evidences: cursor ? this.data.evidences.concat(result.evidences || []) : (result.evidences || []),
        nextCursor: result.nextCursor || '',
        hasMore: result.hasMore === true,
        errorMessage: ''
      })
    } catch (_error) {
      this.setData({ errorMessage: '分享内容已失效或暂时无法查看' })
    } finally {
      this.setData({ loading: false, loadingMore: false })
    }
  },

  async loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return
    this.setData({ loadingMore: true })
    await this.loadPage(this.data.nextCursor)
  },

  openEvidence(event) {
    const evidence = this.data.evidences[Number(event.currentTarget.dataset.index)]
    if (!evidence || !/^https:\/\//.test(evidence.url || '')) return
    if (evidence.category === 'image') {
      wx.previewImage({ current: evidence.url, urls: [evidence.url] })
      return
    }
    if (evidence.category === 'video' && typeof wx.previewMedia === 'function') {
      wx.previewMedia({ sources: [{ url: evidence.url, type: 'video' }] })
      return
    }
    wx.downloadFile({
      url: evidence.url,
      success: result => wx.openDocument({
        filePath: result.tempFilePath,
        showMenu: false,
        fail: () => wx.showToast({ title: '凭证暂时无法打开', icon: 'none' })
      }),
      fail: () => wx.showToast({ title: '凭证暂时无法打开', icon: 'none' })
    })
  },

  onShareAppMessage() {
    return {
      title: `${this.data.businessName || '售后结果'}·${this.data.nodeName || '节点结果'}`,
      path: `/pages/public-node-share/index?token=${encodeURIComponent(this.data.token)}`
    }
  }
})
