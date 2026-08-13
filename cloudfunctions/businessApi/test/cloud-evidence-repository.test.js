const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createCloudEvidenceRepository,
  effectiveAllowedEvidenceTypes,
  hasOwnAccountRelationship
} = require('../lib/cloud-evidence-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const NOW = new Date('2026-08-07T00:00:00.000Z')
const PDF_BYTES = Buffer.from('%PDF-safe-fixture')

function assertCode(code) {
  return error => error && error.code === code
}

function seed(overrides = {}) {
  return {
    users: [{ _id: 'account-1', status: 'active', openid: 'wx-current' }],
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerUserIds: ['account-owner'], memberUserIds: ['account-1', 'account-owner']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      assigneeUserIds: ['account-1'], allowedEvidenceTypes: ['pdf']
    }],
    evidences: [],
    ...overrides
  }
}

function createHarness({ documents = seed(), download, temporary, idFactory, transformRead } = {}) {
  const fake = createFakeCloudDatabase(documents, { transformRead })
  const calls = []
  const cloud = {
    async downloadFile(input) {
      calls.push(['downloadFile', input, fake.transactionRuns.length])
      if (download) return download(input, fake)
      return { fileContent: PDF_BYTES }
    },
    async getTempFileURL(input) {
      calls.push(['getTempFileURL', input])
      if (temporary) return temporary(input, fake)
      return {
        fileList: [{
          fileID: input.fileList[0].fileID,
          tempFileURL: 'https://temporary.example/report.pdf',
          status: 0
        }]
      }
    }
  }
  return {
    calls,
    fake,
    repository: createCloudEvidenceRepository({
      db: fake.db,
      cloud,
      clock: () => new Date(NOW),
      idFactory: idFactory || (() => 'evidence-1'),
      temporaryUrlTtlSeconds: 300
    })
  }
}

function registration(overrides = {}) {
  return {
    actor: { _id: 'account-1', status: 'active', openid: 'wx-current' },
    input: {
      businessLineId: 'business-1', nodeId: 'node-1',
      fileId: 'cloud://test-env/evidence/report.pdf',
      fileName: 'report.PDF', declaredSize: PDF_BYTES.length,
      ...overrides
    }
  }
}

test('authorizes before download, inspects bytes, and stores secret-free unattached metadata', async () => {
  const harness = createHarness()
  const result = await harness.repository.registerUpload(registration())

  assert.deepEqual(harness.calls[0], [
    'downloadFile', { fileID: 'cloud://test-env/evidence/report.pdf' }, 1
  ])
  assert.equal(result.evidenceId, 'evidence-1')
  assert.deepEqual(result.metadata, {
    fileName: 'report.PDF', category: 'pdf', extension: 'pdf', size: PDF_BYTES.length,
    storageStatus: 'available', orphanExpiresAt: new Date('2026-08-08T00:00:00.000Z')
  })
  assert.equal(Object.hasOwn(result.metadata, 'fileId'), false)
  assert.equal(Object.hasOwn(result.metadata, 'sha256'), false)

  const stored = harness.fake.documents('evidences')[0]
  assert.deepEqual({
    id: stored._id,
    businessLineId: stored.businessLineId,
    nodeId: stored.nodeId,
    feedbackId: stored.feedbackId,
    fileId: stored.fileId,
    fileName: stored.fileName,
    category: stored.category,
    extension: stored.extension,
    mimeType: stored.mimeType,
    size: stored.size,
    storageStatus: stored.storageStatus,
    uploadedBy: stored.uploadedBy,
    orphanExpiresAt: stored.orphanExpiresAt
  }, {
    id: 'evidence-1', businessLineId: 'business-1', nodeId: 'node-1', feedbackId: null,
    fileId: 'cloud://test-env/evidence/report.pdf', fileName: 'report.PDF', category: 'pdf',
    extension: 'pdf', mimeType: 'application/pdf', size: PDF_BYTES.length,
    storageStatus: 'available', uploadedBy: 'account-1',
    orphanExpiresAt: new Date('2026-08-08T00:00:00.000Z')
  })
  assert.match(stored.sha256, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(stored), /wx-current/)
})

