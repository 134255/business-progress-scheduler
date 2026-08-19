'use strict'

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

function validDateKey(value) {
  const match = DATE_KEY.exec(value)
  if (!match) return false
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toISOString().slice(0, 10) === value
}

function missingDocument(error) {
  return /does not exist|not found/i.test(String(error && (error.errMsg || error.message || error)))
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
    if (!validDateKey(dateKey)) throw new TypeError('dateKey must be a real date')
    const year = Number(dateKey.slice(0, 4))
    const generation = await readDocument(db, 'work_calendar_years', String(year))
    if (!generation || generation.year !== year || typeof generation.sourceVersion !== 'string' ||
        !generation.sourceVersion || typeof generation.generationId !== 'string' || !generation.generationId) return null
    const id = `${generation.generationId}_${dateKey}`
    const entry = await readDocument(db, 'work_calendar_entries', id)
    if (!entry || entry._id !== id || entry.date !== dateKey || entry.sourceYear !== year ||
        entry.sourceVersion !== generation.sourceVersion || entry.generationId !== generation.generationId ||
        typeof entry.isWorkday !== 'boolean') return null
    return { date: entry.date, isWorkday: entry.isWorkday, calendarVersion: entry.sourceVersion }
  }
  return { getDayRule }
}

module.exports = { createCloudWorkCalendarRepository }
