const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudOperationsRepository } = require('../lib/cloud-operations-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

function harness() {
  const fake = createFakeCloudDatabase({
    users: [
      { _id: 'root', role: 'super_admin', status: 'active', displayName: '当前管理员名' },
      { _id: 'user', role: 'user', status: 'active', displayName: '当前处理人名' }
    ],
    templates: [
      { _id: 'template-1', name: '验收模板', status: 'enabled', version: 2 }
    ],
    business_lines: [
      { _id: 'line-1', code: 'BL-1', name: '业务一', status: 'active', currentNodeId: 'node-1', managerUserIds: ['root'], memberUserIds: ['user'], createdAt: new Date('2026-08-10T00:00:00Z') },
      { _id: 'line-2', code: 'BL-2', name: '业务二', status: 'completed', currentNodeId: 'node-2', managerUserIds: ['root'], memberUserIds: ['root'], createdAt: new Date('2026-08-11T00:00:00Z') },
      { _id: 'line-3', code: 'BL-3', name: '关闭业务', status: 'closed', currentNodeId: 'node-3', createdAt: new Date('2026-08-12T00:00:00Z') },
      { _id: 'line-old', code: 'BL-OLD', name: '旧业务', status: 'completed', createdAt: new Date('2025-01-01T00:00:00Z') }
    ],
    business_nodes: [
      {
        _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-1-N001', sequence: 0,
        name: '处理', status: 'in_progress', workflowMode: 'review', processingDueStatus: 'calculated',
        processorUserIds: ['user'], reviewerUserIds: ['root'], reviewMode: 'any',
        reviewerAssignmentMode: 'business_creator',
        processorDisplayNames: ['创建时处理人'], reviewerDisplayNames: ['创建时审核人'],
        processingRoundNumber: 2, reviewRoundNumber: 1, processingElapsedWorkMinutes: 90,
        processingDueAt: new Date('2026-08-12T00:00:00Z'), processingOverdueWorkMinutes: 5,
        reviewDueStatus: 'not_started'
      },
      {
        _id: 'node-2', businessLineId: 'line-2', nodeCode: 'BL-2-N001', sequence: 0,
        name: '完成', status: 'completed', workflowMode: 'review', processingDueStatus: 'pending_calendar',
        processorUserIds: ['user'], reviewerUserIds: ['root'], reviewMode: 'any',
        processingOverdueWorkMinutes: 0, reviewDueStatus: 'pending_calendar', reviewOverdueWorkMinutes: 2
      }
    ],
    node_review_rounds: [
      {
        _id: 'round-1', businessLineId: 'line-1', nodeId: 'node-1', status: 'pending',
        reviewDueStatus: 'pending_calendar', reviewOverdueWorkMinutes: 3,
        reviewStartedAt: new Date('2026-08-12T02:00:00Z'), processingRoundNumber: 2,
        reviewRoundNumber: 1, submittedByDisplayName: '实际提交人', processorAssignmentMode: 'fixed_accounts',
        reviewerAssignmentMode: 'business_creator', reviewerUserIds: ['root'],
        processingRoundTimingStatus: 'calculated', processingRoundWorkMinutes: 90,
        processingRoundStartedAt: new Date('2026-08-11T01:00:00Z'),
        processingRoundEndedAt: new Date('2026-08-12T02:00:00Z'), processingOverdueWorkMinutes: 5,
        voteCount: 1, approvedVoteCount: 1
      }
    ],
    node_review_votes: [{
      _id: 'vote-1', reviewRoundId: 'round-1', businessLineId: 'line-1', nodeId: 'node-1',
      reviewerUserId: 'root', reviewerDisplayName: '实际审核人', decision: 'approved',
      createdAt: new Date('2026-08-12T03:00:00Z'), reviewResponseTimingStatus: 'calculated',
      reviewResponseWorkMinutes: 60, reviewResponseStartedAt: new Date('2026-08-12T02:00:00Z'),
      reviewResponseEndedAt: new Date('2026-08-12T03:00:00Z')
    }],
    operations_analytics_daily: [
      { _id: 'daily-processing-1', day: '2026-08-12', templateId: 'template-1', templateVersion: 2,
        stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, metric: 'node_processing',
        dimensionRole: 'global', dimensionFilterToken: '', sampleCount: 1, totalMinutes: 40, pendingCount: 0, unrecordedCount: 0 },
      { _id: 'daily-processing-2', day: '2026-08-13', templateId: 'template-1', templateVersion: 2,
        stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, metric: 'node_processing',
        dimensionRole: 'global', dimensionFilterToken: '', sampleCount: 1, totalMinutes: 80, pendingCount: 0, unrecordedCount: 0 },
      { _id: 'daily-review-1', day: '2026-08-12', templateId: 'template-1', templateVersion: 2,
        stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, metric: 'node_review',
        dimensionRole: 'global', dimensionFilterToken: '', sampleCount: 1, totalMinutes: 20, pendingCount: 0, unrecordedCount: 0 },
      { _id: 'daily-business-1', day: '2026-08-13', templateId: 'template-1', templateVersion: 2,
        stableNodeId: '', nodeName: '', nodeSequence: null, metric: 'business_completion',
        dimensionRole: 'global', dimensionFilterToken: '', sampleCount: 1, totalMinutes: 200, pendingCount: 0, unrecordedCount: 0 }
    ],
    operations_analytics_facts: [
      { _id: 'fact-processing-1', day: '2026-08-12', templateId: 'template-1', templateVersion: 2,
        stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, businessLineId: 'line-1',
        metric: 'node_processing', dimensionRole: 'global', dimensionFilterToken: '', timingStatus: 'calculated', workMinutes: 40 },
      { _id: 'fact-processing-2', day: '2026-08-13', templateId: 'template-1', templateVersion: 2,
        stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, businessLineId: 'line-2',
        metric: 'node_processing', dimensionRole: 'global', dimensionFilterToken: '', timingStatus: 'calculated', workMinutes: 80 },
      { _id: 'fact-review-1', day: '2026-08-12', templateId: 'template-1', templateVersion: 2,
        stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, businessLineId: 'line-1',
        metric: 'node_review', dimensionRole: 'global', dimensionFilterToken: '', timingStatus: 'calculated', workMinutes: 20 },
      { _id: 'fact-business-1', day: '2026-08-13', templateId: 'template-1', templateVersion: 2,
        stableNodeId: '', nodeName: '', nodeSequence: null, businessLineId: 'line-2',
        metric: 'business_completion', dimensionRole: 'global', dimensionFilterToken: '', timingStatus: 'calculated', workMinutes: 200 },
      { _id: 'fact-person-1', day: '2026-08-12', templateId: 'template-1', templateVersion: 2,
        stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, businessLineId: 'line-1',
        metric: 'node_processing', dimensionRole: 'processor', dimensionFilterToken: 'a'.repeat(64),
        dimensionUserId: 'user', dimensionDisplayName: '当前处理人名', timingStatus: 'calculated', workMinutes: 40 }
    ]
  })
  return { fake, repository: createCloudOperationsRepository({ db: fake.db }) }
}

test('运营仓储统计权威状态并以稳定游标返回脱敏节点行', async () => {
  const { repository } = harness()
  const actor = { _id: 'root', role: 'super_admin', status: 'active' }
  const range = {
    startAt: new Date('2026-08-01T16:00:00Z'), endAt: new Date('2026-08-18T16:00:00Z'),
    cursor: '', pageSize: 1
  }
  const dashboard = await repository.getDashboard({ actor, range })
  assert.deepEqual(dashboard.stats, {
    businesses: 3, active: 1, completed: 1, frozen: 1, pendingProcessing: 1, pendingReview: 1,
    overdueProcessing: 1, overdueReview: 1, pendingCalendar: 2
  })
  const first = await repository.exportRows({ actor, range })
  assert.equal(first.items.length, 1)
  assert.equal(first.hasMore, true)
  assert.equal(JSON.stringify(first).includes('root'), false)
  const second = await repository.exportRows({ actor, range: { ...range, cursor: first.nextCursor } })
  assert.equal(second.items.length, 1)
  assert.notEqual(second.items[0].businessCode, first.items[0].businessCode)
  const activeRow = [...first.items, ...second.items].find(item => item.businessCode === 'BL-1')
  assert.equal(activeRow.processingRoundNumber, 2)
  assert.equal(activeRow.reviewRoundNumber, 1)
  assert.equal(activeRow.processorDisplayNames, '创建时处理人')
  assert.equal(activeRow.reviewerDisplayNames, '创建时审核人')

  const completedOnly = await repository.exportRows({ actor, range: { ...range, status: 'completed', pageSize: 50 } })
  assert.deepEqual(completedOnly.items.map(item => item.businessCode), ['BL-2'])
})

test('运营仓储按审核开始时间稳定分页返回实际提交人与实际投票人工时', async () => {
  const { repository } = harness()
  const actor = { _id: 'root', role: 'super_admin', status: 'active' }
  const range = {
    startDate: '2026-08-01', endDate: '2026-08-17', status: '',
    startAt: new Date('2026-07-31T16:00:00Z'), endAt: new Date('2026-08-17T16:00:00Z'),
    cursor: '', pageSize: 1
  }
  const page = await repository.listTimingDetails({ actor, range })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].submittedByDisplayName, '实际提交人')
  assert.equal(page.items[0].processingTiming.workMinutes, 90)
  assert.deepEqual(page.items[0].votes.map(vote => [vote.reviewerDisplayName, vote.responseTiming.workMinutes]),
    [['实际审核人', 60]])
  assert.equal(JSON.stringify(page).includes('reviewerUserId'), false)
  assert.equal(JSON.stringify(page).includes('businessLineId'), false)
  assert.equal(JSON.stringify(page).includes('reviewerAssignmentMode'), false)
})

