async function listAtMostTwoPages(method, actor) {
  const items = []
  for (let page = 1; page <= 2; page += 1) {
    const result = await method({ actor, query: { page, pageSize: 50 } })
    items.push(...(Array.isArray(result && result.items) ? result.items : []))
    if (!result || !result.hasMore) break
  }
  return items
}

function createDashboardWorkspaceService({ businessService, reviewService }) {
  if (!businessService || typeof businessService.getMyDashboardSummary !== 'function') {
    throw new TypeError('businessService.getMyDashboardSummary is required')
  }
  if (!reviewService || typeof reviewService.listMyPendingReviews !== 'function' ||
      typeof reviewService.listMyNotifications !== 'function') {
    throw new TypeError('reviewService dashboard reads are required')
  }

  async function getDashboardWorkspace({ actor }) {
    const [summary, pendingReviews, notifications] = await Promise.all([
      businessService.getMyDashboardSummary({ actor }),
      listAtMostTwoPages(input => reviewService.listMyPendingReviews(input), actor),
      listAtMostTwoPages(input => reviewService.listMyNotifications(input), actor)
    ])
    const stats = summary && summary.stats || {}
    return {
      stats: {
        active: Number(stats.active || 0),
        pendingMine: Number(stats.pendingProcessing || 0),
        pendingMineAvailable: true,
        pendingReviews: pendingReviews.length,
        unreadNotifications: notifications.filter(item => !item.read).length,
        completed: Number(stats.completed || 0),
        complete: summary && summary.complete !== false
      },
      recent: Array.isArray(summary && summary.recent) ? summary.recent : []
    }
  }

  return { getDashboardWorkspace }
}

module.exports = { createDashboardWorkspaceService }
