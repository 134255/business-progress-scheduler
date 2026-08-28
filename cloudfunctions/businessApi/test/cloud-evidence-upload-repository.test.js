const test = require('node:test')
const assert = require('node:assert/strict')

const {
  COS_UPLOAD_ACTIONS,
  createCloudEvidenceUploadRepository,
  createCosStorageAdapter,
  createScopedCosCredentialProvider
} = require('../lib/cloud-evidence-upload-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const NOW = new Date('2026-08-28T02:00:00.000Z')
const TOKEN_HASH = 'a'.repeat(64)
const EVIDENCE_ID = `evidence-${'1'.repeat(64)}`

function assertCode(code) {
  return error => error && error.code === code
}

function seed(overrides = {}) {
  return {
    users: [{ _id: 'account-1', status: 'active', openid: 'wx-current' }],
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerUserIds: ['account-owner'], memberUserIds: ['account-1', 'account-owner']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'in_progress', version: 4,
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-reviewer'],
      processingRoundNumber: 2, requiresEvidence: false, allowedEvidenceTypes: []
    }],
    evidences: [],
    ...overrides
  }
}

function harness(documents = seed(), overrides = {}) {
  const fake = createFakeCloudDatabase(documents, overrides.databaseOptions)
  const calls = []
  const storage = overrides.storage || {
    async headObject(value) {
      calls.push(['headObject', value])
      return { size: 100, etag: 'etag-1', crc64: '12345' }
    },
    async readObjectHeader(value) {
      calls.push(['readObjectHeader', value])
      return Buffer.from('0000ftypheic')
    }
  }
  return {
    calls,
    fake,
    repository: createCloudEvidenceUploadRepository({
      db: fake.db,
      storage,
      clock: () => new Date(NOW),
      cloudFilePrefix: 'cloud://test-env'
    })
  }
}

function reservation(overrides = {}) {
  return {
    evidenceId: EVIDENCE_ID,
    actorId: 'account-1',
    businessLineId: 'business-1',
    nodeId: 'node-1',
    expectedNodeVersion: 4,
    processingRoundNumber: 2,
    fileName: 'photo.heic',
    extension: 'heic',
    declaredSize: 100,
    objectKey: `evidence-uploads/business-1/node-1/${EVIDENCE_ID}.heic`,
    uploadSessionTokenHash: TOKEN_HASH,
    uploadSessionExpiresAt: new Date('2026-08-28T02:15:00.000Z'),
    orphanExpiresAt: new Date('2026-08-29T02:00:00.000Z'),
    ...overrides
  }
}

async function reserve(repository, overrides) {
  return repository.reserveUpload({
    actor: { _id: 'account-1', status: 'active' },
    reservation: reservation(overrides)
  })
}

test('reservation authorizes the current processor and persists an invisible replay-bound upload', async () => {
  const { fake, repository } = harness()
  const result = await reserve(repository)
  assert.equal(result.evidenceId, EVIDENCE_ID)
  const stored = fake.documents('evidences')[0]
  assert.equal(stored.storageStatus, 'uploading')
  assert.equal(stored.attachmentState, 'unattached')
  assert.equal(stored.uploadedBy, 'account-1')
  assert.equal(stored.processingRoundNumber, 2)
  assert.equal(stored.uploadSessionTokenHash, TOKEN_HASH)
  assert.equal(stored.fileId, `cloud://test-env/evidence-uploads/business-1/node-1/${EVIDENCE_ID}.heic`)
  assert.equal(Object.hasOwn(stored, 'credentials'), false)
})

test('reservation rejects stale version, wrong processor, wrong path and duplicate evidence id atomically', async () => {
  const cases = [
    { documents: seed(), changes: { expectedNodeVersion: 3 }, code: 'VERSION_CONFLICT' },
    { documents: seed(), changes: { actorId: 'account-2' }, code: 'EVIDENCE_NOT_ATTACHABLE' },
    { documents: seed(), changes: { objectKey: 'evidence-uploads/other' }, code: 'EVIDENCE_NOT_ATTACHABLE' },
    { documents: seed({ evidences: [{ _id: EVIDENCE_ID, storageStatus: 'available' }] }), changes: {}, code: 'EVIDENCE_NOT_ATTACHABLE' }
  ]
  for (const item of cases) {
    const { fake, repository } = harness(item.documents)
    await assert.rejects(reserve(repository, item.changes), assertCode(item.code))
    assert.equal(fake.documents('evidences').length, item.documents.evidences.length)
  }
})

