const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FLOW_SCHEMA_VERSION,
  NEXT_MODE,
  normalizeWorkflowGraph,
  validateWorkflowGraph,
  resolveCompletedNodeTarget
} = require('../lib/workflow-routing-domain')

function select(fieldKey, options, condition) {
  return {
    fieldKey,
    sequence: 0,
    name: fieldKey,
    description: '',
    type: 'single_select',
    required: true,
    constraints: { options },
    ...(condition ? { condition } : {})
  }
}

function node(nodeKey, next, fields = []) {
  return { nodeKey, fields, next }
}

function assertTemplateInvalid(operation) {
  assert.throws(operation, error => error && error.code === 'TEMPLATE_INVALID')
}

test('normalizes nested branches and allows mutually exclusive routes to converge', () => {
  const graph = normalizeWorkflowGraph({
    flowSchemaVersion: 2,
    entryNodeKey: 'entry',
    nodes: [
      node('entry', {
        mode: 'single_select', fieldKey: 'kind',
        optionTargets: { 简单: 'merge', 复杂: 'nested' }
      }, [select('kind', ['简单', '复杂'])]),
      node('nested', { mode: 'default', targetNodeKey: 'merge' }),
      node('merge', { mode: 'end' })
    ]
  })

  assert.equal(graph.flowSchemaVersion, FLOW_SCHEMA_VERSION)
  assert.equal(NEXT_MODE.SINGLE_SELECT, 'single_select')
  assert.deepEqual(graph.nodes.map(item => item.nodeKey), ['entry', 'nested', 'merge'])
  assert.equal(validateWorkflowGraph(graph), true)
})

test('normalizes manual activate and skip targets including explicit end', () => {
  const graph = normalizeWorkflowGraph({
    flowSchemaVersion: 2,
    entryNodeKey: 'entry',
    nodes: [
      node('entry', { mode: 'manual', activateTarget: 'optional', skipTarget: 'end' }),
      node('optional', { mode: 'end' })
    ]
  })
  assert.deepEqual(graph.nodes[0].next, {
    mode: 'manual', activateTarget: 'optional', skipTarget: 'end'
  })
})

test('rejects unknown targets, incomplete mappings, invalid routing fields and inaccessible nodes', () => {
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'entry',
    nodes: [node('entry', { mode: 'default', targetNodeKey: 'missing' })]
  }))
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'entry',
    nodes: [node('entry', { mode: 'single_select', fieldKey: 'kind', optionTargets: { 简单: 'end' } }, [select('kind', ['简单', '复杂'])])]
  }))
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'entry',
    nodes: [node('entry', { mode: 'single_select', fieldKey: 'kind', optionTargets: { 简单: 'end' } }, [
      { ...select('kind', ['简单']), required: false }
    ])]
  }))
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'entry',
    nodes: [node('entry', { mode: 'end' }), node('orphan', { mode: 'end' })]
  }))
})

test('rejects self loops, longer cycles, duplicate keys and absent entry nodes', () => {
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'entry',
    nodes: [node('entry', { mode: 'default', targetNodeKey: 'entry' })]
  }))
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'a',
    nodes: [node('a', { mode: 'default', targetNodeKey: 'b' }), node('b', { mode: 'default', targetNodeKey: 'a' })]
  }))
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'a',
    nodes: [node('a', { mode: 'end' }), node('a', { mode: 'end' })]
  }))
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'missing', nodes: [node('a', { mode: 'end' })]
  }))
})

test('never executes node or routing accessors while validating workflow data', () => {
  let calls = 0
  const entry = node('entry', { mode: 'end' })
  Object.defineProperty(entry, 'description', {
    enumerable: true,
    get() {
      calls += 1
      return 'unsafe'
    }
  })
  assertTemplateInvalid(() => normalizeWorkflowGraph({
    flowSchemaVersion: 2, entryNodeKey: 'entry', nodes: [entry]
  }))
  assert.equal(calls, 0)
})

