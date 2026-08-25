const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { createCloudShareRepository } = require('../lib/cloud-share-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const NOW = new Date('2026-08-17T10:00:00.000Z')

function seed(evidenceCount = 2) {
  const evidenceIds = Array.from({ length: evidenceCount }, (_, index) => `evidence-${index}`)
  return {
    users: [{ _id: 'processor', status: 'active', role: 'user' }],
    business_lines: [{
      _id: 'line-1', code: 'BL-1', name: '业务一', status: 'completed', currentNodeId: 'node-1',
      managerUserIds: ['manager'], memberUserIds: ['manager', 'processor', 'reviewer']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-1-N001', name: '资料处理',
      status: 'completed', workflowMode: 'review', processorUserIds: ['processor'], reviewerUserIds: ['reviewer'],
      reviewerAssignmentMode: 'business_creator', reviewerDisplayNames: ['业务发起人'],
      processingRoundNumber: 1, reviewRoundNumber: 1, lastReviewRoundId: 'round-1', completedAt: NOW,
      fieldDefinitions: [{ fieldKey: 'summary', sequence: 0, name: '摘要', type: 'short_text', required: true, constraints: {} }]
    }],
    node_review_rounds: [{
      _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'approved', finalDecision: 'approved',
      reviewerUserIds: ['reviewer'], processorDisplayNames: ['处理人'],
      reviewerAssignmentMode: 'business_creator', reviewerDisplayNames: ['业务发起人'], processingRoundNumber: 1, reviewRoundNumber: 1,
      processingComment: '完成说明', fieldValues: { summary: '固定结果' }, evidenceIds, decidedAt: NOW
    }],
    evidences: evidenceIds.map((id, index) => ({
      _id: id, businessLineId: 'line-1', nodeId: 'node-1', feedbackId: `feedback-${index}`,
      feedbackRevision: 1, fileId: `cloud://evidence-${index}`, fileName: `凭证${index}.jpg`,
      category: 'jpg', size: 10, storageStatus: 'available', purgedAt: null
    }))
  }
}

function harness(evidenceCount = 2, seeded = seed(evidenceCount)) {
  const fake = createFakeCloudDatabase(seeded)
  const tempCalls = []
  const repository = createCloudShareRepository({
    db: fake.db,
    cloud: {
      async getTempFileURL({ fileList }) {
        tempCalls.push(fileList)
        return { fileList: fileList.map(item => ({ fileID: item.fileID, tempFileURL: `https://temp/${item.fileID.split('-').at(-1)}` })) }
      }
    },
    clock: () => new Date(NOW)
  })
  return { fake, repository, tempCalls }
}

test('处理人创建不可变分享快照并以40条分块处理105个凭证', async () => {
  const { fake, repository } = harness(105)
  const token = Buffer.alloc(32, 5).toString('base64url')
  const expiresAt = new Date(NOW.getTime() + 7 * 86400000)
  await repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token, createdAt: NOW, expiresAt, requestKeyHash: 'a'.repeat(64), inputHash: 'b'.repeat(64)
  })
  assert.equal(fake.documents('public_node_shares').length, 1)
  assert.equal(fake.documents('public_node_share_chunks').length, 3)
  assert.equal(fake.documents('evidences').every(item => item.publicShareHoldUntil.getTime() === expiresAt.getTime()), true)
  assert.equal(Math.max(...fake.transactionRuns.map(run => run.operations)) <= 100, true)
  const header = fake.documents('public_node_shares')[0]
  assert.equal(header.publishState, 'published')
  assert.equal(JSON.stringify(header).includes(token), false)
  const audits = fake.documents('audit_logs')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'CREATE_PUBLIC_NODE_SHARE')
  assert.equal(JSON.stringify(audits).includes(token), false)

  await repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token, createdAt: new Date(NOW.getTime() + 1000), expiresAt: new Date(expiresAt.getTime() + 1000),
    requestKeyHash: 'a'.repeat(64), inputHash: 'b'.repeat(64)
  })
  assert.equal(fake.documents('public_node_shares').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
})

