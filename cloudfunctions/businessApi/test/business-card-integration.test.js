const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const Module = require('node:module')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudSearchRepository } = require('../../businessSearch/lib/cloud-search-repository')
const { createSearchService } = require('../../businessSearch/lib/search-service')

const secret = 'synthetic-card-search-secret-1234567890'
const now = new Date('2026-09-10T01:00:00Z')
const fields = [{ fieldKey: 'model', name: '型号', type: 'short_text', sequence: 0, required: false, constraints: {} }]
const summary = { state: 'ready', configRevision: 1, fields: [{ id: 'field-1', label: '型号', value: '示例型号' }] }

function seed() {
  const users = [
    { _id: 'member-1', status: 'active', role: 'user', openid: 'synthetic-member' },
    { _id: 'admin-1', status: 'active', role: 'super_admin', openid: 'synthetic-admin' },
    { _id: 'other-1', status: 'active', role: 'user', openid: 'synthetic-other' }
  ]
  const lines = [1, 2, 3].map(number => ({
    _id: `line-${number}`, code: `BL-TEST-000${number}`, name: '售后联调', description: '',
    sourceTemplateId: 'template-1', sourceTemplateVersion: 1, version: 3,
    status: number === 3 ? 'completed' : 'active', updatedAt: now, createdAt: now,
    progress: number === 3 ? 100 : 25, nodeCount: 1, currentNodeId: `node-${number}`, currentNodeIndex: 0,
    currentNodeName: '合成节点', managerUserIds: ['member-1'], memberUserIds: ['member-1'],
    searchIndexStatus: 'generated', searchSourceVersion: 1, searchGeneratedVersion: 1,
    searchGenerationId: 'generation-1', searchSchemaVersion: 2
  }))
  const token = crypto.createHmac('sha256', secret).update('售后').digest('base64url').slice(0, 22)
  return {
    users,
    wechat_bindings: users.map(user => ({ _id: crypto.createHash('sha256').update(user.openid).digest('hex'), userId: user._id })),
    user_credentials: users.map(user => ({ _id: user._id, mustChangePassword: false, lockedUntil: null })),
    system_settings: [{ _id: 'account_admin_state', activeSuperAdminCount: 1, revision: 0 }],
    templates: [{ _id: 'template-1', status: 'enabled', version: 1,
      cardDisplay: { schemaVersion: 1, revision: 1, fields: [{ nodeKey: 'node-key', fieldKey: 'model' }] } }],
    template_nodes: [{ _id: 'template-node-1', templateId: 'template-1', nodeKey: 'node-key', fields }],
    business_lines: lines,
    business_nodes: lines.map(line => ({ _id: line.currentNodeId, businessLineId: line._id,
      sourceTemplateNodeKey: 'node-key', name: '合成节点', sequence: 0, version: 3,
      workflowMode: 'review', processorUserIds: ['member-1'], reviewerUserIds: line.status === 'completed' ? [] : ['other-1'],
      processingRoundNumber: 1, reviewRoundNumber: 0, status: line.status === 'completed' ? 'completed' : 'in_progress',
      fieldDefinitions: fields, latestFeedbackId: `feedback-${line._id}`, latestFeedbackRevision: 1 })),
    node_feedback: lines.map(line => ({ _id: `feedback-${line._id}`, businessLineId: line._id,
      nodeId: line.currentNodeId, revision: 1, publishState: 'published', processingRoundNumber: 1,
      action: line.status === 'completed' ? 'complete_node' : 'save_progress',
      fieldValues: [{ fieldKey: 'model', name: '型号', type: 'short_text', value: '示例型号' }] })),
    business_search_documents: lines.flatMap(line => [
      { _id: `${line._id}-tokens`, documentType: 'tokens', businessLineId: line._id,
        generationId: 'generation-1', entryId: 'name', tokenHashes: [token] },
      { _id: `${line._id}-entry`, documentType: 'entry', businessLineId: line._id,
        generationId: 'generation-1', entryId: 'name', normalizedText: '售后联调',
        sourceKind: 'business_name', label: '售后名称', safeExcerpt: '售后联调', nodeName: '' }
    ])
  }
}

