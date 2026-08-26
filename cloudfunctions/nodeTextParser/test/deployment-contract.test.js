'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '../../..')

test('部署手册固定节点文本识别的集合、索引、空触发器和每日额度契约', () => {
  const document = fs.readFileSync(
    path.join(repositoryRoot, 'docs/deployment/template-node-fields-setup.md'),
    'utf8'
  )
  for (const required of [
    'node_text_parse_requests',
    'node_text_parse_usage',
    'expiresAt ASC, _id ASC',
    'nodeTextParser',
    '超时至少 60 秒',
    '"triggers": []',
    'NODE_TEXT_PARSE_DAILY_LIMIT',
    '默认 300 次',
    '1..1000',
    '不得写入原始粘贴文本、识别候选'
  ]) assert.match(document, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