test('finalization reauthorizes, uses authoritative metadata and bounded bytes, then publishes available metadata', async () => {
  const { calls, fake, repository } = harness()
  await reserve(repository)
  const result = await repository.finalizeUpload({
    actor: { _id: 'account-1', status: 'active' },
    evidenceId: EVIDENCE_ID,
    uploadSessionTokenHash: TOKEN_HASH,
    expectedNodeVersion: 4
  })
  assert.deepEqual(result, {
    evidenceId: EVIDENCE_ID, fileName: 'photo.heic', category: 'image', size: 100,
    storageStatus: 'available'
  })
  assert.deepEqual(calls, [
    ['headObject', { objectKey: `evidence-uploads/business-1/node-1/${EVIDENCE_ID}.heic` }],
    ['readObjectHeader', { objectKey: `evidence-uploads/business-1/node-1/${EVIDENCE_ID}.heic`, maximumBytes: 64 }]
  ])
  const stored = fake.documents('evidences')[0]
  assert.equal(stored.storageStatus, 'available')
  assert.equal(stored.size, 100)
  assert.equal(stored.category, 'image')
  assert.equal(stored.integrityAlgorithm, 'cos-crc64')
  assert.equal(stored.integrityValue, '12345')
  assert.equal(Object.hasOwn(stored, 'uploadSessionExpiresAt'), false)
  assert.equal(Object.hasOwn(stored, 'objectKey'), false)
})

test('finalization is idempotent for the same actor, token, node version and evidence id', async () => {
  const { calls, repository } = harness()
  await reserve(repository)
  const input = {
    actor: { _id: 'account-1', status: 'active' }, evidenceId: EVIDENCE_ID,
    uploadSessionTokenHash: TOKEN_HASH, expectedNodeVersion: 4
  }
  const first = await repository.finalizeUpload(input)
  const second = await repository.finalizeUpload(input)
  assert.deepEqual(second, first)
  assert.equal(calls.filter(call => call[0] === 'headObject').length, 1)
})

test('finalization rejects expired sessions, stale nodes, token replay and authoritative size mismatches before publish', async () => {
  const cases = [
    { reservation: { uploadSessionExpiresAt: new Date('2026-08-28T01:59:59.000Z') }, input: {}, code: 'EVIDENCE_UPLOAD_EXPIRED' },
    { reservation: {}, input: { uploadSessionTokenHash: 'b'.repeat(64) }, code: 'FORBIDDEN' },
    { reservation: {}, input: { expectedNodeVersion: 3 }, code: 'VERSION_CONFLICT' },
    { reservation: {}, input: {}, storage: {
      async headObject() { return { size: 101, etag: 'etag' } },
      async readObjectHeader() { throw new Error('must not read') }
    }, code: 'EVIDENCE_NOT_ATTACHABLE' }
  ]
  for (const item of cases) {
    const h = harness(seed(), { storage: item.storage })
    await reserve(h.repository, item.reservation)
    await assert.rejects(h.repository.finalizeUpload({
      actor: { _id: 'account-1', status: 'active' }, evidenceId: EVIDENCE_ID,
      uploadSessionTokenHash: TOKEN_HASH, expectedNodeVersion: 4, ...item.input
    }), assertCode(item.code))
    assert.equal(h.fake.documents('evidences')[0].storageStatus, 'uploading')
  }
})

test('finalization enforces the server-authoritative 120 MiB processing-round total', async () => {
  const existing = {
    _id: 'existing', businessLineId: 'business-1', nodeId: 'node-1', processingRoundNumber: 2,
    storageStatus: 'available', size: 120 * 1024 * 1024, attachmentState: 'unattached'
  }
  const h = harness(seed({ evidences: [existing] }))
  await reserve(h.repository)
  await assert.rejects(h.repository.finalizeUpload({
    actor: { _id: 'account-1', status: 'active' }, evidenceId: EVIDENCE_ID,
    uploadSessionTokenHash: TOKEN_HASH, expectedNodeVersion: 4
  }), assertCode('FEEDBACK_TOTAL_TOO_LARGE'))
  assert.equal(h.fake.documents('evidences').find(item => item._id === EVIDENCE_ID).storageStatus, 'uploading')
})

