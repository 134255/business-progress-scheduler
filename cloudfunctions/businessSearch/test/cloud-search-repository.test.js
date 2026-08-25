const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { buildSearchEntries, tokenizeEntry, normalizeSearchQuery } = require('../lib/search-domain')
const { createCloudSearchRepository } = require('../lib/cloud-search-repository')

const NOW = new Date('2026-08-25T10:00:00.000Z')
const SECRET = 'search-secret-for-tests-only-1234567890'
const TOKEN = 'ticket-token-with-at-least-192-bits-of-randomness'

function ticketId(token = TOKEN) {
  return crypto.createHmac('sha256', SECRET).update(token, 'utf8').digest('hex')
}

function requestTicket(overrides = {}) {
  return {
    _id: ticketId(),
    operation: 'index',
    actorId: 'member-1',
    businessLineId: 'line-1',
    sourceVersion: 3,
    status: 'pending',
    createdAt: new Date('2026-08-25T09:55:00.000Z'),
    expiresAt: new Date('2026-08-25T10:05:00.000Z'),
    ...overrides
  }
}

function fieldValues(prefix) {
  return [
    { fieldKey: 'summary', name: '故障描述', type: 'short_text', value: `${prefix}故障` },
    { fieldKey: 'urgent', name: '是否加急', type: 'boolean', value: true }
  ]
}

function authoritativeSeed() {
  return {
    users: [
      { _id: 'member-1', status: 'active', role: 'user', openid: 'openid-member-1' },
      { _id: 'manager-1', status: 'active', role: 'admin' },
      { _id: 'reviewer-1', status: 'active', role: 'user' },
      { _id: 'root-1', status: 'active', role: 'super_admin' },
      { _id: 'outsider-1', status: 'active', role: 'user' }
    ],
    business_lines: [{
      _id: 'line-1', code: 'BL-20260825-0001', name: '清闲售后', description: '需要上门处理',
      status: 'active', currentNodeId: 'node-2', nodeCount: 4,
      managerUserIds: ['manager-1'], memberUserIds: ['member-1', 'reviewer-1'],
      searchSourceVersion: 3, searchGeneratedVersion: 0, searchIndexStatus: 'pending'
    }],
    business_nodes: [
      {
        _id: 'node-1', businessLineId: 'line-1', sequence: 0, name: '处理中节点', nodeCode: 'N001',
        status: 'in_progress', processingRoundNumber: 2, latestFeedbackId: 'feedback-current',
        latestFeedbackRevision: 2, searchSourceVersion: 3, searchGeneratedVersion: 0,
        searchIndexStatus: 'pending'
      },
      {
        _id: 'node-2', businessLineId: 'line-1', sequence: 1, name: '待审核节点', nodeCode: 'N002',
        status: 'pending_review', processingRoundNumber: 1, activeReviewRoundId: 'round-pending',
        searchSourceVersion: 3, searchGeneratedVersion: 0, searchIndexStatus: 'pending'
      },
      {
        _id: 'node-3', businessLineId: 'line-1', sequence: 2, name: '已完成节点', nodeCode: 'N003',
        status: 'completed', processingRoundNumber: 2, lastReviewRoundId: 'round-approved',
        searchSourceVersion: 3, searchGeneratedVersion: 0, searchIndexStatus: 'pending'
      },
      {
        _id: 'node-4', businessLineId: 'line-1', sequence: 3, name: '等待节点', nodeCode: 'N004',
        status: 'ready', processingRoundNumber: 1,
        searchSourceVersion: 3, searchGeneratedVersion: 0, searchIndexStatus: 'pending'
      }
    ],
    node_feedback: [
      {
        _id: 'feedback-old', businessLineId: 'line-1', nodeId: 'node-1', processingRoundNumber: 2,
        revision: 1, publishState: 'published', action: 'save_progress', fieldValues: fieldValues('旧版'),
        processingComment: '旧处理说明', evidenceIds: []
      },
      {
        _id: 'feedback-current', businessLineId: 'line-1', nodeId: 'node-1', processingRoundNumber: 2,
        revision: 2, publishState: 'published', action: 'save_progress', fieldValues: fieldValues('当前'),
        processingComment: '当前处理说明', evidenceIds: ['evidence-current']
      }
    ],
    node_review_rounds: [
      {
        _id: 'round-pending', businessLineId: 'line-1', nodeId: 'node-2', status: 'pending',
        finalDecision: null, processingRoundNumber: 1, reviewRoundNumber: 1,
        fieldValues: fieldValues('审核中'), processingComment: '待审核处理说明',
        evidenceIds: ['evidence-review']
      },
      {
        _id: 'round-approved', businessLineId: 'line-1', nodeId: 'node-3', status: 'approved',
        finalDecision: 'approved', processingRoundNumber: 2, reviewRoundNumber: 2,
        fieldValues: fieldValues('最终'), processingComment: '最终处理说明',
        evidenceIds: ['evidence-final']
      },
      {
        _id: 'round-rejected', businessLineId: 'line-1', nodeId: 'node-3', status: 'rejected',
        finalDecision: 'rejected', processingRoundNumber: 1, reviewRoundNumber: 1,
        fieldValues: fieldValues('已驳回'), processingComment: '旧驳回说明', evidenceIds: []
      }
    ],
    node_review_votes: [
      {
        _id: 'vote-pending', reviewRoundId: 'round-pending', businessLineId: 'line-1', nodeId: 'node-2',
        reviewerUserId: 'reviewer-1', decision: 'approved', comment: '当前审核意见'
      },
      {
        _id: 'vote-approved', reviewRoundId: 'round-approved', businessLineId: 'line-1', nodeId: 'node-3',
        reviewerUserId: 'reviewer-1', decision: 'approved', comment: '最终审核意见'
      },
      {
        _id: 'vote-rejected', reviewRoundId: 'round-rejected', businessLineId: 'line-1', nodeId: 'node-3',
        reviewerUserId: 'reviewer-1', decision: 'rejected', comment: '旧驳回意见'
      }
    ],
    evidences: [
      {
        _id: 'evidence-current', businessLineId: 'line-1', nodeId: 'node-1', feedbackId: 'feedback-current',
        fileName: '当前现场照片.jpg', storageStatus: 'available', purgedAt: null, fileId: 'cloud://secret/current'
      },
      {
        _id: 'evidence-review', businessLineId: 'line-1', nodeId: 'node-2',
        fileName: '待审核报告.pdf', storageStatus: 'available', purgedAt: null, fileId: 'cloud://secret/review'
      },
      {
        _id: 'evidence-final', businessLineId: 'line-1', nodeId: 'node-3',
        fileName: '最终验收单.pdf', storageStatus: 'available', purgedAt: null, fileId: 'cloud://secret/final'
      }
    ],
    business_search_requests: [requestTicket()],
    business_search_documents: []
  }
}