test('accepts 48 reachable nodes and rejects 49', () => {
  function chain(count) {
    return Array.from({ length: count }, (_, index) => node(
      `n-${index}`,
      index === count - 1 ? { mode: 'end' } : { mode: 'default', targetNodeKey: `n-${index + 1}` }
    ))
  }
  assert.equal(normalizeWorkflowGraph({ flowSchemaVersion: 2, entryNodeKey: 'n-0', nodes: chain(48) }).nodes.length, 48)
  assertTemplateInvalid(() => normalizeWorkflowGraph({ flowSchemaVersion: 2, entryNodeKey: 'n-0', nodes: chain(49) }))
})

test('resolves end, default, single-select and manual outcomes from final values', () => {
  assert.deepEqual(resolveCompletedNodeTarget({ node: node('a', { mode: 'end' }), fieldValues: [] }), { kind: 'end' })
  assert.deepEqual(resolveCompletedNodeTarget({ node: node('a', { mode: 'default', targetNodeKey: 'b' }), fieldValues: [] }), { kind: 'node', nodeKey: 'b' })
  assert.deepEqual(resolveCompletedNodeTarget({
    node: node('a', { mode: 'single_select', fieldKey: 'kind', optionTargets: { 简单: 'b', 复杂: 'end' } }, [select('kind', ['简单', '复杂'])]),
    fieldValues: [{ fieldKey: 'kind', value: '复杂' }]
  }), { kind: 'end' })
  assert.deepEqual(resolveCompletedNodeTarget({ node: node('a', { mode: 'manual', activateTarget: 'b', skipTarget: 'end' }), fieldValues: [] }), { kind: 'manual' })
})

test('fails closed when a single-select route cannot be uniquely resolved', () => {
  const branch = node('a', {
    mode: 'single_select', fieldKey: 'kind', optionTargets: { 简单: 'b', 复杂: 'end' }
  }, [select('kind', ['简单', '复杂'])])
  assert.throws(() => resolveCompletedNodeTarget({ node: branch, fieldValues: [] }), error => error.code === 'BUSINESS_STATE_INVALID')
  assert.throws(() => resolveCompletedNodeTarget({ node: branch, fieldValues: [{ fieldKey: 'kind', value: '未知' }] }), error => error.code === 'BUSINESS_STATE_INVALID')
  assert.throws(() => resolveCompletedNodeTarget({ node: branch, fieldValues: [
    { fieldKey: 'kind', value: '简单' }, { fieldKey: 'kind', value: '复杂' }
  ] }), error => error.code === 'BUSINESS_STATE_INVALID')
})

test('resolves immutable snapshot node ids for every non-manual completion mode', () => {
  const fieldDefinitions = [select('route', ['A', 'B'])]
  assert.deepEqual(resolveCompletedNodeTarget({
    node: { fieldDefinitions, next: { mode: 'end' } }, fieldValues: []
  }), { kind: 'end' })
  assert.deepEqual(resolveCompletedNodeTarget({
    node: { fieldDefinitions, next: { mode: 'default', targetNodeId: 'line-node-2' } }, fieldValues: []
  }), { kind: 'node', nodeId: 'line-node-2' })
  assert.deepEqual(resolveCompletedNodeTarget({
    node: {
      fieldDefinitions,
      next: {
        mode: 'single_select', fieldKey: 'route',
        optionTargets: { A: 'line-node-2', B: 'end' }
      }
    },
    fieldValues: [{ fieldKey: 'route', name: '路线', type: 'single_select', value: 'A' }]
  }), { kind: 'node', nodeId: 'line-node-2' })
})

test('snapshot routing rejects malformed target ids and unapproved field values', () => {
  const fieldDefinitions = [select('route', ['A', 'B'])]
  assert.throws(() => resolveCompletedNodeTarget({
    node: { fieldDefinitions, next: { mode: 'default', targetNodeId: 'end' } }, fieldValues: []
  }), error => error.code === 'BUSINESS_STATE_INVALID')
  assert.throws(() => resolveCompletedNodeTarget({
    node: {
      fieldDefinitions,
      next: { mode: 'single_select', fieldKey: 'route', optionTargets: { A: 'node-a', B: 'end' } }
    },
    fieldValues: [{ fieldKey: 'route', name: '路线', type: 'single_select', value: '未知' }]
  }), error => error.code === 'BUSINESS_STATE_INVALID')
})
