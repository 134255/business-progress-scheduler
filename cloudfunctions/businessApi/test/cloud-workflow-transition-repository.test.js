const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createCloudWorkflowTransitionRepository } = require('../lib/cloud-workflow-transition-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function seed(next = { mode: 'default', targetNodeId: 'node-target' }) {
  return {
    users: [
      { _id: 'actor-1', status: 'active', displayName: '当前人员' },
      { _id: 'target-processor', status: 'active', displayName: '后续处理人' }
    ],
    business_lines: [{
      _id: 'line-1', status: 'active', version: 4, flowSchemaVersion: 2,
      entryNodeId: 'node-current', currentNodeId: 'node-current', currentNodeIndex: 0,
      currentNodeName: '当前节点', traversedNodeIds: [], routeDecisionVersion: 0,
      managerUserIds: ['actor-1'], memberUserIds: ['actor-1', 'target-processor'],
      searchSourceVersion: 1, searchGeneratedVersion: 1, searchIndexStatus: 'generated'
    }],
    business_nodes: [
      {
        _id: 'node-current', businessLineId: 'line-1', nodeKey: 'current', sequence: 0,
        name: '当前节点', status: 'pending_review', routeState: 'active', version: 3,
        workflowMode: 'review', processorUserIds: ['actor-1'], reviewerUserIds: [],
        fieldDefinitions: [], next, searchSourceVersion: 1,
        searchGeneratedVersion: 1, searchIndexStatus: 'generated'
      },
      {
        _id: 'node-target', businessLineId: 'line-1', nodeKey: 'target', sequence: 1,
        name: '后续节点', status: 'waiting', routeState: 'dormant', version: 1,
        workflowMode: 'review', processorUserIds: ['target-processor'], reviewerUserIds: [],
        processingSlaWorkHours: 2, processingDueStatus: 'not_started', processingDueAt: null,
        fieldDefinitions: [], next: { mode: 'end' }
      }
    ],
    notifications: [],
    audit_logs: []
  }
}

function request(overrides = {}) {
  return {
    actor: { _id: 'actor-1', status: 'active' },
    input: {
      businessLineId: 'line-1', nodeId: 'node-current',
      expectedLineVersion: 4, expectedNodeVersion: 3, fieldValues: []
    },
    requestKeyHash: sha('request-1'), inputHash: sha('input-1'),
    ...overrides
  }
}

function timing() {
  return {
    processingStartedAt: new Date('2026-09-03T03:00:00.000Z'),
    processingDueStatus: 'calculated',
    processingDueAt: new Date('2026-09-03T05:00:00.000Z'),
    processingCalendarVersion: 'calendar-v2'
  }
}

function harness(initial = seed()) {
  const fake = createFakeCloudDatabase(initial)
  const repository = createCloudWorkflowTransitionRepository({
    db: fake.db, clock: () => new Date('2026-09-03T03:00:00.000Z')
  })
  return { fake, repository }
}

test('completion atomically marks the source and activates exactly one dormant target', async () => {
  const { fake, repository } = harness()
  const base = request()
  const context = await repository.inspectCompletion(base)
  const result = await repository.commitCompletion({
    ...base, context, transition: { kind: 'activate_node', targetNodeId: 'node-target' }, timing: timing()
  })

  assert.deepEqual(result, {
    nodeStatus: 'completed', lineStatus: 'active', currentNodeId: 'node-target',
    routeState: 'active', lineVersion: 5, nodeVersion: 4
  })
  const [line] = fake.documents('business_lines')
  const nodes = fake.documents('business_nodes')
  const current = nodes.find(node => node._id === 'node-current')
  const target = nodes.find(node => node._id === 'node-target')
  assert.deepEqual(line.traversedNodeIds, ['node-current'])
  assert.equal(line.routeDecisionVersion, 1)
  assert.equal(line.currentNodeId, 'node-target')
  assert.equal(current.status, 'completed')
  assert.equal(current.routeState, 'completed')
  assert.equal(target.status, 'ready')
  assert.equal(target.routeState, 'active')
  assert.equal(target.processingStartedAt.toISOString(), '2026-09-03T03:00:00.000Z')
  assert.equal(nodes.filter(node => node.routeState === 'active').length, 1)
  assert.equal(fake.documents('notifications').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
})

test('end completion freezes the line exactly and starts no dormant node clock', async () => {
  const { fake, repository } = harness(seed({ mode: 'end' }))
  const base = request()
  const context = await repository.inspectCompletion(base)
  const result = await repository.commitCompletion({
    ...base, context, transition: { kind: 'complete_line' }
  })

  assert.equal(result.lineStatus, 'completed')
  assert.equal(result.currentNodeId, 'node-current')
  const [line] = fake.documents('business_lines')
  const target = fake.documents('business_nodes').find(node => node._id === 'node-target')
  assert.equal(line.status, 'completed')
  assert.equal(line.progress, 100)
  assert.equal(line.completedAt.toISOString(), '2026-09-03T03:00:00.000Z')
  assert.equal(line.frozenAt.toISOString(), '2026-09-03T03:00:00.000Z')
  assert.equal(line.purgeDueAt.toISOString(), '2026-11-02T03:00:00.000Z')
  assert.equal(target.routeState, 'dormant')
  assert.equal(Object.hasOwn(target, 'processingStartedAt'), false)
})

test('manual completion waits without activating candidates and exact replay is idempotent', async () => {
  const next = {
    mode: 'manual', activateTargetNodeId: 'node-target', skipTargetNodeId: 'end'
  }
  const { fake, repository } = harness(seed(next))
  const base = request()
  const context = await repository.inspectCompletion(base)
  const commit = {
    ...base, context, transition: { kind: 'await_manual_decision' }
  }
  const first = await repository.commitCompletion(commit)
  const retry = await repository.commitCompletion(commit)

  assert.deepEqual(retry, first)
  const [line] = fake.documents('business_lines')
  const source = fake.documents('business_nodes').find(node => node._id === 'node-current')
  const target = fake.documents('business_nodes').find(node => node._id === 'node-target')
  assert.equal(line.awaitingManualDecision, true)
  assert.equal(line.currentNodeId, 'node-current')
  assert.equal(source.status, 'awaiting_decision')
  assert.equal(source.routeState, 'awaiting_manual_decision')
  assert.equal(target.routeState, 'dormant')
  assert.equal(Object.hasOwn(target, 'processingStartedAt'), false)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('notifications').length, 1)
  assert.deepEqual(fake.documents('notifications')[0].recipientUserIds, ['target-processor'])
})

test('commit rejects a changed target and leaves the whole transition untouched', async () => {
  const { fake, repository } = harness()
  const base = request()
  const context = await repository.inspectCompletion(base)
  fake.replace('business_nodes', 'node-target', {
    ...fake.documents('business_nodes').find(node => node._id === 'node-target'), version: 2
  })

  await assert.rejects(repository.commitCompletion({
    ...base, context, transition: { kind: 'activate_node', targetNodeId: 'node-target' }, timing: timing()
  }), error => error.code === 'VERSION_CONFLICT')
  const [line] = fake.documents('business_lines')
  const source = fake.documents('business_nodes').find(node => node._id === 'node-current')
  assert.equal(line.version, 4)
  assert.equal(line.currentNodeId, 'node-current')
  assert.equal(source.routeState, 'active')
  assert.equal(fake.documents('audit_logs').length, 0)
})
