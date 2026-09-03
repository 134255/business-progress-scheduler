const ACTIVATION_MODE = Object.freeze({
  REQUIRED: 'required',
  OPTIONAL_TAIL: 'optional_tail'
})
const ROUTE_STATE = Object.freeze({
  DORMANT: 'dormant',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  AWAITING_MANUAL_DECISION: 'awaiting_manual_decision'
})
const ACTUAL_ROUTE_STATES = new Set([
  ROUTE_STATE.ACTIVE,
  ROUTE_STATE.COMPLETED,
  ROUTE_STATE.AWAITING_MANUAL_DECISION
])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function hasDescriptorInPrototype(object, key) {
  let current = Object.getPrototypeOf(object)
  while (current) {
    if (Object.getOwnPropertyDescriptor(current, key)) return true
    current = Object.getPrototypeOf(current)
  }
  return false
}

function normalizeActivationMode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw createError('TEMPLATE_INVALID')
  const descriptor = Object.getOwnPropertyDescriptor(node, 'activationMode')
  if (!descriptor) {
    if (hasDescriptorInPrototype(node, 'activationMode')) throw createError('TEMPLATE_INVALID')
    return ACTIVATION_MODE.REQUIRED
  }
  if (!hasOwn(descriptor, 'value')) throw createError('TEMPLATE_INVALID')
  if (![ACTIVATION_MODE.REQUIRED, ACTIVATION_MODE.OPTIONAL_TAIL].includes(descriptor.value)) {
    throw createError('TEMPLATE_INVALID')
  }
  return descriptor.value
}

function classifyCompletedNodeTransition({ line, node, nextNode }) {
  if (!line || !Number.isSafeInteger(line.nodeCount) || line.nodeCount < 1 ||
      !node || !Number.isSafeInteger(node.sequence) || node.sequence < 0) {
    throw createError('BUSINESS_STATE_INVALID')
  }
  if (node.sequence + 1 >= line.nodeCount) return 'complete_line'
  if (!nextNode || typeof nextNode !== 'object') throw createError('BUSINESS_STATE_INVALID')
  return nextNode.activationMode === ACTIVATION_MODE.OPTIONAL_TAIL
    ? 'await_optional_decision'
    : 'next_node'
}

function isActualRouteState(value) {
  return ACTUAL_ROUTE_STATES.has(value)
}

module.exports = {
  ACTIVATION_MODE,
  ROUTE_STATE,
  isActualRouteState,
  normalizeActivationMode,
  classifyCompletedNodeTransition
}
