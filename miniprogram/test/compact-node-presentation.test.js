const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const target = path.join(__dirname, '../utils/compact-node-presentation.js')
const presentation = () => {
  assert.ok(fs.existsSync(target), 'compact presentation helper must exist')
  return require(target)
}

test('fold state starts closed and toggles without changing the immutable history', () => {
  const { initialCompactState, toggleCompactSection, toggleFeedbackRevision } = presentation()
  const history = Object.freeze([Object.freeze({ feedbackId: 'f1', comment: 'original', fieldValues: [0, false] }), Object.freeze({ feedbackId: 'f2' })])
  const state = { ...initialCompactState(), history, comment: 'unsaved', readOnly: true }
  assert.deepEqual(initialCompactState(), { feedbackHistoryOpen: false, reviewHistoryOpen: false, expandedFeedback: {} })
  const opened = { ...state, ...toggleCompactSection(state, 'feedbackHistoryOpen') }
  assert.equal(opened.feedbackHistoryOpen, true)
  const revision = { ...opened, ...toggleFeedbackRevision(opened, history, 'f1') }
  assert.equal(revision.expandedFeedback.f1, true)
  assert.equal(state.expandedFeedback.f1, undefined)
  assert.equal(revision.history, history)
  assert.equal(revision.comment, 'unsaved')
  assert.equal(revision.readOnly, true)
  assert.equal(toggleFeedbackRevision(revision, history, 'f1').expandedFeedback.f1, false)
  assert.deepEqual(toggleFeedbackRevision(revision, history, 'unknown'), {})
  assert.deepEqual(toggleFeedbackRevision(revision, history, '__proto__'), {})
  assert.deepEqual(toggleCompactSection(state, 'readOnly'), {})
  assert.equal(toggleCompactSection(state, 'reviewHistoryOpen').reviewHistoryOpen, true)
})

test('display values retain zero, false, selected values and multiline plain text', () => {
  const { compactValueText } = presentation()
  for (const [value, expected] of [[0, '0'], [false, '否'], [true, '是'], ['', '未填写'], [null, '未填写'], [undefined, '未填写'], [[], '未填写'], [['已选甲', '已选乙'], '已选甲、已选乙'], ['第一行\n<正文>', '第一行\n<正文>']]) {
    assert.equal(compactValueText(value), expected)
  }
})
