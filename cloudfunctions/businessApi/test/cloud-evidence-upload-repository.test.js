const test = require('node:test')
const assert = require('node:assert/strict')

const {
  COS_UPLOAD_ACTIONS,
  createCloudEvidenceUploadRepository,
  createCosStorageAdapter,
  createScopedCosCredentialProvider
} = require('../lib/cloud-evidence-upload-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { APPLICATION_ERROR_MARKER } = require('../lib/cloud-template-repository')

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
      delay: overrides.delay || (async () => {}),
      onFinalizeError: overrides.onFinalizeError,
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

test('finalization reads the account once per transaction without reusing preflight authorization for commit', async () => {
  const { fake, repository } = harness()
  await reserve(repository)
  const before = fake.transactionRuns.length
  await repository.finalizeUpload({
    actor: { _id: 'account-1', status: 'active' }, evidenceId: EVIDENCE_ID,
    uploadSessionTokenHash: TOKEN_HASH, expectedNodeVersion: 4
  })
  assert.deepEqual(fake.transactionRuns.slice(before).map(item => item.operations), [4, 6])
})

test('account disabled after upload preflight cannot publish evidence using an earlier account snapshot', async () => {
  let fake
  const built = harness(seed(), { storage: {
    async headObject() {
      fake.replace('users', 'account-1', { status: 'disabled' })
      return { size: 100, etag: 'etag-1', crc64: '12345' }
    },
    async readObjectHeader() { return Buffer.from('0000ftypheic') }
  } })
  fake = built.fake
  await reserve(built.repository)
  await assert.rejects(built.repository.finalizeUpload({
    actor: { _id: 'account-1', status: 'active' }, evidenceId: EVIDENCE_ID,
    uploadSessionTokenHash: TOKEN_HASH, expectedNodeVersion: 4
  }), { code: 'FORBIDDEN' })
  assert.equal(fake.documents('evidences')[0].storageStatus, 'uploading')
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

function wrappedWriteConflict() {
  return Object.assign(new Error('document.update:fail -501001 resource system error. database transaction conflict'), {
    errCode: -501001
  })
}

function finalizeInput(evidenceId = EVIDENCE_ID) {
  return { actor: { _id: 'account-1', status: 'active' }, evidenceId,
    uploadSessionTokenHash: TOKEN_HASH, expectedNodeVersion: 4 }
}

async function conflictFromLockedWxSdk(operation = 'update') {
  const cloud = require('wx-server-sdk')
  const { Db } = require('@cloudbase/database')
  cloud.init({ env: 'local-upload-repro' })
  const database = cloud.database()
  const originalRequest = Db.reqClass
  let updates = 0
  // Replace only the network boundary. The real SDK document adapter and
  // transaction retry logic must remain in this regression.
  Db.reqClass = class {
    async send(action) {
      if (action === 'database.startTransaction') return { transactionId: 'local-tx' }
      if (action === (operation === 'get' ? 'database.getDocument' : 'database.modifyDocument')) {
        updates += 1
        return { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'database transaction conflict' }
      }
      if (action === 'database.abortTransaction') return {}
      assert.fail(`unexpected SDK action: ${action}`)
    }
  }
  try {
    await database.runTransaction(transaction => operation === 'get'
      ? transaction.collection('test').doc('node').get()
      : transaction.collection('test').doc('node').update({ data: { bytes: 100 } }))
    assert.fail('the locked SDK must surface the wrapped conflict')
  } catch (error) {
    assert.equal(updates, 1)
    assert.equal(error.errCode, -501001)
    assert.equal(error.code, undefined)
    return error
  } finally {
    Db.reqClass = originalRequest
  }
}

test('preflight read conflict is safely classified for replay of the same reservation', async () => {
  const diagnostics = []
  const { fake, repository, calls } = harness(seed(), { onFinalizeError: value => diagnostics.push(value) })
  await reserve(repository)
  const run = fake.db.runTransaction.bind(fake.db)
  const conflict = await conflictFromLockedWxSdk('get')
  fake.db.runTransaction = async () => { throw conflict }
  await assert.rejects(repository.finalizeUpload(finalizeInput()), error => {
    assert.equal(error.code, 'EVIDENCE_UPLOAD_RETRYABLE')
    assert.equal(error[APPLICATION_ERROR_MARKER], true)
    return true
  })
  assert.deepEqual(diagnostics, [{ stage: 'preflight', causeCode: 'TRANSACTION_CONFLICT' }])
  assert.equal(calls.length, 0)
  assert.equal(fake.documents('evidences')[0].storageStatus, 'uploading')
  fake.db.runTransaction = run
  assert.equal((await repository.finalizeUpload(finalizeInput())).storageStatus, 'available')
  assert.equal(fake.documents('evidences').length, 1)
  assert.equal(fake.documents('business_nodes')[0].evidenceUploadAvailableBytes, 100)
})

test('real uploader replays a lost registration response without reuploading or double counting', async () => {
  const { createEvidenceUploader } = require('../../../miniprogram/utils/evidence-upload')
  const { repository, fake } = harness()
  let begins = 0
  let transfers = 0
  let finalizations = 0
  const uploader = createEvidenceUploader({
    beginUpload: async () => {
      begins++
      await reserve(repository)
      return { evidenceId: EVIDENCE_ID, uploadSessionToken: 'synthetic-token',
        bucket: 'synthetic-123', region: 'ap-shanghai', objectKey: 'synthetic-key' }
    },
    refreshUpload: async () => assert.fail('not expired'),
    cosFactory: () => ({ uploadFile(params, callback) { transfers++; callback(null, {}) } }),
    finalizeUpload: async input => {
      assert.deepEqual(input, { evidenceId: EVIDENCE_ID, uploadSessionToken: 'synthetic-token', expectedNodeVersion: 4 })
      const result = await repository.finalizeUpload(finalizeInput(input.evidenceId))
      if (++finalizations === 1) throw Object.assign(new Error('response lost'), { code: 'NetworkError' })
      return result
    },
    delay: async () => {}
  })
  const result = await uploader.upload({ businessLineId: 'business-1', nodeId: 'node-1', expectedNodeVersion: 4,
    file: { name: 'synthetic.heic', path: '/synthetic.heic', size: 100 } })
  assert.equal(result.storageStatus, 'available')
  assert.equal(begins, 1)
  assert.equal(transfers, 1)
  assert.equal(finalizations, 2)
  assert.equal(fake.documents('evidences').length, 1)
  assert.equal(fake.documents('business_nodes')[0].evidenceUploadAvailableBytes, 100)
})

test('only transient storage errors are retryable and diagnostics never expose provider details', async () => {
  for (const stage of ['head', 'header']) {
    for (const transient of [true, false]) {
      const diagnostics = []
      const raw = Object.assign(new Error('private path and token'), { code: transient ? 'ETIMEDOUT' : 'AccessDenied', statusCode: transient ? 504 : 403 })
      const storage = {
        async headObject() { if (stage === 'head') throw raw; return { size: 100, etag: 'etag' } },
        async readObjectHeader() { throw raw }
      }
      const { fake, repository } = harness(seed(), { storage, onFinalizeError(value) { diagnostics.push(value); throw new Error('logger failed') } })
      await reserve(repository)
      await assert.rejects(repository.finalizeUpload(finalizeInput()), error =>
        transient ? error.code === 'EVIDENCE_UPLOAD_RETRYABLE' && error[APPLICATION_ERROR_MARKER] === true : error === raw)
      assert.deepEqual(diagnostics, [{ stage, causeCode: transient ? 'TRANSIENT_SERVICE_ERROR' : 'UNEXPECTED_ERROR' }])
      assert.doesNotMatch(JSON.stringify(diagnostics), /private|path|token|ETIMEDOUT|AccessDenied/)
      assert.equal(fake.documents('evidences')[0].storageStatus, 'uploading')
    }
  }
})

test('finalization recovers a wx SDK wrapped write conflict without reuploading or double counting', async () => {
  const waits = []
  const { fake, repository, calls } = harness(seed(), { delay: async ms => { waits.push(ms) } })
  await reserve(repository)
  fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error: await conflictFromLockedWxSdk() })

  const result = await repository.finalizeUpload(finalizeInput())
  assert.equal(result.storageStatus, 'available')
  assert.equal(fake.documents('business_nodes')[0].evidenceUploadAvailableBytes, 100)
  assert.equal(fake.documents('evidences').length, 1)
  assert.deepEqual(waits, [80])
  assert.equal(calls.filter(call => call[0] === 'headObject').length, 1)
  assert.deepEqual(await repository.finalizeUpload(finalizeInput()), result)
  assert.equal(fake.documents('business_nodes')[0].evidenceUploadAvailableBytes, 100)
})

test('finalization conflict retry rereads the counter and current permission instead of replaying stale writes', async () => {
  for (const revoked of [false, true]) {
    let fake
    const built = harness(seed(), { delay: async () => {
      if (revoked) fake.replace('users', 'account-1', { status: 'disabled' })
      else fake.replace('business_nodes', 'node-1', { ...fake.documents('business_nodes')[0],
        evidenceUploadRoundNumber: 2, evidenceUploadAvailableBytes: 200 })
    } })
    fake = built.fake
    await reserve(built.repository)
    fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error: wrappedWriteConflict() })
    if (revoked) {
      await assert.rejects(built.repository.finalizeUpload(finalizeInput()), { code: 'FORBIDDEN' })
      assert.equal(fake.documents('evidences')[0].storageStatus, 'uploading')
    } else {
      await built.repository.finalizeUpload(finalizeInput())
      assert.equal(fake.documents('business_nodes')[0].evidenceUploadAvailableBytes, 300)
    }
  }
})

