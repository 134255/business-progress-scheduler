const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudSearchRepository } = require('../lib/cloud-search-repository')
const { createSearchService } = require('../lib/search-service')
const { normalizeSearchQuery } = require('../lib/search-domain')

const SECRET = 'synthetic-query-recovery-secret-1234567890'
const NOW = new Date('2026-09-10T10:00:00Z')
const CUSTOMER = '合成紫岚客户'
const SEARCH_KEYS = ['searchSourceVersion', 'searchGeneratedVersion', 'searchIndexStatus',
  'searchGenerationId', 'searchUpdatedAt', 'searchGeneratedAt', 'searchSchemaVersion']

function seed(count = 1) {
  const data = { users: [{ _id: 'reader', role: 'super_admin', status: 'active' },
    { _id: 'other-reader', role: 'super_admin', status: 'active' }],
  business_lines: [], business_nodes: [], node_feedback: [], evidences: [] }
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, '0')
    const lineId = `line-${suffix}`, nodeId = `node-${suffix}`, feedbackId = `feedback-${suffix}`
    const versions = { searchSourceVersion: 10, searchGeneratedVersion: 0, searchIndexStatus: 'pending' }
    data.business_lines.push({ _id: lineId, code: `AF-20260910-${suffix}`, name: 'Synthetic service',
      description: '', status: 'completed', version: 7, flowSchemaVersion: 2, nodeCount: 1,
      currentNodeId: nodeId, managerUserIds: ['reader'], memberUserIds: ['reader'],
      createdAt: new Date('2026-09-09T01:00:00Z'), updatedAt: new Date(NOW), ...versions })
    data.business_nodes.push({ _id: nodeId, businessLineId: lineId, sequence: 0,
      name: '合成收集节点', nodeCode: `AF-20260910-${suffix}-N001`, status: 'completed', version: 4,
      routeState: 'completed', workflowMode: 'review', reviewerUserIds: [], processingRoundNumber: 1,
      latestFeedbackId: feedbackId, latestFeedbackRevision: 1, ...versions })
    data.node_feedback.push({ _id: feedbackId, businessLineId: lineId, nodeId, revision: 1,
      publishState: 'published', action: 'complete_node', processingRoundNumber: 1, comment: '',
      evidenceCount: 0, claimedCount: 0,
      fieldValues: [{ fieldKey: 'customer', name: '客户名称', type: 'short_text', value: CUSTOMER }] })
  }
  return data
}

function harness(data = seed(), options = {}) {
  let time = new Date(NOW), sequence = 0
  const reads = [], logs = []
  const fake = createFakeCloudDatabase(data, { ...options, transformRead(input) {
    reads.push({ collection: input.collection, id: input.data._id })
    return options.transformRead ? options.transformRead(input) : input.data
  } })
  const repository = createCloudSearchRepository({ db: fake.db, secret: SECRET, clock: () => new Date(time) })
  const service = createSearchService({ repository, secret: SECRET, generationIdFactory: () => `generation-${++sequence}`,
    logger: { error(...args) { logs.push(args) } } })
  async function query({ keyword = CUSTOMER, actorId = 'reader', ...input } = {}) {
    const normalized = normalizeSearchQuery({ keyword }), token = `synthetic-ticket-${++sequence}`
    const id = crypto.createHmac('sha256', SECRET).update(token).digest('hex')
    fake.replace('business_search_requests', id, { operation: 'query', actorId,
      normalizedKeywords: normalized.normalizedKeywords, digestInput: normalized.digestInput,
      cursor: '', pageSize: 20, ...input, status: 'pending', createdAt: new Date(time),
      expiresAt: new Date(time.getTime() + 60000) })
    return service.queryRequest({ token })
  }
  return { fake, reads, logs, repository, service, query, setTime(value) { time = value } }
}

const generated = h => h.fake.documents('business_lines').filter(line => line.searchIndexStatus === 'generated')
const scans = h => h.fake.queryCalls.filter(call => call.collection === 'business_lines')
function assertOnlyDerivedWrites(h) {
  assert.equal(h.fake.writeCalls.some(write => write.operation === 'remove'), false)
  for (const write of h.fake.writeCalls) {
    assert.ok(['business_search_requests', 'business_search_documents', 'business_lines', 'business_nodes'].includes(write.collection))
    if (['business_lines', 'business_nodes'].includes(write.collection)) {
      assert.equal(write.operation, 'update')
      assert.ok(Object.keys(write.data).every(key => SEARCH_KEYS.includes(key)))
    }
  }
  assert.deepEqual(h.fake.documents('system_settings'), [])
  assert.deepEqual(h.fake.transactionQueries, [])
}

test('query recovers completed source 10/generated 0 and matches code characters, substrings, node and stored Chinese value', async () => {
  const data = seed(), h = harness(data)
  const result = await h.query()
  assert.equal(result.items.length, 1)
  assert.ok(result.items[0].matches.some(match => match.label === '客户名称' && match.excerpt === CUSTOMER))
  assert.equal(generated(h)[0].searchGeneratedVersion, 10)
  for (const keyword of [...new Set(data.business_lines[0].code), '202609', '收集节点', '客户名称', '紫岚']) {
    assert.equal((await h.query({ keyword })).items.length, 1, keyword)
  }
  assert.equal(h.fake.documents('business_lines')[0].version, 7)
  assert.deepEqual(h.fake.documents('node_feedback'), data.node_feedback)
  assertOnlyDerivedWrites(h)
})

test('recovery attempts at most two lines and resumes without skipping unprocessed heads', async () => {
  const h = harness(seed(5))
  const first = await h.query()
  assert.deepEqual(first.items, [])
  assert.equal(first.indexStatus, 'recovering')
  assert.equal(first.hasMore, true)
  assert.match(first.cursor, /^recovery:/)
  assert.equal(generated(h).length, 2)
  const second = await h.query({ cursor: first.cursor })
  assert.equal(second.indexStatus, 'recovering')
  assert.equal(generated(h).length, 4)
  const final = await h.query({ cursor: second.cursor })
  assert.deepEqual(final.items.map(line => line._id), ['line-000', 'line-001', 'line-002', 'line-003', 'line-004'])
  assert.equal(final.hasMore, false)
  assert.equal(generated(h).length, 5)
  assertOnlyDerivedWrites(h)
})

