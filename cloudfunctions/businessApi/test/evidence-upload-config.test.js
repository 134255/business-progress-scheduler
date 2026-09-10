'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readEvidenceUploadConfig } = require('../lib/evidence-upload-config')

test('evidence upload configuration removes copy-paste whitespace without exposing credentials', () => {
  assert.deepEqual(readEvidenceUploadConfig({
    EVIDENCE_COS_BUCKET: ' bucket-1234567890 \r\n',
    EVIDENCE_COS_REGION: '\tap-shanghai ',
    EVIDENCE_COS_SECRET_ID: ' AKIDexample123\n',
    EVIDENCE_COS_SECRET_KEY: ' secret-value\r\n',
    EVIDENCE_CLOUD_FILE_PREFIX: ' cloud://env-test.bucket-1234567890 '
  }, 'env-test'), {
    bucket: 'bucket-1234567890',
    region: 'ap-shanghai',
    secretId: 'AKIDexample123',
    secretKey: 'secret-value',
    cloudFilePrefix: 'cloud://env-test.bucket-1234567890'
  })
})

test('new uploads correct only the current bucket-only prefix using the trusted runtime environment', () => {
  const config = readEvidenceUploadConfig({
    EVIDENCE_COS_BUCKET: 'bucket-1234567890', EVIDENCE_COS_REGION: 'ap-shanghai',
    EVIDENCE_COS_SECRET_ID: 'AKIDexample123', EVIDENCE_COS_SECRET_KEY: 'synthetic-secret',
    EVIDENCE_CLOUD_FILE_PREFIX: 'cloud://bucket-1234567890'
  }, 'env-test')
  assert.equal(config.cloudFilePrefix, 'cloud://env-test.bucket-1234567890')
})

test('upload configuration rejects mismatched environment, bucket and malformed file prefixes', () => {
  const base = {
    EVIDENCE_COS_BUCKET: 'bucket-1234567890', EVIDENCE_COS_REGION: 'ap-shanghai',
    EVIDENCE_COS_SECRET_ID: 'AKIDexample123', EVIDENCE_COS_SECRET_KEY: 'synthetic-secret'
  }
  for (const prefix of ['cloud://other-env.bucket-1234567890', 'cloud://env-test.other-1234567890',
    'cloud://other-1234567890', 'cloud://env-test', 'cloud://env-test.bucket-1234567890/path',
    'https://env-test.bucket-1234567890']) {
    assert.throws(() => readEvidenceUploadConfig({ ...base, EVIDENCE_CLOUD_FILE_PREFIX: prefix }, 'env-test'),
      error => error.code === 'EVIDENCE_UPLOAD_UNAVAILABLE' && error.configStage === 'file_prefix')
  }
  for (const runtimeEnv of [undefined, '', 'env.test', 'env/test']) {
    assert.throws(() => readEvidenceUploadConfig({ ...base,
      EVIDENCE_CLOUD_FILE_PREFIX: 'cloud://bucket-1234567890' }, runtimeEnv),
    error => error.code === 'EVIDENCE_UPLOAD_UNAVAILABLE' && error.configStage === 'file_prefix')
  }
})

test('evidence upload configuration rejects a missing or malformed permanent SecretId', () => {
  for (const secretId of ['', 'secret-key-was-pasted-here']) {
    assert.throws(() => readEvidenceUploadConfig({
      EVIDENCE_COS_BUCKET: 'bucket-1234567890',
      EVIDENCE_COS_REGION: 'ap-shanghai',
      EVIDENCE_COS_SECRET_ID: secretId,
      EVIDENCE_COS_SECRET_KEY: 'secret-value',
      EVIDENCE_CLOUD_FILE_PREFIX: 'cloud://example'
    }), error => error && error.code === 'EVIDENCE_UPLOAD_UNAVAILABLE' &&
      error.configStage === (secretId ? 'credential_shape' : 'missing'))
  }
})
