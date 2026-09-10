'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const { createCloudWorkCalendarRepository } = require('../lib/cloud-work-calendar-repository')
const { createWorkTimeService } = require('../lib/work-time-service')

// Only the database transport is fake; calculations and generation checks are real.
function calendarFixture(days) {
  const fake = createFakeCloudDatabase()
  const fixture = { fake, reads: [], beforeRead: null, afterRead: null }
  fixture.publish = (year, generationId, sourceVersion, values) => {
    for (const [date, isWorkday] of Object.entries(values)) {
      fake.replace('work_calendar_entries', `${generationId}_${date}`, {
        date, isWorkday, sourceYear: year, generationId, sourceVersion
      })
    }
    fake.replace('work_calendar_years', String(year), { year, generationId, sourceVersion })
  }
  for (const year of new Set(Object.keys(days).map(date => Number(date.slice(0, 4))))) {
    fixture.publish(year, `g-${year}`, `v-${year}`,
      Object.fromEntries(Object.entries(days).filter(([date]) => Number(date.slice(0, 4)) === year)))
  }
  const collection = fake.db.collection.bind(fake.db)
  fake.db.collection = name => {
    const reference = collection(name)
    return {
      ...reference,
      doc(id) {
        const document = reference.doc(id)
        return {
          ...document,
          async get() {
            const read = { collection: name, id }
            fixture.reads.push(read)
            if (fixture.beforeRead) await fixture.beforeRead(read)
            const result = await document.get()
            if (fixture.afterRead) await fixture.afterRead(read, result)
            return result
          }
        }
      }
    }
  }
  fixture.repository = createCloudWorkCalendarRepository({ db: fake.db })
  fixture.service = createWorkTimeService({ calendarRepository: fixture.repository })
  return fixture
}

const first = new Date('2026-08-11T09:00:00+08:00')
const second = new Date('2026-08-12T10:00:00+08:00')
const third = new Date('2026-08-13T10:00:00+08:00')

for (const [dayCount, expectedReads, expectedMinutes, endDate] of [
  [1, 2, 660, '2026-08-01'], [2, 4, 1320, '2026-08-02'], [5, 7, 3300, '2026-08-05']
]) {
  for (const method of ['tryAddWorkMinutes', 'workingMinutesBetween', 'nextWorkInstant']) {
    test(`${method} ${dayCount}-day read budget is ${expectedReads} without a single-day penalty`, async () => {
      const days = Object.fromEntries(Array.from({ length: dayCount }, (_, index) =>
        [`2026-08-${String(index + 1).padStart(2, '0')}`,
          method !== 'nextWorkInstant' || index === dayCount - 1]))
      const fixture = calendarFixture(days)
      const start = new Date('2026-08-01T09:00:00+08:00')
      const end = new Date(`${endDate}T20:00:00+08:00`)
      const result = method === 'workingMinutesBetween'
        ? await fixture.service.workingMinutesBetween(start, end)
        : method === 'tryAddWorkMinutes'
          ? await fixture.service.tryAddWorkMinutes(start, expectedMinutes)
          : await fixture.service.nextWorkInstant(start)
      assert.deepEqual(result, {
        status: 'calculated', calendarVersion: 'v-2026',
        ...(method === 'workingMinutesBetween' ? { minutes: expectedMinutes }
          : { dueAt: method === 'nextWorkInstant' ? new Date(`${endDate}T09:00:00+08:00`) : end })
      })
      assert.equal(fixture.reads.length, expectedReads)
      assert.equal(fixture.reads.filter(read => read.collection === 'work_calendar_entries').length, dayCount)
      assert.equal(fixture.fake.writeCalls.length, 0)
    })
  }
}

for (const [method, calculate, expected] of [
  ['tryAddWorkMinutes', service => service.tryAddWorkMinutes(first, 60),
    { dueAt: new Date('2026-08-11T10:00:00+08:00') }],
  ['nextWorkInstant', service => service.nextWorkInstant(first), { dueAt: first }],
  ['workingMinutesBetween', service => service.workingMinutesBetween(first,
    new Date('2026-08-11T10:00:00+08:00')), { minutes: 60 }]
]) {
  test(`${method} without reuse retains direct getDayRule semantics during a generation switch`, async () => {
    const fixture = calendarFixture({ '2026-08-11': true })
    fixture.afterRead = read => {
      if (read.collection === 'work_calendar_entries') {
        fixture.publish(2026, 'later', 'later-version', { '2026-08-11': false })
      }
    }
    assert.deepEqual(await calculate(fixture.service), {
      status: 'calculated', calendarVersion: 'v-2026', ...expected
    })
    assert.equal(fixture.reads.length, 2)
  })
}