test('forty unrelated raw heads consume the scan budget and cannot starve the next authorized line', async () => {
  const data = seed(41)
  data.users[0].role = 'user'
  for (const line of data.business_lines.slice(0, 40)) line.managerUserIds = line.memberUserIds = ['other-reader']
  const h = harness(data), first = await h.query()
  assert.equal(first.indexStatus, 'recovering')
  assert.equal(generated(h).length, 0)
  assert.equal(scans(h).length, 1)
  assert.equal(scans(h)[0].limit, 40)
  assert.equal(h.reads.some(read => ['business_nodes', 'node_feedback'].includes(read.collection)), false)
  const final = await h.query({ cursor: first.cursor })
  assert.deepEqual(final.items.map(line => line._id), ['line-040'])
  assert.equal(scans(h).every(call => call.offset === 0 && call.limit <= 40), true)
  assertOnlyDerivedWrites(h)
})

test('recovery authorization honors mine, state and Shanghai creation date before reading any node content', async () => {
  const data = seed(5)
  data.business_lines[0].memberUserIds = data.business_lines[0].managerUserIds = ['other-reader']
  data.business_lines[1].status = 'active'
  data.business_lines[2].createdAt = new Date('2026-09-08T00:00:00Z')
  data.business_lines[3].status = 'deleted'
  const h = harness(data)
  const result = await h.query({ scope: 'mine', businessStatus: 'completed', startDate: '2026-09-09', endDate: '2026-09-09' })
  assert.deepEqual(result.items.map(line => line._id), ['line-004'])
  assert.deepEqual(generated(h).map(line => line._id), ['line-004'])
  assert.equal(h.reads.some(read => read.collection === 'node_feedback' && read.id !== 'feedback-004'), false)
})

test('disabled and missing accounts never start recovery scans or content reads', async () => {
  for (const status of ['disabled', 'missing']) {
    const data = seed()
    if (status === 'missing') data.users = []
    else data.users[0].status = status
    const h = harness(data)
    assert.deepEqual((await h.query()).items, [])
    assert.deepEqual(scans(h), [])
    assert.equal(h.reads.some(read => read.collection === 'node_feedback'), false)
    assert.equal(generated(h).length, 0)
  }
})

test('strict legacy gets only derived version initialization while partial search state is never treated as legacy', async () => {
  const data = seed(2)
  for (const record of [...data.business_lines, ...data.business_nodes]) for (const key of SEARCH_KEYS) delete record[key]
  data.business_lines[1].searchSourceVersion = 0
  const h = harness(data), result = await h.query()
  assert.deepEqual(result.items.map(line => line._id), ['line-000'])
  assert.equal(generated(h)[0].searchGeneratedVersion, 1)
  const partial = h.fake.documents('business_lines')[1]
  assert.equal(partial.searchGeneratedVersion, undefined)
  assert.equal(h.reads.some(read => read.collection === 'node_feedback' && read.id === 'feedback-001'), false)
  assertOnlyDerivedWrites(h)
})

test('recovery cursors reject tampering, account, exact role, keyword, scope, status, dates and expired TTL', async () => {
  for (const change of ['signature', 'actor', 'role', 'keyword', 'scope', 'status', 'date', 'expiry']) {
    const h = harness(seed(3)), first = await h.query()
    assert.match(first.cursor, /^recovery:/)
    const input = { cursor: first.cursor }
    if (change === 'signature') input.cursor += 'x'
    if (change === 'actor') input.actorId = 'other-reader'
    if (change === 'role') h.fake.replace('users', 'reader', { role: 'admin', status: 'active' })
    if (change === 'keyword') input.keyword = '收集节点'
    if (change === 'scope') input.scope = 'mine'
    if (change === 'status') input.businessStatus = 'completed'
    if (change === 'date') input.startDate = '2026-09-09'
    if (change === 'expiry') h.setTime(new Date(NOW.getTime() + 5 * 60 * 1000))
    const scanCount = scans(h).length
    await assert.rejects(h.query(input), { code: 'INVALID_SEARCH_QUERY' }, change)
    assert.equal(scans(h).length, scanCount)
  }
})

test('ordinary result pagination does not restart recovery or pick up a newly pending line', async () => {
  const h = harness(seed(3))
  const recovering = await h.query({ pageSize: 1 })
  assert.equal(recovering.indexStatus, 'recovering')
  const first = await h.query({ pageSize: 1, cursor: recovering.cursor })
  assert.equal(first.items.length, 1)
  assert.ok(first.cursor && !first.cursor.startsWith('recovery:'))
  const next = seed(4)
  for (const collection of ['business_lines', 'business_nodes', 'node_feedback']) {
    const record = next[collection][3]
    h.fake.replace(collection, record._id, record)
  }
  const scanCount = scans(h).length
  const second = await h.query({ pageSize: 1, cursor: first.cursor })
  assert.deepEqual(second.items.map(line => line._id), ['line-001'])
  assert.equal(scans(h).length, scanCount)
  assert.equal(h.fake.documents('business_lines').find(line => line._id === 'line-003').searchIndexStatus, 'pending')
})

test('failed rebuild advances once and preserves incomplete until recovery completes and through result cursors', async () => {
  const data = seed(4)
  data.node_feedback[0].fieldValues[0].value = { privateText: 'must-not-leak' }
  const h = harness(data), first = await h.query({ pageSize: 1 })
  assert.equal(first.indexStatus, 'recovering')
  assert.deepEqual(first.items, [])
  assert.match(first.cursor, /^recovery:/)
  assert.equal(first.hasMore, true)
  assert.equal(first.diagnostics, undefined)
  assert.deepEqual(h.logs, [['[businessSearch]', { code: 'BUSINESS_SEARCH_FAILED', causeCode: 'SEARCH_SOURCE_INVALID',
    phase: 'build_entries', operation: 'recovery' }]])
  const failuresRead = h.reads.filter(read => read.collection === 'node_feedback' && read.id === 'feedback-000').length
  const final = await h.query({ pageSize: 1, cursor: first.cursor })
  assert.equal(final.indexStatus, 'incomplete')
  assert.ok(final.cursor && !final.cursor.startsWith('recovery:'))
  assert.equal(h.reads.filter(read => read.collection === 'node_feedback' && read.id === 'feedback-000').length, failuresRead)
  const next = await h.query({ pageSize: 1, cursor: final.cursor })
  assert.equal(next.indexStatus, 'incomplete')
  assert.deepEqual(next.items.map(line => line._id), ['line-002'])
  assert.equal(JSON.stringify([first, final, next]).includes('must-not-leak'), false)
})

