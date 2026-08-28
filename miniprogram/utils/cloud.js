const FUNCTION_NAME = 'businessApi'

async function callBusinessApi(action, payload, options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now
  const onTiming = typeof options.onTiming === 'function' ? options.onTiming : null
  const startedAt = Number(clock())
  let outcomeCode = 'NETWORK_ERROR'
  try {
    const response = await wx.cloud.callFunction({
      name: FUNCTION_NAME,
      data: { action, payload: payload || {} }
    })

    const result = response.result || {}
    if (!result.ok) {
      const error = new Error(result.message || '服务暂时不可用')
      error.code = result.code || 'BUSINESS_ERROR'
      outcomeCode = error.code
      throw error
    }
    outcomeCode = 'OK'
    return result.data
  } catch (error) {
    if (error && typeof error.code === 'string') outcomeCode = error.code
    const message = error && error.message ? error.message : '网络异常，请稍后重试'
    if (!options.silent) {
      wx.showToast({ title: message, icon: 'none', duration: 2600 })
    }
    throw error
  } finally {
    if (onTiming) {
      const endedAt = Number(clock())
      const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(outcomeCode) ? outcomeCode : 'BUSINESS_ERROR'
      const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt)
        ? Math.max(0, Math.round(endedAt - startedAt))
        : 0
      try { onTiming({ action: String(action || ''), durationMs, outcomeCode: safeCode }) } catch (error) {}
    }
  }
}

module.exports = { callBusinessApi }

