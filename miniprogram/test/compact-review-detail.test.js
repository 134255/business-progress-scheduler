const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function setup(service = {}) {
  const file = path.join(__dirname, '../pages/review-detail/index.js')
  const localRequire = createRequire(file)
  const app = { globalData: { currentUser: { _id: 'synthetic', status: 'active' } } }
  const calls = []
  const wx = { setNavigationBarTitle() {}, reLaunch() {}, showToast: value => calls.push(value), previewImage: value => calls.push(value), downloadFile: async () => ({ tempFilePath: '/synthetic-download' }), saveFile: async value => calls.push(value) }
  let definition
  const snapshot = { reviewRoundId: 'r', businessLineId: 'l', nodeId: 'n', status: 'approved', version: 1, fieldValues: [{ fieldKey: 'zero', value: 0 }, { fieldKey: 'false', value: false }], processingComment: 'snapshot', evidences: [{ evidenceId: 'e' }], votes: [{ decision: 'approved', reviewerDisplayName: '审核甲', comment: '原始意见', createdAt: '2026-10-08T00:00:00Z' }] }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { definition = value }, getApp: () => app, wx, require: name => name === '../../services/business' ? { getReviewDetail: async () => snapshot, ...service } : localRequire(name) }, { filename: file })
  const page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update) } }
  return { page, calls, app }
}

test('review vote fold only changes presentation and keeps every original vote and field', async () => {
  const { page } = setup()
  await page.onLoad({ reviewRoundId: 'r' })
  const votes = page.data.votes
  assert.equal(page.data.votesOpen, false)
  page.onToggleVotes()
  assert.equal(page.data.votesOpen, true)
  assert.equal(page.data.votes, votes)
  assert.equal(page.data.fields[0].valueText, '0')
  assert.equal(page.data.fields[1].valueText, '否')
  page.onToggleVotes()
  assert.equal(page.data.votesOpen, false)
  assert.equal(page.data.votes[0].commentText, '原始意见')
})

test('review access loss clears compact snapshots and preview without suppressing the error', async () => {
  const { page } = setup({ getEvidenceAccess: async () => { throw Object.assign(new Error('当前账号无权查看该凭证'), { code: 'FORBIDDEN' }) } })
  await page.onLoad({ reviewRoundId: 'r' })
  page.setData({ videoPreview: { url: 'https://example.invalid/private' } })
  await page.previewEvidence({ currentTarget: { dataset: { id: 'e' } } })
  assert.equal(page.data.fields.length, 0)
  assert.equal(page.data.evidences.length, 0)
  assert.equal(page.data.votes.length, 0)
  assert.equal(page.data.videoPreview, null)
  assert.match(page.data.errorMessage, /无权查看/)
  assert.equal(page.data.canApprove, false)
})

test('retention errors remain visible and authorized preview exposes full filename', async () => {
  const context = setup({ getEvidenceAccess: async () => { throw Object.assign(new Error('凭证已超过保留期并清理'), { code: 'EVIDENCE_PURGED' }) } })
  await context.page.onLoad({ reviewRoundId: 'r' })
  await context.page.previewEvidence({ currentTarget: { dataset: { id: 'e' } } })
  assert.match(context.page.data.errorMessage, /超过保留期/)
  assert.equal(context.page.data.evidences.length, 1)
  const success = setup({ getEvidenceAccess: async () => ({ category: 'image', fileName: '完整长文件名-原始拍摄.png', url: 'https://example.invalid/image' }) })
  await success.page.onLoad({ reviewRoundId: 'r' })
  await success.page.previewEvidence({ currentTarget: { dataset: { id: 'e' } } })
  assert.equal(success.page.data.evidences[0].fileName, '完整长文件名-原始拍摄.png')
  assert.equal(success.calls[0].current, 'https://example.invalid/image')
})

test('HEIC evidence keeps original native image preview without a new save path', async () => {
  const { page, calls } = setup({ getEvidenceAccess: async () => ({ category: 'image', fileName: '原始.heic', url: 'https://example.invalid/heic' }) })
  await page.onLoad({ reviewRoundId: 'r' })
  await page.previewEvidence({ currentTarget: { dataset: { id: 'e' } } })
  assert.equal(calls.some(call => call.tempFilePath === '/synthetic-download'), false)
  assert.ok(calls.some(call => call.current === 'https://example.invalid/heic'))
})
