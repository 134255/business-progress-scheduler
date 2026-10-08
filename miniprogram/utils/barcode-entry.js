// Optional input assistance only: no network writes, product lookup or submission.
function editableField(page, key) {
  const data = page.data
  if (!page.pageAlive || !page.actorStillCurrent() || !data.canSubmit || data.readOnly ||
      data.reviewDraftLocked || data.submitting || data.loadingHistory) return null
  return data.visibleFields.find(field => field.fieldKey === key &&
    field.type === 'short_text' && field.scanEnabled === true) || null
}

function snapshot(page, field) {
  const data = page.data
  return JSON.stringify([page.loadActorId, data.lineId, data.nodeId, data.expectedNodeVersion,
    page.loadSequence, page.formRevision, page.definitionSchemaFingerprint, field, data.fieldValues])
}

function validText(value, constraints = {}) {
  // Never silently truncate/normalize a serial number or convert it to a number.
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return false
  if (constraints.minLength !== undefined && value.length < constraints.minLength ||
      constraints.maxLength !== undefined && value.length > constraints.maxLength) return false
  try { return !constraints.pattern || new RegExp(constraints.pattern).test(value) } catch (_) { return false }
}

async function scanIntoField(page, key, api) {
  if (page.scanRequestActive) return false
  const field = editableField(page, key)
  if (!field) return false
  const before = snapshot(page, field)
  const stillCurrent = () => {
    const current = editableField(page, key)
    return Boolean(current && before === snapshot(page, current))
  }
  const notice = title => {
    if (stillCurrent()) api.showToast({ title, icon: 'none' })
  }
  page.scanRequestActive = true
  page.setData({ scanningFieldKey: key })
  try {
    if (typeof api.scanCode !== 'function' || typeof api.canIUse === 'function' && !api.canIUse('scanCode')) {
      notice('当前端不支持扫码，请手动输入或粘贴')
      return false
    }
    const scanned = await new Promise((resolve, reject) => api.scanCode({
      onlyFromCamera: false,
      scanType: ['barCode', 'qrCode', 'datamatrix', 'pdf417'],
      success: resolve, fail: reject
    }))
    if (!stillCurrent()) return false
    const value = scanned && scanned.result
    if (!validText(value, field.constraints)) {
      notice('识别内容不符合字段要求，请手动填写')
      return false
    }
    const oldValue = page.data.fieldValues[key]
    const replacing = oldValue !== null && oldValue !== undefined && oldValue !== ''
    const confirmed = await new Promise(resolve => api.showModal({
      title: replacing ? '确认替换字段内容' : '确认扫码内容',
      content: `${field.name}\n${value}\n\n${replacing ? '确认后将替换已有内容。' : ''}请核对是否为商品唯一码；仅填入，不自动提交。`,
      confirmText: replacing ? '确认替换' : '确认填入',
      success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false)
    }))
    if (!confirmed || !stillCurrent()) return false
    // Linked fields may require a second clearing confirmation. Keep the same
    // freshness check until the form's actual synchronous commit, not just here.
    return Boolean(await page.applyConditionalValues(
      { ...page.data.fieldValues, [key]: value }, {}, undefined, stillCurrent
    ))
  } catch (error) {
    if (!/cancel/i.test(String(error && error.errMsg || ''))) {
      notice('无法完成扫码，请检查授权或手动输入、粘贴')
    }
    return false
  } finally {
    page.scanRequestActive = false
    if (page.pageAlive) page.setData({ scanningFieldKey: '' })
  }
}

module.exports = { scanIntoField }