function harness(seed = authoritativeSeed(), options = {}) {
  const { clock = () => new Date(NOW), ...fakeOptions } = options
  const fake = createFakeCloudDatabase(seed, fakeOptions)
  return {
    fake,
    repository: createCloudSearchRepository({ db: fake.db, clock, secret: SECRET })
  }
}

test('一次性票据只能消费一次且绑定操作、账号、售后和版本', async () => {
  const { repository, fake } = harness()
  const first = await repository.consumeRequest({ token: TOKEN, operation: 'index' })
  assert.deepEqual(first, {
    actorId: 'member-1', businessLineId: 'line-1', sourceVersion: 3, operation: 'index'
  })
  await assert.rejects(repository.consumeRequest({ token: TOKEN, operation: 'index' }), { code: 'FORBIDDEN' })
  const stored = fake.documents('business_search_requests')[0]
  assert.equal(stored.status, 'consumed')
  assert.equal(JSON.stringify(stored).includes(TOKEN), false)
})

test('一次性票据拒绝过期、跨操作和损坏结构', async () => {
  for (const ticket of [
    requestTicket({ expiresAt: new Date('2026-08-25T09:59:59.000Z') }),
    requestTicket({ operation: 'query' }),
    requestTicket({ sourceVersion: '3' })
  ]) {
    const { repository } = harness({ ...authoritativeSeed(), business_search_requests: [ticket] })
    await assert.rejects(repository.consumeRequest({ token: TOKEN, operation: 'index' }), { code: 'FORBIDDEN' })
  }
})