test('超级管理员可在冻结业务上传独立修订附件且普通反馈规则不会被复用', async () => {
  const documents = seed({
    users: [{ _id: 'root', status: 'active', role: 'super_admin' }],
    business_lines: [{
      _id: 'business-1', status: 'completed', version: 4,
      managerUserIds: [], memberUserIds: []
    }],
    business_nodes: []
  })
  const harness = createHarness({ documents })
  const result = await harness.repository.registerUpload({
    actor: { _id: 'root', status: 'active', role: 'super_admin' },
    input: {
      businessLineId: 'business-1', nodeId: null, purpose: 'audit_amendment',
      fileId: 'cloud://test-env/amendments/report.pdf',
      fileName: 'report.PDF', declaredSize: PDF_BYTES.length
    }
  })

  assert.equal(result.evidenceId, 'evidence-1')
  const stored = harness.fake.documents('evidences')[0]
  assert.equal(stored.nodeId, null)
  assert.equal(stored.feedbackId, null)
  assert.equal(stored.uploadPurpose, 'audit_amendment')
  assert.equal(stored.attachmentState, 'unattached')
  assert.equal(stored.retentionScope, null)
  assert.equal(stored.retentionSource, null)

  for (const item of [
    {
      users: [{ _id: 'root', status: 'active', role: 'user' }],
      lineStatus: 'completed', code: 'FORBIDDEN'
    },
    {
      users: [{ _id: 'root', status: 'active', role: 'super_admin' }],
      lineStatus: 'active', code: 'BUSINESS_FROZEN'
    }
  ]) {
    const denied = createHarness({ documents: seed({
      users: item.users,
      business_lines: [{
        _id: 'business-1', status: item.lineStatus,
        managerUserIds: [], memberUserIds: []
      }],
      business_nodes: []
    }) })
    await assert.rejects(denied.repository.registerUpload({
      actor: { _id: 'root', status: 'active', role: 'super_admin' },
      input: {
        businessLineId: 'business-1', nodeId: null, purpose: 'audit_amendment',
        fileId: 'cloud://test-env/amendments/report.pdf',
        fileName: 'report.PDF', declaredSize: PDF_BYTES.length
      }
    }), assertCode(item.code))
    assert.equal(denied.calls.length, 0)
  }
})

test('底层凭证仓库拒绝未知上传用途', async () => {
  const harness = createHarness()

  await assert.rejects(harness.repository.registerUpload(registration({
    purpose: 'unknown-purpose'
  })), assertCode('EVIDENCE_NOT_ATTACHABLE'))

  assert.equal(harness.calls.length, 0)
})

test('denies unauthorized or non-current registration before any cloud download', async t => {
  const cases = [
    {
      name: 'inactive actor',
      documents: seed({ users: [{ _id: 'account-1', status: 'disabled', openid: 'wx-current' }] }),
      code: 'FORBIDDEN'
    },
    {
      name: 'not a business member',
      documents: seed({ business_lines: [{
        _id: 'business-1', status: 'active', currentNodeId: 'node-1',
        managerUserIds: ['account-owner'], memberUserIds: ['someone-else']
      }] }),
      code: 'FORBIDDEN'
    },
    {
      name: 'not an assignee or owner',
      documents: seed({ business_nodes: [{
        _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
        assigneeUserIds: ['someone-else'], allowedEvidenceTypes: ['pdf']
      }] }),
      code: 'FORBIDDEN'
    },
    {
      name: 'wrong node relationship',
      documents: seed({ business_nodes: [{
        _id: 'node-1', businessLineId: 'business-other', sequence: 0, status: 'ready',
        assigneeUserIds: ['account-1'], allowedEvidenceTypes: ['pdf']
      }] }),
      code: 'NOT_FOUND'
    },
    {
      name: 'non-current node',
      documents: seed({ business_lines: [{
        _id: 'business-1', status: 'active', currentNodeId: 'node-other',
        managerUserIds: ['account-owner'], memberUserIds: ['account-1']
      }] }),
      code: 'NODE_NOT_ACTIVE'
    },
    {
      name: 'completed node',
      documents: seed({ business_nodes: [{
        _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'completed',
        assigneeUserIds: ['account-1'], allowedEvidenceTypes: ['pdf']
      }] }),
      code: 'NODE_NOT_ACTIVE'
    }
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      const harness = createHarness({ documents: item.documents })
      await assert.rejects(harness.repository.registerUpload(registration()), assertCode(item.code))
      assert.deepEqual(harness.calls, [])
      assert.equal(harness.fake.documents('evidences').length, 0)
    })
  }
})

test('denies creating, deleted, and frozen business states before download', async () => {
  for (const { status, code } of [
    { status: 'creating', code: 'NOT_FOUND' },
    { status: 'deleted', code: 'BUSINESS_FROZEN' },
    { status: 'completed', code: 'BUSINESS_FROZEN' },
    { status: 'cancelled', code: 'BUSINESS_FROZEN' },
    { status: 'closed', code: 'BUSINESS_FROZEN' }
  ]) {
    const documents = seed()
    documents.business_lines[0].status = status
    const harness = createHarness({ documents })
    await assert.rejects(harness.repository.registerUpload(registration()), assertCode(code))
    assert.deepEqual(harness.calls, [])
  }
})

test('permits an active account-ID business owner on the current node', async () => {
  const documents = seed()
  documents.business_lines[0].managerUserIds = ['account-1']
  documents.business_nodes[0].assigneeUserIds = ['someone-else']
  const harness = createHarness({ documents })
  assert.equal((await harness.repository.registerUpload(registration())).evidenceId, 'evidence-1')
})

test('新版审核业务快照只允许当前处理人登记凭证且后续成员访问保持可用', async () => {
  const documents = seed({
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['reviewer-1'],
      reviewMode: 'any', allowedEvidenceTypes: ['pdf']
    }]
  })
  const harness = createHarness({ documents })

  const registered = await harness.repository.registerUpload(registration())
  assert.equal(registered.evidenceId, 'evidence-1')
  assert.equal((await harness.repository.getAccessGrant({
    actor: { _id: 'account-1' }, evidenceId: 'evidence-1'
  })).url, 'https://temporary.example/report.pdf')
})

