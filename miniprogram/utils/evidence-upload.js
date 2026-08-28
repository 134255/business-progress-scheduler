const RETRY_DELAYS_MS = Object.freeze([250, 500])
const RETRYABLE_CODES = new Set([
  'RequestError', 'NetworkError', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UPLOAD_FAILED'
])

function uploadError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function assertNotCancelled(signal) {
  if (signal && signal.aborted) throw uploadError('UPLOAD_CANCELLED', '上传已取消')
}

function isRetryable(error) {
  if (!error || error.code === 'UPLOAD_CANCELLED') return false
  const status = Number(error.statusCode)
  return RETRYABLE_CODES.has(error.code) || status === 408 || status === 429 || status >= 500
}

function callUpload(client, params) {
  return new Promise((resolve, reject) => {
    client.uploadFile(params, (error, result) => {
      if (error) return reject(error)
      const status = Number(result && result.statusCode || 200)
      return status >= 200 && status < 300
        ? resolve(result)
        : reject(Object.assign(new Error('upload failed'), { code: 'UPLOAD_FAILED', statusCode: status }))
    })
  })
}

function createEvidenceUploader({ cosFactory, beginUpload, finalizeUpload, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof cosFactory !== 'function' || typeof beginUpload !== 'function' || typeof finalizeUpload !== 'function') {
    throw new TypeError('cosFactory, beginUpload and finalizeUpload are required')
  }

  async function uploadOnce({ session, file, onProgress, signal }) {
    const client = cosFactory({
      getAuthorization: () => ({
        TmpSecretId: session.credentials.tmpSecretId,
        TmpSecretKey: session.credentials.tmpSecretKey,
        SecurityToken: session.credentials.sessionToken,
        StartTime: session.startTime,
        ExpiredTime: session.expiredTime
      })
    })
    let lastError
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      assertNotCancelled(signal)
      try {
        return await callUpload(client, {
          Bucket: session.bucket,
          Region: session.region,
          Key: session.objectKey,
          FilePath: file.path,
          onProgress: progress => {
            if (typeof onProgress === 'function') {
              const percent = Number(progress && progress.percent)
              onProgress(Math.max(0, Math.min(100, Math.round((Number.isFinite(percent) ? percent : 0) * 100))))
            }
          }
        })
      } catch (error) {
        lastError = error
        if (!isRetryable(error) || attempt >= RETRY_DELAYS_MS.length) throw error
        await delay(RETRY_DELAYS_MS[attempt])
      }
    }
    throw lastError
  }

  async function upload(input) {
    assertNotCancelled(input && input.signal)
    const beginInput = {
      businessLineId: input.businessLineId,
      nodeId: input.nodeId,
      expectedNodeVersion: input.expectedNodeVersion,
      fileName: input.file.name,
      declaredSize: input.file.size
    }
    for (let sessionAttempt = 0; sessionAttempt < 2; sessionAttempt += 1) {
      assertNotCancelled(input.signal)
      const session = await beginUpload(beginInput)
      await uploadOnce({ session, file: input.file, onProgress: input.onProgress, signal: input.signal })
      assertNotCancelled(input.signal)
      try {
        return await finalizeUpload({
          evidenceId: session.evidenceId,
          uploadSessionToken: session.uploadSessionToken,
          expectedNodeVersion: input.expectedNodeVersion
        })
      } catch (error) {
        if (error && error.code === 'EVIDENCE_UPLOAD_EXPIRED' && sessionAttempt === 0) continue
        throw error
      }
    }
    throw uploadError('EVIDENCE_UPLOAD_EXPIRED', '上传授权已过期')
  }

  return { upload }
}

module.exports = {
  RETRY_DELAYS_MS,
  createEvidenceUploader
}
