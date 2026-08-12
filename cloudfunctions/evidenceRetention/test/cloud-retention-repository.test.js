const test = require('node:test')
const assert = require('node:assert/strict')

const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
const { createCloudRetentionRepository } = require('../lib/cloud-retention-repository')

const NOW = new Date('2026-08-10T01:00:00.000Z')

function repositoryFor(seed, tokens = ['claim-a', 'claim-b', 'claim-c']) {
  const fake = createFakeCloudDatabase(seed)
  const repository = createCloudRetentionRepository({
    db: fake.db,
    clock: () => NOW,
    tokenFactory: () => tokens.shift() || 'claim-fallback'
  })
  return { fake, repository }
}

test('冻结业务只在上海日历提前十五、七、一日创建确定性站内提醒', async () => {
  const { fake, repository } = repositoryFor({
    business_lines: [
      { _id: 'line-15', status: 'completed', purgeDueAt: new Date('2026-08-25T09:00:00.000Z'), managerUserIds: ['manager-a'] },
      { _id: 'line-7', status: 'cancelled', purgeDueAt: new Date('2026-08-17T00:00:00.000Z'), managerUserIds: ['manager-b'] },
      { _id: 'line-1', status: 'closed', purgeDueAt: new Date('2026-08-10T23:00:00.000Z'), managerUserIds: ['manager-c'] },
      { _id: 'line-active', status: 'active', purgeDueAt: new Date('2026-08-25T00:00:00.000Z'), managerUserIds: ['manager-d'] },
      { _id: 'line-other-day', status: 'deleted', purgeDueAt: new Date('2026-08-20T00:00:00.000Z'), managerUserIds: ['manager-e'] }
    ]
  })

  assert.equal(await repository.createDueReminders({ now: NOW, limit: 20 }), 3)
  assert.equal(await repository.createDueReminders({ now: NOW, limit: 20 }), 0)
  const notifications = fake.documents('notifications').sort((a, b) => a._id.localeCompare(b._id))
  assert.deepEqual(notifications.map(item => item._id), [
    'evidence-retention:line-1:1',
    'evidence-retention:line-15:15',
    'evidence-retention:line-7:7'
  ])
  assert.deepEqual(notifications[0].recipientUserIds, ['manager-c'])
  assert.equal(JSON.stringify(notifications).includes('cloud://'), false)
})

test('提醒批次跳过已存在记录并在后续运行继续处理剩余业务', async () => {
  const { fake, repository } = repositoryFor({
    business_lines: ['a', 'b', 'c'].map(id => ({
      _id: `line-${id}`, status: 'completed', purgeDueAt: new Date('2026-08-25T00:00:00.000Z'), managerUserIds: [`manager-${id}`]
    })),
    notifications: [{ _id: 'evidence-retention:line-a:15', type: 'evidence_retention' }]
  })
  assert.equal(await repository.createDueReminders({ now: NOW, limit: 1 }), 0)
  assert.equal(await repository.createDueReminders({ now: NOW, limit: 1 }), 1)
  assert.equal(await repository.createDueReminders({ now: NOW, limit: 1 }), 1)
  assert.equal(await repository.createDueReminders({ now: NOW, limit: 1 }), 0)
  assert.deepEqual(fake.documents('notifications').map(item => item._id).sort(), [
    'evidence-retention:line-a:15', 'evidence-retention:line-b:15', 'evidence-retention:line-c:15'
  ])
})

test('纯旧OpenID业务保留提醒降级为超级管理员受众且重复执行幂等', async () => {
  const { fake, repository } = repositoryFor({
    business_lines: [{
      _id: 'legacy-line', status: 'completed', purgeDueAt: new Date('2026-08-25T00:00:00.000Z'),
      managerIds: ['legacy-openid'], memberIds: ['legacy-openid']
    }]
  })

  assert.equal(await repository.createDueReminders({ now: NOW, limit: 20 }), 1)
  assert.equal(await repository.createDueReminders({ now: NOW, limit: 20 }), 0)
  const note = fake.documents('notifications')[0]
  assert.equal(note.audienceRole, 'super_admin')
  assert.equal(Object.hasOwn(note, 'recipientUserIds'), false)
  assert.doesNotMatch(JSON.stringify(note), /legacy-openid/)
})

