const test = require('node:test')
const assert = require('node:assert/strict')

const { toCsv } = require('../utils/csv')

test('CSV 使用 BOM、RFC4180 转义并阻断电子表格公式', () => {
  const csv = toCsv([
    { name: '=2+2', note: '含,逗号', lines: '第一行\n第二行', quote: '他说"好"' },
    { name: '+SUM(A1)', note: '@命令', lines: '-1', quote: '' }
  ], [
    ['name', '名称'], ['note', '备注'], ['lines', '换行'], ['quote', '引号']
  ])
  assert.equal(csv.charCodeAt(0), 0xFEFF)
  assert.match(csv, /'\=2\+2/)
  assert.match(csv, /"含,逗号"/)
  assert.match(csv, /"第一行\r\n第二行"/)
  assert.match(csv, /"他说""好"""/)
  assert.match(csv, /'\+SUM\(A1\)/)
  assert.match(csv, /'@命令/)
  assert.match(csv, /'-1/)
})

test('CSV 完整字段文本保留前导空白，但阻断空白后隐藏的公式前缀', () => {
  for (const value of ['\t=1+1','  +SUM(A1)','\r@command','\n-1','\u0000=1']) {
    const result = toCsv([{value}],[['value','内容']]).split('\r\n').slice(1).join('\r\n')
    assert.ok(result.startsWith("'") || result.startsWith('"\''),JSON.stringify(value))
  }
  assert.equal(toCsv([{value:'  正常文本'}],[['value','内容']]),'\uFEFF内容\r\n  正常文本')
})
