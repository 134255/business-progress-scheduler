const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const Module = require('node:module')

const { createCloudShareRepository } = require('../lib/cloud-share-repository')
const { createShareService } = require('../lib/share-service')
const { normalizeFieldDefinition, validateFieldValues } = require('../lib/field-domain')
const { createKeyAllocator } = require('../../../miniprogram/utils/template-editor-keys')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

// Only replace the external SDK import; the public route, service and repository are real.
const originalLoad = Module._load
let createBusinessApi
try {
  Module._load = function loadWithoutCloud(request, parent, isMain) {
    if (request === 'wx-server-sdk') return {
      init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => createFakeCloudDatabase().db
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  createBusinessApi = require('../index').createBusinessApi
} finally {
  Module._load = originalLoad
}

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

function harness(evidenceCount = 2, seeded = seed(evidenceCount), databaseOptions = {}, fileReferenceContext) {
  const fake = createFakeCloudDatabase(seeded, databaseOptions)
  const tempCalls = []
  const repository = createCloudShareRepository({
    db: fake.db,
    fileReferenceContext,
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

function reviewedEditorSeed(fieldKey = createKeyAllocator()('field-key')) {
  const data = seed(1)
  data.users.push({ _id: 'reviewer', status: 'active', role: 'user' })
  Object.assign(data.business_lines[0], {
    status: 'in_progress', currentNodeId: 'node-2', flowSchemaVersion: 2,
    entryNodeId: 'node-1', traversedNodeIds: ['node-1'], routeDecisionVersion: 1
  })
  const node = data.business_nodes[0]
  Object.assign(node, { nodeKey: 'node-key-ui-1', routeState: 'completed', next: { mode: 'end' } })
  node.fieldDefinitions = [normalizeFieldDefinition({ ...node.fieldDefinitions[0], fieldKey })]
  data.node_review_rounds[0].fieldValues = validateFieldValues(node.fieldDefinitions, [
    { fieldKey, value: '固定结果' }
  ])
  return data
}

function reviewerSnapshotInput(actorId = 'reviewer') {
  return {
    actor: { _id: actorId, status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 19).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: 'a'.repeat(64), inputHash: 'b'.repeat(64)
  }
}

test('strict product linked snapshot exposes only selected applicable fields, never full dictionaries or matrix', async () => {
  const data=reviewedEditorSeed()
  const fields=Array.from({length:8},(_,index)=>({fieldKey:`f${index}`,sequence:index,name:`字段${index}`,
    type:'single_select',required:true,constraints:{options:['选中','未选候选']}}))
  fields[0].optionLinkage={schemaVersion:1,fieldKeys:fields.map(field=>field.fieldKey),
    rows:[[0,0,0,0,null,null,null,0],[1,1,1,null,null,null,null,null]]}
  data.business_nodes[0].fieldDefinitions=fields
  data.node_review_rounds[0].fieldValues=validateFieldValues(fields,
    [0,1,2,3,7].map(index=>({fieldKey:`f${index}`,value:'选中'})))
  const {repository}=harness(1,data), input=reviewerSnapshotInput()
  await repository.createSnapshot(input)
  const result=await repository.getPublicSnapshot({token:input.token})
  assert.deepEqual(result.fieldDefinitions.map(field=>field.fieldKey),['f0','f1','f2','f3','f7'])
  assert.equal(JSON.stringify(result).includes('未选候选'),false)
  assert.equal(JSON.stringify(result).includes('optionLinkage'),false)
})

for (const snapshotFormat of ['review-array', 'legacy-object']) {
  test(`真实编辑器字段键兼容：${snapshotFormat} 创建后公开接口读回固定结果`, async () => {
    const data = reviewedEditorSeed()
    assert.equal(data.business_nodes[0].fieldDefinitions[0].fieldKey, 'field-key-ui-1')
    assert.deepEqual(data.node_review_rounds[0].fieldValues, [
      { fieldKey: 'field-key-ui-1', name: '摘要', type: 'short_text', value: '固定结果' }
    ])
    if (snapshotFormat === 'legacy-object') {
      data.node_review_rounds[0].fieldValues = { 'field-key-ui-1': '固定结果' }
    }
    const { fake, repository, tempCalls } = harness(1, data)
    const input = reviewerSnapshotInput()
    await repository.createSnapshot(input)
    const header = fake.documents('public_node_shares')[0]
    assert.equal(header.publishState, 'published')
    assert.equal(header.createdByUserId, 'reviewer')

    // Public reads must use the immutable header, not mutable node/round values.
    fake.replace('business_nodes', 'node-1', { ...data.business_nodes[0], fieldDefinitions: [] })
    fake.replace('node_review_rounds', 'round-1', {
      ...data.node_review_rounds[0], fieldValues: {}, processingComment: '后续修改'
    })
    const api = createBusinessApi({
      shareService: createShareService({ repository }),
      repository: { findUserByOpenid() { assert.fail('公开读取不得查询登录账号') } },
      getContext: () => ({})
    })
    const response = await api.main({ action: 'getPublicNodeShare', payload: { token: input.token } })
    assert.equal(response.ok, true)
    assert.deepEqual(response.data.fieldDefinitions, [
      { fieldKey: 'field-key-ui-1', sequence: 0, name: '摘要', type: 'short_text', required: true }
    ])
    assert.deepEqual(response.data.fieldValues, { 'field-key-ui-1': '固定结果' })
    assert.equal(response.data.processingComment, '完成说明')
    assert.deepEqual(response.data.evidences, [
      { fileName: '凭证0.jpg', category: 'jpg', size: 10, url: 'https://temp/0' }
    ])
    assert.deepEqual(tempCalls, [[{ fileID: 'cloud://evidence-0', maxAge: 300 }]])
    for (const secret of ['cloud://', 'reviewer', 'processor', 'line-1', 'node-1', 'round-1', 'evidence-0']) {
      assert.equal(JSON.stringify(response).includes(secret), false)
    }
  })
}

test('分享字段键兼容保留旧键及64字符边界', async t => {
  for (const fieldKey of ['summary', 'field_key_1', `F${'x'.repeat(62)}-`]) {
    await t.test(fieldKey, async () => {
      const { repository } = harness(1, reviewedEditorSeed(fieldKey))
      const input = reviewerSnapshotInput()
      await repository.createSnapshot(input)
      const snapshot = await repository.getPublicSnapshot({ token: input.token })
      assert.equal(snapshot.fieldValues[fieldKey], '固定结果')
    })
  }
})

test('分享字段键兼容仍拒绝非法键且不写分享或凭证保留锁', async t => {
  for (const fieldKey of ['', '__proto__', '_field', '-field', '1field', 'field.key',
    'constructor.prototype', 'field/key', 'field[key]', '$field', 'field key', `F${'x'.repeat(64)}`]) {
    await t.test(JSON.stringify(fieldKey), async () => {
      const data = reviewedEditorSeed()
      data.business_nodes[0].fieldDefinitions[0].fieldKey = fieldKey
      data.node_review_rounds[0].fieldValues[0].fieldKey = fieldKey
      const { fake, repository } = harness(1, data)
      await assert.rejects(repository.createSnapshot(reviewerSnapshotInput()), { code: 'FORBIDDEN' })
      assert.deepEqual(fake.documents('public_node_shares'), [])
      assert.deepEqual(fake.documents('public_node_share_chunks'), [])
      assert.deepEqual(fake.documents('audit_logs'), [])
      assert.deepEqual(fake.documents('evidences'), data.evidences)
    })
  }
})

test('分享字段键兼容仍拒绝重复快照键、未知键和定义不匹配', async t => {
  for (const [name, mutate] of [
    ['重复快照键', data => {
      data.business_nodes[0].fieldDefinitions.push({
        ...data.business_nodes[0].fieldDefinitions[0], fieldKey: 'field-key-ui-2', sequence: 1
      })
      data.node_review_rounds[0].fieldValues.push({ ...data.node_review_rounds[0].fieldValues[0] })
    }],
    ['未知快照键', data => { data.node_review_rounds[0].fieldValues[0].fieldKey = 'field-key-ui-2' }],
    ['字段名称不匹配', data => { data.node_review_rounds[0].fieldValues[0].name = '其他字段' }],
    ['字段类型不匹配', data => { data.node_review_rounds[0].fieldValues[0].type = 'number' }],
    ['非标量值', data => { data.node_review_rounds[0].fieldValues[0].value = { nested: '不能公开' } }]
  ]) {
    await t.test(name, async () => {
      const data = reviewedEditorSeed()
      mutate(data)
      const { fake, repository } = harness(1, data)
      await assert.rejects(repository.createSnapshot(reviewerSnapshotInput()), { code: 'FORBIDDEN' })
      assert.deepEqual(fake.documents('public_node_shares'), [])
      assert.deepEqual(fake.documents('evidences'), data.evidences)
    })
  }
})

test('分享字段键兼容拒绝访问器且不执行getter', async t => {
  for (const target of ['definition-key', 'snapshot-key', 'snapshot-value', 'object-value']) {
    await t.test(target, async () => {
      let getterCalls = 0
      const data = reviewedEditorSeed()
      // Inject after structuredClone so the database double cannot flatten a getter.
      const { fake, repository } = harness(1, data, {
        transformRead({ collection, data: document }) {
          const getter = { enumerable: true, get() { getterCalls += 1; return 'field-key-ui-1' } }
          if (target === 'definition-key' && collection === 'business_nodes') {
            Object.defineProperty(document.fieldDefinitions[0], 'fieldKey', getter)
          } else if (collection === 'node_review_rounds') {
            if (target === 'snapshot-key' || target === 'snapshot-value') {
              Object.defineProperty(document.fieldValues[0], target === 'snapshot-key' ? 'fieldKey' : 'value', getter)
            } else if (target === 'object-value') {
              document.fieldValues = {}
              Object.defineProperty(document.fieldValues, 'field-key-ui-1', getter)
            }
          }
          return document
        }
      })
      await assert.rejects(repository.createSnapshot(reviewerSnapshotInput()), { code: 'FORBIDDEN' })
      assert.equal(getterCalls, 0)
      assert.deepEqual(fake.documents('public_node_shares'), [])
    })
  }
})

test('分享字段键兼容不放宽成员、节点、通过轮次或凭证权限', async t => {
  for (const [name, mutate] of [
    ['无关成员', data => {
      data.business_nodes[0].reviewerUserIds = ['other-reviewer']
      data.node_review_rounds[0].reviewerUserIds = ['other-reviewer']
    }],
    ['业务撤权', data => { data.business_lines[0].memberUserIds = ['manager', 'processor'] }],
    ['节点撤权', data => { data.business_nodes[0].reviewerUserIds = ['other-reviewer'] }],
    ['非通过轮次审核人', data => { data.node_review_rounds[0].reviewerUserIds = ['other-reviewer'] }],
    ['账号停用', data => { data.users.find(user => user._id === 'reviewer').status = 'disabled' }],
    ['节点未完成', data => { data.business_nodes[0].status = 'in_progress' }],
    ['未走过路线', data => { data.business_lines[0].traversedNodeIds = [] }],
    ['路线未完成', data => { data.business_nodes[0].routeState = 'skipped' }],
    ['轮次未通过', data => { data.node_review_rounds[0].finalDecision = 'rejected' }],
    ['凭证跨节点', data => { data.evidences[0].nodeId = 'node-other' }],
    ['凭证已清理', data => { data.evidences[0].purgedAt = NOW }]
  ]) {
    await t.test(name, async () => {
      const data = reviewedEditorSeed()
      mutate(data)
      const { fake, repository } = harness(1, data)
      await assert.rejects(repository.createSnapshot(reviewerSnapshotInput()), { code: 'FORBIDDEN' })
      assert.equal(fake.documents('public_node_shares').some(item => item.publishState === 'published'), false)
      assert.deepEqual(fake.documents('audit_logs'), [])
      assert.deepEqual(fake.documents('evidences'), data.evidences)
    })
  }
})

test('existing protected share snapshots resolve the same historical bucket-only evidence object', async () => {
  const documents = seed(1)
  const evidenceId = `evidence-${'1'.repeat(64)}`
  Object.assign(documents.evidences[0], { _id: evidenceId, extension: 'jpg',
    fileId: `cloud://bucket-1234567890/evidence-uploads/line-1/node-1/${evidenceId}.jpg` })
  documents.node_review_rounds[0].evidenceIds = [evidenceId]
  const { fake, repository, tempCalls } = harness(1, documents, {},
    () => ({ environmentId: 'env-test', bucket: 'bucket-1234567890' }))
  const token = Buffer.alloc(32, 6).toString('base64url')
  await repository.createSnapshot({ actor: { _id: 'processor', status: 'active' },
    businessLineId: 'line-1', nodeId: 'node-1', token, createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '1'.repeat(64), inputHash: '2'.repeat(64) })
  const before = fake.documents('evidences')
  const result = await repository.getPublicSnapshot({ token, cursor: '', pageSize: 40 })
  assert.equal(result.evidences.length, 1)
  assert.equal(tempCalls[0][0].fileID,
    `cloud://env-test.bucket-1234567890/evidence-uploads/line-1/node-1/${evidenceId}.jpg`)
  assert.deepEqual(fake.documents('evidences'), before)
})

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

test('已启用的无审核人追加节点使用最终完成反馈生成分享快照', async () => {
  const data = seed(1)
  data.business_lines[0].status = 'completed'
  data.business_lines[0].optionalTailState = 'completed'
  Object.assign(data.business_nodes[0], {
    activationMode: 'optional_tail', reviewerUserIds: [], reviewerDisplayNames: [],
    processorDisplayNames: ['处理人'],
    lastReviewRoundId: null, latestFeedbackId: 'feedback-direct', latestFeedbackRevision: 2,
    processingRoundNumber: 1, reviewRoundNumber: 0
  })
  data.node_review_rounds = []
  data.node_feedback = [{
    _id: 'feedback-direct', businessLineId: 'line-1', nodeId: 'node-1',
    action: 'complete_node', status: 'completed', publishState: 'published', revision: 2,
    processingRoundNumber: 1, comment: '追加完成',
    fieldValues: { summary: '追加固定结果' }, evidenceCount: 1, claimedCount: 1
  }]
  Object.assign(data.evidences[0], {
    feedbackId: 'feedback-direct', attachmentState: 'attached', feedbackEvidenceOrder: 0
  })
  const { fake, repository } = harness(1, data)

  await repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 15).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '4'.repeat(64), inputHash: '5'.repeat(64)
  })

  const share = fake.documents('public_node_shares')[0]
  assert.equal(share.publishState, 'published')
  assert.equal(share.reviewRoundId, null)
  assert.equal(share.evidenceCount, 1)
  assert.equal(share.processingComment, '追加完成')
  assert.deepEqual(share.fieldValues, { summary: '追加固定结果' })
  assert.deepEqual(fake.documents('public_node_share_chunks')[0].evidences.map(item => item.evidenceId), ['evidence-0'])
  const publicSnapshot = await repository.getPublicSnapshot({
    token: Buffer.alloc(32, 15).toString('base64url'), cursor: '', pageSize: 40
  })
  assert.equal(publicSnapshot.processingComment, '追加完成')
  assert.equal(JSON.stringify(publicSnapshot).includes('feedback-direct'), false)
  assert.equal(JSON.stringify(publicSnapshot).includes('evidence-0'), false)
  assert.equal(JSON.stringify(publicSnapshot).includes('cloud://'), false)
  assert.equal(JSON.stringify(publicSnapshot).includes('processor'), false)
})

test('未启用的追加节点不能生成分享快照', async () => {
  const data = seed(0)
  Object.assign(data.business_nodes[0], {
    activationMode: 'optional_tail', status: 'skipped', reviewerUserIds: [],
    reviewerDisplayNames: [], lastReviewRoundId: null
  })
  data.node_review_rounds = []
  const { repository } = harness(0, data)
  await assert.rejects(repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 16).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '6'.repeat(64), inputHash: '7'.repeat(64)
  }), error => error.code === 'FORBIDDEN')
})

