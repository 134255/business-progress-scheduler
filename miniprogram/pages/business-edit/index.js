const businessService = require('../../services/business')

Page({
  data: {
    saving: false,
    form: {
      name: '',
      code: '',
      description: '',
      plannedStartDate: '',
      plannedEndDate: '',
      nodes: [
        { name: '资料准备', requiresEvidence: true },
        { name: '业务审核', requiresEvidence: true },
        { name: '办结归档', requiresEvidence: false }
      ]
    }
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  updateDate(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  updateNodeName(event) {
    const index = event.currentTarget.dataset.index
    this.setData({ [`form.nodes[${index}].name`]: event.detail.value })
  },

  toggleEvidence(event) {
    const index = event.currentTarget.dataset.index
    this.setData({ [`form.nodes[${index}].requiresEvidence`]: event.detail.value })
  },

  addNode() {
    this.setData({ [`form.nodes[${this.data.form.nodes.length}]`]: { name: '', requiresEvidence: false } })
  },

  removeNode(event) {
    if (this.data.form.nodes.length <= 1) {
      wx.showToast({ title: '至少保留一个节点', icon: 'none' })
      return
    }
    const nodes = this.data.form.nodes.slice()
    nodes.splice(event.currentTarget.dataset.index, 1)
    this.setData({ 'form.nodes': nodes })
  },

  async save() {
    const form = this.data.form
    if (!form.name.trim() || !form.code.trim()) {
      wx.showToast({ title: '请填写名称和编号', icon: 'none' })
      return
    }
    if (form.nodes.some(node => !node.name.trim())) {
      wx.showToast({ title: '节点名称不能为空', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      const result = await businessService.createBusinessLine(form)
      wx.showToast({ title: '创建成功', icon: 'success' })
      setTimeout(() => wx.redirectTo({ url: `/pages/business-detail/index?id=${result.id}` }), 500)
    } finally {
      this.setData({ saving: false })
    }
  }
})

