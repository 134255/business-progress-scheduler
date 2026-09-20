const test = require('node:test')
const assert = require('node:assert/strict')
const { prepareEvidenceFile } = require('../utils/evidence-file')

const image = () => ({ name: 'local image.JPEG', path: 'wxfile://original', size: 56125 })
function withReader(t, readFile) {
  const previous = Object.getOwnPropertyDescriptor(global, 'wx')
  global.wx = { getFileSystemManager: () => ({ readFile }) }
  t.after(() => {
    if (previous) Object.defineProperty(global, 'wx', previous)
    else delete global.wx
  })
}

test('only a verified PNG signature can normalize a JPG name, without modifying the source object or path', async t => {
  const source = Object.freeze(image())
  withReader(t, options => {
    assert.deepEqual([options.filePath, options.position, options.length, options.encoding], [source.path, 0, 64, undefined])
    const bytes = new Uint8Array(64)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    options.success({ data: bytes.buffer })
  })
  assert.deepEqual(await prepareEvidenceFile(source), { ...source, name: 'local image.png', extension: 'png', category: 'image' })
  assert.equal(source.name, 'local image.JPEG')
})

for (const header of [[255, 216, 255, 224], [37, 80, 68, 70], [77, 90], [137, 80, 78, 71, 0, 0, 0, 0]]) {
  test(`non-PNG header ${header[0]}-${header[1]} is not relabeled or accepted on the client`, async t => {
    const source = image()
    withReader(t, options => { const bytes = new Uint8Array(64); bytes.set(header); options.success({ data: bytes.buffer }) })
    assert.equal(await prepareEvidenceFile(source), source)
  })
}

test('video, PDF and already-correct PNG paths do not add filesystem work', async t => {
  withReader(t, () => assert.fail('unrelated formats must not be read'))
  for (const name of ['clip.MOV', 'clip.mp4', 'report.pdf', 'photo.png', 'photo.heic']) {
    const source = { ...image(), name }
    assert.equal(await prepareEvidenceFile(source), source)
  }
})

for (const mode of ['failure', 'throw', 'string', 'short', 'long', 'missing']) {
  test(`header read ${mode} fails safely without transmitting a guessed filename`, async t => {
    withReader(t, options => {
      if (mode === 'failure') return options.fail({ errMsg: 'secret private-file-path' })
      if (mode === 'throw') throw new Error('secret private-file-path')
      options.success({ data: mode === 'string' ? 'private content' :
        mode === 'short' ? new ArrayBuffer(63) : mode === 'long' ? new ArrayBuffer(65) : undefined })
    })
    await assert.rejects(prepareEvidenceFile(image()), error => {
      assert.equal(error.code, 'EVIDENCE_FILE_READ_FAILED')
      assert.doesNotMatch(error.message, /secret|private/)
      return true
    })
  })
}

test('short files read only their actual size; malformed and oversized declarations are rejected before filesystem access', async t => {
  let reads = 0
  withReader(t, options => {
    reads += 1
    assert.equal(options.length, 3)
    options.success({ data: Uint8Array.from([255, 216, 255]).buffer })
  })
  const source = { ...image(), size: 3 }
  assert.equal(await prepareEvidenceFile(source), source)
  for (const size of [0, -1, NaN, 1.5, '64', 125829121]) {
    await assert.rejects(prepareEvidenceFile({ ...image(), size }), { code: 'EVIDENCE_FILE_READ_FAILED' })
  }
  assert.equal(reads, 1)
})
