const test = require('node:test')
const assert = require('node:assert/strict')

const { createEvidenceUploadService } = require('../lib/evidence-upload-service')

const NOW = new Date('2026-08-28T02:00:00.000Z')

function assertCode(code) {
  return error => error && error.code === code
}

function harness(overrides = {}) {
  const calls = []
  const repository = overrides.repository || {
    async reserveUpload(value) {
      calls.push(['reserveUpload', value])
      return value.reservation
    },
    async finalizeUpload(value) {
      calls.push(['finalizeUpload', value])
      return {
        evidenceId: value.evidenceId,
        fileName: 'photo.heic',
        category: 'image',
        size: 100,
        storageStatus: 'available'
      }
    }
  }
  const credentialProvider = overrides.credentialProvider || {
    async issue(value) {
      calls.push(['issue', value])
      return {
        credentials: {
          tmpSecretId: 'temporary-id',
          tmpSecretKey: 'temporary-key',
          sessionToken: 'temporary-token'
        },
        startTime: 1787882400,
        expiredTime: 1787883300
      }
    }
  }
  const service = createEvidenceUploadService({
    repository,
    credentialProvider,
    bucket: 'evidence-1234567890',
    region: 'ap-shanghai',
    clock: () => new Date(NOW),
    randomBytes: size => Buffer.alloc(size, 7),
    sha256: value => `sha256:${value}`,
    ...overrides
  })
  return { calls, service }
}

function actor() {
  return { _id: 'account-1', status: 'active' }
}

function beginInput(overrides = {}) {
  return {
    businessLineId: 'business-1',
    nodeId: 'node-1',
    expectedNodeVersion: 4,
    fileName: 'photo.heic',
    declaredSize: 100,
    ...overrides
  }
}

test('begin creates a 15-minute opaque reservation and returns only temporary scoped credentials', async () => {
  const { calls, service } = harness()
  const result = await service.beginEvidenceUpload({ actor: actor(), input: beginInput() })

  assert.match(result.evidenceId, /^evidence-[a-f0-9]{64}$/)
  assert.equal(result.uploadSessionToken, Buffer.alloc(32, 7).toString('base64url'))
  assert.equal(result.bucket, 'evidence-1234567890')
  assert.equal(result.region, 'ap-shanghai')
  assert.equal(result.expiresAt.toISOString(), '2026-08-28T02:15:00.000Z')
  assert.deepEqual(result.credentials, {
    tmpSecretId: 'temporary-id',
    tmpSecretKey: 'temporary-key',
    sessionToken: 'temporary-token'
  })
  assert.equal(Object.hasOwn(result, 'secretId'), false)
  assert.equal(Object.hasOwn(result, 'secretKey'), false)

  const reservation = calls[0][1].reservation
  assert.equal(reservation.uploadSessionTokenHash, `sha256:${result.uploadSessionToken}`)
  assert.equal(reservation.uploadSessionExpiresAt.toISOString(), '2026-08-28T02:15:00.000Z')
  assert.equal(reservation.orphanExpiresAt.toISOString(), '2026-08-29T02:00:00.000Z')
  assert.equal(reservation.objectKey, `evidence-uploads/business-1/node-1/${result.evidenceId}.heic`)
  assert.equal(calls[1][1].objectKey, reservation.objectKey)
})

test('begin rejects malformed identity, version, filename and size before repository work', async () => {
  for (const value of [
    { actor: null, input: beginInput() },
    { actor: actor(), input: beginInput({ expectedNodeVersion: 0 }) },
    { actor: actor(), input: beginInput({ fileName: '../photo.jpg' }) },
    { actor: actor(), input: beginInput({ fileName: 'photo.exe' }) },
    { actor: actor(), input: beginInput({ declaredSize: 120 * 1024 * 1024 + 1 }) }
  ]) {
    const { calls, service } = harness()
    await assert.rejects(service.beginEvidenceUpload(value), error => [
      'EVIDENCE_NOT_ATTACHABLE', 'FILE_TOO_LARGE', 'UNSUPPORTED_FILE_TYPE'
    ].includes(error && error.code))
    assert.deepEqual(calls, [])
  }
})

