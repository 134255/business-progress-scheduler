'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createCloudbaseAiClient, resolveModelName, readStrictJson } = require('../lib/cloudbase-ai-client')

test('CloudBase AI client calls managed model and parses fenced JSON', async () => {
  const calls = []
  const client = createCloudbaseAiClient({
    createModel(group) {
      calls.push(group)
      return { async generateText(input) { calls.push(input); return { text: '```json\n{"candidates":[]}\n```' } } }
    },
    modelName: 'deepseek-v4-flash'
  })
  assert.deepEqual(await client.parse({ messages: [{ role: 'user', content: 'x' }] }), { candidates: [] })
  assert.equal(calls[0], 'cloudbase')
  assert.equal(calls[1].model, 'deepseek-v4-flash')
})

test('CloudBase AI client fails closed on unsafe model configuration and response', () => {
  assert.equal(resolveModelName(undefined), 'deepseek-v4-flash')
  assert.equal(resolveModelName('hy3'), 'hy3')
  assert.throws(() => resolveModelName(''), /config/i)
  assert.throws(() => resolveModelName('bad model!'), /config/i)
  assert.throws(() => readStrictJson('{"candidates":[]} trailing'), /response/i)
  assert.throws(() => readStrictJson('{"__proto__":{},"candidates":[]}'), /response/i)
})