test('新版审核节点混入旧负责人或损坏角色关系时登记失败关闭', async () => {
  for (const node of [
    {
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['reviewer-1'],
      assigneeUserIds: ['account-1']
    },
    {
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: ['account-1']
    },
    {
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: null
    },
    {
      workflowMode: 'unknown', processorUserIds: ['account-1'], reviewerUserIds: ['reviewer-1']
    }
  ]) {
    const harness = createHarness({ documents: seed({
      business_nodes: [{
        _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
        allowedEvidenceTypes: ['pdf'], ...node
      }]
    }) })
    await assert.rejects(harness.repository.registerUpload(registration()), assertCode('FORBIDDEN'))
    assert.deepEqual(harness.calls, [])
  }
})

test('业务负责人也不能绕过损坏的新版审核关系', async () => {
  const documents = seed({
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerUserIds: ['account-1'], memberUserIds: ['account-1']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      workflowMode: 'review', processorUserIds: ['account-1'], reviewerUserIds: null,
      allowedEvidenceTypes: ['pdf']
    }]
  })
  const harness = createHarness({ documents })
  await assert.rejects(harness.repository.registerUpload(registration()), assertCode('FORBIDDEN'))
  assert.deepEqual(harness.calls, [])
})

test('声明审核模式的节点绝不回退到纯旧OpenID负责人授权', async () => {
  const documents = seed({
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeId: 'node-1', currentNodeIndex: 0,
      managerIds: ['wx-owner'], memberIds: ['wx-current', 'wx-owner']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      workflowMode: 'review', assigneeIds: ['wx-current'], evidenceTypes: ['pdf']
    }]
  })
  const harness = createHarness({ documents })
  await assert.rejects(harness.repository.registerUpload(registration()), assertCode('FORBIDDEN'))
  assert.deepEqual(harness.calls, [])
})

test('new-schema records never fall back to legacy OpenID memberships or assignees', async () => {
  const documents = seed({
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeId: 'node-1',
      managerUserIds: null, memberUserIds: null,
      managerIds: ['wx-current'], memberIds: ['wx-current']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      assigneeUserIds: null, assigneeIds: ['wx-current'], allowedEvidenceTypes: ['pdf']
    }]
  })
  const harness = createHarness({ documents })
  await assert.rejects(harness.repository.registerUpload(registration()), assertCode('FORBIDDEN'))
  assert.deepEqual(harness.calls, [])
})

test('own account relationship keys are detected on any record without prototype inheritance', () => {
  for (const value of [
    { managerUserIds: [] },
    { watcherUserIds: null },
    { ownerUserId: 'account-1' }
  ]) {
    assert.equal(hasOwnAccountRelationship(value), true)
  }

  const inherited = Object.create({ watcherUserIds: ['stale-account'] })
  inherited.memberIds = ['wx-current']
  assert.equal(hasOwnAccountRelationship(inherited), false)
  assert.equal(hasOwnAccountRelationship(null), false)
})

test('line-level account relationship presence disables legacy fallback for registration and access', async () => {
  for (const lineRelationship of [
    { watcherUserIds: null },
    { ownerUserId: 'account-1' }
  ]) {
    const documents = seed({
      business_lines: [{
        _id: 'business-1', status: 'active', currentNodeIndex: 0,
        managerIds: ['wx-current'], memberIds: ['wx-current'],
        ...lineRelationship
      }],
      business_nodes: [{
        _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
        assigneeIds: ['wx-current'], evidenceTypes: ['pdf']
      }],
      evidences: [accessibleEvidence()]
    })

    const registrationHarness = createHarness({ documents })
    await assert.rejects(
      registrationHarness.repository.registerUpload(registration()),
      assertCode('FORBIDDEN')
    )
    assert.deepEqual(registrationHarness.calls, [])
    assert.equal(registrationHarness.fake.documents('evidences').length, 1)

    const accessHarness = createHarness({ documents })
    await assert.rejects(accessHarness.repository.getAccessGrant({
      actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
    }), assertCode('FORBIDDEN'))
    assert.deepEqual(accessHarness.calls, [])
  }
})

test('legacy fallback requires wholly legacy membership and the current binding', async () => {
  const documents = seed({
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeIndex: 0,
      managerIds: [], memberIds: ['wx-current']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'in_progress',
      assigneeIds: ['wx-current'], evidenceTypes: ['pdf']
    }]
  })
  const harness = createHarness({ documents })
  assert.equal((await harness.repository.registerUpload(registration())).evidenceId, 'evidence-1')

  documents.users[0].openid = 'wx-rebound'
  const rebound = createHarness({ documents })
  await assert.rejects(rebound.repository.registerUpload(registration()), assertCode('FORBIDDEN'))
  assert.deepEqual(rebound.calls, [])
})

