const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const activeUser = id => ({ _id: id, status: 'active', role: 'user' })
const tick = () => new Promise(resolve => setImmediate(resolve))
const emptyHistory = () => ({ items: [], hasMore: false, nextBeforeRoundNumber: null })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixtureRound(number = 2, overrides = {}) {
  return {
    reviewRoundId: `round-${number}`, reviewRoundNumber: number, processingRoundNumber: number,
    status: 'rejected', submittedAt: '2026-09-20T01:00:00.000Z',
    votes: [
      { reviewerDisplayName: '审核甲', decision: 'approved', comment: '第一行\n<说明>&正文', createdAt: '2026-09-20T02:00:00.000Z' },
      { reviewerDisplayName: '审核乙', decision: 'rejected', comment: '请补充资料', createdAt: '2026-09-20T03:00:00.000Z' },
      { reviewerDisplayName: '审核丙', decision: 'approved', comment: ' \n\t', createdAt: '2026-09-20T04:00:00.000Z' }
    ], ...overrides
  }
}
function workspace(status = 'in_progress', lineStatus = 'active', canSubmit = true) {
  return {
    line: { _id: 'line-synthetic', status: lineStatus, version: 7 }, canSubmit, history: [],
    node: {
      _id: 'node-synthetic', name: '合成节点', nodeCode: 'SYN-N001', version: 3, status,
      workflowMode: 'review', requiresReview: true, reviewMode: 'all',
      processingRoundNumber: 2, reviewRoundNumber: 2, processorDisplayNames: ['处理甲'],
      reviewerDisplayNames: ['审核甲', '审核乙'], requiresEvidence: false,
      allowedEvidenceTypes: [], fieldDefinitions: [], reviewDueStatus: 'not_started'
    }
  }
}
function requireWithService(relative, service) {
  const servicePath = require.resolve(path.join(root, 'services/business.js'))
  const original = require.cache[servicePath]
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: service }
  const target = require.resolve(path.join(root, relative))
  try { delete require.cache[target]; return require(target) } finally {
    delete require.cache[target]
    if (original) require.cache[servicePath] = original
    else delete require.cache[servicePath]
  }
}
function setup(service = {}, relative = 'pages/node-feedback/index.js') {
  const app = { globalData: { currentUser: activeUser('member-synthetic') } }
  const toasts = [], redirects = []
  global.getApp = () => app
  global.wx = {
    setNavigationBarTitle() {}, showToast: value => toasts.push(value),
    showLoading() {}, hideLoading() {},
    reLaunch: value => redirects.push(value)
  }
  let definition
  global.Page = value => { definition = value }
  try {
    requireWithService(relative, {
      getNodeWorkspace: async () => workspace(), listNodeReviewHistory: async () => emptyHistory(),
      submitReviewVote: () => assert.fail('Read-only history must never vote'), ...service
    })
  } finally { delete global.Page }
  const page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update) } }
  return { page, app, toasts, redirects }
}
async function open(context) {
  await context.page.onLoad({ lineId: 'line-synthetic', nodeId: 'node-synthetic' })
  await tick()
  return context
}