test('revocation during discovery is rechecked before any authoritative node or feedback read', async () => {
  const data = seed()
  data.users[0].role = 'user'
  let h, revoked = false
  h = harness(data, { transformRead({ collection, data: record }) {
    if (collection === 'business_lines' && !revoked) {
      revoked = true
      h.fake.replace('business_lines', record._id, { ...record, managerUserIds: ['other-reader'], memberUserIds: ['other-reader'] })
    }
    return record
  } })
  assert.deepEqual((await h.query()).items, [])
  assert.equal(h.reads.some(read => ['business_nodes', 'node_feedback'].includes(read.collection)), false)
  assert.equal(generated(h).length, 0)
})

test('source advance before recovery publication cannot publish stale content or be reported complete', async () => {
  const h = harness(), publish = h.repository.publishGeneration
  h.repository.publishGeneration = async input => {
    const line = h.fake.documents('business_lines')[0]
    h.fake.replace('business_lines', line._id, { ...line, searchSourceVersion: 11 })
    return publish(input)
  }
  const result = await h.query()
  assert.equal(result.indexStatus, 'incomplete')
  assert.deepEqual(result.items, [])
  assert.equal(result.diagnostics, undefined)
  assert.deepEqual(h.logs, [['[businessSearch]', { code: 'BUSINESS_SEARCH_FAILED', causeCode: 'VERSION_CONFLICT',
    phase: 'publish_generation', operation: 'recovery' }]])
  assert.equal(generated(h).length, 0)
  assert.equal(result.hasMore, false)
})

test('legacy initialization and publication preserve the 48-node transaction budget', async () => {
  const data = seed()
  const node = data.business_nodes[0], feedback = data.node_feedback[0]
  data.business_lines[0].nodeCount = 48
  data.business_nodes = Array.from({ length: 48 }, (_, i) => ({ ...node, _id: `node-${String(i).padStart(3, '0')}`, sequence: i,
    nodeCode: `N${i}`, latestFeedbackId: `feedback-${i}` }))
  data.node_feedback = data.business_nodes.map(n => ({ ...feedback, _id: n.latestFeedbackId, nodeId: n._id }))
  for (const record of [...data.business_lines, ...data.business_nodes]) for (const key of SEARCH_KEYS) delete record[key]
  const h = harness(data)
  assert.equal((await h.query()).items.length, 1)
  assert.ok(h.fake.transactionRuns.every(transaction => transaction.operations <= 100))
  assert.equal(h.fake.documents('business_nodes').every(n => n.searchGeneratedVersion === 1), true)
  assertOnlyDerivedWrites(h)
})

test('old generated schema is rebuilt without advancing business or source versions; schema 2 skips rebuilding', async () => {
  for (const schema of [undefined, 1]) {
    const data = seed()
    for (const record of [...data.business_lines, ...data.business_nodes]) {
      Object.assign(record, { searchIndexStatus: 'generated', searchGeneratedVersion: 10, searchGenerationId: 'old-incomplete' })
      if (schema !== undefined) record.searchSchemaVersion = schema
    }
    const h = harness(data)
    assert.equal(await h.repository.isGenerationCurrent({ businessLineId: 'line-000', sourceVersion: 10 }), false)
    assert.equal((await h.query()).items.length, 1)
    const line = generated(h)[0]
    assert.equal(line.searchSchemaVersion, 2)
    assert.equal(line.searchSourceVersion, 10)
    assert.equal(line.version, 7)
    assert.equal(await h.repository.isGenerationCurrent({ businessLineId: 'line-000', sourceVersion: 10 }), true)
    const writes = h.fake.writeCalls.filter(write => write.collection === 'business_search_documents').length
    assert.equal((await h.query()).items.length, 1)
    assert.equal(h.fake.writeCalls.filter(write => write.collection === 'business_search_documents').length, writes)
  }
})

test('recovery failures use only safe diagnostic phases and causes without leaking raw exception data', async () => {
  const h = harness()
  h.fake.failNextWrite({ collection: 'business_search_documents', operation: 'set',
    error: Object.assign(new Error('private-customer-and-ticket'), { code: 'PRIVATE_DATABASE_FAILURE' }) })
  const result = await h.query()
  assert.equal(result.indexStatus, 'incomplete')
  assert.deepEqual(h.logs, [['[businessSearch]', { code: 'BUSINESS_SEARCH_FAILED', causeCode: 'UNKNOWN',
    phase: 'publish_generation', operation: 'recovery' }]])
  assert.equal(JSON.stringify([h.logs, result]).includes('private-customer-and-ticket'), false)
})

test('query tickets and repository accept 51 and 100 supplementary Unicode code points', async () => {
  for (const length of [51, 100]) {
    const data = seed(), keyword = '𠮷'.repeat(length)
    data.node_feedback[0].fieldValues[0].value = keyword
    const h = harness(data)
    assert.equal((await h.query({ keyword })).items.length, 1)
    assert.equal((await h.repository.queryAuthorized({ actorId: 'reader', normalizedKeywords: [keyword],
      digestInput: keyword, pageSize: 20 })).items.length, 1)
  }
})

