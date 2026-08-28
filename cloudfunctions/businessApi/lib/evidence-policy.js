const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')

const MB = 1024 * 1024
const FEEDBACK_TOTAL_LIMIT = 120 * MB
const MAX_SINGLE_FILE_SIZE = FEEDBACK_TOTAL_LIMIT
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'avc1', 'mp41', 'mp42', 'qt  ', 'M4V '])
const SUPPORTED_EVIDENCE_EXTENSIONS = Object.freeze([
  'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'mov', 'm4v'
])
const TYPE_POLICY = Object.freeze({
  jpg: { category: 'image', signature: 'jpeg' },
  jpeg: { category: 'image', signature: 'jpeg' },
  png: { category: 'image', signature: 'png' },
  webp: { category: 'image', signature: 'webp' },
  heic: { category: 'image', signature: 'heif' },
  heif: { category: 'image', signature: 'heif' },
  pdf: { category: 'pdf', maximum: MAX_SINGLE_FILE_SIZE, signature: 'pdf' },
  mp4: { category: 'video', signature: 'video' },
  mov: { category: 'video', signature: 'video' },
  m4v: { category: 'video', signature: 'video' }
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
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii')
    if (HEIF_BRANDS.has(brand)) return 'heif'
    if (VIDEO_BRANDS.has(brand)) return 'video'
  }
  throw createError('UNSUPPORTED_FILE_TYPE')
}

function normalizedAllowedTypes(allowedTypes) {
  if (!Array.isArray(allowedTypes)) throw createError('UNSUPPORTED_FILE_TYPE')
  const normalized = []
  for (let index = 0; index < allowedTypes.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(allowedTypes, String(index))
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'string') throw createError('UNSUPPORTED_FILE_TYPE')
    normalized.push(descriptor.value.toLowerCase())
  }
  return normalized
}

function classifyHeader({ fileName, declaredSize, bytes, allowedTypes }) {
  const extension = normalizedExtension(fileName)
  if (!normalizedAllowedTypes(allowedTypes).includes(extension)) {
    throw createError('UNSUPPORTED_FILE_TYPE')
  }
  if (!Buffer.isBuffer(bytes)) throw createError('UNSUPPORTED_FILE_TYPE')
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || bytes.length > declaredSize) {
    throw createError('EVIDENCE_NOT_ATTACHABLE')
  }
  if (declaredSize > MAX_SINGLE_FILE_SIZE) throw createError('FILE_TOO_LARGE')
  const policy = TYPE_POLICY[extension]
  if (detectSignature(bytes) !== policy.signature) throw createError('UNSUPPORTED_FILE_TYPE')
  return {
    category: policy.category,
    extension,
    size: declaredSize
  }
}

function classifyAndValidateFile({ fileName, declaredSize, bytes, allowedTypes }) {
  if (!Buffer.isBuffer(bytes)) throw createError('UNSUPPORTED_FILE_TYPE')
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize !== bytes.length) {
    throw createError('EVIDENCE_NOT_ATTACHABLE')
  }
  const result = classifyHeader({ fileName, declaredSize, bytes, allowedTypes })
  return {
    ...result,
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
  SUPPORTED_EVIDENCE_EXTENSIONS,
  classifyHeader,
  classifyAndValidateFile,
  validateFeedbackTotalSize
}