test('运营工时明细原始窗口越过损坏关联并在返回前再次复核管理员与业务状态', async () => {
  const { fake, repository } = harness()
  for (let index = 0; index < 21; index += 1) {
    fake.replace('node_review_rounds', `bad-${String(index).padStart(2, '0')}`, {
      _id: `bad-${String(index).padStart(2, '0')}`, businessLineId: 'missing-line', nodeId: 'missing-node',
      reviewStartedAt: new Date(`2026-08-13T${String(index).padStart(2, '0')}:00:00Z`)
    })
  }
  const actor = { _id: 'root', role: 'super_admin', status: 'active' }
  const range = {
    startDate: '2026-08-01', endDate: '2026-08-17', status: '',
    startAt: new Date('2026-07-31T16:00:00Z'), endAt: new Date('2026-08-17T16:00:00Z'),
    cursor: '', pageSize: 20
  }
  const page = await repository.listTimingDetails({ actor, range })
  assert.deepEqual(page.items.map(item => item.roundId), ['round-1'])
  assert.notEqual(page.nextCursor, '')

  fake.beforeNextTransaction(() => fake.replace('users', 'root', { role: 'user', status: 'active' }))
  await assert.rejects(repository.listTimingDetails({ actor, range }), error => error.code === 'FORBIDDEN')
})

