const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createCloudManualRouteRepository } = require('../lib/cloud-manual-route-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const AT = new Date('2026-09-03T02:00:00.000Z')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')

function seed(skipTargetNodeId = 'after-node') {
  return {
    users: [
      { _id: 'user-2', status: 'active' },
      { _id: 'skip-processor', status: 'active' },
      { _id: 'outsider', status: 'active' }
    ],
    business_lines: [{
      _id: 'line-1', code: 'BL-1', name: '分支售后', status: 'active', flowSchemaVersion: 2,
      managerUserIds: ['outsider'], memberUserIds: ['user-2', 'skip-processor', 'outsider'],
      currentNodeId: 'source-node', currentNodeIndex: 0, currentNodeName: '人工判断',
      entryNodeId: 'source-node', traversedNodeIds: ['source-node'], routeDecisionVersion: 1,
      awaitingManualDecision: true, nodeCount: 3, progress: 33,
      version: 5, searchSourceVersion: 4, searchGeneratedVersion: 4, searchIndexStatus: 'generated'
    }],
    business_nodes: [{
      _id: 'source-node', businessLineId: 'line-1', nodeKey: 'source', nodeCode: 'BL-1-N001',
      sequence: 0, name: '人工判断', status: 'awaiting_decision', routeState: 'awaiting_manual_decision',
      next: { mode: 'manual', activateTargetNodeId: 'optional-node', skipTargetNodeId },
      processorUserIds: ['outsider'], reviewerUserIds: [], decisionStartedAt: new Date('2026-09-03T01:30:00.000Z'),
      version: 4, searchSourceVersion: 2, searchGeneratedVersion: 2, searchIndexStatus: 'generated'
    }, {
      _id: 'optional-node', businessLineId: 'line-1', nodeKey: 'optional', nodeCode: 'BL-1-N002',
      sequence: 1, name: '可选处理', status: 'waiting', routeState: 'dormant',
      processorUserIds: ['user-2'], reviewerUserIds: [], processingSlaWorkHours: 8,
      processingDueStatus: 'not_started', processingDueAt: null, version: 1
    }, {
      _id: 'after-node', businessLineId: 'line-1', nodeKey: 'after', nodeCode: 'BL-1-N003',
      sequence: 2, name: '后续处理', status: 'waiting', routeState: 'dormant',
      processorUserIds: ['skip-processor'], reviewerUserIds: [], processingSlaWorkHours: 4,
      processingDueStatus: 'not_started', processingDueAt: null, version: 1
    }],
    notifications: [], audit_logs: []
  }
}

function request(overrides = {}) {
  const actor = { _id: 'user-2', status: 'active' }
  const input = { businessLineId: 'line-1', nodeId: 'source-node', expectedLineVersion: 5,
    expectedNodeVersion: 4, decision: 'activate', comment: '', ...overrides }
  const requestKeyHash = hash(`${actor._id}\0${input.nodeId}\0route-001`)
  const inputHash = hash(JSON.stringify([actor._id, input.businessLineId, input.nodeId,
    input.expectedLineVersion, input.expectedNodeVersion, input.decision, input.comment]))
  return { actor, input, requestKeyHash, inputHash }
}

function timing(hours = 8) {
  return {
    decisionAt: AT, decisionTimingStatus: 'calculated', decisionWorkMinutes: 30,
    decisionCalendarVersion: 'calendar-v1', processingStartedAt: AT,
    processingDueStatus: 'calculated',
    processingDueAt: new Date(AT.getTime() + hours * 60 * 60 * 1000),
    processingCalendarVersion: 'calendar-v1'
  }
}

function harness(data = seed()) {
  const fake = createFakeCloudDatabase(data)
  return { fake, repository: createCloudManualRouteRepository({ db: fake.db }) }
}

test('activate target processor can activate exact target and exact retry is idempotent', async () => {
  const { fake, repository } = harness()
  const value = request()
  const context = await repository.inspectDecision(value)
  assert.equal(context.targetNodeId, 'optional-node')
  const result = await repository.commitDecision({ ...value, context, timing: timing() })
  assert.deepEqual(result, {
    decision: 'activate', lineStatus: 'active', currentNodeId: 'optional-node', nodeVersion: 5, lineVersion: 6
  })
  const line = fake.documents('business_lines')[0]
  const nodes = Object.fromEntries(fake.documents('business_nodes').map(node => [node._id, node]))
  assert.equal(line.currentNodeId, 'optional-node')
  assert.equal(line.awaitingManualDecision, false)
  assert.equal(line.routeDecisionVersion, 2)
  assert.equal(nodes['source-node'].routeState, 'completed')
  assert.equal(nodes['optional-node'].routeState, 'active')
  assert.equal(nodes['optional-node'].processingStartedAt.toISOString(), AT.toISOString())
  assert.equal(nodes['after-node'].routeState, 'dormant')
  assert.equal(fake.documents('notifications')[0].type, 'node_processing_started')
  assert.deepEqual((await repository.inspectDecision(value)).retryResult, result)
  assert.deepEqual(await repository.commitDecision({ ...value, context, timing: timing() }), result)
  assert.equal(fake.documents('audit_logs').length, 1)
})

test('skip marks activate target skipped and starts configured skip target', async () => {
  const { fake, repository } = harness()
  const value = request({ decision: 'skip', comment: '无需返修' })
  const context = await repository.inspectDecision(value)
  assert.equal(context.targetNodeId, 'after-node')
  const result = await repository.commitDecision({ ...value, context, timing: timing(4) })
  assert.equal(result.currentNodeId, 'after-node')
  const nodes = Object.fromEntries(fake.documents('business_nodes').map(node => [node._id, node]))
  assert.equal(nodes['optional-node'].routeState, 'skipped')
  assert.equal(nodes['after-node'].routeState, 'active')
  assert.equal(nodes['after-node'].processingStartedAt.toISOString(), AT.toISOString())
})

test('skip-to-end freezes line without starting a dormant node', async () => {
  const { fake, repository } = harness(seed('end'))
  const value = request({ decision: 'skip', comment: '结束流程' })
  const context = await repository.inspectDecision(value)
  assert.equal(context.targetNodeId, null)
  const decisionOnly = { decisionAt: AT, decisionTimingStatus: 'calculated', decisionWorkMinutes: 30,
    decisionCalendarVersion: 'calendar-v1' }
  const result = await repository.commitDecision({ ...value, context, timing: decisionOnly })
  assert.equal(result.lineStatus, 'completed')
  assert.equal(result.currentNodeId, 'source-node')
  const line = fake.documents('business_lines')[0]
  assert.equal(line.status, 'completed')
  assert.equal(line.progress, 100)
  assert.ok(line.purgeDueAt instanceof Date)
})

test('authorization always comes from activate target processors, not skip target or caller', async () => {
  const { repository } = harness()
  for (const actor of [{ _id: 'skip-processor', status: 'active' }, { _id: 'outsider', status: 'active' }]) {
    await assert.rejects(repository.inspectDecision({ ...request(), actor }), error => error.code === 'FORBIDDEN')
  }
})

test('first decision wins and changed retry input is rejected without duplicate effects', async () => {
  const { fake, repository } = harness()
  const first = request()
  const context = await repository.inspectDecision(first)
  await repository.commitDecision({ ...first, context, timing: timing() })
  await assert.rejects(
    repository.inspectDecision(request({ decision: 'skip', comment: 'late' })),
    error => error.code === 'VERSION_CONFLICT'
  )
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('notifications').length, 1)
})
