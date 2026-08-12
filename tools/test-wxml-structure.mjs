import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const miniProgramRoot = path.join(projectRoot, 'miniprogram');

function listWxmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listWxmlFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.wxml') ? [fullPath] : [];
  });
}

function findInvalidConditionalSiblings(source) {
  const errors = [];
  const stack = [{ tag: '#root', lastSiblingAttributes: '' }];
  const tokenPattern = /<!--[\s\S]*?-->|<[^>]+>/g;
  let match;
  let cursor = 0;

  while ((match = tokenPattern.exec(source))) {
    const text = source.slice(cursor, match.index);
    if (text.trim()) stack.at(-1).lastSiblingAttributes = '';
    cursor = tokenPattern.lastIndex;

    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!')) continue;

    if (token.startsWith('</')) {
      if (stack.length === 1) continue;
      const closed = stack.pop();
      stack.at(-1).lastSiblingAttributes = closed.attributes;
      continue;
    }

    const tagMatch = token.match(/^<\s*([^\s/>]+)([\s\S]*?)\/?\s*>$/);
    if (!tagMatch) continue;

    const [, tag, attributes = ''] = tagMatch;
    const parent = stack.at(-1);
    const hasElse = /\bwx:(?:else|elif)\b/.test(attributes);
    const previousHasCondition = /\bwx:(?:if|elif)\s*=/.test(parent.lastSiblingAttributes);

    if (hasElse && !previousHasCondition) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      errors.push({ line, tag });
    }

    if (token.endsWith('/>')) {
      parent.lastSiblingAttributes = attributes;
    } else {
      stack.push({ tag, attributes, lastSiblingAttributes: '' });
    }
  }

  return errors;
}

function findConditionalLoopConflicts(source) {
  const errors = [];
  const tokenPattern = /<!--[\s\S]*?-->|<[^>]+>/g;
  let match;

  while ((match = tokenPattern.exec(source))) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('</') || token.startsWith('<?') || token.startsWith('<!')) {
      continue;
    }

    if (/\bwx:(?:else|elif)\b/.test(token) && /\bwx:for\s*=/.test(token)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      errors.push({ line });
    }
  }

  return errors;
}

function findUnsafeAccountDatasets(source) {
  const errors = [];
  const selectorPattern = /<label\b([^>]*\bbindtap="on(?:Processor|Reviewer)Toggle"[^>]*)>/g;
  let match;

  while ((match = selectorPattern.exec(source))) {
    const attributes = match[1].trim();
    const datasetAttributes = attributes.match(/\bdata-[\w-]+\s*=\s*"{{[^}]+}}"/g) || [];
    const isSafeIdOnly = datasetAttributes.length === 1 &&
      /^data-id\s*=\s*"{{\s*item\._id\s*}}"$/.test(datasetAttributes[0]);
    if (!isSafeIdOnly) errors.push({ attributes });
  }

  return errors;
}

function findLoopsWithoutKeys(source) {
  const errors = [];
  const tokenPattern = /<!--[\s\S]*?-->|<[^>]+>/g;
  let match;

  while ((match = tokenPattern.exec(source))) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('</') || token.startsWith('<?') || token.startsWith('<!')) {
      continue;
    }
    if (/\bwx:for\s*=/.test(token) && !/\bwx:key\s*=/.test(token)) {
      errors.push({ line: source.slice(0, match.index).split(/\r?\n/).length });
    }
  }
  return errors;
}

test('wx:else 和 wx:elif 必须紧邻同级 wx:if 或 wx:elif', () => {
  const failures = listWxmlFiles(miniProgramRoot).flatMap((file) =>
    findInvalidConditionalSiblings(fs.readFileSync(file, 'utf8')).map((error) => ({
      file: path.relative(projectRoot, file),
      ...error,
    })),
  );

  assert.deepEqual(failures, []);
});

test('wx:else 和 wx:elif 不得与 wx:for 位于同一元素', () => {
  const failures = listWxmlFiles(miniProgramRoot).flatMap((file) =>
    findConditionalLoopConflicts(fs.readFileSync(file, 'utf8')).map((error) => ({
      file: path.relative(projectRoot, file),
      ...error,
    })),
  );

  assert.deepEqual(failures, []);
});

test('节点账号选择 dataset 只能携带内部账号编号', () => {
  const source = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-template-node-edit/index.wxml'), 'utf8');
  assert.deepEqual(findUnsafeAccountDatasets(source), []);
  assert.deepEqual(findUnsafeAccountDatasets('<label data-id="{{item}}" bindtap="onProcessorToggle">'), [
    { attributes: 'data-id="{{item}}" bindtap="onProcessorToggle"' },
  ]);
  assert.deepEqual(findUnsafeAccountDatasets('<label data-account="{{selectedAccount}}" bindtap="onReviewerToggle">'), [
    { attributes: 'data-account="{{selectedAccount}}" bindtap="onReviewerToggle"' },
  ]);
});

test('所有 wx:for 循环都必须声明稳定 wx:key', () => {
  const failures = listWxmlFiles(miniProgramRoot).flatMap((file) =>
    findLoopsWithoutKeys(fs.readFileSync(file, 'utf8')).map((error) => ({
      file: path.relative(projectRoot, file),
      ...error,
    })),
  );

  assert.deepEqual(failures, []);
  assert.deepEqual(findLoopsWithoutKeys('<view wx:for="{{items}}">{{item}}</view>'), [{ line: 1 }]);
});
