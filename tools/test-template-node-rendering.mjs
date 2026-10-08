import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Use the installed WeChat compiler, not a hand-written approximation of wx:if.
// Set WECHAT_WCC_PATH to the trusted developer tools' wcc executable before running.
const compilerPath = process.env.WECHAT_WCC_PATH;
assert.ok(compilerPath && fs.existsSync(compilerPath), 'Set WECHAT_WCC_PATH to the installed WeChat WXML compiler');
const miniProgramRoot = path.resolve(import.meta.dirname, '..', 'miniprogram');
const pagePath = 'pages/admin-template-node-edit/index';
const compiled = execFileSync(compilerPath, [`${pagePath}.wxml`], {
  cwd: miniProgramRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024
});
let defaultData;
let pageDefinition;
vm.runInNewContext(fs.readFileSync(path.join(miniProgramRoot, `${pagePath}.js`), 'utf8'), {
  require: createRequire(path.join(miniProgramRoot, `${pagePath}.js`)),
  Page: definition => { pageDefinition = definition; defaultData = definition.data; }, module: { exports: {} },
  getApp: () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
}, { timeout: 5000 });

function renderNodeEditor(data) {
  const runtime = vm.createContext({ window: {}, console });
  vm.runInContext(compiled, runtime, { timeout: 5000 });
  const render = runtime.$gwx(`${pagePath}.wxml`);
  return render({ ...JSON.parse(JSON.stringify(defaultData)), ...data });
}

// The editor uses native setData path patches to avoid retransmitting option
// dictionaries. Mirror those paths rather than treating them as literal keys.
function applyDataPatch(data, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    let target = data;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
  }
}

test('conditional inputs render each partial edit with the correct parent and field bindings', () => {
  const page = { ...pageDefinition, data: { ...JSON.parse(JSON.stringify(defaultData)), flowSchemaVersion: 2 },
    setData(patch) { applyDataPatch(this.data, patch); } };
  page.refreshFields([
    { fieldKey: 'model', type: 'single_select', name: '型号', constraints: { options: ['S1', 'S2'] } },
    { fieldKey: 'color', type: 'single_select', name: '颜色', constraints: { options: ['石墨灰', '冰川白'] },
      condition: { parentFieldKey: 'model', visibleWhen: ['S1', 'S2'],
        optionsByParentValue: { S1: [], S2: ['冰川白'] } } }
  ]);
  for (const value of ['s', 'shi', '石', '石墨灰', '石墨灰，', '石墨灰，冰', '石墨灰，冰川白', '']) {
    page.onFieldConditionalOptionsInput({ currentTarget: { dataset: { index: 1, parentValue: 'S1' } }, detail: { value } });
    const inputs = findAll(renderNodeEditor(page.data), node =>
      node.tag === 'wx-textarea' && node.attr.bindinput === 'onFieldConditionalOptionsInput');
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].attr['data-parent-value'], 'S1');
    assert.equal(inputs[0].attr['data-index'], 1);
    assert.equal(inputs[0].attr.value, value);
    assert.equal(inputs[0].attr.maxlength, '-1');
    assert.equal(inputs[1].attr.value, '冰川白');
  }
});

test('only short-text fields expose a scan switch and readonly templates cannot toggle it', () => {
  const fields = [
    { _uiKey: 'scan', fieldKey: 'scan', name: '条码', type: 'short_text', scanEnabled: true, constraints: {} },
    { _uiKey: 'manual', fieldKey: 'manual', name: '手填', type: 'short_text', constraints: {} },
    { _uiKey: 'number', fieldKey: 'number', name: '数值', type: 'number', constraints: {} }
  ];
  for (const readOnly of [false, true]) {
    const switches = findAll(renderNodeEditor({ fields, readOnly }), node =>
      node.tag === 'wx-switch' && node.attr.bindchange === 'onFieldScanEnabledChange');
    assert.equal(switches.length, 2);
    assert.equal(switches[0].attr.checked, true);
    assert.equal(switches[1].attr.checked, false);
    assert.equal(switches[0].attr['data-index'], 0);
    assert.equal(switches[1].attr['data-index'], 1);
    assert.ok(switches.every(node => node.attr.disabled === readOnly));
  }
});

function findAll(node, matches) {
  if (!node || typeof node !== 'object') return [];
  return [ ...(matches(node) ? [node] : []),
    ...(node.children || []).flatMap(child => findAll(child, matches)) ];
}

for (const flowSchemaVersion of [1, 2]) {
  for (const readOnly of [false, true]) {
    test(`schema ${flowSchemaVersion} renders the saved node name with readOnly=${readOnly}`, () => {
      const tree = renderNodeEditor({ flowSchemaVersion, readOnly, name: '售后信息收集' });
      const names = findAll(tree, node => node.tag === 'wx-input' && node.attr.id === 'node-name');
      assert.equal(names.length, 1, 'the node-name input must be rendered for every flow schema');
      assert.equal(names[0].attr.value, '售后信息收集');
      assert.equal(names[0].attr.disabled, readOnly);
      assert.equal(names[0].attr.bindinput, 'onNameInput');
    });
  }
  test(`schema ${flowSchemaVersion} exposes only its own routing controls`, () => {
    const tree = renderNodeEditor({ flowSchemaVersion });
    const legacy = findAll(tree, node => node.tag === 'wx-switch' && node.attr.bindchange === 'onOptionalTailChange');
    const routing = findAll(tree, node => node.tag === 'wx-picker' && node.attr.bindchange === 'onNextModeChange');
    assert.equal(legacy.length, flowSchemaVersion === 1 ? 1 : 0);
    assert.equal(routing.length, flowSchemaVersion === 2 ? 1 : 0);
  });
}
