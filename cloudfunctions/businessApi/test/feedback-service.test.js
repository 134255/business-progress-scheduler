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
    async findPublishedFeedback(value) {
      calls.push(['published', structuredClone(value)])
      return overrides.published || null
    },
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
    service: createFeedbackService({
      repository: { ...repository, ...overrides.repository },
      businessSearchClient: overrides.businessSearchClient
    })
  }
}

test('发布处理进度后同步检索索引并仅返回公开结果', async () => {
  const publicResult = { feedbackId: 'feedback-1', revision: 1, nodeStatus: 'in_progress', lineStatus: 'active' }
  const envelope = { actorId: 'account-1', businessLineId: 'line-1', sourceVersion: 2 }
  const indexed = []
  const value = harness({
    context: {
      ...context(),
      node: {
        ...context().node,
        workflowMode: 'review',
        requiresEvidence: false,
        processorUserIds: ['account-1'],
        reviewerUserIds: ['reviewer-1'],
        processingRoundNumber: 1
      }
    },
    repository: { async commitFeedback() { return { publicResult, searchEnvelope: envelope } } },
    businessSearchClient: { async ensureIndexed(item) { indexed.push(item) } }
  })
  const result = await value.service.saveNodeProgress({
    actor: value.actor,
    input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
      action: 'save_progress', fieldValues: input().fieldValues, comment: '当前内容',
      evidenceIds: [], requestKey: 'progress-index-1'
    }
  })
  assert.equal(result, publicResult)
  assert.deepEqual(indexed, [envelope])
})

test('处理进度已发布重试会补建检索索引且索引失败仍返回权威成功', async () => {
  const publicResult = { feedbackId: 'feedback-1', revision: 1, nodeStatus: 'in_progress', lineStatus: 'active' }
  const envelope = { actorId: 'account-1', businessLineId: 'line-1', sourceVersion: 2 }
  const value = harness({
    published: { publicResult, searchEnvelope: envelope },
    businessSearchClient: { async ensureIndexed() { throw new Error('timeout') } }
  })
  assert.deepEqual(await value.service.saveNodeProgress({
    actor: value.actor,
    input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
      action: 'save_progress', fieldValues: input().fieldValues, comment: '当前内容',
      evidenceIds: [], requestKey: 'progress-index-1'
    }
  }), { ...publicResult, searchIndexStatus: 'pending' })
})

