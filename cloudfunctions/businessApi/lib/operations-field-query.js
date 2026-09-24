const { normalizeAnalyticsQuery } = require('./operations-domain')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const KEYS = new Set(['startDate', 'endDate', 'grain', 'templateId', 'templateVersion', 'status',
  'businessLineId', 'stableNodeId', 'processorToken', 'reviewerToken', 'cursor', 'pageSize'])
function fieldError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}
function normalizeFieldQuery(query = {}, now) {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(query))) throw fieldError('VALIDATION_ERROR')
  const input = {}
  for (const key of Reflect.ownKeys(query)) {
    const descriptor = Object.getOwnPropertyDescriptor(query, key)
    if (!KEYS.has(key) || !Object.hasOwn(descriptor, 'value')) throw fieldError('VALIDATION_ERROR')
    input[key] = descriptor.value
  }
  const cursor = input.cursor === undefined ? '' : input.cursor
  const pageSize = input.pageSize === undefined ? 50 : input.pageSize
  if (typeof cursor !== 'string' || cursor.length > 2048 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw fieldError('VALIDATION_ERROR')
  }
  return { ...normalizeAnalyticsQuery({ ...input, cursor: '', pageSize: 20 }, now), cursor, pageSize }
}
module.exports={normalizeFieldQuery,fieldError}
