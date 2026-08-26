const test = require('node:test')
const assert = require('node:assert/strict')

const { businessTemplate, createBusinessHarness } = require('./helpers/business-harness')

function validInput(overrides = {}) {
  return {
    templateId: 'template-1',
    name: '  新业务  ',
    description: '  说明  ',
    plannedStartDate: '2026-08-08',
    plannedEndDate: '2026-08-12',
    requestKey: 'request-001',
    ...overrides
  }
}

test('creation accepts only validated template-backed metadata and returns generated identity', async () => {
  const harness = createBusinessHarness()
  const result = await harness.service.createFromTemplate({
    actor: harness.actor,
    input: validInput({ code: 'CLIENT-CODE', nodes: [{ name: '客户端节点' }] })
  })

  assert.deepEqual(result, { id: 'business-1', code: 'BL-20260807-0001' })
  assert.equal(harness.workTimeCalls.length, 1)
  assert.equal(harness.workTimeCalls[0][0].toISOString(), '2026-08-07T02:30:00.000Z')
  assert.equal(harness.workTimeCalls[0][1], 8 * 60)
  assert.deepEqual(harness.calls[2], ['createBusinessSnapshot', {
    actor: harness.actor,
    input: {
      templateId: 'template-1',
      description: '说明',
      requestKey: 'request-001'
    },
    definition: businessTemplate(),
    firstProcessingDue: {
      processingStartedAt: new Date('2026-08-07T02:30:00.000Z'),
      processingDueStatus: 'calculated',
      processingDueAt: new Date('2026-08-07T10:30:00.000Z'),
      processingCalendarVersion: 'calendar-v1',
      calendarNotificationStatus: 'not_required'
    }
  }])
})

test('creation ignores legacy caller names and planned dates before reserving the snapshot', async () => {
  const harness = createBusinessHarness()

  await harness.service.createFromTemplate({
    actor: harness.actor,
    input: validInput({
      name: '客户端旧名称',
      plannedStartDate: '2099-01-01',
      plannedEndDate: '2099-12-31'
    })
  })

  const snapshotCall = harness.calls.find(call => call[0] === 'createBusinessSnapshot')
  assert.deepEqual(snapshotCall[1].input, {
    templateId: 'template-1',
    description: '说明',
    requestKey: 'request-001'
  })
})

test('ordinary metadata updates can change only the description', async () => {
  const calls = []
  const { createBusinessService } = require('../lib/business-service')
  const service = createBusinessService({
    repository: {
      async updateBusinessMetadata(input) {
        calls.push(input)
        return { id: input.lineId, version: input.expectedVersion + 1 }
      }
    },
    clock: () => new Date(),
    workTimeService: { async tryAddWorkMinutes() { throw new Error('not used') } }
  })
  const actor = { _id: 'user-1', status: 'active' }

  await service.updateMetadata({
    actor,
    input: {
      businessLineId: 'business-1',
      expectedVersion: 4,
      description: ' 新说明 ',
      name: '旧客户端试图改名',
      plannedStartDate: '2099-01-01',
      plannedEndDate: '2099-12-31'
    }
  })

  assert.deepEqual(calls, [{
    actor,
    lineId: 'business-1',
    expectedVersion: 4,
    metadata: { description: '新说明' }
  }])
})

test('creation forwards a business creator reviewer policy unchanged for repository snapshot resolution', async () => {
  const definition = businessTemplate()
  definition.nodes[1].reviewerAssignmentMode = 'business_creator'
  definition.nodes[1].reviewerUserIds = []
  const harness = createBusinessHarness({ definition })

  await harness.service.createFromTemplate({ actor: harness.actor, input: validInput() })

  const snapshotCall = harness.calls.find(call => call[0] === 'createBusinessSnapshot')
  assert.equal(snapshotCall[1].definition.nodes[1].reviewerAssignmentMode, 'business_creator')
  assert.deepEqual(snapshotCall[1].definition.nodes[1].reviewerUserIds, [])
})

