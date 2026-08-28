const test = require('node:test')
const assert = require('node:assert/strict')

const { createEvidenceUploader } = require('../utils/evidence-upload')

function session(number = 1) {
  return {
    evidenceId: `evidence-${number}`,
    uploadSessionToken: `token-${number}`,
    bucket: 'bucket-123',
    region: 'ap-shanghai',
    objectKey: `evidence-uploads/line/node/evidence-${number}.mp4`,
    credentials: { tmpSecretId: `tmp-${number}`, tmpSecretKey: `key-${number}`, sessionToken: `session-${number}` },
    startTime: 100,
    expiredTime: 1000
  }
}

test('uploader authorizes first, uses the exact returned key, forwards progress and finalizes safely', async () => {
  const events = []
  const uploader = createEvidenceUploader({
    beginUpload: async input => { events.push(['begin', input]); return session() },
    finalizeUpload: async input => {
      events.push(['finalize', input])
      return { evidenceId: 'evidence-1', fileName: 'proof.mp4', category: 'video', size: 10, storageStatus: 'available' }
    },
    cosFactory: ({ getAuthorization }) => ({
      uploadFile(params, callback) {
        events.push(['credentials', getAuthorization()])
        events.push(['upload', params.Bucket, params.Region, params.Key, params.FilePath])
        params.onProgress({ percent: 0.5 })
        callback(null, { statusCode: 200 })
      }
    }),
    delay: async () => {}
  })
  const progress = []
  const result = await uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'proof.mp4', path: 'wxfile://proof.mp4', size: 10 },
    onProgress: value => progress.push(value)
  })
  assert.equal(result.storageStatus, 'available')
  assert.deepEqual(progress, [50])
  assert.deepEqual(events[0], ['begin', {
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    fileName: 'proof.mp4', declaredSize: 10
  }])
  assert.deepEqual(events[2], ['upload', 'bucket-123', 'ap-shanghai', session().objectKey, 'wxfile://proof.mp4'])
  assert.deepEqual(events.at(-1), ['finalize', {
    evidenceId: 'evidence-1', uploadSessionToken: 'token-1', expectedNodeVersion: 4
  }])
  assert.equal(JSON.stringify(uploader).includes('tmp-1'), false)
})

test('uploader retries retryable transport failures with bounded exponential delay', async () => {
  let attempts = 0
  const waits = []
  const uploader = createEvidenceUploader({
    beginUpload: async () => session(),
    finalizeUpload: async () => ({ evidenceId: 'evidence-1', storageStatus: 'available' }),
    cosFactory: () => ({
      uploadFile(params, callback) {
        attempts += 1
        if (attempts < 3) return callback(Object.assign(new Error('network'), { code: 'RequestError' }))
        callback(null, { statusCode: 200 })
      }
    }),
    delay: async ms => waits.push(ms)
  })
  await uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'proof.pdf', path: 'wxfile://proof.pdf', size: 10 }
  })
  assert.equal(attempts, 3)
  assert.deepEqual(waits, [250, 500])
})

test('an expired session obtains a new exact authorization once and finalize remains replay-safe', async () => {
  let begun = 0
  const finalized = []
  const uploader = createEvidenceUploader({
    beginUpload: async () => session(++begun),
    finalizeUpload: async input => {
      finalized.push(input)
      if (begun === 1) throw Object.assign(new Error('expired'), { code: 'EVIDENCE_UPLOAD_EXPIRED' })
      return { evidenceId: input.evidenceId, storageStatus: 'available' }
    },
    cosFactory: () => ({ uploadFile(params, callback) { callback(null, { statusCode: 200 }) } }),
    delay: async () => {}
  })
  const result = await uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'proof.mov', path: 'wxfile://proof.mov', size: 10 }
  })
  assert.equal(begun, 2)
  assert.equal(result.evidenceId, 'evidence-2')
  assert.deepEqual(finalized.map(value => value.evidenceId), ['evidence-1', 'evidence-2'])
})

test('cancellation stops before authorization or retry and produces a stable safe code', async () => {
  let calls = 0
  const uploader = createEvidenceUploader({
    beginUpload: async () => { calls += 1; return session() },
    finalizeUpload: async () => assert.fail('must not finalize'),
    cosFactory: () => ({ uploadFile: () => assert.fail('must not upload') }),
    delay: async () => {}
  })
  await assert.rejects(uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'proof.pdf', path: 'wxfile://proof.pdf', size: 10 },
    signal: { aborted: true }
  }), error => error && error.code === 'UPLOAD_CANCELLED')
  assert.equal(calls, 0)
})
