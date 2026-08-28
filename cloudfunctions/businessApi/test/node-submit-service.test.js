const test = require('node:test')
const assert = require('node:assert/strict')

const { createNodeSubmitService } = require('../lib/node-submit-service')

const ACTOR = { _id: 'processor-1', status: 'active' }

function input(overrides = {}) {
  return {
    businessLineId: 'line-1',
    nodeId: 'node-1',
    expectedNodeVersion: 4,
    fieldValues: [{ fieldKey: 'summary', value: '资料已齐' }],
    comment: '提交审核',
    evidenceIds: ['evidence-1'],
    progressRequestKey: 'progress-1',
    reviewRequestKey: 'review-1',
    ...overrides
  }
}

test('保存并提交审核使用保存后的节点版本且只返回合并后的公开结果', async () => {
  const calls = []
  const service = createNodeSubmitService({
    feedbackService: {
      async saveNodeProgress(value) {
        calls.push(['progress', value])
        return { feedbackId: 'feedback-1', revision: 2, nodeVersion: 5, nodeStatus: 'in_progress' }
      }
    },
    reviewService: {
      async submitNodeForReview(value) {
        calls.push(['review', value])
        return {
          reviewRoundId: 'round-1', status: 'pending', nodeStatus: 'pending_review',
          evidenceIds: ['evidence-1']
        }
      }
    }
  })

  const result = await service.saveAndSubmitNodeForReview({ actor: ACTOR, input: input() })

  assert.deepEqual(result, {
    feedbackId: 'feedback-1',
    reviewRoundId: 'round-1',
    nodeVersion: 5,
    nodeStatus: 'pending_review'
  })
  assert.deepEqual(calls, [
    ['progress', { actor: ACTOR, input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4,
      action: 'save_progress', fieldValues: [{ fieldKey: 'summary', value: '资料已齐' }],
      comment: '提交审核', evidenceIds: ['evidence-1'], requestKey: 'progress-1'
    } }],
    ['review', { actor: ACTOR, input: {
      businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 5,
      requestKey: 'review-1'
    } }]
  ])
})

test('任一步检索待同步都会保留权威成功并上浮待补索引状态', async () => {
  const service = createNodeSubmitService({
    feedbackService: {
      async saveNodeProgress() {
        return { feedbackId: 'feedback-1', nodeVersion: 5, searchIndexStatus: 'pending' }
      }
    },
    reviewService: {
      async submitNodeForReview() {
        return { reviewRoundId: 'round-1', nodeStatus: 'pending_review' }
      }
    }
  })

  assert.deepEqual(await service.saveAndSubmitNodeForReview({ actor: ACTOR, input: input() }), {
    feedbackId: 'feedback-1', reviewRoundId: 'round-1', nodeVersion: 5,
    nodeStatus: 'pending_review', searchIndexStatus: 'pending'
  })
})

test('严格拒绝缺失、额外、访问器和非法版本输入且不触发子写入', async () => {
  let writes = 0
  const service = createNodeSubmitService({
    feedbackService: { async saveNodeProgress() { writes += 1 } },
    reviewService: { async submitNodeForReview() { writes += 1 } }
  })
  const invalid = [
    { ...input(), extra: true },
    { ...input(), expectedNodeVersion: 0 },
    Object.assign(Object.create({ businessLineId: 'line-1' }), input()),
    Object.defineProperty(input(), 'comment', { get() { throw new Error('getter must not run') } })
  ]
  delete invalid[2].businessLineId

  for (const value of invalid) {
    await assert.rejects(
      service.saveAndSubmitNodeForReview({ actor: ACTOR, input: value }),
      error => error && error.code === 'VALIDATION_ERROR'
    )
  }
  assert.equal(writes, 0)
})

test('保存结果缺少递增节点版本时失败关闭且不得开始审核', async () => {
  let reviews = 0
  const service = createNodeSubmitService({
    feedbackService: {
      async saveNodeProgress() { return { feedbackId: 'feedback-1', nodeVersion: 4 } }
    },
    reviewService: {
      async submitNodeForReview() { reviews += 1 }
    }
  })

  await assert.rejects(
    service.saveAndSubmitNodeForReview({ actor: ACTOR, input: input() }),
    error => error && error.code === 'VERSION_CONFLICT'
  )
  assert.equal(reviews, 0)
})