test('流程版本二的跳过节点即使状态被篡改为完成也不能生成分享快照', async () => {
  const data = seed(0)
  Object.assign(data.business_lines[0], {
    flowSchemaVersion: 2, entryNodeId: 'node-1', traversedNodeIds: [], routeDecisionVersion: 1
  })
  Object.assign(data.business_nodes[0], {
    nodeKey: 'skipped', routeState: 'skipped', next: { mode: 'end' }
  })
  const { repository } = harness(0, data)
  await assert.rejects(repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 18).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '8'.repeat(64), inputHash: '9'.repeat(64)
  }), error => error.code === 'FORBIDDEN')
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

test('分享头通过文档路径指定编号且不把保留字段写入数据', async () => {
  const data = seed(0)
  const { fake, repository } = harness(0, data, { rejectExplicitIdOnSet: true })

  await repository.createSnapshot({
    actor: { _id: 'processor', status: 'active' }, businessLineId: 'line-1', nodeId: 'node-1',
    token: Buffer.alloc(32, 14).toString('base64url'), createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 7 * 86400000),
    requestKeyHash: '2'.repeat(64), inputHash: '3'.repeat(64)
  })

  assert.equal(fake.documents('public_node_shares').length, 1)
  assert.equal(fake.documents('public_node_shares')[0].publishState, 'published')
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