test('权威快照按节点状态只选择当前处理、活动审核、最终通过和等待元数据', async () => {
  const { repository } = harness()
  const snapshot = await repository.loadAuthoritativeSnapshot({ businessLineId: 'line-1', sourceVersion: 3 })
  assert.equal(snapshot.nodes.length, 4)
  assert.equal(snapshot.nodes[0].processingComment, '当前处理说明')
  assert.equal(snapshot.nodes[0].fieldValues[0].value, '当前故障')
  assert.deepEqual(snapshot.nodes[0].evidenceFileNames, ['当前现场照片.jpg'])
  assert.deepEqual(snapshot.nodes[1].reviewComments, ['当前审核意见'])
  assert.equal(snapshot.nodes[2].processingComment, '最终处理说明')
  assert.deepEqual(snapshot.nodes[2].reviewComments, ['最终审核意见'])
  assert.deepEqual(snapshot.nodes[3].fieldValues, [])
  assert.equal(JSON.stringify(snapshot).includes('旧处理说明'), false)
  assert.equal(JSON.stringify(snapshot).includes('旧驳回意见'), false)
  assert.equal(JSON.stringify(snapshot).includes('cloud://'), false)
})

test('售后版本作为并发屏障允许未变节点版本落后并在发布时统一追平', async () => {
  const data = authoritativeSeed()
  data.business_nodes[1].searchSourceVersion = 2
  data.business_nodes[2].searchSourceVersion = 1
  data.business_nodes[3].searchSourceVersion = 0
  data.node_feedback[1].action = 'mark_blocked'
  const { repository, fake } = harness(data)

  const snapshot = await repository.loadAuthoritativeSnapshot({ businessLineId: 'line-1', sourceVersion: 3 })
  assert.equal(snapshot.nodes[0].processingComment, '当前处理说明')
  await repository.publishGeneration({
    businessLineId: 'line-1', sourceVersion: 3, generationId: 'generation-compatible',
    entries: indexedEntries(snapshot)
  })

  assert.equal(fake.documents('business_nodes').every(node =>
    node.searchSourceVersion === 3 && node.searchGeneratedVersion === 3 &&
    node.searchIndexStatus === 'generated'), true)
})

test('权威快照对跨售后凭证和损坏最终轮次失败关闭', async () => {
  const crossEvidence = authoritativeSeed()
  crossEvidence.evidences[0].businessLineId = 'line-other'
  await assert.rejects(harness(crossEvidence).repository.loadAuthoritativeSnapshot({
    businessLineId: 'line-1', sourceVersion: 3
  }), { code: 'SEARCH_SOURCE_INVALID' })

  const badRound = authoritativeSeed()
  badRound.node_review_rounds[1].finalDecision = 'rejected'
  await assert.rejects(harness(badRound).repository.loadAuthoritativeSnapshot({
    businessLineId: 'line-1', sourceVersion: 3
  }), { code: 'SEARCH_SOURCE_INVALID' })
})

function indexedEntries(snapshot) {
  return buildSearchEntries(snapshot).map(entry => ({
    ...entry,
    nodeName: snapshot.nodes.find(node => node.nodeId === entry.nodeId)?.name || '',
    tokenChunks: tokenizeEntry(entry, SECRET)
  }))
}

test('完整新代分批写入后原子发布且不向 set 数据写显式文档编号', async () => {
  const { repository, fake } = harness(authoritativeSeed(), { rejectExplicitIdOnSet: true })
  const snapshot = await repository.loadAuthoritativeSnapshot({ businessLineId: 'line-1', sourceVersion: 3 })
  const result = await repository.publishGeneration({
    businessLineId: 'line-1', sourceVersion: 3, generationId: 'generation-3',
    entries: indexedEntries(snapshot)
  })
  assert.equal(result.generatedVersion, 3)
  const line = fake.documents('business_lines')[0]
  assert.equal(line.searchGeneratedVersion, 3)
  assert.equal(line.searchGenerationId, 'generation-3')
  assert.equal(line.searchIndexStatus, 'generated')
  assert.ok(fake.documents('business_nodes').every(node => node.searchGeneratedVersion === 3))
  assert.ok(fake.documents('business_search_documents').length > snapshot.nodes.length)
  assert.ok(fake.transactionRuns.every(run => run.operations <= 100))
})

