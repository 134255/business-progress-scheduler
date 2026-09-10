const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudSearchRepository } = require('../lib/cloud-search-repository')
const { createSearchService } = require('../lib/search-service')
const { createCloudBusinessRepository } = require('../../businessApi/lib/cloud-business-repository')

const SECRET = 'search-filter-tests-only-secret-1234567890'
const NOW = new Date('2026-09-09T01:00:00Z')
const TOKEN = 'synthetic-query-ticket-at-least-192-bits'
const requestId = crypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex')
const anchorHash = crypto.createHmac('sha256', SECRET).update('售后').digest('base64url').slice(0, 22)

function seedLines(count = 8) {
  const lines = Array.from({ length: count }, (_, index) => ({
    _id: `line-${String(index).padStart(3, '0')}`, code: `BL-${index}`, name: '售后筛选',
    status: index % 2 ? 'completed' : 'active',
    managerUserIds: ['member'], memberUserIds: index < 6 ? ['root', 'member'] : ['member'],
    searchIndexStatus: 'generated', searchSourceVersion: 1, searchGeneratedVersion: 1, searchSchemaVersion: 2,
    searchGenerationId: 'generation-1', currentNodeId: '', createdAt: NOW
  }))
  return {
    users: [{ _id: 'root', role: 'super_admin', status: 'active' },
      { _id: 'member', role: 'user', status: 'active' }, { _id: 'outsider', role: 'user', status: 'active' }],
    business_lines: lines,
    business_search_documents: lines.flatMap(line => [
      { _id: `${line._id}-tokens`, documentType: 'tokens', businessLineId: line._id,
        generationId: 'generation-1', entryId: 'name', tokenHashes: [anchorHash] },
      { _id: `${line._id}-entry`, documentType: 'entry', businessLineId: line._id,
        generationId: 'generation-1', entryId: 'name', normalizedText: '售后筛选',
        label: '售后名称', sourceKind: 'business_name', safeExcerpt: '售后筛选', nodeName: '' }
    ]),
    business_search_requests: []
  }
}

function harness(seed = seedLines(), options = {}) {
  const fake = createFakeCloudDatabase(seed, options)
  const repository = createCloudSearchRepository({ db: fake.db, clock: () => new Date(NOW), secret: SECRET })
  return { fake, repository, service: createSearchService({ repository, secret: SECRET }) }
}

function query(overrides = {}) {
  return { actorId: 'root', normalizedKeywords: ['售后'], digestInput: '售后', pageSize: 2, cursor: '', ...overrides }
}

function queryTicket(filters = {}) {
  return { _id: requestId, operation: 'query', actorId: 'root', normalizedKeywords: ['售后'],
    digestInput: '售后', pageSize: 20, cursor: '', status: 'pending', createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60000), ...filters }
}

test('mine search matches the actual business repository for independent own relationship contributions', async () => {
  for (const actorId of ['root', 'member']) {
    for (const scenario of [
      { name: 'normal', relations: { managerUserIds: ['outsider'], memberUserIds: [actorId] }, visible: true },
      { name: 'empty manager', relations: { managerUserIds: [], memberUserIds: [actorId] }, visible: true },
      { name: 'empty member', relations: { managerUserIds: [actorId], memberUserIds: [] }, visible: true },
      { name: 'null manager', relations: { managerUserIds: null, memberUserIds: [actorId] }, visible: true },
      { name: 'null member', relations: { managerUserIds: [actorId], memberUserIds: null }, visible: true },
      { name: 'missing manager', relations: { memberUserIds: [actorId] }, visible: true },
      { name: 'missing member', relations: { managerUserIds: [actorId] }, visible: true },
      { name: 'invalid new marker with matching legacy', relations: { managerUserIds: null }, visible: false },
      { name: 'getter marker with matching legacy', relations: {}, getter: true, visible: false },
      { name: 'getter side with independent member', relations: { memberUserIds: [actorId] }, getter: true, visible: true },
      { name: 'invalid id invalidates its array', relations: { managerUserIds: [], memberUserIds: [actorId, 'bad id'] }, visible: false },
      { name: 'invalid manager does not erase member', relations: { managerUserIds: ['bad id'], memberUserIds: [actorId] }, visible: true },
      { name: 'duplicate ids invalidate their array', relations: { memberUserIds: [actorId, actorId] }, visible: false },
      { name: 'unassociated own arrays block legacy', relations: { managerUserIds: [], memberUserIds: ['outsider'] }, visible: false },
      { name: 'pure legacy', relations: {}, visible: true }
    ]) {
      const seed = seedLines(1)
      const actor = seed.users.find(item => item._id === actorId)
      actor.openid = 'synthetic-bound-identity'
      const line = seed.business_lines[0]
      delete line.managerUserIds
      delete line.memberUserIds
      Object.assign(line, scenario.relations, { managerIds: ['synthetic-bound-identity'], memberIds: [] })
      let accessed = false
      const value = harness(seed, { transformRead({ collection, data }) {
        if (collection === 'business_lines' && scenario.getter) Object.defineProperty(data, 'managerUserIds',
          { enumerable: true, get() { accessed = true; return [actorId] } })
        return data
      } })
      const businessRepository = createCloudBusinessRepository({ db: value.fake.db, clock: () => new Date(NOW) })
      const listed = await businessRepository.listBusinessLines({ actor, query: { status: 'active', scope: 'mine' } })
      const searched = await value.repository.queryAuthorized(query({ actorId, businessStatus: 'active', scope: 'mine' }))
      const expected = scenario.visible ? ['line-000'] : []
      assert.deepEqual(listed.items.map(item => item._id), expected, `${actorId}: ${scenario.name}: business`)
      assert.deepEqual(searched.items.map(item => item._id), expected, `${actorId}: ${scenario.name}: search`)
      assert.equal(accessed, false, scenario.name)
    }
  }
})