test('repository and consumed tickets reject total keyword lengths over 100 code points', async () => {
  const h = harness(), words = ['甲'.repeat(60), '乙'.repeat(41)]
  await assert.rejects(h.repository.queryAuthorized({ actorId: 'reader', normalizedKeywords: words,
    digestInput: words.join('\u0000'), pageSize: 20 }), { code: 'INVALID_SEARCH_QUERY' })
  const token = 'synthetic-invalid-total', id = crypto.createHmac('sha256', SECRET).update(token).digest('hex')
  h.fake.replace('business_search_requests', id, { operation: 'query', actorId: 'reader', status: 'pending',
    createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60000), normalizedKeywords: words,
    digestInput: words.join('\u0000'), pageSize: 20, cursor: '' })
  await assert.rejects(h.service.queryRequest({ token }), { code: 'FORBIDDEN' })
})

test('corrupt schema 2 generated headers are incomplete without content reads or speculative repair', async () => {
  for (const corruption of ['version-gap', 'missing-generation', 'empty-generation', 'string-version']) {
    const data = seed(), line = data.business_lines[0]
    Object.assign(line, { searchIndexStatus: 'generated', searchGeneratedVersion: 10,
      searchGenerationId: 'synthetic-generation', searchSchemaVersion: 2 })
    if (corruption === 'version-gap') line.searchGeneratedVersion = 9
    if (corruption === 'missing-generation') delete line.searchGenerationId
    if (corruption === 'empty-generation') line.searchGenerationId = ''
    if (corruption === 'string-version') line.searchSourceVersion = '10'
    const h = harness(data), result = await h.query()
    assert.equal(result.indexStatus, 'incomplete', corruption)
    assert.equal(result.hasMore, false)
    assert.deepEqual(result.items, [])
    assert.deepEqual(h.fake.documents('business_lines'), data.business_lines)
    assert.equal(h.reads.some(read => ['business_nodes', 'node_feedback'].includes(read.collection)), false)
    assert.equal(h.fake.writeCalls.some(write => write.collection !== 'business_search_requests'), false)
    assert.deepEqual(h.logs, [['[businessSearch]', { code: 'BUSINESS_SEARCH_FAILED', causeCode: 'SEARCH_SOURCE_INVALID',
      phase: 'recovery', operation: 'recovery' }]])
  }
})

test('encrypted recovery cursor never reveals unrelated scan IDs and authenticates ciphertext with fresh nonces', async () => {
  const data = seed(41)
  data.users[0].role = 'user'
  for (const line of data.business_lines.slice(0, 40)) {
    line._id = `a-private-forbidden-${line._id}`
    line.managerUserIds = line.memberUserIds = ['other-reader']
  }
  const h = harness(data), first = await h.query(), samePosition = await h.query()
  assert.equal(first.indexStatus, 'recovering')
  assert.notEqual(first.cursor, samePosition.cursor)
  const bytes = Buffer.from(first.cursor.slice('recovery:'.length), 'base64url')
  assert.equal(bytes.toString('utf8').includes('a-private-forbidden-'), false)
  assert.equal(bytes.toString('utf8').includes('afterId'), false)
  assert.deepEqual(Object.keys(first).sort(), ['cursor', 'hasMore', 'indexStatus', 'items'])
  bytes[bytes.length - 1] ^= 1
  await assert.rejects(h.query({ cursor: `recovery:${bytes.toString('base64url')}` }), { code: 'INVALID_SEARCH_QUERY' })
})

test('recovery initial actor and transactional actor/head read errors are incomplete, not silent authorization skips', async () => {
  for (const failure of [
    { collection: 'users', id: 'reader', transaction: false },
    { collection: 'users', id: 'reader', transaction: true },
    { collection: 'business_lines', id: 'line-000', transaction: true }
  ]) {
    const h = harness()
    h.fake.failNextRead({ ...failure, error: new Error('private-timeout-customer-record') })
    const result = await h.query()
    assert.equal(result.indexStatus, 'incomplete', JSON.stringify(failure))
    assert.deepEqual(result.items, [])
    assert.equal(result.hasMore, false)
    assert.equal(generated(h).length, 0)
    assert.equal(h.reads.some(read => read.collection === 'node_feedback'), false)
    assert.deepEqual(h.logs, [['[businessSearch]', { code: 'BUSINESS_SEARCH_FAILED', causeCode: 'UNKNOWN',
      phase: 'recovery', operation: 'recovery' }]])
    assert.equal(JSON.stringify([h.logs, result]).includes('private-timeout'), false)
  }
})

test('a skipped head read failure remains incomplete across recovery and every ordinary results page', async () => {
  const h = harness(seed(5))
  h.fake.failNextRead({ collection: 'business_lines', id: 'line-000', transaction: true,
    error: new Error('private-head-timeout') })
  const first = await h.query({ pageSize: 1 })
  assert.equal(first.indexStatus, 'recovering')
  assert.deepEqual(first.items, [])
  assert.match(first.cursor, /^recovery:/)
  const final = await h.query({ pageSize: 1, cursor: first.cursor })
  assert.equal(final.indexStatus, 'incomplete')
  assert.deepEqual(final.items.map(line => line._id), ['line-001'])
  let page = final
  const ids = page.items.map(line => line._id)
  for (let index = 0; page.hasMore && index < 5; index += 1) {
    assert.ok(!page.cursor.startsWith('recovery:'))
    page = await h.query({ pageSize: 1, cursor: page.cursor })
    assert.equal(page.indexStatus, 'incomplete')
    ids.push(...page.items.map(line => line._id))
  }
  assert.deepEqual(ids, ['line-001', 'line-002', 'line-003', 'line-004'])
  assert.equal(h.fake.documents('business_lines')[0].searchIndexStatus, 'pending')
  assert.equal(h.reads.some(read => read.collection === 'node_feedback' && read.id === 'feedback-000'), false)
  assert.equal(h.logs.length, 1)
})