test('进行中业务的已完成审核节点可立即生成分享快照', async () => {
  const data = seed(0)
  data.business_lines[0].status = 'in_progress'
  data.business_lines[0].currentNodeId = 'node-2'
  const { fake, repository } = harness(0, data)

  await repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 9).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '5'.repeat(64), inputHash: '6'.repeat(64)
  })

  assert.equal(fake.documents('public_node_shares').length, 1)
  assert.equal(fake.documents('public_node_shares')[0].publishState, 'published')
})

test('节点与最终通过轮次中的审核人可生成分享快照', async () => {
  const data = seed(0)
  data.users.push({ _id: 'reviewer', status: 'active', role: 'user' })
  const { fake, repository } = harness(0, data)

  await repository.createSnapshot({
    actor: { _id: 'reviewer', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 10).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '7'.repeat(64), inputHash: '8'.repeat(64)
  })

  assert.equal(fake.documents('public_node_shares').length, 1)
  assert.equal(fake.documents('public_node_shares')[0].createdByUserId, 'reviewer')
})

test('真实审核轮次的字段快照数组不会被误判为无分享权限', async () => {
  const data = seed(1)
  data.users.push({ _id: 'reviewer', status: 'active', role: 'user' })
  data.business_nodes[0].fieldDefinitions = []
  data.node_review_rounds[0].fieldValues = []
  const { fake, repository } = harness(1, data)

  await repository.createSnapshot({
    actor: { _id: 'reviewer', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 12).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: 'd'.repeat(64), inputHash: 'e'.repeat(64)
  })

  assert.equal(fake.documents('public_node_shares')[0].publishState, 'published')
  assert.deepEqual(fake.documents('public_node_shares')[0].fieldValues, {})
})

test('真实审核轮次的非空字段快照数组按模板定义生成公开键值', async () => {
  const data = seed(0)
  data.users.push({ _id: 'reviewer', status: 'active', role: 'user' })
  data.node_review_rounds[0].fieldValues = [{
    fieldKey: 'summary', name: '摘要', type: 'short_text', value: '固定结果'
  }]
  const { fake, repository } = harness(0, data)

  await repository.createSnapshot({
    actor: { _id: 'reviewer', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 13).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: 'f'.repeat(64), inputHash: '1'.repeat(64)
  })

  assert.deepEqual(fake.documents('public_node_shares')[0].fieldValues, { summary: '固定结果' })
})

test('无关业务成员不能生成节点分享快照', async () => {
  const data = seed(0)
  data.users.push({ _id: 'observer', status: 'active', role: 'user' })
  data.business_lines[0].memberUserIds.push('observer')
  const { repository } = harness(0, data)

  await assert.rejects(repository.createSnapshot({
    actor: { _id: 'observer', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 11).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '9'.repeat(64), inputHash: '0'.repeat(64)
  }), error => error.code === 'FORBIDDEN')
})

test('分块中断后的同请求重试沿用原到期时间并完成发布', async () => {
  const { fake, repository } = harness(41)
  const token = Buffer.alloc(32, 4).toString('base64url')
  const expiresAt = new Date(NOW.getTime() + 7 * 86400000)
  fake.failNextWrite({ collection: 'public_node_share_chunks', operation: 'set', error: new Error('interrupted') })
  const input = {
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token, createdAt: NOW, expiresAt, requestKeyHash: '1'.repeat(64), inputHash: '2'.repeat(64)
  }
  await assert.rejects(repository.createSnapshot(input), /interrupted/)
  const retry = await repository.createSnapshot({
    ...input,
    createdAt: new Date(NOW.getTime() + 60_000),
    expiresAt: new Date(expiresAt.getTime() + 60_000)
  })
  assert.equal(retry.expiresAt.getTime(), expiresAt.getTime())
  assert.equal(fake.documents('public_node_shares')[0].publishState, 'published')
  assert.equal(fake.documents('public_node_share_chunks').length, 2)
})

