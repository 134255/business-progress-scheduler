const HEADER_LENGTH = 64
const MAX_FILE_SIZE = 120 * 1024 * 1024
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function readError() {
  return Object.assign(new Error('无法读取本机文件，请重新选择后重试'), { code: 'EVIDENCE_FILE_READ_FAILED' })
}

// An image upload can have PNG bytes under a .jpg temporary/original name.
// Normalize only that verified mismatch; never rewrite or transcode bytes.
async function prepareEvidenceFile(file) {
  if (!file || typeof file.name !== 'string' || !/\.(jpe?g)$/i.test(file.name)) return file
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_SIZE ||
      typeof file.path !== 'string' || !file.path) throw readError()
  const length = Math.min(HEADER_LENGTH, file.size)
  const data = await new Promise((resolve, reject) => {
    try {
      const fs = wx.getFileSystemManager()
      fs.readFile({ filePath: file.path, position: 0, length,
        success: result => resolve(result && result.data), fail: () => reject(readError()) })
    } catch (error) { reject(readError()) }
  })
  if (!(data instanceof ArrayBuffer) || data.byteLength !== length) throw readError()
  const bytes = new Uint8Array(data)
  if (bytes.length >= PNG_HEADER.length && PNG_HEADER.every((value, index) => bytes[index] === value)) {
    return { ...file, name: file.name.replace(/\.(jpe?g)$/i, '.png'), extension: 'png', category: 'image' }
  }
  // JPEG and all other signatures still go through the authoritative server
  // classifier. This is not an extension-only permission or format bypass.
  return file
}

module.exports = { prepareEvidenceFile }
