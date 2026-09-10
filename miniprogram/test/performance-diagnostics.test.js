const test = require('node:test')
const assert = require('node:assert/strict')
const { callBusinessApi } = require('../utils/cloud')
const { createEvidenceUploader } = require('../utils/evidence-upload')

function harness(t, enabled) {
  const previousApp = global.getApp
  const previousWx = global.wx
  const app = { globalData: { performanceDiagnostics: enabled } }
  global.getApp = () => app
  global.wx = {
    cloud: { async callFunction() { return { result: { ok: true, data: { private: 'result' } } } } },
    showToast() {}
  }
  t.after(() => { global.getApp = previousApp; global.wx = previousWx })
  return app.globalData
}

test('opt-in diagnostics collect only bounded safe cloud timing fields in memory', async t => {
  const state = harness(t, true)
  for (let i = 0; i < 105; i += 1) {
    await callBusinessApi('getDashboardWorkspace', { private: 'payload' }, { clock: () => 42 })
  }
  assert.equal((state.performanceTimings || []).length, 100)
  assert.deepEqual(state.performanceTimings[0], {
    action: 'getDashboardWorkspace', durationMs: 0, outcomeCode: 'OK'
  })
  await callBusinessApi('private-text-not-an-action', { private: 'payload' })
  assert.equal(state.performanceTimings.length, 100)
  assert.doesNotMatch(JSON.stringify(state.performanceTimings), /private|payload|result/)
})

test('diagnostics are off by default and disabling clears captured timing samples', async t => {
  const state = harness(t, undefined)
  await callBusinessApi('getDashboardWorkspace', {})
  assert.equal(state.performanceTimings, undefined)
  state.performanceDiagnostics = true
  await callBusinessApi('getBusinessLine', {})
  assert.equal((state.performanceTimings || []).length, 1)
  state.performanceDiagnostics = false
  await callBusinessApi('getBusinessLine', {})
  assert.equal(state.performanceTimings, undefined)
})

test('ordinary uploader wiring records all three stages when opt-in is enabled', async t => {
  const state = harness(t, true)
  const uploader = createEvidenceUploader({
    beginUpload: async () => ({ evidenceId: 'private-id', objectKey: 'private-key', bucket: 'private-bucket',
      region: 'test', credentials: {}, startTime: 4102444800, expiredTime: 4102445700 }),
    refreshUpload: async () => assert.fail('must not refresh'),
    finalizeUpload: async () => ({ storageStatus: 'available' }),
    cosFactory: () => ({ uploadFile(params, callback) { callback(null, { statusCode: 200 }) } }),
    clock: () => 0
  })
  await uploader.upload({ businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 1,
    file: { name: 'private.pdf', path: 'private-path', size: 10 } })
  assert.deepEqual((state.performanceTimings || []).map(item => item.stage), ['authorize', 'transfer', 'finalize'])
  assert.doesNotMatch(JSON.stringify(state.performanceTimings), /private|credentials|objectKey/)
})

test('creation and progress saving timings use the actions sent by real business services', async t => {
  const state = harness(t, true)
  const business = require('../services/business')
  await business.createBusinessFromTemplate({ templateId: 'private-template' })
  await business.submitFeedback({ businessLineId: 'private-line' })
  assert.deepEqual((state.performanceTimings || []).map(item => item.action),
    ['createBusinessFromTemplate', 'submitFeedback'])
})
