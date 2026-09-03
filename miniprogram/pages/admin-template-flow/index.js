const templates = require('../../services/templates')

function decode(value) {
  if (typeof value !== 'string') return ''
  try { return decodeURIComponent(value) } catch (_) { return '' }
}

function targets(next) {
  if (!next || next.mode === 'end') return []
  if (next.mode === 'default') return [next.targetNodeKey]
  if (next.mode === 'single_select') return Object.values(next.optionTargets || {})
  if (next.mode === 'manual') return [next.activateTarget, next.skipTarget]
  return []
}

function graphDiagnostics(entryNodeKey, nodes) {
  const diagnostics = []
  const byKey = new Map(nodes.map(node => [node.nodeKey, node]))
  if (!byKey.has(entryNodeKey)) return ['入口节点不存在']
  for (const node of nodes) {
    for (const target of targets(node.next)) {
      if (target !== 'end' && !byKey.has(target)) diagnostics.push(`${node.name} 指向不存在的节点`)
    }
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(key) {
    if (key === 'end' || !byKey.has(key)) return
    if (visiting.has(key)) {
      diagnostics.push('流程存在循环')
      return
    }
    if (visited.has(key)) return
    visiting.add(key)
    for (const target of targets(byKey.get(key).next)) visit(target)
    visiting.delete(key)
    visited.add(key)
  }
  visit(entryNodeKey)
  if (visited.size !== byKey.size) diagnostics.push('流程存在不可达节点')
  return [...new Set(diagnostics)]
}

function routeLabel(next, names) {
  const name = key => key === 'end' ? '结束' : names.get(key) || '未知节点'
  if (!next || next.mode === 'end') return '完成后结束售后'
  if (next.mode === 'default') return `完成后进入：${name(next.targetNodeKey)}`
  if (next.mode === 'manual') {
    return `人工决定：开启 → ${name(next.activateTarget)}；跳过 → ${name(next.skipTarget)}`
  }
  if (next.mode === 'single_select') {
    return Object.entries(next.optionTargets || {}).map(([option, target]) => `${option} → ${name(target)}`).join('；')
  }
  return '后续规则无效'
}

Page({
  data: { loading: false, templateName: '', rows: [], diagnostics: [], errorMessage: '' },

  requireSuperAdmin() {
    const currentUser = getApp().globalData.currentUser
    if (currentUser && currentUser.role === 'super_admin' && currentUser.status === 'active') return true
    wx.reLaunch({ url: currentUser ? '/pages/dashboard/index' : '/pages/login/index' })
    return false
  },

  async onLoad(options = {}) {
    if (!this.requireSuperAdmin()) return
    const templateId = decode(options.id)
    if (!templateId) {
      this.setData({ errorMessage: '模板编号无效' })
      return
    }
    this.setData({ loading: true, errorMessage: '' })
    try {
      const definition = await templates.getTemplate(templateId)
      if (!this.requireSuperAdmin()) return
      const template = definition.template || {}
      const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
      const names = new Map(nodes.map(node => [node.nodeKey, node.name]))
      this.setData({
        templateName: template.name || '流程预览',
        rows: nodes.map((node, index) => ({
          nodeKey: node.nodeKey, name: node.name || `节点 ${index + 1}`,
          sequence: index + 1, isEntry: node.nodeKey === template.entryNodeKey,
          routeLabel: routeLabel(node.next, names)
        })),
        diagnostics: template.flowSchemaVersion === 2
          ? graphDiagnostics(template.entryNodeKey, nodes)
          : ['旧模板仅支持顺序流程预览']
      })
      wx.setNavigationBarTitle({ title: '流程预览' })
    } catch (_) {
      if (this.requireSuperAdmin()) this.setData({ errorMessage: '流程加载失败，请稍后重试' })
    } finally {
      if (this.requireSuperAdmin()) this.setData({ loading: false })
    }
  }
})

module.exports = { graphDiagnostics, routeLabel }
