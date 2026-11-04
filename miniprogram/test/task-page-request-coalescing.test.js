const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const root = path.resolve(__dirname, '../..')
const pages = [
  { name: 'business-detail', method: 'getBusinessLine', read: 'loadDetail' },
  { name: 'pending-processing', method: 'listMyPendingProcessing', read: 'refresh', key: 'nodeId' },
  { name: 'review-list', method: 'listMyPendingReviews', read: 'refresh', key: 'reviewRoundId' }
]

// Exercise the real page, presenters and error handling. Only the external
// service boundary and WeChat runtime are controlled; no product test hooks.
function harness(kind, synchronousFailure = false) {
  const app = { globalData: { currentUser: { _id: 'synthetic-reader', role: 'user', status: 'active' } } }
  const requests = [], redirects = [], toasts = []
  const business = { [kind.method](input) {
    requests.push({ input })
    if (synchronousFailure) throw new Error('synthetic-sync-failure')
    return new Promise((resolve, reject) => Object.assign(requests.at(-1), { resolve, reject }))
  } }
  const relative = `miniprogram/pages/${kind.name}/index.js`
  const filename = path.join(root, relative)
  const source = fs.readFileSync(path.join(process.env.TASK_PAGE_SOURCE_ROOT || root, relative), 'utf8')
  const realRequire = createRequire(filename)
  const wx = { reLaunch: input => redirects.push(input), showToast: input => toasts.push(input) }
  let definition
  vm.compileFunction(source, ['require', 'Page', 'getApp', 'wx'], { filename })(
    name => name === '../../services/business' ? business : realRequire(name),
    value => { definition = value }, () => app, wx
  )
  function newPage(lineId = 'line-1') {
    const page = { ...definition, data: structuredClone(definition.data),
      setData(update) { Object.assign(this.data, update) } }
    if (page.onLoad) page.onLoad({ id: lineId })
    return page
  }
  function result(marker, { hasMore = false, lineId = 'line-1' } = {}) {
    if (kind.name === 'business-detail') return {
      line: { _id: lineId, code: 'SYNTHETIC', name: 'Synthetic line', status: 'active', version: marker,
        currentNodeId: 'node-current', progress: 0, nodeCount: 1 },
      nodes: [], canManage: true, canEditNodes: false
    }
    return { items: [{ [kind.key]: `task-${marker}`, businessLineId: lineId, businessName: 'Synthetic line',
      nodeName: `Synthetic ${marker}`, status: kind.name === 'review-list' ? 'pending' : 'ready' }],
    cursor: hasMore ? 'synthetic-cursor' : '', page: 1, hasMore }
  }
  function marker(page) {
    return kind.name === 'business-detail' ? page.data.line && page.data.line.version
      : page.data.items[0] && page.data.items[0].nodeName
  }
  const want = number => kind.name === 'business-detail' ? number : `Synthetic ${number}`
  return { app, business, requests, redirects, toasts, newPage, page: newPage(), result, marker, want,
    read(page) { return (page || this.page)[kind.read]() } }
}

