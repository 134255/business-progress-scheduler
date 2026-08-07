const BUSINESS_CODE_PATTERN = /^BL-\d{8}-\d{4,}$/

function requireSequence(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('sequence must be a positive safe integer')
  }
  return value
}

function formatBusinessCode(now, sequence, timeZone = 'Asia/Shanghai') {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new TypeError('now must be a valid date')
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]))
  return `BL-${parts.year}${parts.month}${parts.day}-${String(requireSequence(sequence)).padStart(4, '0')}`
}

function formatNodeCode(businessCode, oneBasedSequence) {
  if (typeof businessCode !== 'string' || !BUSINESS_CODE_PATTERN.test(businessCode)) {
    throw new TypeError('businessCode must be a valid business code')
  }
  return `${businessCode}-N${String(requireSequence(oneBasedSequence)).padStart(3, '0')}`
}

module.exports = { formatBusinessCode, formatNodeCode }
