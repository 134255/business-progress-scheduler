const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudBusinessRepository } = require('../lib/cloud-business-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createOptimisticBusinessDatabase } = require('./helpers/business-harness')

function sourceNode(overrides = {}) {
  return {
    _id: 'template-node-1',
    templateId: 'template-1',
    nodeKey: 'node-a',
    sequence: 0,
    name: '启动',
    description: '启动说明',
    workflowMode: 'review',
    processorUserIds: ['user-2'],
    reviewerUserIds: ['user-3'],
    reviewMode: 'any',
    processingSlaWorkHours: 8,
    reviewSlaWorkHours: 4,
    requiresEvidence: false,
    allowedEvidenceTypes: ['pdf'],
    fields: [{
      fieldKey: 'field-a', sequence: 0, name: '摘要', description: '',
      type: 'short_text', required: true, constraints: { maxLength: 100 }
    }],
    ...overrides
  }
}

function seedDefinition(overrides = {}) {
  const nodes = overrides.nodes || [
    sourceNode(),
    sourceNode({
      _id: 'template-node-2', nodeKey: 'node-b', sequence: 1, name: '交付',
      processorUserIds: ['user-3'], reviewerUserIds: ['user-4'], reviewMode: 'all',
      processingSlaWorkHours: 22, reviewSlaWorkHours: 8, requiresEvidence: true,
      allowedEvidenceTypes: ['pdf', 'mp4']
    })
  ]
  return {
    users: overrides.users || [
      { _id: 'user-1', status: 'active', displayName: '用户一' },
      { _id: 'user-2', status: 'active', displayName: '用户二' },
      { _id: 'user-3', status: 'active', displayName: '用户三' },
      { _id: 'user-4', status: 'active', displayName: '用户四' }
    ],
    templates: [{
      _id: 'template-1', name: '交付模板', status: 'enabled', version: 4,
      nodeCount: nodes.length
    }],
    template_nodes: nodes,
    ...(overrides.extra || {})
  }
}

function createRepositoryHarness(seed = seedDefinition(), options = {}) {
  const { fakeOptions, ...repositoryOptions } = options
  const fake = createFakeCloudDatabase(seed, fakeOptions)
  const repository = createCloudBusinessRepository({
    db: fake.db,
    clock: () => new Date('2026-08-07T02:30:00.000Z'),
    workTimeService: {
      async tryAddWorkMinutes(startAt, minutes) {
        return {
          status: 'calculated',
          dueAt: new Date(startAt.getTime() + minutes * 60 * 1000),
          calendarVersion: 'calendar-v1'
        }
      }
    },
    ...repositoryOptions
  })
  return { fake, repository }
}

function input(overrides = {}) {
  return {
    templateId: 'template-1',
    name: '新业务',
    description: '说明',
    plannedStartDate: '2026-08-08',
    plannedEndDate: '2026-08-12',
    requestKey: 'request-001',
    ...overrides
  }
}

async function definition(repository) {
  return repository.getTemplateDefinition('template-1')
}

test('creation allocates a generated code and publishes a complete immutable template snapshot', async () => {
  const { fake, repository } = createRepositoryHarness()
  const source = await definition(repository)
  const result = await repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: source
  })

  assert.deepEqual(result, { id: result.id, code: 'BL-20260807-0001' })
  const [line] = fake.documents('business_lines')
  const nodes = fake.documents('business_nodes').sort((left, right) => left.sequence - right.sequence)
  assert.equal(line._id, result.id)
  assert.equal(line.status, 'active')
  assert.equal(line.sourceTemplateId, 'template-1')
  assert.equal(line.sourceTemplateVersion, 4)
  assert.deepEqual(line.managerUserIds, ['user-1'])
  assert.deepEqual(line.memberUserIds, ['user-1', 'user-2', 'user-3', 'user-4'])
  assert.equal(line.currentNodeId, nodes[0]._id)
  assert.equal(line.currentNodeName, '启动')
  assert.equal(line.nodeCount, 2)
  assert.equal(line.version, 1)
  assert.deepEqual(nodes.map(node => node.nodeCode), [
    'BL-20260807-0001-N001', 'BL-20260807-0001-N002'
  ])
  assert.deepEqual(nodes.map(node => node.status), ['ready', 'waiting'])
  assert.equal(nodes[0].workflowMode, 'review')
  assert.deepEqual(nodes[0].processorUserIds, ['user-2'])
  assert.deepEqual(nodes[0].reviewerUserIds, ['user-3'])
  assert.equal(nodes[0].reviewMode, 'any')
  assert.equal(nodes[0].processingSlaWorkHours, 8)
  assert.equal(nodes[0].reviewSlaWorkHours, 4)
  assert.equal(nodes[0].processingRoundNumber, 1)
  assert.equal(nodes[0].reviewRoundNumber, 0)
  assert.equal(nodes[0].processingDueStatus, 'calculated')
  assert.equal(nodes[0].processingDueAt.toISOString(), '2026-08-07T10:30:00.000Z')
  assert.equal(nodes[0].processingCalendarVersion, 'calendar-v1')
  assert.equal(nodes[0].processingStartedAt.toISOString(), '2026-08-07T02:30:00.000Z')
  assert.equal(nodes[0].reviewDueStatus, 'not_started')
  assert.equal(nodes[0].reviewDueAt, null)
  assert.equal(Object.hasOwn(nodes[0], 'assigneeUserIds'), false)
  assert.equal(Object.hasOwn(nodes[0], 'slaWorkHours'), false)
  assert.equal(nodes[1].processingRoundNumber, 1)
  assert.equal(nodes[1].reviewRoundNumber, 0)
  assert.equal(nodes[1].processingDueStatus, 'not_started')
  assert.equal(nodes[1].processingDueAt, null)
  assert.equal(nodes[1].reviewDueStatus, 'not_started')
  assert.equal(nodes[1].reviewDueAt, null)
  assert.equal(nodes[0].sourceTemplateNodeKey, 'node-a')
  assert.deepEqual(nodes[0].fieldDefinitions, source.nodes[0].fields)
  assert.notEqual(nodes[0].fieldDefinitions, source.nodes[0].fields)
  source.nodes[0].fields[0].name = '后续模板变化'
  source.nodes[0].processorUserIds[0] = '后续处理人'
  source.nodes[0].reviewerUserIds[0] = '后续审核人'
  assert.equal(fake.documents('business_nodes')[0].fieldDefinitions[0].name, '摘要')
  assert.deepEqual(fake.documents('business_nodes')[0].processorUserIds, ['user-2'])
  assert.deepEqual(fake.documents('business_nodes')[0].reviewerUserIds, ['user-3'])
  assert.equal(fake.documents('sequence_counters')[0].sequence, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.deepEqual(fake.transactionQueries, [])
})

test('snapshot creation and publication roll back safely and resume through the same reservation', async () => {
  const { fake, repository } = createRepositoryHarness()
  const source = await definition(repository)
  fake.failNextWrite({ collection: 'audit_logs', operation: 'set', error: new Error('audit unavailable') })

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: source
  }), /audit unavailable/)

  assert.equal(fake.documents('business_lines')[0].status, 'creating')
  assert.equal(fake.documents('business_nodes').length, 2)
  assert.equal(fake.documents('audit_logs').length, 0)

  const retried = await repository.findCreationResult({ actorId: 'user-1', input: input() })
  assert.equal(retried.code, 'BL-20260807-0001')
  assert.equal(fake.documents('business_lines')[0].status, 'active')
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('sequence_counters')[0].sequence, 1)
})

test('snapshot transaction revalidates enabled template and active processor/reviewer accounts and leaves no partial data', async t => {
  await t.test('template disabled after the service read', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('templates', 'template-1', {
      name: '交付模板', status: 'disabled', version: 5, nodeCount: 2
    }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'TEMPLATE_NOT_ENABLED')
    assert.equal(fake.documents('business_lines').length, 0)
    assert.equal(fake.documents('business_nodes').length, 0)
  })

  await t.test('processor disabled after the service read', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('users', 'user-2', { status: 'disabled' }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'PROCESSOR_INACTIVE')
    assert.equal(fake.documents('business_lines').length, 0)
    assert.equal(fake.documents('sequence_counters').length, 0)
  })

  await t.test('reviewer disabled after the service read', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('users', 'user-4', { status: 'disabled' }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'REVIEWER_INACTIVE')
    assert.equal(fake.documents('business_lines').length, 0)
    assert.equal(fake.documents('sequence_counters').length, 0)
  })

  await t.test('creator disabled after route resolution', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('users', 'user-1', { status: 'disabled' }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'FORBIDDEN')
    assert.equal(fake.documents('business_lines').length, 0)
    assert.equal(fake.documents('business_nodes').length, 0)
    assert.equal(fake.documents('sequence_counters').length, 0)
  })
})

test('same-key retries return the existing deterministic reservation', async () => {
  const { fake, repository } = createRepositoryHarness()
  const source = await definition(repository)
  const request = { actor: { _id: 'user-1' }, input: input(), definition: source }
  const first = await repository.createBusinessSnapshot(request)
  const retry = await repository.createBusinessSnapshot(request)
  assert.deepEqual(first, retry)
  assert.equal(fake.documents('business_lines').length, 1)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.documents('sequence_counters')[0].sequence, 1)
})

test('overlapping snapshot transactions conflict and retry to unique or idempotent results', async () => {
  const optimistic = createOptimisticBusinessDatabase(seedDefinition())
  const repository = createCloudBusinessRepository({
    db: optimistic.db,
    clock: () => new Date('2026-08-07T02:30:00.000Z')
  })
  const source = await definition(repository)
  const actor = { _id: 'user-1' }

  const distinct = await Promise.all([
    repository.createBusinessSnapshot({ actor, input: input({ requestKey: 'request-a' }), definition: source }),
    repository.createBusinessSnapshot({ actor, input: input({ requestKey: 'request-b' }), definition: source })
  ])
  assert.deepEqual(distinct.map(item => item.code).sort(), [
    'BL-20260807-0001', 'BL-20260807-0002'
  ])

  const sameRequest = { actor, input: input({ requestKey: 'request-c' }), definition: source }
  const same = await Promise.all([
    repository.createBusinessSnapshot(sameRequest),
    repository.createBusinessSnapshot(sameRequest)
  ])
  assert.deepEqual(same[0], same[1])
  assert.ok(optimistic.metrics.maxActiveCallbacks >= 2)
  assert.ok(optimistic.metrics.conflicts >= 1)
  assert.ok(optimistic.metrics.retries >= 1)
  assert.equal(optimistic.documents('business_lines').length, 3)
  assert.equal(optimistic.documents('audit_logs').length, 3)
  assert.equal(optimistic.documents('sequence_counters')[0].sequence, 3)
})