test('only explicit transaction conflicts are retried, with a finite backoff budget', async () => {
  const cases = [
    { error: wrappedWriteConflict(), waits: [80, 160, 320], retryable: true },
    { error: Object.assign(new Error('conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' }), waits: [80, 160, 320], retryable: true },
    { error: Object.assign(new Error('document.update:fail -501001 resource system error. permission denied'), { errCode: -501001 }), waits: [] },
    { error: Object.assign(new Error('database transaction conflict'), { code: 'VERSION_CONFLICT', [APPLICATION_ERROR_MARKER]: true }), waits: [] },
    { error: Object.assign(wrappedWriteConflict(), { [APPLICATION_ERROR_MARKER]: true }), waits: [] },
    { error: Object.assign(new Error('network failure'), { code: 'ETIMEDOUT' }), waits: [], retryable: true }
  ]
  for (const { error, waits: expectedWaits, retryable } of cases) {
    const waits = []
    const { fake, repository } = harness(seed(), { delay: async ms => { waits.push(ms) } })
    await reserve(repository)
    for (let i = 0; i < 5; i += 1) {
      fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error })
    }
    await assert.rejects(repository.finalizeUpload(finalizeInput()), failure =>
      retryable ? failure.code === 'EVIDENCE_UPLOAD_RETRYABLE' && failure[APPLICATION_ERROR_MARKER] === true : failure === error)
    assert.deepEqual(waits, expectedWaits)
    assert.equal(fake.documents('evidences')[0].storageStatus, 'uploading')
    assert.equal(fake.documents('business_nodes')[0].evidenceUploadAvailableBytes, undefined)
  }
})