test('写入中断或来源推进不会发布部分代际', async () => {
  const interrupted = harness()
  interrupted.fake.failNextWrite({
    collection: 'business_search_documents', operation: 'set', error: new Error('write failed')
  })
  const snapshot = await interrupted.repository.loadAuthoritativeSnapshot({ businessLineId: 'line-1', sourceVersion: 3 })
  await assert.rejects(interrupted.repository.publishGeneration({
    businessLineId: 'line-1', sourceVersion: 3, generationId: 'generation-bad',
    entries: indexedEntries(snapshot)
  }))
  assert.equal(interrupted.fake.documents('business_lines')[0].searchIndexStatus, 'pending')

  const advanced = harness()
  const nextSnapshot = await advanced.repository.loadAuthoritativeSnapshot({ businessLineId: 'line-1', sourceVersion: 3 })
  advanced.fake.beforeNextTransaction(() => {
    const current = advanced.fake.documents('business_lines')[0]
    advanced.fake.replace('business_lines', current._id, { ...current, searchSourceVersion: 4 })
  })
  await assert.rejects(advanced.repository.publishGeneration({
    businessLineId: 'line-1', sourceVersion: 3, generationId: 'generation-stale',
    entries: indexedEntries(nextSnapshot)
  }), { code: 'VERSION_CONFLICT' })
  assert.notEqual(advanced.fake.documents('business_lines')[0].searchGenerationId, 'generation-stale')
})

async function generatedHarness() {
  const value = harness()
  const snapshot = await value.repository.loadAuthoritativeSnapshot({ businessLineId: 'line-1', sourceVersion: 3 })
  await value.repository.publishGeneration({
    businessLineId: 'line-1', sourceVersion: 3, generationId: 'generation-3', entries: indexedEntries(snapshot)
  })
  return value
}

test('普通成员按现有关系检索，活动超级管理员可全局检索且摘要最多三条', async () => {
  const { repository } = await generatedHarness()
  const query = normalizeSearchQuery({ keyword: '清闲 当前' })
  const member = await repository.queryAuthorized({
    actorId: 'member-1', normalizedKeywords: query.normalizedKeywords, digestInput: query.digestInput,
    pageSize: 20, cursor: ''
  })
  assert.equal(member.items.length, 1)
  assert.equal(member.items[0]._id, 'line-1')
  assert.ok(member.items[0].matches.length > 0)
  assert.ok(member.items[0].matches.some(match => match.excerpt.includes('清闲')))
  assert.ok(member.items[0].matches.some(match => match.excerpt.includes('当前')))
  assert.ok(member.items[0].matches.length <= 3)

  const root = await repository.queryAuthorized({
    actorId: 'root-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: ''
  })
  assert.equal(root.items.length, 1)

  const outsider = await repository.queryAuthorized({
    actorId: 'outsider-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: ''
  })
  assert.deepEqual(outsider.items, [])
})

test('单个代际超过100条安全内容仍能命中后续字段', async () => {
  const value = await generatedHarness()
  for (let index = 0; index < 100; index += 1) {
    const suffix = String(index).padStart(3, '0')
    value.fake.replace('business_search_documents', `decoy-entry-${suffix}`, {
      _id: `decoy-entry-${suffix}`,
      documentType: 'entry',
      businessLineId: 'line-1',
      generationId: 'generation-3',
      entryId: `000-decoy-${suffix}`,
      normalizedText: '无关占位内容',
      safeExcerpt: '无关占位内容',
      sourceKind: 'field',
      label: '占位字段',
      segmentIndex: index,
      nodeName: '占位节点',
      createdAt: NOW
    })
  }
  const result = await value.repository.queryAuthorized({
    actorId: 'member-1', normalizedKeywords: ['当前'], digestInput: '当前', pageSize: 20, cursor: ''
  })
  assert.equal(result.items.length, 1)
  assert.ok(result.items[0].matches.some(match => match.excerpt.includes('当前')))
})

test('纯旧OpenID关系兼容授权，混合新旧关系不回退旧字段', async () => {
  const legacy = await generatedHarness()
  const current = legacy.fake.documents('business_lines')[0]
  const { managerUserIds, memberUserIds, ...withoutAccountRelationships } = current
  legacy.fake.replace('business_lines', current._id, {
    ...withoutAccountRelationships,
    managerIds: ['openid-manager-1'],
    memberIds: ['openid-member-1']
  })
  const allowed = await legacy.repository.queryAuthorized({
    actorId: 'member-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: ''
  })
  assert.equal(allowed.items.length, 1)

  const mixed = await generatedHarness()
  const line = mixed.fake.documents('business_lines')[0]
  mixed.fake.replace('business_lines', line._id, {
    ...line,
    managerUserIds: [],
    memberUserIds: [],
    managerIds: [],
    memberIds: ['openid-member-1']
  })
  const denied = await mixed.repository.queryAuthorized({
    actorId: 'member-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: ''
  })
  assert.deepEqual(denied.items, [])
})