// Evaluate the actual WXML bindings, loops and conditionals against live page data.
// This tests our view contract; it does not emulate native layout or device rendering.
function view(relative, data) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  const tree = { children: [] }, stack = [tree]
  const tokens = source.match(/<!--[^]*?-->|<\/?[\w-]+\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?>|[^<]+/g) || []
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) { stack.pop(); continue }
    if (!token.startsWith('<')) { stack.at(-1).children.push(token); continue }
    const tag = /^<([\w-]+)/.exec(token)[1], attrs = {}
    for (const [, key, value] of token.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[key] = value
    if (/\bwx:else\b/.test(token)) attrs['wx:else'] = true
    const node = { tag, attrs, children: [] }
    stack.at(-1).children.push(node)
    if (!token.endsWith('/>')) stack.push(node)
  }
  const evaluate = (value, scope) => {
    const binding = /^\{\{([^]*?)\}\}$/.exec(value || '')
    return binding ? vm.runInNewContext(binding[1], scope) : value
  }
  const interpolate = (value, scope) => value.replace(/\{\{([^]*?)\}\}/g, (_, expression) => {
    const result = vm.runInNewContext(expression, scope)
    return result == null ? '' : String(result)
  })
  function render(nodes, scope) {
    const output = []
    let branchTaken = false
    for (const node of nodes) {
      if (typeof node === 'string') { output.push(node.trim() ? interpolate(node, scope) : ''); continue }
      const attrs = node.attrs
      if ('wx:if' in attrs) { branchTaken = Boolean(evaluate(attrs['wx:if'], scope)); if (!branchTaken) continue }
      else if ('wx:elif' in attrs) { if (branchTaken) continue; branchTaken = Boolean(evaluate(attrs['wx:elif'], scope)); if (!branchTaken) continue }
      else if ('wx:else' in attrs) { if (branchTaken) continue; branchTaken = true }
      else branchTaken = false
      const entries = 'wx:for' in attrs ? evaluate(attrs['wx:for'], scope) || [] : [null]
      entries.forEach((item, index) => {
        const childScope = 'wx:for' in attrs ? { ...scope, [attrs['wx:for-item'] || 'item']: item, [attrs['wx:for-index'] || 'index']: index } : scope
        output.push({ tag: node.tag, attrs, children: render(node.children, childScope) })
      })
    }
    return output
  }
  const rendered = render(tree.children, { ...data })
  function flatten(nodes) { return nodes.flatMap(node => typeof node === 'string' ? [] : [node, ...flatten(node.children)]) }
  function textOf(nodes) { return nodes.map(node => typeof node === 'string' ? node : textOf(node.children)).join('') }
  return { nodes: flatten(rendered), text: textOf(rendered) }
}
const historyView = page => view('pages/node-feedback/index.wxml', page.data)

// Break: the new action bypasses silent protected error mapping or changes the paging payload.
test('history service uses protected read action, exact cursor payload and safe silent errors', async () => {
  const calls = [], toasts = []
  global.wx = { cloud: { callFunction: async input => {
    calls.push(input)
    return calls.length === 1 ? { result: { ok: true, data: emptyHistory() } }
      : { result: { ok: false, code: 'UNAUTHORIZED', message: 'internal diagnostic' } }
  } }, showToast: value => toasts.push(value) }
  const service = require('../services/business')
  assert.equal(typeof service.listNodeReviewHistory, 'function')
  const query = { businessLineId: 'line-synthetic', nodeId: 'node-synthetic', beforeRoundNumber: 6, pageSize: 5 }
  assert.deepEqual(await service.listNodeReviewHistory(query), emptyHistory())
  assert.deepEqual(calls[0], { name: 'businessApi', data: { action: 'listNodeReviewHistory', payload: query } })
  await assert.rejects(service.listNodeReviewHistory(query), error => error.code === 'UNAUTHORIZED' && error.message === '审核历史加载失败，请稍后重试')
  assert.deepEqual(toasts, [])
})

// Break: vote comments are omitted from the actual visible detail, interpreted as markup, or whitespace blanks leak.
test('review detail renders every vote comment as multiline plain text with blank fallback', async () => {
  const { page } = setup({ getReviewDetail: async () => ({
    ...fixtureRound(), businessLineId: 'line-synthetic', nodeId: 'node-synthetic', version: 2,
    fieldValues: [], evidences: [], reviewerDisplayNames: ['审核甲', '审核乙', '审核丙'],
    canApprove: false, canReject: false
  }) }, 'pages/review-detail/index.js')
  await page.onLoad({ reviewRoundId: 'round-2' })
  const rendered = view('pages/review-detail/index.wxml', page.data)
  assert.ok(rendered.text.includes('第一行\n<说明>&正文'))
  assert.ok(rendered.text.includes('请补充资料'))
  assert.ok(rendered.text.includes('未填写审核意见'))
  assert.equal(rendered.nodes.some(node => node.tag === 'rich-text'), false)
  assert.equal(rendered.nodes.filter(node => ['onApprove', 'onReject'].includes(node.attrs.bindtap)).length, 0)
})

