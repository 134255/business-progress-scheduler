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
    startTime: 4102444800,
    expiredTime: 4102445700
  }
}

function refreshedSession(number = 1) {
  return {
    evidenceId: `evidence-${number}`,
    uploadSessionToken: `token-${number}`,
    bucket: 'bucket-123',
    region: 'ap-shanghai',
    objectKey: `evidence-uploads/line/node/evidence-${number}.mp4`,
    credentials: {
      tmpSecretId: `tmp-${number}-refreshed`,
      tmpSecretKey: `key-${number}-refreshed`,
      sessionToken: `session-${number}-refreshed`
    },
    startTime: 4102445680,
    expiredTime: 4102446580
  }
}

test('uploader authorizes first, uses the exact returned key, forwards progress and finalizes safely', async () => {
  const events = []
  const uploader = createEvidenceUploader({
    beginUpload: async input => { events.push(['begin', input]); return session() },
    refreshUpload: async () => assert.fail('must not refresh'),
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
    refreshUpload: async () => assert.fail('must not refresh'),
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

test('an expired finalize refreshes the same reservation once and remains replay-safe', async () => {
  let begun = 0
  let refreshed = 0
  const finalized = []
  const uploader = createEvidenceUploader({
    beginUpload: async () => session(++begun),
    refreshUpload: async input => {
      refreshed += 1
      assert.deepEqual(input, {
        evidenceId: 'evidence-1', uploadSessionToken: 'token-1', expectedNodeVersion: 4
      })
      return refreshedSession(1)
    },
    finalizeUpload: async input => {
      finalized.push(input)
      if (refreshed === 0) throw Object.assign(new Error('expired'), { code: 'EVIDENCE_UPLOAD_EXPIRED' })
      return { evidenceId: input.evidenceId, storageStatus: 'available' }
    },
    cosFactory: () => ({ uploadFile(params, callback) { callback(null, { statusCode: 200 }) } }),
    delay: async () => {}
  })
  const result = await uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'proof.mov', path: 'wxfile://proof.mov', size: 10 }
  })
  assert.equal(begun, 1)
  assert.equal(refreshed, 1)
  assert.equal(result.evidenceId, 'evidence-1')
  assert.deepEqual(finalized.map(value => value.evidenceId), ['evidence-1', 'evidence-1'])
})

test('a 120 MiB multipart upload refreshes an expired credential on the same key and never regresses progress', async () => {
  let uploads = 0
  let refreshed = 0
  const authorizations = []
  const progress = []
  const uploader = createEvidenceUploader({
    beginUpload: async () => session(),
    refreshUpload: async input => {
      refreshed += 1
      assert.equal(input.evidenceId, 'evidence-1')
      return refreshedSession(1)
    },
    finalizeUpload: async input => ({ evidenceId: input.evidenceId, storageStatus: 'available' }),
    cosFactory: ({ getAuthorization }) => ({
      async uploadFile(params, callback) {
        uploads += 1
        authorizations.push(await getAuthorization())
        if (uploads === 1) {
          params.onProgress({ percent: 0.93 })
          return callback(Object.assign(new Error('The security token has expired'), {
            code: 'ExpiredToken', statusCode: 403
          }))
        }
        params.onProgress({ percent: 0.25 })
        params.onProgress({ percent: 1 })
        callback(null, { statusCode: 200 })
      }
    }),
    delay: async () => {}
  })

  const result = await uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'edge.mp4', path: 'wxfile://edge.mp4', size: 120 * 1024 * 1024 },
    onProgress: value => progress.push(value)
  })

  assert.equal(result.evidenceId, 'evidence-1')
  assert.equal(uploads, 2)
  assert.equal(refreshed, 1)
  assert.equal(authorizations[0].TmpSecretId, 'tmp-1')
  assert.equal(authorizations[1].TmpSecretId, 'tmp-1-refreshed')
  assert.deepEqual(progress, [93, 93, 100])
})

test('parallel authorization requests near expiry share one proactive refresh', async () => {
  let refreshed = 0
  const uploader = createEvidenceUploader({
    beginUpload: async () => ({ ...session(), expiredTime: 1060 }),
    refreshUpload: async () => {
      refreshed += 1
      return refreshedSession(1)
    },
    finalizeUpload: async input => ({ evidenceId: input.evidenceId, storageStatus: 'available' }),
    cosFactory: ({ getAuthorization }) => ({
      async uploadFile(params, callback) {
        const values = await Promise.all([getAuthorization(), getAuthorization(), getAuthorization()])
        assert.deepEqual(values.map(value => value.TmpSecretId), [
          'tmp-1-refreshed', 'tmp-1-refreshed', 'tmp-1-refreshed'
        ])
        callback(null, { statusCode: 200 })
      }
    }),
    delay: async () => {},
    nowSeconds: () => 1000
  })

  await uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'edge.mp4', path: 'wxfile://edge.mp4', size: 96 * 1024 * 1024 }
  })
  assert.equal(refreshed, 1)
})

test('slow 120-part upload crosses repeated credential windows without changing reservation identity', async () => {
  let now = 1000
  let refreshes = 0
  const keys = []
  const uploader = createEvidenceUploader({
    beginUpload: async () => ({ ...session(), startTime: 990, expiredTime: 1900 }),
    refreshUpload: async input => {
      refreshes += 1
      return {
        ...refreshedSession(1),
        startTime: now - 10,
        expiredTime: now + 900,
        evidenceId: input.evidenceId,
        objectKey: session().objectKey
      }
    },
    finalizeUpload: async input => ({ evidenceId: input.evidenceId, storageStatus: 'available' }),
    cosFactory: ({ getAuthorization }) => ({
      async uploadFile(params, callback) {
        for (let part = 1; part <= 120; part += 1) {
          const authorization = await getAuthorization()
          assert.ok(authorization.ExpiredTime > now)
          keys.push(params.Key)
          params.onProgress({ percent: part / 120 })
          now += 20
        }
        callback(null, { statusCode: 200 })
      }
    }),
    delay: async () => {},
    nowSeconds: () => now
  })

  const result = await uploader.upload({
    businessLineId: 'line', nodeId: 'node', expectedNodeVersion: 4,
    file: { name: 'edge.mp4', path: 'wxfile://edge.mp4', size: 120 * 1024 * 1024 }
  })

  assert.equal(result.evidenceId, 'evidence-1')
  assert.ok(refreshes >= 2)
  assert.deepEqual(new Set(keys), new Set([session().objectKey]))
})

test('cancellation stops before authorization or retry and produces a stable safe code', async () => {
  let calls = 0
  const uploader = createEvidenceUploader({
    beginUpload: async () => { calls += 1; return session() },
    refreshUpload: async () => assert.fail('must not refresh'),
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