test('numbering expands past four digits and retries a stale counter collision without wrapping', async () => {
  const seed = seedDefinition({
    extra: {
      sequence_counters: [{ _id: 'business-line-20260807', sequence: 9998 }],
      business_lines: [{
        _id: 'existing', code: 'BL-20260807-9999', status: 'active',
        createdBy: 'other-user'
      }]
    }
  })
  const { fake, repository } = createRepositoryHarness(seed)
  const result = await repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  })

  assert.equal(result.code, 'BL-20260807-10000')
  assert.equal(fake.documents('sequence_counters')[0].sequence, 10000)
})

test('snapshot creation rejects creator-aware operation budget overflow before starting a transaction', async () => {
  const nodes = Array.from({ length: 48 }, (_, index) => sourceNode({
    _id: `template-node-${index}`,
    nodeKey: `node-${index}`,
    sequence: index,
    processorUserIds: [`p${index % 24}`],
    reviewerUserIds: [`p${24 + (index % 23)}`]
  }))
  const users = [{ _id: 'user-1', status: 'active' }].concat(Array.from({ length: 47 }, (_, index) => ({
    _id: `p${index}`, status: 'active'
  })))
  const { fake, repository } = createRepositoryHarness(seedDefinition({ nodes, users }))

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }), error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' &&
    /snapshot transaction operation budget/i.test(error.message) &&
    !/at most 48 nodes/i.test(error.message))
  assert.equal(fake.transactionRuns.length, 0)
})

test('snapshot transaction budget permits exactly one hundred operations with deduplicated review participants', async () => {
  const nodes = Array.from({ length: 48 }, (_, index) => sourceNode({
    _id: `template-node-${index}`,
    nodeKey: `node-${index}`,
    sequence: index,
    processorUserIds: [`p${index % 23}`],
    reviewerUserIds: [`p${23 + (index % 23)}`]
  }))
  const users = [{ _id: 'user-1', status: 'active' }].concat(Array.from({ length: 46 }, (_, index) => ({
    _id: `p${index}`, status: 'active'
  })))
  const { fake, repository } = createRepositoryHarness(seedDefinition({ nodes, users }))

  await repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  })

  assert.equal(fake.transactionRuns[0].operations, 100)
  assert.equal(fake.documents('business_lines').length, 1)
})

test('业务创建在事务前拒绝三十个真实长度账号形成的索引键超限', async () => {
  const ids = Array.from({ length: 30 }, (_, index) =>
    `acct-${String(index).padStart(2, '0')}-12345678901234567890123456789012`)
  const nodes = [sourceNode({
    processorUserIds: ids.slice(0, 15),
    reviewerUserIds: ids.slice(15)
  })]
  const users = [{ _id: 'user-1', status: 'active' }, ...ids.map(_id => ({ _id, status: 'active' }))]
  const { fake, repository } = createRepositoryHarness(seedDefinition({ nodes, users }))

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }), error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' && /索引账号数组/.test(error.message))
  assert.equal(fake.transactionRuns.length, 0)
})

test('missing work calendar publishes the business with a deterministic safe administrator warning', async () => {
  const { fake, repository } = createRepositoryHarness(seedDefinition(), {
    workTimeService: {
      async tryAddWorkMinutes() {
        return { status: 'pending_calendar', dueAt: null, missingDate: '2026-08-07' }
      }
    }
  })
  const request = {
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }

  const first = await repository.createBusinessSnapshot(request)
  const retry = await repository.createBusinessSnapshot(request)

  assert.deepEqual(retry, first)
  assert.equal(fake.documents('business_lines')[0].status, 'active')
  const firstNode = fake.documents('business_nodes').sort((a, b) => a.sequence - b.sequence)[0]
  assert.equal(firstNode.processingDueStatus, 'pending_calendar')
  assert.equal(firstNode.processingDueAt, null)
  assert.equal(firstNode.processingStartedAt.toISOString(), '2026-08-07T02:30:00.000Z')
  assert.equal(firstNode.calendarNotificationStatus, 'notified')
  const warnings = fake.documents('notifications')
  assert.equal(warnings.length, 1)
  assert.deepEqual(Object.keys(warnings[0]).sort(), [
    '_id', 'audienceRole', 'createdAt', 'status', 'type'
  ])
  assert.equal(warnings[0].audienceRole, 'super_admin')
  assert.equal(warnings[0].type, 'work_calendar_missing')
  assert.equal(warnings[0].status, 'pending')
})

test('日历缺失只将截止时间标为待补算，不阻断新版业务创建', async () => {
  const { fake, repository } = createRepositoryHarness(seedDefinition(), {
    workTimeService: {
      async tryAddWorkMinutes() {
        return { status: 'pending_calendar', dueAt: null, missingDate: '2026-08-07' }
      }
    }
  })
  const created = await repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  })

  assert.ok(created.id)
  assert.equal(fake.documents('business_lines').length, 1)
  assert.equal(fake.documents('business_nodes')[0].processingDueStatus, 'pending_calendar')
  assert.equal(fake.documents('business_nodes')[0].processingDueAt, null)
})

test('administrator warning failure does not roll back publication and a retry creates it once', async () => {
  const { fake, repository } = createRepositoryHarness(seedDefinition(), {
    workTimeService: {
      async tryAddWorkMinutes() {
        return { status: 'pending_calendar', dueAt: null, missingDate: '2026-08-07' }
      }
    }
  })
  const request = {
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }
  fake.failNextWrite({ collection: 'notifications', operation: 'set', error: new Error('notification unavailable') })

  const created = await repository.createBusinessSnapshot(request)
  assert.equal(fake.documents('business_lines')[0].status, 'active')
  assert.equal(fake.documents('notifications').length, 0)
  assert.equal(fake.documents('business_nodes').find(node => node.sequence === 0).calendarNotificationStatus, 'pending')

  assert.deepEqual(await repository.findCreationResult({ actorId: 'user-1', input: input() }), created)
  assert.equal(fake.documents('notifications').length, 1)
  assert.equal(fake.documents('business_nodes').find(node => node.sequence === 0).calendarNotificationStatus, 'notified')
})

test('failed snapshot writes roll back the counter, line, nodes, and audit together', async () => {
  const { fake, repository } = createRepositoryHarness()
  fake.failNextWrite({ collection: 'business_nodes', operation: 'set', error: new Error('node write failed') })

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }), /node write failed/)
  assert.equal(fake.documents('sequence_counters').length, 0)
  assert.equal(fake.documents('business_lines').length, 0)
  assert.equal(fake.documents('business_nodes').length, 0)
  assert.equal(fake.documents('audit_logs').length, 0)
})

test('reusing a request key with different validated input fails closed', async () => {
  const { repository } = createRepositoryHarness()
  const request = { actor: { _id: 'user-1' }, input: input(), definition: await definition(repository) }
  await repository.createBusinessSnapshot(request)

  await assert.rejects(
    repository.findCreationResult({ actorId: 'user-1', input: input({ name: '另一个业务' }) }),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('business list and detail reads support account-id snapshots and legacy OpenID records', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        {
          _id: 'new-active', code: 'BL-20260807-0001', name: '新业务', status: 'active',
          managerUserIds: ['user-1'], memberUserIds: ['user-1', 'user-2'], updatedAt: 4
        },
        {
          _id: 'new-creating', code: 'BL-20260807-0002', name: '半成品', status: 'creating',
          managerUserIds: ['user-1'], memberUserIds: ['user-1'], updatedAt: 5
        },
        {
          _id: 'legacy-active', code: 'LEGACY-1', name: '旧业务', status: 'active',
          managerIds: ['wx-user-1'], memberIds: ['wx-user-1'], updatedAt: 3
        },
        {
          _id: 'foreign', code: 'BL-20260807-0003', name: '无权业务', status: 'active',
          managerUserIds: ['user-3'], memberUserIds: ['user-3'], updatedAt: 2
        },
        {
          _id: 'hybrid-foreign', code: 'BL-20260807-0004', name: '混合字段无权业务', status: 'active',
          managerUserIds: ['user-3'], memberUserIds: ['user-3'], memberIds: ['wx-user-1'], updatedAt: 1
        }
      ],
      business_nodes: [
        {
          _id: 'new-node', businessLineId: 'new-active', sequence: 0, name: '新节点',
          status: 'ready', assigneeUserIds: ['user-2']
        },
        {
          _id: 'legacy-node', businessLineId: 'legacy-active', sequence: 0, name: '旧节点',
          status: 'ready', assigneeIds: ['wx-user-1'], assigneeNames: ['旧用户'],
          requiresEvidence: false
        }
      ]
    }
  })
  const { fake, repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  const listed = await repository.listBusinessLines({ actor, query: { page: 1, pageSize: 20 } })
  assert.deepEqual(listed.items.map(line => line._id), ['new-active', 'legacy-active'])

  const current = await repository.getBusinessLine({ actor, lineId: 'new-active' })
  assert.equal(current.line._id, 'new-active')
  assert.equal(current.nodes[0]._id, 'new-node')
  assert.equal(current.canManage, true)
  assert.equal(current.canEditNodes, false)

  const legacy = await repository.getBusinessLine({ actor, lineId: 'legacy-active' })
  assert.equal(legacy.line._id, 'legacy-active')
  assert.equal(legacy.nodes[0].canFeedback, true)
  assert.equal(legacy.nodes[0].assigneeNamesText, '旧用户')
  assert.equal(legacy.nodes[0].requiresEvidence, false)
  assert.deepEqual(legacy.nodes[0].allowedEvidenceTypes, [])
})