test('recovery legacy initialization and publication retain original read-failure diagnostics and never publish', async () => {
  for (const stage of ['legacy', 'publish']) for (const collection of ['users', 'business_lines']) {
    const data = seed()
    if (stage === 'legacy') {
      for (const record of [...data.business_lines, ...data.business_nodes]) for (const key of SEARCH_KEYS) delete record[key]
    }
    const h = harness(data)
    h.fake.failNextRead({ collection, id: collection === 'users' ? 'reader' : 'line-000', transaction: true,
      after: stage === 'legacy' ? 1 : 2, error: new Error('private-fixed-read-timeout') })
    const result = await h.query()
    assert.equal(result.indexStatus, 'incomplete', `${stage}:${collection}`)
    assert.deepEqual(result.items, [])
    assert.equal(generated(h).length, 0)
    assert.deepEqual(h.logs, [['[businessSearch]', { code: 'BUSINESS_SEARCH_FAILED', causeCode: 'UNKNOWN',
      phase: stage === 'legacy' ? 'recovery' : 'publish_generation', operation: 'recovery' }]])
    assertOnlyDerivedWrites(h)
  }
})

function legacyMetadataSeed({ initialized = true } = {}) {
  const versions = initialized
    ? { searchSourceVersion: 1, searchGeneratedVersion: 0, searchIndexStatus: 'pending' }
    : {}
  return {
    users: [{ _id: 'reader', role: 'user', status: 'active' }],
    business_lines: [{ _id: 'legacy-line', code: 'SYN-190', name: '合成旧售后',
      description: '', status: 'active', version: 1, nodeCount: 3, currentNodeId: 'legacy-node-0',
      managerUserIds: ['reader'], memberUserIds: ['reader'],
      createdAt: new Date(NOW), updatedAt: new Date(NOW), ...versions }],
    business_nodes: ['合成受理', '合成检验', '合成交付'].map((name, sequence) => ({
      _id: `legacy-node-${sequence}`, businessLineId: 'legacy-line', sequence, name,
      nodeCode: `SYN-190-N00${sequence + 1}`, sourceTemplateNodeKey: `step-${sequence}`,
      status: sequence === 0 ? 'ready' : 'waiting', version: 1,
      ...(sequence === 1 ? { activationMode: 'required' } : {}),
      assigneeUserIds: ['reader'], fieldDefinitions: [{ fieldKey: 'note', sequence: 0,
        name: '合成备注', type: 'short_text', required: false, constraints: { maxLength: 100 } }],
      ...versions
    })),
    node_feedback: [], node_review_rounds: [], node_review_votes: [], evidences: []
  }
}

for (const initialized of [true, false]) {
  test(`legacy metadata-only ready/waiting nodes recover ${initialized ? 'pending' : 'uninitialized'} indexes without inventing rounds`, async () => {
    const data = legacyMetadataSeed({ initialized }), h = harness(data)
    for (const keyword of ['9', '190', '合成受理', '合成检验', '合成交付']) {
      const result = await h.query({ keyword })
      assert.deepEqual(result.items.map(line => line._id), ['legacy-line'])
      assert.equal(result.indexStatus, undefined)
      assert.equal(result.hasMore, false)
    }
    const line = generated(h)[0]
    assert.equal(line.searchSchemaVersion, 2)
    assert.equal(line.searchSourceVersion, 1)
    assert.equal(line.searchGeneratedVersion, 1)
    const withoutSearch = row => Object.fromEntries(Object.entries(row).filter(([key]) => !SEARCH_KEYS.includes(key)))
    assert.deepEqual(withoutSearch(line), withoutSearch(data.business_lines[0]))
    assert.deepEqual(h.fake.documents('business_nodes').map(withoutSearch), data.business_nodes.map(withoutSearch))
    for (const collection of ['node_feedback', 'node_review_rounds', 'node_review_votes', 'evidences']) {
      assert.deepEqual(h.fake.documents(collection), [])
      assert.equal(h.fake.queryCalls.some(call => call.collection === collection), false)
      assert.equal(h.fake.writeCalls.some(write => write.collection === collection), false)
    }
    assertOnlyDerivedWrites(h)
  })
}

test('legacy metadata-only round exception rejects mixed modern markers and present invalid rounds on ready or waiting nodes', async () => {
  const corruptions = [
    { workflowMode: 'review' }, { workflowMode: null }, { processorUserIds: [] }, { reviewerUserIds: [] },
    { processorAssignmentMode: 'fixed' }, { reviewerAssignmentMode: 'fixed' },
    { reviewRoundNumber: 0 }, { reviewMode: 'OR' }, { processingDueStatus: 'not_started' },
    { routeState: 'active' }, { nodeKey: 'modern-node' }, { next: { mode: 'end' } },
    { latestFeedbackId: null }, { latestFeedbackRevision: 0 }, { activeReviewRoundId: null },
    { lastReviewRoundId: null }, { feedbackClaimId: 'claim' }, { latestComment: 'saved' },
    { activationMode: 'optional_tail' }, { activationMode: null }, { activationMode: 'unknown' },
    { processingRoundNumber: undefined }, { processingRoundNumber: null },
    { processingRoundNumber: 0 }, { processingRoundNumber: '1' }
  ]
  for (const nodeIndex of [0, 1]) for (const corruption of corruptions) {
    const data = legacyMetadataSeed()
    Object.assign(data.business_nodes[nodeIndex], corruption)
    const h = harness(data), result = await h.query({ keyword: '9' })
    assert.equal(result.indexStatus, 'incomplete', `${nodeIndex}:${Object.keys(corruption)[0]}`)
    assert.deepEqual(result.items, [])
    assert.equal(generated(h).length, 0)
    assert.deepEqual(h.fake.documents('business_nodes'), data.business_nodes)
  }
})

test('legacy metadata-only round exception never accepts dynamic nodes, missing codes or invalid assignees', async () => {
  for (const corruption of [
    { status: 'in_progress' }, { status: 'blocked' }, { status: 'completed' }, { status: 'pending_review' },
    { status: 'pending' }, { nodeCode: '' }, { name: '' }, { assigneeUserIds: [] },
    { assigneeUserIds: ['reader', 'reader'] }
  ]) {
    const data = legacyMetadataSeed()
    Object.assign(data.business_nodes[0], corruption)
    const h = harness(data), result = await h.query({ keyword: '9' })
    assert.equal(result.indexStatus, 'incomplete')
    assert.deepEqual(result.items, [])
    assert.equal(generated(h).length, 0)
  }
  const data = seed()
  Object.assign(data.business_nodes[0], { status: 'in_progress', latestFeedbackId: 'missing-pointer' })
  const h = harness(data), result = await h.query()
  assert.equal(result.indexStatus, 'incomplete')
  assert.deepEqual(result.items, [])
  assert.equal(generated(h).length, 0)
})

