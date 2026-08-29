const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createCloudOptionalTailRepository } = require('../lib/cloud-optional-tail-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const DECISION_AT = new Date('2026-08-29T02:00:00.000Z')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function seed(overrides = {}) {
  return {
    users: [
      { _id: 'user-2', status: 'active', displayName: '候选处理人' },
      { _id: 'user-9', status: 'active', displayName: '无关用户' }
    ],
    business_lines: [{
      _id: 'line-1', code: 'BL-20260829-0001', name: '可选节点售后', status: 'active',
      managerUserIds: ['user-9'], memberUserIds: ['user-2', 'user-9'],
      currentNodeId: 'node-2', currentNodeIndex: 1, currentNodeName: '追加回访',
      nodeCount: 2, progress: 50, optionalTailNodeId: 'node-2', optionalTailState: 'pending',
      version: 5, searchSourceVersion: 4, searchGeneratedVersion: 4, searchIndexStatus: 'generated'
    }],
    business_nodes: [{
      _id: 'node-2', businessLineId: 'line-1', nodeCode: 'BL-20260829-0001-N002',
      sequence: 1, name: '追加回访', status: 'awaiting_decision', activationMode: 'optional_tail',
      workflowMode: 'review', processorUserIds: ['user-2'], reviewerUserIds: [],
      processingSlaWorkHours: 8, reviewSlaWorkHours: 4, processingRoundNumber: 1,
      decisionStartedAt: new Date('2026-08-29T01:30:00.000Z'),
      nextDecisionReminderWorkHour: 1, version: 1,
      searchSourceVersion: 2, searchGeneratedVersion: 2, searchIndexStatus: 'generated'
    }],
    notifications: [],
    audit_logs: [],
    ...overrides
  }
}

function decision(overrides = {}) {
  const actor = { _id: 'user-2', status: 'active' }
  const input = {
    businessLineId: 'line-1', nodeId: 'node-2', expectedLineVersion: 5,
    expectedNodeVersion: 1, decision: 'activate', comment: '', ...overrides
  }
  const requestKeyHash = sha256(`${actor._id}\0${input.nodeId}\0request-001`)
  const inputHash = sha256(JSON.stringify([
    actor._id, input.businessLineId, input.nodeId, input.expectedLineVersion,
    input.expectedNodeVersion, input.decision, input.comment
  ]))
  return { actor, input, requestKeyHash, inputHash }
}

function activateTiming(overrides = {}) {
  return {
    decisionAt: DECISION_AT,
    decisionTimingStatus: 'calculated', decisionWorkMinutes: 30,
    decisionCalendarVersion: 'calendar-v1', processingStartedAt: DECISION_AT,
    processingDueStatus: 'calculated',
    processingDueAt: new Date('2026-08-29T10:00:00.000Z'),
    processingCalendarVersion: 'calendar-v1',
    ...overrides
  }
}

function harness(value = seed()) {
  const fake = createFakeCloudDatabase(value)
  return {
    fake,
    repository: createCloudOptionalTailRepository({ db: fake.db, clock: () => DECISION_AT })
  }
}