test('an idempotent retry returns its reservation without requiring the template to remain enabled', async () => {
  const harness = createBusinessHarness({
    definition: null,
    existing: { id: 'business-existing', code: 'BL-20260807-0042' }
  })
  const result = await harness.service.createFromTemplate({ actor: harness.actor, input: validInput() })

  assert.deepEqual(result, { id: 'business-existing', code: 'BL-20260807-0042' })
  assert.deepEqual(harness.calls.map(call => call[0]), ['findCreationResult'])
  assert.equal(harness.workTimeCalls.length, 0)
})

test('创建与幂等重试在公开返回前同步检索且索引失败不重复写权威仓储', async () => {
  const { createBusinessService } = require('../lib/business-service')
  const envelope = { actorId: 'user-1', businessLineId: 'business-1', sourceVersion: 1 }
  const stored = { id: 'business-1', code: 'BL-20260807-0001' }
  Object.defineProperties(stored, {
    searchEnvelope: { value: envelope },
    publicResult: { value: stored }
  })
  let createCalls = 0
  const indexCalls = []
  const repository = {
    async findCreationResult() { return null },
    async getTemplateDefinition() { return businessTemplate() },
    async createBusinessSnapshot() { createCalls += 1; return stored }
  }
  const service = createBusinessService({
    repository,
    workTimeService: { async tryAddWorkMinutes(at) {
      return { status: 'calculated', dueAt: new Date(at.getTime() + 60_000), calendarVersion: 'v1' }
    } },
    clock: () => new Date('2026-08-07T02:30:00Z'),
    businessSearchClient: { async ensureIndexed(value) { indexCalls.push(value) } }
  })

  assert.equal(await service.createFromTemplate({ actor: { _id: 'user-1', status: 'active' }, input: validInput() }), stored)
  assert.equal(createCalls, 1)
  assert.deepEqual(indexCalls, [envelope])

  const failed = createBusinessService({
    repository: { ...repository, async findCreationResult() { return stored } },
    workTimeService: { async tryAddWorkMinutes() { throw new Error('not used') } },
    businessSearchClient: { async ensureIndexed() { throw new Error('timeout') } }
  })
  await assert.rejects(
    failed.createFromTemplate({ actor: { _id: 'user-1', status: 'active' }, input: validInput() }),
    error => error.code === 'BUSINESS_SEARCH_PENDING'
  )
  assert.equal(createCalls, 1)
})

test('calendar gaps become a safe pending first-node timing instead of blocking business creation', async () => {
  const harness = createBusinessHarness({
    dueResult: { status: 'pending_calendar', dueAt: null, missingDate: '2026-08-07' }
  })

  await harness.service.createFromTemplate({ actor: harness.actor, input: validInput() })

  assert.deepEqual(harness.calls[2][1].firstProcessingDue, {
    processingStartedAt: new Date('2026-08-07T02:30:00.000Z'),
    processingDueStatus: 'pending_calendar',
    processingDueAt: null,
    calendarNotificationStatus: 'pending'
  })
})

test('legacy enabled templates remain compatible only when no node declares the review workflow', async () => {
  const harness = createBusinessHarness({
    definition: businessTemplate({
      nodes: businessTemplate().nodes.map(node => {
        const {
          workflowMode, processorUserIds, reviewerUserIds, reviewMode,
          processingSlaWorkHours, reviewSlaWorkHours, ...legacy
        } = node
        return { ...legacy, assigneeUserIds: ['user-2'], slaWorkHours: 8 }
      })
    })
  })

  await assert.doesNotReject(harness.service.createFromTemplate({ actor: harness.actor, input: validInput() }))
})

test('a declared review workflow cannot fall back to legacy assignees', async () => {
  const harness = createBusinessHarness({
    definition: businessTemplate({
      nodes: [
        {
          ...businessTemplate().nodes[0],
          processorUserIds: undefined,
          reviewerUserIds: undefined,
          assigneeUserIds: ['user-2']
        }
      ],
      template: { nodeCount: 1 }
    })
  })

  await assert.rejects(
    harness.service.createFromTemplate({ actor: harness.actor, input: validInput() }),
    error => error.code === 'TEMPLATE_INVALID'
  )
})