// Break: awaiting history blocks the form, or history errors claim an empty successful read.
test('history loads independently; failure offers retry without blocking or replacing the draft', async () => {
  const pending = deferred(), calls = []
  const context = await open(setup({ listNodeReviewHistory: input => {
    calls.push(input); return calls.length === 1 ? pending.promise : Promise.resolve(emptyHistory())
  } }))
  const { page } = context
  assert.equal(page.data.loadingHistory, false)
  assert.equal(page.data.readOnly, false)
  assert.equal(page.data.reviewHistoryLoading, true)
  assert.match(historyView(page).text, /正在加载审核历史/)
  page.onComment({ detail: { value: '未保存草稿' } })
  pending.reject(new Error('network detail'))
  await tick()
  assert.equal(page.data.reviewHistoryLoaded, false)
  assert.equal(page.data.reviewHistoryError, '审核历史加载失败，请稍后重试')
  assert.doesNotMatch(historyView(page).text, /暂无审核记录/)
  assert.ok(historyView(page).nodes.some(node => node.attrs.bindtap === 'onRetryReviewHistory'))
  await page.onRetryReviewHistory()
  assert.equal(page.data.comment, '未保存草稿')
  assert.equal(page.data.draftDirty, true)
  assert.equal(page.data.reviewHistoryLoaded, true)
  assert.match(historyView(page).text, /暂无审核记录/)
  assert.deepEqual(calls[0], { businessLineId: 'line-synthetic', nodeId: 'node-synthetic', pageSize: 5 })
  assert.deepEqual(context.toasts, [])
})

for (const state of [
  { status: 'completed', lineStatus: 'completed', canSubmit: false },
  { status: 'in_progress', lineStatus: 'active', canSubmit: true },
  { status: 'pending_review', lineStatus: 'active', canSubmit: false }
]) {
  // Break: history is gated on processor/write permission or a node's nonterminal state.
  test(`inline history remains available in ${state.status} without any vote actions`, async () => {
    const { page } = await open(setup({
      getNodeWorkspace: async () => workspace(state.status, state.lineStatus, state.canSubmit),
      listNodeReviewHistory: async () => ({ items: [fixtureRound(2), fixtureRound(1, { status: 'approved' })], hasMore: false, nextBeforeRoundNumber: null })
    }))
    const rendered = historyView(page)
    assert.ok(Array.isArray(page.data.reviewHistory), 'Review history must be available to authorized readers')
    assert.equal(page.data.reviewHistory.length, 2)
    for (const text of ['审核甲', '审核乙', '审核丙', '通过', '驳回', '第一行\n<说明>&正文', '请补充资料', '未填写审核意见']) assert.ok(rendered.text.includes(text), text)
    assert.ok(rendered.text.indexOf('第 2 轮审核') < rendered.text.indexOf('第 1 轮审核'))
    assert.equal(rendered.nodes.some(node => node.tag === 'rich-text' || ['onApprove', 'onReject'].includes(node.attrs.bindtap)), false)
    assert.equal(page.data.reviewHistory[0].votes[0].createdAtText, new Date('2026-09-20T02:00:00.000Z').toLocaleString('zh-CN'))
    assert.equal(page.data.readOnly, !state.canSubmit)
  })
}

// Break: paging drops earlier votes, advances a failed cursor, duplicates in-flight requests, or reloads the form.
test('load more is single-flight and retries the same failed cursor while retaining loaded rounds', async () => {
  const pending = deferred(), calls = []
  const { page } = await open(setup({ listNodeReviewHistory: input => {
    calls.push(input)
    if (calls.length === 1) return Promise.resolve({ items: [fixtureRound(6)], hasMore: true, nextBeforeRoundNumber: 6 })
    if (calls.length === 2) return pending.promise
    return Promise.resolve({ items: [fixtureRound(5), fixtureRound(4)], hasMore: false, nextBeforeRoundNumber: null })
  } }))
  assert.ok(historyView(page).nodes.some(node => node.attrs.bindtap === 'onLoadMoreReviewHistory'))
  const loading = page.onLoadMoreReviewHistory()
  await page.onLoadMoreReviewHistory()
  assert.equal(calls.length, 2)
  pending.reject(new Error('temporary'))
  await loading
  assert.deepEqual(page.data.reviewHistory.map(item => item.reviewRoundNumber), [6])
  assert.doesNotMatch(historyView(page).text, /暂无审核记录/)
  await page.onRetryReviewHistory()
  assert.deepEqual(calls[1], { businessLineId: 'line-synthetic', nodeId: 'node-synthetic', pageSize: 5, beforeRoundNumber: 6 })
  assert.deepEqual(calls[2], calls[1])
  assert.deepEqual(page.data.reviewHistory.map(item => item.reviewRoundNumber), [6, 5, 4])
  assert.equal(page.data.reviewHistoryHasMore, false)
  await page.onLoadMoreReviewHistory()
  assert.equal(calls.length, 3)
})

