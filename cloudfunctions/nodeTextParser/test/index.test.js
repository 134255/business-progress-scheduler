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