test('creation rejects unavailable templates and invalid account or request metadata', async t => {
  await t.test('template is not enabled', async () => {
    const harness = createBusinessHarness({
      definition: businessTemplate({ template: { status: 'disabled' } })
    })
    await assert.rejects(
      harness.service.createFromTemplate({ actor: harness.actor, input: validInput() }),
      error => error.code === 'TEMPLATE_NOT_ENABLED'
    )
  })

  for (const item of [
    { name: 'inactive actor', actor: { _id: 'user-1', status: 'disabled' }, input: validInput(), code: 'FORBIDDEN' },
    { name: 'missing template', actor: { _id: 'user-1', status: 'active' }, input: validInput({ templateId: ' ' }), code: 'VALIDATION_ERROR' },
    { name: 'invalid request key', actor: { _id: 'user-1', status: 'active' }, input: validInput({ requestKey: 'bad key' }), code: 'VALIDATION_ERROR' },
  ]) {
    await t.test(item.name, async () => {
      const harness = createBusinessHarness()
      await assert.rejects(
        harness.service.createFromTemplate({ actor: item.actor, input: item.input }),
        error => error.code === item.code
      )
    })
  }
})

test('repository processor and reviewer revalidation failures remain closed application errors', async () => {
  for (const code of ['PROCESSOR_INACTIVE', 'REVIEWER_INACTIVE']) {
    const failure = new Error(code)
    failure.code = code
    const harness = createBusinessHarness({ createError: failure })

    await assert.rejects(
      harness.service.createFromTemplate({ actor: harness.actor, input: validInput() }),
      error => error.code === code
    )
  }
})

test('business reads use the trusted account actor and validated identifiers', async () => {
  const harness = createBusinessHarness()
  await harness.service.listBusinessLines({ actor: harness.actor, query: { page: 2, pageSize: 10 } })
  await harness.service.getBusinessLine({ actor: harness.actor, lineId: 'business-1' })

  assert.deepEqual(harness.calls, [
    ['listBusinessLines', { actor: harness.actor, query: { page: 2, pageSize: 10 } }],
    ['getBusinessLine', { actor: harness.actor, lineId: 'business-1' }]
  ])
  await assert.rejects(
    harness.service.getBusinessLine({ actor: harness.actor, lineId: ' ' }),
    error => error.code === 'VALIDATION_ERROR'
  )
})

test('待处理与概览查询只接受受信活动账号和严格分页参数', async () => {
  const harness = createBusinessHarness()
  await harness.service.listMyPendingProcessing({
    actor: harness.actor,
    query: { cursor: '', pageSize: 20 }
  })
  await harness.service.getMyDashboardSummary({ actor: harness.actor })

  assert.deepEqual(harness.calls.slice(-2), [
    ['listMyPendingProcessing', { actor: harness.actor, query: { cursor: '', pageSize: 20 } }],
    ['getMyBusinessSummary', { actor: harness.actor }]
  ])
  await assert.rejects(
    harness.service.listMyPendingProcessing({ actor: harness.actor, query: { pageSize: 1000 } }),
    error => error.code === 'VALIDATION_ERROR'
  )
})