test('any node account relationship field disables legacy OpenID fallback before cloud egress', async () => {
  for (const nodeRelationships of [
    { assigneeUserIds: null, assigneeIds: ['wx-current'] },
    { watcherUserIds: [], assigneeIds: ['wx-current'] },
    { ownerUserIds: ['someone-else'], assigneeIds: ['wx-current'] }
  ]) {
    const documents = seed({
      business_lines: [{
        _id: 'business-1', status: 'active', currentNodeIndex: 0,
        managerIds: [], memberIds: ['wx-current']
      }],
      business_nodes: [{
        _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
        evidenceTypes: ['pdf'],
        ...nodeRelationships
      }]
    })
    const harness = createHarness({ documents })
    await assert.rejects(harness.repository.registerUpload(registration()), assertCode('FORBIDDEN'))
    assert.deepEqual(harness.calls, [])
    assert.equal(harness.fake.documents('evidences').length, 0)
  }
})

test('business owners follow the selected relationship schema explicitly', async () => {
  const legacyDocuments = seed({
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeIndex: 0,
      managerIds: ['wx-current'], memberIds: []
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      assigneeIds: ['someone-else'], evidenceTypes: ['pdf']
    }]
  })
  const legacy = createHarness({ documents: legacyDocuments })
  assert.equal((await legacy.repository.registerUpload(registration())).evidenceId, 'evidence-1')

  legacyDocuments.business_nodes[0].assigneeUserIds = null
  const mixed = createHarness({ documents: legacyDocuments })
  await assert.rejects(mixed.repository.registerUpload(registration()), assertCode('FORBIDDEN'))
  assert.deepEqual(mixed.calls, [])
  assert.equal(mixed.fake.documents('evidences').length, 0)
})

test('rejects external or malformed file IDs without invoking the cloud adapter', async () => {
  for (const fileId of [
    'https://attacker.example/file.pdf', 'http://attacker.example/file.pdf',
    'cloud://test-env/../secret.pdf', 'cloud://test-env/file.pdf?url=https://attacker.example',
    'cloud://test-env//file.pdf'
  ]) {
    const harness = createHarness()
    await assert.rejects(
      harness.repository.registerUpload(registration({ fileId })),
      assertCode('EVIDENCE_NOT_ATTACHABLE')
    )
    assert.deepEqual(harness.calls, [])
  }
})

test('rejects a declared size above 20 MB before authorization or cloud download', async () => {
  const harness = createHarness()
  await assert.rejects(harness.repository.registerUpload(registration({
    declaredSize: 20 * 1024 * 1024 + 1
  })), assertCode('FILE_TOO_LARGE'))
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.fake.transactionRuns.length, 0)
  assert.equal(harness.fake.documents('evidences').length, 0)
})

test('optional evidence nodes with an empty allowlist accept every supported signed format', async () => {
  for (const fixture of [
    { extension: 'jpg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]) },
    { extension: 'jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]) },
    { extension: 'png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { extension: 'pdf', bytes: Buffer.from('%PDF-safe-fixture') },
    { extension: 'mp4', bytes: Buffer.from('0000ftyp0000') },
    { extension: 'mov', bytes: Buffer.from('0000ftyp0000') },
    { extension: 'm4v', bytes: Buffer.from('0000ftyp0000') }
  ]) {
    const documents = seed({ business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      assigneeUserIds: ['account-1'], requiresEvidence: false, allowedEvidenceTypes: []
    }] })
    const harness = createHarness({
      documents,
      download: async () => ({ fileContent: fixture.bytes })
    })

    const result = await harness.repository.registerUpload(registration({
      fileName: `evidence.${fixture.extension}`,
      declaredSize: fixture.bytes.length
    }))

    assert.equal(result.metadata.extension, fixture.extension)
    assert.equal(harness.fake.documents('evidences')[0].extension, fixture.extension)
  }
})

test('a non-empty optional allowlist remains a strict evidence-type restriction', async () => {
  const documents = seed({ business_nodes: [{
    _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
    assigneeUserIds: ['account-1'], requiresEvidence: false, allowedEvidenceTypes: ['pdf']
  }] })
  const pdf = createHarness({ documents })
  assert.equal((await pdf.repository.registerUpload(registration())).metadata.extension, 'pdf')

  const jpg = createHarness({
    documents: seed({ business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
      assigneeUserIds: ['account-1'], requiresEvidence: false, allowedEvidenceTypes: ['pdf']
    }] }),
    download: async () => ({ fileContent: Buffer.from([0xff, 0xd8, 0xff, 0x00]) })
  })
  await assert.rejects(jpg.repository.registerUpload(registration({
    fileName: 'photo.jpg', declaredSize: 4
  })), assertCode('UNSUPPORTED_FILE_TYPE'))
  assert.equal(jpg.fake.documents('evidences').length, 0)
})

test('required evidence with an empty allowlist fails before download or persistence', async () => {
  const harness = createHarness({ documents: seed({ business_nodes: [{
    _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
    assigneeUserIds: ['account-1'], requiresEvidence: true, allowedEvidenceTypes: []
  }] }) })

  await assert.rejects(harness.repository.registerUpload(registration()), assertCode('UNSUPPORTED_FILE_TYPE'))
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.fake.documents('evidences').length, 0)
})

