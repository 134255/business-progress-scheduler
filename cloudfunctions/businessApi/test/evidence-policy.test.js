const test = require('node:test')
const assert = require('node:assert/strict')

const {
  FEEDBACK_TOTAL_LIMIT,
  MAX_SINGLE_FILE_SIZE,
  SUPPORTED_EVIDENCE_EXTENSIONS,
  classifyHeader,
  classifyAndValidateFile,
  validateFeedbackTotalSize
} = require('../lib/evidence-policy')

const MB = 1024 * 1024
const jpeg = size => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(size - 3)])
const png = size => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(size - 8)
])
const pdf = size => Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(size - 4)])
const ftyp = (brand, size = 24) => Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftyp'),
  Buffer.from(brand),
  Buffer.alloc(size - 12)
])
const video = size => ftyp('isom', size)
const webp = size => Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(size - 12)
])

function assertCode(code) {
  return error => error && error.code === code
}

test('classifies supported signatures and normalizes extension case without using MIME', () => {
  const fixtures = [
    { fileName: 'photo.JPEG', bytes: jpeg(20), allowedTypes: ['jpeg'], want: ['image', 'jpeg'] },
    { fileName: 'diagram.PnG', bytes: png(20), allowedTypes: ['png'], want: ['image', 'png'] },
    { fileName: 'report.PDF', bytes: pdf(20), allowedTypes: ['pdf'], want: ['pdf', 'pdf'] },
    { fileName: 'clip.MP4', bytes: video(20), allowedTypes: ['mp4'], want: ['video', 'mp4'] },
    { fileName: 'clip.MOV', bytes: video(20), allowedTypes: ['mov'], want: ['video', 'mov'] },
    { fileName: 'clip.M4V', bytes: video(20), allowedTypes: ['m4v'], want: ['video', 'm4v'] }
  ]

  for (const fixture of fixtures) {
    const result = classifyAndValidateFile({
      fileName: fixture.fileName,
      declaredSize: fixture.bytes.length,
      bytes: fixture.bytes,
      allowedTypes: fixture.allowedTypes
    })
    assert.deepEqual([result.category, result.extension, result.size], [...fixture.want, 20])
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
  }
})

test('bounded headers classify every approved image, video, and document extension', () => {
  assert.equal(FEEDBACK_TOTAL_LIMIT, 120 * MB)
  assert.equal(MAX_SINGLE_FILE_SIZE, FEEDBACK_TOTAL_LIMIT)
  assert.deepEqual(SUPPORTED_EVIDENCE_EXTENSIONS, [
    'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'mp4', 'mov', 'm4v'
  ])

  const fixtures = [
    { fileName: 'photo.jpg', bytes: jpeg(24), allowedTypes: ['jpg'], want: ['image', 'jpg'] },
    { fileName: 'photo.jpeg', bytes: jpeg(24), allowedTypes: ['jpeg'], want: ['image', 'jpeg'] },
    { fileName: 'photo.png', bytes: png(24), allowedTypes: ['png'], want: ['image', 'png'] },
    { fileName: 'photo.webp', bytes: webp(24), allowedTypes: ['webp'], want: ['image', 'webp'] },
    { fileName: 'photo.heic', bytes: ftyp('heic'), allowedTypes: ['heic'], want: ['image', 'heic'] },
    { fileName: 'photo.heif', bytes: ftyp('mif1'), allowedTypes: ['heif'], want: ['image', 'heif'] },
    { fileName: 'report.pdf', bytes: pdf(24), allowedTypes: ['pdf'], want: ['pdf', 'pdf'] },
    { fileName: 'clip.mp4', bytes: ftyp('mp42'), allowedTypes: ['mp4'], want: ['video', 'mp4'] },
    { fileName: 'clip.mov', bytes: ftyp('qt  '), allowedTypes: ['mov'], want: ['video', 'mov'] },
    { fileName: 'clip.m4v', bytes: ftyp('M4V '), allowedTypes: ['m4v'], want: ['video', 'm4v'] }
  ]

  for (const fixture of fixtures) {
    const result = classifyHeader({
      ...fixture,
      declaredSize: 120 * MB
    })
    assert.deepEqual([result.category, result.extension, result.size], [...fixture.want, 120 * MB])
    assert.equal(Object.hasOwn(result, 'sha256'), false)
  }
})

