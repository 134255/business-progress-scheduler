const test = require('node:test')
const assert = require('node:assert/strict')

const { createDashboardWorkspaceService } = require('../lib/dashboard-workspace-service')

function deferred() {
  let resolve
  const promise = new Promise(onResolve => { resolve = onResolve })
  return { promise, resolve }
}

test('dashboard workspace starts independent reads in parallel and returns a safe projection', async () => {
  const summary = deferred()
  const reviews = deferred()
  const notifications = deferred()
  const calls = []
  const actor = { _id: 'account-1', status: 'active' }
  const service = createDashboardWorkspaceService({
    businessService: {
      getMyDashboardSummary(input) {
        calls.push(['summary', input])
        return summary.promise
      }
    },
    reviewService: {
      listMyPendingReviews(input) {
        calls.push(['reviews', input])
        return reviews.promise
      },
      listMyNotifications(input) {
        calls.push(['notifications', input])
        return notifications.promise
      }
    }
  })

  const pending = service.getDashboardWorkspace({ actor })
  assert.deepEqual(calls.map(([name]) => name), ['summary', 'reviews', 'notifications'])
  summary.resolve({
    stats: { active: 2, pendingProcessing: 3, completed: 4 },
    recent: [{ _id: 'line-1', secret: 'not-projected-separately' }],
    complete: true
  })
  reviews.resolve({ items: [{ reviewRoundId: 'round-1' }], hasMore: false })
  notifications.resolve({
    items: [{ notificationId: 'note-1', read: false }, { notificationId: 'note-2', read: true }],
    hasMore: false
  })

  assert.deepEqual(await pending, {
    stats: {
      active: 2,
      pendingMine: 3,
      pendingMineAvailable: true,
      pendingReviews: 1,
      unreadNotifications: 1,
      completed: 4,
      complete: true
    },
    recent: [{ _id: 'line-1', secret: 'not-projected-separately' }]
  })
  assert.deepEqual(calls, [
    ['summary', { actor }],
    ['reviews', { actor, query: { page: 1, pageSize: 50 } }],
    ['notifications', { actor, query: { page: 1, pageSize: 50 } }]
  ])
})

test('dashboard workspace follows at most two pages for counts', async () => {
  const calls = []
  const actor = { _id: 'account-1', status: 'active' }
  const service = createDashboardWorkspaceService({
    businessService: {
      async getMyDashboardSummary() { return { stats: {}, recent: [], complete: false } }
    },
    reviewService: {
      async listMyPendingReviews({ query }) {
        calls.push(['reviews', query.page])
        return { items: [{ reviewRoundId: `round-${query.page}` }], hasMore: query.page === 1 }
      },
      async listMyNotifications({ query }) {
        calls.push(['notifications', query.page])
        return { items: [{ notificationId: `note-${query.page}`, read: query.page === 2 }], hasMore: query.page === 1 }
      }
    }
  })

  const result = await service.getDashboardWorkspace({ actor })
  assert.equal(result.stats.pendingReviews, 2)
  assert.equal(result.stats.unreadNotifications, 1)
  assert.deepEqual(calls, [
    ['reviews', 1], ['notifications', 1], ['reviews', 2], ['notifications', 2]
  ])
})