test('effective evidence allowlists fail closed for malformed own data and inherited or accessor fields', () => {
  const malformed = [
    { allowedEvidenceTypes: 'pdf' },
    { allowedEvidenceTypes: ['pdf', 'pdf'] },
    { allowedEvidenceTypes: ['exe'] },
    Object.defineProperty({}, 'allowedEvidenceTypes', { get: () => ['pdf'], enumerable: true }),
    Object.create({ allowedEvidenceTypes: ['pdf'] })
  ]

  for (const node of malformed) {
    assert.throws(() => effectiveAllowedEvidenceTypes(node, true), assertCode('UNSUPPORTED_FILE_TYPE'))
  }
  assert.throws(() => effectiveAllowedEvidenceTypes({
    allowedEvidenceTypes: ['pdf'], requiresEvidence: 'false'
  }, true), assertCode('UNSUPPORTED_FILE_TYPE'))
  assert.deepEqual(effectiveAllowedEvidenceTypes({
    allowedEvidenceTypes: [], requiresEvidence: false
  }, true), ['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])
})

test('effective evidence allowlists reject inherited or accessor requiresEvidence', () => {
  const inherited = Object.assign(Object.create({ requiresEvidence: true }), {
    allowedEvidenceTypes: []
  })
  const accessor = Object.defineProperty({ allowedEvidenceTypes: [] }, 'requiresEvidence', {
    get: () => true,
    enumerable: true
  })

  for (const node of [inherited, accessor]) {
    assert.throws(() => effectiveAllowedEvidenceTypes(node, true), assertCode('UNSUPPORTED_FILE_TYPE'))
  }
})

test('registration rejects inherited or accessor requiresEvidence before download or persistence', async () => {
  for (const shape of ['inherited', 'accessor']) {
    const harness = createHarness({
      documents: seed({ business_nodes: [{
        _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
        assigneeUserIds: ['account-1'], allowedEvidenceTypes: []
      }] }),
      transformRead: ({ collection, data }) => {
        if (collection !== 'business_nodes') return data
        if (shape === 'inherited') {
          return Object.assign(Object.create({ requiresEvidence: true }), data)
        }
        return Object.defineProperty(data, 'requiresEvidence', {
          get: () => true,
          enumerable: true
        })
      }
    })

    await assert.rejects(harness.repository.registerUpload(registration()), assertCode('UNSUPPORTED_FILE_TYPE'))
    assert.deepEqual(harness.calls, [])
    assert.equal(harness.fake.documents('evidences').length, 0)
  }
})

test('registration reauthorizes the effective allowlist before evidence metadata is written', async () => {
  const documents = seed({ business_nodes: [{
    _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'ready',
    assigneeUserIds: ['account-1'], requiresEvidence: false, allowedEvidenceTypes: []
  }] })
  const harness = createHarness({
    documents,
    download: async (input, fake) => {
      fake.replace('business_nodes', 'node-1', {
        businessLineId: 'business-1', sequence: 0, status: 'ready', assigneeUserIds: ['account-1'],
        requiresEvidence: false, allowedEvidenceTypes: ['pdf']
      })
      return { fileContent: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }
    }
  })

  await assert.rejects(harness.repository.registerUpload(registration({
    fileName: 'photo.jpg', declaredSize: 4
  })), assertCode('UNSUPPORTED_FILE_TYPE'))
  assert.equal(harness.fake.documents('evidences').length, 0)
})

test('rejects spoofed, disallowed, mismatched, oversized, or malformed downloads without a record', async () => {
  const downloads = [
    { bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]), input: {}, code: 'UNSUPPORTED_FILE_TYPE' },
    { bytes: PDF_BYTES, input: { fileName: 'report.jpg' }, code: 'UNSUPPORTED_FILE_TYPE' },
    { bytes: PDF_BYTES, input: { declaredSize: PDF_BYTES.length - 1 }, code: 'EVIDENCE_NOT_ATTACHABLE' },
    { bytes: Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(20 * 1024 * 1024 - 3)]), input: {}, code: 'FILE_TOO_LARGE' },
    { bytes: new Uint8Array(PDF_BYTES), input: {}, code: 'UNSUPPORTED_FILE_TYPE' }
  ]
  for (const item of downloads) {
    const harness = createHarness({ download: async () => ({ fileContent: item.bytes }) })
    const request = registration({ declaredSize: item.bytes.length, ...item.input })
    await assert.rejects(harness.repository.registerUpload(request), assertCode(item.code))
    assert.equal(harness.fake.documents('evidences').length, 0)
  }
})