test('ordinary search without mine retains its existing complete nonempty relationship-pair contract', async () => {
  for (const relations of [
    { managerUserIds: [], memberUserIds: ['member'] },
    { managerUserIds: ['member'], memberUserIds: [] },
    { managerUserIds: null, memberUserIds: ['member'] }
  ]) {
    const seed = seedLines(1)
    Object.assign(seed.business_lines[0], relations)
    const result = await harness(seed).repository.queryAuthorized(query({ actorId: 'member' }))
    assert.deepEqual(result.items, [])
  }
})

test('mine search accepts manager-only and member-only unions with legitimate empty arrays without granting empty unions', async () => {
  for (const actorId of ['root', 'member']) {
    for (const [managers, members, visible] of [
      [[actorId], [], true], [[], [actorId], true], [[], [], false],
      [['outsider'], [], false], [[], ['outsider'], false]
    ]) {
      const seed = seedLines(1)
      seed.users.find(actor => actor._id === actorId).openid = 'synthetic-bound-identity'
      Object.assign(seed.business_lines[0], { managerUserIds: managers, memberUserIds: members,
        managerIds: ['synthetic-bound-identity'], memberIds: ['synthetic-bound-identity'] })
      const result = await harness(seed).repository.queryAuthorized(query({ actorId, businessStatus: 'active', scope: 'mine' }))
      assert.deepEqual(result.items.map(item => item._id), visible ? ['line-000'] : [],
        JSON.stringify({ actorId, managers, members }))
    }
  }
})

test('a damaged own account relationship marker cannot downgrade mine search to matching legacy identities', async () => {
  for (const field of ['managerUserIds', 'memberUserIds']) {
    const seed = seedLines(1)
    seed.users[0].openid = 'synthetic-bound-identity'
    delete seed.business_lines[0].managerUserIds
    delete seed.business_lines[0].memberUserIds
    Object.assign(seed.business_lines[0], { managerIds: ['synthetic-bound-identity'], memberIds: [] })
    let accessed = false
    const value = harness(seed, { transformRead({ collection, data }) {
      if (collection === 'business_lines') Object.defineProperty(data, field,
        { enumerable: true, get() { accessed = true; return ['root'] } })
      return data
    } })
    const result = await value.repository.queryAuthorized(query({ businessStatus: 'active', scope: 'mine' }))
    assert.deepEqual(result.items, [], field)
    assert.equal(accessed, false, field)
    const legacyResult = await harness(seed).repository.queryAuthorized(query({ businessStatus: 'active', scope: 'mine' }))
    assert.deepEqual(legacyResult.items.map(item => item._id), ['line-000'])
  }
})

test('keyword status and mine filters run before page truncation and preserve administrator defaults', async () => {
  const { repository } = harness()
  for (const [businessStatus, firstIds, secondIds] of [
    ['active', ['line-000', 'line-002'], ['line-004']],
    ['completed', ['line-001', 'line-003'], ['line-005']]
  ]) {
    const filters = { businessStatus, scope: 'mine' }
    const first = await repository.queryAuthorized(query(filters))
    assert.deepEqual(first.items.map(item => item._id), firstIds)
    assert.equal(first.hasMore, true)
    const second = await repository.queryAuthorized(query({ ...filters, cursor: first.cursor }))
    assert.deepEqual(second.items.map(item => item._id), secondIds)
    assert.equal(second.hasMore, false)
    assert.equal((await repository.queryAuthorized(query({ businessStatus, pageSize: 20 }))).items.length, 4)
    assert.equal((await repository.queryAuthorized(query({ actorId: 'member', businessStatus, scope: 'mine', pageSize: 20 }))).items.length, 4)
  }
  assert.equal((await repository.queryAuthorized(query({ pageSize: 20 }))).items.length, 8)
  assert.deepEqual((await repository.queryAuthorized(query({ actorId: 'outsider', businessStatus: 'active' }))).items, [])
})