test('已有同编号空受众保留提醒会在事务中升级而不是永久跳过', async () => {
  const notificationId = 'evidence-retention:legacy-line:15'
  const { fake, repository } = repositoryFor({
    business_lines: [{
      _id: 'legacy-line', status: 'completed', purgeDueAt: new Date('2026-08-25T00:00:00.000Z'),
      managerIds: ['legacy-openid'], memberIds: ['legacy-openid']
    }],
    notifications: [{
      _id: notificationId, type: 'evidence_retention', businessLineId: 'legacy-line',
      recipientUserIds: [], daysRemaining: 15, status: 'pending'
    }]
  })

  assert.equal(await repository.createDueReminders({ now: NOW, limit: 20 }), 1)
  const note = fake.documents('notifications').find(item => item._id === notificationId)
  assert.equal(note.audienceRole, 'super_admin')
  assert.equal(Object.hasOwn(note, 'recipientUserIds'), false)
})

test('账号制保留提醒受众超过索引预算时失败关闭且不降级为角色通知', async () => {
  const managerUserIds = Array.from({ length: 30 }, (_, index) =>
    `account-manager-${String(index).padStart(2, '0')}-1234567890abcdef`)
  const { fake, repository } = repositoryFor({
    business_lines: [{
      _id: 'oversized-line', status: 'completed',
      purgeDueAt: new Date('2026-08-25T00:00:00.000Z'),
      managerUserIds, memberUserIds: managerUserIds
    }]
  })
  assert.equal(await repository.createDueReminders({ now: NOW, limit: 20 }), 0)
  assert.deepEqual(fake.documents('notifications'), [])
})

test('到期候选包含统一业务期限和独立修订期限的精确边界并排除不安全记录', async () => {
  const { repository } = repositoryFor({
    business_lines: [
      { _id: 'line-due', status: 'completed', purgeDueAt: NOW },
      { _id: 'line-later', status: 'closed', purgeDueAt: new Date(NOW.getTime() + 1) },
      { _id: 'line-active', status: 'active', purgeDueAt: NOW }
    ],
    audit_logs: [
      { _id: 'amend-published', action: 'AMEND_FROZEN_BUSINESS', publishState: 'published', targetId: 'line-due' },
      { _id: 'amend-reserved', action: 'AMEND_FROZEN_BUSINESS', publishState: 'reserved', targetId: 'line-due' }
    ],
    evidences: [
      { _id: 'ordinary-due', businessLineId: 'line-due', feedbackId: 'feedback-1', fileId: 'cloud://env/ordinary', storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'node_feedback' },
      { _id: 'ordinary-later', businessLineId: 'line-later', feedbackId: 'feedback-2', fileId: 'cloud://env/later', storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'node_feedback' },
      { _id: 'ordinary-active', businessLineId: 'line-active', feedbackId: 'feedback-3', fileId: 'cloud://env/active', storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'node_feedback' },
      { _id: 'amendment-due', businessLineId: 'line-due', amendmentId: 'amend-published', fileId: 'cloud://env/amend', storageStatus: 'available', retentionScope: 'evidence', retentionSource: 'audit_amendment', purgeDueAt: NOW },
      { _id: 'amendment-unpublished', businessLineId: 'line-due', amendmentId: 'amend-reserved', fileId: 'cloud://env/reserved', storageStatus: 'available', retentionScope: 'evidence', retentionSource: 'audit_amendment', purgeDueAt: NOW },
      { _id: 'malformed-scope', businessLineId: 'line-due', fileId: 'cloud://env/bad', storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'audit_amendment' },
      { _id: 'already-purged', businessLineId: 'line-due', fileId: 'cloud://env/purged', storageStatus: 'purged', retentionScope: 'business_line', retentionSource: 'node_feedback' }
    ]
  })

  assert.deepEqual(await repository.listDueEvidence({ now: NOW, afterId: '', limit: 20 }), [
    { evidenceId: 'amendment-due' },
    { evidenceId: 'ordinary-due' }
  ])
})