for (const code of ['FORBIDDEN', 'UNAUTHORIZED', 'ACCOUNT_DISABLED', 'ACCOUNT_LOCKED', 'PASSWORD_CHANGE_REQUIRED', 'ACCOUNT_STATE_INVALID']) {
  // Break: denied history requests retain sensitive previously visible votes.
  test(`history ${code} clears loaded rounds and cursor, without showing an empty success`, async () => {
    let reads = 0
    const { page } = await open(setup({ listNodeReviewHistory: async () => {
      if (++reads === 1) return { items: [fixtureRound()], hasMore: true, nextBeforeRoundNumber: 2 }
      throw Object.assign(new Error('private server diagnostic'), { code })
    } }))
    assert.ok(Array.isArray(page.data.reviewHistory), 'Loaded history must have an independent state')
    assert.equal(page.data.reviewHistory.length, 1)
    await page.onLoadMoreReviewHistory()
    assert.deepEqual(page.data.reviewHistory, [])
    assert.equal(page.data.reviewHistoryHasMore, false)
    assert.equal(page.data.reviewHistoryBeforeRoundNumber, null)
    assert.equal(page.data.reviewHistoryLoading, false)
    assert.equal(page.data.reviewHistoryLoaded, false)
    assert.doesNotMatch(historyView(page).text, /暂无审核记录|private server diagnostic|第一行|请补充资料/)
  })
}

// Break: a workspace authorization failure can be undone by a late independent history response.
test('workspace auth denial clears history and invalidates an in-flight history page', async () => {
  let workspaceReads = 0, historyReads = 0
  const pending = deferred()
  const { page } = await open(setup({
    getNodeWorkspace: async () => {
      if (++workspaceReads === 1) return workspace()
      throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' })
    },
    listNodeReviewHistory: async () => ++historyReads === 1
      ? { items: [fixtureRound()], hasMore: true, nextBeforeRoundNumber: 2 } : pending.promise
  }))
  assert.ok(Array.isArray(page.data.reviewHistory), 'Loaded history must have an independent state')
  assert.equal(page.data.reviewHistory.length, 1)
  const loading = page.onLoadMoreReviewHistory()
  await page.loadData()
  assert.deepEqual(page.data.reviewHistory, [])
  pending.resolve({ items: [fixtureRound(1)], hasMore: false, nextBeforeRoundNumber: null })
  await loading
  assert.deepEqual(page.data.reviewHistory, [])
  assert.equal(page.data.readOnly, true)
})

for (const mode of ['account-show', 'account-response', 'unload', 'superseded']) {
  // Break: an obsolete account/page/request repopulates review history (including late errors).
  test(`${mode} prevents stale review history from repopulating the page`, async () => {
    const pending = deferred()
    let reads = 0
    const context = await open(setup({ listNodeReviewHistory: async () => {
      if (++reads === 1) return { items: [fixtureRound(3)], hasMore: true, nextBeforeRoundNumber: 3 }
      if (reads === 2) return pending.promise
      return { items: [fixtureRound(4)], hasMore: false, nextBeforeRoundNumber: null }
    } }))
    const { page, app } = context
    assert.ok(Array.isArray(page.data.reviewHistory), 'Loaded history must have an independent state')
    assert.equal(page.data.reviewHistory.length, 1)
    const loading = page.onLoadMoreReviewHistory()
    if (mode.startsWith('account')) {
      app.globalData.currentUser = activeUser('other-synthetic')
      if (mode === 'account-show') { page.setData({ draftDirty: true }); await page.onShow(); assert.deepEqual(page.data.reviewHistory, []) }
    } else if (mode === 'unload') page.onUnload()
    else await page.loadReviewHistory()
    pending.resolve({ items: [fixtureRound(1)], hasMore: false, nextBeforeRoundNumber: null })
    await loading
    assert.deepEqual(page.data.reviewHistory.map(item => item.reviewRoundNumber), mode === 'superseded' ? [4] : [])
    assert.deepEqual(context.toasts, [])
  })
}

