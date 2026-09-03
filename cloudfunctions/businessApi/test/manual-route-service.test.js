const test = require('node:test')
const assert = require('node:assert/strict')

const { createManualRouteService } = require('../lib/manual-route-service')

function input(overrides = {}) {
  return {
    businessLineId: 'line-1', nodeId: 'source-node', expectedLineVersion: 5,
    expectedNodeVersion: 4, decision: 'activate', comment: '', requestKey: 'route-001',
    ...overrides
  }
}

function harness(overrides = {}) {
  const calls = []
  const repository = {
    async inspectDecision(value) {
      calls.push(['inspect', value])
      return {
        decisionStartedAt: new Date('2026-09-03T01:30:00.000Z'),
        targetNodeId: 'optional-node', processingSlaWorkHours: 8
      }
    },
    async commitDecision(value) {
      calls.push(['commit', value])
      return {
        decision: value.input.decision, lineStatus: 'active', currentNodeId: 'optional-node',
        nodeVersion: 5, lineVersion: 6
      }
    },
    ...overrides.repository
  }
  const workTimeService = {
    async workingMinutesBetween(start, end) {
      calls.push(['elapsed', start, end])
      return { status: 'calculated', minutes: 30, calendarVersion: 'calendar-v1' }
    },
    async tryAddWorkMinutes(start, minutes) {
      calls.push(['due', start, minutes])
      return { status: 'calculated', dueAt: new Date('2026-09-03T10:00:00.000Z'), calendarVersion: 'calendar-v1' }
    },
    ...overrides.workTimeService
  }
  return {
    calls,
    service: createManualRouteService({
      repository, workTimeService,
      clock: () => new Date('2026-09-03T02:00:00.000Z')
    })
  }
}

test('manual decision calculates separate decision and selected-target processing timing', async () => {
  const { calls, service } = harness()
  await service.decide({ actor: { _id: 'user-2', status: 'active' }, input: input() })
  const commit = calls.find(call => call[0] === 'commit')[1]
  assert.equal(calls.filter(call => call[0] === 'elapsed').length, 1)
  assert.equal(calls.filter(call => call[0] === 'due').length, 1)
  assert.deepEqual(commit.timing, {
    decisionAt: new Date('2026-09-03T02:00:00.000Z'),
    decisionTimingStatus: 'calculated', decisionWorkMinutes: 30,
    decisionCalendarVersion: 'calendar-v1',
    processingStartedAt: new Date('2026-09-03T02:00:00.000Z'),
    processingDueStatus: 'calculated',
    processingDueAt: new Date('2026-09-03T10:00:00.000Z'),
    processingCalendarVersion: 'calendar-v1'
  })
  assert.match(commit.requestKeyHash, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(commit.input, 'requestKey'), false)
})

test('skip-to-node starts the selected skip target while skip-to-end has no processing clock', async () => {
  const toNode = harness({ repository: { async inspectDecision() {
    return { decisionStartedAt: new Date('2026-09-03T01:30:00.000Z'), targetNodeId: 'after-node', processingSlaWorkHours: 4 }
  } } })
  await toNode.service.decide({
    actor: { _id: 'user-2', status: 'active' },
    input: input({ decision: 'skip', comment: '不执行可选处理' })
  })
  assert.equal(toNode.calls.filter(call => call[0] === 'due').length, 1)

  const toEnd = harness({ repository: { async inspectDecision() {
    return { decisionStartedAt: new Date('2026-09-03T01:30:00.000Z'), targetNodeId: null }
  } } })
  await toEnd.service.decide({
    actor: { _id: 'user-2', status: 'active' },
    input: input({ decision: 'skip', comment: '流程结束' })
  })
  assert.equal(toEnd.calls.filter(call => call[0] === 'due').length, 0)
})

test('service rejects malformed input and empty skip reasons', async () => {
  const { service } = harness()
  for (const invalid of [input({ unexpected: true }), input({ expectedLineVersion: 0 }),
    input({ decision: 'skip', comment: '  ' })]) {
    await assert.rejects(
      service.decide({ actor: { _id: 'user-2', status: 'active' }, input: invalid }),
      error => error.code === 'VALIDATION_ERROR'
    )
  }
})

test('exact retry returns without recalculating timing', async () => {
  const retryResult = { decision: 'activate', lineStatus: 'active', currentNodeId: 'optional-node', nodeVersion: 5, lineVersion: 6 }
  const { calls, service } = harness({ repository: { async inspectDecision() { return { retryResult } } } })
  assert.deepEqual(await service.decide({ actor: { _id: 'user-2', status: 'active' }, input: input() }), retryResult)
  assert.equal(calls.some(call => ['elapsed', 'due', 'commit'].includes(call[0])), false)
})
