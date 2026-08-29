const { createCloudFeedbackRepository } = require('../../lib/cloud-feedback-repository')
const { createRequestFingerprint } = require('../../lib/feedback-service')
const { createFakeCloudDatabase } = require('./fake-cloud-database')
const { createOptimisticBusinessDatabase } = require('./business-harness')

const NOW = new Date('2026-08-07T03:00:00.000Z')

function seed(overrides = {}) {
  const evidenceCount = overrides.evidenceCount === undefined ? 2 : overrides.evidenceCount
  const evidences = Array.from({ length: evidenceCount }, (_, index) => ({
    _id: `evidence-${index + 1}`,
    businessLineId: 'line-1', nodeId: 'node-1', feedbackId: null,
    fileId: `cloud://env/path-${index + 1}.pdf`, fileName: `file-${index + 1}.pdf`,
    category: 'pdf', extension: 'pdf', mimeType: 'application/pdf', size: 1,
    uploadedBy: 'account-a', uploadedAt: new Date('2026-08-07T02:00:00.000Z'),
    storageStatus: 'available', orphanExpiresAt: new Date('2026-08-08T02:00:00.000Z'),
    retentionStartedAt: null, purgeDueAt: null, purgedAt: null
  }))
  return {
    users: overrides.users || [
      { _id: 'account-a', status: 'active' },
      { _id: 'account-b', status: 'active' },
      { _id: 'manager', status: 'active' }
    ],
    business_lines: overrides.lines || [{
      _id: 'line-1', status: 'active', managerUserIds: ['manager'],
      memberUserIds: ['account-a', 'account-b', 'manager'], currentNodeId: 'node-1',
      currentNodeIndex: 0, currentNodeName: '执行', nodeCount: 2, progress: 0, version: 1
    }],
    business_nodes: overrides.nodes || [
      {
        _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-20260807-0001-N001',
        sequence: 0, name: '执行', status: 'ready', version: 4,
        assigneeUserIds: ['account-a', 'account-b'], requiresEvidence: false,
        fieldDefinitions: []
      },
      {
        _id: 'line-1-node-002', businessLineId: 'line-1', nodeCode: 'BL-20260807-0001-N002',
        sequence: 1, name: '交付', status: 'waiting', version: 1,
        assigneeUserIds: ['account-a'], requiresEvidence: false,
        fieldDefinitions: []
      }
    ],
    evidences: overrides.evidences || evidences,
    node_feedback: overrides.feedback || [],
    audit_logs: overrides.audit || []
  }
}

function submission(overrides = {}) {
  const evidenceIds = overrides.evidenceIds || []
  const actor = overrides.actor || { _id: 'account-a', status: 'active' }
  const fieldValues = overrides.fieldValues || []
  const requestInput = {
    businessLineId: 'line-1', nodeId: 'node-1', expectedNodeVersion: 4,
    status: 'completed', fieldValues, comment: '完成', evidenceIds,
    requestKey: 'request-1',
    ...(overrides.input || {})
  }
  const { fieldValues: ignored, ...input } = requestInput
  return {
    actor,
    input,
    requestFingerprint: createRequestFingerprint(actor, requestInput),
    fieldSnapshots: overrides.fieldSnapshots || [],
    evidenceTotalBytes: overrides.evidenceTotalBytes === undefined ? evidenceIds.length : overrides.evidenceTotalBytes
  }
}

function createFeedbackHarness(overrides = {}) {
  const fake = createFakeCloudDatabase(overrides.seed || seed(overrides), {
    afterTransaction: overrides.afterTransaction,
    afterTransactionError: overrides.afterTransactionError,
    transformRead: overrides.transformRead
  })
  const repository = createCloudFeedbackRepository({
    db: fake.db,
    clock: overrides.clock || (() => new Date(NOW)),
    workTimeService: overrides.workTimeService,
    claimChunkSize: overrides.claimChunkSize || 40,
    wait: overrides.wait
  })
  return { fake, repository, now: new Date(NOW) }
}

function createOptimisticFeedbackHarness(overrides = {}) {
  const fake = createOptimisticBusinessDatabase(overrides.seed || seed(overrides))
  const repository = createCloudFeedbackRepository({
    db: fake.db,
    clock: () => new Date(NOW),
    workTimeService: overrides.workTimeService,
    claimChunkSize: overrides.claimChunkSize || 40,
    wait: overrides.wait || (() => Promise.resolve())
  })
  return { fake, repository, now: new Date(NOW) }
}

module.exports = { NOW, seed, submission, createFeedbackHarness, createOptimisticFeedbackHarness }
