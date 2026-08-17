const test = require('node:test')
const assert = require('node:assert/strict')

const { createRetentionService } = require('../lib/retention-service')

function harness(overrides = {}) {
  const calls = []
  const pages = {
    feedback: [['feedback-expired'], []],
    amendment: [['amendment-expired'], []],
    shares: [['share-expired'], []],
    due: [[{ evidenceId: 'due-1' }, { evidenceId: 'due-missing' }, { evidenceId: 'due-fail' }], []],
    orphan: [[{ evidenceId: 'orphan-1' }], []]
  }
  const repository = {
    async listExpiredFeedbackReservations(input) { calls.push(['listFeedback', input]); return pages.feedback.shift() || [] },
    async recoverExpiredFeedbackReservation(input) { calls.push(['recoverFeedback', input]); return true },
    async listExpiredAmendmentReservations(input) { calls.push(['listAmendment', input]); return pages.amendment.shift() || [] },
    async recoverExpiredAmendmentReservation(input) { calls.push(['recoverAmendment', input]); return true },
    async listExpiredPublicShares(input) { calls.push(['listShares', input]); return pages.shares.shift() || [] },
    async cleanupExpiredPublicShare(input) { calls.push(['cleanupShare', input]); return true },
    async createDueReminders(input) { calls.push(['reminders', input]); return 3 },
    async listDueEvidence(input) { calls.push(['listDue', input]); return pages.due.shift() || [] },
    async listExpiredOrphans(input) { calls.push(['listOrphans', input]); return pages.orphan.shift() || [] },
    async claimEvidenceForPurge(input) {
      calls.push(['claim', input])
      return { evidenceId: input.evidenceId, fileId: `cloud://env/${input.evidenceId}`, claimToken: `token-${input.evidenceId}` }
    },
    async markEvidencePurged(input) { calls.push(['purged', input]) },
    async markEvidencePurgeFailed(input) { calls.push(['failed', input]) },
    ...overrides.repository
  }
  const storage = {
    async deleteObject(fileId) {
      calls.push(['delete', fileId])
      if (fileId.endsWith('due-fail')) {
        const error = new Error('provider path must not escape')
        error.category = 'TRANSIENT'
        throw error
      }
      return { absent: fileId.endsWith('due-missing') }
    },
    ...overrides.storage
  }
  const now = new Date('2026-08-10T00:00:00.000Z')
  const service = createRetentionService({ repository, storage, clock: () => now, batchSize: 2 })
  return { service, calls, now }
}

test('按固定顺序回收预约、创建提醒并清理到期和孤立凭证', async () => {
  const { service, calls, now } = harness()
  const result = await service.runOnce()

  assert.deepEqual(result, {
    feedbackReservationsRecovered: 1,
    amendmentReservationsRecovered: 1,
    publicSharesCleaned: 1,
    remindersCreated: 3,
    objectsPurged: 2,
    orphansPurged: 1,
    failures: { TRANSIENT: 1 }
  })
  assert.deepEqual(calls.filter(call => call[0] === 'recoverFeedback')[0], ['recoverFeedback', { id: 'feedback-expired', now }])
  assert.equal(calls.findIndex(call => call[0] === 'recoverAmendment') > calls.findIndex(call => call[0] === 'recoverFeedback'), true)
  assert.equal(calls.findIndex(call => call[0] === 'listOrphans') > calls.findIndex(call => call[0] === 'recoverAmendment'), true)
  assert.equal(calls.findIndex(call => call[0] === 'cleanupShare') > calls.findIndex(call => call[0] === 'recoverAmendment'), true)
  assert.equal(calls.findIndex(call => call[0] === 'listOrphans') > calls.findIndex(call => call[0] === 'cleanupShare'), true)
  assert.equal(calls.findIndex(call => call[0] === 'reminders') > calls.findIndex(call => call[0] === 'listOrphans'), true)
  assert.equal(calls.findIndex(call => call[0] === 'listDue') > calls.findIndex(call => call[0] === 'reminders'), true)
})

test('清理只在认领成功后删除，确认对象不存在也记为已清理', async () => {
  const { service, calls } = harness({
    repository: {
      async claimEvidenceForPurge(input) {
        calls.push(['claim', input])
        if (input.evidenceId === 'due-1') return null
        return { evidenceId: input.evidenceId, fileId: `cloud://env/${input.evidenceId}`, claimToken: `token-${input.evidenceId}` }
      }
    }
  })
  const result = await service.runOnce()
  assert.equal(calls.some(call => call[0] === 'delete' && call[1].endsWith('due-1')), false)
  assert.equal(calls.some(call => call[0] === 'purged' && call[1].evidenceId === 'due-missing'), true)
  assert.equal(calls.some(call => call[0] === 'purged' && call[1].claimToken === 'token-due-missing'), true)
  assert.equal(result.objectsPurged, 1)
})

test('删除成功和失败都携带同一次事务认领令牌', async () => {
  const { service, calls } = harness()
  await service.runOnce()
  assert.equal(calls.some(call => call[0] === 'purged' && call[1].evidenceId === 'due-1' && call[1].claimToken === 'token-due-1'), true)
  assert.equal(calls.some(call => call[0] === 'failed' && call[1].evidenceId === 'due-fail' && call[1].claimToken === 'token-due-fail'), true)
})

test('失败结果只保留安全分类，不返回文件、业务或身份信息', async () => {
  const { service } = harness()
  const result = await service.runOnce()
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('cloud://'), false)
  assert.equal(serialized.includes('due-fail'), false)
  assert.deepEqual(result.failures, { TRANSIENT: 1 })
})

test('无效依赖、时钟和批次在执行前失败', async () => {
  assert.throws(() => createRetentionService({}), /repository/)
  assert.throws(() => createRetentionService({ repository: {}, storage: {}, clock: () => new Date(), batchSize: 0 }), /batchSize/)
  const service = createRetentionService({ repository: {}, storage: {}, clock: () => new Date('invalid'), batchSize: 10 })
  await assert.rejects(service.runOnce(), /clock/)
  assert.throws(
    () => createRetentionService({ repository: {}, storage: {}, clock: () => new Date(), batchSize: 41 }),
    /batchSize/
  )
})

test('每条维护路径单次只读取一个有界候选页', async () => {
  const { service, calls } = harness()
  await service.runOnce()
  for (const name of ['listFeedback', 'listAmendment', 'listShares', 'listOrphans', 'listDue']) {
    assert.equal(calls.filter(call => call[0] === name).length, 1, name)
  }
})
