'use strict'

function safeError(category) {
  const error = new Error('cloud storage operation failed')
  error.category = category
  return error
}

function createCloudStorageAdapter({ cloud } = {}) {
  if (!cloud || typeof cloud.deleteFile !== 'function') throw new TypeError('cloud.deleteFile is required')

  async function deleteObject(fileId) {
    if (typeof fileId !== 'string' || !fileId.startsWith('cloud://') || fileId.length > 2048) {
      throw safeError('INVALID_RECORD')
    }
    let result
    try {
      result = await cloud.deleteFile({ fileList: [fileId] })
    } catch (error) {
      const marker = `${error && error.errCode || ''} ${error && error.code || ''} ${error && error.message || ''}`
      if (/not.?found|does not exist|file_not_found/i.test(marker)) return { absent: true }
      throw safeError('TRANSIENT')
    }
    const item = result && Array.isArray(result.fileList) ? result.fileList[0] : null
    if (!item || item.status !== 0) throw safeError('TRANSIENT')
    return { absent: false }
  }

  return { deleteObject }
}

module.exports = { createCloudStorageAdapter }
