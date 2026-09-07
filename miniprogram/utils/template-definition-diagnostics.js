// Editor-side guidance only. The cloud domain remains the authoritative validator.
function title(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function conditionIssue(field, fields, index) {
  const condition = field.condition
  if (!condition) return ''
  const parent = fields.slice(0, index).find(item => item.fieldKey === condition.parentFieldKey)
  const parentOptions = parent && parent.type === 'single_select' && parent.constraints && parent.constraints.options
  if (!Array.isArray(parentOptions)) return '请选择当前节点中前置的单选字段作为父字段'
  const visible = condition.visibleWhen
  if (!Array.isArray(visible) || !visible.length) return '请至少选择一个有效的父选项作为显示条件'
  const stale = visible.find(value => !parentOptions.includes(value))
  if (stale !== undefined) return `父选项“${stale}”已失效，请打开节点重新确认联动`
  if (new Set(visible).size !== visible.length) return '显示条件中的父选项重复'
  if (condition.optionsByParentValue === undefined) return ''
  const mapping = condition.optionsByParentValue
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || field.type !== 'single_select') {
    return '候选项联动仅适用于单选字段，请重新配置'
  }
  const staleKey = Object.keys(mapping).find(key => !visible.includes(key))
  if (staleKey !== undefined) return `父选项“${staleKey}”的候选配置已失效，请打开节点重新确认联动`
  const options = field.constraints && field.constraints.options
  for (const value of visible) {
    const choices = Object.prototype.hasOwnProperty.call(mapping, value) ? mapping[value] : null
    if (!Array.isArray(choices) || !choices.length) return `父选项“${value}”的候选项不能为空`
    if (!Array.isArray(options)) return '请先填写本字段的基础选项'
    const unknown = choices.find(choice => !options.includes(choice))
    if (unknown !== undefined) return `父选项“${value}”包含未知候选“${unknown}”`
    if (new Set(choices).size !== choices.length) return `父选项“${value}”的候选项重复`
  }
  return ''
}

function templateDefinitionIssue(definition) {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : []
  const nodeKeys = new Map()
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]
    const nodeName = title(node.name, `第 ${nodeIndex + 1} 节点`)
    if (node.nodeKey && nodeKeys.has(node.nodeKey)) {
      return `节点“${nodeKeys.get(node.nodeKey)}”与“${nodeName}”内部编号重复，请重新添加冲突节点`
    }
    if (node.nodeKey) nodeKeys.set(node.nodeKey, nodeName)
    const fields = Array.isArray(node.fields) ? node.fields : []
    const keys = new Map()
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]
      const name = title(field.name, `第 ${index + 1} 字段`)
      if (field.fieldKey && keys.has(field.fieldKey)) {
        return `节点“${nodeName}”：字段“${keys.get(field.fieldKey)}”与“${name}”内部编号重复，请重新添加冲突字段并核对联动`
      }
      if (field.fieldKey) keys.set(field.fieldKey, name)
    }
    for (let index = 0; index < fields.length; index += 1) {
      const issue = conditionIssue(fields[index], fields, index)
      if (issue) return `节点“${nodeName}” / 字段“${title(fields[index].name, `第 ${index + 1} 字段`)}”：${issue}`
    }
  }
  return ''
}

module.exports = { templateDefinitionIssue }
