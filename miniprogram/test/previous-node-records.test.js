const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const componentPath = path.resolve(__dirname, '../components/previous-node-records/index.js')
const servicePath = require.resolve('../services/business')
const user = { _id: 'member', status: 'active', role: 'user' }
const detail = { line: { _id: 'line', flowSchemaVersion: 2, traversedNodeIds: ['earlier-2', 'earlier-1'], currentNodeId: 'current' }, nodes: [
  { _id: 'earlier-2', name: '前二', status: 'completed', routeState: 'completed', sequence: 8, workflowMode: 'review' },
  { _id: 'skipped', name: '跳过', status: 'completed', routeState: 'skipped', sequence: 0 },
  { _id: 'earlier-1', name: '前一', status: 'completed', routeState: 'completed', sequence: 1, workflowMode: 'review' },
  { _id: 'current', status: 'in_progress', sequence: 2 } ] }

function harness(overrides = {}) {
  let current = { ...user }, definition
  const calls = []
  const services = {
    async getBusinessLine() { calls.push('list'); return structuredClone(detail) },
    async getPreviousNodeResult(input) { calls.push(['final', input]); return { nodeId: input.nodeId, fieldValues: [{ fieldKey: 'zero', name: '数量', value: 0 }, { fieldKey: 'bool', name: '确认', value: false }], evidences: [], votes: [] } },
    async getNodeHistory() { calls.push('history'); return { history: [{ feedbackId: 'save', comment: '原文', submittedAt: '2026-09-01', fieldValues: [], evidences: [] }] } },
    async listNodeReviewHistory() { calls.push('reviews'); return { items: [], hasMore: false } },
    ...overrides
  }
  const previousService = require.cache[servicePath]
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: services }
  global.getApp = () => ({ globalData: { currentUser: current } })
  global.wx = { showToast() {}, previewImage() {}, downloadFile() {}, openDocument() {} }
  global.Component = value => { definition = value }
  delete require.cache[componentPath]
  require(componentPath)
  require.cache[servicePath] = previousService
  const component = { data: { ...structuredClone(definition.data), businessLineId: 'line', nodeId: 'current', enabled: true },
    ...definition.methods, setData(value, callback) { Object.assign(this.data, value); if (callback) callback() },
    triggerEvent(name) { calls.push(['event', name]) } }
  definition.lifetimes.attached.call(component)
  return { component, calls, definition, setUser(value) { current = value } }
}
const tap = id => ({ currentTarget: { dataset: { id } } })
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }

test('collapsed section performs no network reads; expansion follows actual route, not sequence or skipped nodes', async () => {
  const { component: c, calls } = harness()
  assert.deepEqual(calls, [])
  await c.toggleSection()
  assert.deepEqual(c.data.nodes.map(n => n._id), ['earlier-2', 'earlier-1'])
  assert.deepEqual(calls, ['list'])
  await c.toggleNode(tap('earlier-1'))
  assert.equal(c.data.result.fields[0].valueText, '0')
  assert.equal(c.data.result.fields[1].valueText, '否')
  assert.equal(calls.includes('history'), false)
  await c.toggleHistory()
  assert.equal(calls.includes('history'), true)
  assert.equal(calls.includes('reviews'), false)
  await c.toggleReviews()
  assert.equal(calls.includes('reviews'), true)
})

test('a late result cannot replace a newly selected node', async () => {
  const late = deferred()
  const { component: c } = harness({ async getPreviousNodeResult(input) { return input.nodeId === 'earlier-2' ? late.promise : { nodeId: input.nodeId, fieldValues: [] } } })
  await c.toggleSection()
  const old = c.toggleNode(tap('earlier-2'))
  await c.toggleNode(tap('earlier-1'))
  late.resolve({ nodeId: 'earlier-2', processingComment: 'old' })
  await old
  assert.equal(c.data.result.nodeId, 'earlier-1')
})

