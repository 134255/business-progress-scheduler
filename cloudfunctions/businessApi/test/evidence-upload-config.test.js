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
    EVIDENCE_CLOUD_FILE_PREFIX: ' cloud://example '
  }), {
    bucket: 'bucket-1234567890',
    region: 'ap-shanghai',
    secretId: 'AKIDexample123',
    secretKey: 'secret-value',
    cloudFilePrefix: 'cloud://example'
  })
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
