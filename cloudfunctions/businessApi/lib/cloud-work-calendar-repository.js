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

  async function readGeneration(year) {
    const generation = await readDocument(db, 'work_calendar_years', String(year))
    if (!generation || generation.year !== year || typeof generation.sourceVersion !== 'string' ||
        !generation.sourceVersion || typeof generation.generationId !== 'string' || !generation.generationId) return null
    return { year, generationId: generation.generationId, sourceVersion: generation.sourceVersion }
  }

  async function readDayRule(dateKey, generation) {
    if (!generation) return null
    const year = Number(dateKey.slice(0, 4))
    const recordId = `${generation.generationId}_${dateKey}`
    const record = await readDocument(db, 'work_calendar_entries', recordId)
    if (!record || record._id !== recordId || record.date !== dateKey || typeof record.isWorkday !== 'boolean') {
      return null
    }
    if (record.sourceYear !== year || record.sourceVersion !== generation.sourceVersion ||
        record.generationId !== generation.generationId) return null
    return {
      date: record.date,
      isWorkday: record.isWorkday,
      calendarVersion: typeof record.sourceVersion === 'string' && record.sourceVersion
        ? record.sourceVersion
        : null
    }
  }

  async function getDayRule(dateKey) {
    if (!validDateKey(dateKey)) throw new TypeError('dateKey must be a real YYYY-MM-DD date')
    return readDayRule(dateKey, await readGeneration(Number(dateKey.slice(0, 4))))
  }

  // Owned by one calculation attempt, never by this reused repository instance.
  // Published entries are immutable. Reused snapshots require a final header check;
  // without reuse retain the original getDayRule read semantics and budget.
  function createReadSession() {
    const years = new Map()
    const days = new Map()
    let reused = false

    async function getDayRule(dateKey) {
      if (!validDateKey(dateKey)) throw new TypeError('dateKey must be a real YYYY-MM-DD date')
      const year = Number(dateKey.slice(0, 4))
      if (days.has(dateKey) || years.has(year)) reused = true
      if (!days.has(dateKey)) {
        if (!years.has(year)) {
          years.set(year, { firstDate: dateKey, generation: readGeneration(year) })
        }
        days.set(dateKey, years.get(year).generation.then(generation => readDayRule(dateKey, generation)))
      }
      return days.get(dateKey)
    }

    async function findChangedDate() {
      if (!reused) return null
      for (const [year, snapshot] of years) {
        const before = await snapshot.generation
        const current = await readGeneration(year)
        if (before === null && current === null) continue
        if (!before || !current || before.generationId !== current.generationId ||
            before.sourceVersion !== current.sourceVersion) return snapshot.firstDate
      }
      return null
    }

    return { getDayRule, findChangedDate }
  }

  return { getDayRule, createReadSession }
}

module.exports = { createCloudWorkCalendarRepository }
