'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createNodeTextParserHandler } = require('../index')

test('parser handler rejects direct client identity and returns safe failures', async () => {
  const service = { async parseAuthorizedText() { throw Object.assign(new Error('secret cloud://path'), { code: 'DB_SECRET' }) } }
  await assert.rejects(createNodeTextParserHandler({ service, getContext: () => ({ OPENID: 'client' }) })({}), /未经授权/)
  await assert.rejects(createNodeTextParserHandler({ service, logger: { error() {} } })({}), error => {
    assert.equal(error.code, 'NODE_TEXT_PARSE_FAILED')
    assert.doesNotMatch(error.message, /cloud:\/\//)
    return true
  })
})

test('parser handler accepts a ticketed server call even when CloudBase inherits the original OPENID', async () => {
  let received
  const event = {
    ticketId: 'ticket_12345678901234567890',
    text: '型号：S1黑色',
    schema: []
  }
  const handler = createNodeTextParserHandler({
    service: {
      async parseAuthorizedText(input) {
        received = input
        return { candidates: [] }
      }
    },
    getContext: () => ({ OPENID: 'inherited-from-business-api' })
  })

  assert.deepEqual(await handler(event), { candidates: [] })
  assert.equal(received, event)
})

test('parser handler still rejects a direct client call without an internal ticket', async () => {
  let called = false
  const handler = createNodeTextParserHandler({
    service: {
      async parseAuthorizedText() {
        called = true
        return { candidates: [] }
      }
    },
    getContext: () => ({ OPENID: 'direct-client' })
  })

  await assert.rejects(handler({ text: '型号：S1黑色', schema: [] }), error => {
    assert.equal(error.code, 'FORBIDDEN')
    return true
  })
  assert.equal(called, false)
})
