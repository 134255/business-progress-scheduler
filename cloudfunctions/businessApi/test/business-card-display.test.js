const test = require('node:test')
const assert = require('node:assert/strict')
const { APPLICATION_ERROR_MARKER } = require('../lib/cloud-template-repository')

// Load inside tests so a missing feature is reported alongside service failures.
const domain = () => require('../lib/business-card-display')
const ref = { nodeKey: 'node-a', fieldKey: 'field-a' }
const nodes = [
  { nodeKey: 'node-a', fields: [{ fieldKey: 'field-a' }, { fieldKey: 'field-b' }] },
  { nodeKey: 'node-b', fields: [{ fieldKey: 'field-c' }, { fieldKey: 'field-d' }] }
]
const display = (fields = [ref], revision = 1) => ({ schemaVersion: 1, revision, fields })
const invalid = error => error.code === 'CARD_DISPLAY_INVALID' && error[APPLICATION_ERROR_MARKER] === true
const accessor = (key, value = {}) => Object.defineProperty(value, key, {
  enumerable: true, get() { assert.fail('accessors must not execute') }
})

test('only a completely absent configuration defaults to revision zero and no fields', () => {
  assert.deepEqual(domain().readCardDisplay({}), display([], 0))
  assert.deepEqual(domain().readCardDisplay({ status: 'deleted', cardDisplay: display() }), display())
  const original = { cardDisplay: display() }
  const read = domain().readCardDisplay(original)
  read.fields[0].fieldKey = 'changed'
  assert.equal(original.cardDisplay.fields[0].fieldKey, 'field-a')
})

test('present, inherited, accessor and malformed configurations fail with the application marker', () => {
  for (const template of [
    null, [], { cardDisplay: undefined }, { cardDisplay: null },
    Object.create({ cardDisplay: display() }), accessor('cardDisplay'),
    { cardDisplay: Object.assign(Object.create({ revision: 1 }), { schemaVersion: 1, fields: [] }) },
    { cardDisplay: accessor('revision', { schemaVersion: 1, fields: [] }) },
    { cardDisplay: { ...display(), extra: true } },
    { cardDisplay: { ...display(), [Symbol('extra')]: true } },
    { cardDisplay: { schemaVersion: 1, revision: 1 } },
    ...[0, 2, '1', undefined].map(schemaVersion => ({ cardDisplay: { ...display(), schemaVersion } })),
    ...[-1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(revision => ({ cardDisplay: display([], revision) }))
  ]) assert.throws(() => domain().readCardDisplay(template), invalid)
})

test('references preserve selection order, accept zero through four, and resolve by exact node and field keys', () => {
  const fields = [
    { nodeKey: 'node-b', fieldKey: 'field-d' }, ref,
    { nodeKey: 'node-b', fieldKey: 'field-c' }, { nodeKey: 'node-a', fieldKey: 'field-b' }
  ]
  assert.deepEqual(domain().normalizeCardDisplayFields([], nodes), [])
  assert.deepEqual(domain().normalizeCardDisplayFields(fields, nodes), fields)
  assert.doesNotThrow(() => domain().assertCardDisplayReferences(display(fields), nodes))
})

test('fifth, duplicate, unknown, cross-node and unsafe identifiers are rejected without accepting values', () => {
  for (const fields of [
    Array(5).fill(ref), [ref, ref], [{ ...ref, nodeKey: 'unknown' }],
    [{ ...ref, fieldKey: 'field-c' }], [{ ...ref, fieldKey: 'unknown' }],
    [{ ...ref, value: 'synthetic-only' }], [{ ...ref, label: 'synthetic-label' }],
    ...['', ' node-a', 'node.a', 'a/b', 'x'.repeat(129), 1].map(nodeKey => [{ ...ref, nodeKey }]),
    ...['', 'field-a ', 'a.b', 'x'.repeat(129), null].map(fieldKey => [{ ...ref, fieldKey }])
  ]) assert.throws(() => domain().normalizeCardDisplayFields(fields, nodes), invalid)
})

test('selection arrays and reference records must be dense own data with no extra keys', () => {
  const inheritedArray = [ref]
  Object.setPrototypeOf(inheritedArray, Object.create(Array.prototype))
  for (const fields of [
    undefined, {}, new Array(1), Object.assign([ref], { extra: true }),
    Object.assign([ref], { [Symbol('extra')]: true }), inheritedArray,
    accessor('0', [ref]), [Object.create(ref)], [accessor('nodeKey', { fieldKey: 'field-a' })],
    [{ nodeKey: 'node-a' }], [{ ...ref, [Symbol('extra')]: true }],
    [Object.defineProperty({ ...ref }, 'extra', { value: true })]
  ]) {
    assert.throws(() => domain().normalizeCardDisplayFields(fields, nodes), invalid)
    assert.throws(() => domain().readCardDisplay({ cardDisplay: { schemaVersion: 1, revision: 1, fields } }), invalid)
  }
})

test('ambiguous or malformed definition references fail closed without evaluating getters', () => {
  for (const definitions of [
    [nodes[0], nodes[0]], [{ nodeKey: 'node-a', fields: [{ fieldKey: 'field-a' }, { fieldKey: 'field-a' }] }],
    new Array(1), Object.assign([...nodes], { extra: 1 }), [Object.create(nodes[0])],
    [accessor('nodeKey', { fields: [] })], [accessor('fields', { nodeKey: 'node-a' })],
    [{ nodeKey: 'node-a', fields: [accessor('fieldKey')] }],
    [{ nodeKey: 'node-a', fields: new Array(1) }]
  ]) assert.throws(() => domain().normalizeCardDisplayFields([ref], definitions), invalid)
})

test('definition guard allows renames but refuses loss or movement of a selected stable pair', () => {
  assert.doesNotThrow(() => domain().assertCardDisplayReferences(display(), [
    { nodeKey: 'node-a', name: 'renamed', fields: [{ fieldKey: 'field-a', name: 'renamed' }] }
  ]))
  for (const definitions of [[], [{ nodeKey: 'node-a', fields: [] }], [
    { nodeKey: 'node-a', fields: [] }, { nodeKey: 'node-b', fields: [{ fieldKey: 'field-a' }] }
  ]]) assert.throws(() => domain().assertCardDisplayReferences(display(), definitions), invalid)
})