test('submission snapshots typed field identity and delegates immutable normalized feedback', async () => {
  const { actor, calls, service } = harness()
  const result = await service.submitFeedback({ actor, input: input() })

  assert.deepEqual(result, { feedbackId: 'feedback-1', revision: 1, nodeStatus: 'completed', lineStatus: 'completed' })
  assert.equal(calls[0][0], 'published')
  assert.deepEqual(calls[2][1], {
    actor,
    input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 3,
      status: 'completed', comment: '完成说明', evidenceIds: ['evidence-1', 'evidence-2'],
      requestKey: 'feedback-request-1'
    },
    requestFingerprint: calls[2][1].requestFingerprint,
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

test('条件字段提交拒绝隐藏字段注入、可见必填缺失和当前分支外选项', async () => {
  const conditionalContext = context({
    node: {
      ...context().node,
      requiresEvidence: false,
      fieldDefinitions: [
        {
          fieldKey: 'kind', sequence: 0, name: '类型', type: 'single_select', required: true,
          constraints: { options: ['换货', '维修'] }
        },
        {
          fieldKey: 'reason', sequence: 1, name: '原因', type: 'single_select', required: true,
          constraints: { options: ['破损', '尺寸', '主板', '屏幕'] },
          condition: {
            parentFieldKey: 'kind', visibleWhen: ['换货', '维修'],
            optionsByParentValue: { '换货': ['破损', '尺寸'], '维修': ['主板', '屏幕'] }
          }
        },
        {
          fieldKey: 'exchange_note', sequence: 2, name: '换货说明', type: 'short_text', required: true,
          constraints: { maxLength: 100 },
          condition: { parentFieldKey: 'kind', visibleWhen: ['换货'] }
        }
      ]
    },
    evidences: []
  })
  const invalidValues = [
    [
      { fieldKey: 'kind', value: '维修' },
      { fieldKey: 'reason', value: '主板' },
      { fieldKey: 'exchange_note', value: '不应提交' }
    ],
    [
      { fieldKey: 'kind', value: '换货' },
      { fieldKey: 'reason', value: '破损' }
    ],
    [
      { fieldKey: 'kind', value: '维修' },
      { fieldKey: 'reason', value: '破损' }
    ]
  ]
  for (const fieldValues of invalidValues) {
    const { actor, calls, service } = harness({ context: conditionalContext })
    await assert.rejects(
      service.submitFeedback({ actor, input: input({ fieldValues, evidenceIds: [] }) }),
      error => error.code === 'INVALID_FIELD_VALUE'
    )
    assert.equal(calls.some(call => call[0] === 'commit'), false)
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
    assert.equal(calls[2][1].input.comment, '')
  }
})

test('aggregate evidence validation has an exact 120 MiB boundary and no count cap', async () => {
  const tiny = Array.from({ length: 150 }, (_, index) => ({ _id: `evidence-${index}`, size: 1 }))
  const ids = tiny.map(item => item._id)
  const allowed = harness({ context: { ...context(), evidences: tiny } })
  await allowed.service.submitFeedback({ actor: allowed.actor, input: input({ evidenceIds: ids }) })
  assert.equal(allowed.calls[2][1].evidenceTotalBytes, 150)

  const tooLarge = harness({ context: { ...context(), evidences: [{ _id: 'evidence-1', size: 120 * 1024 * 1024 + 1 }] } })
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

test('exact published retry returns before active-node and frozen-line preflight', async () => {
  const published = { feedbackId: 'feedback-1', revision: 7, nodeStatus: 'completed', lineStatus: 'completed' }
  const { actor, calls, service } = harness({
    published,
    repository: {
      async getSubmissionContext() { throw new Error('frozen preflight must not run') },
      async commitFeedback() { throw new Error('commit must not run') }
    }
  })
  assert.deepEqual(await service.submitFeedback({ actor, input: input() }), published)
  assert.deepEqual(calls.map(call => call[0]), ['published'])
})

test('feedback input must be a plain own-property request with every required key', async () => {
  const { actor, service } = harness()
  const inherited = Object.create(input())
  await assert.rejects(service.submitFeedback({ actor, input: inherited }), error => error.code === 'VALIDATION_ERROR')
  const missingComment = input()
  delete missingComment.comment
  await assert.rejects(service.submitFeedback({ actor, input: missingComment }), error => error.code === 'VALIDATION_ERROR')
  const hiddenExtra = input()
  Object.defineProperty(hiddenExtra, 'hidden', { value: true })
  await assert.rejects(service.submitFeedback({ actor, input: hiddenExtra }), error => error.code === 'VALIDATION_ERROR')
  const accessor = input()
  Object.defineProperty(accessor, 'comment', { get() { return 'unsafe' }, enumerable: true })
  await assert.rejects(service.submitFeedback({ actor, input: accessor }), error => error.code === 'VALIDATION_ERROR')
})

test('新版节点处理人只能保存进度或标记受阻，不能直接完成', async () => {
  const reviewContext = context({
    node: {
      ...context().node,
      workflowMode: 'review',
      processorUserIds: ['account-1'],
      reviewerUserIds: ['reviewer-1'],
      processingRoundNumber: 1
    }
  })
  const { actor, calls, service } = harness({ context: reviewContext })
  const { status: ignoredStatus, ...progressBase } = input()

  await assert.rejects(
    service.saveNodeProgress({ actor, input: { ...progressBase, action: 'completed' } }),
    error => error.code === 'VALIDATION_ERROR'
  )
  const result = await service.saveNodeProgress({
    actor,
    input: { ...progressBase, action: 'save_progress' }
  })

  assert.equal(result.nodeStatus, 'in_progress')
  assert.equal(calls.at(-1)[1].input.action, 'save_progress')
  assert.equal(calls.at(-1)[1].input.status, 'in_progress')
})

test('无审核人新版节点可直接完成并仍执行字段与凭证校验', async () => {
  const directContext = context({
    node: {
      ...context().node,
      workflowMode: 'review',
      processorUserIds: ['account-1'],
      reviewerUserIds: [],
      processingRoundNumber: 1
    }
  })
  const value = harness({
    context: directContext,
    repository: {
      async commitFeedback(inputValue) {
        value.calls.push(['commit', structuredClone(inputValue)])
        return {
          feedbackId: 'feedback-direct', revision: 1, nodeStatus: 'completed',
          lineStatus: 'active', nextNodeId: 'node-2', optionalTailState: 'none'
        }
      }
    }
  })
  const { status: ignoredStatus, ...progressBase } = input()
  const result = await value.service.saveNodeProgress({
    actor: value.actor,
    input: { ...progressBase, action: 'complete_node' }
  })
  assert.deepEqual(result, {
    feedbackId: 'feedback-direct', revision: 1, nodeStatus: 'completed',
    lineStatus: 'active', nextNodeId: 'node-2', optionalTailState: 'none'
  })
  assert.equal(value.calls.at(-1)[1].input.action, 'complete_node')
  assert.equal(value.calls.at(-1)[1].input.status, 'completed')

  const reviewed = harness({ context: {
    ...directContext,
    node: { ...directContext.node, reviewerUserIds: ['reviewer-1'] }
  } })
  await assert.rejects(reviewed.service.saveNodeProgress({
    actor: reviewed.actor,
    input: { ...progressBase, action: 'complete_node' }
  }), error => error.code === 'NODE_REVIEW_REQUIRED')

  const missingEvidence = harness({ context: { ...directContext, evidences: [] } })
  await assert.rejects(missingEvidence.service.saveNodeProgress({
    actor: missingEvidence.actor,
    input: { ...progressBase, action: 'complete_node', evidenceIds: [] }
  }), error => error.code === 'EVIDENCE_NOT_ATTACHABLE')
})

test('组合提交预检会在任何写入前拒绝无审核人节点', async () => {
  const directContext = context({
    node: {
      ...context().node,
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: []
    }
  })
  const { actor, calls, service } = harness({ context: directContext })
  await assert.rejects(service.assertNodeRequiresReview({
    actor, businessLineId: 'line-1', nodeId: 'node-1'
  }), error => error.code === 'NODE_REVIEW_NOT_REQUIRED')
  assert.equal(calls.some(call => call[0] === 'commit'), false)
})

test('标记受阻原因必填且发布不可变处理版本', async () => {
  const reviewContext = context({
    node: {
      ...context().node,
      workflowMode: 'review',
      processorUserIds: ['account-1'],
      reviewerUserIds: ['reviewer-1'],
      processingRoundNumber: 2
    }
  })
  const { actor, calls, service } = harness({ context: reviewContext })
  const { status: ignoredStatus, ...progressBase } = input()
  const base = { ...progressBase, action: 'mark_blocked', evidenceIds: [] }

  await assert.rejects(
    service.saveNodeProgress({ actor, input: { ...base, comment: '  ' } }),
    error => error.code === 'BLOCKED_REASON_REQUIRED'
  )
  await service.saveNodeProgress({ actor, input: { ...base, comment: ' 等待外部资料 ' } })

  assert.equal(calls.at(-1)[1].input.status, 'blocked')
  assert.equal(calls.at(-1)[1].input.comment, '等待外部资料')
})

test('旧完成入口不能绕过新版节点审核', async () => {
  const { actor, calls, service } = harness({
    context: context({
      node: {
        ...context().node,
        workflowMode: 'review',
        processorUserIds: ['account-1'],
        reviewerUserIds: ['reviewer-1'],
        processingRoundNumber: 1
      }
    })
  })

  await assert.rejects(
    service.submitFeedback({ actor, input: input() }),
    error => error.code === 'NODE_PENDING_REVIEW'
  )
  assert.equal(calls.some(call => call[0] === 'commit'), false)
})