function legacyFeedbackSeed({ status = 'in_progress', evidenceCount = 4, ordered = false } = {}) {
  const data = legacyMetadataSeed(), node = data.business_nodes[0]
  data.business_lines[0].version = 2
  Object.assign(node, { status, version: 2, latestFeedbackId: 'legacy-feedback',
    latestFeedbackRevision: 1, latestComment: '合成当前说明' })
  if (status === 'completed') {
    data.business_lines[0].currentNodeId = 'legacy-node-1'
    data.business_nodes[1].status = 'ready'
  }
  const fields = [
    { fieldKey: 'text', name: '合成客户字段', type: 'short_text', value: '合成紫杉客户' },
    { fieldKey: 'long', name: '合成长文本', type: 'long_text', value: '合成处理经过' },
    { fieldKey: 'number', name: '合成数量', type: 'number', value: 37 },
    { fieldKey: 'boolean', name: '合成开关', type: 'boolean', value: true },
    { fieldKey: 'date', name: '合成日期', type: 'date', value: '2026-09-10' },
    { fieldKey: 'single', name: '合成单选', type: 'single_select', value: '合成选项甲' },
    { fieldKey: 'multi', name: '合成多选', type: 'multi_select', value: ['合成选项乙', '合成选项丙'] }
  ]
  node.fieldDefinitions = fields.map(({ value, ...field }, sequence) => ({ ...field, sequence,
    required: false, constraints: field.type.endsWith('select')
      ? { options: ['合成选项甲', '合成选项乙', '合成选项丙'] } : {} }))
  data.node_feedback = [{ _id: 'legacy-feedback', businessLineId: 'legacy-line', nodeId: node._id,
    nodeCode: node.nodeCode, nodeName: node.name, status, publishState: 'published',
    revision: 1, plannedRevision: 1, expectedNodeVersion: 1, lineStatus: 'active',
    fieldValues: fields, comment: node.latestComment, evidenceCount, claimedCount: evidenceCount,
    evidenceTotalBytes: evidenceCount, claimedBytes: evidenceCount, freezesLine: false,
    createdAt: new Date(NOW), submittedAt: new Date(NOW), transitionAt: new Date(NOW) }]
  data.evidences = Array.from({ length: evidenceCount }, (_, index) => ({
    _id: `legacy-evidence-${String(evidenceCount - index).padStart(3, '0')}`,
    businessLineId: 'legacy-line', nodeId: node._id, feedbackId: 'legacy-feedback', feedbackRevision: 1,
    ...(ordered ? { feedbackEvidenceOrder: index } : {}), attachmentState: 'attached', storageStatus: 'available',
    fileId: `cloud://synthetic/legacy-${index}.pdf`, fileName: `合成凭证${index}.pdf`, size: 1,
    retentionScope: 'business_line', retentionSource: 'node_feedback', purgedAt: null
  }))
  return data
}

for (const status of ['in_progress', 'blocked', 'completed']) {
  test(`legacy published ${status} feedback recovers fields comments and exact attached evidence without invented rounds`, async () => {
    const data = legacyFeedbackSeed({ status }), h = harness(data)
    for (const keyword of ['9', '合成受理', '合成客户字段', '紫杉客户', '当前说明', '合成凭证3',
      '处理经过', '37', '是', '2026-09-10', '合成选项甲', '合成选项丙']) {
      const result = await h.query({ keyword })
      assert.deepEqual(result.items.map(line => line._id), ['legacy-line'], `${status}:${keyword}`)
      assert.equal(result.indexStatus, undefined)
    }
    assert.equal(generated(h)[0].searchGeneratedVersion, 1)
    assert.equal(generated(h)[0].version, 2)
    assert.equal(generated(h)[0].status, 'active')
    const snapshot = await h.repository.loadAuthoritativeSnapshot({ businessLineId: 'legacy-line', sourceVersion: 1 })
    assert.deepEqual(snapshot.nodes[0].evidenceFileNames, ['合成凭证3.pdf', '合成凭证2.pdf', '合成凭证1.pdf', '合成凭证0.pdf'])
    const withoutSearch = row => Object.fromEntries(Object.entries(row).filter(([key]) => !SEARCH_KEYS.includes(key)))
    assert.deepEqual(h.fake.documents('business_nodes').map(withoutSearch), data.business_nodes.map(withoutSearch))
    for (const collection of ['node_feedback', 'evidences', 'node_review_rounds', 'node_review_votes']) {
      assert.deepEqual(h.fake.documents(collection), data[collection])
    }
    assert.equal(h.fake.queryCalls.some(call => ['node_review_rounds', 'node_review_votes'].includes(call.collection)), false)
    assertOnlyDerivedWrites(h)
  })
}

test('legacy published snapshots do not merge older feedback fields comments or attachments into an invented round', async () => {
  const data = legacyFeedbackSeed()
  data.node_feedback.unshift({ ...data.node_feedback[0], _id: 'older-feedback',
    fieldValues: [{ fieldKey: 'old', name: '旧字段', type: 'short_text', value: '过时合成字段' }],
    comment: '过时合成说明', evidenceCount: 1, claimedCount: 1 })
  Object.assign(data.node_feedback[1], { revision: 2, plannedRevision: 2, expectedNodeVersion: 2 })
  Object.assign(data.business_nodes[0], { latestFeedbackRevision: 2, version: 3 })
  for (const evidence of data.evidences) evidence.feedbackRevision = 2
  data.evidences.push({ ...data.evidences[0], _id: 'older-evidence', feedbackId: 'older-feedback',
    feedbackRevision: 1, fileName: '过时合成附件.pdf' })
  const h = harness(data)
  assert.equal((await h.query({ keyword: '紫杉客户' })).items.length, 1)
  for (const keyword of ['过时合成字段', '过时合成说明', '过时合成附件']) {
    assert.deepEqual((await h.query({ keyword })).items, [])
  }
  assert.equal(h.fake.queryCalls.some(call => call.collection === 'node_feedback'), false)
})

