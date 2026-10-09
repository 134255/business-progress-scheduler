const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { APPLICATION_ERROR_MARKER } = require('../lib/cloud-template-repository')

const originalLoad = Module._load
let createBusinessApi
try {
  Module._load = function boundary(request, parent, isMain) {
    if (request === 'wx-server-sdk') return {
      init() {}, database: () => createFakeCloudDatabase().db
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  ;({ createBusinessApi } = require('../index'))
} finally { Module._load = originalLoad }

const actor = { _id: 'member-1', status: 'active', role: 'user' }
function harness(services = {}, user = actor) {
  const logs = []
  const api = createBusinessApi({
    repository: {
      async findUserByOpenid() { return user },
      async findCredential() { return { mustChangePassword: false } }
    },
    getContext: () => ({ OPENID: 'synthetic-binding', REQUESTID: 'synthetic-request' }),
    logger: { error(...args) { logs.push(args) } },
    ...services
  })
  return { main: api.main, logs }
}
function marked(code, message = code) {
  return Object.assign(new Error(message), { code, [APPLICATION_ERROR_MARKER]: true })
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

for (const first of ['search', 'card']) {
  test(`creation starts search and cards after publication, and waits for both (${first} finishes first)`, async () => {
    const { createBusinessService } = require('../lib/business-service')
    const gates = { search: deferred(), card: deferred() }
    const starts = []
    let published = false
    let returned = false
    const timingLogs = []
    const stored = { id: 'line-1', code: 'SYNTHETIC-1' }
    Object.defineProperties(stored, {
      publicResult: { value: stored },
      searchEnvelope: { value: { actorId: actor._id, businessLineId: 'line-1', sourceVersion: 1 } }
    })
    const businessService = createBusinessService({
      repository: { async createBusinessSnapshot() { published = true; return stored } },
      workTimeService: { async tryAddWorkMinutes() { assert.fail('existing snapshot') } },
      businessSearchClient: { async ensureIndexed() {
        assert.equal(published, true); starts.push('search'); await gates.search.promise
      } }
    })
    const { main } = harness({ businessService,
      logger: { error() {}, info: (...args) => timingLogs.push(args) },
      businessCardService: { async refreshAfterMutation(input) {
      assert.equal(published, true)
      assert.equal(input.actor, actor)
      assert.equal(input.result, stored)
      starts.push('card'); await gates.card.promise
    } } })
    const response = main({ action: 'createBusinessFromTemplate', payload: {
      templateId: 'template-1', requestKey: 'create-1',
      // A client cannot replace the trusted post-publication callback.
      afterCreated: 'untrusted', creationCardsRefreshed: true, creationTiming: { finish: 'untrusted' }
    } }).then(result => { returned = true; return result })
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(starts.slice().sort(), ['card', 'search'])
      assert.equal(returned, false)
      assert.equal(timingLogs.length, 0, 'summary must not be emitted before completion')
      gates[first].resolve()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(returned, false)
    } finally {
      gates.card.resolve(); gates.search.resolve()
      await response
    }
    assert.deepEqual(await response, { ok: true, data: stored })
    assert.equal(starts.length, 2, 'no duplicate refresh')
    assert.equal(timingLogs.length, 1)
    assert.equal(timingLogs[0][0], '[businessApi.creationTiming]')
    assert.equal(timingLogs[0][1].outcome, 'OK')
    assert.deepEqual(Object.keys(timingLogs[0][1].stages).sort(), ['authorize', 'card_refresh', 'search_sync'])
    assert.equal(JSON.stringify(timingLogs).includes('untrusted'), false)
  })
}

test('creation timing includes rejected authorization but is absent on unrelated actions', async () => {
  const events = []
  const logger = { error() {}, info: (_, event) => events.push(event) }
  const denied = harness({ logger, businessService: { createFromTemplate() { assert.fail('not authorized') } } }, null)
  const response = await denied.main({ action: 'createBusinessFromTemplate', payload: { description: 'PRIVATE' } })
  assert.equal(response.code, 'UNAUTHORIZED')
  assert.equal(events.length, 1)
  assert.equal(events[0].outcome, 'ERROR')
  assert.equal(events[0].stages.authorize.failedCalls, 1)
  assert.equal(JSON.stringify(events).includes('PRIVATE'), false)
  const other = harness({ logger, businessService: { listBusinessLines: async () => ({ items: [] }) } })
  assert.equal((await other.main({ action: 'listBusinessLines', payload: {} })).ok, true)
  assert.equal(events.length, 1)
})

test('a broken timing log sink cannot change the creation API success or failure response', async () => {
  for (const asynchronous of [false, true]) {
    let logCalls = 0
    const logger = { error() {}, info() {
      logCalls++
      const error = new Error('synthetic log sink unavailable')
      if (asynchronous) return Promise.reject(error)
      throw error
    } }
    const success = harness({ logger, businessService: { async createFromTemplate() {
      return { id: 'synthetic-line', code: 'synthetic-code' }
    } } })
    assert.deepEqual(await success.main({ action: 'createBusinessFromTemplate', payload: {} }),
      { ok: true, data: { id: 'synthetic-line', code: 'synthetic-code' } })
    const failure = harness({ logger, businessService: { async createFromTemplate() { throw marked('TEMPLATE_NOT_ENABLED') } } })
    const response = await failure.main({ action: 'createBusinessFromTemplate', payload: {} })
    assert.equal(response.ok, false)
    assert.equal(response.code, 'TEMPLATE_NOT_ENABLED')
    assert.equal(logCalls, 2)
    await new Promise(resolve => setImmediate(resolve))
  }
})

test('parallel creation derived failures keep authoritative success and drain both tasks', async () => {
  const { createBusinessService } = require('../lib/business-service')
  let creates = 0
  for (const fails of ['search', 'card']) {
    const survivor = deferred()
    let returned = false
    const started = []
    const stored = { id: 'line-1', code: 'SYNTHETIC-1' }
    Object.defineProperties(stored, {
      publicResult: { value: stored },
      searchEnvelope: { value: { actorId: actor._id, businessLineId: 'line-1', sourceVersion: 1 } }
    })
    const work = async name => {
      started.push(name)
      if (fails === name) throw new Error('synthetic-derived-failure')
      await survivor.promise
    }
    const businessService = createBusinessService({
      repository: { async createBusinessSnapshot() { creates++; return stored } },
      workTimeService: { async tryAddWorkMinutes() { assert.fail('unused') } },
      businessSearchClient: { ensureIndexed: () => work('search') }
    })
    const { main, logs } = harness({ businessService,
      businessCardService: { refreshAfterMutation: () => work('card') } })
    const response = main({ action: 'createBusinessFromTemplate', payload: {
      templateId: 'template-1', requestKey: 'request-1'
    } }).then(result => { returned = true; return result })
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(started.slice().sort(), ['card', 'search'])
      assert.equal(returned, false)
    } finally { survivor.resolve(); await response }
    assert.deepEqual(await response, { ok: true, data: {
      ...stored, ...(fails === 'search' ? { searchIndexStatus: 'pending' } : {})
    } })
    assert.equal(logs.length, 0)
  }
  assert.equal(creates, 2, 'never retry authoritative creation for a derived failure')
})

test('concurrent creation callbacks and fallback refreshes stay request-local', async () => {
  const gate = deferred()
  const modernStarted = deferred()
  const refreshes = []
  const { main } = harness({
    businessService: { async createFromTemplate({ input, afterCreated }) {
      const result = { id: input.requestKey }
      if (input.requestKey === 'modern') await afterCreated(result)
      return result
    } },
    businessCardService: { async refreshAfterMutation({ result }) {
      refreshes.push(result.id)
      if (result.id === 'modern') { modernStarted.resolve(); await gate.promise }
    } }
  })
  const modern = main({ action: 'createBusinessFromTemplate', payload: { requestKey: 'modern' } })
  try {
    await modernStarted.promise
    const fallback = await main({ action: 'createBusinessFromTemplate', payload: { requestKey: 'fallback' } })
    assert.deepEqual(fallback, { ok: true, data: { id: 'fallback' } })
    assert.deepEqual(refreshes, ['modern', 'fallback'])
  } finally { gate.resolve(); await modern }
  assert.deepEqual(await modern, { ok: true, data: { id: 'modern' } })
  assert.equal(refreshes.length, 2)
})

for (const action of ['getTemplateCardDisplay', 'updateTemplateCardDisplay']) {
  test(`${action} is protected and delegates only trusted actor and allowlisted config inputs`, async () => {
    const calls = []
    const service = { async [action](input) { calls.push(input); return { revision: 2, fields: [] } } }
    const payload = { templateId: 'template-1', actor: { role: 'super_admin' }, actorId: 'forged',
      role: 'super_admin', openid: 'forged' }
    if (action === 'updateTemplateCardDisplay') Object.assign(payload, { expectedRevision: 1, fields: [] })
    const denied = harness({ templateService: service }, null)
    assert.equal((await denied.main({ action, payload })).code, 'UNAUTHORIZED')
    assert.equal(calls.length, 0)
    const { main } = harness({ templateService: service })
    assert.deepEqual(await main({ action, payload }), { ok: true, data: { revision: 2, fields: [] } })
    assert.deepEqual(calls, [{ actor, templateId: 'template-1',
      ...(action === 'updateTemplateCardDisplay' ? { expectedRevision: 1, fields: [] } : {}) }])
    for (const extra of [{ value: 'synthetic-value' }, { path: 'arbitrary.path' }, { expectedVersion: 1 },
      { [Symbol('unknown')]: true }]) {
      assert.equal((await main({ action, payload: { ...payload, ...extra } })).code, 'VALIDATION_ERROR')
    }
    let getterRuns = 0
    const accessor = { ...payload }
    Object.defineProperty(accessor, 'templateId', { get() { getterRuns++; return 'template-1' } })
    assert.equal((await main({ action, payload: accessor })).code, 'VALIDATION_ERROR')
    assert.equal(getterRuns, 0)
    assert.equal(calls.length, 1)
  })
}

test('marked config/reference errors expose only a safe message; unmarked failures stay internal', async () => {
  const error = marked('CARD_DISPLAY_INVALID', 'synthetic-private-field-details')
  error.diagnostic = { code: 'synthetic-private-diagnostic', stage: 'service_init' }
  const { main, logs } = harness({ templateService: {
    async updateTemplateCardDisplay() { throw error }, async updateTemplate() { throw error }
  } })
  for (const action of ['updateTemplateCardDisplay', 'updateTemplate']) {
    const result = await main({ action, payload: {} })
    assert.equal(result.code, 'CARD_DISPLAY_INVALID')
    assert.equal(result.ok, false)
    assert.equal(Object.hasOwn(result, 'diagnostic'), false)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/)
  }
  delete error[APPLICATION_ERROR_MARKER]
  assert.equal((await main({ action: 'updateTemplateCardDisplay', payload: {} })).code, 'INTERNAL_ERROR')
  assert.doesNotMatch(JSON.stringify(logs), /synthetic-private/)
})

