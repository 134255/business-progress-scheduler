const test = require('node:test')
const assert = require('node:assert/strict')

const {
  unique,
  isManager,
  isMember,
  canFeedback,
  canTransitionNode,
  calculateProgress,
  normalizeLineInput
} = require('../lib/domain')

test('角色权限按业务线隔离', () => {
  const line = { managerIds: ['manager'], memberIds: ['manager', 'viewer'] }
  const node = { assigneeIds: ['owner'] }
  assert.equal(isManager(line, 'manager'), true)
  assert.equal(isManager(line, 'viewer'), false)
  assert.equal(isMember(line, 'viewer'), true)
  assert.equal(isMember(line, 'outsider'), false)
  assert.equal(canFeedback(line, node, 'manager'), true)
  assert.equal(canFeedback(line, node, 'owner'), true)
  assert.equal(canFeedback(line, node, 'viewer'), false)
})
test('节点只能按允许路径流转', () => {
  assert.equal(canTransitionNode('pending', 'completed'), false)
  assert.equal(canTransitionNode('ready', 'in_progress'), true)
  assert.equal(canTransitionNode('ready', 'completed'), true)
  assert.equal(canTransitionNode('blocked', 'in_progress'), true)
  assert.equal(canTransitionNode('completed', 'in_progress'), false)
})

test('进度始终限制在 0 到 100', () => {
  assert.equal(calculateProgress(1, 3), 33)
  assert.equal(calculateProgress(3, 3), 100)
  assert.equal(calculateProgress(5, 3), 100)
  assert.equal(calculateProgress(-1, 3), 0)
  assert.equal(calculateProgress(1, 0), 0)
})

test('业务输入被标准化且数组去重', () => {
  assert.deepEqual(unique(['a', 'a', '', null, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeLineInput({ name: '  客户开户  ', code: ' bl-001 ', description: ' 说明 ' }), {
    name: '客户开户',
    code: 'BL-001',
    description: '说明',
    plannedStartDate: '',
    plannedEndDate: ''
  })
})
