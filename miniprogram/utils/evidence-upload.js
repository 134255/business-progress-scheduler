const RETRY_DELAYS_MS = Object.freeze([250, 500])
const RETRYABLE_CODES = new Set([
  'RequestError', 'NetworkError', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UPLOAD_FAILED'
])
const AUTHORIZATION_EXPIRED_CODES = new Set([
  'ExpiredToken', 'ExpiredTokenException', 'InvalidSecurityToken', 'RequestTimeTooSkewed'
])
const AUTHORIZATION_REFRESH_WINDOW_SECONDS = 120
const MAX_AUTHORIZATION_REFRESHES = 8

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

function isAuthorizationExpired(error) {
  if (!error) return false
  if (AUTHORIZATION_EXPIRED_CODES.has(error.code) || AUTHORIZATION_EXPIRED_CODES.has(error.Code)) return true
  const status = Number(error.statusCode || error.status)
  const text = `${error.message || ''} ${error.error || ''} ${error.errMsg || ''}`.toLowerCase()
  return status === 403 && (text.includes('expired') || text.includes('security token'))
}

function authorizationOf(session) {
  return {
    TmpSecretId: session.credentials.tmpSecretId,
    TmpSecretKey: session.credentials.tmpSecretKey,
    SecurityToken: session.credentials.sessionToken,
    StartTime: session.startTime,
    ExpiredTime: session.expiredTime
  }
}

function mergeRefreshedSession(current, next) {
  if (!next || next.evidenceId !== current.evidenceId || next.objectKey !== current.objectKey ||
      next.bucket !== current.bucket || next.region !== current.region || !next.credentials ||
      !Number.isSafeInteger(next.startTime) || !Number.isSafeInteger(next.expiredTime) ||
      next.expiredTime <= next.startTime) {
    throw uploadError('EVIDENCE_UPLOAD_EXPIRED', '上传授权续期失败')
  }
  return {
    ...current,
    credentials: next.credentials,
    startTime: next.startTime,
    expiredTime: next.expiredTime,
    expiresAt: next.expiresAt
  }
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

function createEvidenceUploader({
  cosFactory,
  beginUpload,
  refreshUpload,
  finalizeUpload,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  nowSeconds = () => Math.floor(Date.now() / 1000)
}) {
  if (typeof cosFactory !== 'function' || typeof beginUpload !== 'function' ||
      typeof refreshUpload !== 'function' || typeof finalizeUpload !== 'function') {
    throw new TypeError('cosFactory, beginUpload, refreshUpload and finalizeUpload are required')
  }

  async function uploadOnce({ session, file, onProgress, signal }) {
    let currentSession = session
    let refreshPromise = null
    let authorizationError = null
    let maximumProgress = 0
    const refreshInput = {
      evidenceId: session.evidenceId,
      uploadSessionToken: session.uploadSessionToken,
      expectedNodeVersion: session.expectedNodeVersion
    }
    const refreshSession = async force => {
      const nearExpiry = currentSession.expiredTime <= nowSeconds() + AUTHORIZATION_REFRESH_WINDOW_SECONDS
      if (!force && !nearExpiry) return currentSession
      if (!refreshPromise) {
        refreshPromise = Promise.resolve(refreshUpload(refreshInput))
          .then(next => {
            currentSession = mergeRefreshedSession(currentSession, next)
            authorizationError = null
            return currentSession
          })
          .finally(() => { refreshPromise = null })
      }
      return refreshPromise
    }
    const client = cosFactory({
      getAuthorization: async () => authorizationOf(await refreshSession(false)),
      onAuthorizationError: error => { authorizationError = error }
    })
    let lastError
    let transportRetries = 0
    let authorizationRefreshes = 0
    while (true) {
      assertNotCancelled(signal)
      try {
        const result = await callUpload(client, {
          Bucket: currentSession.bucket,
          Region: currentSession.region,
          Key: currentSession.objectKey,
          FilePath: file.path,
          onProgress: progress => {
            if (typeof onProgress === 'function') {
              const percent = Number(progress && progress.percent)
              const nextProgress = Math.max(0, Math.min(100, Math.round((Number.isFinite(percent) ? percent : 0) * 100)))
              maximumProgress = Math.max(maximumProgress, nextProgress)
              onProgress(maximumProgress)
            }
          }
        })
        return { result, refreshSession }
      } catch (error) {
        lastError = authorizationError || error
        authorizationError = null
        if (isAuthorizationExpired(lastError) && authorizationRefreshes < MAX_AUTHORIZATION_REFRESHES) {
          authorizationRefreshes += 1
          await refreshSession(true)
          continue
        }
        if (!isRetryable(lastError) || transportRetries >= RETRY_DELAYS_MS.length) throw lastError
        await delay(RETRY_DELAYS_MS[transportRetries])
        transportRetries += 1
      }
    }
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
    const session = {
      ...(await beginUpload(beginInput)),
      expectedNodeVersion: input.expectedNodeVersion
    }
    const uploadState = await uploadOnce({
      session, file: input.file, onProgress: input.onProgress, signal: input.signal
    })
    for (let finalizeAttempt = 0; finalizeAttempt < 2; finalizeAttempt += 1) {
      assertNotCancelled(input.signal)
      try {
        return await finalizeUpload({
          evidenceId: session.evidenceId,
          uploadSessionToken: session.uploadSessionToken,
          expectedNodeVersion: input.expectedNodeVersion
        })
      } catch (error) {
        if (error && error.code === 'EVIDENCE_UPLOAD_EXPIRED' && finalizeAttempt === 0) {
          await uploadState.refreshSession(true)
          continue
        }
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