test('运营仓储在查询前后都复核超级管理员状态', async () => {
  const { fake, repository } = harness()
  fake.beforeNextTransaction(() => fake.replace('users', 'root', { role: 'user', status: 'active' }))
  await assert.rejects(
    repository.getDashboard({
      actor: { _id: 'root', role: 'super_admin', status: 'active' },
      range: { startAt: new Date('2026-08-01'), endAt: new Date('2026-09-01'), cursor: '', pageSize: 20 }
    }),
    error => error.code === 'FORBIDDEN'
  )
})

test('所有活动用户可读取全局历史统计且响应不泄漏账号标识', async () => {
  const { repository } = harness()
  const actor = { _id: 'user', role: 'user', status: 'active' }
  const range = {
    startDate: '2026-08-01', endDate: '2026-08-19', grain: 'week', templateId: 'template-1',
    templateVersion: null, status: '', businessLineId: '', stableNodeId: '', processorToken: '', reviewerToken: '',
    metric: '', cursor: '', pageSize: 20
  }
  const filters = await repository.getAnalyticsFilters({ actor, range })
  assert.deepEqual(filters.templates, [{ templateId: 'template-1', templateName: '验收模板' }])
  assert.equal(filters.processors[0].token, 'a'.repeat(64))
  assert.equal(JSON.stringify(filters).includes('user'), false)

  const summary = await repository.getAnalyticsSummary({ actor, range })
  assert.equal(summary.nodeSeries[0].processing.averageMinutes, 60)
  assert.equal(summary.nodeSeries[0].review.averageMinutes, 20)
  assert.equal(summary.templateMetrics.businessCompletion.averageMinutes, 200)
  assert.equal(Object.hasOwn(summary.trendSeries[0], 'processing'), true)
  assert.equal(Object.hasOwn(summary.trendSeries[0], 'review'), true)
  assert.equal(JSON.stringify(summary).includes('businessLineId'), false)
})