test('three concurrent image registrations each publish once and preserve the authoritative total', async () => {
  const { fake, repository } = harness()
  const ids = ['1', '2', '3'].map(character => `evidence-${character.repeat(64)}`)
  for (const evidenceId of ids) {
    await reserve(repository, { evidenceId,
      objectKey: `evidence-uploads/business-1/node-1/${evidenceId}.heic` })
  }
  const results = await Promise.all(ids.map(id => repository.finalizeUpload(finalizeInput(id))))
  assert.deepEqual(results.map(result => result.evidenceId).sort(), ids)
  assert.equal(fake.documents('evidences').filter(item => item.storageStatus === 'available').length, 3)
  assert.equal(fake.documents('business_nodes')[0].evidenceUploadAvailableBytes, 300)
})

test('conflict retry cannot overrun capacity or bypass a changed node version', async () => {
  for (const code of ['FEEDBACK_TOTAL_TOO_LARGE', 'VERSION_CONFLICT']) {
    let fake
    const built = harness(seed(), { delay: async () => {
      fake.replace('business_nodes', 'node-1', { ...fake.documents('business_nodes')[0],
        ...(code === 'VERSION_CONFLICT' ? { version: 5 } : {
          evidenceUploadRoundNumber: 2, evidenceUploadAvailableBytes: 120 * 1024 * 1024 - 50
        }) })
    } })
    fake = built.fake
    await reserve(built.repository)
    fake.failNextWrite({ collection: 'business_nodes', operation: 'update', error: wrappedWriteConflict() })
    await assert.rejects(built.repository.finalizeUpload(finalizeInput()), { code })
    assert.equal(fake.documents('evidences')[0].storageStatus, 'uploading')
  }
})

test('authorization refresh reauthorizes and extends one uploading reservation without changing its key', async () => {
  const { fake, repository } = harness()
  await reserve(repository, { uploadSessionExpiresAt: new Date('2026-08-28T01:59:59.000Z') })
  const nextExpiry = new Date('2026-08-28T02:15:00.000Z')
  const result = await repository.refreshUploadAuthorization({
    actor: { _id: 'account-1', status: 'active' },
    evidenceId: EVIDENCE_ID,
    uploadSessionTokenHash: TOKEN_HASH,
    expectedNodeVersion: 4,
    uploadSessionExpiresAt: nextExpiry
  })

  assert.deepEqual(result, {
    evidenceId: EVIDENCE_ID,
    objectKey: `evidence-uploads/business-1/node-1/${EVIDENCE_ID}.heic`
  })
  const stored = fake.documents('evidences')[0]
  assert.equal(stored.uploadSessionExpiresAt.toISOString(), nextExpiry.toISOString())
  assert.equal(stored.objectKey, result.objectKey)
  assert.equal(stored.storageStatus, 'uploading')
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