test('active candidate activates the exact pending optional tail once and receives an idempotent retry', async () => {
  const { fake, repository } = harness()
  const request = decision()
  const context = await repository.inspectDecision(request)
  const result = await repository.commitDecision({ ...request, context, timing: activateTiming() })

  assert.deepEqual(result, {
    decision: 'activate', lineStatus: 'active', nodeStatus: 'ready', lineVersion: 6, nodeVersion: 2
  })
  const [line] = fake.documents('business_lines')
  const [node] = fake.documents('business_nodes')
  assert.equal(line.optionalTailState, 'activated')
  assert.equal(line.status, 'active')
  assert.equal(line.version, 6)
  assert.equal(line.searchIndexStatus, 'pending')
  assert.equal(node.status, 'ready')
  assert.equal(node.version, 2)
  assert.equal(node.processingStartedAt.toISOString(), DECISION_AT.toISOString())
  assert.equal(node.processingDueAt.toISOString(), '2026-08-29T10:00:00.000Z')
  assert.equal(node.decisionWorkMinutes, 30)
  assert.equal(node.decision, 'activate')
  assert.equal(node.decisionAnalyticsSnapshotStatus, 'pending')
  assert.equal(node.decisionAnalyticsSourceVersion, 1)
  assert.equal(node.decisionActorId, 'user-2')
  assert.equal(node.decisionComment, '')
  assert.equal(Object.hasOwn(node, 'nextDecisionReminderWorkHour'), false)
  assert.equal(Object.hasOwn(node, 'decisionReminderStatus'), false)
  assert.equal(fake.documents('audit_logs')[0].action, 'ACTIVATE_OPTIONAL_TAIL')
  assert.equal(Object.hasOwn(fake.documents('audit_logs')[0], 'decisionComment'), false)
  assert.equal(fake.documents('notifications')[0].type, 'node_processing_started')

  const retry = await repository.inspectDecision(request)
  assert.deepEqual(retry.retryResult, result)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('notifications').length, 1)

  await assert.rejects(
    repository.inspectDecision(decision({ decision: 'skip', comment: '改为跳过' })),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('skip records the reason, freezes the line, starts retention and emits redacted terminal records', async () => {
  const { fake, repository } = harness()
  const request = decision({ decision: 'skip', comment: '客户明确不需要追加回访' })
  const context = await repository.inspectDecision(request)
  const result = await repository.commitDecision({
    ...request,
    context,
    timing: {
      decisionAt: DECISION_AT,
      decisionTimingStatus: 'calculated', decisionWorkMinutes: 30, decisionCalendarVersion: 'calendar-v1'
    }
  })

  assert.deepEqual(result, {
    decision: 'skip', lineStatus: 'completed', nodeStatus: 'skipped', lineVersion: 6, nodeVersion: 2
  })
  const [line] = fake.documents('business_lines')
  const [node] = fake.documents('business_nodes')
  assert.equal(line.optionalTailState, 'skipped')
  assert.equal(line.status, 'completed')
  assert.equal(line.progress, 100)
  assert.equal(line.retentionStartedAt.toISOString(), DECISION_AT.toISOString())
  assert.equal(line.purgeDueAt.toISOString(), '2026-10-28T02:00:00.000Z')
  assert.equal(line.analyticsSnapshotStatus, 'pending')
  assert.equal(line.analyticsSourceVersion, 1)
  assert.equal(node.status, 'skipped')
  assert.equal(node.decisionComment, '客户明确不需要追加回访')
  assert.equal(node.decision, 'skip')
  assert.equal(node.decisionAnalyticsSnapshotStatus, 'pending')
  assert.equal(node.decisionAnalyticsSourceVersion, 1)
  assert.equal(node.analyticsSnapshotStatus, 'pending')
  assert.equal(node.analyticsSourceVersion, 1)
  assert.equal(Object.hasOwn(node, 'processingStartedAt'), false)
  const [audit] = fake.documents('audit_logs')
  const [notification] = fake.documents('notifications')
  assert.equal(audit.action, 'SKIP_OPTIONAL_TAIL')
  assert.equal(Object.hasOwn(audit, 'decisionComment'), false)
  assert.equal(notification.type, 'business_completed')
  assert.equal(Object.hasOwn(notification, 'decisionComment'), false)
})

test('inactive and unrelated accounts cannot inspect or commit a decision', async () => {
  const { fake, repository } = harness()
  await assert.rejects(
    repository.inspectDecision({ ...decision(), actor: { _id: 'user-9', status: 'active' } }),
    error => error.code === 'FORBIDDEN'
  )
  fake.replace('users', 'user-2', { _id: 'user-2', status: 'disabled' })
  await assert.rejects(repository.inspectDecision(decision()), error => error.code === 'FORBIDDEN')
})

test('commit rejects stale context and malformed pending relationships without partial writes', async () => {
  const { fake, repository } = harness()
  const request = decision()
  const context = await repository.inspectDecision(request)
  fake.replace('business_lines', 'line-1', {
    ...fake.documents('business_lines')[0], optionalTailState: 'activated', version: 6
  })
  await assert.rejects(
    repository.commitDecision({ ...request, context, timing: activateTiming() }),
    error => error.code === 'VERSION_CONFLICT'
  )
  assert.equal(fake.documents('audit_logs').length, 0)
  assert.equal(fake.documents('notifications').length, 0)
})

test('pending-calendar activation preserves null decision and processing durations', async () => {
  const { fake, repository } = harness()
  const request = decision()
  const context = await repository.inspectDecision(request)
  await repository.commitDecision({
    ...request,
    context,
    timing: activateTiming({
      decisionTimingStatus: 'pending_calendar', decisionWorkMinutes: null,
      decisionCalendarVersion: null, processingDueStatus: 'pending_calendar',
      processingDueAt: null, processingCalendarVersion: null
    })
  })
  const [node] = fake.documents('business_nodes')
  assert.equal(node.decisionTimingStatus, 'pending_calendar')
  assert.equal(node.decisionWorkMinutes, null)
  assert.equal(node.processingDueStatus, 'pending_calendar')
  assert.equal(node.processingDueAt, null)
})
