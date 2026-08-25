const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const miniProgramRoot = path.resolve(__dirname, '..')

function declarationsFor(source, targetSelector) {
  const declarations = {}
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  let match

  while ((match = rulePattern.exec(source))) {
    const selectors = match[1].split(',').map(selector => selector.trim())
    if (!selectors.includes(targetSelector)) continue

    for (const declaration of match[2].split(';')) {
      const separator = declaration.indexOf(':')
      if (separator === -1) continue
      declarations[declaration.slice(0, separator).trim()] = declaration.slice(separator + 1).trim()
    }
  }

  return declarations
}

function rpx(value) {
  const match = /^(\d+(?:\.\d+)?)rpx$/.exec(value || '')
  return match ? Number(match[1]) : null
}

test('全局输入控件为安卓原生输入层提供可读文字尺寸和稳定内容高度', () => {
  const source = fs.readFileSync(path.join(miniProgramRoot, 'app.wxss'), 'utf8')
  const input = declarationsFor(source, '.input')
  const textarea = declarationsFor(source, '.textarea')

  assert.ok(rpx(input['font-size']) >= 28, 'input 必须显式设置至少 28rpx 字号')
  assert.ok(rpx(textarea['font-size']) >= 28, 'textarea 必须显式设置至少 28rpx 字号')
  assert.ok(rpx(input.height) >= 80, 'input 必须提供不会压缩原生文字层的固定高度')
  assert.ok(rpx(input['line-height']) >= 40, 'input 必须提供与字号匹配的行高')
  assert.ok(Number.parseFloat(textarea['line-height']) >= 1.4, 'textarea 必须提供可读行高')
  assert.match(input.color || '', /^#[0-9a-f]{6}$/i, 'input 必须显式设置可见文字颜色')
  assert.match(textarea.color || '', /^#[0-9a-f]{6}$/i, 'textarea 必须显式设置可见文字颜色')
})
