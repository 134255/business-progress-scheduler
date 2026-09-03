const { normalizeConditionalFields } = require('./conditional-field-domain')

const FLOW_SCHEMA_VERSION = 2
const MAX_WORKFLOW_NODES = 48
const END_TARGET = 'end'
const NEXT_MODE = Object.freeze({
  END: 'end',
  DEFAULT: 'default',
  SINGLE_SELECT: 'single_select',
  MANUAL: 'manual'
})
const NEXT_KEYS = Object.freeze({
  end: new Set(['mode']),
  default: new Set(['mode', 'targetNodeKey']),
  single_select: new Set(['mode', 'fieldKey', 'optionTargets']),
  manual: new Set(['mode', 'activateTarget', 'skipTarget'])
})
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

function createError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isPlainOwnObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownDataObject(value, allowedKeys = null) {
  if (!isPlainOwnObject(value)) throw createError('TEMPLATE_INVALID')
  const result = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor' ||
        allowedKeys && !allowedKeys.has(key)) throw createError('TEMPLATE_INVALID')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !hasOwn(descriptor, 'value')) throw createError('TEMPLATE_INVALID')
    result[key] = descriptor.value
  }
  return result
}

function ownArrayValues(value, code = 'TEMPLATE_INVALID') {
  if (!Array.isArray(value)) throw createError(code)
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !hasOwn(descriptor, 'value')) throw createError(code)
    result.push(descriptor.value)
  }
  return result
}

function text(value) {
  if (typeof value !== 'string' || !value.trim()) throw createError('TEMPLATE_INVALID')
  return value.trim()
}

function target(value) {
  return text(value)
}

function readNodeProperty(node, key) {
  const descriptor = Object.getOwnPropertyDescriptor(node, key)
  if (!descriptor || !hasOwn(descriptor, 'value')) throw createError('TEMPLATE_INVALID')
  return descriptor.value
}

function normalizeNext(node, fields) {
  const input = ownDataObject(readNodeProperty(node, 'next'))
  const mode = input.mode
  if (!Object.values(NEXT_MODE).includes(mode)) throw createError('TEMPLATE_INVALID')
  const allowed = NEXT_KEYS[mode]
  if (Reflect.ownKeys(input).some(key => !allowed.has(key)) ||
      [...allowed].some(key => !hasOwn(input, key))) throw createError('TEMPLATE_INVALID')
  if (mode === NEXT_MODE.END) return { mode }
  if (mode === NEXT_MODE.DEFAULT) return { mode, targetNodeKey: target(input.targetNodeKey) }
  if (mode === NEXT_MODE.MANUAL) {
    return { mode, activateTarget: target(input.activateTarget), skipTarget: target(input.skipTarget) }
  }

  const fieldKey = text(input.fieldKey)
  const definition = fields.find(field => field.fieldKey === fieldKey)
  if (!definition || definition.type !== 'single_select' || definition.required !== true || definition.condition ||
      !definition.constraints || !Array.isArray(definition.constraints.options)) throw createError('TEMPLATE_INVALID')
  const sourceTargets = ownDataObject(input.optionTargets)
  const optionTargets = {}
  const options = definition.constraints.options
  if (Object.keys(sourceTargets).length !== options.length || Object.keys(sourceTargets).some(key => !options.includes(key))) {
    throw createError('TEMPLATE_INVALID')
  }
  for (const option of options) {
    if (!hasOwn(sourceTargets, option)) throw createError('TEMPLATE_INVALID')
    optionTargets[option] = target(sourceTargets[option])
  }
  return { mode, fieldKey, optionTargets }
}

function outgoingTargets(next) {
  if (next.mode === NEXT_MODE.END) return []
  if (next.mode === NEXT_MODE.DEFAULT) return [next.targetNodeKey]
  if (next.mode === NEXT_MODE.SINGLE_SELECT) return Object.values(next.optionTargets)
  return [next.activateTarget, next.skipTarget]
}

