// Presentation only: the server owns field selection, permissions and formatting.
function presentBusinessCard(item) {
  const source = item && typeof item === 'object' ? item : {}
  const summary = source.cardSummary
  let cardState = summary === undefined ? 'none' : 'unavailable'
  let fields = []
  if (summary && summary.state === 'ready' && Array.isArray(summary.fields) && summary.fields.length <= 4) {
    const ids = new Set()
    const valid = summary.fields.every(field => {
      if (!field || typeof field.id !== 'string' || !field.id || ids.has(field.id) ||
          typeof field.label !== 'string' || typeof field.value !== 'string') return false
      ids.add(field.id)
      return true
    })
    if (valid) {
      cardState = 'ready'
      fields = summary.fields.map(({ id, label, value }) => ({ id, label, value }))
    }
  }
  const cardTitle = typeof source.code === 'string' && source.code.trim()
    ? source.code : typeof source.name === 'string' && source.name.trim() ? source.name : '售后'
  return {
    ...source,
    ...(summary !== undefined ? { cardSummary: {
      state: cardState,
      ...(Number.isSafeInteger(summary && summary.configRevision) && summary.configRevision >= 0
        ? { configRevision: summary.configRevision } : {}),
      fields
    } } : {}),
    cardTitle,
    cardState,
    cardRows: fields.map(field => ({ ...field, long: Array.from(field.label + field.value).length > 20 }))
  }
}

module.exports = { presentBusinessCard }