test('account switch, parent access revocation, and page hide invalidate late reads and clear private state', async () => {
  for (const mode of ['account', 'parent', 'hide', 'detach']) {
    const late = deferred()
    const h = harness({ getPreviousNodeResult: () => late.promise })
    const c = h.component
    await c.toggleSection()
    const pending = c.toggleNode(tap('earlier-1'))
    if (mode === 'account') h.setUser({ ...user, _id: 'another' })
    if (mode === 'parent') { c.data.enabled = false; h.definition.observers['businessLineId, nodeId, enabled'].call(c) }
    if (mode === 'hide') h.definition.pageLifetimes.hide.call(c)
    if (mode === 'detach') h.definition.lifetimes.detached.call(c)
    late.resolve({ nodeId: 'earlier-1', processingComment: 'private' })
    await pending
    assert.equal(c.data.result, null, mode)
    assert.deepEqual(c.data.history, [], mode)
  }
})

test('retry final failure and history loading are independent and never write to parent draft', async () => {
  let tries = 0
  const { component: c } = harness({ async getPreviousNodeResult() { if (++tries === 1) throw new Error('network'); return { nodeId: 'earlier-1', fieldValues: [] } } })
  c.parentDraft = { comment: '未提交意见', fieldValues: { example: '未保存' }, files: ['upload'] }
  const before = structuredClone(c.parentDraft)
  await c.toggleSection(); await c.toggleNode(tap('earlier-1'))
  assert.ok(c.data.resultError)
  await c.toggleHistory()
  assert.equal(c.data.history[0].comment, '原文')
  await c.loadResult()
  assert.equal(c.data.result.nodeId, 'earlier-1')
  assert.deepEqual(c.parentDraft, before)
})