function normalizeWorkflowGraph(input) {
  const source = ownDataObject(input, new Set(['flowSchemaVersion', 'entryNodeKey', 'nodes']))
  if (source.flowSchemaVersion !== FLOW_SCHEMA_VERSION) throw createError('TEMPLATE_INVALID')
  const entryNodeKey = text(source.entryNodeKey)
  const nodeValues = ownArrayValues(source.nodes)
  if (!nodeValues.length || nodeValues.length > MAX_WORKFLOW_NODES) throw createError('TEMPLATE_INVALID')
  const nodes = nodeValues.map(rawNode => {
    const safeNode = ownDataObject(rawNode)
    const nodeKey = text(readNodeProperty(safeNode, 'nodeKey'))
    let fields
    try {
      fields = normalizeConditionalFields(readNodeProperty(safeNode, 'fields'))
    } catch (error) {
      throw createError('TEMPLATE_INVALID')
    }
    return { ...safeNode, nodeKey, fields, next: normalizeNext(safeNode, fields) }
  })
  if (new Set(nodes.map(node => node.nodeKey)).size !== nodes.length) throw createError('TEMPLATE_INVALID')
  const graph = { flowSchemaVersion: FLOW_SCHEMA_VERSION, entryNodeKey, nodes }
  validateWorkflowGraph(graph)
  return graph
}

function validateWorkflowGraph(graph) {
  if (!graph || graph.flowSchemaVersion !== FLOW_SCHEMA_VERSION || !Array.isArray(graph.nodes)) {
    throw createError('TEMPLATE_INVALID')
  }
  const nodesByKey = new Map(graph.nodes.map(node => [node.nodeKey, node]))
  if (!nodesByKey.has(graph.entryNodeKey) || nodesByKey.size !== graph.nodes.length) throw createError('TEMPLATE_INVALID')
  for (const node of graph.nodes) {
    for (const destination of outgoingTargets(node.next)) {
      if (destination !== END_TARGET && !nodesByKey.has(destination)) throw createError('TEMPLATE_INVALID')
    }
  }

  const visiting = new Set()
  const visited = new Set()
  function visit(nodeKey) {
    if (visiting.has(nodeKey)) throw createError('TEMPLATE_INVALID')
    if (visited.has(nodeKey)) return
    visiting.add(nodeKey)
    const node = nodesByKey.get(nodeKey)
    for (const destination of outgoingTargets(node.next)) if (destination !== END_TARGET) visit(destination)
    visiting.delete(nodeKey)
    visited.add(nodeKey)
  }
  visit(graph.entryNodeKey)
  if (visited.size !== graph.nodes.length) throw createError('TEMPLATE_INVALID')
  return true
}

function normalizeFinalValues(fieldValues) {
  const byKey = new Map()
  for (const raw of ownArrayValues(fieldValues, 'BUSINESS_STATE_INVALID')) {
    let item
    try {
      item = ownDataObject(raw, new Set(['fieldKey', 'name', 'type', 'value']))
    } catch (error) {
      throw createError('BUSINESS_STATE_INVALID')
    }
    if (typeof item.fieldKey !== 'string' || !item.fieldKey || !hasOwn(item, 'value') || byKey.has(item.fieldKey)) {
      throw createError('BUSINESS_STATE_INVALID')
    }
    byKey.set(item.fieldKey, item.value)
  }
  return byKey
}

function snapshotTarget(value, { allowEnd = true } = {}) {
  if (allowEnd && value === END_TARGET) return value
  if (value === END_TARGET || typeof value !== 'string' || !DOCUMENT_ID.test(value)) {
    throw createError('BUSINESS_STATE_INVALID')
  }
  return value
}