test('two dates in separate years without reuse retain the original four-read budget', async () => {
  const fixture = calendarFixture({ '2026-12-31': true, '2027-01-01': true })
  assert.deepEqual(await fixture.service.workingMinutesBetween(
    new Date('2026-12-31T19:00:00+08:00'), new Date('2027-01-01T10:00:00+08:00')),
  { status: 'calculated', minutes: 120, calendarVersion: 'v-2026|v-2027' })
  assert.equal(fixture.reads.length, 4)
})

test('a missing year without reuse stays pending with one read until the next public call', async () => {
  const fixture = calendarFixture({})
  assert.deepEqual(await fixture.service.tryAddWorkMinutes(first, 60), {
    status: 'pending_calendar', dueAt: null, missingDate: '2026-08-11'
  })
  assert.equal(fixture.reads.length, 1)
  fixture.publish(2026, 'published', 'available', { '2026-08-11': true })
  assert.deepEqual(await fixture.service.tryAddWorkMinutes(first, 60), {
    status: 'calculated', dueAt: new Date('2026-08-11T10:00:00+08:00'), calendarVersion: 'available'
  })
  assert.equal(fixture.reads.length, 3)
})

test('a stable 31-day calculation reads 31 dates plus two year headers, not 62 documents', async () => {
  const days = Object.fromEntries(Array.from({ length: 31 }, (_, index) =>
    [`2026-08-${String(index + 1).padStart(2, '0')}`, true]))
  const fixture = calendarFixture(days)
  const result = await fixture.service.workingMinutesBetween(
    new Date('2026-08-01T09:00:00+08:00'), new Date('2026-08-31T20:00:00+08:00'))
  assert.deepEqual(result, { status: 'calculated', minutes: 20460, calendarVersion: 'v-2026' })
  assert.equal(fixture.reads.length, 33)
  assert.equal(fixture.reads.filter(read => read.collection === 'work_calendar_years').length, 2)
  assert.equal(fixture.fake.writeCalls.length, 0)
})

test('a read session shares concurrent year and date promises and validates each affected year', async () => {
  const fixture = calendarFixture({ '2026-12-31': true, '2027-01-01': false })
  const session = fixture.repository.createReadSession()
  const result = await Promise.all([
    session.getDayRule('2026-12-31'), session.getDayRule('2026-12-31'),
    session.getDayRule('2027-01-01')
  ])
  assert.deepEqual(result.map(rule => rule.isWorkday), [true, true, false])
  assert.equal(await session.findChangedDate(), null)
  assert.equal(fixture.reads.length, 6)
  assert.deepEqual(fixture.reads.filter(read => read.collection === 'work_calendar_entries').map(read => read.id),
    ['g-2026_2026-12-31', 'g-2027_2027-01-01'])
})

test('repeating just one date is reuse and must still revalidate its generation', async () => {
  const fixture = calendarFixture({ '2026-08-11': true })
  const session = fixture.repository.createReadSession()
  assert.equal((await session.getDayRule('2026-08-11')).isWorkday, true)
  fixture.publish(2026, 'new', 'new-version', { '2026-08-11': false })
  assert.equal((await session.getDayRule('2026-08-11')).isWorkday, true)
  assert.equal(await session.findChangedDate(), '2026-08-11')
  assert.equal(fixture.reads.length, 3)
})

test('once any cache is reused, even a singly read year is revalidated before returning', async () => {
  const fixture = calendarFixture({ '2026-12-31': true, '2027-01-01': true })
  const session = fixture.repository.createReadSession()
  await session.getDayRule('2026-12-31')
  await session.getDayRule('2026-12-31')
  await session.getDayRule('2027-01-01')
  fixture.publish(2027, 'new', 'new-version', { '2027-01-01': false })
  assert.equal(await session.findChangedDate(), '2027-01-01')
  assert.equal(fixture.reads.length, 6)
})

const calculations = [
  ['tryAddWorkMinutes', service => service.tryAddWorkMinutes(first, 60),
    { status: 'calculated', dueAt: third, calendarVersion: 'v-new' }],
  ['nextWorkInstant', service => service.nextWorkInstant(first),
    { status: 'calculated', dueAt: new Date('2026-08-13T09:00:00+08:00'), calendarVersion: 'v-new' }],
  ['workingMinutesBetween', service => service.workingMinutesBetween(first, third),
    { status: 'calculated', minutes: 60, calendarVersion: 'v-new' }]
]

