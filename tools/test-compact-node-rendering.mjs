import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const root = path.resolve(import.meta.dirname, '..', 'miniprogram');
const compiler = process.env.WECHAT_WCC_PATH;
assert.ok(compiler && fs.existsSync(compiler), 'Official WXML compiler required');
const cache = new Map();
function render(page, data) {
  const file = `pages/${page}/index.wxml`;
  if (!cache.has(file)) cache.set(file, execFileSync(compiler, [file], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(cache.get(file), context, { timeout: 5000 });
  return context.$gwx(file)(data);
}
const all = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(all)] : [];
const text = node => typeof node === 'string' ? node : (node?.children || []).map(text).join('');
const evidence = { evidenceId: 'e', fileName: '完整文件名不截断-原始凭证.pdf', category: 'pdf', storageStatus: 'purged', storageStatusLabel: '已清理' };
const history = [
  { feedbackId: 'new', revision: 2, statusLabel: '处理中', submittedAtText: '保存时间', fieldValues: [{ fieldKey: 'zero', name: '数量', valueText: '0' }, { fieldKey: 'no', name: '是否', valueText: '否' }, { fieldKey: 'options', name: '选项', valueText: '已选甲、已选乙' }], comment: '最近保存说明', evidences: [evidence] },
  { feedbackId: 'old', revision: 1, statusLabel: '受阻', submittedAtText: '旧时间', fieldValues: [{ fieldKey: 'old', name: '旧字段', valueText: '旧字段值' }], comment: '旧版说明', evidences: [{ ...evidence, evidenceId: 'old-e', fileName: '旧版完整附件.heic', storageStatus: 'available', canPreview: true, downloadOnly: true }] }
];
const base = { workflowMode: 'review', readOnly: true, history, visibleFields: [{ fieldKey: 'zero', type: 'number', name: '数量' }, { fieldKey: 'no', type: 'boolean', name: '是否' }, { fieldKey: 'long', type: 'long_text', name: '备注' }], fieldValues: { zero: 0, no: false, long: '正文' }, comment: '未保存草稿', feedbackHistoryOpen: false, reviewHistoryOpen: false, expandedFeedback: {}, reviewHistory: [] };

test('readonly current node uses latest saved label/value rows without disabled form controls', () => {
  const tree = render('node-feedback', base);
  for (const expected of ['最近保存内容', '数量', '0', '否', '已选甲、已选乙', '最近保存说明', evidence.fileName, '已清理']) assert.ok(text(tree).includes(expected), expected);
  assert.doesNotMatch(text(tree), /最终有效结果|最终通过|未保存草稿|旧版说明/);
  assert.equal(all(tree).some(n => ['wx-input', 'wx-textarea', 'wx-picker', 'wx-radio-group', 'wx-checkbox-group'].includes(n.tag)), false);
  const attachment = all(tree).find(n => n.attr?.['data-evidenceid'] === 'e');
  assert.equal(attachment.attr.bindtap, 'previewEvidence');
  assert.equal(attachment.attr['data-filename'], evidence.fileName);
  assert.ok(all(tree).some(n => n.attr?.bindtap === 'downloadAllEvidence'));
});

test('history outer and per-revision folds preserve all old values and attachment actions', () => {
  let state = { ...base, feedbackHistoryOpen: true };
  assert.doesNotMatch(text(render('node-feedback', state)), /旧字段值|旧版说明|旧版完整附件/);
  state = { ...state, expandedFeedback: { old: true } };
  const tree = render('node-feedback', state);
  for (const expected of ['旧字段值', '旧版说明', '旧版完整附件.heic', '下载']) assert.ok(text(tree).includes(expected), expected);
  assert.equal(all(tree).find(n => n.attr?.['data-evidenceid'] === 'old-e').attr.bindtap, 'previewEvidence');
  assert.doesNotMatch(text(render('node-feedback', { ...state, feedbackHistoryOpen: false })), /旧版说明/);
});

test('audit folding keeps all votes, time and comments reachable and errors visible when closed', () => {
  const rounds = [{ reviewRoundId: 'r', reviewRoundNumber: 2, processingRoundNumber: 2, submittedAtText: '提交时刻', statusLabel: '驳回', votes: [{ voteKey: 'a', reviewerDisplayName: '审核甲', decisionLabel: '通过', createdAtText: '时间甲', commentText: '甲意见\n原文' }, { voteKey: 'b', reviewerDisplayName: '审核乙', decisionLabel: '驳回', createdAtText: '时间乙', commentText: '乙意见' }] }];
  assert.doesNotMatch(text(render('node-feedback', { ...base, reviewHistory: rounds })), /甲意见|乙意见/);
  const tree = render('node-feedback', { ...base, reviewHistory: rounds, reviewHistoryOpen: true });
  for (const expected of ['提交时刻', '时间甲', '时间乙', '甲意见\n原文', '乙意见']) assert.ok(text(tree).includes(expected), expected);
  const error = render('node-feedback', { ...base, reviewHistoryError: '审核历史暂时无法查看，请重试' });
  assert.match(text(error), /审核历史暂时无法查看/);
  assert.ok(all(error).some(n => n.attr?.bindtap === 'onRetryReviewHistory'));
});

test('editing short text and number controls and draft lock remain intact', () => {
  const tree = render('node-feedback', { ...base, readOnly: false, reviewDraftLocked: true, visibleFields: [{ fieldKey: 'short', type: 'short_text' }, { fieldKey: 'zero', type: 'number' }] });
  assert.ok(all(tree).some(n => n.tag === 'wx-input' && n.attr.bindinput === 'onFieldInput' && n.attr.disabled === true));
  assert.ok(all(tree).some(n => n.tag === 'wx-input' && n.attr.bindinput === 'onNumberInput'));
  assert.ok(all(tree).some(n => n.tag === 'wx-textarea' && n.attr.bindinput === 'onComment'));
});

test('readonly header keeps identities and deadlines in compact metadata without changing editing header', () => {
  const state = { ...base, processorNamesText: '处理甲', reviewerNamesText: '审核甲', processingDueText: '处理截止时刻', reviewDueText: '审核截止时刻', reviewStartedText: '提交时刻' };
  const tree = render('node-feedback', state);
  const meta = all(tree).find(n => n.attr?.class === 'compact-meta');
  assert.ok(meta);
  for (const expected of ['处理甲', '审核甲', '处理截止时刻', '审核截止时刻', '提交时刻']) assert.ok(text(meta).includes(expected));
  assert.equal(all(render('node-feedback', { ...state, readOnly: false })).some(n => n.attr?.class === 'compact-meta'), false);
});

test('scan opt-in adds a guarded action while preserving manual short text input', () => {
  const state = { ...base, readOnly: false, scanningFieldKey: '', visibleFields: [{ fieldKey: 'scan', type: 'short_text', scanEnabled: true }, { fieldKey: 'manual', type: 'short_text' }, { fieldKey: 'wrong', type: 'number', scanEnabled: true }] };
  const tree = render('node-feedback', state);
  const scans = all(tree).filter(n => n.attr?.bindtap === 'onScanField');
  assert.equal(scans.length, 1);
  assert.equal(scans[0].attr['data-fieldkey'], 'scan');
  assert.ok(text(tree).includes('保留手动输入或粘贴；扫码后核对填入。'));
  for (const guard of [{ reviewDraftLocked: true }, { submitting: true }, { loadingHistory: true }, { scanningFieldKey: 'scan' }]) {
    const button = all(render('node-feedback', { ...state, ...guard })).find(n => n.attr?.bindtap === 'onScanField');
    assert.ok(button.attr.disabled);
    if (guard.scanningFieldKey) assert.equal(button.attr.loading, true);
  }
  assert.equal(all(render('node-feedback', { ...state, readOnly: true })).some(n => n.attr?.bindtap === 'onScanField'), false);
});

test('review snapshot groups compact fields and folds votes without changing pending actions', () => {
  const state = { loading: false, fields: history[0].fieldValues, evidences: [{ ...evidence, sequence: 1 }], votes: [{ voteKey: 'v', reviewerDisplayName: '审核甲', decisionLabel: '通过', createdAtText: '时刻', commentText: '原始意见' }], votesOpen: false, status: 'pending', canApprove: true, canReject: true, processingCommentText: '说明正文' };
  const tree = render('review-detail', state);
  assert.equal(all(tree).filter(n => n.attr?.class?.split(' ').includes('compact-fields')).length, 1);
  assert.ok(text(tree).includes(evidence.fileName));
  assert.doesNotMatch(text(tree), /原始意见/);
  for (const action of ['onApprove', 'onReject', 'onToggleVotes']) assert.ok(all(tree).some(n => n.attr?.bindtap === action));
  assert.ok(text(render('review-detail', { ...state, votesOpen: true })).includes('原始意见'));
});
