const TERMINAL_LINE_STATUSES = new Set(['completed', 'cancelled', 'closed', 'deleted'])

function parseStrictTimestamp(value) {
  if (value === null || value === undefined) return { valid: true, date: null }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { valid: false, date: null }
      : { valid: true, date: new Date(value) }
  }
  if (typeof value !== 'string') return { valid: false, date: null }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return { valid: false, date: null }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const maximumDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0
  if (year < 1 || day < 1 || day > maximumDay || hour > 23 || minute > 59 || second > 59) {
    return { valid: false, date: null }
  }
  if (zone !== 'Z') {
    const zoneHour = Number(zone.slice(1, 3))
    const zoneMinute = Number(zone.slice(4, 6))
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) {
      return { valid: false, date: null }
    }
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? { valid: false, date: null }
    : { valid: true, date: parsed }
}

function classifyEvidenceRetention(evidence, line, { allowLegacy = false } = {}) {
  if (!evidence || !line) return null
  const evidenceDeadline = parseStrictTimestamp(evidence.purgeDueAt)
  const lineDeadline = parseStrictTimestamp(line.purgeDueAt)
  if (!evidenceDeadline.valid || !lineDeadline.valid) return null

  const attached = typeof evidence.feedbackId === 'string' && evidence.feedbackId &&
    evidence.attachmentState === 'attached'
  const scopeAbsent = evidence.retentionScope === null || evidence.retentionScope === undefined
  const sourceAbsent = evidence.retentionSource === null || evidence.retentionSource === undefined
  if (allowLegacy && scopeAbsent && sourceAbsent) {
    const legacyDeadline = evidenceDeadline.date || lineDeadline.date
    if (TERMINAL_LINE_STATUSES.has(line.status) && !legacyDeadline) return null
    return { kind: 'legacy', effectivePurgeDueAt: legacyDeadline }
  }
  if (!attached) {
    if (evidence.retentionScope !== null && evidence.retentionScope !== undefined ||
        evidence.retentionSource !== null && evidence.retentionSource !== undefined) return null
    return { kind: 'orphan', effectivePurgeDueAt: evidenceDeadline.date }
  }

  if (evidence.retentionScope === 'business_line' && evidence.retentionSource === 'node_feedback') {
    if (line.status !== 'active' && !TERMINAL_LINE_STATUSES.has(line.status)) return null
    if (TERMINAL_LINE_STATUSES.has(line.status) && !lineDeadline.date) return null
    return { kind: 'business_line', effectivePurgeDueAt: lineDeadline.date }
  }
  if (evidence.retentionScope === 'evidence' && evidence.retentionSource === 'audit_amendment') {
    if (!evidenceDeadline.date) return null
    return { kind: 'audit_amendment', effectivePurgeDueAt: evidenceDeadline.date }
  }
  return null
}

module.exports = { TERMINAL_LINE_STATUSES, classifyEvidenceRetention, parseStrictTimestamp }