test('查询返回前撤权、账号停用或超级管理员降权会静默隐藏候选', async () => {
  for (const scenario of [
    { actorId: 'member-1', mutate(data) { data.memberUserIds = ['reviewer-1'] } },
    { actorId: 'member-1', mutateUser(data) { data.status = 'disabled' } },
    { actorId: 'root-1', mutateUser(data) { data.role = 'user' } }
  ]) {
    const value = await generatedHarness()
    value.fake.beforeNextTransaction(() => {})
    value.fake.beforeNextTransaction(() => {
      if (scenario.mutate) {
        const line = value.fake.documents('business_lines')[0]
        scenario.mutate(line)
        value.fake.replace('business_lines', line._id, line)
      }
      if (scenario.mutateUser) {
        const user = value.fake.documents('users').find(item => item._id === scenario.actorId)
        scenario.mutateUser(user)
        value.fake.replace('users', user._id, user)
      }
    })
    const result = await value.repository.queryAuthorized({
      actorId: scenario.actorId, normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: ''
    })
    assert.deepEqual(result.items, [])
  }
})

test('查询游标绑定账号与关键词且创建中售后不返回', async () => {
  const value = await generatedHarness()
  const first = await value.repository.queryAuthorized({
    actorId: 'member-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 1, cursor: ''
  })
  if (first.cursor) {
    await assert.rejects(value.repository.queryAuthorized({
      actorId: 'root-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 1, cursor: first.cursor
    }), { code: 'INVALID_SEARCH_QUERY' })
  }
  const line = value.fake.documents('business_lines')[0]
  value.fake.replace('business_lines', line._id, { ...line, status: 'creating' })
  const hidden = await value.repository.queryAuthorized({
    actorId: 'root-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: ''
  })
  assert.deepEqual(hidden.items, [])
})

function legacyBackfillSeed() {
  const seed = authoritativeSeed()
  seed.business_lines = []
  seed.business_nodes = []
  seed.system_settings = []
  for (let index = 1; index <= 41; index += 1) {
    const suffix = String(index).padStart(3, '0')
    const lineId = `legacy-line-${suffix}`
    const nodeId = `${lineId}-node-1`
    const alreadyIndexed = index <= 40
    seed.business_lines.push({
      _id: lineId,
      code: `BL-${suffix}`,
      name: `历史售后${suffix}`,
      description: '',
      status: 'active',
      currentNodeId: nodeId,
      nodeCount: 1,
      managerUserIds: ['manager-1'],
      memberUserIds: ['member-1'],
      updatedAt: new Date(`2026-08-24T00:${String(index).padStart(2, '0')}:00.000Z`),
      ...(alreadyIndexed ? {
        searchSourceVersion: 1,
        searchGeneratedVersion: 1,
        searchGenerationId: `generation-${suffix}`,
        searchIndexStatus: 'generated',
        searchGeneratedAt: NOW
      } : {})
    })
    seed.business_nodes.push({
      _id: nodeId,
      businessLineId: lineId,
      sequence: 0,
      name: '历史节点',
      nodeCode: `${suffix}-N001`,
      status: 'ready',
      processingRoundNumber: 1,
      updatedAt: new Date(`2026-08-24T00:${String(index).padStart(2, '0')}:00.000Z`),
      ...(alreadyIndexed ? {
        searchSourceVersion: 1,
        searchGeneratedVersion: 1,
        searchGenerationId: `generation-${suffix}`,
        searchIndexStatus: 'generated',
        searchGeneratedAt: NOW
      } : {})
    })
  }
  return seed
}

