const test = require('node:test')
const assert = require('node:assert/strict')
let createOperationsFieldService
try { ({ createOperationsFieldService } = require('../lib/operations-field-service')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

const admin = { _id: 'root', role: 'super_admin', status: 'active' }
const user = { _id: 'staff', role: 'user', status: 'active' }
function harness() {
  assert.equal(typeof createOperationsFieldService, 'function', 'field service must enforce the new protected contract')
  const reads = []
  const repository = Object.fromEntries(['getSummary', 'getFilters', 'exportReportRows'].map(method => [method, async input => { reads.push({ method, ...input }); return { scope: 'authorized', groups: [] } }]))
  return { reads, service: createOperationsFieldService({ repository, clock: () => new Date('2026-09-11T00:00:00Z') }) }
}
test('field summary normalizes completion-day range and allows an active ordinary account', async () => {
  const { service, reads } = harness()
  await service.getSummary({ actor: user, query: { templateId: 'template-1', startDate: '2026-09-01', endDate: '2026-09-11' } })
  assert.equal(reads[0].range.startAt.toISOString(), '2026-08-31T16:00:00.000Z')
  assert.equal(reads[0].range.endAt.toISOString(), '2026-09-11T16:00:00.000Z')
})
test('field report prevents non-admin and disabled actors reaching data reads', async () => {
  const { service, reads } = harness()
  for (const actor of [user, { ...admin, status: 'disabled' }, null]) await assert.rejects(service.exportReportRows({ actor, query: {} }), { code: 'FORBIDDEN' })
  await assert.rejects(service.getSummary({ actor: { ...user, status: 'disabled' } }), { code: 'FORBIDDEN' })
  assert.equal(reads.length, 0)
})
test('field query rejects unknown keys, invalid dates and invalid report pagination before repository access', async () => {
  const { service, reads } = harness()
  for (const query of [{ secret: 'ignored?' }, { startDate: '2026-02-30' }, { pageSize: 51 }, { pageSize: 0 }, { cursor: 'x'.repeat(2049) }, { metric: 'node_processing' }]) {
    await assert.rejects(service.exportReportRows({ actor: admin, query }), { code: 'VALIDATION_ERROR' })
  }
  assert.equal(reads.length, 0)
  await service.exportReportRows({ actor: admin, query: { pageSize: 50, cursor: 'opaque' } })
  assert.equal(reads[0].range.pageSize, 50)
  assert.equal(reads[0].range.cursor, 'opaque')
})