for (const kind of pages) {
  test(`${kind.name}: three same-generation loads share one request and its rendered result`, async () => {
    const h = harness(kind)
    const first = h.page.onShow(), second = h.read(), third = h.read()
    assert.equal(h.requests.length, 1)
    h.requests[0].resolve(h.result(3))
    await Promise.all([first, second, third])
    assert.equal(h.marker(h.page), h.want(3))
    assert.equal(h.page.data.loading, false)
  })

  test(`${kind.name}: success is not cached for a later ordinary refresh`, async () => {
    const h = harness(kind), first = h.page.onShow()
    h.requests[0].resolve(h.result(1)); await first
    const next = h.read()
    assert.equal(h.requests.length, 2)
    h.requests[1].resolve(h.result(2)); await next
    assert.equal(h.marker(h.page), h.want(2))
  })

  test(`${kind.name}: shared failure releases the slot without automatic retries`, async () => {
    const h = harness(kind), first = h.page.onShow(), second = h.read(), third = h.read()
    assert.equal(h.requests.length, 1)
    h.requests[0].reject(new Error('synthetic-network-failure'))
    await Promise.all([first, second, third])
    assert.equal(h.page.data.loading, false)
    assert.ok(h.page.data.errorMessage)
    const next = h.read()
    assert.equal(h.requests.length, 2)
    h.requests[1].resolve(h.result(4)); await next
    assert.equal(h.marker(h.page), h.want(4))
    assert.equal(h.page.data.errorMessage, '')
  })

  test(`${kind.name}: every show starts a fresh read without requiring a hide event`, async () => {
    const h = harness(kind), old = h.page.onShow(), current = h.page.onShow()
    assert.equal(h.requests.length, 2)
    h.requests[1].resolve(h.result(4)); await current
    h.requests[0].reject(new Error('synthetic-late-denial')); await old
    assert.equal(h.marker(h.page), h.want(4))
    assert.equal(h.page.data.errorMessage, '')
    assert.equal(h.page.data.loading, false)
  })

  for (const identity of ['role', 'session']) {
    test(`${kind.name}: ${identity} change cannot join the old request or release the newer one`, async () => {
      const h = harness(kind), old = h.page.onShow()
      if (identity === 'role') h.app.globalData.currentUser.role = 'super_admin'
      else h.app.globalData.currentUser = { ...h.app.globalData.currentUser }
      const current = h.read()
      assert.equal(h.requests.length, 2)
      h.requests[0].resolve(h.result(99)); await old
      assert.notEqual(h.marker(h.page), h.want(99))
      assert.equal(h.page.data.loading || h.page.data.refreshing, true)
      const joined = h.read()
      assert.equal(h.requests.length, 2)
      h.requests[1].resolve(h.result(5)); await Promise.all([current, joined])
      assert.equal(h.marker(h.page), h.want(5))
    })
  }

  for (const lifecycle of ['onHide', 'onUnload']) {
    test(`${kind.name}: ${lifecycle} prevents the old response from entering the hidden page`, async () => {
      const h = harness(kind), old = h.page.onShow()
      if (h.page[lifecycle]) h.page[lifecycle]()
      h.requests[0].resolve(h.result(99)); await old
      assert.notEqual(h.marker(h.page), h.want(99))
      const current = h.page.onShow(), joined = h.read()
      assert.equal(h.requests.length, 2)
      h.requests[1].resolve(h.result(6)); await Promise.all([current, joined])
      assert.equal(h.marker(h.page), h.want(6))
    })
  }

  test(`${kind.name}: an old finally does not release a pending newer show`, async () => {
    const h = harness(kind), old = h.page.onShow(), current = h.page.onShow()
    h.requests[0].reject(new Error('synthetic-old-failure')); await old
    const joined = h.read()
    assert.equal(h.requests.length, 2)
    assert.equal(h.page.data.loading || h.page.data.refreshing, true)
    h.requests[1].resolve(h.result(7)); await Promise.all([current, joined])
    assert.equal(h.marker(h.page), h.want(7))
    assert.equal(h.page.data.errorMessage, '')
  })

  test(`${kind.name}: invalidation survives restoring the exact same account object`, async () => {
    const h = harness(kind), actor = h.app.globalData.currentUser, old = h.page.onShow()
    actor.status = 'disabled'
    await h.read()
    assert.equal(h.redirects.length, 1)
    actor.status = 'active'
    h.requests[0].resolve(h.result(99)); await old
    assert.notEqual(h.marker(h.page), h.want(99))
    const next = h.page.onShow()
    assert.equal(h.requests.length, 2)
    h.requests[1].resolve(h.result(8)); await next
    assert.equal(h.marker(h.page), h.want(8))
  })

  test(`${kind.name}: separate page instances do not share requests`, async () => {
    const h = harness(kind), other = h.newPage(), first = h.page.onShow(), second = other.onShow()
    assert.equal(h.requests.length, 2)
    h.requests[0].resolve(h.result(1)); h.requests[1].resolve(h.result(2))
    await Promise.all([first, second])
    assert.equal(h.marker(h.page), h.want(1)); assert.equal(h.marker(other), h.want(2))
  })

  test(`${kind.name}: synchronous service errors never leave a reusable settled slot`, async () => {
    const h = harness(kind, true)
    await h.page.onShow(); await h.read()
    assert.equal(h.requests.length, 2)
    assert.equal(h.page.data.loading, false)
    assert.ok(h.page.data.errorMessage)
  })
}

test('business-detail: different line targets cannot share requests or receive each other results', async () => {
  const h = harness(pages[0]), old = h.page.onShow()
  h.page.setData({ id: 'line-2' })
  const current = h.read(), joined = h.read()
  assert.equal(h.requests.length, 2)
  assert.deepEqual(h.requests.map(item => item.input), ['line-1', 'line-2'])
  h.requests[1].resolve(h.result(2, { lineId: 'line-2' })); await Promise.all([current, joined])
  h.requests[0].resolve(h.result(99)); await old
  assert.equal(h.page.data.line._id, 'line-2'); assert.equal(h.marker(h.page), 2)
})