test('download failures and authorization changes before persistence leave no metadata record', async () => {
  const failed = createHarness({ download: async () => { throw new Error('cloud download failed') } })
  await assert.rejects(failed.repository.registerUpload(registration()), /cloud download failed/)
  assert.equal(failed.fake.documents('evidences').length, 0)

  const changed = createHarness({
    download: async (input, fake) => {
      fake.replace('business_nodes', 'node-1', {
        businessLineId: 'business-1', sequence: 0, status: 'completed',
        assigneeUserIds: ['account-1'], allowedEvidenceTypes: ['pdf']
      })
      return { fileContent: PDF_BYTES }
    }
  })
  await assert.rejects(changed.repository.registerUpload(registration()), assertCode('NODE_NOT_ACTIVE'))
  assert.equal(changed.fake.documents('evidences').length, 0)
})

test('a generated evidence id collision never overwrites existing immutable metadata', async () => {
  const existing = accessibleEvidence({ fileName: 'original.pdf' })
  const harness = createHarness({ documents: seed({ evidences: [existing] }) })
  await assert.rejects(harness.repository.registerUpload(registration()), assertCode('EVIDENCE_NOT_ATTACHABLE'))
  assert.deepEqual(harness.fake.documents('evidences'), [existing])
})

function accessibleEvidence(overrides = {}) {
  return {
    _id: 'evidence-1', businessLineId: 'business-1', nodeId: 'node-1', feedbackId: null,
    fileId: 'cloud://test-env/evidence/report.pdf', fileName: 'report.pdf', category: 'pdf',
    extension: 'pdf', size: 100, storageStatus: 'available',
    orphanExpiresAt: new Date('2026-08-08T00:00:00.000Z'),
    ...overrides
  }
}

function attachedEvidence(overrides = {}) {
  return accessibleEvidence({
    feedbackId: 'feedback-1', feedbackRevision: 1, attachmentState: 'attached',
    retentionScope: 'business_line', retentionSource: 'node_feedback',
    orphanExpiresAt: null, purgeDueAt: null,
    ...overrides
  })
}

test('issues only a short-lived safe access projection to active business members', async () => {
  const documents = seed({ evidences: [accessibleEvidence()] })
  const harness = createHarness({ documents })
  const result = await harness.repository.getAccessGrant({
    actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
  })

  assert.deepEqual(harness.calls, [[
    'getTempFileURL', {
      fileList: [{ fileID: 'cloud://test-env/evidence/report.pdf', maxAge: 300 }]
    }
  ]])
  assert.deepEqual(result, {
    url: 'https://temporary.example/report.pdf', fileName: 'report.pdf', category: 'pdf',
    expiresAt: new Date('2026-08-07T00:05:00.000Z')
  })
  assert.equal(Object.hasOwn(result, 'fileId'), false)
  assert.equal(Object.hasOwn(result, 'sha256'), false)
})

test('access also denies legacy membership fallback when the evidence node has account relationships', async () => {
  const documents = seed({
    business_lines: [{
      _id: 'business-1', status: 'active', currentNodeIndex: 0,
      managerIds: [], memberIds: ['wx-current']
    }],
    business_nodes: [{
      _id: 'node-1', businessLineId: 'business-1', sequence: 0, status: 'completed',
      assigneeUserIds: null, assigneeIds: ['wx-current'], evidenceTypes: ['pdf']
    }],
    evidences: [accessibleEvidence()]
  })
  const harness = createHarness({ documents })
  await assert.rejects(harness.repository.getAccessGrant({
    actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
  }), assertCode('FORBIDDEN'))
  assert.deepEqual(harness.calls, [])
})

test('denies unavailable, expired, purged, malformed, and unauthorized evidence before temp URL issuance', async () => {
  const cases = [
    { evidence: accessibleEvidence({ storageStatus: 'purged', purgedAt: NOW }), code: 'EVIDENCE_EXPIRED' },
    { evidence: accessibleEvidence({ storageStatus: 'purge_pending' }), code: 'EVIDENCE_EXPIRED' },
    { evidence: accessibleEvidence({ orphanExpiresAt: NOW }), code: 'EVIDENCE_EXPIRED' },
    { evidence: accessibleEvidence({ orphanExpiresAt: null, purgeDueAt: NOW }), code: 'EVIDENCE_EXPIRED' },
    { evidence: accessibleEvidence({ orphanExpiresAt: 'not-a-date' }), code: 'EVIDENCE_EXPIRED' },
    { evidence: accessibleEvidence({ orphanExpiresAt: null, purgeDueAt: 'not-a-date' }), code: 'EVIDENCE_EXPIRED' },
    { evidence: accessibleEvidence({ fileId: 'https://attacker.example/file' }), code: 'EVIDENCE_EXPIRED' }
  ]
  for (const item of cases) {
    const harness = createHarness({ documents: seed({ evidences: [item.evidence] }) })
    await assert.rejects(harness.repository.getAccessGrant({
      actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
    }), assertCode(item.code))
    assert.deepEqual(harness.calls, [])
  }

  const documents = seed({ evidences: [accessibleEvidence()] })
  documents.business_lines[0].memberUserIds = ['someone-else']
  const forbidden = createHarness({ documents })
  await assert.rejects(forbidden.repository.getAccessGrant({
    actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
  }), assertCode('FORBIDDEN'))
  assert.deepEqual(forbidden.calls, [])
})