for (const [name, calculate, expected] of calculations) {
  test(`${name} discards the whole result when a generation switches after cache reuse`, async () => {
    const fixture = calendarFixture({ '2026-08-11': false, '2026-08-12': true, '2026-08-13': true })
    fixture.afterRead = read => {
      if (read.id === 'g-2026_2026-08-12') {
        fixture.afterRead = null
        fixture.publish(2026, 'g-new', 'v-new', { '2026-08-11': false, '2026-08-12': false, '2026-08-13': true })
      }
    }
    assert.deepEqual(await calculate(fixture.service), expected)
    assert.equal(fixture.reads.filter(read => read.collection === 'work_calendar_years').length, 4)
  })

  test(`${name} returns pending instead of a stale result after three unstable attempts`, async () => {
    const fixture = calendarFixture({ '2026-08-11': false, '2026-08-12': true, '2026-08-13': true })
    let switches = 0
    fixture.afterRead = read => {
      if (read.collection === 'work_calendar_entries' && read.id.endsWith('_2026-08-12')) {
        switches += 1
        assert.ok(switches <= 3, 'generation retries must be bounded')
        fixture.publish(2026, `g-${switches}`, `v-${switches}`,
          { '2026-08-11': false, '2026-08-12': true, '2026-08-13': true })
      }
    }
    const result = await calculate(fixture.service)
    assert.deepEqual(result, {
      status: 'pending_calendar',
      ...(name === 'workingMinutesBetween' ? { minutes: null } : { dueAt: null }),
      missingDate: '2026-08-11'
    })
    assert.equal(switches, 3)
  })
}

test('reused generation identity is checked even if sourceVersion stays unchanged', async () => {
  const fixture = calendarFixture({ '2026-08-11': true, '2026-08-12': true })
  fixture.afterRead = read => {
    if (read.id === 'g-2026_2026-08-12') {
      fixture.afterRead = null
      fixture.publish(2026, 'replacement', 'v-2026', { '2026-08-11': false, '2026-08-12': false })
    }
  }
  assert.deepEqual(await fixture.service.workingMinutesBetween(first, second),
    { status: 'calculated', minutes: 0, calendarVersion: 'v-2026' })
})

test('sourceVersion changes invalidate the result even without a generationId change', async () => {
  const fixture = calendarFixture({ '2026-08-11': true, '2026-08-12': true })
  fixture.afterRead = read => {
    if (read.id === 'g-2026_2026-08-12') {
      fixture.afterRead = null
      fixture.publish(2026, 'g-2026', 'corrected', { '2026-08-11': false, '2026-08-12': false })
    }
  }
  assert.deepEqual(await fixture.service.workingMinutesBetween(first, second),
    { status: 'calculated', minutes: 0, calendarVersion: 'corrected' })
})

test('a change to the earlier year during a cross-year calculation forces a complete retry', async () => {
  const fixture = calendarFixture({ '2026-12-30': true, '2026-12-31': false, '2027-01-01': true })
  fixture.afterRead = read => {
    if (read.id === 'g-2027_2027-01-01') {
      fixture.afterRead = null
      fixture.publish(2026, 'corrected', 'new-2026', { '2026-12-30': false, '2026-12-31': false })
    }
  }
  const result = await fixture.service.workingMinutesBetween(
    new Date('2026-12-30T19:59:29.500+08:00'), new Date('2027-01-01T09:00:30.500+08:00'))
  assert.deepEqual(result, { status: 'calculated', minutes: 0, calendarVersion: 'new-2026|v-2027' })
})

test('pending results after reuse are revalidated so a newly published generation can resolve them', async () => {
  const fixture = calendarFixture({ '2026-08-11': true })
  fixture.beforeRead = read => {
    if (read.id === 'g-2026_2026-08-12') {
      fixture.publish(2026, 'published', 'available', { '2026-08-11': true, '2026-08-12': true })
    }
  }
  assert.deepEqual(await fixture.service.workingMinutesBetween(first, second), {
    status: 'calculated', minutes: 720, calendarVersion: 'available'
  })
})

test('invalidated year metadata never permits returning a previously calculated result', async () => {
  const fixture = calendarFixture({ '2026-08-11': true, '2026-08-12': true })
  fixture.afterRead = read => {
    if (read.id === 'g-2026_2026-08-12') {
      fixture.afterRead = null
      fixture.fake.replace('work_calendar_years', '2026', { year: 2026, generationId: null, sourceVersion: '' })
    }
  }
  assert.deepEqual(await fixture.service.workingMinutesBetween(first, second), {
    status: 'pending_calendar', minutes: null, missingDate: '2026-08-11'
  })
})

