const test = require('node:test')
const assert = require('node:assert/strict')

const { formatBusinessCode, formatNodeCode } = require('../lib/business-numbering')

test('business and node codes use Shanghai dates and expand without wrapping', () => {
  const beforeShanghaiMidnight = new Date('2026-08-06T16:30:00.000Z')

  assert.equal(formatBusinessCode(beforeShanghaiMidnight, 7), 'BL-20260807-0007')
  assert.equal(formatBusinessCode(beforeShanghaiMidnight, 10000), 'BL-20260807-10000')
  assert.equal(formatNodeCode('BL-20260807-0007', 1), 'BL-20260807-0007-N001')
  assert.equal(formatNodeCode('BL-20260807-0007', 1000), 'BL-20260807-0007-N1000')
})

test('numbering rejects invalid dates, business codes, and unsafe sequences', () => {
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatBusinessCode(new Date(), sequence), /positive safe integer/)
    assert.throws(() => formatNodeCode('BL-20260807-0001', sequence), /positive safe integer/)
  }

  assert.throws(() => formatBusinessCode(new Date('invalid'), 1), /valid date/)
  assert.throws(() => formatNodeCode('client-value', 1), /valid business code/)
})
