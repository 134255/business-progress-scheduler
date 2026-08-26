'use strict'

const crypto = require('node:crypto')
const { normalizeParserSchema, buildModelRequest, validateModelCandidates } = require('./parser-domain')

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stableSchema(schema) {
  return JSON.stringify(schema)
}

function createParserService({ repository, aiClient } = {}) {
  if (!repository || typeof repository.consumeParseTicket !== 'function' || !aiClient || typeof aiClient.parse !== 'function') {
    throw new TypeError('parser dependencies are required')
  }
  return {
    async parseAuthorizedText(input) {
      if (!input || typeof input !== 'object') throw Object.assign(new Error('invalid ticket'), { code: 'NODE_TEXT_TICKET_INVALID' })
      const schema = normalizeParserSchema(input.schema)
      const request = buildModelRequest({ text: input.text, schema })
      await repository.consumeParseTicket({
        ticketId: input.ticketId,
        actorHash: input.actorHash,
        businessLineId: input.businessLineId,
        nodeId: input.nodeId,
        expectedNodeVersion: input.expectedNodeVersion,
        schemaDigest: digest(stableSchema(schema)),
        textDigest: digest(input.text.trim()),
        requestKeyHash: input.requestKeyHash
      })
      const raw = await aiClient.parse(request)
      return { candidates: validateModelCandidates(schema, raw.candidates) }
    }
  }
}

module.exports = { createParserService, digest, stableSchema }
