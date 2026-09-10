import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Uses the installed official compiler. This is not native-device acceptance.
const compilerPath = process.env.WECHAT_WCC_PATH;
assert.ok(compilerPath && fs.existsSync(compilerPath), 'Set WECHAT_WCC_PATH to the installed WeChat WXML compiler');
const miniRoot = path.resolve(import.meta.dirname, '..', 'miniprogram');

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
    const runtime = vm.createContext({ window: {}, console });
    vm.runInContext(compiled, runtime, { timeout: 5000 });
    return runtime.$gwx(file)(data);
  };
}

function findAll(node, matches) {
  if (!node || typeof node !== 'object') return [];
  return [...(matches(node) ? [node] : []), ...(node.children || []).flatMap(child => findAll(child, matches))];
}

const dashboard = compile('dashboard');
const list = compile('business-list');

test('official dashboard render exposes both full-card tap handlers and correct statuses', () => {
  const tree = dashboard({ stats: { active: 3, completed: 2, pendingMine: 1 }, recent: [], profile: null });
  const cards = findAll(tree, node => node.attr && node.attr.bindtap === 'openStatusList');
  assert.equal(cards.length, 2);
  assert.deepEqual(Array.from(cards, card => card.attr['data-status']), ['active', 'completed']);
  assert.ok(cards.every(card => card.tag === 'wx-view' && card.attr.class.includes('stat')));
});

for (const status of ['进行中', '已完成']) {
  test(`official list render shows the ${status} relationship scope`, () => {
    const label = `与我相关 · ${status}`;
    const tree = list({ filterLabel: label, items: [], loading: false, hasMore: false });
    const labels = findAll(tree, node => node.attr && node.attr.class === 'filter-scope');
    assert.equal(labels.length, 1);
    assert.ok(JSON.stringify(labels[0]).includes(label));
  });
}

test('empty search candidate page renders continuation, not a false no-results state', () => {
  const tree = list({ items: [], loading: false, hasMore: true, loadMoreText: '上拉加载更多' });
  assert.equal(findAll(tree, node => node.attr && node.attr.bindtap === 'loadMore').length, 1);
  assert.equal(findAll(tree, node => node.attr && node.attr.class === 'empty').length, 0);
});

test('unfiltered empty terminal page hides scope and load-more controls', () => {
  const tree = list({ filterLabel: '', items: [], loading: false, hasMore: false });
  assert.equal(findAll(tree, node => node.attr && node.attr.class === 'filter-scope').length, 0);
  assert.equal(findAll(tree, node => node.attr && node.attr.bindtap === 'loadMore').length, 0);
  assert.equal(findAll(tree, node => node.attr && node.attr.class === 'empty').length, 1);
});

test('search submits the named native input and also accepts keyboard final value', () => {
  const tree = list({ items: [], keyword: '测试', loading: false, hasMore: false });
  const forms = findAll(tree, node => node.tag === 'wx-form' && node.attr.bindsubmit === 'onSearchSubmit');
  assert.equal(forms.length, 1);
  const inputs = findAll(forms[0], node => node.tag === 'wx-input' && node.attr.name === 'keyword');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].attr.bindconfirm, 'onSearchConfirm');
  assert.equal(inputs[0].attr.bindblur, 'onKeyword');
  const buttons = findAll(forms[0], node => node.tag === 'wx-button');
  assert.equal(buttons.filter(node => node.attr.formType === 'submit').length, 1, JSON.stringify(buttons));
});

test('failed or edited search renders its state instead of pretending there are no matches', () => {
  for (const state of [{ errorMessage: '检索暂时不可用' }, { queryDirty: true }]) {
    const tree = list({ items: [], loading: false, hasMore: false, ...state });
    assert.equal(findAll(tree, node => node.attr && node.attr.class === 'empty').length, 0);
    assert.equal(findAll(tree, node => node.attr && /^search-(error|pending)$/.test(node.attr.class)).length, 1);
  }
});