test('新版业务详情只返回审核流程安全投影与负责人显示名', async () => {
  const seed = seedDefinition({
    users: [
      { _id: 'user-1', status: 'active', displayName: '业务管理员', credentialHash: 'secret' },
      { _id: 'user-2', status: 'active', displayName: '处理人', openid: 'wx-secret' },
      { _id: 'user-3', status: 'active', username: 'reviewer03' }
    ],
    extra: {
      business_lines: [{
        _id: 'line-review', code: 'BL-20260811-0001', name: '审核业务', status: 'active',
        managerUserIds: ['user-1'], memberUserIds: ['user-1', 'user-2', 'user-3'],
        currentNodeId: 'node-review', currentNodeIndex: 0, version: 3,
        creationRequestHash: 'secret-request', internalLease: 'secret-lease'
      }],
      business_nodes: [{
        _id: 'node-review', businessLineId: 'line-review', nodeCode: 'BL-20260811-0001-N001',
        sequence: 0, name: '资料收集', status: 'pending_review', workflowMode: 'review', version: 5,
        processorUserIds: ['user-2'], reviewerUserIds: ['user-3'], reviewMode: 'any',
        processingRoundNumber: 2, reviewRoundNumber: 1,
        processingDueStatus: 'calculated', processingDueAt: new Date('2026-08-11T08:00:00.000Z'),
        processingOverdueWorkMinutes: 30, reviewDueStatus: 'calculated',
        reviewDueAt: new Date('2026-08-11T09:00:00.000Z'), reviewOverdueWorkMinutes: 10,
        reviewStartedAt: new Date('2026-08-11T07:30:00.000Z'),
        activeReviewRoundId: 'round-1', latestFeedbackId: 'feedback-secret', feedbackClaimId: 'claim-secret',
        requiresEvidence: true, allowedEvidenceTypes: ['pdf', 'mp4'],
        fieldDefinitions: [
          {
            fieldKey: 'summary', sequence: 0, name: '摘要', description: '填写摘要',
            type: 'short_text', required: true, constraints: { minLength: 2, maxLength: 100 },
            internalHash: 'field-secret'
          },
          {
            fieldKey: 'amount', sequence: 1, name: '金额', description: '',
            type: 'number', required: false, constraints: { min: 0, max: 9999, decimalPlaces: 2 },
            reservationId: 'field-reservation'
          },
          {
            fieldKey: 'category', sequence: 2, name: '类型', description: '',
            type: 'single_select', required: true, constraints: { options: ['合同', '发票'] },
            credentialHash: 'field-credential'
          },
          {
            fieldKey: 'confirmed', sequence: 3, name: '已确认', description: '',
            type: 'boolean', required: false, constraints: {}, internalLease: 'field-lease'
          }
        ]
      }]
    }
  })
  const { fake, repository } = createRepositoryHarness(seed)
  const result = await repository.getBusinessLine({
    actor: { _id: 'user-1', status: 'active' }, lineId: 'line-review'
  })

  assert.deepEqual(result.line, {
    _id: 'line-review', code: 'BL-20260811-0001', name: '审核业务', description: '',
    plannedStartDate: '', plannedEndDate: '', status: 'active', version: 3,
    progress: 0, nodeCount: 0, currentNodeId: 'node-review', currentNodeName: '', updatedAt: null
  })
  assert.deepEqual(result.nodes[0], {
    _id: 'node-review', nodeCode: 'BL-20260811-0001-N001', sequence: 0,
    name: '资料收集', description: '', status: 'pending_review', version: 5,
    workflowMode: 'review', processorDisplayNames: ['处理人'], reviewerDisplayNames: ['reviewer03'],
    reviewMode: 'any', processingRoundNumber: 2, reviewRoundNumber: 1,
    processingDueStatus: 'calculated', processingDueAt: new Date('2026-08-11T08:00:00.000Z'),
    processingOverdueWorkMinutes: 30, reviewDueStatus: 'calculated',
    reviewDueAt: new Date('2026-08-11T09:00:00.000Z'), reviewOverdueWorkMinutes: 10,
    reviewStartedAt: new Date('2026-08-11T07:30:00.000Z'),
    activeReviewRoundId: 'round-1', canFeedback: false,
    requiresEvidence: true, allowedEvidenceTypes: ['pdf', 'mp4'],
    fieldDefinitions: [
      {
        fieldKey: 'summary', sequence: 0, name: '摘要', description: '填写摘要',
        type: 'short_text', required: true, constraints: { minLength: 2, maxLength: 100 }
      },
      {
        fieldKey: 'amount', sequence: 1, name: '金额', description: '',
        type: 'number', required: false, constraints: { min: 0, max: 9999, decimalPlaces: 2 }
      },
      {
        fieldKey: 'category', sequence: 2, name: '类型', description: '',
        type: 'single_select', required: true, constraints: { options: ['合同', '发票'] }
      },
      {
        fieldKey: 'confirmed', sequence: 3, name: '已确认', description: '',
        type: 'boolean', required: false, constraints: {}
      }
    ]
  })
  assert.doesNotMatch(JSON.stringify(result), /user-2|user-3|wx-secret|credentialHash|secret-request|secret-lease|feedback-secret|claim-secret|field-secret|field-reservation|field-credential|field-lease/)
  result.nodes[0].fieldDefinitions[0].constraints.maxLength = 1
  result.nodes[0].fieldDefinitions[2].constraints.options.push('内部类型')
  result.nodes[0].allowedEvidenceTypes.push('jpg')
  const storedNode = fake.documents('business_nodes').find(item => item._id === 'node-review')
  assert.equal(storedNode.fieldDefinitions[0].constraints.maxLength, 100)
  assert.deepEqual(storedNode.fieldDefinitions[2].constraints.options, ['合同', '发票'])
  assert.deepEqual(storedNode.allowedEvidenceTypes, ['pdf', 'mp4'])

  fake.beforeNextTransaction(() => {
    const user = fake.documents('users').find(item => item._id === 'user-1')
    fake.replace('users', 'user-1', { ...user, status: 'disabled' })
  })
  await assert.rejects(repository.getBusinessLine({
    actor: { _id: 'user-1', status: 'active' }, lineId: 'line-review'
  }), error => error.code === 'FORBIDDEN')
})

test('停用节点参与人不阻断已完成业务详情并显示停用标记', async () => {
  const seed = seedDefinition({
    users: [
      { _id: 'manager-1', status: 'active', displayName: '业务管理员' },
      { _id: 'processor-1', status: 'disabled', displayName: '历史处理人' },
      { _id: 'reviewer-1', status: 'active', displayName: '历史审核人' }
    ],
    extra: {
      business_lines: [{
        _id: 'line-completed', code: 'BL-HISTORY-001', name: '已完成业务',
        status: 'completed', version: 4, progress: 100,
        managerUserIds: ['manager-1'],
        memberUserIds: ['manager-1', 'processor-1', 'reviewer-1'],
        currentNodeId: 'node-completed', currentNodeIndex: 0, nodeCount: 1
      }],
      business_nodes: [{
        _id: 'node-completed', businessLineId: 'line-completed',
        nodeCode: 'BL-HISTORY-001-N001', sequence: 0, name: '历史节点',
        status: 'completed', version: 3, workflowMode: 'review',
        processorUserIds: ['processor-1'], reviewerUserIds: ['reviewer-1'],
        reviewMode: 'any', processingRoundNumber: 1, reviewRoundNumber: 1,
        processingDueStatus: 'calculated', reviewDueStatus: 'calculated',
        requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
      }]
    }
  })
  const { repository } = createRepositoryHarness(seed)

  const result = await repository.getBusinessLine({
    actor: { _id: 'manager-1' }, lineId: 'line-completed'
  })

  assert.deepEqual(result.nodes[0].processorDisplayNames, ['历史处理人（已停用）'])
  assert.deepEqual(result.nodes[0].reviewerDisplayNames, ['历史审核人'])
})

test('业务详情对损坏或缺失的节点参与账号继续失败关闭', async t => {
  function historySeed(processor) {
    return seedDefinition({
      users: [
        { _id: 'manager-1', status: 'active', displayName: '业务管理员' },
        ...(processor ? [processor] : []),
        { _id: 'reviewer-1', status: 'active', displayName: '历史审核人' }
      ],
      extra: {
        business_lines: [{
          _id: 'line-history-invalid', code: 'BL-HISTORY-INVALID', name: '历史异常业务',
          status: 'completed', version: 4, progress: 100,
          managerUserIds: ['manager-1'],
          memberUserIds: ['manager-1', 'processor-1', 'reviewer-1'],
          currentNodeId: 'node-history-invalid', currentNodeIndex: 0, nodeCount: 1
        }],
        business_nodes: [{
          _id: 'node-history-invalid', businessLineId: 'line-history-invalid',
          nodeCode: 'BL-HISTORY-INVALID-N001', sequence: 0, name: '历史异常节点',
          status: 'completed', version: 3, workflowMode: 'review',
          processorUserIds: ['processor-1'], reviewerUserIds: ['reviewer-1'],
          reviewMode: 'any', processingRoundNumber: 1, reviewRoundNumber: 1,
          processingDueStatus: 'calculated', reviewDueStatus: 'calculated',
          requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
        }]
      }
    })
  }

  for (const item of [
    { name: '状态缺失', processor: { _id: 'processor-1', displayName: '历史处理人' } },
    { name: '未知状态', processor: { _id: 'processor-1', status: 'locked', displayName: '历史处理人' } },
    { name: '账号缺失', processor: null }
  ]) {
    await t.test(item.name, async () => {
      const { repository } = createRepositoryHarness(historySeed(item.processor))
      await assert.rejects(repository.getBusinessLine({
        actor: { _id: 'manager-1' }, lineId: 'line-history-invalid'
      }), error => error.code === 'FORBIDDEN')
    })
  }

  await t.test('名称访问器不执行', async () => {
    const getterReads = { count: 0 }
    const { repository } = createRepositoryHarness(historySeed({
      _id: 'processor-1', status: 'disabled', displayName: '占位名称'
    }), {
      fakeOptions: {
        transformRead({ collection, data }) {
          if (collection === 'users' && data._id === 'processor-1') {
            delete data.username
            Object.defineProperty(data, 'displayName', {
              enumerable: true,
              get() {
                getterReads.count += 1
                return '不应读取'
              }
            })
          }
          return data
        }
      }
    })

    await assert.rejects(repository.getBusinessLine({
      actor: { _id: 'manager-1' }, lineId: 'line-history-invalid'
    }), error => error.code === 'FORBIDDEN')
    assert.equal(getterReads.count, 0)
  })

  await t.test('状态访问器不执行', async () => {
    const getterReads = { count: 0 }
    const { repository } = createRepositoryHarness(historySeed({
      _id: 'processor-1', status: 'disabled', displayName: '历史处理人'
    }), {
      fakeOptions: {
        transformRead({ collection, data }) {
          if (collection === 'users' && data._id === 'processor-1') {
            delete data.status
            Object.defineProperty(data, 'status', {
              enumerable: true,
              get() {
                getterReads.count += 1
                return 'disabled'
              }
            })
          }
          return data
        }
      }
    })

    await assert.rejects(repository.getBusinessLine({
      actor: { _id: 'manager-1' }, lineId: 'line-history-invalid'
    }), error => error.code === 'FORBIDDEN')
    assert.equal(getterReads.count, 0)
  })
})

