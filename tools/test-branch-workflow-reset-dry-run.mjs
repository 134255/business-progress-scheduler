import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  FULL_COLLECTION_TARGETS,
  PRESERVED_COLLECTIONS,
  SCOPED_SYSTEM_SETTING_IDS,
  buildResetInventory
} from './branch-workflow-reset-dry-run.mjs'

const CLOUD_PREFIX = 'cloud://env-safe'
const evidenceIdA = `evidence-${'a'.repeat(64)}`
const evidenceIdB = `evidence-${'b'.repeat(64)}`

function expectedTargets() {
  return [
    'templates', 'template_nodes', 'business_lines', 'business_nodes', 'node_feedback',
    'node_review_rounds', 'node_review_votes', 'evidences', 'notifications',
    'public_node_shares', 'public_node_share_chunks', 'business_search_requests',
    'business_search_documents', 'operations_analytics_facts', 'operations_analytics_daily',
    'node_text_parse_requests'
  ]
}

function fixtureReader() {
  const validKeyA = `evidence-uploads/line-a/node-a/${evidenceIdA}.mp4`
  const validKeyB = `evidence-uploads/line-b/node-b/${evidenceIdB}.pdf`
  const data = Object.fromEntries(expectedTargets().map(name => [name, [{ _id: `${name}-1` }]]))
  data.evidences = [
    {
      _id: evidenceIdA, businessLineId: 'line-a', nodeId: 'node-a', extension: 'mp4',
      storageStatus: 'uploading', purgedAt: null, declaredSize: 100, objectKey: validKeyA,
      fileId: `${CLOUD_PREFIX}/${validKeyA}`
    },
    {
      _id: evidenceIdB, businessLineId: 'line-b', nodeId: 'node-b', extension: 'pdf',
      storageStatus: 'available', purgedAt: null, size: 200,
      fileId: `${CLOUD_PREFIX}/${validKeyB}`
    },
    {
      _id: `evidence-${'c'.repeat(64)}`, businessLineId: 'line-c', nodeId: 'node-c',
      extension: 'pdf', storageStatus: 'available', purgedAt: null, size: 300,
      fileId: `cloud://different-env/evidence-uploads/line-c/node-c/evidence-${'c'.repeat(64)}.pdf`
    },
    {
      _id: `evidence-${'d'.repeat(64)}`, businessLineId: 'line-d', nodeId: 'node-d',
      extension: 'pdf', storageStatus: 'uploading', purgedAt: null, declaredSize: 400,
      objectKey: `evidence-uploads/other-line/node-d/evidence-${'d'.repeat(64)}.pdf`
    },
    {
      _id: `evidence-${'e'.repeat(64)}`, businessLineId: 'line-e', nodeId: 'node-e',
      extension: 'pdf', storageStatus: 'available', purgedAt: null, size: 500,
      fileId: `${CLOUD_PREFIX}/legacy/report.pdf`
    },
    {
      _id: `evidence-${'f'.repeat(64)}`, businessLineId: 'line-f', nodeId: 'node-f',
      extension: 'pdf', storageStatus: 'uploading', purgedAt: null, declaredSize: 600,
      objectKey: `evidence-uploads/line-f/node-f/evidence-${'f'.repeat(64)}.pdf`,
      fileId: `${CLOUD_PREFIX}/evidence-uploads/line-x/node-f/evidence-${'f'.repeat(64)}.pdf`
    },
    {
      _id: `evidence-${'0'.repeat(64)}`, businessLineId: 'line-purged', nodeId: 'node-purged',
      extension: 'pdf', storageStatus: 'purged', purgedAt: new Date('2026-08-01T00:00:00Z'), size: 700
    },
    {
      _id: `evidence-${'7'.repeat(64)}`, businessLineId: 'line-amend', nodeId: null,
      uploadPurpose: 'audit_amendment', extension: 'pdf', storageStatus: 'available', purgedAt: null,
      size: 400, fileId: `${CLOUD_PREFIX}/amendment/line-amend/1788400000000-0-proof.PDF`
    },
    {
      _id: `evidence-${'8'.repeat(64)}`, businessLineId: 'line-amend', nodeId: null,
      uploadPurpose: 'audit_amendment', extension: 'mov', storageStatus: 'purge_pending', purgedAt: null,
      size: 500, fileId: `${CLOUD_PREFIX}/amendment/line-amend/1788400000001-1-proof.MoV`
    },
    {
      _id: `evidence-${'9'.repeat(64)}`, businessLineId: 'line-amend', nodeId: null,
      uploadPurpose: 'audit_amendment', extension: 'pdf', storageStatus: 'purged',
      purgedAt: new Date('2026-08-02T00:00:00Z'), size: 600
    },
    {
      _id: `evidence-${'1'.repeat(64)}`, businessLineId: 'line-amend', nodeId: null,
      uploadPurpose: 'audit_amendment', extension: 'pdf', storageStatus: 'available', purgedAt: null,
      size: 700, fileId: `${CLOUD_PREFIX}/amendment/other-line/1788400000002-0-proof.pdf`
    }
  ]
  data.system_settings = [
    { _id: SCOPED_SYSTEM_SETTING_IDS[0] },
    { _id: 'account_admin_state', secretLike: 'must-not-appear' }
  ]
  for (const preserved of PRESERVED_COLLECTIONS) {
    if (preserved !== 'system_settings') data[preserved] = [{ _id: `${preserved}-preserved` }]
  }
  const calls = []
  return {
    calls,
    validKeyA,
    validKeyB,
    async listPage(collection, afterId, limit) {
      calls.push(collection)
      const rows = (data[collection] || []).slice().sort((a, b) => a._id.localeCompare(b._id))
      const filtered = afterId ? rows.filter(row => row._id > afterId) : rows
      return filtered.slice(0, limit)
    }
  }
}