test('metadata update accepts only normalized metadata and an expected version', async () => {
  const calls = []
  const repository = {
    async updateBusinessMetadata(input) {
      calls.push(input)
      return { id: input.lineId, version: input.expectedVersion + 1 }
    }
  }
  const { createBusinessService } = require('../lib/business-service')
  const service = createBusinessService({
    repository,
    clock: () => new Date(),
    workTimeService: { async tryAddWorkMinutes() { throw new Error('not used') } }
  })
  const actor = { _id: 'user-1', status: 'active' }

  const result = await service.updateMetadata({
    actor,
    input: {
      businessLineId: ' business-1 ',
      expectedVersion: 4,
      name: ' 新名称 ',
      description: ' 新说明 ',
      plannedStartDate: '2026-08-08',
      plannedEndDate: '2026-08-12'
    }
  })

  assert.deepEqual(result, { id: 'business-1', version: 5 })
  assert.deepEqual(calls, [{
    actor,
    lineId: 'business-1',
    expectedVersion: 4,
    metadata: { description: '新说明' }
  }])

  for (const input of [
    { businessLineId: 'business-1', expectedVersion: 4, name: '名称', code: 'FORGED' },
    { businessLineId: 'business-1', expectedVersion: 0, name: '名称' },
    { businessLineId: ' ', expectedVersion: 4, description: '' }
  ]) {
    await assert.rejects(
      service.updateMetadata({ actor, input }),
      error => error.code === 'VALIDATION_ERROR'
    )
  }
  assert.equal(calls.length, 1)
})

test('非空关键词仅委托受保护检索客户端并剥离未知输入', async () => {
  const searchCalls = []
  const harness = createBusinessHarness({
    businessSearchClient: {
      async query(input) {
        searchCalls.push(input)
        return {
          items: [{
            _id: 'business-1', code: 'BL-1', name: '售后甲', status: 'active',
            currentNodeName: '资料收集',
            matches: [{ nodeName: '资料收集', label: '客户名称', excerpt: '命中客户甲' }],
            secret: '不得返回'
          }],
          cursor: 'cursor-1', hasMore: true, internal: '不得返回'
        }
      }
    }
  })

  const result = await harness.service.listBusinessLines({
    actor: harness.actor,
    query: { keyword: '  客户甲  合同  ', pageSize: 10, cursor: '' }
  })

  assert.deepEqual(searchCalls, [{
    actorId: 'user-1',
    query: { keyword: '客户甲 合同', pageSize: 10, cursor: '' }
  }])
  assert.deepEqual(result, {
    items: [{
      _id: 'business-1', code: 'BL-1', name: '售后甲', status: 'active',
      currentNodeName: '资料收集',
      matches: [{ nodeName: '资料收集', label: '客户名称', excerpt: '命中客户甲' }]
    }],
    cursor: 'cursor-1', hasMore: true, total: null
  })
  assert.equal(harness.calls.some(call => call[0] === 'listBusinessLines'), false)
})

test('售后列表严格校验关键词、日期和分页输入', async () => {
  const harness = createBusinessHarness({ businessSearchClient: { async query() { return { items: [] } } } })
  for (const query of [
    { unknown: true },
    { keyword: 42 },
    { keyword: '一 二 三 四 五 六' },
    { keyword: '甲'.repeat(101) },
    { keyword: '客户', pageSize: 21 },
    { keyword: '客户', cursor: 1 },
    { startDate: '2026-02-30' },
    { startDate: '2026-08-02', endDate: '2026-08-01' }
  ]) {
    await assert.rejects(
      harness.service.listBusinessLines({ actor: harness.actor, query }),
      error => error.code === 'VALIDATION_ERROR'
    )
  }
})

test('元数据修改成功后同步检索并剥离内部信封', async () => {
  const { createBusinessService } = require('../lib/business-service')
  const envelope = { actorId: 'user-1', businessLineId: 'business-1', sourceVersion: 2 }
  const publicResult = { id: 'business-1', version: 5 }
  const stored = { publicResult, searchEnvelope: envelope }
  const calls = []
  const service = createBusinessService({
    repository: { async updateBusinessMetadata() { return stored } },
    workTimeService: { async tryAddWorkMinutes() { throw new Error('not used') } },
    businessSearchClient: { async ensureIndexed(value) { calls.push(value) } }
  })
  const result = await service.updateMetadata({
    actor: { _id: 'user-1', status: 'active' },
    input: { businessLineId: 'business-1', expectedVersion: 4, name: '新名称' }
  })
  assert.deepEqual(result, publicResult)
  assert.deepEqual(calls, [envelope])
})