test('legacy published attachment pagination preserves exact selection order beyond one hundred documents', async () => {
  const h = harness(legacyFeedbackSeed({ evidenceCount: 105, ordered: true }))
  assert.equal((await h.query({ keyword: '合成凭证104' })).items.length, 1)
  const snapshot = await h.repository.loadAuthoritativeSnapshot({ businessLineId: 'legacy-line', sourceVersion: 1 })
  assert.deepEqual(snapshot.nodes[0].evidenceFileNames,
    Array.from({ length: 105 }, (_, index) => `合成凭证${index}.pdf`))
  assert.equal(h.fake.queryCalls.filter(call => call.collection === 'evidences').every(call => call.limit === 100), true)
})

test('legacy published pagination fixture uses consistent string ordering and keyset comparisons', async () => {
  const fake = createFakeCloudDatabase({ business_search_documents: [
    { _id: 'one', entryId: 'node:10:0' }, { _id: 'two', entryId: 'node:100:0' }
  ] })
  const first = await fake.db.collection('business_search_documents').orderBy('entryId', 'asc').limit(1).get()
  assert.equal(first.data[0].entryId, 'node:100:0')
  const second = await fake.db.collection('business_search_documents')
    .where({ entryId: fake.db.command.gt(first.data[0].entryId) }).orderBy('entryId', 'asc').limit(1).get()
  assert.equal(second.data[0].entryId, 'node:10:0')
})

test('legacy published snapshots reject modern markers and mismatched published pointers or statuses', async () => {
  const cases = [
    ['node', { workflowMode: 'review' }], ['node', { processorUserIds: [] }], ['node', { reviewerUserIds: [] }],
    ['node', { processingRoundNumber: null }], ['node', { processingRoundNumber: 0 }],
    ['node', { latestFeedbackId: 'missing' }], ['node', { latestFeedbackRevision: 2 }],
    ['feedback', { action: 'save_progress' }], ['feedback', { action: undefined }],
    ['feedback', { processingRoundNumber: undefined }], ['feedback', { processingRoundNumber: 1 }],
    ['feedback', { publishState: 'reserved' }], ['feedback', { publishState: undefined }],
    ['feedback', { status: 'completed' }], ['feedback', { nodeId: 'foreign-node' }],
    ['feedback', { businessLineId: 'foreign-line' }], ['feedback', { revision: '1' }],
    ['feedback', { fieldValues: null }], ['feedback', { comment: null }]
  ]
  for (const [target, change] of cases) {
    const data = legacyFeedbackSeed()
    Object.assign(target === 'node' ? data.business_nodes[0] : data.node_feedback[0], change)
    const h = harness(data), result = await h.query({ keyword: '紫杉客户' })
    assert.equal(result.indexStatus, 'incomplete', `${target}:${Object.keys(change)[0]}`)
    assert.deepEqual(result.items, [])
    assert.equal(generated(h).length, 0)
  }
})

test('legacy published attachments reject missing claims wrong ownership modern rounds and invalid ordering', async () => {
  for (const change of [{ nodeId: 'foreign' }, { businessLineId: 'foreign' }, { feedbackRevision: 2 },
    { processingRoundNumber: 1 }, { processingRoundNumber: undefined },
    { attachmentState: 'reserved' }, { storageStatus: 'purged' }, { feedbackEvidenceOrder: -1 }]) {
    const data = legacyFeedbackSeed()
    Object.assign(data.evidences[0], change)
    const h = harness(data), result = await h.query({ keyword: '紫杉客户' })
    assert.equal(result.indexStatus, 'incomplete', Object.keys(change)[0])
    assert.deepEqual(result.items, [])
    assert.equal(generated(h).length, 0)
  }
  for (const kind of ['missing-document', 'claim-mismatch']) {
    const data = legacyFeedbackSeed()
    if (kind === 'missing-document') data.evidences.pop()
    else data.node_feedback[0].claimedCount = 3
    const h = harness(data), result = await h.query({ keyword: '紫杉客户' })
    assert.equal(result.indexStatus, 'incomplete')
    assert.deepEqual(result.items, [])
  }
})

function missingNodeSearchSeed({ nodeCount = 2, allMissing = false } = {}) {
  const data = seed(), line = data.business_lines[0], current = data.business_nodes[0]
  delete line.flowSchemaVersion
  Object.assign(line, { status: 'active', version: 3, nodeCount, searchSourceVersion: 2 })
  delete current.routeState
  Object.assign(current, { status: 'in_progress', version: 3, processorUserIds: ['reader'],
    reviewerUserIds: ['other-reader'], latestFeedbackRevision: 2, searchSourceVersion: 2 })
  data.business_nodes = [current, ...Array.from({ length: nodeCount - 1 }, (_, index) => ({
    _id: `untouched-${String(index + 1).padStart(3, '0')}`, businessLineId: line._id,
    sequence: index + 1, status: 'waiting', version: 1, workflowMode: 'review',
    name: `合成等待节点${index + 1}`, nodeCode: `SYN-W${index + 1}`,
    processorUserIds: ['reader'], reviewerUserIds: ['other-reader'], processingRoundNumber: 1,
    fieldDefinitions: []
  }))]
  if (allMissing) for (const key of SEARCH_KEYS) delete current[key]
  const latest = data.node_feedback[0]
  Object.assign(latest, { status: 'in_progress', action: 'save_progress', revision: 2,
    evidenceCount: 1, claimedCount: 1 })
  data.node_feedback = [{ ...latest, _id: 'prior-feedback', revision: 1 }, latest]
  data.evidences = data.node_feedback.map((feedback, index) => ({
    _id: `owned-evidence-${index}`, businessLineId: line._id, nodeId: current._id,
    feedbackId: feedback._id, feedbackRevision: feedback.revision, processingRoundNumber: 1,
    feedbackEvidenceOrder: 0, attachmentState: 'attached', storageStatus: 'available',
    fileId: `cloud://synthetic/current-${index}.pdf`, fileName: `合成附件${index}.pdf`
  }))
  return data
}