// Break: returning with unsaved progress skips fresh read-only history, or clobbers the progress draft.
test('onShow refreshes review history without reloading an unsaved progress form', async () => {
  let workspaceReads = 0, historyReads = 0
  const { page } = await open(setup({
    getNodeWorkspace: async () => { workspaceReads += 1; return workspace() },
    listNodeReviewHistory: async () => ({ items: [fixtureRound(++historyReads)], hasMore: false, nextBeforeRoundNumber: null })
  }))
  page.onComment({ detail: { value: '未保存内容' } })
  await page.onShow()
  assert.equal(workspaceReads, 1)
  assert.equal(historyReads, 2)
  assert.equal(page.data.comment, '未保存内容')
  assert.equal(page.data.reviewHistory[0].reviewRoundNumber, 2)
})

// Break: a malformed response is treated as proof that no history exists.
test('malformed history responses do not become successful empty history', async () => {
  const { page } = await open(setup({ listNodeReviewHistory: async () => ({ hasMore: false, nextBeforeRoundNumber: null }) }))
  assert.equal(page.data.reviewHistoryLoaded, false)
  assert.equal(page.data.reviewHistoryLoading, false)
  assert.ok(page.data.reviewHistoryError)
  assert.doesNotMatch(historyView(page).text, /暂无审核记录/)
})

// Break: legacy nodes call an unrelated review API or fabricate review records.
test('legacy nodes never load review history; reviewerless review nodes may load an empty history', async () => {
  for (const mode of ['legacy', 'review']) {
    let reads = 0
    const { page } = await open(setup({
      getNodeWorkspace: async () => {
        const result = workspace()
        result.node.workflowMode = mode
        result.node.requiresReview = false
        result.node.reviewerDisplayNames = []
        return result
      },
      listNodeReviewHistory: async () => { reads += 1; return emptyHistory() }
    }))
    assert.equal(reads, mode === 'review' ? 1 : 0)
    if (mode === 'review') assert.match(historyView(page).text, /暂无审核记录/)
    else assert.doesNotMatch(historyView(page).text, /审核历史|暂无审核记录/)
  }
})

for (const outcome of ['resolve', 'reject']) {
  // Break: obsolete responses clear a newer request's loading/error state.
  test(`superseded ${outcome} cannot end the newer history loading state`, async () => {
    const oldRequest = deferred(), newRequest = deferred()
    const { page } = await open(setup({ listNodeReviewHistory: (() => {
      let reads = 0
      return () => ++reads === 1 ? oldRequest.promise : newRequest.promise
    })() }))
    assert.equal(page.data.reviewHistoryLoading, true)
    const loading = page.loadReviewHistory()
    if (outcome === 'resolve') oldRequest.resolve(emptyHistory())
    else oldRequest.reject(new Error('old failure'))
    await tick()
    assert.equal(page.data.reviewHistoryLoading, true)
    assert.equal(page.data.reviewHistoryError, '')
    newRequest.resolve({ items: [fixtureRound()], hasMore: false, nextBeforeRoundNumber: null })
    await loading
    assert.equal(page.data.reviewHistory.length, 1)
  })
}

