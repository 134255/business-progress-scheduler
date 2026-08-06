const businessService = require('../../services/business')

Page({
  data: {
    id: '',
    editMode: false,
    loading: false,
    saving: false,
    canEditNodes: true,
    form: {
      version: 1,
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

  onLoad(query) {
    if (!query.id) return
    this.setData({ id: query.id, editMode: true })
    wx.setNavigationBarTitle({ title: '编辑业务线' })
    this.loadBusinessLine()
  },

  async loadBusinessLine() {
    this.setData({ loading: true })
    try {
      const data = await businessService.getBusinessLine(this.data.id)
      if (!data.canManage) {
        wx.showToast({ title: '只有管理员可以编辑', icon: 'none' })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 500)
        return
      }
      this.setData({
        canEditNodes: data.canEditNodes,
        form: {
          version: data.line.version || 1,
          name: data.line.name || '',
          code: data.line.code || '',
          description: data.line.description || '',
          plannedStartDate: data.line.plannedStartDate || '',
          plannedEndDate: data.line.plannedEndDate || '',
          nodes: data.nodes.map(node => ({
            _id: node._id,
            name: node.name,
            requiresEvidence: Boolean(node.requiresEvidence),
            assigneeIds: node.assigneeIds || [],
            assigneeNames: node.assigneeNames || [],
            watcherIds: node.watcherIds || [],
            evidenceTypes: node.evidenceTypes || ['pdf', 'png', 'jpg', 'jpeg'],
            dueDate: node.dueDate || ''
          }))
        }
      })
    } finally {
      this.setData({ loading: false })
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
    if (!this.data.canEditNodes) return
    this.setData({ [`form.nodes[${this.data.form.nodes.length}]`]: { name: '', requiresEvidence: false } })
  },

  removeNode(event) {
    if (!this.data.canEditNodes) return
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
      if (this.data.editMode) {
        const result = await businessService.updateBusinessLine(Object.assign({}, form, {
          id: this.data.id,
          replaceNodes: this.data.canEditNodes,
          nodes: this.data.canEditNodes ? form.nodes : undefined
        }))
        this.setData({ 'form.version': result.version })
        wx.showToast({ title: '保存成功', icon: 'success' })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 500)
      } else {
        const result = await businessService.createBusinessLine(form)
        wx.showToast({ title: '创建成功', icon: 'success' })
        setTimeout(() => wx.redirectTo({ url: `/pages/business-detail/index?id=${result.id}` }), 500)
      }
    } finally {
      this.setData({ saving: false })
    }
  }
})