test('year revalidation transport errors propagate and do not poison the next calculation', async () => {
  const fixture = calendarFixture({ '2026-08-11': true, '2026-08-12': true })
  fixture.beforeRead = read => {
    if (read.collection === 'work_calendar_years' && fixture.reads.length === 4) {
      throw new Error('calendar transport unavailable')
    }
  }
  await assert.rejects(fixture.service.workingMinutesBetween(first, second), /calendar transport unavailable/)
  fixture.beforeRead = null
  assert.equal((await fixture.service.workingMinutesBetween(first, second)).status, 'calculated')
})

test('overlapping requests on a reused service never share a failing date promise', async () => {
  const fixture = calendarFixture({ '2026-08-11': true })
  let release
  let reached
  const paused = new Promise(resolve => { reached = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let firstRead = true
  fixture.beforeRead = async read => {
    if (read.collection === 'work_calendar_entries' && firstRead) {
      firstRead = false
      reached()
      await gate
      throw new Error('first request failed')
    }
  }
  const failed = assert.rejects(fixture.service.tryAddWorkMinutes(first, 60), /first request failed/)
  await paused
  try {
    assert.equal((await fixture.service.tryAddWorkMinutes(first, 60)).status, 'calculated')
  } finally {
    release()
  }
  await failed
  assert.equal((await fixture.service.tryAddWorkMinutes(first, 60)).status, 'calculated')
})

test('separate public calculations re-read calendar state on the same service instance', async () => {
  const fixture = calendarFixture({ '2026-08-11': true })
  assert.equal((await fixture.service.nextWorkInstant(first)).calendarVersion, 'v-2026')
  fixture.publish(2026, 'later', 'later-version', { '2026-08-11': false, '2026-08-12': true })
  assert.deepEqual(await fixture.service.nextWorkInstant(first), {
    status: 'calculated', dueAt: new Date('2026-08-12T09:00:00+08:00'), calendarVersion: 'later-version'
  })
})

test('zero minutes, empty intervals and nonworking-window intervals perform zero reads', async () => {
  const fixture = calendarFixture({})
  assert.deepEqual(await fixture.service.tryAddWorkMinutes(first, 0),
    { status: 'calculated', dueAt: first, calendarVersion: null })
  assert.deepEqual(await fixture.service.workingMinutesBetween(first, first),
    { status: 'calculated', minutes: 0, calendarVersion: null })
  assert.deepEqual(await fixture.service.workingMinutesBetween(
    new Date('2026-08-11T20:00:00+08:00'), new Date('2026-08-12T09:00:00+08:00')),
  { status: 'calculated', minutes: 0, calendarVersion: null })
  assert.deepEqual(fixture.reads, [])
})

test('leap day and work-window seconds survive session reuse with one final minute rounding', async () => {
  const fixture = calendarFixture({ '2028-02-28': true, '2028-02-29': true, '2028-03-01': true })
  const result = await fixture.service.workingMinutesBetween(
    new Date('2028-02-28T19:59:29.500+08:00'), new Date('2028-03-01T09:00:30.500+08:00'))
  assert.deepEqual(result, { status: 'calculated', minutes: 661, calendarVersion: 'v-2028' })
  assert.equal(fixture.reads.length, 5)
  const due = await fixture.service.tryAddWorkMinutes(new Date('2028-02-28T19:59:30+08:00'), 1)
  assert.deepEqual(due, {
    status: 'calculated', dueAt: new Date('2028-02-29T09:00:30+08:00'), calendarVersion: 'v-2028'
  })
})

test('session reads keep all entry generation, source, date and boolean checks fail-closed', async () => {
  for (const corrupt of [
    { generationId: 'other' }, { sourceVersion: 'other' }, { sourceYear: 2025 },
    { date: '2026-08-12' }, { isWorkday: 1 }
  ]) {
    const fixture = calendarFixture({ '2026-08-11': true })
    const entry = fixture.fake.documents('work_calendar_entries')[0]
    fixture.fake.replace('work_calendar_entries', entry._id, { ...entry, ...corrupt })
    assert.deepEqual(await fixture.service.tryAddWorkMinutes(first, 60), {
      status: 'pending_calendar', dueAt: null, missingDate: '2026-08-11'
    })
  }
})
