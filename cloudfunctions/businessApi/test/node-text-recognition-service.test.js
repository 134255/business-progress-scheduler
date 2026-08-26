'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createNodeTextRecognitionService,
  resolveDailyLimit,
  normalizeSchema,
  validateReturnedCandidates
} = require('../lib/node-text-recognition-service')

const schema = [{ fieldKey: 'name', name: '姓名', type: 'short_text', required: true, constraints: {} }]

test('node text daily limit defaults to 300 and validates server override', () => {
  assert.equal(resolveDailyLimit(undefined), 300)
  assert.equal(resolveDailyLimit('450'), 450)
  for (const value of ['', '0', '1001', '2.5', ' 300 ']) assert.throws(() => resolveDailyLimit(value), /配置异常/)
})

test('node text recognition authorizes before and after parser call', async () => {
  const calls = []
  const service = createNodeTextRecognitionService({
    dailyLimit: '300', clock: () => new Date('2026-08-26T08:00:00.000Z'),
    repository: {
      async authorizeRecognition() { calls.push('auth'); return { fieldDefinitions: schema } },
      async claimUsageAndCreateTicket(input) { calls.push(input.dailyLimit); return { ticketId: 'ticket', actorHash: 'a'.repeat(64), lockToken: 'lock' } },
      async releaseUsage() { calls.push('release') }
    },
    parserClient: { async parse() { calls.push('parse'); return { candidates: [] } } }
  })
  await service.recognize({ actor: { _id: 'user-1' }, input: {
    businessLineId: 'business-1', nodeId: 'node-1', expectedNodeVersion: 2,
    text: '客户：张三', requestKey: 'request_1234567890123456'
  } })
  assert.deepEqual(calls, ['auth', 300, 'parse', 'auth', 'release'])
})

test('schema normalization rejects inherited, accessor, sparse and unknown constraint data without executing getters', () => {
  let getterCalls = 0
  const accessor = {}
  Object.defineProperty(accessor, 'options', { enumerable: true, get() { getterCalls += 1; return ['A'] } })
  const sparseDefinitions = new Array(1)
  const accessorDefinitions = []
  Object.defineProperty(accessorDefinitions, 0, { enumerable: true, get() { getterCalls += 1; return schema[0] } })
  accessorDefinitions.length = 1
  const invalidSchemas = [
    sparseDefinitions,
    accessorDefinitions,
    [{ fieldKey: 'x', name: 'X', type: 'single_select', required: true, constraints: accessor }],
    [{ fieldKey: 'x', name: 'X', type: 'single_select', required: true, constraints: Object.create({ options: ['A'] }) }],
    [{ fieldKey: 'x', name: 'X', type: 'short_text', required: true, constraints: { unknown: 1 } }],
    [{ fieldKey: 'x', name: 'X', type: 'single_select', required: true, constraints: { options: Object.assign(new Array(2), { 0: 'A' }) } }]
  ]
  for (const value of invalidSchemas) assert.throws(() => normalizeSchema(value), error => error.code === 'NODE_TEXT_STALE')
  assert.equal(getterCalls, 0)
})

test('schema normalization rejects unknown field types and contradictory bounds before ticket creation', () => {
  const invalidSchemas = [
    [{ fieldKey: 'x', name: 'X', type: 'unsupported', required: true, constraints: {} }],
    [{ fieldKey: 'x', name: 'X', type: 'short_text', required: true, constraints: { minLength: 5, maxLength: 4 } }],
    [{ fieldKey: 'x', name: 'X', type: 'number', required: true, constraints: { min: 2, max: 1 } }],
    [{ fieldKey: 'x', name: 'X', type: 'short_text', required: true, constraints: { pattern: '(a+)+$' } }]
  ]
  for (const value of invalidSchemas) assert.throws(() => normalizeSchema(value), error => error.code === 'NODE_TEXT_STALE')
})

test('business service revalidates parser candidates against the current normalized schema', () => {
  const definitions = normalizeSchema([
    { fieldKey: 'amount', name: '金额', type: 'number', required: true, constraints: { min: 0, max: 100, decimalPlaces: 2 } },
    { fieldKey: 'choice', name: '选项', type: 'single_select', required: true, constraints: { options: ['A', 'B'] } }
  ])
  for (const candidates of [
    [{ fieldKey: 'amount', value: 101, matchKind: 'direct', alternatives: [] }],
    [{ fieldKey: 'amount', value: 1.234, matchKind: 'direct', alternatives: [] }],
    [{ fieldKey: 'choice', value: 'C', matchKind: 'semantic', alternatives: [] }],
    [{ fieldKey: 'choice', value: 'A', matchKind: 'semantic', alternatives: [{ value: 'C', confidence: 0.8 }] }]
  ]) assert.throws(() => validateReturnedCandidates(definitions, candidates), error => error.code === 'NODE_TEXT_PARSE_FAILED')
})