for (const [action, serviceKey, method, key, lineIdKey] of [
  ['listBusinessLines', 'businessService', 'listBusinessLines', 'items'],
  ['listMyPendingProcessing', 'businessService', 'listMyPendingProcessing', 'items', 'businessLineId'],
  ['listMyPendingReviews', 'reviewService', 'listMyPendingReviews', 'items', 'businessLineId'],
  ['getMyDashboardSummary', 'businessService', 'getMyDashboardSummary', 'recent'],
  ['getDashboardWorkspace', 'dashboardWorkspaceService', 'getDashboardWorkspace', 'recent']
]) {
  test(`${action} decorates exactly its card array after success and preserves the complete envelope`, async () => {
    const items = [{ _id: lineIdKey ? 'node-1' : 'line-1', businessLineId: 'line-1', code: 'SYNTHETIC-1', matches: [{ label: '型号', excerpt: '示例型号' }] }]
    const result = { [key]: items, stats: { active: 1 }, total: null, cursor: 'opaque-cursor',
      hasMore: true, complete: false, indexStatus: 'recovering', filters: { status: 'active', scope: 'mine' },
      pendingProcessing: [{ _id: 'node-1' }], sourceMetadata: { generation: 'synthetic-generation' } }
    const before = structuredClone(result)
    const events = []
    const { main } = harness({
      [serviceKey]: { async [method]() { events.push('read'); return result } },
      businessCardService: {
        async decorateItems(input) {
          events.push('decorate'); assert.equal(input.actor, actor); assert.equal(input.items, items)
          assert.equal(input.lineIdKey, lineIdKey)
          return input.items.map(item => ({ ...item, cardSummary: { state: 'ready', fields: [], configRevision: 0 } }))
        },
        async refreshAfterMutation() { assert.fail('read must not refresh') }
      }
    })
    const response = await main({ action })
    assert.equal(response.ok, true)
    assert.deepEqual(events, ['read', 'decorate'])
    assert.deepEqual(response.data[key][0].cardSummary, { state: 'ready', fields: [], configRevision: 0 })
    assert.deepEqual({ ...response.data, [key]: response.data[key].map(({ cardSummary, ...base }) => base) }, before)
    assert.deepEqual(result, before)
  })
}

