const { normalizeAnalyticsQuery } = require('./operations-domain')
const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const KEYS = new Set(['startDate', 'endDate', 'grain', 'templateId', 'templateVersion', 'status',
  'businessLineId', 'stableNodeId', 'processorToken', 'reviewerToken', 'cursor', 'pageSize'])
const SAFE_ERRORS = new Set(['FORBIDDEN', 'VALIDATION_ERROR', 'RANGE_TOO_LARGE', 'FIELD_SOURCE_INVALID',
  'INCOMPLETE_FIELD_DATA', 'REPORT_CHANGED', 'REPORT_EXPIRED', 'REPORT_CONFIGURATION_ERROR'])

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

function createOperationsFieldService({ repository, clock = () => new Date() }) {
  if (!repository) throw new TypeError('repository is required')
  async function invoke(method, { actor, query = {} }) {
    if (!actor || actor.status !== 'active' || typeof actor._id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor._id) ||
        !['user', 'super_admin'].includes(actor.role) || method === 'exportReportRows' && actor.role !== 'super_admin') {
      throw fieldError('FORBIDDEN')
    }
    const range = normalizeFieldQuery(query, clock())
    try { return await repository[method]({ actor, range }) } catch (error) {
      if (SAFE_ERRORS.has(error && error.code)) throw fieldError(error.code)
      throw error
    }
  }
  return {
    getSummary: input => invoke('getSummary', input),
    getFilters: input => invoke('getFilters', input),
    exportReportRows: input => invoke('exportReportRows', input),
    // Internal post-success hook, deliberately not exposed as a public route.
    refreshAfterMutation: input => repository.refreshAfterMutation(input)
  }
}
module.exports = { createOperationsFieldService, normalizeFieldQuery, fieldError }