test('孤立清理只选择到期且未被反馈或修订预约占用的可用凭证', async () => {
  const { repository } = repositoryFor({
    evidences: [
      { _id: 'orphan-due', fileId: 'cloud://env/due', storageStatus: 'available', orphanExpiresAt: NOW, feedbackId: null, amendmentId: null, attachmentState: 'unattached' },
      { _id: 'orphan-later', fileId: 'cloud://env/later', storageStatus: 'available', orphanExpiresAt: new Date(NOW.getTime() + 1), feedbackId: null, amendmentId: null, attachmentState: 'unattached' },
      { _id: 'feedback-claimed', fileId: 'cloud://env/feedback', storageStatus: 'available', orphanExpiresAt: NOW, feedbackId: 'feedback-1', amendmentId: null, attachmentState: 'feedback_claimed' },
      { _id: 'amendment-claimed', fileId: 'cloud://env/amend', storageStatus: 'available', orphanExpiresAt: NOW, feedbackId: null, amendmentId: 'amend-1', attachmentState: 'amendment_claimed' }
    ]
  })
  assert.deepEqual(await repository.listExpiredOrphans({ now: NOW, afterId: '', limit: 20 }), [
    { evidenceId: 'orphan-due' }
  ])
})

test('工作器中断后只有租约已过期的清理中记录重新进入对应候选集', async () => {
  const { repository } = repositoryFor({
    business_lines: [{ _id: 'line-due', status: 'completed', purgeDueAt: NOW }],
    evidences: [
      { _id: 'retention-expired', businessLineId: 'line-due', feedbackId: 'feedback-1', fileId: 'cloud://env/a', storageStatus: 'purge_pending', purgeClaimExpiresAt: NOW, retentionScope: 'business_line', retentionSource: 'node_feedback' },
      { _id: 'retention-live', businessLineId: 'line-due', feedbackId: 'feedback-2', fileId: 'cloud://env/b', storageStatus: 'purge_pending', purgeClaimExpiresAt: new Date(NOW.getTime() + 1), retentionScope: 'business_line', retentionSource: 'node_feedback' },
      { _id: 'orphan-expired', fileId: 'cloud://env/c', storageStatus: 'purge_pending', purgeClaimExpiresAt: NOW, orphanExpiresAt: NOW, feedbackId: null, amendmentId: null, attachmentState: 'unattached' }
    ]
  })
  assert.deepEqual(await repository.listDueEvidence({ now: NOW, afterId: '', limit: 20 }), [{ evidenceId: 'retention-expired' }])
  assert.deepEqual(await repository.listExpiredOrphans({ now: NOW, afterId: '', limit: 20 }), [{ evidenceId: 'orphan-expired' }])
})