test('已创建的初始审核节点缺少截止状态时只把尚未开始阶段安全映射为 not_started', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [{
        _id: 'line-initial-due', code: 'BL-20260812-0001', name: '初始截止状态', status: 'active',
        managerUserIds: ['user-1'], memberUserIds: ['user-1', 'user-2', 'user-3', 'user-4'],
        currentNodeId: 'node-current', currentNodeIndex: 0, version: 1
      }],
      business_nodes: [
        {
          _id: 'node-current', businessLineId: 'line-initial-due', nodeCode: 'BL-20260812-0001-N001',
          sequence: 0, name: '当前处理', status: 'ready', workflowMode: 'review', version: 1,
          processorUserIds: ['user-2'], reviewerUserIds: ['user-3'], reviewMode: 'any',
          processingRoundNumber: 1, reviewRoundNumber: 0,
          processingDueStatus: 'calculated', processingDueAt: new Date('2026-08-14T11:00:00.000Z'),
          requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
        },
        {
          _id: 'node-waiting', businessLineId: 'line-initial-due', nodeCode: 'BL-20260812-0001-N002',
          sequence: 1, name: '后续节点', status: 'waiting', workflowMode: 'review', version: 1,
          processorUserIds: ['user-3'], reviewerUserIds: ['user-4'], reviewMode: 'any',
          processingRoundNumber: 1, reviewRoundNumber: 0,
          requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
        },
        {
          _id: 'node-corrupt-active', businessLineId: 'line-initial-due', nodeCode: 'BL-20260812-0001-N003',
          sequence: 2, name: '异常活动阶段', status: 'pending_review', workflowMode: 'review', version: 2,
          processorUserIds: ['user-2'], reviewerUserIds: ['user-4'], reviewMode: 'any',
          processingRoundNumber: 1, reviewRoundNumber: 1,
          reviewStartedAt: new Date('2026-08-12T11:00:00.000Z'),
          requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
        }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)

  const result = await repository.getBusinessLine({
    actor: { _id: 'user-1', status: 'active' }, lineId: 'line-initial-due'
  })

  assert.equal(result.nodes[0].processingDueStatus, 'calculated')
  assert.equal(result.nodes[0].reviewDueStatus, 'not_started')
  assert.equal(result.nodes[1].processingDueStatus, 'not_started')
  assert.equal(result.nodes[1].reviewDueStatus, 'not_started')
  assert.equal(result.nodes[2].processingDueStatus, undefined)
  assert.equal(result.nodes[2].reviewDueStatus, undefined)
})

test('旧业务节点详情保留动态字段和必传凭证契约并剥离字段内部属性', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [{
        _id: 'legacy-line', code: 'BL-LEGACY', name: '旧业务', status: 'active', version: 1,
        managerIds: ['wx-user-1'], memberIds: ['wx-user-1'], currentNodeId: 'legacy-node',
        currentNodeIndex: 0
      }],
      business_nodes: [{
        _id: 'legacy-node', businessLineId: 'legacy-line', nodeCode: 'BL-LEGACY-N001',
        sequence: 0, name: '旧节点', status: 'ready', version: 1,
        assigneeIds: ['wx-user-1'], assigneeNames: ['旧负责人'], requiresEvidence: true,
        evidenceTypes: ['jpg', 'png', 'pdf', 'mp4'],
        fieldDefinitions: [{
          fieldKey: 'notes', sequence: 0, name: '说明', description: '', type: 'long_text',
          required: true, constraints: { maxLength: 500 }, internalDigest: 'do-not-return'
        }]
      }]
    }
  })
  const { repository } = createRepositoryHarness(seed)

  const result = await repository.getBusinessLine({
    actor: { _id: 'user-1', openid: 'wx-user-1' }, lineId: 'legacy-line'
  })

  assert.equal(result.nodes[0].requiresEvidence, true)
  assert.deepEqual(result.nodes[0].allowedEvidenceTypes, ['jpg', 'png', 'pdf', 'mp4'])
  assert.deepEqual(result.nodes[0].fieldDefinitions, [{
    fieldKey: 'notes', sequence: 0, name: '说明', description: '', type: 'long_text',
    required: true, constraints: { maxLength: 500 }
  }])
  assert.doesNotMatch(JSON.stringify(result), /evidenceTypes|internalDigest|do-not-return/)
})

test('新版审核节点凭证策略拒绝旧字段回退、混合字段、访问器和原型链', async () => {
  const baseNode = {
    _id: 'node-review-policy', businessLineId: 'line-review-policy',
    nodeCode: 'BL-20260811-0100-N001', sequence: 0, name: 'Review node',
    status: 'ready', version: 1, workflowMode: 'review',
    processorUserIds: ['user-2'], reviewerUserIds: ['user-3'], reviewMode: 'any',
    processingRoundNumber: 1, reviewRoundNumber: 0,
    processingDueStatus: 'calculated', reviewDueStatus: 'not_started',
    requiresEvidence: false, fieldDefinitions: []
  }
  const cases = [
    {
      name: '旧字段回退',
      mutate(node) { node.evidenceTypes = ['pdf'] }
    },
    {
      name: '新旧字段混合',
      mutate(node) {
        node.allowedEvidenceTypes = ['pdf']
        node.evidenceTypes = ['png']
      }
    },
    {
      name: '非法类型',
      mutate(node) { node.allowedEvidenceTypes = ['exe'] }
    },
    {
      name: '重复类型',
      mutate(node) { node.allowedEvidenceTypes = ['pdf', 'pdf'] }
    },
    {
      name: '非数组类型列表',
      mutate(node) { node.allowedEvidenceTypes = 'pdf' }
    },
    {
      name: '继承新版字段',
      mutate(node) {
        Object.setPrototypeOf(node, { allowedEvidenceTypes: ['pdf'] })
      }
    },
    {
      name: '继承旧字段',
      mutate(node) {
        Object.setPrototypeOf(node, { evidenceTypes: ['pdf'] })
      }
    },
    {
      name: '新版字段访问器',
      mutate(node, reads) {
        Object.defineProperty(node, 'allowedEvidenceTypes', {
          configurable: true,
          get() {
            reads.count += 1
            return ['pdf']
          }
        })
      }
    },
    {
      name: '旧字段访问器',
      mutate(node, reads) {
        Object.defineProperty(node, 'evidenceTypes', {
          configurable: true,
          get() {
            reads.count += 1
            return ['pdf']
          }
        })
      }
    },
    {
      name: '数组元素访问器',
      mutate(node, reads) {
        const types = []
        Object.defineProperty(types, '0', {
          configurable: true,
          get() {
            reads.count += 1
            return 'pdf'
          }
        })
        types.length = 1
        node.allowedEvidenceTypes = types
      }
    }
  ]

  for (const item of cases) {
    const reads = { count: 0 }
    const seed = seedDefinition({
      extra: {
        business_lines: [{
          _id: 'line-review-policy', code: 'BL-20260811-0100', name: 'Review policy',
          status: 'active', version: 1, managerUserIds: ['user-1'],
          memberUserIds: ['user-1', 'user-2', 'user-3'], currentNodeId: 'node-review-policy',
          currentNodeIndex: 0, nodeCount: 1
        }],
        business_nodes: [{ ...baseNode }]
      }
    })
    const { repository } = createRepositoryHarness(seed, {
      fakeOptions: {
        transformRead({ collection, data }) {
          if (collection === 'business_nodes' && data._id === 'node-review-policy') {
            item.mutate(data, reads)
          }
          return data
        }
      }
    })

    await assert.rejects(repository.getBusinessLine({
      actor: { _id: 'user-1', status: 'active' }, lineId: 'line-review-policy'
    }), error => error.code === 'FORBIDDEN', item.name)
    assert.equal(reads.count, 0, `${item.name} 不得执行访问器`)
  }
})