// Break: adding opinions to detail leaves sensitive old votes visible after auth loss/account change.
for (const reason of ['account-change', 'auth-error']) {
  test(`review detail clears displayed vote comments on ${reason}`, async () => {
    let reads = 0
    const { page, app } = setup({ getReviewDetail: async () => {
      if (++reads > 1) throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' })
      return { ...fixtureRound(), version: 2, fieldValues: [], evidences: [], canApprove: false, canReject: false }
    } }, 'pages/review-detail/index.js')
    await page.onLoad({ reviewRoundId: 'round-2' })
    assert.equal(page.data.votes.length, 3)
    if (reason === 'account-change') app.globalData.currentUser = activeUser('other-synthetic')
    await page.onShow()
    assert.deepEqual(page.data.votes, [])
    assert.equal(page.data.canApprove, false)
    assert.equal(page.data.canReject, false)
  })
}

// Break: long/multiline comments lose line breaks or overflow the page's comment element.
test('both visible comment elements preserve whitespace and wrap long plain text', async () => {
  for (const name of ['node-feedback', 'review-detail']) {
    const { page } = setup({
      listNodeReviewHistory: async () => ({ items: [fixtureRound()], hasMore: false, nextBeforeRoundNumber: null }),
      getReviewDetail: async () => ({ ...fixtureRound(), version: 2, fieldValues: [], evidences: [], canApprove: false, canReject: false })
    }, `pages/${name}/index.js`)
    await page.onLoad({ lineId: 'line-synthetic', nodeId: 'node-synthetic', reviewRoundId: 'round-2' })
    await tick()
    const rendered = view(`pages/${name}/index.wxml`, page.data)
    const comment = rendered.nodes.find(node => node.tag === 'text' && node.children.includes('第一行\n<说明>&正文'))
    assert.ok(comment, `${name} must render a plain-text comment`)
    const stylesheet = fs.readFileSync(path.join(root, `pages/${name}/index.wxss`), 'utf8')
    const classes = (comment.attrs.class || '').split(/\s+/)
    const declarations = {}
    for (const [, selector, body] of stylesheet.matchAll(/([^{}]+)\{([^}]+)\}/g)) {
      if (!selector.split(',').some(part => classes.some(className => part.trim() === `.${className}`))) continue
      for (const entry of body.split(';')) { const [key, value] = entry.split(':'); if (key && value) declarations[key.trim()] = value.trim() }
    }
    assert.equal(declarations['white-space'], 'pre-wrap')
    assert.ok(['break-all', 'break-word'].includes(declarations['word-break']))
  }
})

for (const action of ['save', 'submit-review', 'submit-review-check', 'recognize', 'preview', 'download', 'upload']) {
  // Break: another protected action observes revoked access but leaves already loaded opinions visible.
  test(`${action} access denial also clears review history and discards a late history page`, async () => {
    const denied = async () => { throw Object.assign(new Error('access diagnostic'), { code: 'UNAUTHORIZED' }) }
    const pending = deferred()
    let historyReads = 0, workspaceReads = 0
    const { page } = await open(setup({
      getNodeWorkspace: async () => ++workspaceReads > 1 && action === 'submit-review-check' ? denied() : workspace(),
      listNodeReviewHistory: async () => ++historyReads === 1
        ? { items: [fixtureRound(2)], hasMore: true, nextBeforeRoundNumber: 2 } : pending.promise,
      submitFeedback: denied, saveAndSubmitNodeForReview: async () => {
        if (action === 'submit-review-check') throw new Error('unknown write outcome')
        return denied()
      },
      recognizeNodeText: denied, getEvidenceAccess: denied
    }))
    const loading = page.onLoadMoreReviewHistory()
    if (action === 'save') await page.onSaveProgress()
    if (action === 'submit-review' || action === 'submit-review-check') await page.onSubmitReview()
    if (action === 'recognize') {
      page.onRecognitionText({ detail: { value: '合成识别文本' } })
      await page.onRecognizeText()
    }
    if (action === 'preview') await page.previewEvidence({ currentTarget: { dataset: { evidenceid: 'synthetic-evidence', status: 'available', category: 'image' } } })
    if (action === 'download') {
      page.setData({ history: [{ evidences: [{ evidenceId: 'synthetic-evidence', canPreview: true }] }] })
      await page.downloadAllEvidence()
    }
    if (action === 'upload') {
      page.createEvidenceUploader = () => ({ upload: denied })
      page.addSelectedFiles([{ name: 'synthetic.pdf', path: 'wxfile://synthetic.pdf', size: 10, category: 'pdf' }])
      await page.onSaveProgress()
    }
    assert.deepEqual(page.data.reviewHistory, [])
    pending.resolve({ items: [fixtureRound(1)], hasMore: false, nextBeforeRoundNumber: null })
    await loading
    assert.deepEqual(page.data.reviewHistory, [])
  })
}

