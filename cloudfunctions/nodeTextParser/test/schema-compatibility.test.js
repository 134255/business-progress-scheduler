'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { normalizeSchema } = require('../../businessApi/lib/node-text-recognition-service')
const { normalizeParserSchema } = require('../lib/parser-domain')
const { createParserService } = require('../lib/parser-service')

function choiceSchema(count, type = 'single_select') {
  return [{ fieldKey: 'choice', name: 'Choice', type, required: true,
    constraints: { options: Array.from({ length: count }, (_, index) => `Choice ${index}`) } }]
}

// All options stay within the existing 100-character limit. Multibyte labels
// distinguish the UTF-8 JSON budget from a character-count or per-field budget.
function schemaAtBytes(bytes) {
  const schema = Array.from({ length: 10 }, (_, field) => ({
    fieldKey: `f${field}`, name: `Field ${field}`, type: 'single_select', required: true,
    constraints: { options: Array.from({ length: 100 }, (_, index) =>
      `${String(index).padStart(4, '0')}${'界'.repeat(80)}`) }
  }))
  let remaining = bytes - Buffer.byteLength(JSON.stringify(schema), 'utf8')
  assert.ok(remaining >= 0)
  for (const field of schema) {
    field.constraints.options = field.constraints.options.map(option => {
      const padding = Math.min(remaining, 100 - option.length)
      remaining -= padding
      return option + 'x'.repeat(padding)
    })
  }
  assert.equal(remaining, 0)
  assert.equal(Buffer.byteLength(JSON.stringify(schema), 'utf8'), bytes)
  return schema
}

for (const [side, normalize, code] of [
  ['recognition', normalizeSchema, 'NODE_TEXT_STALE'],
  ['parser', normalizeParserSchema, 'NODE_TEXT_MODEL_INVALID']
]) {
  for (const type of ['single_select', 'multi_select']) {
    test(`${side} accepts all 5000 ${type} choices without truncation`, () => {
      const schema = choiceSchema(5000, type)
      const result = normalize(schema)
      assert.deepEqual(result, schema)
      assert.equal(result[0].constraints.options[4999], 'Choice 4999')
      assert.notEqual(result[0].constraints.options, schema[0].constraints.options)
    })

    test(`${side} rejects 5001 ${type} choices`, () => {
      assert.throws(() => normalize(choiceSchema(5001, type)), { code })
    })
  }

  test(`${side} accepts exactly 256 KiB of normalized UTF-8 schema`, () => {
    const schema = schemaAtBytes(262144)
    const input = schema.map(field => ({ ...field, name: ` ${field.name} ` }))
    assert.ok(Buffer.byteLength(JSON.stringify(input), 'utf8') > 262144)
    assert.deepEqual(normalize(input), schema)
  })

  test(`${side} rejects one byte above the total normalized UTF-8 schema budget`, () => {
    const schema = schemaAtBytes(262145)
    assert.ok(JSON.stringify(schema).length < 262144)
    assert.throws(() => normalize(schema), { code })
  })

  test(`${side} rejects damaged large choices without evaluating getters`, () => {
    let getters = 0
    const variants = [
      options => { delete options[100] },
      options => { Object.defineProperty(options, 100, { get() { getters += 1; return 'injected' } }) },
      options => {
        delete options[100]
        const prototype = Object.create(Array.prototype)
        Object.defineProperty(prototype, 100, { get() { getters += 1; return 'inherited' } })
        Object.setPrototypeOf(options, prototype)
      }
    ]
    for (const damage of variants) {
      const schema = choiceSchema(101)
      damage(schema[0].constraints.options)
      assert.throws(() => normalize(schema), { code })
    }
    for (const constraints of [
      Object.create({ options: choiceSchema(101)[0].constraints.options }),
      Object.defineProperty({}, 'options', { enumerable: true, get() { getters += 1; return [] } })
    ]) {
      assert.throws(() => normalize([{ ...choiceSchema(1)[0], constraints }]), { code })
    }
    assert.equal(getters, 0)
  })

  test(`${side} preserves option string validation with larger dictionaries`, () => {
    for (const value of ['', '   ', 'x'.repeat(101), 'Choice 0', 42]) {
      const schema = choiceSchema(101)
      schema[0].constraints.options[100] = value
      assert.throws(() => normalize(schema), { code })
    }
    const schema = choiceSchema(101)
    schema[0].constraints.options[100] = 'x'.repeat(100)
    assert.equal(normalize(schema)[0].constraints.options[100], 'x'.repeat(100))
  })

  test(`${side} preserves legacy normalized schema bytes and digest`, () => {
    const input = [
      { fieldKey: ' item ', name: ' Item ', type: 'single_select', required: true,
        constraints: { options: ['A', 'B'] } },
      { fieldKey: 'count', name: 'Count', type: 'number', required: false,
        constraints: { max: 10, min: 0, decimalPlaces: 2 } }
    ]
    const expected = '[{"fieldKey":"item","name":"Item","type":"single_select","required":true,"constraints":{"options":["A","B"]}},{"fieldKey":"count","name":"Count","type":"number","required":false,"constraints":{"decimalPlaces":2,"min":0,"max":10}}]'
    const actual = JSON.stringify(normalize(input))
    assert.equal(actual, expected)
    assert.equal(crypto.createHash('sha256').update(actual).digest('hex'),
      crypto.createHash('sha256').update(expected).digest('hex'))
  })
}

test('parser rejects excessive choice count or schema bytes before ticket consumption and AI', async () => {
  let consumed = 0
  let aiCalls = 0
  const service = createParserService({
    repository: { async consumeParseTicket() { consumed += 1 } },
    aiClient: { async parse() { aiCalls += 1; return { candidates: [] } } }
  })
  for (const schema of [choiceSchema(5001), choiceSchema(5001, 'multi_select'), schemaAtBytes(262145)]) {
    await assert.rejects(service.parseAuthorizedText({ text: 'Choice: Choice 0', schema }),
      { code: 'NODE_TEXT_MODEL_INVALID' })
  }
  assert.equal(consumed, 0)
  assert.equal(aiCalls, 0)
})
