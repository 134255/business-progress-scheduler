const test = require('node:test')
const assert = require('node:assert/strict')

const { createWorkflowTransitionService } = require('../lib/workflow-transition-service')

function node(next, fields = []) {
  return {
    _id: 'node-current', businessLineId: 'line-1', nodeKey: 'current',
    routeState: 'active', status: 'pending_review', version: 3,
    fieldDefinitions: fields, next
  }
}

function input(overrides = {}) {
  return {
    businessLineId: 'line-1', nodeId: 'node-current',
    expectedLineVersion: 4, expectedNodeVersion: 3,
    fieldValues: [], requestKey: 'complete-1', ...overrides
  }
}

function harness(context) {
  const calls = []
  const repository = {
    async inspectCompletion(value) {
      calls.push(['inspectCompletion', structuredClone(value)])
      return structuredClone(context)
    },
    async commitCompletion(value) {
      calls.push(['commitCompletion', structuredClone(value)])
      return { nodeStatus: 'completed', lineStatus: 'active', currentNodeId: 'node-target' }
    }
  }
  const workCalls = []
  const service = createWorkflowTransitionService({
    repository,
    clock: () => new Date('2026-09-03T03:00:00.000Z'),
    workTimeService: {
      async tryAddWorkMinutes(at, minutes) {
        workCalls.push([new Date(at), minutes])
        return {
          status: 'calculated', dueAt: new Date(at.getTime() + minutes * 60000),
          calendarVersion: 'calendar-v2'
        }
      }
    }
  })
  return { service, calls, workCalls }
}

test('end completion plans an exact line terminal without target timing', async () => {
  const h = harness({ node: node({ mode: 'end' }), targetNode: null })

  await h.service.complete({ actor: { _id: 'actor-1', status: 'active' }, input: input() })

  assert.equal(h.workCalls.length, 0)
  assert.deepEqual(h.calls[1][1].transition, { kind: 'complete_line' })
  assert.equal(Object.hasOwn(h.calls[1][1], 'timing'), false)
})

test('default completion activates its snapshotted target and calculates only that target deadline', async () => {
  const target = {
    _id: 'node-target', businessLineId: 'line-1', nodeKey: 'target', routeState: 'dormant',
    status: 'waiting', version: 1, processingSlaWorkHours: 6
  }
  const h = harness({
    node: node({ mode: 'default', targetNodeId: 'node-target' }), targetNode: target
  })

  await h.service.complete({ actor: { _id: 'actor-1', status: 'active' }, input: input() })

  assert.equal(h.workCalls[0][1], 360)
  assert.deepEqual(h.calls[1][1].transition, { kind: 'activate_node', targetNodeId: 'node-target' })
  assert.deepEqual(h.calls[1][1].timing, {
    processingStartedAt: new Date('2026-09-03T03:00:00.000Z'),
    processingDueStatus: 'calculated',
    processingDueAt: new Date('2026-09-03T09:00:00.000Z'),
    processingCalendarVersion: 'calendar-v2'
  })
})

test('single-select completion resolves the final approved value across nested and converging routes', async () => {
  const fields = [{
    fieldKey: 'decision', sequence: 0, name: '去向', description: '',
    type: 'single_select', required: true, constraints: { options: ['汇合', '结束'] }
  }]
  const target = {
    _id: 'node-shared', businessLineId: 'line-1', nodeKey: 'shared', routeState: 'dormant',
    status: 'waiting', version: 1, processingSlaWorkHours: 2
  }
  const h = harness({
    node: node({
      mode: 'single_select', fieldKey: 'decision',
      optionTargets: { '汇合': 'node-shared', '结束': 'end' }
    }, fields),
    targetNode: target
  })

  await h.service.complete({
    actor: { _id: 'actor-1', status: 'active' },
    input: input({ fieldValues: [{ fieldKey: 'decision', name: '去向', type: 'single_select', value: '汇合' }] })
  })

  assert.deepEqual(h.calls[1][1].transition, { kind: 'activate_node', targetNodeId: 'node-shared' })
  assert.equal(h.workCalls[0][1], 120)
})

test('manual completion waits for a later decision and does not start either candidate clock', async () => {
  const h = harness({
    node: node({
      mode: 'manual', activateTargetNodeId: 'node-a', skipTargetNodeId: 'node-b'
    }),
    targetNode: null
  })

  await h.service.complete({ actor: { _id: 'actor-1', status: 'active' }, input: input() })

  assert.equal(h.workCalls.length, 0)
  assert.deepEqual(h.calls[1][1].transition, { kind: 'await_manual_decision' })
})

test('an exact finalized retry returns without recalculating timing or committing again', async () => {
  const retryResult = { nodeStatus: 'completed', lineStatus: 'completed', currentNodeId: 'node-current' }
  const h = harness({ retryResult })

  const result = await h.service.complete({
    actor: { _id: 'actor-1', status: 'active' }, input: input()
  })

  assert.deepEqual(result, retryResult)
  assert.equal(h.calls.length, 1)
  assert.equal(h.workCalls.length, 0)
})