test('历史回填原始页全失效仍推进游标并使第41条有限可达', async () => {
  const value = harness(legacyBackfillSeed())
  assert.deepEqual(await value.repository.claimBackfillPage({ now: NOW, batchSize: 40 }), [])
  const second = await value.repository.claimBackfillPage({ now: NOW, batchSize: 40 })
  assert.deepEqual(second, [{ businessLineId: 'legacy-line-041', sourceVersion: 1 }])
  const line = value.fake.documents('business_lines').find(item => item._id === 'legacy-line-041')
  const node = value.fake.documents('business_nodes').find(item => item.businessLineId === line._id)
  assert.equal(line.searchIndexStatus, 'pending')
  assert.equal(node.searchIndexStatus, 'pending')
  assert.ok(value.fake.transactionRuns.every(run => run.operations <= 100))
})

test('历史回填损坏游标与版本溢出失败关闭', async () => {
  for (const cursor of [
    { _id: 'business-search-backfill-cursor', kind: 'business_search_backfill', schemaVersion: 1,
      revision: '1', cursorUpdatedAt: null, cursorId: null },
    { _id: 'business-search-backfill-cursor', kind: 'business_search_backfill', schemaVersion: 1,
      revision: Number.MAX_SAFE_INTEGER, cursorUpdatedAt: null, cursorId: null }
  ]) {
    const seed = legacyBackfillSeed()
    seed.system_settings = [cursor]
    await assert.rejects(harness(seed).repository.claimBackfillPage({ now: NOW, batchSize: 40 }), {
      code: 'SEARCH_CURSOR_INVALID'
    })
  }
})

test('待恢复索引使用独立游标领取且旧代清理不删除当前代', async () => {
  const seed = authoritativeSeed()
  seed.business_lines[0].updatedAt = new Date('2026-08-25T09:00:00.000Z')
  seed.system_settings = []
  seed.business_search_documents = [
    { _id: 'old-doc', documentType: 'entry', businessLineId: 'line-1', generationId: 'generation-old',
      createdAt: new Date('2026-08-24T00:00:00.000Z') },
    { _id: 'current-doc', documentType: 'entry', businessLineId: 'line-1', generationId: 'generation-current',
      createdAt: new Date('2026-08-25T00:00:00.000Z') }
  ]
  seed.business_lines[0].searchGenerationId = 'generation-current'
  const value = harness(seed)
  assert.deepEqual(await value.repository.claimRecoveryPage({ now: NOW, batchSize: 40 }), [
    { businessLineId: 'line-1', sourceVersion: 3 }
  ])
  assert.deepEqual(await value.repository.cleanupOldGeneration({ now: NOW, batchSize: 40 }), { cleaned: 1 })
  assert.deepEqual(value.fake.documents('business_search_documents').map(item => item._id), ['current-doc'])
})

test('超过100个倒排文档时后续合法售后通过服务端游标到达', async () => {
  const value = await generatedHarness()
  const tokenHash = crypto.createHmac('sha256', SECRET).update('清闲', 'utf8')
    .digest('base64url').slice(0, 22)
  for (let index = 0; index < 100; index += 1) {
    const id = String(index).padStart(3, '0')
    await value.fake.db.collection('business_search_documents').doc(`decoy-${id}`).set({ data: {
      documentType: 'tokens', businessLineId: `aa-decoy-${id}`, generationId: 'stale',
      entryId: `decoy-${id}`, tokenHashes: [tokenHash], createdAt: NOW
    } })
  }
  const first = await value.repository.queryAuthorized({
    actorId: 'root-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: ''
  })
  assert.deepEqual(first.items, [])
  assert.equal(first.hasMore, true)
  assert.ok(first.cursor)

  const root = value.fake.documents('users').find(item => item._id === 'root-1')
  value.fake.replace('users', root._id, { ...root, role: 'user' })
  await assert.rejects(value.repository.queryAuthorized({
    actorId: 'root-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: first.cursor
  }), { code: 'INVALID_SEARCH_QUERY' })
  value.fake.replace('users', root._id, root)

  const second = await value.repository.queryAuthorized({
    actorId: 'root-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: first.cursor
  })
  assert.deepEqual(second.items.map(item => item._id), ['line-1'])

  const expiredRepository = createCloudSearchRepository({
    db: value.fake.db,
    clock: () => new Date(NOW.getTime() + 5 * 60 * 1000 + 1),
    secret: SECRET
  })
  await assert.rejects(expiredRepository.queryAuthorized({
    actorId: 'root-1', normalizedKeywords: ['清闲'], digestInput: '清闲', pageSize: 20, cursor: first.cursor
  }), { code: 'INVALID_SEARCH_QUERY' })
})
