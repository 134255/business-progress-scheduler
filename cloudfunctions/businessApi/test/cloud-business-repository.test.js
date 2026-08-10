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
    assigneeUserIds: ['user-2'],
    slaWorkHours: 8,
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
      assigneeUserIds: ['user-3'], requiresEvidence: true,
      allowedEvidenceTypes: ['pdf', 'mp4']
    })
  ]
  return {
    users: overrides.users || [
      { _id: 'user-1', status: 'active' },
      { _id: 'user-2', status: 'active' },
      { _id: 'user-3', status: 'active' }
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
  const fake = createFakeCloudDatabase(seed)
  const repository = createCloudBusinessRepository({
    db: fake.db,
    clock: () => new Date('2026-08-07T02:30:00.000Z'),
    ...options
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
  assert.deepEqual(line.memberUserIds, ['user-1', 'user-2', 'user-3'])
  assert.equal(line.currentNodeId, nodes[0]._id)
  assert.equal(line.currentNodeName, '启动')
  assert.equal(line.nodeCount, 2)
  assert.equal(line.version, 1)
  assert.deepEqual(nodes.map(node => node.nodeCode), [
    'BL-20260807-0001-N001', 'BL-20260807-0001-N002'
  ])
  assert.deepEqual(nodes.map(node => node.status), ['ready', 'waiting'])
  assert.equal(nodes[0].sourceTemplateNodeKey, 'node-a')
  assert.deepEqual(nodes[0].fieldDefinitions, source.nodes[0].fields)
  assert.notEqual(nodes[0].fieldDefinitions, source.nodes[0].fields)
  source.nodes[0].fields[0].name = '后续模板变化'
  assert.equal(fake.documents('business_nodes')[0].fieldDefinitions[0].name, '摘要')
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

test('snapshot transaction revalidates enabled template and active assignees and leaves no partial data', async t => {
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

  await t.test('assignee disabled after the service read', async () => {
    const { fake, repository } = createRepositoryHarness()
    const source = await definition(repository)
    fake.beforeNextTransaction(() => fake.replace('users', 'user-2', { status: 'disabled' }))
    await assert.rejects(repository.createBusinessSnapshot({
      actor: { _id: 'user-1' }, input: input(), definition: source
    }), error => error.code === 'ASSIGNEE_INACTIVE')
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
    assigneeUserIds: [`assignee-${index % 47}`]
  }))
  const users = [{ _id: 'user-1', status: 'active' }].concat(nodes.map((node, index) => ({
    _id: `assignee-${index}`, status: 'active'
  })))
  const { fake, repository } = createRepositoryHarness(seedDefinition({ nodes, users }))

  await assert.rejects(repository.createBusinessSnapshot({
    actor: { _id: 'user-1' }, input: input(), definition: await definition(repository)
  }), error => error.code === 'TEMPLATE_LIMIT_EXCEEDED' &&
    /snapshot transaction operation budget/i.test(error.message) &&
    !/at most 48 nodes/i.test(error.message))
  assert.equal(fake.transactionRuns.length, 0)
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
          status: 'ready', assigneeIds: ['wx-user-1'], assigneeNames: ['旧用户']
        }
      ]
    }
  })
  const { repository } = createRepositoryHarness(seed)
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