test('closing history prevents a late evidence grant from opening the now-hidden attachment', async () => {
  const grant = deferred()
  const { component: c } = harness({ getEvidenceAccess: () => grant.promise,
    async getNodeHistory() { return { history: [{ feedbackId: 'f', evidences: [{ evidenceId: 'e', storageStatus: 'available' }] }] } } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleHistory()
  c.toggleEntry(tap('f'))
  const opening = c.previewEvidence(tap('e'))
  await c.toggleHistory()
  grant.resolve({ category: 'video', url: 'https://example.invalid/synthetic' })
  await opening
  assert.equal(c.data.videoPreview, null)
})

test('review history paging preserves earlier pages and final result, and uses the returned cursor', async () => {
  const queries = []
  const { component: c } = harness({ async listNodeReviewHistory(query) {
    queries.push(query)
    const number = query.beforeRoundNumber ? 1 : 6
    return { items: [{ reviewRoundId: `r${number}`, reviewRoundNumber: number, votes: [] }], hasMore: number > 1, nextBeforeRoundNumber: number }
  } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleReviews(); await c.loadMoreReviews()
  assert.deepEqual(c.data.rounds.map(r => r.reviewRoundNumber), [6, 1])
  assert.equal(queries[1].beforeRoundNumber, 6)
  assert.equal(c.data.result.nodeId, 'earlier-1')
})

test('legacy preceding nodes retain feedback history without calling the forbidden review history API', async () => {
  const { component: c, calls } = harness({ async getBusinessLine() {
    const result = structuredClone(detail); result.nodes[2].workflowMode = 'legacy'; return result
  }, async listNodeReviewHistory() { throw Object.assign(new Error('not review workflow'), { code: 'FORBIDDEN' }) } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleHistory()
  await c.toggleReviews()
  assert.equal(c.data.opened, true)
  assert.equal(c.data.history[0].comment, '原文')
  assert.equal(c.data.rounds.length, 0)
})

test('processing and review histories load independently; each entry starts folded and reopening an entry needs no read', async () => {
  const { component: c, calls } = harness({ async listNodeReviewHistory() {
    return { items: [{ reviewRoundId: 'r1', votes: [{ decision: 'approved', comment: '意见' }] }] }
  } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleHistory()
  assert.equal(c.data.history[0].opened, false)
  assert.equal(c.data.reviewsOpen, false)
  c.toggleEntry(tap('save'))
  assert.equal(c.data.history[0].opened, true)
  c.toggleEntry(tap('save')); c.toggleEntry(tap('save'))
  assert.equal(calls.filter(call => call === 'history').length, 1)
  await c.toggleReviews()
  assert.equal(c.data.rounds[0].opened, false)
  c.toggleRound(tap('r1'))
  assert.equal(c.data.rounds[0].opened, true)
  assert.equal(c.data.history[0].opened, true)
})

test('a processing-history failure cannot suppress successful review history or its independent retry', async () => {
  let attempts = 0
  const { component: c } = harness({ async getNodeHistory() {
    if (++attempts === 1) throw new Error('network')
    return { history: [{ feedbackId: 'f', fieldValues: [], evidences: [] }] }
  }, async listNodeReviewHistory() { return { items: [{ reviewRoundId: 'r1', votes: [] }] } } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleHistory(); await c.toggleReviews()
  assert.ok(c.data.historyError)
  assert.equal(c.data.reviewsError, '')
  assert.equal(c.data.rounds.length, 1)
  await c.loadHistory()
  assert.equal(c.data.history.length, 1)
  assert.equal(c.data.rounds.length, 1)
})

test('retrying a failed next review page preserves loaded pages and retries the same cursor', async () => {
  const cursors = []
  const { component: c } = harness({ async listNodeReviewHistory(query) {
    cursors.push(query.beforeRoundNumber)
    if (cursors.length === 2) throw new Error('network')
    return query.beforeRoundNumber ? { items: [{ reviewRoundId: 'r1', votes: [] }], hasMore: false }
      : { items: [{ reviewRoundId: 'r6', votes: [] }], hasMore: true, nextBeforeRoundNumber: 6 }
  } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleReviews(); await c.loadMoreReviews()
  assert.ok(c.data.reviewsError)
  assert.deepEqual(c.data.rounds.map(r => r.reviewRoundId), ['r6'])
  await c.loadMoreReviews()
  assert.deepEqual(cursors, [undefined, 6, 6])
  assert.deepEqual(c.data.rounds.map(r => r.reviewRoundId), ['r6', 'r1'])
})

test('closing one saved entry invalidates an in-flight attachment grant; hidden entries cannot open attachments', async () => {
  const grant = deferred(); const requested = []
  const { component: c } = harness({ getEvidenceAccess: id => { requested.push(id); return grant.promise },
    async getNodeHistory() { return { history: [{ feedbackId: 'f', evidences: [{ evidenceId: 'e', storageStatus: 'available' }] }] } } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleHistory()
  const hidden = c.previewEvidence(tap('e'))
  assert.deepEqual(requested, [])
  await hidden
  c.toggleEntry(tap('f'))
  const opening = c.previewEvidence(tap('e'))
  c.toggleEntry(tap('f'))
  grant.resolve({ category: 'video', url: 'https://example.invalid/video' }); await opening
  assert.equal(c.data.videoPreview, null)
  assert.equal(c.data.previewLoading, false)
})

test('video preview has an explicit pending state, can be cancelled, and reports native playback errors', async () => {
  const grant = deferred(); const notices = []
  const { component: c } = harness({ getEvidenceAccess: () => grant.promise,
    async getPreviousNodeResult(input) { return { nodeId: input.nodeId, evidences: [{ evidenceId: 'e', storageStatus: 'available' }] } } })
  wx.showToast = data => notices.push(data.title)
  await c.toggleSection(); await c.toggleNode(tap('earlier-1'))
  const opening = c.previewEvidence(tap('e'))
  assert.equal(c.data.previewLoading, true)
  c.closeVideo()
  grant.resolve({ category: 'video', url: 'https://example.invalid/video' }); await opening
  assert.equal(c.data.videoPreview, null)
  await c.previewEvidence(tap('e'))
  assert.equal(c.data.videoPreview.category, 'video')
  c.onVideoError()
  assert.equal(c.data.videoPreview, null)
  assert.equal(notices.length, 1)
})

for (const code of ['FORBIDDEN', 'ACCOUNT_DISABLED']) {
  test(`cancelled preview still clears same-context records when its late response is ${code}`, async () => {
    const grant = deferred()
    const { component: c } = harness({ getEvidenceAccess: () => grant.promise,
      async getPreviousNodeResult(input) { return { nodeId: input.nodeId, evidences: [{ evidenceId: 'e', storageStatus: 'available' }] } } })
    await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleHistory(); await c.toggleReviews()
    const opening = c.previewEvidence(tap('e'))
    c.closeVideo()
    grant.reject(Object.assign(new Error('denied'), { code })); await opening
    assert.equal(c.data.opened, false)
    assert.equal(c.data.result, null)
    assert.deepEqual(c.data.history, [])
    assert.deepEqual(c.data.rounds, [])
  })
}

test('a cancelled old-node preview denial cannot clear the newly selected node', async () => {
  const grant = deferred()
  const { component: c } = harness({ getEvidenceAccess: () => grant.promise,
    async getPreviousNodeResult(input) { return { nodeId: input.nodeId, evidences: [{ evidenceId: 'e', storageStatus: 'available' }] } } })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1'))
  const opening = c.previewEvidence(tap('e'))
  c.closeVideo(); await c.toggleNode(tap('earlier-2'))
  grant.reject(Object.assign(new Error('denied'), { code: 'FORBIDDEN' })); await opening
  assert.equal(c.data.opened, true)
  assert.equal(c.data.result.nodeId, 'earlier-2')
})

test('return to current form collapses records before emitting a navigation-only event and invalidates pending reads', async () => {
  const late = deferred()
  const { component: c, calls } = harness({ getNodeHistory: () => late.promise })
  await c.toggleSection(); await c.toggleNode(tap('earlier-1'))
  const pending = c.toggleHistory()
  c.returnToCurrent()
  assert.equal(c.data.opened, false)
  assert.equal(c.data.result, null)
  assert.deepEqual(calls.at(-1), ['event', 'returntocurrent'])
  late.resolve({ history: [{ feedbackId: 'private' }] }); await pending
  assert.deepEqual(c.data.history, [])
})

test('collapsing and reopening the whole section revalidates instead of rendering cached private content', async () => {
  const { component: c, calls } = harness()
  await c.toggleSection(); await c.toggleNode(tap('earlier-1')); await c.toggleSection(); await c.toggleSection()
  assert.equal(calls.filter(call => call === 'list').length, 2)
  assert.equal(c.data.result, null)
  assert.equal(c.data.selectedId, '')
})

for (const name of ['node-feedback', 'review-detail']) {
  test(`${name} return event only scrolls to the current form and preserves real page draft/upload/approval state`, () => {
    harness()
    let page
    global.Page = definition => { page = definition }
    const file = require.resolve(`../pages/${name}/index.js`)
    delete require.cache[file]; require(file); delete global.Page
    page.data = { ...structuredClone(page.data), previousRecordsEnabled: true, comment: '未提交意见',
      fieldValues: { model: '未保存型号' }, draftDirty: true, files: [{ localId: 'uploading', progress: 42 }], submitting: false }
    page.pageAlive = true; page.actorId = user._id; page.loadActorId = user._id
    page.setData = update => Object.assign(page.data, update)
    const before = structuredClone(page.data), scrolls = []
    wx.pageScrollTo = options => scrolls.push(options.selector)
    page.returnToCurrentForm()
    assert.deepEqual(scrolls, ['#current-node-form'])
    assert.deepEqual(page.data, before)
    page.pageAlive = false; page.returnToCurrentForm()
    assert.equal(scrolls.length, 1)
  })
}
