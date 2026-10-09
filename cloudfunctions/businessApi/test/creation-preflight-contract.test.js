const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createBusinessService } = require('../lib/business-service')
const { version2TemplateDefinitionDigest } = require('../lib/template-domain')

function setup() {
  const nodes = [0, 1].map(i => ({
    _id: `source-${i}`, templateId: 'template', nodeKey: `node-${i}`, sequence: i,
    name: `Node ${i}`, workflowMode: 'review', activationMode: 'required',
    processorAssignmentMode: 'fixed_accounts', processorUserIds: ['processor'],
    reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: ['reviewer'], reviewMode: 'any',
    processingSlaWorkHours: 8, reviewSlaWorkHours: 4, requiresEvidence: false,
    allowedEvidenceTypes: [], fields: i ? [] : [{
      fieldKey: 'serial', sequence: 0, name: 'Serial', type: 'short_text',
      required: false, constraints: {}, scanEnabled: true
    }],
    next: i ? { mode: 'end' } : { mode: 'default', targetNodeKey: 'node-1' }
  }))
  const template = { _id: 'template', name: 'Synthetic template', status: 'enabled', version: 1,
    nodeCount: 2, flowSchemaVersion: 2, entryNodeKey: 'node-0',
    definitionNodeIds: nodes.map(node => node._id),
    definitionDigest: version2TemplateDefinitionDigest({ flowSchemaVersion: 2, entryNodeKey: 'node-0', nodes }) }
  const actor = { _id: 'creator', status: 'active', role: 'user' }
  const fake = createFakeCloudDatabase({ templates: [template], template_nodes: nodes,
    users: [actor, ...['processor', 'reviewer'].map(_id => ({ _id, status: 'active', displayName: _id }))] })
  const clock = () => new Date('2026-10-09T02:00:00Z')
  const dueCalls = []
  let onDue = () => {}
  const workTimeService = { async tryAddWorkMinutes(start, minutes) {
    dueCalls.push({ start, minutes })
    onDue()
    return { status: 'calculated', dueAt: new Date(start.getTime() + minutes * 60000), calendarVersion: 'synthetic' }
  } }
  const repository = createCloudBusinessRepository({ db: fake.db, clock, workTimeService })
  const service = createBusinessService({ repository, clock, workTimeService })
  return { fake, dueCalls, nodes, setDueHook(hook) { onDue = hook }, create() {
    return service.createFromTemplate({ actor, input: { templateId: 'template', requestKey: 'contract', description: '' } })
  } }
}

function corruptField(h) {
  const node = structuredClone(h.nodes[0])
  node.fields[0].type = 'unsupported'
  h.fake.replace('template_nodes', node._id, node)
}

function assertNoCreation(h) {
  for (const name of ['business_lines', 'business_nodes', 'sequence_counters', 'audit_logs']) {
    assert.equal(h.fake.documents(name).length, 0, name)
  }
}

test('approved light preflight calculates provisional due then rejects corrupt body before writes', async () => {
  const h = setup()
  corruptField(h)
  await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
  assert.equal(h.dueCalls.length, 1)
  assert.equal(h.fake.transactionRuns.length, 1)
  assertNoCreation(h)
})

test('unchanged head with body corruption after preflight is invalid with no partial writes', async () => {
  const h = setup()
  h.setDueHook(() => corruptField(h))
  await assert.rejects(h.create(), { code: 'TEMPLATE_INVALID' })
  assert.equal(h.dueCalls.length, 1)
  assert.equal(h.dueCalls[0].minutes, 480)
  assert.equal(h.dueCalls[0].start.toISOString(), '2026-10-09T02:00:00.000Z')
  assertNoCreation(h)
})

test('approved light preflight permits calendar failure to precede corrupt-body validation', async () => {
  const h = setup()
  corruptField(h)
  h.setDueHook(() => { throw new Error('synthetic calendar failure') })
  await assert.rejects(h.create(), /synthetic calendar failure/)
  assert.equal(h.dueCalls.length, 1)
  assert.equal(h.fake.transactionRuns.length, 0)
  assertNoCreation(h)
})
