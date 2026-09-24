const { normalizeFieldQuery, fieldError } = require('./operations-field-query')
const { normalizeAnalysisQuery, normalizeFieldReportQuery } = require('./operations-field-analysis-query')
const SAFE_ERRORS = new Set(['FORBIDDEN', 'VALIDATION_ERROR', 'RANGE_TOO_LARGE', 'FIELD_SOURCE_INVALID',
  'INCOMPLETE_FIELD_DATA', 'REPORT_CHANGED', 'REPORT_EXPIRED', 'REPORT_CONFIGURATION_ERROR'])

function createOperationsFieldService({ repository, clock = () => new Date() }) {
  if (!repository) throw new TypeError('repository is required')
  async function invoke(method, { actor, query = {} }) {
    if (!actor || actor.status !== 'active' || typeof actor._id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor._id) ||
        !['user', 'super_admin'].includes(actor.role) || method === 'exportReportRows' && actor.role !== 'super_admin') {
      throw fieldError('FORBIDDEN')
    }
    const normalize = method === 'getAnalysis' ? normalizeAnalysisQuery :
      method === 'exportReportRows' ? normalizeFieldReportQuery : normalizeFieldQuery
    const range = normalize(query, clock())
    try { return await repository[method]({ actor, range }) } catch (error) {
      if (SAFE_ERRORS.has(error && error.code)) throw fieldError(error.code)
      throw error
    }
  }
  return {
    getSummary: input => invoke('getSummary', input),
    getFilters: input => invoke('getFilters', input),
    getAnalysis: input => invoke('getAnalysis', input),
    exportReportRows: input => invoke('exportReportRows', input),
    // Internal post-success hook, deliberately not exposed as a public route.
    refreshAfterMutation: input => repository.refreshAfterMutation(input)
  }
}
module.exports = { createOperationsFieldService, normalizeFieldQuery, fieldError }