test('业务详情按请求缓存负责人显示名且重复账号只解析一次', async () => {
  const participants = Array.from({ length: 46 }, (_, index) => ({
    _id: `staff-${String(index + 1).padStart(2, '0')}`,
    status: 'active', displayName: `成员${String(index + 1).padStart(2, '0')}`
  }))
  const nodes = Array.from({ length: 48 }, (_, index) => {
    const processor = participants[index % participants.length]._id
    const reviewer = participants[(index + 1) % participants.length]._id
    return {
      _id: `node-${String(index + 1).padStart(2, '0')}`, businessLineId: 'line-many',
      nodeCode: `BL-20260811-0099-N${String(index + 1).padStart(3, '0')}`,
      sequence: index, name: `节点${index + 1}`, status: index === 0 ? 'ready' : 'waiting',
      version: 1, workflowMode: 'review', processorUserIds: [processor],
      reviewerUserIds: [reviewer], reviewMode: 'any', processingRoundNumber: 1,
      reviewRoundNumber: 0, processingDueStatus: 'calculated', reviewDueStatus: 'not_started',
      requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
    }
  })
  const reads = new Map()
  const seed = seedDefinition({
    users: [{ _id: 'manager-1', status: 'active', displayName: '管理员' }, ...participants],
    extra: {
      business_lines: [{
        _id: 'line-many', code: 'BL-20260811-0099', name: '批量业务', status: 'active', version: 1,
        managerUserIds: ['manager-1'], memberUserIds: participants.map(item => item._id),
        currentNodeId: 'node-01', currentNodeIndex: 0, nodeCount: 48
      }],
      business_nodes: nodes
    }
  })
  const { repository } = createRepositoryHarness(seed, {
    fakeOptions: {
      transformRead({ collection, data }) {
        if (collection === 'users' && data._id.startsWith('staff-')) {
          reads.set(data._id, (reads.get(data._id) || 0) + 1)
        }
        return data
      }
    }
  })

  const result = await repository.getBusinessLine({
    actor: { _id: 'manager-1' }, lineId: 'line-many'
  })

  assert.equal(result.nodes.length, 48)
  assert.equal([...reads.values()].reduce((sum, count) => sum + count, 0), 46)
  assert.equal([...reads.values()].every(count => count === 1), true)
  assert.equal(result.nodes[0].reviewerDisplayNames[0], result.nodes[46].reviewerDisplayNames[0])
})

test('business detail reads hide creating reservations and deny non-members in both schemas', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        { _id: 'new-creating', status: 'creating', memberUserIds: ['user-1'] },
        { _id: 'new-foreign', status: 'active', memberUserIds: ['user-2'] },
        { _id: 'legacy-foreign', status: 'active', memberIds: ['wx-user-2'] }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  await assert.rejects(
    repository.getBusinessLine({ actor, lineId: 'new-creating' }),
    error => error.code === 'NOT_FOUND'
  )
  for (const lineId of ['new-foreign', 'legacy-foreign']) {
    await assert.rejects(
      repository.getBusinessLine({ actor, lineId }),
      error => error.code === 'FORBIDDEN'
    )
  }
})

test('present malformed account membership fields never inherit legacy OpenID access', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        {
          _id: 'null-member', status: 'active', memberUserIds: null,
          memberIds: ['wx-user-1'], updatedAt: 3
        },
        {
          _id: 'object-manager', status: 'active', managerUserIds: { user: 'user-1' },
          managerIds: ['wx-user-1'], updatedAt: 2
        },
        {
          _id: 'null-manager-account-member', status: 'active', managerUserIds: null,
          memberUserIds: ['user-1'], managerIds: ['wx-user-1'], updatedAt: 1
        }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  const listed = await repository.listBusinessLines({ actor, query: { page: 1, pageSize: 20 } })
  assert.deepEqual(listed.items.map(line => line._id), ['null-manager-account-member'])

  for (const lineId of ['null-member', 'object-manager']) {
    await assert.rejects(
      repository.getBusinessLine({ actor, lineId }),
      error => error.code === 'FORBIDDEN'
    )
  }

  const accountMember = await repository.getBusinessLine({
    actor,
    lineId: 'null-manager-account-member'
  })
  assert.equal(accountMember.canManage, false)
})

