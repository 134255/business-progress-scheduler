const test = require('node:test')
const assert = require('node:assert/strict')

// Exercise the page's real COS factory and the shipped SDK. Only the WeChat
// filesystem/network and cloud service boundary are replaced; no real I/O occurs.
async function uploadThroughPage(size, fixture = {}) {
  const pagePath = require.resolve('../pages/node-feedback/index')
  const servicePath = require.resolve('../services/business')
  const sdkPath = require.resolve('../vendor/cos-wx-sdk-v5')
  const previousModules = new Map([pagePath, servicePath, sdkPath].map(key => [key, require.cache[key]]))
  const previousGlobals = new Map(['wx', 'Page', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(global, key)]))
  const bytes = Buffer.alloc(size, 0xa5)
  Buffer.from(fixture.header || '89504e470d0a1a0a', 'hex').copy(bytes)
  const name = fixture.name || 'synthetic.png'
  const filePath = '/synthetic/' + name
  const key = 'evidence-uploads/test-line/test-node/evidence-test.' + (fixture.extension || 'png')
  const calls = []
  const parts = []
  const reads = []
  const now = Math.floor(Date.now() / 1000)
  const task = () => ({ abort() {}, onProgressUpdate() {}, onHeadersReceived() {} })
  const respond = (options, data, statusCode = 200) => {
    queueMicrotask(() => options.success({ statusCode, data, header: { etag: '"synthetic-etag"' } }))
    return task()
  }
  let page
  let beginInput
  let finalizeInput
  try {
    global.wx = {
      getSystemInfoSync: () => ({ SDKVersion: '3.17.1' }),
      getDeviceInfo: () => ({ platform: fixture.platform || 'ios' }),
      getAppBaseInfo: () => ({ SDKVersion: '3.17.1' }),
      canIUse: () => true,
      getStorageSync: () => '',
      setStorageSync() {},
      removeStorageSync() {},
      getFileSystemManager: () => ({
        stat(options) {
          assert.equal(options.path, filePath)
          queueMicrotask(() => options.success({ stats: { size, isDirectory: () => false } }))
        },
        readFile(options) {
          assert.equal(options.filePath, filePath)
          reads.push({ position: options.position, length: options.length, encoding: options.encoding })
          const start = options.position || 0
          const end = options.length === undefined ? bytes.length : start + options.length
          const data = Uint8Array.from(bytes.subarray(start, end)).buffer
          queueMicrotask(() => options.success({ data }))
        }
      }),
      uploadFile(options) {
        calls.push({ api: 'uploadFile', method: options.method, key: options.formData.key })
        // PostObject is deliberately NOT granted by the production STS policy.
        return respond(options, '<Error><Code>AccessDenied</Code><Message>PostObject not granted</Message></Error>', 403)
      },
      request(options) {
        const url = new URL(options.url)
        calls.push({ api: 'request', method: options.method, path: url.pathname, query: url.search })
        if (options.method === 'GET' && url.searchParams.has('uploads')) {
          return respond(options, '<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>')
        }
        assert.equal(decodeURIComponent(url.pathname), '/' + key)
        if (options.method === 'POST' && url.searchParams.has('uploads')) {
          return respond(options, '<InitiateMultipartUploadResult><UploadId>synthetic-upload</UploadId></InitiateMultipartUploadResult>')
        }
        if (options.method === 'PUT') {
          assert.ok(options.data instanceof ArrayBuffer)
          parts.push({ number: Number(url.searchParams.get('partNumber') || 1), bytes: Buffer.from(options.data) })
          return respond(options, '')
        }
        if (options.method === 'POST' && url.searchParams.get('uploadId') === 'synthetic-upload') {
          return respond(options, '<CompleteMultipartUploadResult><ETag>synthetic-etag</ETag></CompleteMultipartUploadResult>')
        }
        assert.fail('Unexpected COS request method or query')
      }
    }
    global.Page = definition => { page = definition }
    require.cache[servicePath] = {
      id: servicePath, filename: servicePath, loaded: true,
      exports: {
        async beginEvidenceUpload(input) {
          beginInput = input
          if (fixture.reservationAllowedTypes && !fixture.reservationAllowedTypes.includes(input.fileName.split('.').pop().toLowerCase())) {
            throw Object.assign(new Error('Unsupported reservation format'), { code: 'UNSUPPORTED_FILE_TYPE' })
          }
          return {
            evidenceId: 'evidence-test', uploadSessionToken: 'synthetic-session',
            bucket: 'synthetic-1234567890', region: 'ap-shanghai', objectKey: key,
            credentials: { tmpSecretId: 'synthetic-id', tmpSecretKey: 'synthetic-key', sessionToken: 'synthetic-token' },
            startTime: now - 1, expiredTime: now + 900
          }
        },
        async refreshEvidenceUploadAuthorization() { assert.fail('Fresh authorization must not refresh') },
        async finalizeEvidenceUpload(input) {
          finalizeInput = input
          const uploaded = Buffer.concat(parts.slice().sort((a, b) => a.number - b.number).map(part => part.bytes))
          const { classifyHeader } = require('../../cloudfunctions/businessApi/lib/evidence-policy')
          const classified = classifyHeader({ fileName: beginInput.fileName, declaredSize: uploaded.length,
            bytes: uploaded.subarray(0, 64), allowedTypes: fixture.allowedTypes || ['png', 'jpg', 'jpeg'] })
          return { evidenceId: 'evidence-test', fileName: beginInput.fileName, ...classified, storageStatus: 'available' }
        }
      }
    }
    delete require.cache[pagePath]
    delete require.cache[sdkPath]
    require(pagePath)
    const uploader = page.createEvidenceUploader()
    let result
    let error
    try {
      result = await uploader.upload({
        businessLineId: 'test-line', nodeId: 'test-node', expectedNodeVersion: 4,
        file: { path: filePath, name, size }
      })
    } catch (caught) { error = caught }
    return { result, error, calls, parts, bytes, reads, beginInput, finalizeInput }
  } finally {
    for (const [key, previous] of previousModules) {
      if (previous) require.cache[key] = previous
      else delete require.cache[key]
    }
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(global, key, descriptor)
      else delete global[key]
    }
  }
}

