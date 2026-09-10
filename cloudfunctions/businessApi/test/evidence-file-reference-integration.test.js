'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const Module = require('node:module')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { resolveEvidenceFileId } = require('../lib/evidence-file-reference')

const BUCKET = 'bucket-1234567890'
const ENVIRONMENT = 'env-test'
const EVIDENCE_ID = `evidence-${'1'.repeat(64)}`
const objectKey = extension => `evidence-uploads/business-1/node-1/${EVIDENCE_ID}.${extension}`

async function withDeployedApi(evidences, run) {
  const fake = createFakeCloudDatabase({
    users: [{ _id: 'account-1', status: 'active', role: 'member', openid: 'wx-synthetic' }],
    wechat_bindings: [{ _id: crypto.createHash('sha256').update('wx-synthetic').digest('hex'), userId: 'account-1' }],
    user_credentials: [{ _id: 'account-1', mustChangePassword: false, lockedUntil: null }],
    system_settings: [{ _id: 'account_admin_state', activeSuperAdminCount: 1, revision: 0 }],
    business_lines: [{ _id: 'business-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerUserIds: ['account-1'], memberUserIds: ['account-1'] }],
    business_nodes: [{ _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'in_progress', version: 4,
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-reviewer'],
      processingRoundNumber: 2, requiresEvidence: false, allowedEvidenceTypes: [] }],
    evidences
  })
  const config = {
    EVIDENCE_COS_BUCKET: BUCKET, EVIDENCE_COS_REGION: 'ap-shanghai',
    EVIDENCE_COS_SECRET_ID: 'AKIDsynthetic', EVIDENCE_COS_SECRET_KEY: 'synthetic-secret',
    EVIDENCE_CLOUD_FILE_PREFIX: `cloud://${BUCKET}`
  }
  const previousEnv = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]))
  const originalLoad = Module._load
  const entry = require.resolve('../index')
  const previousEntry = require.cache[entry]
  const urlCalls = []
  try {
    Object.assign(process.env, config)
    delete require.cache[entry]
    Module._load = function loadBoundary(request, parent, isMain) {
      if (request === 'wx-server-sdk') return {
        DYNAMIC_CURRENT_ENV: 'dynamic', init() {}, database: () => fake.db,
        async downloadFile() { throw new Error('unexpected storage download') },
        getWXContext: () => ({ ENV: ENVIRONMENT, OPENID: 'wx-synthetic', REQUESTID: 'synthetic-request' }),
        async getTempFileURL({ fileList }) {
          urlCalls.push(...fileList)
          return { fileList: fileList.map(item => ({ ...item, status: 0, tempFileURL: 'https://temporary.example/evidence' })) }
        }
      }
      if (request === 'cos-nodejs-sdk-v5') return class SyntheticCos {
        headObject() { throw new Error('unexpected storage read') }
        getObject() { throw new Error('unexpected storage read') }
      }
      if (request === 'qcloud-cos-sts') return {
        getCredential(input, callback) {
          callback(null, { credentials: { tmpSecretId: 'synthetic-id', tmpSecretKey: 'synthetic-key', sessionToken: 'synthetic-token' },
            startTime: 100, expiredTime: 1000 })
        }
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    await run({ main: require('../index').main, fake, urlCalls })
  } finally {
    Module._load = originalLoad
    delete require.cache[entry]
    if (previousEntry) require.cache[entry] = previousEntry
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('deployed access entry resolves historical image and video using trusted runtime context without writes', async () => {
  for (const [extension, category] of [['jpg', 'image'], ['mp4', 'video']]) {
    const evidence = { _id: EVIDENCE_ID, businessLineId: 'business-1', nodeId: 'node-1',
      fileId: `cloud://${BUCKET}/${objectKey(extension)}`, fileName: `sample.${extension}`, extension, category,
      size: 100, storageStatus: 'available', attachmentState: 'attached', feedbackId: 'feedback-1', feedbackRevision: 1,
      orphanExpiresAt: null, purgeDueAt: null, retentionScope: 'business_line', retentionSource: 'node_feedback' }
    await withDeployedApi([evidence], async ({ main, fake, urlCalls }) => {
      const result = await main({ action: 'getEvidenceAccess', ENV: 'forged-env',
        payload: { evidenceId: EVIDENCE_ID, environmentId: 'forged-env', bucket: 'other-1234567890' } })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.data.category, category)
      assert.equal(result.data.url, 'https://temporary.example/evidence')
      assert.equal(urlCalls.length, 1)
      assert.equal(urlCalls[0].fileID, `cloud://${ENVIRONMENT}.${BUCKET}/${objectKey(extension)}`)
      assert.deepEqual(fake.documents('evidences'), [evidence])
    })
  }
})

test('deployed upload entry persists canonical image and video references with bucket-only configuration', async () => {
  await withDeployedApi([], async ({ main, fake }) => {
    for (const extension of ['jpg', 'mp4']) {
      const result = await main({ action: 'beginEvidenceUpload', payload: {
        businessLineId: 'business-1', nodeId: 'node-1', expectedNodeVersion: 4,
        fileName: `sample.${extension}`, declaredSize: 100
      } })
      assert.equal(result.ok, true, JSON.stringify(result))
      const stored = fake.documents('evidences').find(item => item._id === result.data.evidenceId)
      assert.equal(stored.fileId, `cloud://${ENVIRONMENT}.${BUCKET}/${result.data.objectKey}`)
      assert.equal(stored.storageStatus, 'uploading')
      assert.equal(stored.attachmentState, 'unattached')
      assert.equal(stored.uploadedBy, 'account-1')
    }
  })
})

test('reference compatibility preserves other authorities and requires valid context and own path metadata', () => {
  const context = { environmentId: ENVIRONMENT, bucket: BUCKET }
  const evidence = { _id: EVIDENCE_ID, businessLineId: 'business-1', nodeId: 'node-1', extension: 'jpg',
    fileId: `cloud://${BUCKET}/${objectKey('jpg')}` }
  for (const authority of [`${ENVIRONMENT}.${BUCKET}`, `other-env.${BUCKET}`, 'sdk-env', 'other-1234567890']) {
    const fileId = `cloud://${authority}/${objectKey('jpg')}`
    assert.equal(resolveEvidenceFileId({ ...evidence, fileId }, context), fileId)
  }
  for (const environmentId of [undefined, '', 'invalid/env']) {
    assert.throws(() => resolveEvidenceFileId(evidence, { ...context, environmentId }), /INVALID_EVIDENCE_FILE_REFERENCE/)
  }
  const inherited = Object.assign(Object.create({ extension: 'jpg' }), evidence)
  delete inherited.extension
  assert.throws(() => resolveEvidenceFileId(inherited, context), /INVALID_EVIDENCE_FILE_REFERENCE/)
  const accessor = { ...evidence }
  Object.defineProperty(accessor, 'extension', { get() { throw new Error('getter must not execute') } })
  assert.throws(() => resolveEvidenceFileId(accessor, context), /INVALID_EVIDENCE_FILE_REFERENCE/)
})
