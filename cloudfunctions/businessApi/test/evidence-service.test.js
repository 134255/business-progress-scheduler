const test = require('node:test')
const assert = require('node:assert/strict')

const { createEvidenceService } = require('../lib/evidence-service')

function createHarness() {
  const calls = []
  const repository = {
    async registerUpload(input) {
      calls.push(['registerUpload', input])
      return { evidenceId: 'evidence-1', metadata: { fileName: input.input.fileName } }
    },
    async getAccessGrant(input) {
      calls.push(['getAccessGrant', input])
      return {
        url: 'https://temporary.example/file', fileName: 'report.pdf', category: 'pdf',
        expiresAt: new Date('2026-08-07T00:05:00.000Z')
      }
    }
  }
  return { calls, service: createEvidenceService({ repository }) }
}

function assertCode(code) {
  return error => error && error.code === code
}

test('normalizes registration input and delegates only the trusted actor contract', async () => {
  const harness = createHarness()
  const actor = { _id: 'account-1', status: 'active', openid: 'legacy-binding' }
  const result = await harness.service.registerUpload({
    actor,
    input: {
      businessLineId: ' business-1 ', nodeId: ' node-1 ',
      fileId: ' cloud://env/path/report.pdf ', fileName: 'report.pdf', declaredSize: 12,
      actor: { _id: 'forged' }, url: 'https://attacker.example/file'
    }
  })

  assert.equal(result.evidenceId, 'evidence-1')
  assert.deepEqual(harness.calls, [[
    'registerUpload',
    {
      actor,
      input: {
        businessLineId: 'business-1', nodeId: 'node-1',
        fileId: 'cloud://env/path/report.pdf', fileName: 'report.pdf', declaredSize: 12
      }
    }
  ]])
})

test('rejects malformed registration values before repository or cloud work', async () => {
  const invalidInputs = [
    null,
    {},
    { businessLineId: '../line', nodeId: 'node-1', fileId: 'cloud://env/a.pdf', fileName: 'a.pdf', declaredSize: 12 },
    { businessLineId: 'business-1', nodeId: 'node/1', fileId: 'cloud://env/a.pdf', fileName: 'a.pdf', declaredSize: 12 },
    { businessLineId: 'business-1', nodeId: 'node-1', fileId: 'https://attacker.example/a.pdf', fileName: 'a.pdf', declaredSize: 12 },
    { businessLineId: 'business-1', nodeId: 'node-1', fileId: 'cloud://env/a.pdf', fileName: '', declaredSize: 12 },
    { businessLineId: 'business-1', nodeId: 'node-1', fileId: 'cloud://env/a.pdf', fileName: 'a.pdf', declaredSize: '12' }
  ]
  for (const input of invalidInputs) {
    const harness = createHarness()
    await assert.rejects(
      harness.service.registerUpload({ actor: { _id: 'account-1' }, input }),
      assertCode('EVIDENCE_NOT_ATTACHABLE')
    )
    assert.deepEqual(harness.calls, [])
  }

  for (const actor of [{ _id: 123 }, { _id: { toString: () => 'account-1' } }, null]) {
    const harness = createHarness()
    await assert.rejects(harness.service.registerUpload({
      actor,
      input: {
        businessLineId: 'business-1', nodeId: 'node-1',
        fileId: 'cloud://env/a.pdf', fileName: 'a.pdf', declaredSize: 12
      }
    }), assertCode('EVIDENCE_NOT_ATTACHABLE'))
    assert.deepEqual(harness.calls, [])
  }
})

test('rejects a declared size above the universal evidence limit before repository work', async () => {
  const harness = createHarness()
  await assert.rejects(harness.service.registerUpload({
    actor: { _id: 'account-1' },
    input: {
      businessLineId: 'business-1', nodeId: 'node-1',
      fileId: 'cloud://env/oversized.pdf', fileName: 'oversized.pdf',
      declaredSize: 20 * 1024 * 1024 + 1
    }
  }), assertCode('FILE_TOO_LARGE'))
  assert.deepEqual(harness.calls, [])
})

test('normalizes access IDs and rejects malformed values before delegation', async () => {
  const harness = createHarness()
  const actor = { _id: 'account-1' }
  const result = await harness.service.getAccessGrant({ actor, evidenceId: ' evidence-1 ' })
  assert.equal(result.url, 'https://temporary.example/file')
  assert.deepEqual(harness.calls, [['getAccessGrant', { actor, evidenceId: 'evidence-1' }]])

  for (const evidenceId of [undefined, '', '../evidence', 'evidence/1', 123]) {
    const rejected = createHarness()
    await assert.rejects(rejected.service.getAccessGrant({ actor, evidenceId }), assertCode('EVIDENCE_NOT_ATTACHABLE'))
    assert.deepEqual(rejected.calls, [])
  }
})
