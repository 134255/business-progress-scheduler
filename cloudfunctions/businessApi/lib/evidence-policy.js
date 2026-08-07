const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const MB = 1024 * 1024
const MAX_SINGLE_FILE_SIZE = 20 * MB
const FEEDBACK_TOTAL_LIMIT = 20 * MB
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TYPE_POLICY = Object.freeze({
  jpg: { category: 'image', maximum: 5 * MB, signature: 'jpeg' },
  jpeg: { category: 'image', maximum: 5 * MB, signature: 'jpeg' },
  png: { category: 'image', maximum: 5 * MB, signature: 'png' },
  pdf: { category: 'pdf', maximum: MAX_SINGLE_FILE_SIZE, signature: 'pdf' },
  mp4: { category: 'video', maximum: MAX_SINGLE_FILE_SIZE, signature: 'video' },
  mov: { category: 'video', maximum: MAX_SINGLE_FILE_SIZE, signature: 'video' },
  m4v: { category: 'video', maximum: MAX_SINGLE_FILE_SIZE, signature: 'video' }
})

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function normalizedExtension(fileName) {
  if (typeof fileName !== 'string' || fileName !== fileName.trim() || !fileName || fileName.length > 255 ||
      /[\0-\x1f\x7f\\/]/.test(fileName)) {
    throw createError('UNSUPPORTED_FILE_TYPE')
  }
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) throw createError('UNSUPPORTED_FILE_TYPE')
  const extension = fileName.slice(dot + 1).toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(TYPE_POLICY, extension)) {
    throw createError('UNSUPPORTED_FILE_TYPE')
  }
  return extension
}

function detectSignature(bytes) {
  if (!Buffer.isBuffer(bytes)) throw createError('UNSUPPORTED_FILE_TYPE')
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video'
  throw createError('UNSUPPORTED_FILE_TYPE')
}

function classifyAndValidateFile({ fileName, declaredSize, bytes, allowedTypes }) {
  const extension = normalizedExtension(fileName)
  if (!Array.isArray(allowedTypes) || !allowedTypes.every(value => typeof value === 'string') ||
      !allowedTypes.map(value => value.toLowerCase()).includes(extension)) {
    throw createError('UNSUPPORTED_FILE_TYPE')
  }
  if (!Buffer.isBuffer(bytes)) throw createError('UNSUPPORTED_FILE_TYPE')
  const policy = TYPE_POLICY[extension]
  if (bytes.length > policy.maximum) throw createError('FILE_TOO_LARGE')
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize !== bytes.length) {
    throw createError('EVIDENCE_NOT_ATTACHABLE')
  }
  if (detectSignature(bytes) !== policy.signature) throw createError('UNSUPPORTED_FILE_TYPE')
  return {
    category: policy.category,
    extension,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  }
}

function validateFeedbackTotalSize(sizes) {
  if (!Array.isArray(sizes) || sizes.some(size => !Number.isSafeInteger(size) || size < 0)) {
    throw createError('EVIDENCE_NOT_ATTACHABLE')
  }
  let total = 0
  for (const size of sizes) {
    if (size > FEEDBACK_TOTAL_LIMIT - total) throw createError('FEEDBACK_TOTAL_TOO_LARGE')
    total += size
  }
  return total
}

module.exports = {
  FEEDBACK_TOTAL_LIMIT,
  MAX_SINGLE_FILE_SIZE,
  classifyAndValidateFile,
  validateFeedbackTotalSize
}
