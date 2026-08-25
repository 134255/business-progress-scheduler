const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeSearchQuery,
  buildSearchEntries,
  segmentText,
  tokenizeEntry,
  entryMatchesKeywords,
  safeSearchExcerpt,
  estimateTokenIndexBytes
} = require('../lib/search-domain')

function assertCode(operation, code) {
  assert.throws(operation, error => error && error.code === code)
}

function source(overrides = {}) {
  return {
    businessLineId: 'line-1',
    name: '清闲售后',
    code: 'BL-20260825-0001',
    description: '需要二次上门',
    nodes: [{
      nodeId: 'node-1',
      name: '信息收集',
      code: 'BL-20260825-0001-N001',
      fieldValues: [
        { fieldKey: 'short', name: '联系人', type: 'short_text', value: '张三' },
        { fieldKey: 'long', name: '问题说明', type: 'long_text', value: '设备无法启动' },
        { fieldKey: 'number', name: '数量', type: 'number', value: 2.5 },
        { fieldKey: 'boolean', name: '是否加急', type: 'boolean', value: true },
        { fieldKey: 'date', name: '上门日期', type: 'date', value: '2026-08-26' },
        { fieldKey: 'single', name: '处理方式', type: 'single_select', value: '上门' },
        { fieldKey: 'multi', name: '问题类别', type: 'multi_select', value: ['电源', '主板'] }
      ],
      processingComment: '已经完成初检',
      reviewComments: ['同意进入下一节点'],
      evidenceFileNames: ['现场照片.jpg']
    }],
    ...overrides
  }
}

test('检索支持单字符并对多个关键词执行 NFKC、大小写和空白规范化', () => {
  assert.deepEqual(normalizeSearchQuery({ keyword: ' Ａ  清\t闲 ' }), {
    keywords: ['a', '清', '闲'],
    normalizedKeywords: ['a', '清', '闲'],
    digestInput: 'a\u0000清\u0000闲'
  })
})

test('检索拒绝超过五词、规范化后超过一百码点和非字符串输入', () => {
  assertCode(() => normalizeSearchQuery({ keyword: '一 二 三 四 五 六' }), 'INVALID_SEARCH_QUERY')
  assertCode(() => normalizeSearchQuery({ keyword: '测'.repeat(101) }), 'INVALID_SEARCH_QUERY')
  assertCode(() => normalizeSearchQuery({ keyword: 7 }), 'INVALID_SEARCH_QUERY')
  assertCode(() => normalizeSearchQuery([]), 'INVALID_SEARCH_QUERY')
  assert.equal(normalizeSearchQuery({ keyword: '测'.repeat(100) }).normalizedKeywords[0].length, 100)
})

test('条目构建覆盖售后、节点、七类字段、处理说明、审核意见和凭证文件名', () => {
  const entries = buildSearchEntries(source())
  const kinds = entries.map(item => item.sourceKind)
  assert.deepEqual(kinds, [
    'line_name', 'line_code', 'line_description', 'node_name', 'node_code',
    'field_name', 'field_value', 'field_name', 'field_value', 'field_name', 'field_value',
    'field_name', 'field_value', 'field_name', 'field_value', 'field_name', 'field_value',
    'field_name', 'field_value', 'processing_comment', 'review_comment', 'evidence_file_name'
  ])
  assert.equal(entries.find(item => item.label === '是否加急' && item.sourceKind === 'field_value').normalizedText, '是')
  assert.equal(entries.find(item => item.label === '问题类别' && item.sourceKind === 'field_value').normalizedText, '电源 主板')
  assert.equal(entries.some(item => JSON.stringify(item).includes('cloud://')), false)
})

test('条目构建对访问器、继承值、稀疏数组、重复字段和未知类型失败关闭', () => {
  const getterSource = source()
  let getterCalls = 0
  Object.defineProperty(getterSource.nodes[0], 'processingComment', {
    enumerable: true,
    get() { getterCalls += 1; return '不得读取' }
  })
  assertCode(() => buildSearchEntries(getterSource), 'SEARCH_SOURCE_INVALID')
  assert.equal(getterCalls, 0)

  const inherited = source()
  delete inherited.nodes[0].name
  Object.setPrototypeOf(inherited.nodes[0], { name: '不得继承' })
  assertCode(() => buildSearchEntries(inherited), 'SEARCH_SOURCE_INVALID')

  const sparse = source()
  sparse.nodes[0].fieldValues = new Array(2)
  sparse.nodes[0].fieldValues[1] = { fieldKey: 'one', name: '一', type: 'short_text', value: '值' }
  assertCode(() => buildSearchEntries(sparse), 'SEARCH_SOURCE_INVALID')

  const duplicate = source()
  duplicate.nodes[0].fieldValues[1].fieldKey = 'short'
  assertCode(() => buildSearchEntries(duplicate), 'SEARCH_SOURCE_INVALID')

  const unknown = source()
  unknown.nodes[0].fieldValues[0].type = 'file'
  assertCode(() => buildSearchEntries(unknown), 'SEARCH_SOURCE_INVALID')
})

test('长文本按二千零四十八码点分段并保留九十九码点重叠', () => {
  const text = `${'甲'.repeat(2047)}乙${'丙'.repeat(100)}`
  const parts = segmentText(text)
  assert.equal(parts.length, 2)
  assert.equal(Array.from(parts[0]).length, 2048)
  assert.equal(parts[0].slice(-99), parts[1].slice(0, 99))
  assert.equal(parts.map((item, index) => index === 0 ? item : item.slice(99)).join(''), text)
})

test('HMAC 令牌按关键词长度使用一元、二元和三元片段且不泄漏原文', () => {
  const entry = {
    businessLineId: 'line-1', nodeId: null, sourceKind: 'line_name', label: '售后名称',
    normalizedText: 'a清闲售后', safeExcerpt: 'a清闲售后', segmentIndex: 0
  }
  const chunks = tokenizeEntry(entry, 'test-secret-which-is-not-production')
  assert.ok(chunks.length >= 1)
  const hashes = chunks.flatMap(item => item.tokenHashes)
  assert.ok(hashes.every(item => /^[A-Za-z0-9_-]{22}$/.test(item)))
  assert.equal(JSON.stringify(hashes).includes('清'), false)
  assert.equal(JSON.stringify(hashes).includes('售后'), false)
  assert.ok(chunks.every(item => estimateTokenIndexBytes(item.tokenHashes) <= 768))
  assert.deepEqual(chunks.flatMap(item => item.gramSizes), [
    1, 1, 1, 1, 1,
    2, 2, 2, 2,
    3, 3, 3
  ])
})

test('候选锚点碰撞不能绕过正文连续子串校验', () => {
  const entry = {
    normalizedText: '清闲售后已经完成',
    safeExcerpt: '清闲售后已经完成'
  }
  assert.equal(entryMatchesKeywords(entry, ['清闲', '完成']), true)
  assert.equal(entryMatchesKeywords(entry, ['清闲完成']), false)
  assert.equal(entryMatchesKeywords(entry, ['不存在']), false)
})

test('安全摘要在命中附近截断并保持最多一百六十码点', () => {
  const prefix = '前'.repeat(180)
  const excerpt = safeSearchExcerpt({ normalizedText: `${prefix}目标内容${'后'.repeat(180)}` }, ['目标'])
  assert.ok(excerpt.includes('目标'))
  assert.ok(Array.from(excerpt).length <= 160)
})
