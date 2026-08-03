const FUNCTION_NAME = 'businessApi'

async function callBusinessApi(action, payload) {
  try {
    const response = await wx.cloud.callFunction({
      name: FUNCTION_NAME,
      data: { action, payload: payload || {} }
    })

    const result = response.result || {}
    if (!result.ok) {
      throw new Error(result.message || '服务暂时不可用')
    }
    return result.data
  } catch (error) {
    const message = error && error.message ? error.message : '网络异常，请稍后重试'
    wx.showToast({ title: message, icon: 'none', duration: 2600 })
    throw error
  }
}

module.exports = { callBusinessApi }