test('分享快照拒绝稀疏字段定义和稀疏显示名数组', async () => {
  for (const mutate of [
    data => { data.business_nodes[0].fieldDefinitions = new Array(1) },
    data => { data.node_review_rounds[0].processorDisplayNames = new Array(1) }
  ]) {
    const data = seed(0)
    mutate(data)
    const { repository } = harness(0, data)
    await assert.rejects(repository.createSnapshot({
      actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
      token: Buffer.alloc(32, 7).toString('base64url'), createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 7 * 86400000),
      requestKeyHash: '3'.repeat(64), inputHash: '4'.repeat(64)
    }), error => error.code === 'FORBIDDEN')
  }
})

test('公开读取无需账号、返回短期地址且不泄漏永久标识，过期统一拒绝', async () => {
  const { fake, repository } = harness(2)
  const token = Buffer.alloc(32, 6).toString('base64url')
  await repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token, createdAt: NOW, expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: 'c'.repeat(64), inputHash: 'd'.repeat(64)
  })
  const result = await repository.getPublicSnapshot({ token, cursor: '', pageSize: 40 })
  assert.equal(result.businessName, '业务一')
  assert.deepEqual(result.fieldValues, { summary: '固定结果' })
  assert.equal(result.evidences.length, 2)
  assert.match(result.evidences[0].url, /^https:\/\/temp\//)
  const serialized = JSON.stringify(result)
  for (const secret of ['cloud://', 'processor', 'reviewer', 'line-1', 'node-1', 'feedback-']) {
    assert.equal(serialized.includes(secret), false)
  }
  fake.replace('public_node_shares', fake.documents('public_node_shares')[0]._id, {
    ...fake.documents('public_node_shares')[0], expiresAt: new Date(NOW.getTime() - 1)
  })
  await assert.rejects(repository.getPublicSnapshot({ token, cursor: '', pageSize: 40 }),
    error => error.code === 'SHARE_UNAVAILABLE')
})

test('公开分页直接读取确定性分块且可跨越四千条边界', async () => {
  const token = Buffer.alloc(32, 8).toString('base64url')
  const shareId = `share-${crypto.createHash('sha256').update(token).digest('hex')}`
  const evidenceItems = Array.from({ length: 45 }, (_, index) => ({
    evidenceId: `evidence-${3960 + index}`, fileName: `file-${3960 + index}.jpg`, category: 'jpg', size: 10
  }))
  const fake = createFakeCloudDatabase({
    public_node_shares: [{
      _id: shareId, publishState: 'published', expiresAt: new Date(NOW.getTime() + 86400000),
      evidenceCount: 4005, chunkCount: 101, businessCode: 'BL-1', businessName: '业务', nodeCode: 'N-1',
      nodeName: '节点', completedAt: NOW, processingRoundNumber: 1, reviewRoundNumber: 1,
      processingComment: '', fieldDefinitions: [], fieldValues: {}
    }],
    public_node_share_chunks: [{
      _id: `${shareId}-chunk-000099`, shareId, index: 99, evidences: evidenceItems.slice(0, 40)
    }, {
      _id: `${shareId}-chunk-000100`, shareId, index: 100, evidences: evidenceItems.slice(40)
    }],
    evidences: evidenceItems.map(item => ({
      _id: item.evidenceId, fileId: `cloud://${item.evidenceId}`, fileName: item.fileName,
      category: item.category, size: item.size, storageStatus: 'available', purgedAt: null,
      publicShareHoldUntil: new Date(NOW.getTime() + 86400000)
    }))
  })
  const repository = createCloudShareRepository({
    db: fake.db,
    cloud: { async getTempFileURL({ fileList }) { return { fileList: fileList.map(() => ({ tempFileURL: 'https://temp/file' })) } } },
    clock: () => new Date(NOW)
  })
  const result = await repository.getPublicSnapshot({ token, cursor: '3990', pageSize: 40 })
  assert.equal(result.evidences.length, 15)
  assert.equal(result.hasMore, false)
  assert.equal(result.nextCursor, '')
})

test('分享标识由令牌摘要确定且同一令牌不会写入明文', () => {
  const token = Buffer.alloc(32, 3).toString('base64url')
  const expected = `share-${crypto.createHash('sha256').update(token).digest('hex')}`
  const { shareIdForToken } = require('../lib/cloud-share-repository')
  assert.equal(shareIdForToken(token), expected)
})