function assertAvailableUpload(actual, size) {
  assert.equal(actual.error, undefined, 'The page must use COS operations granted by the scoped upload policy')
  assert.deepEqual(actual.beginInput, {
    businessLineId: 'test-line', nodeId: 'test-node', expectedNodeVersion: 4,
    fileName: 'synthetic.png', declaredSize: size
  })
  assert.deepEqual(actual.finalizeInput, {
    evidenceId: 'evidence-test', uploadSessionToken: 'synthetic-session', expectedNodeVersion: 4
  })
  assert.equal(actual.result.storageStatus, 'available')
  assert.equal(actual.result.size, size)
  assert.deepEqual(Buffer.concat(actual.parts.sort((a, b) => a.number - b.number).map(part => part.bytes)), actual.bytes)
}

for (const size of [372429, 1048575, 1048576]) {
  test(`page uploads ${size}-byte PNG through the real SDK using scoped PutObject`, async () => {
    const actual = await uploadThroughPage(size)
    assert.deepEqual(actual.calls.map(call => [call.api, call.method]), [['request', 'PUT']],
      'Simple uploads must not require the ungranted COS PostObject action')
    assertAvailableUpload(actual, size)
  })
}

test('page keeps multipart transfer and binary ordering above the SDK simple-upload boundary', async () => {
  const actual = await uploadThroughPage(1048577)
  assertAvailableUpload(actual, 1048577)
  assert.equal(actual.calls.some(call => call.api === 'uploadFile'), false)
  assert.equal(actual.parts.length, 2)
  assert.deepEqual(actual.parts.map(part => part.bytes.length), [1048576, 1])
  assert.ok(actual.calls.some(call => call.method === 'POST' && call.query.includes('uploads')))
  assert.ok(actual.calls.some(call => call.method === 'POST' && call.query.includes('uploadId=synthetic-upload')))
})

test('Mac image named JPG with PNG bytes is named by content before authorization and passes the real server policy', async () => {
  const actual = await uploadThroughPage(56125, { name: 'local-photo.jpg', platform: 'mac' })
  assert.equal(actual.error, undefined)
  assert.equal(actual.beginInput.fileName, 'local-photo.png')
  assert.equal(actual.result.storageStatus, 'available')
  assert.equal(actual.result.extension, 'png')
  assert.deepEqual(Buffer.concat(actual.parts.map(part => part.bytes)), actual.bytes, 'No transcoding or file rewrite')
  assert.deepEqual(actual.reads[0], { position: 0, length: 64, encoding: undefined })
})

test('Mac genuine JPG keeps its name and exact bytes through upload and server verification', async () => {
  const actual = await uploadThroughPage(56125, { name: 'local-photo.JPG', platform: 'mac',
    header: 'ffd8ffe000104a4649460001', extension: 'JPG' })
  assert.equal(actual.error, undefined)
  assert.equal(actual.beginInput.fileName, 'local-photo.JPG')
  assert.equal(actual.result.extension, 'jpg')
  assert.deepEqual(Buffer.concat(actual.parts.map(part => part.bytes)), actual.bytes)
})

test('normalizing a mislabeled image does not bypass the actual-format node allowlist', async () => {
  const actual = await uploadThroughPage(56125, { name: 'local-photo.jpg', platform: 'mac', allowedTypes: ['jpg'] })
  assert.equal(actual.beginInput.fileName, 'local-photo.png')
  assert.equal(actual.error.code, 'UNSUPPORTED_FILE_TYPE')
  assert.equal(actual.result, undefined)
})

test('authorization rejection of normalized PNG stops before all COS requests and finalization', async () => {
  const actual = await uploadThroughPage(56125, {
    name: 'local-photo.jpg', platform: 'mac', reservationAllowedTypes: ['jpg']
  })
  assert.equal(actual.beginInput.fileName, 'local-photo.png')
  assert.equal(actual.error.code, 'UNSUPPORTED_FILE_TYPE')
  assert.equal(actual.error.uploadStage, 'authorize')
  assert.deepEqual(actual.calls, [])
  assert.deepEqual(actual.parts, [])
  assert.equal(actual.finalizeInput, undefined)
  assert.equal(actual.result, undefined)
})
