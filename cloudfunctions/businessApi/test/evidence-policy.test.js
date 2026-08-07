const test = require('node:test')
const assert = require('node:assert/strict')

const {
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
const video = size => Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('isom'), Buffer.alloc(size - 12)])

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

test('accepts exact per-file byte boundaries and rejects one byte over', () => {
  for (const fixture of [
    { fileName: 'photo.jpg', bytes: jpeg(5 * MB), allowedTypes: ['jpg'] },
    { fileName: 'photo.png', bytes: png(5 * MB), allowedTypes: ['png'] },
    { fileName: 'report.pdf', bytes: pdf(20 * MB), allowedTypes: ['pdf'] },
    { fileName: 'clip.mp4', bytes: video(20 * MB), allowedTypes: ['mp4'] }
  ]) {
    assert.equal(classifyAndValidateFile({
      ...fixture,
      declaredSize: fixture.bytes.length
    }).size, fixture.bytes.length)
  }

  for (const fixture of [
    { fileName: 'photo.jpeg', bytes: jpeg(5 * MB + 1), allowedTypes: ['jpeg'] },
    { fileName: 'photo.png', bytes: png(5 * MB + 1), allowedTypes: ['png'] },
    { fileName: 'report.pdf', bytes: pdf(20 * MB + 1), allowedTypes: ['pdf'] },
    { fileName: 'clip.mov', bytes: video(20 * MB + 1), allowedTypes: ['mov'] }
  ]) {
    assert.throws(() => classifyAndValidateFile({
      ...fixture,
      declaredSize: fixture.bytes.length
    }), assertCode('FILE_TOO_LARGE'))
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

test('rejects an oversized downloaded buffer as too large even when declared size is spoofed smaller', () => {
  assert.throws(() => classifyAndValidateFile({
    fileName: 'photo.jpg', declaredSize: 1, bytes: jpeg(5 * MB + 1), allowedTypes: ['jpg']
  }), assertCode('FILE_TOO_LARGE'))
})

test('feedback total helper allows 20 MB exactly and rejects malformed or oversized totals', () => {
  assert.equal(validateFeedbackTotalSize([5 * MB, 15 * MB]), 20 * MB)
  assert.equal(validateFeedbackTotalSize([]), 0)
  assert.throws(() => validateFeedbackTotalSize([20 * MB, 1]), assertCode('FEEDBACK_TOTAL_TOO_LARGE'))
  assert.throws(() => validateFeedbackTotalSize([Number.MAX_SAFE_INTEGER]), assertCode('FEEDBACK_TOTAL_TOO_LARGE'))
  for (const sizes of [null, [1, -1], [1.5], ['1']]) {
    assert.throws(() => validateFeedbackTotalSize(sizes), assertCode('EVIDENCE_NOT_ATTACHABLE'))
  }
})