test('finalize hashes the opaque token and delegates only normalized replay-bound fields', async () => {
  const { calls, service } = harness()
  const result = await service.finalizeEvidenceUpload({
    actor: actor(),
    input: {
      evidenceId: 'evidence-1',
      uploadSessionToken: 'a'.repeat(43),
      expectedNodeVersion: 4
    }
  })
  assert.equal(result.storageStatus, 'available')
  assert.deepEqual(calls, [[
    'finalizeUpload',
    {
      actor: actor(),
      evidenceId: 'evidence-1',
      uploadSessionTokenHash: `sha256:${'a'.repeat(43)}`,
      expectedNodeVersion: 4
    }
  ]])
})

test('finalize rejects malformed tokens and replay coordinates before repository work', async () => {
  for (const input of [
    { evidenceId: 'evidence-1', uploadSessionToken: 'short', expectedNodeVersion: 4 },
    { evidenceId: '../evidence', uploadSessionToken: 'a'.repeat(43), expectedNodeVersion: 4 },
    { evidenceId: 'evidence-1', uploadSessionToken: 'a'.repeat(43), expectedNodeVersion: 3.5 }
  ]) {
    const { calls, service } = harness()
    await assert.rejects(service.finalizeEvidenceUpload({ actor: actor(), input }), assertCode('EVIDENCE_NOT_ATTACHABLE'))
    assert.deepEqual(calls, [])
  }
})

test('begin fails closed when the credential provider returns a permanent or malformed projection', async () => {
  for (const credentials of [
    { secretId: 'permanent', secretKey: 'permanent' },
    { tmpSecretId: 'id', tmpSecretKey: 'key' },
    null
  ]) {
    const { service } = harness({
      credentialProvider: { async issue() { return { credentials, startTime: 1, expiredTime: 2 } } }
    })
    await assert.rejects(
      service.beginEvidenceUpload({ actor: actor(), input: beginInput() }),
      assertCode('EVIDENCE_UPLOAD_UNAVAILABLE')
    )
  }
})

test('begin reports only safe credential-provider diagnostics before failing closed', async () => {
  const diagnostics = []
  const providerError = new Error('request contained secret material')
  providerError.code = 'AccessDenied'
  providerError.statusCode = 403
  providerError.RequestId = 'sts-request-123'
  providerError.secretId = 'must-not-leak'
  const { service } = harness({
    credentialProvider: { async issue() { throw providerError } },
    onCredentialError: value => diagnostics.push(value)
  })

  let caught
  await assert.rejects(
    service.beginEvidenceUpload({ actor: actor(), input: beginInput() }),
    error => {
      caught = error
      return assertCode('EVIDENCE_UPLOAD_UNAVAILABLE')(error)
    }
  )
  assert.deepEqual(diagnostics, [{
    code: 'AccessDenied',
    statusCode: 403,
    requestId: 'sts-request-123'
  }])
  assert.deepEqual(caught.diagnostic, {
    stage: 'credential_issue',
    code: 'AccessDenied',
    statusCode: 403
  })
  assert.equal(JSON.stringify(diagnostics).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(diagnostics).includes('request contained'), false)
})

test('begin extracts the nested Tencent Cloud API error code without exposing the response body', async () => {
  const providerError = new Error('response contained secret material')
  providerError.response = {
    status: 403,
    data: {
      Response: {
        Error: {
          Code: 'AuthFailure.SecretIdNotFound',
          Message: 'must-not-leak'
        },
        RequestId: 'nested-request-123'
      }
    }
  }
  const { service } = harness({
    credentialProvider: { async issue() { throw providerError } }
  })

  let caught
  await assert.rejects(
    service.beginEvidenceUpload({ actor: actor(), input: beginInput() }),
    error => {
      caught = error
      return assertCode('EVIDENCE_UPLOAD_UNAVAILABLE')(error)
    }
  )
  assert.deepEqual(caught.diagnostic, {
    stage: 'credential_issue',
    code: 'AuthFailure.SecretIdNotFound',
    statusCode: 403
  })
  assert.equal(JSON.stringify(caught).includes('must-not-leak'), false)
})