test('dry-run inventories every approved collection and only exact managed COS objects', async () => {
  assert.deepEqual(FULL_COLLECTION_TARGETS, expectedTargets())
  const reader = fixtureReader()
  const result = await buildResetInventory({
    listPage: reader.listPage,
    cloudFilePrefix: CLOUD_PREFIX,
    pageSize: 2,
    sampleLimit: 2,
    objectLimit: 10
  })

  assert.equal(result.destructive, false)
  assert.deepEqual(result.collections.map(item => item.name), expectedTargets())
  assert.equal(result.collections.find(item => item.name === 'evidences').count, 11)
  assert.deepEqual(result.scopedSystemSettings.ids, [SCOPED_SYSTEM_SETTING_IDS[0]])
  assert.equal(result.scopedSystemSettings.count, 1)
  assert.deepEqual(result.cosObjects.keys, [reader.validKeyA, reader.validKeyB])
  assert.equal(result.cosObjects.count, 2)
  assert.equal(result.cosObjects.totalDeclaredBytes, 300)
  assert.deepEqual(result.cloudFiles.fileIds, [
    `${CLOUD_PREFIX}/amendment/line-amend/1788400000000-0-proof.PDF`,
    `${CLOUD_PREFIX}/amendment/line-amend/1788400000001-1-proof.MoV`
  ])
  assert.equal(result.cloudFiles.count, 2)
  assert.equal(result.cloudFiles.totalDeclaredBytes, 900)
  assert.equal(result.cosObjects.invalidEvidenceCount, 5)
  assert.equal(result.cosObjects.invalidEvidenceIds.length, 2)
  assert.equal(result.cosObjects.invalidEvidenceIdsTruncated, true)
  assert.equal(result.cosObjects.alreadyPurgedEvidenceCount, 2)

  for (const preserved of PRESERVED_COLLECTIONS.filter(name => name !== 'system_settings')) {
    assert.equal(reader.calls.includes(preserved), false)
    assert.equal(JSON.stringify(result).includes(`${preserved}-preserved`), false)
  }
  assert.equal(JSON.stringify(result).includes('account_admin_state'), false)
  assert.equal(JSON.stringify(result).includes('must-not-appear'), false)
})

test('dry-run implementation contains no database or COS mutation call', async () => {
  const source = await readFile(new URL('./branch-workflow-reset-dry-run.mjs', import.meta.url), 'utf8')
  for (const forbidden of [
    '.add(', '.remove(', '.update(', '.doc(',
    'deleteFile(', 'deleteObject(', 'uploadFile(', 'putObject('
  ]) {
    assert.equal(source.includes(forbidden), false, `unexpected mutation API: ${forbidden}`)
  }
  assert.match(source, /process\.env\.BRANCH_RESET_OBJECT_LIMIT/)
})

test('dry-run rejects invalid configuration and never accepts a broad cloud prefix', async () => {
  const listPage = async () => []
  for (const cloudFilePrefix of ['', 'cloud://env-safe/', 'https://example.com', 'cloud://*']) {
    await assert.rejects(
      buildResetInventory({ listPage, cloudFilePrefix }),
      /invalid dry-run configuration/
    )
  }
  await assert.doesNotReject(buildResetInventory({ listPage, cloudFilePrefix: CLOUD_PREFIX, objectLimit: 1001 }))
})
