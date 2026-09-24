import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Official WXML virtual-tree checks; not native/mobile layout acceptance.
const require = createRequire(import.meta.url);
const miniRoot = path.resolve(import.meta.dirname, '..', 'miniprogram');
const compilerPath = process.env.WECHAT_WCC_PATH;
assert.ok(compilerPath && fs.existsSync(compilerPath), 'Set WECHAT_WCC_PATH to the installed official WXML compiler');

function compile(page) {
  const file = `pages/${page}/index.wxml`;
  const templateRoot = path.join(miniRoot, 'templates');
  const imports = fs.existsSync(templateRoot)
    ? fs.readdirSync(templateRoot).filter(name => name.endsWith('.wxml')).map(name => `templates/${name}`)
    : [];
  const compiled = execFileSync(compilerPath, [file, ...imports], {
    cwd: miniRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024
  });
  return data => {
    const context = vm.createContext({ window: {}, console });
    vm.runInContext(compiled, context, { timeout: 5000 });
    return context.$gwx(file)(data);
  };
}

const renderEditor = compile('admin-template-edit');

test('official enabled-template editor keeps flow readonly but card configuration independently editable', () => {
  const { presentBusinessCard } = require('../miniprogram/utils/business-card');
  const tree = renderEditor({
    readOnly: true, editMode: true, loading: false, submitting: false,
    name: '合成模板', description: '', status: 'enabled', version: 2, nodes: [],
    cardLoaded: true, cardLoading: false, cardSubmitting: false, cardRevision: 1,
    cardFields: [{ id: 'field-1', nodeName: '示例节点', label: '数量' }],
    cardNodeOptions: [{ name: '示例节点' }], cardNodeIndex: 0,
    cardFieldOptions: [{ name: '数量' }], cardFieldIndex: 0,
    cardPreview: presentBusinessCard(structuredClone(fixture))
  });
  const name = descendants(tree, node => node.attr && node.attr.id === 'template-name');
  assert.equal(name.length, 1);
  assert.equal(name[0].attr.disabled, true);
  assert.equal(descendants(tree, node => node.attr && node.attr.bindtap === 'submit').length, 0);
  const save = descendants(tree, node => node.attr && node.attr.bindtap === 'saveCardDisplay');
  assert.equal(save.length, 1);
  assert.equal(save[0].attr.disabled, false);
  assert.equal(descendants(tree, node => node.tag === 'wx-picker' && !node.attr.disabled).length, 2);
  assert.ok(textContent(tree).includes('不修改历史内容'));
  assert.ok(textContent(tree).includes('合成示例预览'));
  assert.ok(textContent(tree).includes('0'));
});

test('official unsaved-template editor explains save-first without exposing config mutation controls', () => {
  const tree = renderEditor({ editMode: false, readOnly: false, loading: false, nodes: [] });
  assert.ok(textContent(tree).includes('请先保存模板'));
  assert.equal(descendants(tree, node => node.attr && node.attr.bindtap === 'saveCardDisplay').length, 0);
  assert.equal(descendants(tree, node => node.attr && node.attr.bindtap === 'addCardField').length, 0);
  assert.equal(descendants(tree, node => node.attr && node.attr.bindtap === 'submit').length, 1);
});

function descendants(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => descendants(child, predicate))];
}

function textContent(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node && typeof node === 'object' ? (node.children || []).map(textContent).join('') : '';
}

const fixture = {
  _id: 'line-synthetic', code: 'BL-SYNTHETIC-0001', name: '示例模板-BL-SYNTHETIC-0001',
  status: 'completed', progress: 100, showProgressPercent: true, displayProgress: 100,
  currentNodeName: '示例完成节点', matches: [], visibleMatches: [],
  cardSummary: { state: 'ready', configRevision: 1, fields: [
    { id: 'model', label: '型号', value: '示例型号' },
    { id: 'quantity', label: '数量', value: '0' },
    { id: 'confirmed', label: '已确认', value: '否' },
    { id: 'note', label: '备注', value: '示例中文与🙂' }
  ] }
};

for (const page of ['dashboard', 'business-list', 'pending-processing', 'review-list']) {
  const task = ['pending-processing', 'review-list'].includes(page);
  const render = compile(page);
  const treeFor = item => render({
    profile: null, stats: { active: 0, completed: 1, pendingMine: 0 },
    recent: [item], items: [item], loading: false, hasMore: false
  });
  test(`${page}: official rendered card shows number once and selected fields in order`, () => {
    const { presentBusinessCard } = require('../miniprogram/utils/business-card');
    const tree = treeFor(presentBusinessCard({ ...structuredClone(fixture),
      businessLineId: fixture._id, nodeId: 'node-synthetic', reviewRoundId: 'round-synthetic',
      businessCode: fixture.code, businessName: fixture.name, nodeName: '示例待办节点',
      nodeCode: 'SYNTHETIC-N002', processingRoundNumber: 2, reviewRoundNumber: 3,
      cardStatus: page === 'review-list' ? 'pending_review' : undefined,
      reviewModeLabel: '会签', dueText: '示例截止时间', actionText: '继续处理 →'
    }));
    const cards = descendants(tree, node => node.attr &&
      node.attr.bindtap === (page === 'pending-processing' ? 'openItem' : 'openDetail'));
    assert.equal(cards.length, 1);
    const text = textContent(cards[0]);
    assert.equal(text.split(fixture.code).length - 1, 1);
    let cursor = -1;
    for (const field of fixture.cardSummary.fields) {
      const next = text.indexOf(field.label, cursor + 1);
      assert.ok(next > cursor, text);
      assert.ok(text.indexOf(field.value, next) >= next, text);
      cursor = next;
    }
    assert.ok(text.includes(task ? '示例待办节点' : '示例完成节点'));
    if (task) {
      assert.ok(text.includes('示例截止时间'));
      assert.ok(text.includes(page === 'review-list' ? '会签' : '继续处理'));
      assert.ok(text.includes(page === 'review-list' ? '3' : '2'));
    }
    if (page === 'pending-processing') {
      assert.equal(cards[0].attr['data-line-id'], fixture._id);
      assert.equal(cards[0].attr['data-node-id'], 'node-synthetic');
    } else assert.equal(cards[0].attr['data-id'], page === 'review-list' ? 'round-synthetic' : fixture._id);
    assert.equal(descendants(cards[0], node => node.tag === 'wx-status-pill').length, 1);
    if (page === 'review-list') {
      assert.equal(descendants(cards[0], node => node.tag === 'wx-status-pill')[0].attr.status, 'pending_review');
    }
  });
  test(`${page}: summary error retains card navigation and exposes explicit retry`, () => {
    const { presentBusinessCard } = require('../miniprogram/utils/business-card');
    const item = presentBusinessCard({ ...fixture, businessCode: fixture.code,
      businessName: fixture.name, cardSummary: { state: 'unavailable', fields: [] } });
    const tree = treeFor(item);
    assert.ok(textContent(tree).includes(fixture.code));
    assert.ok(textContent(tree).includes('重试'));
    assert.ok(descendants(tree, node => node.attr &&
      (node.attr.catchtap || node.attr.bindtap && node.attr.bindtap !== 'openDetail') &&
      textContent(node).includes('重试')).length > 0);
  });
}