test('read decoration authorization and unexpected errors propagate; failed reads never decorate', async () => {
  let sourceFailure = false
  let decorations = 0
  let error = marked('FORBIDDEN')
  const { main } = harness({
    businessService: { async listBusinessLines() { if (sourceFailure) throw marked('VERSION_CONFLICT'); return { items: [] } } },
    businessCardService: { async decorateItems() { decorations++; throw error } }
  })
  assert.equal((await main({ action: 'listBusinessLines' })).code, 'FORBIDDEN')
  error = new Error('synthetic-derived-read-failure')
  assert.equal((await main({ action: 'listBusinessLines' })).code, 'INTERNAL_ERROR')
  sourceFailure = true
  assert.equal((await main({ action: 'listBusinessLines' })).code, 'VERSION_CONFLICT')
  assert.equal(decorations, 2)
})

const mutations = [
  ['createBusinessFromTemplate', 'businessService', 'createFromTemplate', { templateId: 'template-1' }, { id: 'line-1', code: 'SYNTHETIC-1' }],
  ['updateBusinessMetadata', 'businessService', 'updateMetadata', { businessLineId: 'line-1' }, { id: 'line-1', version: 2 }],
  ['submitFeedback', 'feedbackService', 'submitFeedback', { nodeId: 'node-1' }, { feedbackId: 'feedback-1' }],
  ['submitFeedback', 'feedbackService', 'saveNodeProgress', { nodeId: 'node-1', action: 'save_progress' }, { feedbackId: 'feedback-1' }],
  ['saveAndSubmitNodeForReview', 'nodeSubmitService', 'saveAndSubmitNodeForReview', { nodeId: 'node-1' }, { reviewRoundId: 'round-1' }],
  ['submitNodeForReview', 'reviewService', 'submitNodeForReview', { nodeId: 'node-1' }, { reviewRoundId: 'round-1' }],
  ['submitReviewVote', 'reviewService', 'submitReviewVote', { reviewRoundId: 'round-1' }, { reviewRoundId: 'round-1', status: 'approved' }],
  ['rejectPreviousNode', 'businessLifecycleService', 'rejectPreviousNode', { currentNodeId: 'node-1' }, { businessLineId: 'line-1' }],
  ['closeBusinessLine', 'businessLifecycleService', 'closeBusinessLine', { businessLineId: 'line-1' }, { businessLineId: 'line-1' }],
  ['amendFrozenBusiness', 'businessLifecycleService', 'amendFrozenBusiness', { businessLineId: 'line-1' }, { businessLineId: 'line-1' }],
  ['decideOptionalTailNode', 'optionalTailService', 'decide', { nodeId: 'node-1' }, { businessLineId: 'line-1' }],
  ['decideNodeRoute', 'manualRouteService', 'decide', { nodeId: 'node-1' }, { businessLineId: 'line-1' }]
]
for (const [action, serviceKey, method, payload, result] of mutations) {
  test(`${action}/${method} awaits derived refresh once after success, never after original failure`, async () => {
    const events = []
    let failBusiness = false
    let rejectRefresh = false
    const { main, logs } = harness({
      [serviceKey]: { async [method]() {
        events.push('mutation')
        if (failBusiness) throw marked('VERSION_CONFLICT', 'original-business-failure')
        return result
      } },
      businessCardService: { async refreshAfterMutation(input) {
        assert.deepEqual(input, { actor, action, payload, result })
        events.push('refresh-start')
        await new Promise(resolve => setImmediate(resolve))
        events.push('refresh-end')
        if (rejectRefresh) throw new Error('synthetic-private-refresh-failure')
      } }
    })
    for (rejectRefresh of [false, true]) {
      events.length = 0
      const response = await main({ action, payload })
      assert.equal(response.ok, true)
      assert.equal(response.data, result)
      assert.deepEqual(events, ['mutation', 'refresh-start', 'refresh-end'])
    }
    assert.equal(logs.length, 0)
    failBusiness = true; events.length = 0
    assert.deepEqual(await main({ action, payload }), { ok: false, code: 'VERSION_CONFLICT', message: 'original-business-failure' })
    assert.deepEqual(events, ['mutation'])
  })
}

test('optional card service preserves old injected adapters and unrelated routes never decorate or refresh', async () => {
  const result = { items: [{ _id: 'node-1' }], recent: [], id: 'line-1' }
  const businessService = {
    async listBusinessLines() { return result }, async getMyDashboardSummary() { return result },
    async updateMetadata() { return result }, async listMyPendingProcessing() { return result },
    async getBusinessLine() { return result }
  }
  const old = harness({ businessService })
  for (const action of ['listBusinessLines', 'getMyDashboardSummary', 'updateBusinessMetadata']) {
    assert.equal((await old.main({ action })).data, result)
  }
  let unrelatedRefreshes = 0
  const { main } = harness({ businessService,
    evidenceService: { async getAccessGrant() { return result } },
    templateService: { async updateTemplateCardDisplay() { return result } },
    businessCardService: {
      async decorateItems() { assert.fail('unrelated decoration') },
      async refreshAfterMutation() { unrelatedRefreshes++ }
    }
  })
  for (const action of ['getBusinessLine', 'getEvidenceAccess', 'updateTemplateCardDisplay']) {
    assert.equal((await main({ action })).data, result)
  }
  assert.equal(unrelatedRefreshes, 0)
})