function normalizeSnapshotNext(node, fields) {
  let input
  try {
    input = ownDataObject(readNodeProperty(node, 'next'))
  } catch (error) {
    throw createError('BUSINESS_STATE_INVALID')
  }
  const mode = input.mode
  if (mode === NEXT_MODE.END && Reflect.ownKeys(input).length === 1) return { mode }
  if (mode === NEXT_MODE.DEFAULT && Reflect.ownKeys(input).length === 2 && hasOwn(input, 'targetNodeId')) {
    return { mode, targetNodeId: snapshotTarget(input.targetNodeId, { allowEnd: false }) }
  }
  if (mode === NEXT_MODE.MANUAL && Reflect.ownKeys(input).length === 3 &&
      hasOwn(input, 'activateTargetNodeId') && hasOwn(input, 'skipTargetNodeId')) {
    return {
      mode,
      activateTargetNodeId: snapshotTarget(input.activateTargetNodeId),
      skipTargetNodeId: snapshotTarget(input.skipTargetNodeId)
    }
  }
  if (mode !== NEXT_MODE.SINGLE_SELECT || Reflect.ownKeys(input).length !== 3 ||
      !hasOwn(input, 'fieldKey') || !hasOwn(input, 'optionTargets')) {
    throw createError('BUSINESS_STATE_INVALID')
  }
  const definition = fields.find(field => field.fieldKey === input.fieldKey)
  if (!definition || definition.type !== 'single_select' || definition.required !== true ||
      definition.condition || !definition.constraints || !Array.isArray(definition.constraints.options)) {
    throw createError('BUSINESS_STATE_INVALID')
  }
  let sourceTargets
  try {
    sourceTargets = ownDataObject(input.optionTargets)
  } catch (error) {
    throw createError('BUSINESS_STATE_INVALID')
  }
  const options = definition.constraints.options
  if (Object.keys(sourceTargets).length !== options.length ||
      options.some(option => !hasOwn(sourceTargets, option))) throw createError('BUSINESS_STATE_INVALID')
  const optionTargets = {}
  for (const option of options) optionTargets[option] = snapshotTarget(sourceTargets[option])
  return { mode, fieldKey: input.fieldKey, optionTargets }
}

function resolveCompletedNodeTarget({ node, fieldValues }) {
  if (!isPlainOwnObject(node)) throw createError('BUSINESS_STATE_INVALID')
  const snapshotFields = Object.getOwnPropertyDescriptor(node, 'fieldDefinitions')
  if (snapshotFields) {
    if (!hasOwn(snapshotFields, 'value')) throw createError('BUSINESS_STATE_INVALID')
    let fields
    try {
      fields = normalizeConditionalFields(snapshotFields.value)
    } catch (error) {
      throw createError('BUSINESS_STATE_INVALID')
    }
    const next = normalizeSnapshotNext(node, fields)
    if (next.mode === NEXT_MODE.END) return { kind: 'end' }
    if (next.mode === NEXT_MODE.DEFAULT) return { kind: 'node', nodeId: next.targetNodeId }
    if (next.mode === NEXT_MODE.MANUAL) return { kind: 'manual' }
    const value = normalizeFinalValues(fieldValues).get(next.fieldKey)
    if (typeof value !== 'string' || !hasOwn(next.optionTargets, value)) {
      throw createError('BUSINESS_STATE_INVALID')
    }
    const destination = next.optionTargets[value]
    return destination === END_TARGET ? { kind: 'end' } : { kind: 'node', nodeId: destination }
  }
  let fields
  let next
  try {
    fields = normalizeConditionalFields(readNodeProperty(node, 'fields'))
    next = normalizeNext(node, fields)
  } catch (error) {
    throw createError('BUSINESS_STATE_INVALID')
  }
  if (next.mode === NEXT_MODE.END) return { kind: 'end' }
  if (next.mode === NEXT_MODE.DEFAULT) return { kind: 'node', nodeKey: next.targetNodeKey }
  if (next.mode === NEXT_MODE.MANUAL) return { kind: 'manual' }
  const value = normalizeFinalValues(fieldValues).get(next.fieldKey)
  if (typeof value !== 'string' || !hasOwn(next.optionTargets, value)) throw createError('BUSINESS_STATE_INVALID')
  const destination = next.optionTargets[value]
  return destination === END_TARGET ? { kind: 'end' } : { kind: 'node', nodeKey: destination }
}

module.exports = {
  FLOW_SCHEMA_VERSION,
  MAX_WORKFLOW_NODES,
  END_TARGET,
  NEXT_MODE,
  normalizeWorkflowGraph,
  validateWorkflowGraph,
  resolveCompletedNodeTarget
}
