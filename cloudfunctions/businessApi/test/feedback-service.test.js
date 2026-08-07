const test = require('node:test')
const assert = require('node:assert/strict')

const { createFeedbackService } = require('../lib/feedback-service')

function context(overrides = {}) {
  return {
    line: { _id: 'line-1', status: 'active' },
    node: {
      _id: 'node-1', businessLineId: 'line-1', status: 'ready', version: 3,
      requiresEvidence: true,
      fieldDefinitions: [
        { fieldKey: 'summary', sequence: 0, name: '摘要', type: 'short_text', required: true, constraints: { maxLength: 20 } },
        { fieldKey: 'accepted', sequence: 1, name: '通过', type: 'boolean', required: true, constraints: {} },
        { fieldKey: 'choice', sequence: 2, name: '结果', type: 'single_select', required: false, constraints: { options: ['通过', '退回'] } }
      ]
    },
    evidences: [
      { _id: 'evidence-1', size: 8 * 1024 * 1024 },
      { _id: 'evidence-2', size: 12 * 1024 * 1024 }
    ],
    ...overrides
  }
}

function input(overrides = {}) {
  return {
    businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
    status: 'completed',
    fieldValues: [
      { fieldKey: 'summary', value: '验收完成' },
      { fieldKey: 'accepted', value: true },
      { fieldKey: 'choice', value: '通过' }
    ],
    comment: '  完成说明  ', evidenceIds: ['evidence-1', 'evidence-2'],
    requestKey: 'feedback-request-1',
    ...overrides
  }
}

function harness(overrides = {}) {
  const calls = []
  const repository = {
    async getSubmissionContext(value) {
      calls.push(['context', structuredClone(value)])
      return context(overrides.context)
    },
    async commitFeedback(value) {
      calls.push(['commit', structuredClone(value)])
      return { feedbackId: 'feedback-1', revision: 1, nodeStatus: value.input.status, lineStatus: 'completed' }
    }
  }
  return {
    actor: { _id: 'account-1', status: 'active' },
    calls,
    service: createFeedbackService({ repository: { ...repository, ...overrides.repository } })
  }
}

test('submission snapshots typed field identity and delegates immutable normalized feedback', async () => {
  const { actor, calls, service } = harness()
  const result = await service.submitFeedback({ actor, input: input() })

  assert.deepEqual(result, { feedbackId: 'feedback-1', revision: 1, nodeStatus: 'completed', lineStatus: 'completed' })
  assert.deepEqual(calls[1][1], {
    actor,
    input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
      status: 'completed', comment: '完成说明', evidenceIds: ['evidence-1', 'evidence-2'],
      requestKey: 'feedback-request-1'
    },
    fieldSnapshots: [
      { fieldKey: 'summary', name: '摘要', type: 'short_text', value: '验收完成' },
      { fieldKey: 'accepted', name: '通过', type: 'boolean', value: true },
      { fieldKey: 'choice', name: '结果', type: 'single_select', value: '通过' }
    ],
    evidenceTotalBytes: 20 * 1024 * 1024
  })
})

test('field policy rejects missing required values, wrong types, and undeclared choices', async () => {
  for (const fieldValues of [
    [{ fieldKey: 'accepted', value: true }],
    [{ fieldKey: 'summary', value: 'ok' }, { fieldKey: 'accepted', value: 'true' }],
    [{ fieldKey: 'summary', value: 'ok' }, { fieldKey: 'accepted', value: true }, { fieldKey: 'choice', value: '未知' }]
  ]) {
    const { actor, service } = harness()
    await assert.rejects(service.submitFeedback({ actor, input: input({ fieldValues }) }), error => error.code === 'INVALID_FIELD_VALUE')
  }
})

test('completion requires registered evidence when the node snapshot requires it', async () => {
  const { actor, service } = harness({ context: { ...context(), evidences: [] } })
  await assert.rejects(
    service.submitFeedback({ actor, input: input({ evidenceIds: [] }) }),
    error => error.code === 'EVIDENCE_NOT_ATTACHABLE'
  )
})

test('in-progress and blocked revisions may omit evidence and preserve null optional fields', async () => {
  for (const status of ['in_progress', 'blocked']) {
    const { actor, calls, service } = harness({ context: { ...context(), evidences: [] } })
    const result = await service.submitFeedback({
      actor,
      input: input({ status, evidenceIds: [], comment: undefined })
    })
    assert.equal(result.nodeStatus, status)
    assert.equal(calls[1][1].input.comment, '')
  }
})

test('aggregate evidence validation has an exact 20MB boundary and no count cap', async () => {
  const tiny = Array.from({ length: 150 }, (_, index) => ({ _id: `evidence-${index}`, size: 1 }))
  const ids = tiny.map(item => item._id)
  const allowed = harness({ context: { ...context(), evidences: tiny } })
  await allowed.service.submitFeedback({ actor: allowed.actor, input: input({ evidenceIds: ids }) })
  assert.equal(allowed.calls[1][1].evidenceTotalBytes, 150)

  const tooLarge = harness({ context: { ...context(), evidences: [{ _id: 'evidence-1', size: 20 * 1024 * 1024 + 1 }] } })
  await assert.rejects(
    tooLarge.service.submitFeedback({ actor: tooLarge.actor, input: input({ evidenceIds: ['evidence-1'] }) }),
    error => error.code === 'FEEDBACK_TOTAL_TOO_LARGE'
  )
})

test('malformed, duplicate, or missing evidence identities fail before commit', async () => {
  for (const evidenceIds of [['evidence-1', 'evidence-1'], ['bad id'], ['missing']]) {
    const { actor, calls, service } = harness()
    await assert.rejects(service.submitFeedback({ actor, input: input({ evidenceIds }) }))
    assert.equal(calls.some(call => call[0] === 'commit'), false)
  }
})

test('history delegates only normalized identifiers for an active actor', async () => {
  const calls = []
  const repository = { async getNodeHistory(value) { calls.push(value); return { history: [] } } }
  const service = createFeedbackService({ repository })
  const actor = { _id: 'account-1', status: 'active' }
  assert.deepEqual(await service.getNodeHistory({ actor, businessLineId: 'line-1', nodeId: 'node-1' }), { history: [] })
  assert.deepEqual(calls, [{ actor, businessLineId: 'line-1', nodeId: 'node-1' }])
})
