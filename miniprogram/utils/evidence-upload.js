const RETRY_DELAYS_MS = Object.freeze([250, 500])
const MAX_STAGE_ATTEMPTS = RETRY_DELAYS_MS.length + 1
const { recordPerformanceTiming, readTimingClock, notifyTiming } = require('./performance-timing')
const RETRYABLE_CODES = new Set([
  'RequestError', 'NetworkError', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UPLOAD_FAILED',
  'SlowDown', 'InternalError'
])
const AUTHORIZATION_EXPIRED_CODES = new Set([
  'ExpiredToken', 'ExpiredTokenException', 'InvalidSecurityToken', 'RequestTimeTooSkewed'
])
const AUTHORIZATION_REFRESH_WINDOW_SECONDS = 120

function uploadError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

async function atUploadStage(stage, action) {
  try {
    return await action()
  } catch (error) {
    const failure = attemptFailure(error, error && error.attempts)
    failure.uploadStage = stage
    throw failure
  }
}

function assertNotCancelled(signal) {
  if (signal && signal.aborted) throw uploadError('UPLOAD_CANCELLED', '上传已取消')
}

function isRetryable(error) {
  if (!error || !RETRYABLE_CODES.has(error.code) &&
      !['EVIDENCE_UPLOAD_RETRYABLE', 'EVIDENCE_UPLOAD_FAILED'].includes(error.code)) return false
  const status = Number(error.statusCode)
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false
  return RETRYABLE_CODES.has(error.code) || error.code === 'EVIDENCE_UPLOAD_RETRYABLE' ||
    status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function attemptFailure(error, attempts) {
  // Preserve only upload error fields, never a provider's body, path or credentials.
  const source = error && typeof error.error === 'object' && error.error ? error.error : error
  const failure = uploadError(source && (source.code || source.Code) || error && error.code || 'EVIDENCE_UPLOAD_FAILED', '上传失败，请重试')
  const status = Number(error && error.statusCode || source && source.statusCode)
  if (Number.isInteger(status) && status >= 100 && status <= 599) failure.statusCode = status
  if (Number.isInteger(attempts) && attempts >= 1 && attempts <= MAX_STAGE_ATTEMPTS) failure.attempts = attempts
  return failure
}

function isAuthorizationExpired(error) {
  if (!error) return false
  const code = attemptFailure(error).code
  if (AUTHORIZATION_EXPIRED_CODES.has(code)) return true
  if (code !== 'EVIDENCE_UPLOAD_FAILED' && !RETRYABLE_CODES.has(code)) return false
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
  prepareFile,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  nowSeconds = () => Math.floor(Date.now() / 1000),
  clock = Date.now,
  onTiming = recordPerformanceTiming
}) {
  if (typeof cosFactory !== 'function' || typeof beginUpload !== 'function' ||
      typeof refreshUpload !== 'function' || typeof finalizeUpload !== 'function') {
    throw new TypeError('cosFactory, beginUpload, refreshUpload and finalizeUpload are required')
  }
  // One uploader belongs to one page operation. Transfer stays parallel; only
  // registration is queued. A rejected file must never poison the next one.
  let finalizeTail = Promise.resolve()

  async function timedUploadStage(stage, action) {
    const startedAt = readTimingClock(clock)
    let outcomeCode = 'ERROR'
    try {
      const result = await atUploadStage(stage, action)
      outcomeCode = 'OK'
      return result
    } finally {
      try {
        const endedAt = readTimingClock(clock)
        const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt)
          ? Math.max(0, Math.round(endedAt - startedAt)) : 0
        notifyTiming(onTiming, { action: 'evidenceUpload', stage, durationMs, outcomeCode })
      } catch (error) {}
    }
  }

  async function uploadOnce({ session, file, onProgress, assertCurrent, reportStatus }) {
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
      assertCurrent()
      const nearExpiry = currentSession.expiredTime <= nowSeconds() + AUTHORIZATION_REFRESH_WINDOW_SECONDS
      if (!force && !nearExpiry) return currentSession
      if (!refreshPromise) {
        refreshPromise = Promise.resolve(refreshUpload(refreshInput))
          .then(next => {
            assertCurrent()
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
    for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
      assertCurrent()
      reportStatus('transfer', attempt)
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
        const lastError = authorizationError || error
        authorizationError = null
        const failure = attemptFailure(lastError, attempt)
        if (attempt === MAX_STAGE_ATTEMPTS) throw failure
        if (isAuthorizationExpired(lastError)) {
          await refreshSession(true)
          continue
        }
        if (!isRetryable(failure)) throw failure
        await delay(RETRY_DELAYS_MS[attempt - 1])
      }
    }
  }

  async function upload(input) {
    assertNotCancelled(input && input.signal)
    const assertCurrent = () => {
      assertNotCancelled(input && input.signal)
      if (typeof input.isCurrent === 'function' && !input.isCurrent()) throw uploadError('UPLOAD_CANCELLED', '上传已取消')
    }
    const reportStatus = (stage, attempt) => {
      try {
        if (typeof input.onStatus === 'function') input.onStatus({ stage, attempt, maxAttempts: MAX_STAGE_ATTEMPTS })
      } catch (_) { /* Display observers cannot alter upload outcomes. */ }
    }
    assertCurrent()
    const file = typeof prepareFile === 'function'
      ? await atUploadStage('prepare', () => prepareFile(input.file)) : input.file
    assertCurrent()
    const beginInput = {
      businessLineId: input.businessLineId,
      nodeId: input.nodeId,
      expectedNodeVersion: input.expectedNodeVersion,
      fileName: file.name,
      declaredSize: file.size
    }
    const session = {
      ...(await timedUploadStage('authorize', () => beginUpload(beginInput))),
      expectedNodeVersion: input.expectedNodeVersion
    }
    assertCurrent()
    const uploadState = await timedUploadStage('transfer', () => uploadOnce({
      session, file, onProgress: input.onProgress, assertCurrent, reportStatus
    }))
    assertCurrent()
    reportStatus('finalize', 0)
    const registration = finalizeTail.then(() => timedUploadStage('finalize', async () => {
      let refreshed = false
      for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
        assertCurrent()
        reportStatus('finalize', attempt)
        try {
          return await finalizeUpload({
            evidenceId: session.evidenceId,
            uploadSessionToken: session.uploadSessionToken,
            expectedNodeVersion: input.expectedNodeVersion
          })
        } catch (error) {
          const failure = attemptFailure(error, attempt)
          if (attempt === MAX_STAGE_ATTEMPTS) throw failure
          if (error && error.code === 'EVIDENCE_UPLOAD_EXPIRED' && !refreshed) {
            refreshed = true
            await uploadState.refreshSession(true)
            continue
          }
          if (!isRetryable(failure)) throw failure
          await delay(RETRY_DELAYS_MS[attempt - 1])
        }
      }
    }))
    finalizeTail = registration.catch(() => {})
    return registration
  }

  return { upload }
}

module.exports = {
  RETRY_DELAYS_MS,
  createEvidenceUploader
}
