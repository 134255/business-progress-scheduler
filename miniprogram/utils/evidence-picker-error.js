// Only fixed classifications and bounded numeric native codes may reach the UI.
// Native error text can contain local paths; never retain or display it.
function evidencePickerError(api, error, stage = 'native') {
  const message = error && typeof error.errMsg === 'string' ? error.errMsg.slice(0, 512) : ''
  if (stage === 'native' && /^(?:\w+:fail\s+)?(?:user\s+)?cancel(?:led)?[.!\s]*$/i.test(message)) return null
  // Native messages may append a URI or an absolute local path after the reason.
  // A file named privacy.mp4 must not become an authorization failure.
  const reason = message.split(/\b[a-z][a-z0-9+.-]*:\/\/|[a-z]:[\\/]|(?:^|\s|["'])[\\/]/i, 1)[0]
  let code = 'PICKER_FAILED'
  let text = '微信未能取回所选文件，请重新选择；仍失败请反馈下方诊断码'
  if (stage === 'unavailable') {
    code = 'PICKER_UNAVAILABLE'
    text = '当前微信不支持此文件选择接口，请更新微信后重试'
  } else if (stage === 'invoke') {
    code = 'PICKER_INVOKE_FAILED'
    text = '无法启动文件选择，请重新进入小程序后重试'
  } else if (stage === 'result') {
    code = 'PICKER_RESULT_INVALID'
    text = '所选文件信息处理失败，请重新选择并反馈下方诊断码'
  } else if (stage === 'partial') {
    code = 'PICKER_RESULT_PARTIAL'
    text = '部分文件信息无效，已保留其他有效文件；请重新选择未加入的文件'
  } else if (/privacy|隐私/i.test(reason)) {
    code = 'PICKER_PRIVACY_DENIED'
    text = '文件选择的隐私授权未完成，请检查小程序隐私授权后重试'
  } else if (/permission|auth\s*deny|authorize|authorization|access denied|权限|授权/i.test(reason)) {
    code = 'PICKER_PERMISSION_DENIED'
    text = '文件选择权限被拒绝，请检查微信的相册或相机权限后重试'
  } else if (/compress|transcod|encod|decod|codec|压缩|转码/i.test(reason)) {
    code = 'PICKER_MEDIA_PROCESSING_FAILED'
    text = '微信处理所选媒体失败，请重新选择文件'
  } else if (/read.*(?:file|video)|(?:file|video).*read|copy.*(?:file|video)|文件.*读取|读取.*文件/i.test(reason)) {
    code = 'PICKER_FILE_READ_FAILED'
    text = '微信读取所选文件失败，请确认文件已下载到本机后重试'
  }
  const safeApi = ['chooseMedia', 'chooseVideo', 'chooseImage', 'chooseMessageFile', 'showActionSheet'].includes(api) ? api : 'unknown'
  const safeStage = ['native', 'unavailable', 'invoke', 'result', 'partial'].includes(stage) ? stage : 'unknown'
  const nativeCode = error && Number.isSafeInteger(error.errCode) && Math.abs(error.errCode) <= 1000000000
    ? ` / ${error.errCode}` : ''
  return {
    code,
    message: text,
    diagnostic: `${code} / ${safeApi} / ${safeStage}${nativeCode}`,
    canRetryVideo: api === 'chooseMedia' && stage === 'native' &&
      ['PICKER_FAILED', 'PICKER_MEDIA_PROCESSING_FAILED', 'PICKER_FILE_READ_FAILED'].includes(code)
  }
}

function filterEvidencePickerResult(api, result) {
  if (!result || typeof result !== 'object') return null
  if (api === 'showActionSheet') return Number.isInteger(result.tapIndex) && result.tapIndex >= 0 && result.tapIndex <= 1
    ? { result, partial: false } : null
  const files = api === 'chooseVideo' ? [result] : result.tempFiles
  if (!Array.isArray(files) || files.length === 0) return null
  const pathKey = api === 'chooseVideo' || api === 'chooseMedia' ? 'tempFilePath' : 'path'
  const validFiles = files.filter(file => file && typeof file[pathKey] === 'string' && file[pathKey].trim() &&
    (file.name === undefined || typeof file.name === 'string') &&
    Number.isFinite(Number(file.size)) && Number(file.size) > 0)
  if (!validFiles.length) return null
  return {
    result: api === 'chooseVideo' ? validFiles[0] : { ...result, tempFiles: validFiles },
    partial: validFiles.length !== files.length
  }
}

module.exports = { evidencePickerError, filterEvidencePickerResult }
