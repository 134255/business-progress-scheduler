'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createNodeTextParserClient } = require('../lib/node-text-parser-client')

test('node text parser client calls independent worker and masks failures', async () => {
  const client = createNodeTextParserClient({ callFunction: async input => {
    assert.equal(input.name, 'nodeTextParser')
    return { result: { candidates: [] } }
  } })
  assert.deepEqual(await client.parse({ ticketId: 'ticket' }), { candidates: [] })
  await assert.rejects(createNodeTextParserClient({ callFunction: async () => { throw new Error('cloud://secret') } }).parse({}), error => {
    assert.equal(error.code, 'NODE_TEXT_PARSE_FAILED')
    assert.doesNotMatch(error.message, /cloud:\/\//)
    return true
  })
})

test('node text parser client rejects malformed worker candidates before returning to route', async () => {
  const malformed = [
    null,
    { result: { candidates: [{}] } },
    { result: { candidates: [{ fieldKey: 'x', value: 'A', confidence: 2, sourceExcerpt: 'x', matchKind: 'direct', requiresConfirmation: false, alternatives: [] }] } },
    { result: { candidates: Object.assign(new Array(2), { 0: { fieldKey: 'x' } }) } }
  ]
  for (const response of malformed) {
    const client = createNodeTextParserClient({ callFunction: async () => response })
    await assert.rejects(client.parse({}), error => error.code === 'NODE_TEXT_PARSE_FAILED')
  }
})

test('node text parser client accepts a valid multi-select result with up to 100 options', async () => {
  const selected = Array.from({ length: 60 }, (_, index) => `option-${index}`)
  const alternatives = Array.from({ length: 60 }, (_, index) => ({ value: `alternative-${index}`, confidence: 0.9 - index / 1000 }))
  const client = createNodeTextParserClient({ callFunction: async () => ({
    result: { candidates: [{
      fieldKey: 'tags', value: selected, confidence: 0.9, sourceExcerpt: '多项标签',
      matchKind: 'semantic', requiresConfirmation: false, alternatives
    }] }
  }) })
  const candidate = (await client.parse({})).candidates[0]
  assert.deepEqual(candidate.value, selected)
  assert.deepEqual(candidate.alternatives, alternatives)
})
