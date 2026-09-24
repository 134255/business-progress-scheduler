import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const root = path.resolve(import.meta.dirname, '..', 'miniprogram');
const compiler = process.env.WECHAT_WCC_PATH;
assert.ok(compiler && fs.existsSync(compiler), 'Official WXML compiler required');
function render(file, data) {
  const compiled = execFileSync(compiler, [file], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const context = vm.createContext({ window: {}, console });
  vm.runInContext(compiled, context, { timeout: 5000 });
  return context.$gwx(file)(data);
}
function all(node) { return node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(all)] : []; }
function text(node) { return typeof node === 'string' ? node : (node?.children || []).map(text).join(''); }
const file = 'components/previous-node-records/index.wxml';
test('official component renders final readonly fields, complete review comments and evidence states', () => {
  const tree = render(file, { enabled: true, opened: true, selectedId: 'n', nodes: [{ _id: 'n', name: '前序', nodeCode: 'N001' }],
    result: { processingRoundNumber: 2, processorDisplayName: '处理甲', submittedAtText: '合成时间', completedAtText: '合成完成时间',
      fields: [{ fieldKey: 'zero', name: '数量', valueText: '0' }], processingComment: '处理\n正文', reviewRequired: true,
      evidences: [{ evidenceId: 'e', fileName: '文件.pdf', unavailable: true, stateText: '已清理' }],
      votes: [{ key: 0, reviewerDisplayName: '审核乙', decisionText: '通过', timeText: '合成审核时间', commentText: '意见\n<正文>&内容' }] } });
  for (const expected of ['最终有效结果', '处理甲', '数量', '0', '已清理', '审核乙', '意见\n<正文>&内容']) assert.ok(text(tree).includes(expected), expected);
  assert.equal(all(tree).some(n => ['wx-input', 'wx-textarea', 'wx-picker', 'wx-checkbox'].includes(n.tag)), false);
  assert.equal(all(tree).find(n => n.attr?.['data-id'] === 'e').attr.disabled, true);
});
test('collapsed component hides private final and historical content', () => {
  const tree = render(file, { enabled: true, opened: false, result: { processingComment: 'private' }, history: [{ comment: 'private' }] });
  assert.equal(text(tree).includes('private'), false);
});

test('history entry summaries do not render duplicate fields, evidence or votes until that entry is opened', () => {
  const state = { enabled: true, opened: true, selectedId: 'n', nodes: [{ _id: 'n', workflowMode: 'review' }], historyOpen: true, reviewsOpen: true,
    history: [{ feedbackId: 'f', opened: false, statusText: '保存进度', fields: [{ fieldKey: 'field', valueText: '保存字段内容' }], comment: '历史处理说明', evidences: [{ evidenceId: 'e', fileName: '历史视频.mp4' }] }],
    rounds: [{ reviewRoundId: 'r', opened: false, statusText: '通过', votes: [{ key: 0, commentText: '历史审核意见' }] }] };
  let tree = render(file, state);
  assert.ok(text(tree).includes('保存进度'));
  for (const hidden of ['保存字段内容', '历史处理说明', '历史视频.mp4', '历史审核意见']) assert.equal(text(tree).includes(hidden), false, hidden);
  state.history[0].opened = true; state.rounds[0].opened = true;
  tree = render(file, state);
  for (const visible of ['保存字段内容', '历史处理说明', '历史视频.mp4', '历史审核意见']) assert.ok(text(tree).includes(visible), visible);
});

test('video preview has a separate modal, error handler, cancellation, and a return-to-current action', () => {
  const tree = render(file, { enabled: true, opened: true, nodes: [], videoPreview: { url: 'https://example.invalid/video', fileName: '视频.mov' }, returnLabel: '返回当前审核' });
  const modal = all(tree).find(n => n.attr?.class?.includes('video-mask'));
  assert.ok(modal, 'player must not be placed in the historical document flow');
  assert.ok(all(modal).some(n => n.tag === 'wx-video' && n.attr?.binderror === 'onVideoError'));
  assert.ok(text(modal).includes('关闭预览'));
  assert.ok(text(tree).includes('返回当前审核'));
});
for (const page of ['node-feedback', 'review-detail']) {
  test(`official ${page} page wires shared readonly component with its existing identity`, () => {
    const tree = render(`pages/${page}/index.wxml`, { loading: false, lineId: 'line', businessLineId: 'line', nodeId: 'node', previousRecordsEnabled: true });
    const component = all(tree).find(n => n.tag === 'wx-previous-node-records');
    assert.ok(component);
    assert.equal(component.attr.businessLineId, 'line'); assert.equal(component.attr.nodeId, 'node');
    assert.equal(component.attr.enabled, true);
    assert.equal(component.attr.bindreturntocurrent, 'returnToCurrentForm');
    assert.ok(all(tree).some(n => n.attr?.id === 'current-node-form'));
    const config = JSON.parse(fs.readFileSync(path.join(root, `pages/${page}/index.json`), 'utf8'));
    assert.equal(config.usingComponents['previous-node-records'], '/components/previous-node-records/index');
  });
}