test('普通用户筛选项在返回业务名称前逐项重新校验当前关系', async () => {
  const { fake, repository } = harness()
  fake.beforeNextTransaction(() => fake.replace('business_lines', 'line-1', {
    _id: 'line-1', code: 'BL-1', name: '业务一', status: 'active',
    managerUserIds: ['root'], memberUserIds: ['root']
  }))
  const filters = await repository.getAnalyticsFilters({
    actor: { _id: 'user', role: 'user', status: 'active' },
    range: {
      startDate: '2026-08-01', endDate: '2026-08-19', grain: 'week', templateId: 'template-1',
      templateVersion: null, status: '', businessLineId: '', stableNodeId: '',
      processorToken: '', reviewerToken: '', metric: '', cursor: '', pageSize: 20
    }
  })
  assert.deepEqual(filters.businesses, [])
})

test('普通用户下钻只返回原有权限业务且保留全局样本差异提示', async () => {
  const { repository } = harness()
  const range = {
    startDate: '2026-08-01', endDate: '2026-08-19', grain: 'week', templateId: 'template-1',
    templateVersion: null, status: '', businessLineId: '', stableNodeId: 'stable-1',
    processorToken: '', reviewerToken: '', metric: 'node_processing', cursor: '', pageSize: 20
  }
  const ordinary = await repository.listAnalyticsSamples({ actor: { _id: 'user', role: 'user', status: 'active' }, range })
  assert.equal(ordinary.globalSampleCount, 2)
  assert.equal(ordinary.visibleSampleCount, 1)
  assert.equal(ordinary.items[0].businessCode, 'BL-1')
  assert.equal(JSON.stringify(ordinary).includes('line-1'), false)
  assert.equal(ordinary.visibilityNotice.length > 0, true)
  assert.equal(Array.isArray(ordinary.items[0].rounds), true)

  const admin = await repository.listAnalyticsSamples({ actor: { _id: 'root', role: 'super_admin', status: 'active' }, range })
  assert.equal(admin.visibleSampleCount, 2)
  assert.equal(admin.statistics.medianMinutes, 60)
  await assert.rejects(repository.listAnalyticsSamples({
    actor: { _id: 'root', role: 'super_admin', status: 'active' },
    range: { ...range, stableNodeId: 'different-node', cursor: admin.nextCursor }
  }), error => error.code === 'VALIDATION_ERROR')

  const unauthorizedBusinessRange = { ...range, businessLineId: 'line-2' }
  await assert.rejects(repository.getAnalyticsSummary({
    actor: { _id: 'user', role: 'user', status: 'active' }, range: unauthorizedBusinessRange
  }), error => error.code === 'FORBIDDEN')
  await assert.rejects(repository.listAnalyticsSamples({
    actor: { _id: 'user', role: 'user', status: 'active' }, range: unauthorizedBusinessRange
  }), error => error.code === 'FORBIDDEN')
})