test('bounded header classifier accepts approved HEIF brands and rejects spoofed or unknown brands', () => {
  for (const brand of ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']) {
    assert.equal(classifyHeader({
      fileName: 'capture.heif',
      declaredSize: 24,
      bytes: ftyp(brand),
      allowedTypes: ['heif']
    }).category, 'image')
  }

  for (const fixture of [
    { fileName: 'photo.webp', bytes: jpeg(24), allowedTypes: ['webp'] },
    { fileName: 'photo.heic', bytes: ftyp('isom'), allowedTypes: ['heic'] },
    { fileName: 'clip.mp4', bytes: ftyp('heic'), allowedTypes: ['mp4'] },
    { fileName: 'clip.mov', bytes: ftyp('zzzz'), allowedTypes: ['mov'] },
    { fileName: 'photo.heif', bytes: ftyp('avif'), allowedTypes: ['heif'] }
  ]) {
    assert.throws(() => classifyHeader({
      ...fixture,
      declaredSize: fixture.bytes.length
    }), assertCode('UNSUPPORTED_FILE_TYPE'))
  }
})

test('bounded header classifier derives the single-object ceiling from the 120 MiB round total', () => {
  assert.equal(classifyHeader({
    fileName: 'report.pdf',
    declaredSize: 120 * MB,
    bytes: pdf(24),
    allowedTypes: ['pdf']
  }).size, 120 * MB)
  assert.throws(() => classifyHeader({
    fileName: 'report.pdf',
    declaredSize: 120 * MB + 1,
    bytes: pdf(24),
    allowedTypes: ['pdf']
  }), assertCode('FILE_TOO_LARGE'))
})

test('rejects spoofed, unsupported, malformed, and disallowed file types', () => {
  const rejected = [
    { fileName: 'report.jpg', bytes: pdf(20), allowedTypes: ['jpg', 'pdf'] },
    { fileName: 'photo.pdf', bytes: jpeg(20), allowedTypes: ['jpg', 'pdf'] },
    { fileName: 'archive.exe', bytes: Buffer.from('MZ executable'), allowedTypes: ['pdf'] },
    { fileName: 'no-extension', bytes: pdf(20), allowedTypes: ['pdf'] },
    { fileName: '.pdf', bytes: pdf(20), allowedTypes: ['pdf'] },
    { fileName: 'report.pdf', bytes: pdf(20), allowedTypes: ['jpg'] },
    { fileName: 'report.pdf', bytes: pdf(20), allowedTypes: ['toString'] },
    { fileName: 'report.pdf', bytes: Buffer.from('%PD'), allowedTypes: ['pdf'] },
    { fileName: 'report.pdf', bytes: new Uint8Array(pdf(20)), allowedTypes: ['pdf'] }
  ]

  for (const fixture of rejected) {
    assert.throws(() => classifyAndValidateFile({
      ...fixture,
      declaredSize: fixture.bytes.length
    }), assertCode('UNSUPPORTED_FILE_TYPE'))
  }
})

test('legacy full-buffer compatibility delegates to the same expanded policy', () => {
  for (const fixture of [
    { fileName: 'photo.webp', bytes: webp(24), allowedTypes: ['webp'] },
    { fileName: 'photo.heif', bytes: ftyp('heix'), allowedTypes: ['heif'] },
    { fileName: 'clip.mov', bytes: ftyp('qt  '), allowedTypes: ['mov'] }
  ]) {
    const result = classifyAndValidateFile({
      ...fixture,
      declaredSize: fixture.bytes.length
    })
    assert.equal(result.size, fixture.bytes.length)
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
  }
})

test('requires declared size to be a safe exact byte count', () => {
  const bytes = pdf(20)
  for (const declaredSize of [undefined, null, '20', 19, 21, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => classifyAndValidateFile({
      fileName: 'report.pdf', declaredSize, bytes, allowedTypes: ['pdf']
    }), assertCode('EVIDENCE_NOT_ATTACHABLE'))
  }
})

test('rejects a full buffer whose byte count disagrees with its declaration', () => {
  assert.throws(() => classifyAndValidateFile({
    fileName: 'photo.jpg', declaredSize: 1, bytes: jpeg(24), allowedTypes: ['jpg']
  }), assertCode('EVIDENCE_NOT_ATTACHABLE'))
})

test('feedback total helper allows 120 MiB exactly and rejects malformed or oversized totals', () => {
  assert.equal(validateFeedbackTotalSize([40 * MB, 80 * MB]), 120 * MB)
  assert.equal(validateFeedbackTotalSize([]), 0)
  assert.throws(() => validateFeedbackTotalSize([120 * MB, 1]), assertCode('FEEDBACK_TOTAL_TOO_LARGE'))
  assert.throws(() => validateFeedbackTotalSize([Number.MAX_SAFE_INTEGER]), assertCode('FEEDBACK_TOTAL_TOO_LARGE'))
  for (const sizes of [null, [1, -1], [1.5], ['1']]) {
    assert.throws(() => validateFeedbackTotalSize(sizes), assertCode('EVIDENCE_NOT_ATTACHABLE'))
  }
})
