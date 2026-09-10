const test = require('node:test')
const assert = require('node:assert/strict')
const { createDashboardWorkspaceService } = require('../lib/dashboard-workspace-service')
const { createReviewService } = require('../lib/review-service')
const { createCloudReviewRepository } = require('../lib/cloud-review-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const actor = { _id: 'reviewer-1', status: 'active' }
const now = new Date('2026-09-10T02:00:00Z')

function seed(count) {
  const data = {
    users: [actor, { _id: 'reviewer-2', status: 'active' }],
    business_lines: [], business_nodes: [], node_review_rounds: [], notifications: []
  }
  for (let i = 0; i < count; i += 1) {
    data.business_lines.push({
      _id: `line-${i}`, status: 'active', currentNodeId: `node-${i}`, currentNodeIndex: 0,
      managerUserIds: ['manager-1'], memberUserIds: ['reviewer-1', 'processor-1'], version: 1
    })
    data.business_nodes.push({
      _id: `node-${i}`, businessLineId: `line-${i}`, sequence: 0, workflowMode: 'review',
      processorUserIds: ['processor-1'], reviewerUserIds: ['reviewer-1'], reviewMode: 'all',
      processingRoundNumber: 1, reviewRoundNumber: 1, version: 2,
      status: 'pending_review', activeReviewRoundId: `round-${i}`
    })
    data.node_review_rounds.push({
      _id: `round-${i}`, businessLineId: `line-${i}`, nodeId: `node-${i}`,
      reviewerUserIds: ['reviewer-1'], reviewMode: 'all', processingRoundNumber: 1,
      reviewRoundNumber: 1, status: 'pending', lockedNodeVersion: 2, createdAt: now
    })
    data.notifications.push({
      _id: `note-${i}`, type: 'review_started', recipientUserIds: ['reviewer-1'],
      readByUserIds: i % 2 === 0 ? ['reviewer-1'] : [], createdAt: now
    })
  }
  return data
}

function harness(data, options) {
  const fake = createFakeCloudDatabase(data, options)
  const reviewRepository = createCloudReviewRepository({ db: fake.db })
  const unexpectedWrite = () => assert.fail('dashboard must remain read-only')
  const reviewService = createReviewService({
    reviewRepository,
    feedbackRepository: {
      getCurrentProcessingRoundDraft: unexpectedWrite,
      getLockedProcessingRoundDraft: unexpectedWrite
    },
    workTimeService: { workingMinutesBetween: unexpectedWrite, tryAddWorkMinutes: unexpectedWrite }
  })
  const workspace = createDashboardWorkspaceService({
    businessService: { async getMyDashboardSummary() { return { stats: {}, recent: [] } } },
    reviewService
  })
  return { fake, reviewService, workspace }
}

for (const count of [50, 51, 60, 100]) {
  test(`dashboard counts ${count} authorized reviews and notifications with one candidate query each`, async () => {
    const { fake, workspace } = harness(seed(count))
    const result = await workspace.getDashboardWorkspace({ actor })
    assert.equal(result.stats.pendingReviews, count)
    assert.equal(result.stats.unreadNotifications, Math.floor(count / 2))
    for (const collection of ['node_review_rounds', 'notifications']) {
      assert.equal(fake.queryCalls.filter(call => call.collection === collection).length, 1,
        `${collection} must not recollect the entire window for page two`)
    }
    assert.equal(fake.transactionRuns.length, count * 4, 'both authorization phases remain')
    assert.equal(fake.writeCalls.length, 0)
  })
}

test('dashboard still revalidates revoked recipients and line relationships before counting', async () => {
  let fake
  let changed = false
  const built = harness(seed(1), {
    afterTransaction() {
      if (changed) return
      changed = true
      const line = fake.documents('business_lines')[0]
      fake.replace('business_lines', line._id, { ...line, memberUserIds: ['reviewer-2'] })
      const note = fake.documents('notifications')[0]
      fake.replace('notifications', note._id, { ...note, recipientUserIds: ['reviewer-2'] })
    }
  })
  fake = built.fake
  const result = await built.workspace.getDashboardWorkspace({ actor })
  assert.equal(result.stats.pendingReviews, 0)
  assert.equal(result.stats.unreadNotifications, 0)
})

test('dashboard windows remain isolated across overlapping accounts and ordinary pages stay capped at 50', async () => {
  const { workspace, reviewService } = harness(seed(51))
  const [one, two] = await Promise.all([
    workspace.getDashboardWorkspace({ actor }),
    workspace.getDashboardWorkspace({ actor: { _id: 'reviewer-2', status: 'active' } })
  ])
  assert.equal(one.stats.pendingReviews, 51)
  assert.equal(two.stats.pendingReviews, 0)
  assert.equal(two.stats.unreadNotifications, 0)
  await assert.rejects(reviewService.listMyPendingReviews({ actor, query: { pageSize: 100 } }),
    { code: 'INVALID_PAGINATION' })
  await assert.rejects(reviewService.listMyNotifications({ actor, query: { pageSize: 100 } }),
    { code: 'INVALID_PAGINATION' })
})