test('统计明细保留待补算与历史未记录计数，并在返回每条业务前重新鉴权', async () => {
  const { fake, repository } = harness()
  fake.replace('operations_analytics_facts', 'fact-pending', {
    _id: 'fact-pending', day: '2026-08-14', templateId: 'template-1', templateVersion: 2,
    stableNodeId: 'stable-1', nodeName: '节点一', nodeSequence: 0, businessLineId: 'line-1', nodeId: 'node-1',
    metric: 'node_processing', dimensionRole: 'global', dimensionFilterToken: '',
    timingStatus: 'pending_calendar', workMinutes: null
  })
  fake.replace('operations_analytics_facts', 'fact-unrecorded', {
    _id: 'fact-unrecorded', day: '2026-08-15', templateId: 'template-1', templateVersion: 2,
    stableNodeId: 'stable-1', nodeName: '节点一', nodeSequence: 0, businessLineId: 'line-1', nodeId: 'node-1',
    metric: 'node_processing', dimensionRole: 'global', dimensionFilterToken: '',
    timingStatus: 'historical_unrecorded', workMinutes: null
  })
  const range = {
    startDate: '2026-08-01', endDate: '2026-08-19', grain: 'week', templateId: 'template-1',
    templateVersion: null, status: '', businessLineId: '', stableNodeId: 'stable-1',
    processorToken: '', reviewerToken: '', metric: 'node_processing', cursor: '', pageSize: 20
  }
  const first = await repository.listAnalyticsSamples({ actor: { _id: 'user', role: 'user', status: 'active' }, range })
  assert.equal(first.globalSampleCount, 2)
  assert.equal(first.statistics.pendingCount, 1)
  assert.equal(first.statistics.unrecordedCount, 1)

  fake.beforeNextTransaction(() => fake.replace('business_lines', 'line-1', {
    _id: 'line-1', code: 'BL-1', name: '业务一', status: 'active',
    managerUserIds: ['root'], memberUserIds: ['root']
  }))
  const revoked = await repository.listAnalyticsSamples({ actor: { _id: 'user', role: 'user', status: 'active' }, range })
  assert.equal(revoked.items.length, 0)
})

test('新看板事实与汇总跨页时不使用 skip 分页', async () => {
  const { fake, repository } = harness()
  for (let index = 0; index < 101; index += 1) {
    fake.replace('operations_analytics_daily', `daily-extra-${String(index).padStart(3, '0')}`, {
      _id: `daily-extra-${String(index).padStart(3, '0')}`,
      day: '2026-08-14', templateId: 'template-1', templateVersion: 2,
      stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0,
      metric: 'node_processing', dimensionRole: 'global', dimensionFilterToken: '',
      sampleCount: 1, totalMinutes: 1, pendingCount: 0, unrecordedCount: 0
    })
  }
  await repository.getAnalyticsSummary({
    actor: { _id: 'user', role: 'user', status: 'active' },
    range: {
      startDate: '2026-08-01', endDate: '2026-08-19', grain: 'week', templateId: 'template-1',
      templateVersion: null, status: '', businessLineId: '', stableNodeId: '',
      processorToken: '', reviewerToken: '', metric: '', cursor: '', pageSize: 20
    }
  })
  const analyticsQueries = fake.queryCalls.filter(call =>
    ['operations_analytics_daily', 'operations_analytics_facts'].includes(call.collection))
  assert.equal(analyticsQueries.some(call => call.offset > 0), false)
})

test('事实分钟累计超过安全整数时失败关闭', async () => {
  const { fake, repository } = harness()
  fake.replace('operations_analytics_facts', 'fact-processing-1', {
    _id: 'fact-processing-1', day: '2026-08-12', templateId: 'template-1', templateVersion: 2,
    stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, businessLineId: 'line-1',
    metric: 'node_processing', dimensionRole: 'global', dimensionFilterToken: '',
    timingStatus: 'calculated', workMinutes: Number.MAX_SAFE_INTEGER
  })
  fake.replace('operations_analytics_facts', 'fact-overflow', {
    _id: 'fact-overflow', day: '2026-08-13', templateId: 'template-1', templateVersion: 2,
    stableNodeId: 'stable-1', nodeName: '资料处理', nodeSequence: 0, businessLineId: 'line-1',
    metric: 'node_processing', dimensionRole: 'global', dimensionFilterToken: '',
    timingStatus: 'calculated', workMinutes: 1
  })
  await assert.rejects(repository.getAnalyticsSummary({
    actor: { _id: 'user', role: 'user', status: 'active' },
    range: {
      startDate: '2026-08-01', endDate: '2026-08-19', grain: 'week', templateId: 'template-1',
      templateVersion: null, status: '', businessLineId: 'line-1', stableNodeId: 'stable-1',
      processorToken: '', reviewerToken: '', metric: '', cursor: '', pageSize: 20
    }
  }), error => error.code === 'VALIDATION_ERROR')
})
