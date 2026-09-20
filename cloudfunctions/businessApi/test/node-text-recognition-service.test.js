'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudNodeTextRecognitionRepository } = require('../lib/cloud-node-text-recognition-repository')
const { createParserService } = require('../../nodeTextParser/lib/parser-service')
const { createCloudParseRepository } = require('../../nodeTextParser/lib/cloud-parse-repository')
const {
  createNodeTextRecognitionService,
  resolveDailyLimit,
  normalizeSchema,
  validateReturnedCandidates
} = require('../lib/node-text-recognition-service')

const schema = [{ fieldKey: 'name', name: '姓名', type: 'short_text', required: true, constraints: {} }]

test('recognition rejects changed hidden linkage semantics even when effective visible options stay the same', async () => {
  const fields=Array.from({length:8},(_,index)=>({fieldKey:`f${index}`,sequence:index,name:`字段${index}`,
    type:'single_select',required:true,constraints:{options:['A','B']}}))
  fields[0].optionLinkage={schemaVersion:1,fieldKeys:fields.map(field=>field.fieldKey),rows:[[0,0,0,0,null,null,null,null]]}
  const service=createNodeTextRecognitionService({repository:{
    async authorizeRecognition(){return {fieldDefinitions:fields}},
    async claimUsageAndCreateTicket(){return {ticketId:'ticket',actorHash:'a'.repeat(64),lockToken:'lock'}},
    async releaseUsage(){}
  },parserClient:{async parse(){fields[0].optionLinkage.rows[0][3]=1;return {candidates:[]}}}})
  await assert.rejects(service.recognize({actor:{_id:'user-1'},input:{businessLineId:'business-1',nodeId:'node-1',
    expectedNodeVersion:2,text:'类型 A',requestKey:'request_1234567890123456',fieldValues:[]}}),{code:'NODE_TEXT_STALE'})
})

test('recognition only sends prefix-valid linked choices, never the full matrix', async () => {
  const definitions = Array.from({length:8}, (_, index) => ({fieldKey:`f${index}`, sequence:index,
    name:`字段${index}`,type:'single_select',required:true,constraints:{options:['A','B']}}))
  definitions[0].optionLinkage = {schemaVersion:1,fieldKeys:definitions.map(field=>field.fieldKey),
    rows:[[0,0,0,0,0,null,null,null],[1,1,1,null,null,null,null,null]]}
  let received
  const service = createNodeTextRecognitionService({ repository:{
    async authorizeRecognition(){ return {fieldDefinitions:definitions} },
    async claimUsageAndCreateTicket(){return {ticketId:'ticket',actorHash:'a'.repeat(64),lockToken:'lock'}},
    async releaseUsage(){}
  },parserClient:{async parse(input){received=input.schema;return {candidates:[]}}} })
  await service.recognize({actor:{_id:'user-1'},input:{businessLineId:'business-1',nodeId:'node-1',
    expectedNodeVersion:2,text:'选择 A',requestKey:'request_1234567890123456',fieldValues:[{fieldKey:'f0',value:'A'}]}})
  assert.deepEqual(received.map(field=>field.fieldKey),['f0','f1'])
  assert.deepEqual(received[1].constraints.options,['A'])
  assert.equal(JSON.stringify(received).includes('optionLinkage'),false)
})

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

test('recognition parser receives only definitions visible for the submitted conditional form state', async () => {
  const definitions = [
    { fieldKey: 'category', sequence: 0, name: '品类', type: 'single_select', required: true, constraints: { options: ['手机', '电脑'] } },
    { fieldKey: 'phoneModel', sequence: 1, name: '手机型号', type: 'short_text', required: true, constraints: {}, condition: {
      parentFieldKey: 'category', visibleWhen: ['手机']
    } },
    { fieldKey: 'computerModel', sequence: 2, name: '电脑型号', type: 'short_text', required: true, constraints: {}, condition: {
      parentFieldKey: 'category', visibleWhen: ['电脑']
    } }
  ]
  let parserSchema
  const service = createNodeTextRecognitionService({
    repository: {
      async authorizeRecognition() { return { fieldDefinitions: definitions } },
      async claimUsageAndCreateTicket() { return { ticketId: 'ticket', actorHash: 'a'.repeat(64), lockToken: 'lock' } },
      async releaseUsage() {}
    },
    parserClient: { async parse(input) { parserSchema = input.schema; return { candidates: [] } } }
  })
  await service.recognize({ actor: { _id: 'user-1' }, input: {
    businessLineId: 'business-1', nodeId: 'node-1', expectedNodeVersion: 2,
    text: '电脑型号 M1', requestKey: 'request_1234567890123456',
    fieldValues: [{ fieldKey: 'category', value: '电脑' }]
  } })
  assert.deepEqual(parserSchema.map(field => field.fieldKey), ['category', 'computerModel'])
})

