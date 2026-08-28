const test = require('node:test')
const assert = require('node:assert/strict')

const { createNodeWorkspaceService } = require('../lib/node-workspace-service')

function deferred() {
  let resolve
  const promise = new Promise(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

test('node workspace starts authorized detail and history reads together and selects the requested node', async () => {
  const detail = deferred()
  const history = deferred()
  const calls = []
  const actor = { _id: 'account-1', status: 'active' }
  const service = createNodeWorkspaceService({
    businessService: {
      getBusinessLine(input) { calls.push(['detail', input]); return detail.promise }
    },
    feedbackService: {
      getNodeHistory(input) { calls.push(['history', input]); return history.promise }
    }
  })

  const pending = service.getNodeWorkspace({ actor, businessLineId: 'line-1', nodeId: 'node-2' })
  assert.deepEqual(calls.map(([name]) => name), ['detail', 'history'])
  detail.resolve({
    line: { _id: 'line-1', version: 4, status: 'active' },
    nodes: [{ _id: 'node-1' }, { _id: 'node-2', version: 3, name: '处理' }],
    canManage: false
  })
  history.resolve({
    node: { id: 'node-2', name: '处理', status: 'ready' },
    canSubmit: true,
    history: [{ feedbackId: 'feedback-1' }]
  })

  assert.deepEqual(await pending, {
    line: { _id: 'line-1', version: 4, status: 'active' },
    node: { _id: 'node-2', version: 3, name: '处理' },
    canSubmit: true,
    history: [{ feedbackId: 'feedback-1' }]
  })
  assert.deepEqual(calls, [
    ['detail', { actor, lineId: 'line-1' }],
    ['history', { actor, businessLineId: 'line-1', nodeId: 'node-2' }]
  ])
})

test('node workspace fails closed when the detail does not contain the requested node', async () => {
  const service = createNodeWorkspaceService({
    businessService: {
      async getBusinessLine() { return { line: { _id: 'line-1' }, nodes: [{ _id: 'node-other' }] } }
    },
    feedbackService: {
      async getNodeHistory() { return { node: { id: 'node-1' }, canSubmit: true, history: [] } }
    }
  })
  await assert.rejects(
    service.getNodeWorkspace({ actor: { _id: 'account-1' }, businessLineId: 'line-1', nodeId: 'node-1' }),
    error => error && error.code === 'NOT_FOUND'
  )
})