test('keyword cursors cannot cross status or scope even with the same supplied digest', async () => {
  const { repository } = harness()
  const first = await repository.queryAuthorized(query({ businessStatus: 'active', scope: 'mine' }))
  assert.ok(first.cursor)
  for (const filters of [{ businessStatus: 'completed', scope: 'mine' }, { businessStatus: 'active' }, { scope: 'mine' }]) {
    await assert.rejects(repository.queryAuthorized(query({ ...filters, cursor: first.cursor })),
      { code: 'INVALID_SEARCH_QUERY' })
  }
})

test('an empty filtered raw candidate page retains a cursor to later matching lines', async () => {
  const seed = seedLines(102)
  seed.business_lines.forEach((line, index) => { line.status = index < 100 ? 'completed' : 'active' })
  const { repository } = harness(seed)
  const first = await repository.queryAuthorized(query({ businessStatus: 'active', pageSize: 20 }))
  assert.deepEqual(first.items, [])
  assert.equal(first.hasMore, true)
  assert.ok(first.cursor)
  const second = await repository.queryAuthorized(query({ businessStatus: 'active', pageSize: 20, cursor: first.cursor }))
  assert.deepEqual(second.items.map(item => item._id), ['line-100', 'line-101'])
})

test('second candidate authorization rejects changed status, removed mine relation and disabled actors', async () => {
  for (const change of ['status', 'relation', 'disabled']) {
    const seed = seedLines(1)
    let reads = 0
    let armed = false
    const value = harness(seed, { transformRead({ collection, data }) {
      if (!armed) return data
      if (collection === 'business_lines' && ++reads >= 2) {
        if (change === 'status') return { ...data, status: 'completed' }
        if (change === 'relation') return { ...data, memberUserIds: ['member'] }
      }
      if (collection === 'users' && change === 'disabled' && reads >= 1) return { ...data, status: 'disabled' }
      return data
    } })
    armed = true
    const result = await value.repository.queryAuthorized(query({ businessStatus: 'active', scope: 'mine' }))
    assert.deepEqual(result.items, [], change)
  }
})

test('query tickets preserve business filters through consumption and service dispatch while old tickets remain unfiltered', async () => {
  for (const [filters, ids] of [
    [{ businessStatus: 'completed', scope: 'mine' }, ['line-001', 'line-003', 'line-005']],
    [{}, ['line-000', 'line-001', 'line-002', 'line-003', 'line-004', 'line-005', 'line-006', 'line-007']]
  ]) {
    const seed = seedLines()
    seed.business_search_requests = [queryTicket(filters)]
    const value = harness(seed)
    const result = await value.service.queryRequest({ token: TOKEN })
    assert.deepEqual(result.items.map(item => item._id), ids)
    assert.equal(value.fake.documents('business_search_requests')[0].status, 'consumed')
  }
})

test('query filters and ticket filters reject unsupported values and accessors without consuming the ticket', async () => {
  for (const filters of [{ businessStatus: '' }, { businessStatus: 'closed' }, { businessStatus: null },
    { businessStatus: 1 }, { businessStatus: undefined }, { scope: '' }, { scope: 'global' }, { scope: false }, { scope: undefined }]) {
    const seed = seedLines()
    seed.business_search_requests = [queryTicket(filters)]
    const value = harness(seed)
    await assert.rejects(value.repository.consumeRequest({ token: TOKEN, operation: 'query' }), { code: 'FORBIDDEN' })
    assert.equal(value.fake.documents('business_search_requests')[0].status, 'pending')
    await assert.rejects(value.repository.queryAuthorized(query(filters)), { code: 'INVALID_SEARCH_QUERY' })
  }
  let accessed = false
  const input = query()
  Object.defineProperty(input, 'businessStatus', { get() { accessed = true; return 'active' } })
  await assert.rejects(harness().repository.queryAuthorized(input), { code: 'INVALID_SEARCH_QUERY' })
  assert.equal(accessed, false)
})