test('valid account arrays take precedence over differing legacy arrays while pure legacy remains compatible', async () => {
  const seed = seedDefinition({
    extra: {
      business_lines: [
        {
          _id: 'new-manager-only', status: 'active', managerUserIds: ['user-1'],
          memberUserIds: [], managerIds: ['wx-other'], memberIds: ['wx-other'], updatedAt: 4
        },
        {
          _id: 'hybrid-account-member', status: 'active', managerUserIds: ['user-2'],
          memberUserIds: ['user-1'], managerIds: ['wx-user-1'], memberIds: ['wx-other'], updatedAt: 3
        },
        {
          _id: 'hybrid-legacy-only', status: 'active', managerUserIds: ['user-2'],
          memberUserIds: ['user-2'], managerIds: ['wx-user-1'], memberIds: ['wx-user-1'], updatedAt: 2
        },
        {
          _id: 'legacy-manager-only', status: 'active', managerIds: ['wx-user-1'],
          memberIds: [], updatedAt: 1
        }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'user-1', openid: 'wx-user-1', status: 'active' }

  const listed = await repository.listBusinessLines({ actor, query: { page: 1, pageSize: 20 } })
  assert.deepEqual(listed.items.map(line => line._id), [
    'new-manager-only', 'hybrid-account-member', 'legacy-manager-only'
  ])

  assert.equal((await repository.getBusinessLine({
    actor,
    lineId: 'new-manager-only'
  })).canManage, true)
  assert.equal((await repository.getBusinessLine({
    actor,
    lineId: 'hybrid-account-member'
  })).canManage, false)
  assert.equal((await repository.getBusinessLine({
    actor,
    lineId: 'legacy-manager-only'
  })).canManage, true)
  await assert.rejects(
    repository.getBusinessLine({ actor, lineId: 'hybrid-legacy-only' }),
    error => error.code === 'FORBIDDEN'
  )
})

test('account-id manager updates metadata atomically without changing immutable snapshot fields', async () => {
  const original = {
    _id: 'business-1', code: 'BL-20260807-0001', name: '旧名称', description: '',
    plannedStartDate: '2026-08-08', plannedEndDate: '2026-08-12', status: 'active', version: 4,
    managerUserIds: ['user-1'], memberUserIds: ['user-1', 'user-2'],
    sourceTemplateId: 'template-1', sourceTemplateVersion: 3, currentNodeId: 'node-1', nodeCount: 1
  }
  const { fake, repository } = createRepositoryHarness(seedDefinition({
    extra: {
      business_lines: [original],
      business_nodes: [{ _id: 'node-1', businessLineId: 'business-1', name: '不可变节点', status: 'ready' }]
    }
  }))

  const result = await repository.updateBusinessMetadata({
    actor: { _id: 'user-1', openid: 'wx-user-1' },
    lineId: 'business-1',
    expectedVersion: 4,
    metadata: {
      name: '新名称', description: '新说明',
      plannedStartDate: '2026-08-09', plannedEndDate: '2026-08-13'
    }
  })

  assert.deepEqual(result, { id: 'business-1', version: 5 })
  const line = fake.documents('business_lines')[0]
  assert.equal(line.name, '新名称')
  assert.equal(line.description, '新说明')
  assert.equal(line.version, 5)
  for (const field of ['code', 'managerUserIds', 'memberUserIds', 'sourceTemplateId', 'sourceTemplateVersion', 'currentNodeId', 'nodeCount']) {
    assert.deepEqual(line[field], original[field], field)
  }
  assert.deepEqual(fake.documents('business_nodes'), [
    { _id: 'node-1', businessLineId: 'business-1', name: '不可变节点', status: 'ready' }
  ])
  assert.deepEqual(fake.documents('audit_logs').map(item => ({
    actorId: item.actorId, action: item.action, targetId: item.targetId,
    beforeVersion: item.beforeVersion, afterVersion: item.afterVersion
  })), [{
    actorId: 'user-1', action: 'UPDATE_BUSINESS_METADATA', targetId: 'business-1',
    beforeVersion: 4, afterVersion: 5
  }])
})

test('metadata update denies non-managers, stale versions, inactive actors, and non-editable states', async t => {
  async function attempt(line, actor = { _id: 'user-1', openid: 'wx-user-1' }, expectedVersion = 4, beforeTransaction) {
    const { fake, repository } = createRepositoryHarness(seedDefinition({ extra: { business_lines: [line] } }))
    if (beforeTransaction) fake.beforeNextTransaction(beforeTransaction(fake))
    const promise = repository.updateBusinessMetadata({
      actor,
      lineId: line._id,
      expectedVersion,
      metadata: { name: '新名称', description: '', plannedStartDate: '', plannedEndDate: '' }
    })
    return { fake, promise }
  }

  await t.test('account-id non-manager', async () => {
    const { fake, promise } = await attempt({
      _id: 'business-1', status: 'active', version: 4,
      managerUserIds: ['user-2'], memberUserIds: ['user-1', 'user-2']
    })
    await assert.rejects(promise, error => error.code === 'FORBIDDEN')
    assert.equal(fake.documents('audit_logs').length, 0)
  })

  await t.test('stale expected version', async () => {
    const { promise } = await attempt({
      _id: 'business-1', status: 'active', version: 5,
      managerUserIds: ['user-1'], memberUserIds: ['user-1']
    })
    await assert.rejects(promise, error => error.code === 'VERSION_CONFLICT')
  })

  await t.test('actor disabled after route resolution', async () => {
    const { fake, promise } = await attempt({
      _id: 'business-1', status: 'active', version: 4,
      managerUserIds: ['user-1'], memberUserIds: ['user-1']
    }, { _id: 'user-1', openid: 'wx-user-1' }, 4, fake => () => {
      fake.replace('users', 'user-1', { status: 'disabled' })
    })
    await assert.rejects(promise, error => error.code === 'FORBIDDEN')
    assert.equal(fake.documents('business_lines')[0].name, undefined)
  })

  for (const status of ['completed', 'cancelled', 'closed', 'deleted']) {
    await t.test(status, async () => {
      const { promise } = await attempt({
        _id: `business-${status}`, status, version: 4,
        managerUserIds: ['user-1'], memberUserIds: ['user-1']
      })
      await assert.rejects(promise, error => error.code === 'BUSINESS_FROZEN')
    })
  }

  await t.test('creating reservation remains hidden', async () => {
    const { promise } = await attempt({
      _id: 'business-creating', status: 'creating', version: 4,
      managerUserIds: ['user-1'], memberUserIds: ['user-1']
    })
    await assert.rejects(promise, error => error.code === 'NOT_FOUND')
  })
})

test('legacy metadata update authorizes the current transactional binding, not the stale route actor', async () => {
  function legacySeed() {
    return seedDefinition({
      users: [
        { _id: 'user-1', status: 'active', openid: 'wx-current-binding' },
        { _id: 'user-2', status: 'active' },
        { _id: 'user-3', status: 'active' }
      ],
      extra: {
        business_lines: [{
          _id: 'legacy-business', name: '旧名称', status: 'active', version: 4,
          managerIds: ['wx-current-binding'], memberIds: ['wx-current-binding']
        }]
      }
    })
  }
  const metadata = { name: '新名称', description: '', plannedStartDate: '', plannedEndDate: '' }

  const bound = createRepositoryHarness(legacySeed())
  const updated = await bound.repository.updateBusinessMetadata({
    actor: { _id: 'user-1', openid: 'wx-current-binding' },
    lineId: 'legacy-business', expectedVersion: 4, metadata
  })
  assert.equal(updated.version, 5)

  const unbound = createRepositoryHarness(legacySeed())
  unbound.fake.beforeNextTransaction(() => {
    unbound.fake.replace('users', 'user-1', { status: 'active' })
  })
  await assert.rejects(
    unbound.repository.updateBusinessMetadata({
      actor: { _id: 'user-1', openid: 'wx-current-binding' },
      lineId: 'legacy-business', expectedVersion: 4, metadata
    }),
    error => error.code === 'FORBIDDEN'
  )
  assert.equal(unbound.fake.documents('business_lines')[0].version, 4)
  assert.equal(unbound.fake.documents('audit_logs').length, 0)
})

function rejectionSeed(overrides = {}) {
  const previousCompletedAt = new Date('2026-08-06T04:00:00.000Z')
  const previousDueAt = new Date('2026-08-05T04:00:00.000Z')
  const currentActivatedAt = new Date('2026-08-06T04:00:00.000Z')
  const currentDueAt = new Date('2026-08-07T12:00:00.000Z')
  return seedDefinition({
    users: [
      { _id: 'user-1', status: 'active' },
      { _id: 'user-2', status: 'active' },
      { _id: 'user-3', status: 'active' }
    ],
    extra: {
      business_lines: [{
        _id: 'line-1', code: 'BL-20260807-0001', name: '业务线', status: 'active', version: 8,
        managerUserIds: ['user-1'], memberUserIds: ['user-1', 'user-2', 'user-3'],
        currentNodeId: 'node-2', currentNodeIndex: 1, currentNodeName: '复核', nodeCount: 3, progress: 33,
        ...(overrides.line || {})
      }],
      business_nodes: [
        {
          _id: 'node-1', businessLineId: 'line-1', nodeCode: 'BL-20260807-0001-N001',
          sequence: 0, name: '资料准备', status: 'completed', version: 5,
          assigneeUserIds: ['user-2'], completedAt: previousCompletedAt, dueAt: previousDueAt,
          latestFeedbackId: 'feedback-previous', latestFeedbackRevision: 2,
          rejectionCount: 1, reworkWorkMinutes: 30,
          ...(overrides.previous || {})
        },
        {
          _id: 'node-2', businessLineId: 'line-1', nodeCode: 'BL-20260807-0001-N002',
          sequence: 1, name: '复核', status: 'ready', version: 3,
          assigneeUserIds: ['user-3'], activatedAt: currentActivatedAt, dueAt: currentDueAt,
          ...(overrides.current || {})
        },
        {
          _id: 'node-3', businessLineId: 'line-1', nodeCode: 'BL-20260807-0001-N003',
          sequence: 2, name: '归档', status: 'waiting', version: 1,
          assigneeUserIds: ['user-1']
        }
      ],
      node_feedback: [{
        _id: 'feedback-previous', businessLineId: 'line-1', nodeId: 'node-1',
        publishState: 'published', revision: 2, status: 'completed', fieldValues: [{ fieldKey: 'a', value: '原值' }]
      }],
      evidences: [{
        _id: 'evidence-previous', businessLineId: 'line-1', nodeId: 'node-1',
        feedbackId: 'feedback-previous', attachmentState: 'attached', storageStatus: 'available'
      }]
    }
  })
}

function rejectionInput(overrides = {}) {
  return {
    actor: { _id: 'user-3', status: 'active' },
    lineId: 'line-1',
    currentNodeId: 'node-2',
    expectedCurrentVersion: 3,
    expectedPreviousVersion: 5,
    reason: '上一节点资料需要补充',
    requestKey: 'reject-001',
    ...overrides
  }
}

test('当前节点负责人可原子驳回紧邻上一节点且不重置历史与计时信息', async () => {
  const { fake, repository } = createRepositoryHarness(rejectionSeed())
  const beforeFeedback = fake.documents('node_feedback')
  const beforeEvidence = fake.documents('evidences')

  const result = await repository.rejectPreviousNode(rejectionInput())

  assert.deepEqual(result, {
    businessLineId: 'line-1', previousNodeId: 'node-1', currentNodeId: 'node-2',
    previousVersion: 6, currentVersion: 4, lineVersion: 9
  })
  const [previous, current] = fake.documents('business_nodes').sort((left, right) => left.sequence - right.sequence)
  const line = fake.documents('business_lines')[0]
  assert.equal(previous.status, 'in_progress')
  assert.equal(previous.version, 6)
  assert.equal(previous.rejectionCount, 2)
  assert.deepEqual(previous.completedAt, new Date('2026-08-06T04:00:00.000Z'))
  assert.deepEqual(previous.dueAt, new Date('2026-08-05T04:00:00.000Z'))
  assert.equal(previous.latestFeedbackId, 'feedback-previous')
  assert.equal(previous.latestFeedbackRevision, 2)
  assert.equal(previous.reworkWorkMinutes, 30)
  assert.equal(current.status, 'waiting')
  assert.equal(current.version, 4)
  assert.deepEqual(current.activatedAt, new Date('2026-08-06T04:00:00.000Z'))
  assert.deepEqual(current.dueAt, new Date('2026-08-07T12:00:00.000Z'))
  assert.equal(line.currentNodeId, 'node-1')
  assert.equal(line.currentNodeIndex, 0)
  assert.equal(line.currentNodeName, '资料准备')
  assert.equal(line.progress, 0)
  assert.equal(line.version, 9)
  assert.deepEqual(fake.documents('node_feedback'), beforeFeedback)
  assert.deepEqual(fake.documents('evidences'), beforeEvidence)
  assert.deepEqual(fake.documents('audit_logs').map(item => ({
    action: item.action, actorId: item.actorId, targetId: item.targetId,
    previousNodeId: item.previousNodeId, currentNodeId: item.currentNodeId, reason: item.reason
  })), [{
    action: 'REJECT_PREVIOUS_NODE', actorId: 'user-3', targetId: 'line-1',
    previousNodeId: 'node-1', currentNodeId: 'node-2', reason: '上一节点资料需要补充'
  }])
  assert.deepEqual(fake.transactionQueries, [])
})

test('同一驳回请求可幂等重试且变更内容会触发版本冲突', async () => {
  const { fake, repository } = createRepositoryHarness(rejectionSeed())
  const first = await repository.rejectPreviousNode(rejectionInput())
  const retry = await repository.rejectPreviousNode(rejectionInput())
  assert.deepEqual(retry, first)
  assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-1').rejectionCount, 2)
  assert.equal(fake.documents('audit_logs').length, 1)

  await assert.rejects(
    repository.rejectPreviousNode(rejectionInput({ reason: '另一原因' })),
    error => error.code === 'VERSION_CONFLICT'
  )
  assert.equal(fake.documents('audit_logs').length, 1)
})

test('驳回事务拒绝越权、非紧邻状态和并发版本变化且不产生部分写入', async t => {
  const cases = [
    ['非当前负责人', rejectionSeed(), rejectionInput({ actor: { _id: 'user-2', status: 'active' } }), 'FORBIDDEN'],
    ['业务线当前指针不匹配', rejectionSeed({ line: { currentNodeId: 'node-3' } }), rejectionInput(), 'REJECTION_NOT_ALLOWED'],
    ['当前节点已完成', rejectionSeed({ current: { status: 'completed' } }), rejectionInput(), 'REJECTION_NOT_ALLOWED'],
    ['新版审核当前节点', rejectionSeed({ current: { workflowMode: 'review' } }), rejectionInput(), 'REJECTION_NOT_ALLOWED'],
    ['上一节点未完成', rejectionSeed({ previous: { status: 'in_progress' } }), rejectionInput(), 'REJECTION_NOT_ALLOWED'],
    ['当前节点版本冲突', rejectionSeed(), rejectionInput({ expectedCurrentVersion: 2 }), 'VERSION_CONFLICT'],
    ['上一节点版本冲突', rejectionSeed(), rejectionInput({ expectedPreviousVersion: 4 }), 'VERSION_CONFLICT']
  ]

  for (const [name, seed, value, code] of cases) {
    await t.test(name, async () => {
      const { fake, repository } = createRepositoryHarness(seed)
      const before = {
        line: fake.documents('business_lines'),
        nodes: fake.documents('business_nodes'),
        audit: fake.documents('audit_logs')
      }
      await assert.rejects(repository.rejectPreviousNode(value), error => error.code === code)
      assert.deepEqual(fake.documents('business_lines'), before.line)
      assert.deepEqual(fake.documents('business_nodes'), before.nodes)
      assert.deepEqual(fake.documents('audit_logs'), before.audit)
    })
  }

  await t.test('账号在路由解析后被停用', async () => {
    const { fake, repository } = createRepositoryHarness(rejectionSeed())
    fake.beforeNextTransaction(() => fake.replace('users', 'user-3', { status: 'disabled' }))
    await assert.rejects(repository.rejectPreviousNode(rejectionInput()), error => error.code === 'FORBIDDEN')
    assert.equal(fake.documents('business_nodes').find(item => item._id === 'node-1').status, 'completed')
    assert.equal(fake.documents('audit_logs').length, 0)
  })

  await t.test('失效账号在节点定位前统一失败关闭', async () => {
    const { fake, repository } = createRepositoryHarness(rejectionSeed({
      current: { _id: 'node-existing' }
    }))
    fake.replace('users', 'user-3', { status: 'disabled' })
    await assert.rejects(
      repository.rejectPreviousNode(rejectionInput({ currentNodeId: 'node-does-not-exist' })),
      error => error.code === 'FORBIDDEN'
    )
    assert.equal(fake.transactionQueries.length, 0)
  })
})

function closureSeed(overrides = {}) {
  return seedDefinition({
    users: overrides.users || [
      { _id: 'manager', status: 'active', role: 'user' },
      { _id: 'member', status: 'active', role: 'user' },
      { _id: 'root', status: 'active', role: 'super_admin' }
    ],
    extra: {
      business_lines: [{
        _id: 'line-close', code: 'BL-20260807-0099', name: '待关闭业务', status: 'active', version: 6,
        managerUserIds: ['manager'], memberUserIds: ['manager', 'member'],
        currentNodeId: 'node-close', currentNodeIndex: 0, currentNodeName: '办理', nodeCount: 1,
        ...(overrides.line || {})
      }],
      business_nodes: [{
        _id: 'node-close', businessLineId: 'line-close', sequence: 0, name: '办理',
        status: 'ready', version: 2, assigneeUserIds: ['member']
      }],
      evidences: [{
        _id: 'evidence-close', businessLineId: 'line-close', nodeId: 'node-close',
        storageStatus: 'available', retentionScope: 'business_line', retentionSource: 'node_feedback',
        purgeDueAt: null, retentionStartedAt: null
      }]
    }
  })
}

test('业务线管理员关闭、取消或逻辑删除进行中业务并设置统一六十天保留期限', async () => {
  for (const outcome of ['cancelled', 'closed', 'deleted']) {
    const { fake, repository } = createRepositoryHarness(closureSeed())
    const result = await repository.closeBusinessLine({
      actor: { _id: 'manager', status: 'active' },
      lineId: 'line-close', expectedVersion: 6, outcome, reason: `转为${outcome}`
    })

    assert.deepEqual(result, { businessLineId: 'line-close', status: outcome, version: 7 })
    const line = fake.documents('business_lines')[0]
    const at = new Date('2026-08-07T02:30:00.000Z')
    assert.equal(line.status, outcome)
    assert.equal(line.version, 7)
    assert.deepEqual(line.frozenAt, at)
    assert.deepEqual(line.retentionStartedAt, at)
    assert.deepEqual(line.purgeDueAt, new Date(at.getTime() + 60 * 24 * 60 * 60 * 1000))
    assert.deepEqual(line[`${outcome}At`], at)
    if (outcome === 'deleted') assert.deepEqual(line.closedAt, at)
    assert.equal(fake.documents('evidences')[0].purgeDueAt, null)
    assert.equal(fake.documents('evidences')[0].retentionStartedAt, null)
    assert.deepEqual(fake.documents('audit_logs').map(item => ({
      actorId: item.actorId, action: item.action, beforeStatus: item.beforeStatus,
      afterStatus: item.afterStatus, reason: item.reason
    })), [{
      actorId: 'manager', action: 'CLOSE_BUSINESS', beforeStatus: 'active',
      afterStatus: outcome, reason: `转为${outcome}`
    }])
  }
})

test('超级管理员可关闭进行中业务，但普通成员、并发旧版本和冻结业务均失败关闭', async t => {
  await t.test('超级管理员', async () => {
    const { repository } = createRepositoryHarness(closureSeed())
    const result = await repository.closeBusinessLine({
      actor: { _id: 'root', status: 'active', role: 'super_admin' },
      lineId: 'line-close', expectedVersion: 6, outcome: 'closed', reason: '管理关闭'
    })
    assert.equal(result.status, 'closed')
  })

  const deniedCases = [
    ['普通成员', closureSeed(), { _id: 'member', status: 'active' }, 6, 'FORBIDDEN'],
    ['旧版本', closureSeed(), { _id: 'manager', status: 'active' }, 5, 'VERSION_CONFLICT'],
    ['已完成', closureSeed({ line: { status: 'completed' } }), { _id: 'manager', status: 'active' }, 6, 'BUSINESS_FROZEN'],
    ['已取消', closureSeed({ line: { status: 'cancelled' } }), { _id: 'root', status: 'active', role: 'super_admin' }, 6, 'BUSINESS_FROZEN']
  ]
  for (const [name, seed, actor, expectedVersion, code] of deniedCases) {
    await t.test(name, async () => {
      const { fake, repository } = createRepositoryHarness(seed)
      await assert.rejects(repository.closeBusinessLine({
        actor, lineId: 'line-close', expectedVersion, outcome: 'closed', reason: '关闭'
      }), error => error.code === code)
      assert.equal(fake.documents('audit_logs').length, 0)
    })
  }

  await t.test('事务内角色降级', async () => {
    const { fake, repository } = createRepositoryHarness(closureSeed())
    fake.beforeNextTransaction(() => fake.replace('users', 'root', { status: 'active', role: 'user' }))
    await assert.rejects(repository.closeBusinessLine({
      actor: { _id: 'root', status: 'active', role: 'super_admin' },
      lineId: 'line-close', expectedVersion: 6, outcome: 'closed', reason: '关闭'
    }), error => error.code === 'FORBIDDEN')
    assert.equal(fake.documents('business_lines')[0].status, 'active')
  })
})

function amendmentSeed(evidenceCount = 2, overrides = {}) {
  return seedDefinition({
    users: [
      { _id: 'root', status: 'active', role: 'super_admin' },
      { _id: 'manager', status: 'active', role: 'user' }
    ],
    extra: {
      business_lines: [{
        _id: 'line-frozen', code: 'BL-20260801-0001', name: '原业务名称', description: '原说明',
        plannedStartDate: '2026-08-01', plannedEndDate: '2026-08-05',
        status: 'completed', version: 9, managerUserIds: ['manager'], memberUserIds: ['manager'],
        currentNodeId: 'node-frozen', currentNodeIndex: 0, currentNodeName: '完成', nodeCount: 1,
        frozenAt: new Date('2026-08-06T01:00:00.000Z'),
        retentionStartedAt: new Date('2026-08-06T01:00:00.000Z'),
        purgeDueAt: new Date('2026-10-05T01:00:00.000Z'),
        ...(overrides.line || {})
      }],
      business_nodes: [{
        _id: 'node-frozen', businessLineId: 'line-frozen', sequence: 0, name: '完成',
        status: 'completed', version: 4, latestFeedbackId: 'feedback-original'
      }],
      node_feedback: [{
        _id: 'feedback-original', businessLineId: 'line-frozen', nodeId: 'node-frozen',
        publishState: 'published', revision: 1, status: 'completed', fieldValues: [{ fieldKey: 'a', value: '原始值' }]
      }],
      evidences: Array.from({ length: evidenceCount }, (_, index) => ({
        _id: `amendment-evidence-${index + 1}`,
        businessLineId: 'line-frozen', nodeId: null, feedbackId: null,
        uploadedBy: 'root', uploadPurpose: 'audit_amendment',
        fileId: `cloud://env/amendment-${index + 1}.pdf`, fileName: `amendment-${index + 1}.pdf`,
        category: 'pdf', size: 1, storageStatus: 'available', attachmentState: 'unattached',
        uploadedAt: new Date(`2026-08-07T00:${String(index % 60).padStart(2, '0')}:00.000Z`),
        orphanExpiresAt: new Date('2026-08-08T02:30:00.000Z'),
        retentionStartedAt: null, purgeDueAt: null, purgedAt: null
      }))
    }
  })
}

function amendmentInput(evidenceCount = 2, overrides = {}) {
  return {
    actor: { _id: 'root', status: 'active', role: 'super_admin' },
    lineId: 'line-frozen', expectedVersion: 9,
    reason: '审计更正业务信息',
    changes: { name: '更正业务名称', description: '更正说明', status: 'closed' },
    evidenceIds: Array.from({ length: evidenceCount }, (_, index) => `amendment-evidence-${index + 1}`),
    ...overrides
  }
}

test('超级管理员修订冻结业务时保存精确前后值且原节点反馈永久不变', async () => {
  const { fake, repository } = createRepositoryHarness(amendmentSeed())
  const originalNodes = fake.documents('business_nodes')
  const originalFeedback = fake.documents('node_feedback')
  const originalPurgeDueAt = fake.documents('business_lines')[0].purgeDueAt

  const result = await repository.amendFrozenBusiness(amendmentInput())

  assert.deepEqual(result, {
    businessLineId: 'line-frozen', amendmentId: 'business-amend-line-frozen-10', version: 10
  })
  const line = fake.documents('business_lines')[0]
  assert.equal(line.name, '更正业务名称')
  assert.equal(line.description, '更正说明')
  assert.equal(line.status, 'closed')
  assert.equal(line.version, 10)
  assert.equal(line.code, 'BL-20260801-0001')
  assert.deepEqual(line.managerUserIds, ['manager'])
  assert.deepEqual(line.purgeDueAt, originalPurgeDueAt)
  assert.deepEqual(fake.documents('business_nodes'), originalNodes)
  assert.deepEqual(fake.documents('node_feedback'), originalFeedback)
  const [audit] = fake.documents('audit_logs')
  assert.equal(audit.publishState, 'published')
  assert.equal(audit.action, 'AMEND_FROZEN_BUSINESS')
  assert.equal(audit.reason, '审计更正业务信息')
  assert.deepEqual(audit.before, {
    name: '原业务名称', description: '原说明', status: 'completed'
  })
  assert.deepEqual(audit.after, {
    name: '更正业务名称', description: '更正说明', status: 'closed'
  })
  const evidences = fake.documents('evidences')
  for (let index = 0; index < evidences.length; index += 1) {
    const evidence = evidences[index]
    const uploadedAt = new Date(`2026-08-07T00:${String(index % 60).padStart(2, '0')}:00.000Z`)
    assert.equal(evidence.amendmentId, audit._id)
    assert.equal(evidence.attachmentState, 'amendment_claimed')
    assert.equal(evidence.retentionScope, 'evidence')
    assert.equal(evidence.retentionSource, 'audit_amendment')
    assert.deepEqual(evidence.retentionStartedAt, uploadedAt)
    assert.deepEqual(evidence.purgeDueAt, new Date(uploadedAt.getTime() + 60 * 24 * 60 * 60 * 1000))
    assert.deepEqual(evidence.amendmentRollbackOrphanExpiresAt, new Date('2026-08-08T02:30:00.000Z'))
    assert.equal(evidence.orphanExpiresAt, null)
  }
  assert.equal(Object.hasOwn(audit, 'claimExpiresAt'), false)
})

test('审计修订附件可跨多个受控事务处理且不设置文件数量上限', async () => {
  const evidenceCount = 105
  const { fake, repository } = createRepositoryHarness(amendmentSeed(evidenceCount))
  const input = amendmentInput(evidenceCount, { changes: {} })

  const first = await repository.amendFrozenBusiness(input)
  const retry = await repository.amendFrozenBusiness(input)

  assert.deepEqual(retry, first)
  assert.equal(fake.documents('evidences').every(item => item.attachmentState === 'amendment_claimed'), true)
  assert.equal(fake.documents('audit_logs').length, 1)
  assert.equal(fake.transactionRuns.every(run => run.operations <= 100), true)
  await assert.rejects(
    repository.amendFrozenBusiness({ ...input, reason: '不同原因' }),
    error => error.code === 'VERSION_CONFLICT'
  )
})

test('同一审计修订并发重试返回相同结果且只发布一次', async () => {
  const optimistic = createOptimisticBusinessDatabase(amendmentSeed(41))
  const repository = createCloudBusinessRepository({
    db: optimistic.db,
    clock: () => new Date('2026-08-07T02:30:00.000Z')
  })
  const input = amendmentInput(41)

  const [first, retry] = await Promise.all([
    repository.amendFrozenBusiness(input),
    repository.amendFrozenBusiness(input)
  ])

  assert.deepEqual(retry, first)
  assert.equal(optimistic.documents('audit_logs').length, 1)
  assert.equal(optimistic.documents('audit_logs')[0].publishState, 'published')
  assert.equal(optimistic.documents('business_lines')[0].version, 10)
  assert.equal(optimistic.documents('evidences').every(item =>
    item.attachmentState === 'amendment_claimed'), true)
  assert.equal(optimistic.metrics.maxActiveCallbacks >= 2, true)
  assert.equal(optimistic.metrics.conflicts > 0, true)
  assert.equal(optimistic.metrics.retries > 0, true)
})

test('审计修订在权限、冻结状态、版本和附件归属变化时失败关闭', async t => {
  const cases = [
    ['非超级管理员', amendmentSeed(), amendmentInput(2, { actor: { _id: 'manager', status: 'active', role: 'user' } }), 'FORBIDDEN'],
    ['业务仍在进行', amendmentSeed(2, { line: { status: 'active' } }), amendmentInput(), 'BUSINESS_FROZEN'],
    ['版本冲突', amendmentSeed(), amendmentInput(2, { expectedVersion: 8 }), 'VERSION_CONFLICT']
  ]
  for (const [name, seed, input, code] of cases) {
    await t.test(name, async () => {
      const { fake, repository } = createRepositoryHarness(seed)
      await assert.rejects(repository.amendFrozenBusiness(input), error => error.code === code)
      assert.equal(fake.documents('audit_logs').length, 0)
      assert.equal(fake.documents('evidences').every(item => item.attachmentState === 'unattached'), true)
    })
  }

  await t.test('附件不属于当前管理员', async () => {
    const seed = amendmentSeed()
    seed.evidences[0].uploadedBy = 'manager'
    const { fake, repository } = createRepositoryHarness(seed)
    await assert.rejects(repository.amendFrozenBusiness(amendmentInput()), error => error.code === 'EVIDENCE_NOT_ATTACHABLE')
    assert.equal(fake.documents('business_lines')[0].version, 9)
    assert.equal(fake.documents('audit_logs')[0].publishState, 'reserved')
  })

  await t.test('附件上传时间缺失、非法或晚于修订时间', async () => {
    for (const uploadedAt of [undefined, 'not-a-date', new Date('2026-08-07T02:30:00.001Z')]) {
      const seed = amendmentSeed()
      seed.evidences[0].uploadedAt = uploadedAt
      const { fake, repository } = createRepositoryHarness(seed)
      await assert.rejects(
        repository.amendFrozenBusiness(amendmentInput()),
        error => error.code === 'EVIDENCE_NOT_ATTACHABLE'
      )
      assert.equal(fake.documents('business_lines')[0].version, 9)
      assert.equal(fake.documents('audit_logs')[0].publishState, 'reserved')
      assert.equal(fake.documents('evidences').every(item => item.attachmentState === 'unattached'), true)
    }
  })

  await t.test('修订附件总量超过二十兆字节', async () => {
    const seed = amendmentSeed()
    seed.evidences[0].size = 10 * 1024 * 1024
    seed.evidences[1].size = 10 * 1024 * 1024 + 1
    const { fake, repository } = createRepositoryHarness(seed)
    await assert.rejects(
      repository.amendFrozenBusiness(amendmentInput()),
      error => error.code === 'FEEDBACK_TOTAL_TOO_LARGE'
    )
    assert.equal(fake.documents('business_lines')[0].version, 9)
    assert.equal(fake.documents('evidences').every(item => item.attachmentState === 'unattached'), true)
  })

  await t.test('分块期间账号被停用', async () => {
    let transactions = 0
    const { fake, repository } = createRepositoryHarness(amendmentSeed(41), {
      afterTransaction: undefined
    })
    const originalRun = fake.db.runTransaction.bind(fake.db)
    fake.db.runTransaction = async callback => {
      transactions += 1
      const result = await originalRun(callback)
      if (transactions === 2) fake.replace('users', 'root', { status: 'disabled', role: 'super_admin' })
      return result
    }
    await assert.rejects(repository.amendFrozenBusiness(amendmentInput(41)), error => error.code === 'FORBIDDEN')
    assert.equal(fake.documents('business_lines')[0].version, 9)
  })
})

test('超级管理员可全局检索冻结业务并读取脱敏修订历史，普通账号失败关闭', async () => {
  const seed = seedDefinition({
    users: [
      { _id: 'root', status: 'active', role: 'super_admin' },
      { _id: 'member', status: 'active', role: 'user' }
    ],
    extra: {
      business_lines: [
        { _id: 'line-completed', code: 'YW-20260810-0001', name: '冻结开户业务', description: '说明', status: 'completed', version: 4, progress: 100, currentNodeId: 'node-completed', nodeCount: 1, updatedAt: new Date('2026-08-10T02:00:00.000Z') },
        { _id: 'line-deleted', code: 'YW-20260809-0001', name: '已删除归档', description: '', status: 'deleted', version: 3, progress: 20, currentNodeId: 'node-deleted', nodeCount: 1, updatedAt: new Date('2026-08-09T02:00:00.000Z') },
        { _id: 'line-active', code: 'YW-20260808-0001', name: '进行中业务', status: 'active', version: 2, updatedAt: new Date('2026-08-08T02:00:00.000Z') }
      ],
      business_nodes: [
        { _id: 'node-completed', businessLineId: 'line-completed', nodeCode: 'YW-20260810-0001-N001', sequence: 0, name: '完成', status: 'completed', version: 2, assigneeUserIds: ['secret-assignee'] },
        { _id: 'node-deleted', businessLineId: 'line-deleted', nodeCode: 'YW-20260809-0001-N001', sequence: 0, name: '归档', status: 'in_progress', version: 2 }
      ],
      audit_logs: [{
        _id: 'business-amend-line-completed-4', actorId: 'root-secret', action: 'AMEND_FROZEN_BUSINESS',
        targetType: 'business_line', targetId: 'line-completed', reason: '审计修订',
        before: { description: '旧说明' }, after: { description: '说明' },
        beforeVersion: 3, afterVersion: 4, publishState: 'published',
        inputHash: 'secret-hash', publishedAt: new Date('2026-08-10T01:00:00.000Z')
      }],
      evidences: [{
        _id: 'evidence-amend', businessLineId: 'line-completed', nodeId: null,
        amendmentId: 'business-amend-line-completed-4', fileId: 'cloud://secret-file',
        fileName: '更正材料.pdf', category: 'pdf', size: 123,
        storageStatus: 'available', retentionScope: 'evidence', retentionSource: 'audit_amendment'
      }]
    }
  })
  const { repository } = createRepositoryHarness(seed)
  const actor = { _id: 'root', status: 'active', role: 'super_admin' }
  const list = await repository.listFrozenBusinessesForAdmin({ actor, query: { keyword: '冻结', page: 1, pageSize: 10 } })
  assert.equal(list.total, 1)
  assert.deepEqual(list.items.map(item => item._id), ['line-completed'])
  assert.equal(Object.hasOwn(list.items[0], 'managerUserIds'), false)

  const detail = await repository.getFrozenBusinessForAdmin({ actor, lineId: 'line-completed' })
  assert.equal(detail.line._id, 'line-completed')
  assert.equal(detail.nodes[0].nodeCode, 'YW-20260810-0001-N001')
  assert.equal(Object.hasOwn(detail.nodes[0], 'assigneeUserIds'), false)
  assert.deepEqual(detail.amendments[0].before, { description: '旧说明' })
  assert.deepEqual(detail.amendments[0].evidences, [{
    evidenceId: 'evidence-amend', fileName: '更正材料.pdf', category: 'pdf', size: 123,
    storageStatus: 'available'
  }])
  assert.equal(Object.hasOwn(detail.amendments[0], 'actorId'), false)
  assert.equal(JSON.stringify(detail).includes('secret-hash'), false)
  assert.equal(JSON.stringify(detail).includes('secret-file'), false)

  await assert.rejects(
    repository.listFrozenBusinessesForAdmin({ actor: { _id: 'member', status: 'active', role: 'user' }, query: { keyword: '', page: 1, pageSize: 10 } }),
    error => error.code === 'FORBIDDEN'
  )
})
