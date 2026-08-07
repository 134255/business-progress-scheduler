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
    definition: businessTemplate()
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

test('repository assignee revalidation failures remain closed application errors', async () => {
  const failure = new Error('ASSIGNEE_INACTIVE')
  failure.code = 'ASSIGNEE_INACTIVE'
  const harness = createBusinessHarness({ createError: failure })

  await assert.rejects(
    harness.service.createFromTemplate({ actor: harness.actor, input: validInput() }),
    error => error.code === 'ASSIGNEE_INACTIVE'
  )
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
