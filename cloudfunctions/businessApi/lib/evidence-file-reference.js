'use strict'

const { ownDataValue } = require('./account-relationship-schema')

function canonicalCloudFilePrefix({ environmentId, bucket } = {}) {
  if (typeof environmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(environmentId) ||
      typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}-[0-9]{5,20}$/.test(bucket) ||
      `${environmentId}.${bucket}`.length > 128) {
    throw new Error('INVALID_EVIDENCE_FILE_REFERENCE')
  }
  return `cloud://${environmentId}.${bucket}`
}

function resolveEvidenceFileId(evidence, context = {}) {
  const fileId = ownDataValue(evidence, 'fileId').value
  const match = typeof fileId === 'string' && /^cloud:\/\/([^/]+)\/(.+)$/.exec(fileId)
  // Canonical and older SDK-managed references retain their existing behavior.
  if (!match || !context.bucket || match[1] !== context.bucket) return fileId
  const prefix = canonicalCloudFilePrefix(context)
  const read = key => ownDataValue(evidence, key).value
  const lineId = read('businessLineId')
  const nodeId = read('nodeId')
  const evidenceId = read('_id')
  const extension = read('extension')
  if (![lineId, nodeId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      typeof evidenceId !== 'string' || !/^evidence-[a-f0-9]{64}$/.test(evidenceId) ||
      !['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'mov', 'm4v'].includes(extension) ||
      match[2] !== `evidence-uploads/${lineId}/${nodeId}/${evidenceId}.${extension}`) {
    throw new Error('INVALID_EVIDENCE_FILE_REFERENCE')
  }
  return `${prefix}/${match[2]}`
}

module.exports = { canonicalCloudFilePrefix, resolveEvidenceFileId }
