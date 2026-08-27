'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createParserService, digest, stableSchema } = require('../lib/parser-service')

test('parser service consumes bound ticket before AI and returns validated candidates', async () => {
  const calls = []
  const schema = [{ fieldKey: 'name', name: '姓名', type: 'short_text', required: true, constraints: {} }]
  const service = createParserService({
    repository: { async consumeParseTicket(input) { calls.push(input) } },
    aiClient: { async parse() { calls.push('ai'); return { candidates: [{ fieldKey: 'name', value: '张三', confidence: 0.9, sourceExcerpt: '客户 张三' }] } } }
  })
  const result = await service.parseAuthorizedText({
    ticketId: 'ticket_12345678901234567890', actorHash: 'a'.repeat(64), businessLineId: 'business_12345678901234567890',
    nodeId: 'node_12345678901234567890', expectedNodeVersion: 1, requestKeyHash: 'b'.repeat(64), text: '客户 张三', schema
  })
  assert.equal(calls[0].schemaDigest, digest(stableSchema(schema)))
  assert.equal(calls[1], 'ai')
  assert.equal(result.candidates[0].value, '张三')
})

test('parser service returns safe structured label candidates without waiting for AI', async () => {
  const schema = [
    { fieldKey: 'model', name: '型号', type: 'single_select', required: true, constraints: { options: ['S1黑色', 'S1白色'] } },
    { fieldKey: 'purchaseDate', name: '购买日期', type: 'date', required: true, constraints: {} },
    { fieldKey: 'warehouse', name: '出库仓库', type: 'single_select', required: true, constraints: { options: ['一件代发', '广州仓'] } },
    { fieldKey: 'orderNumber', name: '订单号', type: 'short_text', required: true, constraints: {} },
    { fieldKey: 'customerName', name: '客户姓名', type: 'short_text', required: true, constraints: {} },
    { fieldKey: 'phone', name: '手机号', type: 'short_text', required: true, constraints: {} },
    { fieldKey: 'address', name: '地址', type: 'long_text', required: true, constraints: {} }
  ]
  let ticketConsumed = false
  const service = createParserService({
    repository: { async consumeParseTicket() { ticketConsumed = true } },
    aiClient: { async parse() { throw new Error('AI must not run for structured labels') } }
  })

  const result = await service.parseAuthorizedText({
    ticketId: 'ticket_12345678901234567890', actorHash: 'a'.repeat(64), businessLineId: 'business_12345678901234567890',
    nodeId: 'node_12345678901234567890', expectedNodeVersion: 1, requestKeyHash: 'b'.repeat(64),
    text: [
      '型号： S1黑色',
      '购买日期：2026年8月23日',
      '仓库：一件代发',
      '订单号:E20260824122425018606151',
      '收件人：李龙',
      '手机号码:15692408181',
      '所在地址：广东省广州市海珠区江海街道聚德花苑东区f41栋7'
    ].join('\n'),
    schema
  })

  assert.equal(ticketConsumed, true)
  assert.deepEqual(result.candidates.map(candidate => [candidate.fieldKey, candidate.value]), [
    ['model', 'S1黑色'],
    ['purchaseDate', '2026-08-23'],
    ['warehouse', '一件代发'],
    ['orderNumber', 'E20260824122425018606151'],
    ['customerName', '李龙'],
    ['phone', '15692408181'],
    ['address', '广东省广州市海珠区江海街道聚德花苑东区f41栋7']
  ])
})