// Only the external SDK/database boundary is replaced. main constructs every
// API repository/domain service, and keyword calls execute the real Search chain.
async function withRuntime(run, options = {}) {
  const reads = []
  const fake = createFakeCloudDatabase(seed(), { ...options.database,
    transformRead(entry) { reads.push(entry.collection); return entry.data }
  })
  let currentUser = 'member-1'
  const search = createSearchService({ secret,
    repository: createCloudSearchRepository({ db: fake.db, clock: () => new Date(), secret }) })
  const originalLoad = Module._load
  const entry = require.resolve('../index')
  const previousEntry = require.cache[entry]
  const previousSecret = process.env.BUSINESS_SEARCH_HMAC_SECRET
  const originalError = console.error
  const logs = []
  const searchResponses = []
  try {
    if (options.search) process.env.BUSINESS_SEARCH_HMAC_SECRET = secret
    else delete process.env.BUSINESS_SEARCH_HMAC_SECRET
    console.error = (...args) => logs.push(args)
    delete require.cache[entry]
    Module._load = function externalBoundary(request, parent, isMain) {
      if (request === 'wx-server-sdk') return {
        init() {}, database: () => fake.db,
        async downloadFile() { throw new Error('unexpected storage download') },
        async getTempFileURL() { throw new Error('unexpected storage URL') },
        getWXContext: () => ({ OPENID: seed().users.find(user => user._id === currentUser)?.openid || '',
          ENV: 'synthetic-env', REQUESTID: 'synthetic-card-request' }),
        async callFunction(input) {
          assert.equal(input.name, 'businessSearch')
          assert.equal(input.data.operation, 'query')
          assert.deepEqual(Object.keys(input.data).sort(), ['operation', 'ticket'])
          const result = await search.queryRequest({ token: input.data.ticket })
          searchResponses.push(structuredClone(result))
          return { result }
        }
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    const { main } = require(entry)
    await run({ main, fake, reads, logs, searchResponses, as: id => { currentUser = id } })
  } finally {
    Module._load = originalLoad; console.error = originalError
    delete require.cache[entry]
    if (previousEntry) require.cache[entry] = previousEntry
    if (previousSecret === undefined) delete process.env.BUSINESS_SEARCH_HMAC_SECRET
    else process.env.BUSINESS_SEARCH_HMAC_SECRET = previousSecret
  }
}

function expectOk(response) {
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.data
}

test('default runtime ordinary/status lists and both dashboard envelopes share real summaries without changing sources', async () => {
  await withRuntime(async ({ main, fake }) => {
    const before = fake.documents('business_lines')
    const feedback = fake.documents('node_feedback')
    const ordinary = expectOk(await main({ action: 'listBusinessLines', payload: { pageSize: 5, status: 'active', scope: 'mine' } }))
    assert.equal(ordinary.items.length, 2)
    assert.equal(ordinary.items[0].code, 'BL-TEST-0001')
    assert.deepEqual(ordinary.items[0].cardSummary, summary)
    assert.equal(ordinary.total, 2)
    assert.equal(ordinary.hasMore, false)
    assert.equal(ordinary.pageSize, 5)
    const completed = expectOk(await main({ action: 'listBusinessLines', payload: { status: 'completed', scope: 'mine' } }))
    assert.deepEqual(completed.items.map(item => item._id), ['line-3'])
    assert.deepEqual(completed.items[0].cardSummary, summary)
    const dashboard = expectOk(await main({ action: 'getMyDashboardSummary' }))
    assert.deepEqual(dashboard.stats, { active: 2, completed: 1, pendingProcessing: 2 })
    assert.equal(dashboard.complete, true)
    const workspace = expectOk(await main({ action: 'getDashboardWorkspace' }))
    assert.deepEqual(workspace.stats, { active: 2, completed: 1, pendingMine: 2, pendingMineAvailable: true,
      pendingReviews: 0, unreadNotifications: 0, complete: true })
    for (const envelope of [dashboard, workspace]) {
      assert.equal(envelope.recent.length, 3)
      for (const item of envelope.recent) assert.deepEqual(item.cardSummary, summary)
    }
    const pending = expectOk(await main({ action: 'listMyPendingProcessing' }))
    assert.equal(pending.items.length, 2)
    assert.ok(pending.items.every(item => !Object.hasOwn(item, 'cardSummary')))
    assert.deepEqual(fake.documents('node_feedback'), feedback)
    assert.deepEqual(fake.documents('business_lines').map(({ cardSummary, ...line }) => line), before)
    assert.ok(fake.transactionRuns.every(run => run.operations <= 100))
  })
})

test('default runtime signed keyword pages preserve Search matches, cursors, counts and index status through decoration', async () => {
  await withRuntime(async ({ main, searchResponses }) => {
    const query = { keyword: '售后', status: 'active', scope: 'mine', pageSize: 1 }
    const first = expectOk(await main({ action: 'listBusinessLines', payload: query }))
    assert.deepEqual(first.items.map(item => item._id), ['line-1'])
    assert.deepEqual(first.items[0].cardSummary, summary)
    assert.equal(first.total, null)
    assert.equal(first.hasMore, true)
    assert.ok(first.cursor)
    assert.deepEqual(first.items[0].matches, [{ nodeName: '', label: '售后名称', excerpt: '售后联调' }])
    const second = expectOk(await main({ action: 'listBusinessLines', payload: { ...query, cursor: first.cursor } }))
    assert.deepEqual(second.items.map(item => item._id), ['line-2'])
    const completed = expectOk(await main({ action: 'listBusinessLines', payload: { keyword: '售后', status: 'completed', scope: 'mine' } }))
    assert.deepEqual(completed.items.map(item => item._id), ['line-3'])
    for (const [index, response] of [first, second, completed].entries()) {
      assert.deepEqual(response.items[0].cardSummary, summary)
      const original = searchResponses[index]
      assert.equal(response.total, null) // API contract; Search itself has no total.
      for (const key of ['hasMore', 'cursor', 'indexStatus']) assert.deepEqual(response[key], original[key], key)
      assert.deepEqual(response.items.map(({ cardSummary, ...base }) => base), original.items)
    }
  }, { search: true })
})

test('global admin nonmember gains no card field authority while member and ordinary access stay intact', async () => {
  await withRuntime(async ({ main, fake, as: actAs }) => {
    expectOk(await main({ action: 'listBusinessLines' })) // warm as member
    actAs('admin-1')
    for (const payload of [{}, { keyword: '售后' }]) {
      const response = expectOk(await main({ action: 'listBusinessLines', payload }))
      assert.equal(response.items.length, 3)
      for (const item of response.items) assert.deepEqual(item.cardSummary, { state: 'unavailable', fields: [], configRevision: 0 })
    }
    assert.equal((await main({ action: 'getBusinessLine', payload: { id: 'line-1' } })).code, 'FORBIDDEN')
    const line = fake.documents('business_lines')[0]
    fake.replace('business_lines', line._id, { ...line, memberUserIds: ['member-1', 'admin-1'] })
    const member = expectOk(await main({ action: 'listBusinessLines', payload: { scope: 'mine' } }))
    assert.deepEqual(member.items.map(item => item._id), ['line-1'])
    assert.deepEqual(member.items[0].cardSummary, summary)
    actAs('other-1')
    assert.deepEqual(expectOk(await main({ action: 'listBusinessLines' })).items, [])
  }, { search: true })
})

for (const change of ['membership', 'disabled', 'demoted']) {
  test(`default runtime ${change} between base read and summary cannot bypass current authorization`, async () => {
    await withRuntime(async ({ main, fake, as: actAs }) => {
      if (change === 'demoted') actAs('admin-1')
      expectOk(await main({ action: 'listBusinessLines' }))
      fake.beforeNextTransaction(() => {
        if (change === 'membership') for (const line of fake.documents('business_lines')) {
          fake.replace('business_lines', line._id, { ...line, memberUserIds: [], managerUserIds: [] })
        }
        else {
          const id = change === 'demoted' ? 'admin-1' : 'member-1'
          const user = fake.documents('users').find(item => item._id === id)
          fake.replace('users', id, { ...user, ...(change === 'disabled' ? { status: 'disabled' } : { role: 'user' }) })
        }
      })
      assert.equal((await main({ action: 'listBusinessLines' })).code, 'FORBIDDEN')
    })
  })
}

test('real metadata success refreshes before return; a failed derived write still succeeds and next read recovers', async () => {
  for (const failDerived of [false, true]) {
    let fakeDb
    await withRuntime(async ({ main, fake, logs }) => {
      fakeDb = fake
      const response = expectOk(await main({ action: 'updateBusinessMetadata', payload: {
        businessLineId: 'line-1', expectedVersion: 3, description: '合成说明'
      } }))
      assert.deepEqual(response, { id: 'line-1', version: 4, searchIndexStatus: 'pending' })
      const saved = fake.documents('business_lines')[0]
      assert.equal(saved.version, 4)
      assert.equal(saved.description, '合成说明')
      assert.equal(Boolean(saved.cardSummary), !failDerived)
      const list = expectOk(await main({ action: 'listBusinessLines', payload: { status: 'active', scope: 'mine' } }))
      assert.deepEqual(list.items.find(item => item._id === 'line-1').cardSummary, summary)
      assert.equal(fake.documents('business_lines')[0].cardSummary.lineVersion, 4)
      assert.deepEqual(fake.documents('business_lines')[0].updatedAt, saved.updatedAt)
      assert.equal(fake.documents('audit_logs').filter(item => item.action === 'UPDATE_BUSINESS_METADATA').length, 1)
      assert.doesNotMatch(JSON.stringify(logs), /synthetic-private/)
    }, { database: { afterTransaction({ result }) {
      if (failDerived && result && result.id === 'line-1' && result.version === 4) {
        fakeDb.failNextWrite({ collection: 'business_lines', operation: 'update', error: new Error('synthetic-private-refresh') })
      }
    } } })
  }
})

test('real original metadata failure is untouched and never begins a summary read or write', async () => {
  await withRuntime(async ({ main, fake, reads }) => {
    const before = fake.documents('business_lines')
    for (const version of [2, 3]) {
      reads.length = 0
      if (version === 3) fake.failNextWrite({ collection: 'audit_logs', operation: 'set', error: new Error('synthetic-original-failure') })
      const response = await main({ action: 'updateBusinessMetadata', payload: {
        businessLineId: 'line-1', expectedVersion: version, description: '合成说明'
      } })
      assert.equal(response.code, version === 2 ? 'VERSION_CONFLICT' : 'INTERNAL_ERROR')
      assert.equal(reads.includes('templates'), false)
      assert.deepEqual(fake.documents('business_lines'), before)
      assert.equal(fake.documents('audit_logs').length, 0)
    }
  })
})

test('unavailable derived source preserves legitimate base navigation and recovers without stale fields', async () => {
  await withRuntime(async ({ main, fake }) => {
    const initial = expectOk(await main({ action: 'listBusinessLines' }))
    const original = fake.documents('node_feedback')[0]
    const line = fake.documents('business_lines')[0]
    fake.replace('business_lines', line._id, { ...line, version: 4 })
    fake.replace('node_feedback', original._id, { ...original, publishState: 'reserved' })
    const unavailable = expectOk(await main({ action: 'listBusinessLines' }))
    assert.equal(unavailable.total, initial.total)
    assert.equal(unavailable.hasMore, initial.hasMore)
    const { cardSummary, ...base } = unavailable.items.find(item => item._id === line._id)
    const { cardSummary: previousSummary, ...previousBase } = initial.items.find(item => item._id === line._id)
    assert.deepEqual(previousSummary, summary)
    assert.deepEqual(cardSummary, { state: 'unavailable', fields: [], configRevision: 1 })
    assert.deepEqual(base, { ...previousBase, version: 4 })
    fake.replace('node_feedback', original._id, original)
    const recovered = expectOk(await main({ action: 'listBusinessLines' }))
    assert.deepEqual(recovered.items.find(item => item._id === line._id).cardSummary, summary)
  })
})

test('real config routes enforce current admin, revisions and reference deletion conflicts without workflow changes', async () => {
  await withRuntime(async ({ main, fake, as: actAs }) => {
    actAs('admin-1')
    const created = expectOk(await main({ action: 'createTemplate', payload: { name: '合成配置模板', description: '', nodes: [{
      sequence: 0, name: '合成配置节点', description: '', workflowMode: 'review',
      processorAssignmentMode: 'fixed_accounts', processorUserIds: ['member-1'],
      reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: [], reviewMode: 'any',
      processingSlaWorkHours: 8, reviewSlaWorkHours: 8, requiresEvidence: false, allowedEvidenceTypes: [],
      fields: [{ sequence: 0, name: '型号', type: 'short_text', required: false, constraints: {} }]
    }] } }))
    const templateId = created.template._id
    const refs = [{ nodeKey: created.nodes[0].nodeKey, fieldKey: created.nodes[0].fields[0].fieldKey }]
    assert.deepEqual(expectOk(await main({ action: 'getTemplateCardDisplay', payload: { templateId } })), { templateId, revision: 0, fields: [] })
    actAs('member-1')
    for (const action of ['getTemplateCardDisplay', 'updateTemplateCardDisplay']) {
      assert.equal((await main({ action, payload: { templateId, ...(action.startsWith('update') ? { expectedRevision: 0, fields: refs } : {}),
        actor: { _id: 'admin-1', role: 'super_admin' } } })).code, 'FORBIDDEN')
    }
    actAs('admin-1')
    assert.deepEqual(expectOk(await main({ action: 'updateTemplateCardDisplay', payload: { templateId, expectedRevision: 0, fields: refs } })),
      { templateId, revision: 1, fields: refs })
    assert.equal((await main({ action: 'updateTemplateCardDisplay', payload: { templateId, expectedRevision: 0, fields: [] } })).code, 'VERSION_CONFLICT')
    assert.equal((await main({ action: 'updateTemplateCardDisplay', payload: { templateId, expectedRevision: 1,
      fields: [{ nodeKey: refs[0].nodeKey, fieldKey: 'missing' }] } })).code, 'CARD_DISPLAY_INVALID')
    const original = fake.documents('templates').find(item => item._id === templateId)
    const deletion = await main({ action: 'updateTemplate', payload: { templateId, expectedVersion: original.version,
      definition: { name: original.name, description: '', nodes: [{ ...created.nodes[0], fields: [] }] } } })
    assert.equal(deletion.code, 'CARD_DISPLAY_INVALID')
    assert.deepEqual(fake.documents('templates').find(item => item._id === templateId), original)
    for (const key of ['version', 'definitionDigest', 'definitionNodeIds']) assert.deepEqual(original[key], created.template[key])
  })
})
