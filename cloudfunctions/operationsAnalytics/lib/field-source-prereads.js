'use strict'

// These are call-local source hints, never transaction reads or authority.
const CONTENT = Object.freeze({ business_lines: 'businessLineId', node_feedback: 'latestFeedbackId' })
const MAX_GROUP = 4

function stopped() {
  const error = new Error('FIELD_RECOVERY_PREREAD_STOP')
  error.code = 'FIELD_RECOVERY_PREREAD_STOP'
  return error
}

// Keep accessors inert until the original consumer rejects them. Shared line
// entries must not share mutable nested objects between different candidates.
function copyData(value, seen = new Map()) {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  const prototype = Object.getPrototypeOf(value)
  const copy = prototype === Date.prototype ? new Date(Date.prototype.getTime.call(value))
    : Array.isArray(value) ? [] : Object.create(prototype)
  if (Array.isArray(value)) Object.setPrototypeOf(copy, prototype)
  seen.set(value, copy)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (Object.hasOwn(descriptor, 'value')) descriptor.value = copyData(descriptor.value, seen)
    Object.defineProperty(copy, key, descriptor)
  }
  return copy
}

function createFieldSourcePrereads({ db, budget, own, documentId, excludedHint }) {
  let group = null
  const supported = typeof db.command.in === 'function'
  function discard() { group = null }
  function locator(node) {
    return { nodeId: documentId(own(node, '_id')),
      business_lines: documentId(own(node, 'businessLineId')),
      node_feedback: documentId(own(node, 'latestFeedbackId')), used: new Set() }
  }
  async function fetchRows(collection, ids) {
    budget()
    let response
    try { response = await db.collection(collection).where({ _id: db.command.in(ids) }).limit(ids.length).get() }
    catch (_) { throw stopped() }
    budget()
    try {
      const rows = own(response, 'data')
      if (!Array.isArray(rows) || rows.length > ids.length) throw stopped()
      const records = new Map()
      for (let index = 0; index < rows.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(rows, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw stopped()
        const row = descriptor.value, id = own(row, '_id')
        if (!ids.includes(id) || records.has(id)) throw stopped()
        records.set(id, row)
      }
      return records
    } catch (_) { throw stopped() }
  }
  async function prepare({ page, index, node }) {
    budget()
    if (!supported) return
    const current = locator(node)
    if (group && group.entries.has(current.nodeId)) return
    discard()
    const locations = [current]
    let previous = current.nodeId
    for (let offset = 1; offset < MAX_GROUP && index + offset < page.length; offset++) {
      let next
      try {
        const descriptor = Object.getOwnPropertyDescriptor(page, String(index + offset))
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || excludedHint(descriptor.value)) break
        next = locator(descriptor.value)
        if (next.nodeId <= previous) break
      } catch (_) { break } // Invalid future hints are handled at their own visit.
      locations.push(next); previous = next.nodeId
    }
    if (locations.length < 2) return
    const ids = Object.fromEntries(Object.keys(CONTENT).map(collection =>
      [collection, [...new Set(locations.map(location => location[collection]))]]))
    const lines = await fetchRows('business_lines', ids.business_lines)
    group = { entries: new Map(locations.map(location => [location.nodeId, location])), ids,
      records: { business_lines: lines } }
  }
  async function read({ node, collection, id, fallback }) {
    budget()
    const current = group && group.entries.get(own(node, '_id'))
    if (!current || current[collection] !== id || current.used.has(collection)) {
      // A known changed pointer is not a replay of an unknown query outcome.
      if (current) discard()
      return fallback()
    }
    if (!Object.hasOwn(group.records, collection)) {
      group.records[collection] = await fetchRows(collection, group.ids[collection])
    }
    budget()
    current.used.add(collection)
    const row = group.records[collection].get(id)
    const result = row ? copyData(row) : null
    if (current.used.size === Object.keys(CONTENT).length) group.entries.delete(current.nodeId)
    return result
  }
  return { prepare, read, discard }
}

module.exports = { createFieldSourcePrereads }
