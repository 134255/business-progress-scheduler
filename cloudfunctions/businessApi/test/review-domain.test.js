const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeReviewMode,
  normalizeWorkAction,
  normalizeVoteInput,
  deterministicVoteId
} = require('../lib/review-domain')

test('审核模式、动作和投票输入采用封闭枚举', () => {
  assert.equal(normalizeReviewMode('any'), 'any')
  assert.equal(normalizeWorkAction('submit_review'), 'submit_review')
  assert.deepEqual(normalizeVoteInput({ decision: 'rejected', comment: '资料不完整' }), {
    decision: 'rejected',
    comment: '资料不完整'
  })
  assert.throws(() => normalizeReviewMode('majority'), error => error.code === 'REVIEW_MODE_INVALID')
  assert.throws(() => normalizeWorkAction('complete'), error => error.code === 'WORK_ACTION_INVALID')
  assert.throws(() => normalizeVoteInput({ decision: 'pending', comment: '等待' }), error => error.code === 'VOTE_DECISION_INVALID')
  assert.throws(() => normalizeVoteInput({ decision: 'rejected', comment: '' }),
    error => error.code === 'REVIEW_COMMENT_REQUIRED')
})

test('投票编号由轮次和审核人确定性生成', () => {
  assert.equal(deterministicVoteId('round-a', 'user-a'), deterministicVoteId('round-a', 'user-a'))
  assert.notEqual(deterministicVoteId('round-a', 'user-a'), deterministicVoteId('round-a', 'user-b'))
})