function largeLinkedDefinitions(count) {
  const definitions = Array.from({ length: 8 }, (_, index) => ({
    fieldKey: `f${index}`, sequence: index, name: `Field ${index}`,
    type: 'single_select', required: true, constraints: { options: ['A'] }
  }))
  definitions[0].constraints.options = ['A', 'B']
  definitions[1].constraints.options = ['Brand', 'HIDDEN_BRAND']
  definitions[2].constraints.options = [
    ...Array.from({ length: count }, (_, index) => `Model ${index}`), 'HIDDEN_MODEL'
  ]
  definitions[3].constraints.options = ['VISIBLE_ATTRIBUTE', 'HIDDEN_ATTRIBUTE']
  definitions[0].optionLinkage = {
    schemaVersion: 1, fieldKeys: definitions.map(field => field.fieldKey),
    rows: [
      ...Array.from({ length: count }, (_, index) => [0, 0, index, 0, null, null, null, null]),
      [1, 1, count, 1, null, null, null, null]
    ]
  }
  definitions.push({ fieldKey: 'note', sequence: 8, name: 'Note', type: 'short_text', required: false, constraints: {} })
  return definitions
}

function recognitionInterop(definitions, { changeRequest, afterParse } = {}) {
  const now = new Date('2026-09-18T08:00:00.000Z')
  const actor = { _id: 'synthetic-processor', status: 'active' }
  const input = {
    businessLineId: 'business_12345678901234567890', nodeId: 'node_12345678901234567890',
    expectedNodeVersion: 3, text: 'Field 2: Model 100\nNote: synthetic note',
    requestKey: 'request_1234567890123456', fieldValues: [{ fieldKey: 'f0', value: 'A' }, { fieldKey: 'f1', value: 'Brand' }]
  }
  const fake = createFakeCloudDatabase({
    users: [actor],
    business_lines: [{ _id: input.businessLineId, status: 'active', currentNodeId: input.nodeId,
      managerUserIds: ['manager-1'], memberUserIds: [actor._id] }],
    business_nodes: [{ _id: input.nodeId, businessLineId: input.businessLineId, status: 'ready',
      workflowMode: 'review', version: 3, processorUserIds: [actor._id], reviewerUserIds: ['reviewer-1'],
      fieldDefinitions: definitions }]
  })
  const parser = createParserService({
    repository: createCloudParseRepository({ db: fake.db, clock: () => now }),
    aiClient: { async parse() { assert.fail('structured exact candidates must not call AI') } }
  })
  const requests = []
  const service = createNodeTextRecognitionService({
    repository: createCloudNodeTextRecognitionRepository({ db: fake.db }), clock: () => now,
    parserClient: { async parse(request) {
      // Exercise the ordinary JSON service boundary, without mocking the parser.
      const transported = JSON.parse(JSON.stringify(request))
      requests.push(transported)
      if (changeRequest) changeRequest(transported)
      const result = await parser.parseAuthorizedText(transported)
      if (afterParse) await afterParse(fake, input)
      return result
    } }
  })
  return { service, parser, actor, input, fake, requests, now }
}