for (const kind of pages.slice(1)) {
  test(`${kind.name}: switching accounts starts a separate read and ignores the former account`, async () => {
    const h = harness(kind), old = h.page.onShow()
    h.app.globalData.currentUser = { _id: 'synthetic-other', role: 'user', status: 'active' }
    const current = h.read(), joined = h.read()
    assert.equal(h.requests.length, 2)
    h.requests[1].resolve(h.result(2)); await Promise.all([current, joined])
    h.requests[0].resolve(h.result(99)); await old
    assert.equal(h.marker(h.page), h.want(2))
  })

  test(`${kind.name}: clearing cards invalidates a pending response before another request starts`, async () => {
    const h = harness(kind), old = h.page.onShow()
    h.page.clearCards()
    h.requests[0].resolve(h.result(99)); await old
    assert.deepEqual(h.page.data.items, [])
  })

  test(`${kind.name}: first-page refresh never joins pagination or appends its late results`, async () => {
    const h = harness(kind), first = h.page.onShow()
    h.requests[0].resolve(h.result(1, { hasMore: true })); await first
    const more = h.page.loadMore(), current = h.read(), joined = h.read()
    assert.equal(h.requests.length, 3)
    assert.deepEqual(h.requests[1].input, kind.name === 'pending-processing'
      ? { cursor: 'synthetic-cursor', pageSize: 20 } : { page: 2, pageSize: 20 })
    h.requests[2].resolve(h.result(2)); await Promise.all([current, joined])
    h.requests[1].resolve(h.result(99)); await more
    assert.equal(h.marker(h.page), h.want(2))
    assert.equal(h.page.data.items.length, 1)
    assert.equal(h.page.data.loadingMore, false)
  })
}

for (const action of [
  { entry: 'closeLine', service: 'closeBusinessLine' },
  { entry: 'rejectPrevious', service: 'rejectPreviousNode' },
  { entry: 'confirmRouteDecision', service: 'decideNodeRoute' },
  { entry: 'confirmOptionalDecision', service: 'decideOptionalTailNode' }
]) {
  for (const conflict of [false, true]) {
    test(`business-detail: ${action.entry} ${conflict ? 'version conflict' : 'success'} forces a post-operation read`, async () => {
      const h = harness(pages[0]), old = h.page.onShow()
      let writes = 0
      h.business[action.service] = async () => {
        writes++
        if (conflict) throw Object.assign(new Error('synthetic-conflict'), { code: 'VERSION_CONFLICT' })
      }
      h.page.setData({ line: { _id: 'line-1', version: 1, status: 'active' }, canClose: true,
        closureReason: 'Synthetic reason', canRejectPrevious: true, rejectionReason: 'Synthetic reason',
        currentNode: { _id: 'node-current', version: 3, canDecideNodeRoute: true, canDecideOptionalTail: true },
        previousNode: { _id: 'node-previous', version: 2 },
        routeDecisionPanelOpen: true, routeDecision: 'activate', routeDecisionComment: '',
        optionalDecisionPanelOpen: true, optionalDecision: 'activate', optionalDecisionComment: '' })
      const actionResult = h.page[action.entry]()
      await new Promise(setImmediate)
      assert.equal(writes, 1)
      assert.equal(h.requests.length, 2, 'must not join the pre-operation read')
      const joined = h.read()
      assert.equal(h.requests.length, 2)
      h.requests[1].resolve(h.result(2)); await Promise.all([actionResult, joined])
      h.requests[0].resolve(h.result(99)); await old
      assert.equal(h.marker(h.page), 2)
    })
  }
}

for (const action of [
  { entry: 'closeLine', service: 'closeBusinessLine', busy: 'closing' },
  { entry: 'rejectPrevious', service: 'rejectPreviousNode', busy: 'rejecting' },
  { entry: 'confirmRouteDecision', service: 'decideNodeRoute', busy: 'routeDecisionSubmitting' },
  { entry: 'confirmOptionalDecision', service: 'decideOptionalTailNode', busy: 'optionalDecisionSubmitting' }
]) {
  test(`business-detail: hiding during ${action.entry} does not leave its action permanently busy`, async () => {
    const h = harness(pages[0]), initial = h.page.onShow()
    h.requests[0].resolve(h.result(1)); await initial
    let finish
    h.business[action.service] = () => new Promise(resolve => { finish = resolve })
    h.page.setData({ canClose: true, closureReason: 'Synthetic reason', canRejectPrevious: true,
      rejectionReason: 'Synthetic reason', currentNode: { _id: 'node-current', version: 3,
        canDecideNodeRoute: true, canDecideOptionalTail: true }, previousNode: { _id: 'node-previous', version: 2 },
      routeDecisionPanelOpen: true, routeDecision: 'activate', routeDecisionComment: '',
      optionalDecisionPanelOpen: true, optionalDecision: 'activate', optionalDecisionComment: '' })
    const actionResult = h.page[action.entry]()
    assert.equal(h.page.data[action.busy], true)
    if (h.page.onHide) h.page.onHide()
    finish({})
    await new Promise(setImmediate)
    // The original control has no read-hide boundary and may start a read.
    // Settle it as well so this regression checks the action cleanup itself.
    if (h.requests.length > 1) h.requests.at(-1).resolve(h.result(2))
    await actionResult
    assert.equal(h.page.data[action.busy], false)
    const count = h.requests.length, current = h.page.onShow()
    assert.equal(h.requests.length, count + 1)
    h.requests.at(-1).resolve(h.result(3)); await current
    assert.equal(h.marker(h.page), 3)
  })
}