test('only null or undefined timestamps are absent and every malformed present timestamp fails closed', async () => {
  const malformedValues = [
    false,
    0,
    '',
    {},
    [],
    new Date(Number.NaN),
    'not-a-date'
  ]
  for (const field of ['orphanExpiresAt', 'purgeDueAt', 'purgedAt']) {
    for (const value of malformedValues) {
      const evidence = accessibleEvidence({
        orphanExpiresAt: null,
        purgeDueAt: null,
        purgedAt: null,
        [field]: value
      })
      const harness = createHarness({ documents: seed({ evidences: [evidence] }) })
      await assert.rejects(harness.repository.getAccessGrant({
        actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
      }), assertCode('EVIDENCE_EXPIRED'))
      assert.deepEqual(harness.calls, [])
    }
  }
})

test('timestamp precedence accepts absent/future expiry and denies past expiry or any purged marker', async () => {
  const cases = [
    { overrides: { orphanExpiresAt: null, purgeDueAt: undefined, purgedAt: null }, allowed: true },
    { overrides: { orphanExpiresAt: new Date('2026-08-07T00:00:00.001Z') }, allowed: true },
    { overrides: { orphanExpiresAt: '2026-08-07T00:00:00.001Z' }, allowed: true },
    { overrides: { orphanExpiresAt: new Date('2026-08-07T00:00:00.000Z') }, allowed: false },
    { overrides: { orphanExpiresAt: '2026-08-06T23:59:59.999Z' }, allowed: false },
    { overrides: { orphanExpiresAt: null, purgeDueAt: new Date('2026-08-07T00:00:00.001Z') }, allowed: true },
    { overrides: { orphanExpiresAt: null, purgeDueAt: '2026-08-07T00:00:00.001Z' }, allowed: true },
    { overrides: { orphanExpiresAt: null, purgeDueAt: new Date('2026-08-07T00:00:00.000Z') }, allowed: false },
    { overrides: { orphanExpiresAt: null, purgeDueAt: '2026-08-06T23:59:59.999Z' }, allowed: false },
    { overrides: { orphanExpiresAt: null, purgedAt: new Date('2026-08-07T00:00:00.001Z') }, allowed: false },
    { overrides: { orphanExpiresAt: null, purgedAt: '2026-08-06T23:59:59.999Z' }, allowed: false },
    { overrides: { storageStatus: 'purged', orphanExpiresAt: null, purgedAt: null }, allowed: false }
  ]
  for (const item of cases) {
    const harness = createHarness({
      documents: seed({ evidences: [accessibleEvidence(item.overrides)] })
    })
    const promise = harness.repository.getAccessGrant({
      actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
    })
    if (item.allowed) {
      assert.equal((await promise).url, 'https://temporary.example/report.pdf')
      assert.equal(harness.calls.length, 1)
    } else {
      await assert.rejects(promise, assertCode('EVIDENCE_EXPIRED'))
      assert.deepEqual(harness.calls, [])
    }
  }
})

test('does not return a permanent URL when the temporary URL adapter fails or is malformed', async () => {
  const documents = seed({ evidences: [accessibleEvidence()] })
  for (const temporary of [
    async () => { throw new Error('temp adapter failed') },
    async () => ({ fileList: [] }),
    async () => ({ fileList: [{ fileID: 'cloud://other/file', tempFileURL: 'https://temporary.example/file', status: 0 }] }),
    async input => ({ fileList: [{ fileID: input.fileList[0].fileID, tempFileURL: 'http://temporary.example/file', status: 0 }] })
  ]) {
    const harness = createHarness({ documents, temporary })
    await assert.rejects(harness.repository.getAccessGrant({
      actor: { _id: 'account-1', openid: 'wx-current' }, evidenceId: 'evidence-1'
    }))
  }
})

test('ordinary attached evidence uses the strict line deadline for every feedback revision', async () => {
  for (const { due, allowed } of [
    { due: new Date(NOW.getTime() + 1), allowed: true },
    { due: NOW, allowed: false },
    { due: new Date(NOW.getTime() - 1), allowed: false }
  ]) {
    for (const revision of [1, 2]) {
      const documents = seed({ evidences: [attachedEvidence({ feedbackRevision: revision })] })
      Object.assign(documents.business_lines[0], { status: 'completed', purgeDueAt: due })
      const harness = createHarness({ documents })
      const promise = harness.repository.getAccessGrant({ actor: { _id: 'account-1' }, evidenceId: 'evidence-1' })
      if (allowed) assert.equal((await promise).url, 'https://temporary.example/report.pdf')
      else await assert.rejects(promise, assertCode('EVIDENCE_EXPIRED'))
    }
  }
})

