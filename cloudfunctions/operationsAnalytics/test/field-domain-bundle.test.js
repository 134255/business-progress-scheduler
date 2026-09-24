'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { fieldSource } = require('../../businessApi/test/helpers/field-fixtures')

const root = path.resolve(__dirname, '../../..')
const files = ['operations-field-domain.js', 'field-domain.js', 'conditional-field-domain.js', 'option-linkage-domain.js']
const script = path.join(root, 'tools/sync-operations-field-domain.mjs')

test('standalone field bundle is byte-identical and executes the approved source/header/projection contract', () => {
  for (const name of files) {
    const target = path.join(__dirname, '../lib', name)
    assert.ok(fs.existsSync(target), `standalone worker is missing ${name}`)
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(root, 'cloudfunctions/businessApi/lib', name)))
  }
  const worker = require('../lib/operations-field-domain')
  const api = require('../../businessApi/lib/operations-field-domain')
  for (const reviewed of [false, true]) {
    const source = fieldSource({ reviewed })
    const result = worker.buildFinalFieldResult(source)
    assert.equal(result.fields.find(field => field.fieldKey === 'amount').value, 0)
    assert.equal(result.day, '2026-09-11')
    assert.equal(result.sourceHeader, api.fieldSourceHeader(source))
    assert.deepEqual(worker.selectionSnapshot(result), api.selectionSnapshot(api.buildFinalFieldResult(source)))
  }
})

test('query-only metadata does not change the deployed worker snapshot protocol', () => {
  const domain = require('../lib/operations-field-domain')
  const source = fieldSource(), result = domain.buildFinalFieldResult(source)
  // Captured from the verified pre-analysis implementation, not recomputed by
  // the new metadata helper under test.
  assert.equal(result.sourceHeader, '2a4274b01bb8aa83e2585a92fc4fb6f7418c8edb8bd670a9ef9f2c73044a3943')
  assert.equal(result.sourceDigest, 'beaaba023114ac518207214c740920266285fcde6fe57ede89740ddcdadaf2e3')
  const snapshot = domain.selectionSnapshot(result)
  domain.describeFieldAnalysisSource(source, snapshot)
  assert.deepEqual(domain.selectionSnapshot(result), snapshot)
  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(Object.hasOwn(snapshot,'dimensions'), false)
})

test('real sync CLI copies only the three allowlisted files and check mode detects drift without writing', t => {
  assert.ok(fs.existsSync(script), 'the standalone bundle must have a reproducible sync command')
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'operations-field-bundle-'))
  t.after(() => {
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temporaryRoot).startsWith('operations-field-bundle-'))
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  })
  const source = path.join(temporaryRoot, 'cloudfunctions/businessApi/lib')
  const target = path.join(temporaryRoot, 'cloudfunctions/operationsAnalytics/lib')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  for (const name of files) fs.copyFileSync(path.join(root, 'cloudfunctions/businessApi/lib', name), path.join(source, name))
  fs.writeFileSync(path.join(source, 'unrelated.js'), 'not a bundle dependency')
  fs.writeFileSync(path.join(target, 'sentinel.js'), 'keep me')
  function invoke(...args) {
    return spawnSync(process.execPath, [script, '--root', temporaryRoot, ...args], { encoding: 'utf8', windowsHide: true })
  }
  assert.equal(invoke('--check').status, 1)
  assert.equal(invoke().status, 0)
  assert.equal(invoke('--check').status, 0)
  for (const name of files) assert.deepEqual(fs.readFileSync(path.join(source, name)), fs.readFileSync(path.join(target, name)))
  assert.deepEqual(fs.readdirSync(target).sort(), [...files, 'sentinel.js'].sort())
  fs.writeFileSync(path.join(target, files[0]), 'drift')
  assert.equal(invoke('--check').status, 1)
  assert.equal(fs.readFileSync(path.join(target, files[0]), 'utf8'), 'drift')
  assert.equal(fs.readFileSync(path.join(target, 'sentinel.js'), 'utf8'), 'keep me')
})