test('事务清理租约阻止并发认领并要求原令牌确认成功或失败', async () => {
  const { fake, repository } = repositoryFor({
    business_lines: [{ _id: 'line-due', status: 'deleted', purgeDueAt: NOW }],
    evidences: [
      { _id: 'evidence-1', businessLineId: 'line-due', feedbackId: 'feedback-1', fileId: 'cloud://env/file', storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'node_feedback', purgeFailureCount: 0 }
    ]
  })
  const claimed = await repository.claimEvidenceForPurge({ evidenceId: 'evidence-1', mode: 'retention', now: NOW })
  assert.deepEqual(claimed, { evidenceId: 'evidence-1', fileId: 'cloud://env/file', claimToken: 'claim-a' })
  assert.equal(await repository.claimEvidenceForPurge({ evidenceId: 'evidence-1', mode: 'retention', now: NOW }), null)
  assert.equal(await repository.markEvidencePurged({ evidenceId: 'evidence-1', mode: 'retention', now: NOW, claimToken: 'wrong', objectWasAbsent: false }), false)
  assert.equal(await repository.markEvidencePurgeFailed({ evidenceId: 'evidence-1', mode: 'retention', now: NOW, claimToken: 'claim-a', errorCategory: 'TRANSIENT' }), true)
  let stored = fake.documents('evidences')[0]
  assert.equal(stored.storageStatus, 'purge_failed')
  assert.equal(stored.purgeFailureCount, 1)
  assert.equal(stored.lastPurgeErrorCategory, 'TRANSIENT')

  const retry = await repository.claimEvidenceForPurge({ evidenceId: 'evidence-1', mode: 'retention', now: new Date(NOW.getTime() + 1) })
  assert.equal(retry.claimToken, 'claim-b')
  assert.equal(await repository.markEvidencePurged({ evidenceId: 'evidence-1', mode: 'retention', now: NOW, claimToken: 'claim-b', objectWasAbsent: true }), true)
  stored = fake.documents('evidences')[0]
  assert.equal(stored.storageStatus, 'purged')
  assert.equal(stored.fileId, undefined)
  assert.equal(stored.purgedObjectWasAbsent, true)
})

test('过期反馈预约按固定关系回滚凭证并清除仍指向它的节点锁', async () => {
  const { fake, repository } = repositoryFor({
    node_feedback: [
      { _id: 'feedback-expired', publishState: 'reserved', businessLineId: 'line-1', nodeId: 'node-1', claimExpiresAt: NOW },
      { _id: 'feedback-live', publishState: 'reserved', businessLineId: 'line-1', nodeId: 'node-2', claimExpiresAt: new Date(NOW.getTime() + 1) }
    ],
    business_nodes: [
      { _id: 'node-1', businessLineId: 'line-1', feedbackClaimId: 'feedback-expired', feedbackClaimHash: 'safe', feedbackClaimExpiresAt: NOW },
      { _id: 'node-2', businessLineId: 'line-1', feedbackClaimId: 'feedback-live', feedbackClaimExpiresAt: new Date(NOW.getTime() + 1) }
    ],
    evidences: [
      { _id: 'feedback-evidence', feedbackId: 'feedback-expired', attachmentState: 'feedback_claimed', orphanExpiresAt: null, attachmentPreviousOrphanExpiresAt: new Date('2026-08-11T01:00:00.000Z'), retentionScope: 'business_line', retentionSource: 'node_feedback' }
    ]
  })
  assert.deepEqual(await repository.listExpiredFeedbackReservations({ now: NOW, afterId: '', limit: 20 }), ['feedback-expired'])
  assert.equal(await repository.recoverExpiredFeedbackReservation({ id: 'feedback-expired', now: NOW }), true)
  assert.equal(fake.documents('node_feedback').find(item => item._id === 'feedback-expired').publishState, 'aborted')
  assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-1').feedbackClaimId, undefined)
  const evidence = fake.documents('evidences')[0]
  assert.equal(evidence.feedbackId, null)
  assert.equal(evidence.attachmentState, undefined)
  assert.deepEqual(evidence.orphanExpiresAt, new Date('2026-08-11T01:00:00.000Z'))
})

test('预约记录丢失时只清除到期且仍指向该编号的节点锁', async () => {
  const { fake, repository } = repositoryFor({
    business_nodes: [
      { _id: 'node-stale', businessLineId: 'line-1', feedbackClaimId: 'feedback-missing', feedbackClaimExpiresAt: NOW },
      { _id: 'node-live', businessLineId: 'line-1', feedbackClaimId: 'feedback-other', feedbackClaimExpiresAt: new Date(NOW.getTime() + 1) }
    ]
  })
  assert.deepEqual(await repository.listExpiredFeedbackReservations({ now: NOW, afterId: '', limit: 20 }), ['feedback-missing'])
  assert.equal(await repository.recoverExpiredFeedbackReservation({ id: 'feedback-missing', now: NOW }), true)
  assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-stale').feedbackClaimId, undefined)
  assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-live').feedbackClaimId, 'feedback-other')
})

