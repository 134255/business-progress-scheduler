const {
  normalizeDefinitionNodes, normalizeVersion2TemplateDefinition,
  templateDefinitionDigest, version2TemplateDefinitionDigest
} = require('./template-domain')
const { readCardDisplay, normalizeCardDisplayFields } = require('./business-card-display')

// Copy only normalized definition data, never source lifecycle/history metadata.
function copyTemplateDefinition(source, keyFactory) {
  const version2 = source.template.flowSchemaVersion === 2
  const normalized = version2
    ? normalizeVersion2TemplateDefinition({ flowSchemaVersion: 2,
      entryNodeKey: source.template.entryNodeKey, nodes: source.nodes })
    : { nodes: source.nodes.length ? normalizeDefinitionNodes(source.nodes).nodes : [] }
  const display = normalizeCardDisplayFields(readCardDisplay(source.template).fields, normalized.nodes)
  const nodes = JSON.parse(JSON.stringify(normalized.nodes))
  const occupied = new Set(['end', ...nodes.flatMap(n => [n.nodeKey, ...n.fields.map(f => f.fieldKey)])])
  function newKey(prefix) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const key = keyFactory(prefix)
      if (typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key) && !occupied.has(key)) {
        occupied.add(key)
        return key
      }
    }
    const error = new Error('TEMPLATE_INVALID')
    error.code = 'TEMPLATE_INVALID'
    throw error
  }
  const nodeKeys = new Map(nodes.map(n => [n.nodeKey, newKey('node')]))
  const fieldKeys = new Map(nodes.map(n => [n.nodeKey,
    new Map(n.fields.map(f => [f.fieldKey, newKey('field')]))]))
  const target = key => key === 'end' ? 'end' : nodeKeys.get(key)
  for (const node of nodes) {
    const fields = fieldKeys.get(node.nodeKey)
    for (const field of node.fields) {
      field.fieldKey = fields.get(field.fieldKey)
      if (field.condition) field.condition.parentFieldKey = fields.get(field.condition.parentFieldKey)
      if (field.optionLinkage) field.optionLinkage.fieldKeys = field.optionLinkage.fieldKeys.map(key => fields.get(key))
    }
    if (version2) {
      const next = node.next
      if (next.mode === 'default') next.targetNodeKey = target(next.targetNodeKey)
      if (next.mode === 'manual') {
        next.activateTarget = target(next.activateTarget)
        next.skipTarget = target(next.skipTarget)
      }
      if (next.mode === 'single_select') {
        next.fieldKey = fields.get(next.fieldKey)
        next.optionTargets = Object.fromEntries(Object.entries(next.optionTargets).map(([option, key]) => [option, target(key)]))
      }
    }
    node.nodeKey = nodeKeys.get(node.nodeKey)
  }
  const graph = version2 ? { flowSchemaVersion: 2, entryNodeKey: nodeKeys.get(normalized.entryNodeKey), nodes } : null
  return {
    template: {
      ...(version2 ? { flowSchemaVersion: 2, entryNodeKey: graph.entryNodeKey } : {}),
      cardDisplay: { schemaVersion: 1, revision: display.length ? 1 : 0,
        fields: display.map(f => ({ nodeKey: nodeKeys.get(f.nodeKey), fieldKey: fieldKeys.get(f.nodeKey).get(f.fieldKey) })) },
      definitionDigest: version2 ? version2TemplateDefinitionDigest(graph) : templateDefinitionDigest(nodes)
    },
    nodes
  }
}

module.exports = { copyTemplateDefinition }
