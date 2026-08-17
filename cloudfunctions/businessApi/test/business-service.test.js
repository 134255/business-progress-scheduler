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
      name: '新业务',
      description: '说明',
      plannedStartDate: '2026-08-08',
      plannedEndDate: '2026-08-12',
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
    { name: 'missing name', actor: { _id: 'user-1', status: 'active' }, input: validInput({ name: ' ' }), code: 'VALIDATION_ERROR' },
    { name: 'invalid request key', actor: { _id: 'user-1', status: 'active' }, input: validInput({ requestKey: 'bad key' }), code: 'VALIDATION_ERROR' },
    { name: 'reversed dates', actor: { _id: 'user-1', status: 'active' }, input: validInput({ plannedStartDate: '2026-08-13' }), code: 'VALIDATION_ERROR' }
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
    metadata: {
      name: '新名称',
      description: '新说明',
      plannedStartDate: '2026-08-08',
      plannedEndDate: '2026-08-12'
    }
  }])

  for (const input of [
    { businessLineId: 'business-1', expectedVersion: 4, name: '名称', code: 'FORGED' },
    { businessLineId: 'business-1', expectedVersion: 0, name: '名称' },
    { businessLineId: 'business-1', expectedVersion: 4, name: ' ', description: '' },
    { businessLineId: 'business-1', expectedVersion: 4, name: '名称', plannedStartDate: '2026-02-30' },
    { businessLineId: 'business-1', expectedVersion: 4, name: '名称', plannedStartDate: '2026-08-13', plannedEndDate: '2026-08-12' }
  ]) {
    await assert.rejects(
      service.updateMetadata({ actor, input }),
      error => error.code === 'VALIDATION_ERROR'
    )
  }
  assert.equal(calls.length, 1)
})
