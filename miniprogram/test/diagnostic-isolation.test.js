const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { callBusinessApi } = require('../utils/cloud')
const { createEvidenceUploader } = require('../utils/evidence-upload')

function uploader(clock, onTiming, failure) {
  return createEvidenceUploader({
    clock, onTiming,
    beginUpload: async () => ({ evidenceId: 'test', objectKey: 'test', credentials: {},
      startTime: 4102444800, expiredTime: 4102445700 }),
    refreshUpload: async () => assert.fail('must not refresh'),
    cosFactory: () => ({ uploadFile(params, callback) { callback(null, { statusCode: 200 }) } }),
    finalizeUpload: async () => {
      if (failure) throw Object.assign(new Error('business failure'), { code: 'FORBIDDEN' })
      return { storageStatus: 'available' }
    }
  })
}

const input = { businessLineId: 'test', nodeId: 'test', expectedNodeVersion: 1,
  file: { name: 'test.pdf', path: 'test', size: 10 } }

test('throwing or unconvertible clocks cannot prevent upload finalization or replace its business failure', async () => {
  for (const failure of [false, true]) {
    for (const failAt of [1, 2, 3, 4, 5, 6]) {
      for (const conversion of [false, true]) {
        let calls = 0
        const clock = () => {
          if (++calls !== failAt) return calls
          if (conversion) return Symbol('invalid clock')
          throw new Error('clock failure')
        }
        const pending = uploader(clock, () => {}, failure).upload(input)
        if (failure) await assert.rejects(pending, { code: 'FORBIDDEN', uploadStage: 'finalize' })
        else assert.deepEqual(await pending, { storageStatus: 'available' })
      }
    }
  }
})

test('throwing or unconvertible clocks cannot prevent a cloud write or replace its authoritative result', async t => {
  const previous = global.wx
  t.after(() => { global.wx = previous })
  for (const failure of [false, true]) {
    for (const failAt of [1, 2]) {
      for (const conversion of [false, true]) {
        let calls = 0
        let requests = 0
        global.wx = { cloud: { async callFunction() {
          requests += 1
          return { result: failure ? { ok: false, code: 'VERSION_CONFLICT' } : { ok: true, data: { saved: true } } }
        } } }
        const clock = () => {
          if (++calls !== failAt) return calls
          if (conversion) return Symbol('invalid clock')
          throw new Error('clock failure')
        }
        const pending = callBusinessApi('submitFeedback', {}, { silent: true, clock })
        if (failure) await assert.rejects(pending, { code: 'VERSION_CONFLICT' })
        else assert.deepEqual(await pending, { saved: true })
        assert.equal(requests, 1)
      }
    }
  }
})

test('asynchronous timing observers never produce unhandled rejections on success or failure', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { callBusinessApi } = require(${JSON.stringify(require.resolve('../utils/cloud'))});
    const { createEvidenceUploader } = require(${JSON.stringify(require.resolve('../utils/evidence-upload'))});
    const onTiming = async () => { throw new Error('diagnostic observer failed') };
    (async () => {
      for (const failure of [false, true]) {
        global.wx = { cloud: { async callFunction() {
          return { result: failure ? { ok: false, code: 'FORBIDDEN' } : { ok: true, data: { saved: true } } };
        } } };
        const cloud = callBusinessApi('submitFeedback', {}, { silent: true, onTiming });
        if (failure) await assert.rejects(cloud, { code: 'FORBIDDEN' });
        else assert.deepEqual(await cloud, { saved: true });
        const upload = createEvidenceUploader({ onTiming,
          beginUpload: async () => ({ evidenceId: 'test', objectKey: 'test', credentials: {}, expiredTime: 4102445700 }),
          refreshUpload: async () => assert.fail('unexpected refresh'),
          cosFactory: () => ({ uploadFile(params, callback) { callback(null, { statusCode: 200 }); } }),
          finalizeUpload: async () => { if (failure) throw { code: 'FORBIDDEN' }; return { storageStatus: 'available' }; }
        }).upload(${JSON.stringify(input)});
        if (failure) await assert.rejects(upload, { code: 'FORBIDDEN' });
        else assert.deepEqual(await upload, { storageStatus: 'available' });
      }
    })().catch(() => { process.exitCode = 2; });
  `
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('unformattable timing metadata cannot replace an authoritative cloud failure', async t => {
  const previous = global.wx
  t.after(() => { global.wx = previous })
  const code = Symbol('unformattable-code')
  global.wx = { cloud: { async callFunction() { return { result: { ok: false, code } } } } }
  await assert.rejects(callBusinessApi('submitFeedback', {}, { silent: true }), error => error.code === code)
})
