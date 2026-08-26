function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function emptyValue(value) {
  return value === null || value === undefined || value === '' || Array.isArray(value) && value.length === 0
}

function candidateText(value) {
  if (Array.isArray(value)) return value.join('、')
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function readCharacterClass(pattern, start) {
  let index = start + 1
  while (index < pattern.length) {
    if (pattern[index] === '\\') { index += 2; continue }
    if (pattern[index] === '[') return -1
    if (pattern[index] === ']') return index + 1
    index += 1
  }
  return -1
}

function readQuantifier(pattern, start) {
  if ('*+?'.includes(pattern[start])) return start + 1
  if (pattern[start] !== '{') return start
  const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(pattern.slice(start))
  if (!match || match[2] && Number(match[2]) < Number(match[1])) return -1
  return start + match[0].length
}

function safePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 256) return false
  let start = pattern.startsWith('^') ? 1 : 0
  const end = pattern.endsWith('$') ? pattern.length - 1 : pattern.length
  let quantified = false
  while (start < end) {
    const character = pattern[start]
    let next
    if (character === '[') next = readCharacterClass(pattern, start)
    else if (character === '\\') {
      if (start + 1 >= end || /\d/.test(pattern[start + 1])) return false
      next = start + 2
    } else if ('^$()[]{}|*+?.'.includes(character)) return false
    else next = start + 1
    if (next < 0 || next > end) return false
    const quantifierEnd = readQuantifier(pattern, next)
    if (quantifierEnd < 0) return false
    if (quantifierEnd !== next) {
      if (quantified || quantifierEnd !== end) return false
      quantified = true
      next = quantifierEnd
    }
    start = next
  }
  return true
}

function respectsDecimalPlaces(value, places) {
  if (places === undefined) return true
  if (!Number.isSafeInteger(places) || places < 0) return false
  const scaled = value * (10 ** places)
  return Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8
}

function validCandidate(field, value) {
  const constraints = field && field.constraints || {}
  if (!field || typeof field.fieldKey !== 'string') return false
  if (field.type === 'short_text' || field.type === 'long_text') {
    if (typeof value !== 'string' || !value.trim()) return false
    if (constraints.minLength !== undefined && (!Number.isSafeInteger(constraints.minLength) || value.length < constraints.minLength)) return false
    if (constraints.maxLength !== undefined && (!Number.isSafeInteger(constraints.maxLength) || value.length > constraints.maxLength)) return false
    if (constraints.pattern !== undefined) {
      if (!safePattern(constraints.pattern)) return false
      try { if (!new RegExp(constraints.pattern).test(value)) return false } catch (_) { return false }
    }
    return true
  }
  if (field.type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) &&
      (constraints.min === undefined || Number.isFinite(constraints.min) && value >= constraints.min) &&
      (constraints.max === undefined || Number.isFinite(constraints.max) && value <= constraints.max) &&
      respectsDecimalPlaces(value, constraints.decimalPlaces)
  }
  if (field.type === 'boolean') return typeof value === 'boolean'
  if (field.type === 'date') return validDate(value)
  if (field.type === 'single_select') return Array.isArray(constraints.options) && constraints.options.includes(value)
  if (field.type === 'multi_select') {
    return Array.isArray(value) && Array.isArray(constraints.options) && value.every(item => constraints.options.includes(item)) && new Set(value).size === value.length
  }
  return false
}

function buildRecognitionPreview(fields, fieldValues, candidates) {
  if (!Array.isArray(fields) || !fieldValues || typeof fieldValues !== 'object' || !Array.isArray(candidates)) return []
  const byKey = new Map(fields.map(field => [field.fieldKey, field]))
  const seen = new Set()
  const preview = []
  for (const candidate of candidates) {
    const field = candidate && byKey.get(candidate.fieldKey)
    if (!field || seen.has(candidate.fieldKey) || !validCandidate(field, candidate.value)) continue
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 ||
        typeof candidate.sourceExcerpt !== 'string' || !candidate.sourceExcerpt.trim()) continue
    seen.add(candidate.fieldKey)
    const currentValue = fieldValues[candidate.fieldKey]
    const group = candidate.requiresConfirmation ? 'manual' : emptyValue(currentValue) ? 'direct' : 'replacement'
    preview.push({
      fieldKey: field.fieldKey,
      fieldName: field.name,
      value: candidate.value,
      candidateText: candidateText(candidate.value),
      currentText: emptyValue(currentValue) ? '未填写' : candidateText(currentValue),
      confidenceText: `${Math.round(candidate.confidence * 100)}%`,
      sourceExcerpt: candidate.sourceExcerpt.trim(),
      matchKind: candidate.matchKind,
      requiresConfirmation: Boolean(candidate.requiresConfirmation),
      group,
      selected: group === 'direct' && !sameValue(currentValue, candidate.value)
    })
  }
  return preview
}

function applyRecognitionPreview(fields, fieldValues, preview) {
  const nextValues = { ...fieldValues }
  const byKey = new Map(fields.map(field => [field.fieldKey, field]))
  for (const item of Array.isArray(preview) ? preview : []) {
    const field = item && byKey.get(item.fieldKey)
    if (item && item.selected && field && validCandidate(field, item.value)) nextValues[item.fieldKey] = item.value
  }
  const nextFields = fields.map(field => {
    if (field.type !== 'multi_select') return field
    const selected = Array.isArray(nextValues[field.fieldKey]) ? nextValues[field.fieldKey] : []
    const options = field.constraints && Array.isArray(field.constraints.options) ? field.constraints.options : []
    return { ...field, optionItems: options.map(value => ({ value, selected: selected.includes(value) })) }
  })
  return { fieldValues: nextValues, fields: nextFields }
}

function recognitionSnapshotStillCurrent(snapshot, current) {
  if (!snapshot || !current) return false
  return ['actorId', 'lineId', 'nodeId', 'nodeVersion', 'schemaDigest', 'formRevision']
    .every(key => snapshot[key] === current[key])
}

module.exports = { buildRecognitionPreview, applyRecognitionPreview, recognitionSnapshotStillCurrent }