test('COS storage adapter uses authoritative HEAD metadata and a bounded range read', async () => {
  const calls = []
  const client = {
    headObject(params, callback) {
      calls.push(['headObject', params])
      callback(null, { ETag: 'etag-1', headers: {
        'content-length': '321', 'x-cos-hash-crc64ecma': '987'
      } })
    },
    getObject(params, callback) {
      calls.push(['getObject', params])
      callback(null, { Body: Buffer.from('header') })
    }
  }
  const adapter = createCosStorageAdapter({ client, bucket: 'bucket-1234567890', region: 'ap-shanghai' })
  assert.deepEqual(await adapter.headObject({ objectKey: 'exact/key' }), {
    size: 321, etag: 'etag-1', crc64: '987'
  })
  assert.deepEqual(await adapter.readObjectHeader({ objectKey: 'exact/key', maximumBytes: 64 }), Buffer.from('header'))
  assert.deepEqual(calls, [
    ['headObject', { Bucket: 'bucket-1234567890', Region: 'ap-shanghai', Key: 'exact/key', Headers: {} }],
    ['getObject', {
      Bucket: 'bucket-1234567890', Region: 'ap-shanghai', Key: 'exact/key', Headers: { Range: 'bytes=0-63' }
    }]
  ])
})

test('scoped credential provider grants multipart upload actions to one exact generated key only', async () => {
  let request
  const sts = {
    async getCredential(input) {
      request = input
      return {
        credentials: { tmpSecretId: 'tmp-id', tmpSecretKey: 'tmp-key', sessionToken: 'token' },
        startTime: 1,
        expiredTime: 901
      }
    }
  }
  const provider = createScopedCosCredentialProvider({
    sts,
    secretId: 'permanent-id',
    secretKey: 'permanent-key',
    bucket: 'bucket-1234567890',
    region: 'ap-shanghai'
  })
  const objectKey = `evidence-uploads/business-1/node-1/${EVIDENCE_ID}.heic`
  const result = await provider.issue({ objectKey })
  assert.equal(result.credentials.tmpSecretId, 'tmp-id')
  assert.equal(request.durationSeconds, 900)
  assert.deepEqual(request.policy.statement[0].action, COS_UPLOAD_ACTIONS)
  assert.deepEqual(request.policy.statement[0].action, [
    'name/cos:PutObject',
    'name/cos:InitiateMultipartUpload',
    'name/cos:ListMultipartUploads',
    'name/cos:ListParts',
    'name/cos:UploadPart',
    'name/cos:CompleteMultipartUpload',
    'name/cos:AbortMultipartUpload'
  ])
  assert.deepEqual(request.policy.statement[0].resource, [
    `qcs::cos:ap-shanghai:uid/1234567890:bucket-1234567890/${objectKey}`
  ])
  assert.equal(Object.hasOwn(request.policy.statement[0], 'principal'), false)
  assert.equal(JSON.stringify(request.policy).includes('*"'), false)
  assert.equal(request.policy.statement[0].resource[0].includes('*'), false)
})

test('reservation never attempts to write the immutable CloudBase _id field', async () => {
  const { fake, repository } = harness(seed(), { databaseOptions: { rejectExplicitIdOnSet: true } })

  await reserve(repository)

  const stored = fake.documents('evidences')[0]
  assert.equal(stored._id, EVIDENCE_ID)
  assert.equal(stored.storageStatus, 'uploading')
})

test('scoped credential provider waits for the callback-only qcloud STS contract', async () => {
  let callbackReceived = false
  const sts = {
    getCredential(input, callback) {
      assert.equal(typeof callback, 'function')
      setImmediate(() => {
        callbackReceived = true
        callback(null, {
          credentials: { tmpSecretId: 'tmp-id', tmpSecretKey: 'tmp-key', sessionToken: 'token' },
          startTime: 1,
          expiredTime: 901
        })
      })
    }
  }
  const provider = createScopedCosCredentialProvider({
    sts,
    secretId: 'permanent-id',
    secretKey: 'permanent-key',
    bucket: 'bucket-1234567890',
    region: 'ap-shanghai'
  })

  const result = await provider.issue({
    objectKey: `evidence-uploads/business-1/node-1/${EVIDENCE_ID}.pdf`
  })

  assert.equal(callbackReceived, true)
  assert.equal(result.credentials.tmpSecretId, 'tmp-id')
})
