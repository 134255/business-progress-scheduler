'use strict'

const SECRET_ID = /^AKID[A-Za-z0-9]+$/

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readEvidenceUploadConfig(env = {}) {
  const config = {
    bucket: clean(env.EVIDENCE_COS_BUCKET),
    region: clean(env.EVIDENCE_COS_REGION),
    secretId: clean(env.EVIDENCE_COS_SECRET_ID),
    secretKey: clean(env.EVIDENCE_COS_SECRET_KEY),
    cloudFilePrefix: clean(env.EVIDENCE_CLOUD_FILE_PREFIX)
  }
  if (!Object.values(config).every(Boolean)) {
    const error = new Error('EVIDENCE_UPLOAD_UNAVAILABLE')
    error.code = 'EVIDENCE_UPLOAD_UNAVAILABLE'
    error.configStage = 'missing'
    throw error
  }
  if (!SECRET_ID.test(config.secretId)) {
    const error = new Error('EVIDENCE_UPLOAD_UNAVAILABLE')
    error.code = 'EVIDENCE_UPLOAD_UNAVAILABLE'
    error.configStage = 'credential_shape'
    throw error
  }
  return config
}

module.exports = { readEvidenceUploadConfig }
