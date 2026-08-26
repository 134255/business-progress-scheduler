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