test('过期审计修订预约分块恢复孤立期限并终结为不可发布状态', async () => {
  const evidences = Array.from({ length: 41 }, (_, index) => ({
    _id: `amend-evidence-${String(index).padStart(2, '0')}`,
    amendmentId: 'amend-expired',
    attachmentState: 'amendment_claimed',
    orphanExpiresAt: null,
    amendmentRollbackOrphanExpiresAt: new Date('2026-08-11T01:00:00.000Z'),
    retentionScope: 'evidence', retentionSource: 'audit_amendment', purgeDueAt: new Date('2026-10-01T00:00:00.000Z')
  }))
  const { fake, repository } = repositoryFor({
    audit_logs: [
      { _id: 'amend-expired', action: 'AMEND_FROZEN_BUSINESS', publishState: 'reserved', targetId: 'line-1', claimExpiresAt: NOW },
      { _id: 'amend-live', action: 'AMEND_FROZEN_BUSINESS', publishState: 'reserved', targetId: 'line-1', claimExpiresAt: new Date(NOW.getTime() + 1) },
      { _id: 'amend-published', action: 'AMEND_FROZEN_BUSINESS', publishState: 'published', targetId: 'line-1', claimExpiresAt: NOW }
    ],
    evidences
  })
  assert.deepEqual(await repository.listExpiredAmendmentReservations({ now: NOW, afterId: '', limit: 20 }), ['amend-expired'])
  assert.equal(await repository.recoverExpiredAmendmentReservation({ id: 'amend-expired', now: NOW }), true)
  assert.equal(fake.documents('audit_logs').find(item => item._id === 'amend-expired').publishState, 'aborted')
  assert.equal(fake.documents('evidences').every(item => item.amendmentId === null && item.attachmentState === undefined), true)
  assert.equal(Math.max(...fake.transactionRuns.map(item => item.operations)) <= 100, true)
})

test('反馈预约有界页会越过四十条坏记录并在下一轮到达第四十一条', async () => {
  const bad = Array.from({ length: 40 }, (_, index) => ({
    _id: `feedback-${String(index).padStart(2, '0')}`,
    publishState: 'reserved', claimExpiresAt: NOW
  }))
  const { repository } = repositoryFor({
    node_feedback: [...bad, {
      _id: 'feedback-40', publishState: 'reserved', businessLineId: 'line-1', nodeId: 'node-1',
      claimExpiresAt: NOW
    }]
  })

  assert.deepEqual(await repository.listExpiredFeedbackReservations({ now: NOW, limit: 40 }), [])
  assert.deepEqual(await repository.listExpiredFeedbackReservations({ now: NOW, limit: 40 }), ['feedback-40'])
})

test('损坏的保留游标失败关闭且空候选只执行有限查询', async () => {
  const { repository } = repositoryFor({
    system_settings: [{ _id: 'evidence-retention:feedback-reservations', afterId: 7 }],
    node_feedback: []
  })
  await assert.rejects(
    repository.listExpiredFeedbackReservations({ now: NOW, limit: 40 }),
    /cursor/i
  )
})

test('候选返回后进程崩溃未处理时游标回绕并再次交付同一候选', async () => {
  const { repository } = repositoryFor({
    node_feedback: [{
      _id: 'feedback-crash', businessLineId: 'line-crash', nodeId: 'node-crash',
      publishState: 'aborting'
    }]
  })
  assert.deepEqual(await repository.listExpiredFeedbackReservations({ now: NOW, limit: 40 }), ['feedback-crash'])
  assert.deepEqual(await repository.listExpiredFeedbackReservations({ now: NOW, limit: 40 }), ['feedback-crash'])
})