test('terminal lines require a strict ordinary evidence deadline while active lines may omit it', async () => {
  for (const status of ['completed', 'cancelled', 'closed', 'deleted']) {
    for (const due of [undefined, null, '2026-13-40T00:00:00.000Z', NOW, new Date(NOW.getTime() - 1)]) {
      const documents = seed({ evidences: [attachedEvidence()] })
      Object.assign(documents.business_lines[0], { status, purgeDueAt: due })
      const harness = createHarness({ documents })
      await assert.rejects(
        harness.repository.getAccessGrant({ actor: { _id: 'account-1' }, evidenceId: 'evidence-1' }),
        assertCode('EVIDENCE_EXPIRED')
      )
      assert.deepEqual(harness.calls, [])
    }
    const futureDocuments = seed({ evidences: [attachedEvidence()] })
    Object.assign(futureDocuments.business_lines[0], { status, purgeDueAt: new Date(NOW.getTime() + 1) })
    const future = createHarness({ documents: futureDocuments })
    assert.equal((await future.repository.getAccessGrant({ actor: { _id: 'account-1' }, evidenceId: 'evidence-1' })).url,
      'https://temporary.example/report.pdf')
  }

  const active = createHarness({ documents: seed({ evidences: [attachedEvidence()] }) })
  assert.equal((await active.repository.getAccessGrant({ actor: { _id: 'account-1' }, evidenceId: 'evidence-1' })).url,
    'https://temporary.example/report.pdf')
})

test('unattached evidence uses orphan expiry while explicit amendment evidence uses its own later deadline', async () => {
  const unattachedDocuments = seed({ evidences: [accessibleEvidence()] })
  Object.assign(unattachedDocuments.business_lines[0], { status: 'active', purgeDueAt: NOW })
  const unattached = createHarness({ documents: unattachedDocuments })
  assert.equal((await unattached.repository.getAccessGrant({ actor: { _id: 'account-1' }, evidenceId: 'evidence-1' })).url,
    'https://temporary.example/report.pdf')

  const amendmentDocuments = seed({ evidences: [attachedEvidence({
    retentionScope: 'evidence', retentionSource: 'audit_amendment',
    purgeDueAt: new Date(NOW.getTime() + 1)
  })] })
  Object.assign(amendmentDocuments.business_lines[0], { status: 'completed', purgeDueAt: NOW })
  const amendment = createHarness({ documents: amendmentDocuments })
  assert.equal((await amendment.repository.getAccessGrant({ actor: { _id: 'account-1' }, evidenceId: 'evidence-1' })).url,
    'https://temporary.example/report.pdf')
})

test('新修订附件只有在所属审计修订发布后才可由业务成员访问', async () => {
  function amendmentDocuments(publishState) {
    const documents = seed({
      evidences: [accessibleEvidence({
        nodeId: null,
        feedbackId: null,
        amendmentId: 'business-amend-business-1-5',
        attachmentState: 'amendment_claimed',
        uploadPurpose: 'audit_amendment',
        orphanExpiresAt: null,
        retentionScope: 'evidence',
        retentionSource: 'audit_amendment',
        purgeDueAt: new Date(NOW.getTime() + 60_000)
      })],
      audit_logs: [{
        _id: 'business-amend-business-1-5',
        action: 'AMEND_FROZEN_BUSINESS', targetType: 'business_line', targetId: 'business-1',
        publishState
      }]
    })
    Object.assign(documents.business_lines[0], {
      status: 'completed', purgeDueAt: new Date(NOW.getTime() + 1)
    })
    return documents
  }

  const published = createHarness({ documents: amendmentDocuments('published') })
  assert.equal((await published.repository.getAccessGrant({
    actor: { _id: 'account-1' }, evidenceId: 'evidence-1'
  })).url, 'https://temporary.example/report.pdf')

  for (const status of ['reserved', 'aborting', 'aborted', undefined]) {
    const documents = amendmentDocuments(status)
    if (status === undefined) documents.audit_logs = []
    const hidden = createHarness({ documents })
    await assert.rejects(hidden.repository.getAccessGrant({
      actor: { _id: 'account-1' }, evidenceId: 'evidence-1'
    }), assertCode('EVIDENCE_EXPIRED'))
    assert.deepEqual(hidden.calls, [])
  }
})

test('malformed line, evidence, or retention-scope metadata denies access before a temporary URL', async () => {
  const cases = [
    { lineDue: '2026-13-40T00:00:00.000Z', evidence: attachedEvidence() },
    { lineDue: new Date(NOW.getTime() + 1), evidence: attachedEvidence({ purgeDueAt: 'invalid' }) },
    { lineDue: NOW, evidence: attachedEvidence({ retentionScope: 'evidence', retentionSource: 'audit_amendment', purgeDueAt: 'invalid' }) },
    { lineDue: new Date(NOW.getTime() + 1), evidence: attachedEvidence({ retentionScope: 'unknown' }) },
    { lineDue: new Date(NOW.getTime() + 1), evidence: attachedEvidence({ retentionSource: 'unknown' }) }
  ]
  for (const item of cases) {
    const documents = seed({ evidences: [item.evidence] })
    Object.assign(documents.business_lines[0], { status: 'completed', purgeDueAt: item.lineDue })
    const harness = createHarness({ documents })
    await assert.rejects(
      harness.repository.getAccessGrant({ actor: { _id: 'account-1' }, evidenceId: 'evidence-1' }),
      assertCode('EVIDENCE_EXPIRED')
    )
    assert.deepEqual(harness.calls, [])
  }
})
