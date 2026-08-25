const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const miniProgramRoot = path.resolve(__dirname, '..')
const repositoryRoot = path.resolve(miniProgramRoot, '..')
const cloudFunctionsRoot = path.join(repositoryRoot, 'cloudfunctions')
const visibleSourceExtensions = new Set(['.js', '.json', '.wxml'])

function productionUiFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') return []
      return productionUiFiles(fullPath)
    }
    return visibleSourceExtensions.has(path.extname(entry.name)) ? [fullPath] : []
  })
}

test('小程序与云端返回文案统一使用“售后”而不再显示“业务”', () => {
  const violations = [
    ...productionUiFiles(miniProgramRoot),
    ...productionUiFiles(cloudFunctionsRoot)
  ].flatMap(file => {
    const source = fs.readFileSync(file, 'utf8')
    return source.includes('业务') ? [path.relative(repositoryRoot, file)] : []
  })

  assert.deepEqual(violations, [], `仍含旧 UI 术语的文件：${violations.join('、')}`)
})
