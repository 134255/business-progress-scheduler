'use strict'

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

function validDateKey(value) {
  const match = DATE_KEY.exec(value)
  if (!match) return false
  const normalized = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toISOString().slice(0, 10)
  return normalized === value
}

function missingDocument(error) {
  return /document(?:\.get)?:fail.*(?:does not exist|not found)|document with _id .* does not exist/i
    .test(String(error && (error.errMsg || error.message || error)))
}

async function readDocument(db, collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get()
    return result && result.data ? result.data : null
  } catch (error) {
    if (missingDocument(error)) return null
    throw error
  }
}

function createCloudWorkCalendarRepository({ db } = {}) {
  if (!db || typeof db.collection !== 'function') throw new TypeError('db is required')

  async function getDayRule(dateKey) {
    if (!validDateKey(dateKey)) throw new TypeError('dateKey must be a real YYYY-MM-DD date')
    const year = Number(dateKey.slice(0, 4))
    const generation = await readDocument(db, 'work_calendar_years', String(year))
    if (generation && generation.activeSlot === 'none') return null
    const collection = generation && generation.activeSlot === 'shadow'
      ? 'work_calendar_shadow'
      : 'work_calendar'
    const record = await readDocument(db, collection, dateKey)
    if (!record || record._id !== dateKey || record.date !== dateKey || typeof record.isWorkday !== 'boolean') {
      return null
    }
    if (generation && generation.activeSlot === 'legacy') {
      if (generation.year !== year || record.sourceYear !== undefined || record.source !== undefined) return null
    } else if (generation) {
      if (generation.year !== year || !['primary', 'shadow'].includes(generation.activeSlot) ||
          typeof generation.sourceVersion !== 'string' || !generation.sourceVersion ||
          record.sourceYear !== year || record.sourceVersion !== generation.sourceVersion) return null
    } else if (record.sourceYear !== undefined || record.source !== undefined) {
      return null
    }
    return {
      date: record.date,
      isWorkday: record.isWorkday,
      calendarVersion: typeof record.sourceVersion === 'string' && record.sourceVersion
        ? record.sourceVersion
        : null
    }
  }

  return { getDayRule }
}

module.exports = { createCloudWorkCalendarRepository }
