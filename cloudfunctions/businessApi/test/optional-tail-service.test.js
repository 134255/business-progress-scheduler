const test = require('node:test')
const assert = require('node:assert/strict')

const { createOptionalTailService } = require('../lib/optional-tail-service')

function input(overrides = {}) {
  return {
    businessLineId: 'line-1',
    nodeId: 'node-2',
    expectedLineVersion: 5,
    expectedNodeVersion: 1,
    decision: 'activate',
    comment: '',
    requestKey: 'decision-request-001',
    ...overrides
  }
}

function harness(overrides = {}) {
  const calls = []
  const repository = {
    async inspectDecision(value) {
      calls.push(['inspect', value])
      return {
        decisionStartedAt: new Date('2026-08-29T01:30:00.000Z'),
        processingSlaWorkHours: 8
      }
    },
    async commitDecision(value) {
      calls.push(['commit', value])
      return {
        decision: value.input.decision,
        lineStatus: value.input.decision === 'skip' ? 'completed' : 'active',
        nodeStatus: value.input.decision === 'skip' ? 'skipped' : 'ready',
        lineVersion: 6,
        nodeVersion: 2
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
      return {
        status: 'calculated',
        dueAt: new Date('2026-08-29T10:00:00.000Z'),
        calendarVersion: 'calendar-v1'
      }
    },
    ...overrides.workTimeService
  }
  const service = createOptionalTailService({
    repository,
    workTimeService,
    clock: () => new Date('2026-08-29T02:00:00.000Z'),
    businessSearchClient: overrides.businessSearchClient || null
  })
  return { calls, service }
}

test('candidate activation calculates decision duration and starts processing timing', async () => {
  const { calls, service } = harness()

  assert.deepEqual(await service.decide({
    actor: { _id: 'user-2', status: 'active' }, input: input()
  }), {
    decision: 'activate', lineStatus: 'active', nodeStatus: 'ready', lineVersion: 6, nodeVersion: 2
  })

  assert.equal(calls.filter(call => call[0] === 'elapsed').length, 1)
  assert.equal(calls.filter(call => call[0] === 'due').length, 1)
  const commit = calls.find(call => call[0] === 'commit')[1]
  assert.deepEqual(commit.timing, {
    decisionAt: new Date('2026-08-29T02:00:00.000Z'),
    decisionTimingStatus: 'calculated',
    decisionWorkMinutes: 30,
    decisionCalendarVersion: 'calendar-v1',
    processingStartedAt: new Date('2026-08-29T02:00:00.000Z'),
    processingDueStatus: 'calculated',
    processingDueAt: new Date('2026-08-29T10:00:00.000Z'),
    processingCalendarVersion: 'calendar-v1'
  })
  assert.match(commit.requestKeyHash, /^[a-f0-9]{64}$/)
  assert.match(commit.inputHash, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(commit.input, 'requestKey'), false)
})

test('skip calculates decision duration without calculating a processing deadline', async () => {
  const { calls, service } = harness()

  const result = await service.decide({
    actor: { _id: 'user-2', status: 'active' },
    input: input({ decision: 'skip', comment: '客户不需要追加回访' })
  })

  assert.equal(result.lineStatus, 'completed')
  assert.equal(calls.filter(call => call[0] === 'due').length, 0)
  const commit = calls.find(call => call[0] === 'commit')[1]
  assert.equal(commit.input.comment, '客户不需要追加回访')
  assert.equal(Object.hasOwn(commit.timing, 'processingStartedAt'), false)
})

test('pending calendar results are preserved for decision and activation timing', async () => {
  const { calls, service } = harness({
    workTimeService: {
      async workingMinutesBetween() {
        return { status: 'pending_calendar', minutes: null, calendarVersion: null }
      },
      async tryAddWorkMinutes() {
        return { status: 'pending_calendar', dueAt: null, calendarVersion: null }
      }
    }
  })

  await service.decide({ actor: { _id: 'user-2', status: 'active' }, input: input() })
  const timing = calls.find(call => call[0] === 'commit')[1].timing
  assert.equal(timing.decisionTimingStatus, 'pending_calendar')
  assert.equal(timing.decisionWorkMinutes, null)
  assert.equal(timing.processingDueStatus, 'pending_calendar')
  assert.equal(timing.processingDueAt, null)
})

test('service rejects inactive actors, unknown keys, client identity, invalid versions and empty skip reasons', async () => {
  const { service } = harness()
  await assert.rejects(
    service.decide({ actor: { _id: 'user-2', status: 'disabled' }, input: input() }),
    error => error.code === 'FORBIDDEN'
  )
  for (const invalid of [
    input({ actorId: 'forged' }),
    input({ expectedLineVersion: 0 }),
    input({ decision: 'skip', comment: '   ' })
  ]) {
    await assert.rejects(
      service.decide({ actor: { _id: 'user-2', status: 'active' }, input: invalid }),
      error => error.code === 'VALIDATION_ERROR'
    )
  }
})

test('repository authorization errors and retry results pass through without extra timing work', async () => {
  const forbidden = harness({
    repository: {
      async inspectDecision() {
        const error = new Error('FORBIDDEN')
        error.code = 'FORBIDDEN'
        throw error
      }
    }
  })
  await assert.rejects(
    forbidden.service.decide({ actor: { _id: 'user-9', status: 'active' }, input: input() }),
    error => error.code === 'FORBIDDEN'
  )

  const retryResult = {
    decision: 'activate', lineStatus: 'active', nodeStatus: 'ready', lineVersion: 6, nodeVersion: 2
  }
  const retry = harness({ repository: { async inspectDecision() { return { retryResult } } } })
  assert.deepEqual(await retry.service.decide({
    actor: { _id: 'user-2', status: 'active' }, input: input()
  }), retryResult)
  assert.equal(retry.calls.some(call => ['elapsed', 'due', 'commit'].includes(call[0])), false)
})