test('whole-missing node search state recovers untouched waiting nodes under an already versioned line', async () => {
  const data = missingNodeSearchSeed(), h = harness(data)
  await assert.rejects(h.repository.loadAuthoritativeSnapshot({ businessLineId: 'line-000', sourceVersion: 2 }),
    { code: 'SEARCH_SOURCE_INVALID' })
  assert.deepEqual(h.fake.documents('business_nodes'), data.business_nodes)
  const result = await h.query()
  assert.deepEqual(result.items.map(line => line._id), ['line-000'])
  assert.equal(result.indexStatus, undefined)
  for (const keyword of ['9', '合成等待节点1', '合成附件0', '合成附件1']) {
    assert.equal((await h.query({ keyword })).items.length, 1, keyword)
  }
  const withoutSearch = row => Object.fromEntries(Object.entries(row).filter(([key]) => !SEARCH_KEYS.includes(key)))
  assert.deepEqual(h.fake.documents('business_lines').map(withoutSearch), data.business_lines.map(withoutSearch))
  assert.deepEqual(h.fake.documents('business_nodes').map(withoutSearch), data.business_nodes.map(withoutSearch))
  assert.deepEqual(h.fake.documents('node_feedback'), data.node_feedback)
  assert.deepEqual(h.fake.documents('evidences'), data.evidences)
  assert.equal(h.fake.documents('business_nodes').every(node => node.searchSourceVersion === 2 &&
    node.searchGeneratedVersion === 2 && node.searchSchemaVersion === 2), true)
  assertOnlyDerivedWrites(h)
})

test('whole-missing node initialization never treats partial or corrupt search metadata as absent', async () => {
  for (const state of [
    { searchSourceVersion: 2 }, { searchGeneratedVersion: 0 }, { searchIndexStatus: 'pending' },
    { searchUpdatedAt: NOW }, { searchSchemaVersion: 2 }, { searchGenerationId: '' },
    { searchSourceVersion: 2, searchGeneratedVersion: 3, searchIndexStatus: 'pending' },
    { searchSourceVersion: '2', searchGeneratedVersion: 0, searchIndexStatus: 'pending' }
  ]) {
    const data = missingNodeSearchSeed({ nodeCount: 3 })
    Object.assign(data.business_nodes[1], state)
    const h = harness(data), result = await h.query()
    assert.equal(result.indexStatus, 'incomplete', Object.keys(state)[0])
    assert.deepEqual(result.items, [])
    assert.equal(generated(h).length, 0)
    assert.deepEqual(h.fake.documents('business_nodes'), data.business_nodes)
  }
})

test('whole-missing node initialization rechecks actor line and all fixed node versions before derived writes', async () => {
  for (const change of ['actor-disabled', 'line-version', 'line-source', 'current-node-version',
    'waiting-node-version', 'waiting-node-owner', 'concurrent-partial-state']) {
    const data = missingNodeSearchSeed()
    let h, queued = false
    h = harness(data, { transformRead({ collection, data: row }) {
      if (!queued && collection === 'business_nodes' && row._id === 'untouched-001') {
        queued = true
        h.fake.beforeNextTransaction(() => {
          if (change === 'actor-disabled') h.fake.replace('users', 'reader', { ...data.users[0], status: 'disabled' })
          else if (change.startsWith('line-')) h.fake.replace('business_lines', 'line-000', {
            ...data.business_lines[0], ...(change === 'line-version' ? { version: 4 } : { searchSourceVersion: 3 })
          })
          else if (change === 'current-node-version') h.fake.replace('business_nodes', 'node-000', {
            ...data.business_nodes[0], version: 4
          })
          else h.fake.replace('business_nodes', 'untouched-001', { ...data.business_nodes[1],
            ...(change === 'waiting-node-version' ? { version: 2 } : change === 'waiting-node-owner'
              ? { businessLineId: 'foreign-line' } : { searchSourceVersion: 2 }) })
        })
      }
      return row
    } })
    const result = await h.query()
    assert.equal(queued, true)
    assert.equal(result.indexStatus, 'incomplete', change)
    assert.deepEqual(result.items, [])
    assert.equal(generated(h).length, 0)
    assert.equal(h.fake.writeCalls.some(write => write.collection !== 'business_search_requests'), false)
  }
})

test('whole-missing node initialization keeps forty-eight fixed reads and writes inside the transaction budget', async () => {
  const h = harness(missingNodeSearchSeed({ nodeCount: 48, allMissing: true }))
  assert.equal((await h.query()).items.length, 1)
  assert.equal(h.fake.documents('business_nodes').every(node => node.searchGeneratedVersion === 2), true)
  assert.ok(h.fake.transactionRuns.some(transaction => transaction.operations === 98))
  assert.ok(h.fake.transactionRuns.every(transaction => transaction.operations <= 100))
  assertOnlyDerivedWrites(h)
})

test('whole-missing node initialization read and write failures stay incomplete and never leave partial initialization', async () => {
  for (const operation of ['read', 'write']) {
    const data = missingNodeSearchSeed({ nodeCount: 3 }), h = harness(data)
    if (operation === 'read') h.fake.failNextRead({ collection: 'business_nodes', id: 'untouched-002',
      transaction: true, error: new Error('synthetic-node-read-failure') })
    else h.fake.failNextWrite({ collection: 'business_nodes', id: 'untouched-002', operation: 'update',
      error: new Error('synthetic-node-write-failure') })
    const result = await h.query()
    assert.equal(result.indexStatus, 'incomplete')
    assert.deepEqual(result.items, [])
    assert.deepEqual(h.fake.documents('business_nodes'), data.business_nodes)
    assert.equal(generated(h).length, 0)
    assert.equal(h.logs.length, 1)
    assert.deepEqual(h.logs[0][1], { code: 'BUSINESS_SEARCH_FAILED', causeCode: 'UNKNOWN',
      phase: 'load_snapshot', operation: 'recovery' })
  }
})
