function normalizeBusinessListFilters(input, createError) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError()
  const filters = {}
  for (const [key, allowed] of [['status', ['active', 'completed']], ['scope', ['mine']]]) {
    if (!(key in input)) continue
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        !allowed.includes(descriptor.value)) throw createError()
    filters[key] = descriptor.value
  }
  return filters
}

module.exports = { normalizeBusinessListFilters }
