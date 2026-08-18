const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { normalizeOperationsQuery, normalizeTimingDetailsQuery } = require('./operations-domain')

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function createOperationsService({ repository, clock = () => new Date() }) {
  if (!repository) throw new TypeError('repository is required')
  function requireAdmin(actor) {
    if (!actor || actor.status !== 'active' || actor.role !== 'super_admin') throw createError('FORBIDDEN')
  }
  async function getDashboard({ actor, query = {} }) {
    requireAdmin(actor)
    return repository.getDashboard({ actor, range: normalizeOperationsQuery(query, clock()) })
  }
  async function exportRows({ actor, query = {} }) {
    requireAdmin(actor)
    return repository.exportRows({ actor, range: normalizeOperationsQuery(query, clock()) })
  }
  async function listTimingDetails({ actor, query = {} }) {
    requireAdmin(actor)
    return repository.listTimingDetails({ actor, range: normalizeTimingDetailsQuery(query, clock()) })
  }
  return { getDashboard, exportRows, listTimingDetails }
}

module.exports = { createOperationsService }