// Break: a denied vote can leave/repopulate newly displayed comments from a simultaneous detail read.
test('vote authorization denial clears existing comments and invalidates an in-flight detail read', async () => {
  let detailReads = 0
  const pending = deferred()
  const detail = { ...fixtureRound(), status: 'pending', version: 2, fieldValues: [], evidences: [], canApprove: true, canReject: true }
  const { page } = setup({
    getReviewDetail: async () => ++detailReads === 1 ? detail : pending.promise,
    submitReviewVote: async () => { throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }) }
  }, 'pages/review-detail/index.js')
  await page.onLoad({ reviewRoundId: 'round-2' })
  const loading = page.loadDetail()
  await page.onApprove()
  assert.deepEqual(page.data.votes, [])
  assert.equal(page.data.canApprove, false)
  assert.equal(page.data.canReject, false)
  pending.resolve(detail)
  await loading
  assert.deepEqual(page.data.votes, [])
  assert.equal(page.data.loading, false)
})

test('review evidence authorization denial clears displayed opinions and invalidates pending detail', async () => {
  const pending = deferred()
  let reads = 0
  const detail = { ...fixtureRound(), version: 2, fieldValues: [], evidences: [{ evidenceId: 'synthetic-evidence' }], canApprove: false, canReject: false }
  const { page } = setup({
    getReviewDetail: async () => ++reads === 1 ? detail : pending.promise,
    getEvidenceAccess: async () => { throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }) }
  }, 'pages/review-detail/index.js')
  await page.onLoad({ reviewRoundId: 'round-2' })
  const loading = page.loadDetail()
  await page.previewEvidence({ currentTarget: { dataset: { id: 'synthetic-evidence' } } })
  assert.deepEqual(page.data.votes, [])
  pending.resolve(detail)
  await loading
  assert.deepEqual(page.data.votes, [])
})

for (const action of ['save', 'submit-review', 'vote']) {
  for (const change of ['account-success', 'account-failure', 'version-failure']) {
    test(`${action} cleans private history before discarding ${change} response`, async () => {
      const pending = deferred()
      const detail = { ...fixtureRound(), status: 'pending', version: 2,
        fieldValues: [], evidences: [], canApprove: true, canReject: true }
      const service = {
        getReviewDetail: async () => detail,
        listNodeReviewHistory: async () => ({ items: [fixtureRound()], hasMore: false, nextBeforeRoundNumber: null }),
        submitFeedback: () => pending.promise, saveAndSubmitNodeForReview: () => pending.promise,
        submitReviewVote: () => pending.promise
      }
      const context = setup(service, action === 'vote' ? 'pages/review-detail/index.js' : 'pages/node-feedback/index.js')
      const { page, app } = context
      if (action === 'vote') await page.onLoad({ reviewRoundId: 'round-2' })
      else await open(context)
      const writing = action === 'vote' ? page.onApprove() : action === 'save' ? page.onSaveProgress() : page.onSubmitReview()
      await tick()
      if (change.startsWith('account')) app.globalData.currentUser = activeUser('different-member')
      else if (action === 'vote') page.setData({ roundVersion: 3 })
      else page.setData({ expectedNodeVersion: 4 })
      if (change === 'account-success') pending.resolve({ nodeVersion: 4, nodeStatus: 'pending_review' })
      else pending.reject(Object.assign(new Error('denied'), { code: 'FORBIDDEN' }))
      await writing
      assert.deepEqual(action === 'vote' ? page.data.votes : page.data.reviewHistory, [])
      if (action === 'vote') {
        assert.equal(page.data.canApprove, false)
        assert.equal(page.data.canReject, false)
      } else {
        assert.equal(page.data.canSubmit, false)
        assert.equal(page.data.readOnly, true)
      }
    })
  }
}