for (const count of [101, 2495]) {
  test(`recognition interoperates with the real parser and bound ticket for ${count} prefix-valid choices`, async () => {
    const harness = recognitionInterop(largeLinkedDefinitions(count))
    const { service, parser, actor, input, fake, requests, now } = harness
    input.text = `Field 2: Model ${count - 1}\nNote: synthetic note`
    const result = await service.recognize({ actor, input })
    const expectedSchema = [
      { fieldKey: 'f0', name: 'Field 0', type: 'single_select', required: true, constraints: { options: ['A', 'B'] } },
      { fieldKey: 'f1', name: 'Field 1', type: 'single_select', required: true, constraints: { options: ['Brand'] } },
      { fieldKey: 'f2', name: 'Field 2', type: 'single_select', required: true,
        constraints: { options: Array.from({ length: count }, (_, index) => `Model ${index}`) } },
      { fieldKey: 'note', name: 'Note', type: 'short_text', required: false, constraints: {} }
    ]
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0].schema, expectedSchema)
    assert.doesNotMatch(JSON.stringify(requests[0]), /optionLinkage|rows|HIDDEN_|VISIBLE_ATTRIBUTE/)
    assert.deepEqual(result.candidates, [
      { fieldKey: 'f2', value: `Model ${count - 1}`, confidence: 1, sourceExcerpt: `Field 2: Model ${count - 1}`,
        matchKind: 'exact', requiresConfirmation: false, alternatives: [] },
      { fieldKey: 'note', value: 'synthetic note', confidence: 1, sourceExcerpt: 'Note: synthetic note',
        matchKind: 'direct', requiresConfirmation: false, alternatives: [] }
    ])
    const hash = value => crypto.createHash('sha256').update(value).digest('hex')
    const tickets = fake.documents('node_text_parse_requests')
    assert.equal(tickets.length, 1)
    const ticket = tickets[0]
    assert.equal(ticket.status, 'consumed')
    assert.equal(ticket.revision, 1)
    assert.equal(ticket.schemaDigest, hash(JSON.stringify(expectedSchema)))
    assert.equal(result.schemaDigest, ticket.schemaDigest)
    assert.equal(ticket.textDigest, hash(input.text))
    assert.equal(ticket.requestKeyHash, hash(input.requestKey))
    assert.equal(ticket.actorHash, hash(actor._id))
    assert.equal(ticket.businessLineId, input.businessLineId)
    assert.equal(ticket.nodeId, input.nodeId)
    assert.equal(ticket.expectedNodeVersion, 3)
    assert.equal(result.nodeVersion, 3)
    assert.equal(ticket.expiresAt.getTime(), now.getTime() + 5 * 60 * 1000)
    const usage = fake.documents('node_text_parse_usage')[0]
    assert.equal(usage.dailyCount, 1)
    assert.equal(usage.minuteCount, 1)
    assert.equal(usage.lockToken, '')
    assert.equal(usage.inflightUntil, null)
    assert.doesNotMatch(JSON.stringify({ tickets, usage }), /Model |synthetic note|optionLinkage|HIDDEN_/)
    await assert.rejects(parser.parseAuthorizedText(requests[0]), { code: 'NODE_TEXT_TICKET_INVALID' })
  })
}

test('large recognition schema cannot be substituted after ticket issuance and usage is released', async () => {
  const { service, actor, input, fake } = recognitionInterop(largeLinkedDefinitions(101), {
    changeRequest(request) { request.schema[2].constraints.options.reverse() }
  })
  await assert.rejects(service.recognize({ actor, input }), { code: 'NODE_TEXT_TICKET_INVALID' })
  assert.equal(fake.documents('node_text_parse_requests')[0].status, 'pending')
  assert.equal(fake.documents('node_text_parse_usage')[0].lockToken, '')
})

test('large recognition results are stale when hidden linkage semantics change and usage is released', async () => {
  const { service, actor, input, fake } = recognitionInterop(largeLinkedDefinitions(101), {
    async afterParse(database, request) {
      const definitions = largeLinkedDefinitions(101)
      definitions[0].optionLinkage.rows[101][3] = 0
      await database.db.collection('business_nodes').doc(request.nodeId).update({ data: { fieldDefinitions: definitions } })
    }
  })
  await assert.rejects(service.recognize({ actor, input }), { code: 'NODE_TEXT_STALE' })
  assert.equal(fake.documents('node_text_parse_requests').length, 1)
  assert.equal(fake.documents('node_text_parse_requests')[0].status, 'consumed')
  assert.equal(fake.documents('node_text_parse_usage')[0].lockToken, '')
})

test('recognition rejects 5001 choices and excessive total schema bytes before ticket or parser invocation', async () => {
  const excessiveChoices = type => [{ fieldKey: 'choice', name: 'Choice', type, required: true,
    constraints: { options: Array.from({ length: 5001 }, (_, index) => `Choice ${index}`) } }]
  const excessiveBytes = Array.from({ length: 10 }, (_, field) => ({
    fieldKey: `f${field}`, name: `Field ${field}`, type: 'single_select', required: true,
    constraints: { options: Array.from({ length: 100 }, (_, index) => `${index}${'界'.repeat(97)}`) }
  }))
  assert.ok(Buffer.byteLength(JSON.stringify(excessiveBytes), 'utf8') > 262144)
  for (const definitions of [excessiveChoices('single_select'), excessiveChoices('multi_select'), excessiveBytes]) {
    const { service, actor, input, fake, requests } = recognitionInterop(definitions)
    input.fieldValues = []
    await assert.rejects(service.recognize({ actor, input }), { code: 'NODE_TEXT_STALE' })
    assert.equal(fake.documents('node_text_parse_requests').length, 0)
    assert.equal(fake.documents('node_text_parse_usage').length, 0)
    assert.equal(requests.length, 0)
  }
})
