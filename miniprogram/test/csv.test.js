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
