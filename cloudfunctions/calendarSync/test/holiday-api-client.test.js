'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createHolidayApiClient } = require('../lib/holiday-api-client')

function daysInYear(year) {
  const rows = []
  for (let at = Date.UTC(year, 0, 1); new Date(at).getUTCFullYear() === year; at += 86400000) {
    rows.push({ date: new Date(at).toISOString().slice(0, 10), is_holiday: 0 })
  }
  return rows
}

function payload(year, changes = {}) {
  const data = daysInYear(year)
  return { code: 0, year, count: data.length, data, ...changes }
}

function fakeHttps({ statusCode = 200, body, error, timeout = false }) {
  return {
    get(url, options, callback) {
      const request = new EventEmitter()
      request.destroy = destroyError => queueMicrotask(() => request.emit('error', destroyError))
      request.setTimeout = (milliseconds, handler) => {
        request.timeoutMilliseconds = milliseconds
        if (timeout) queueMicrotask(handler)
      }
      queueMicrotask(() => {
        if (error) return request.emit('error', error)
        if (timeout) return
        const response = new EventEmitter()
        response.statusCode = statusCode
        response.resume = () => {}
        callback(response)
        if (body !== undefined) response.emit('data', Buffer.from(body))
        response.emit('end')
      })
      request.requestedUrl = url
      request.options = options
      return request
    }
  }
}

test('通过内置 HTTPS 获取并规范化完整全年数据', async () => {
  const body = JSON.stringify(payload(2026))
  const client = createHolidayApiClient({ httpsModule: fakeHttps({ body }), timeoutMs: 1234 })
  const result = await client.fetchYear(2026)
  assert.equal(result.year, 2026)
  assert.equal(result.days.length, 365)
  assert.deepEqual(result.days[0], { date: '2026-01-01', isWorkday: true })
  assert.match(result.sourceVersion, /^ailcc:2026:[a-f0-9]{64}$/)
})

test('接受 AILCC 文档定义的四位字符串年份并保持内部年份为数字', async () => {
  const body = JSON.stringify(payload(2026, { year: '2026' }))
  const client = createHolidayApiClient({ httpsModule: fakeHttps({ body }) })
  const result = await client.fetchYear(2026)
  assert.equal(result.year, 2026)
  assert.equal(result.days.length, 365)
})

test('拒绝可被宽松转换但不符合接口契约的年份形式', async () => {
  for (const year of [' 2026', '02026', '2026.0', '+2026', '', null, true]) {
    const invalid = payload(2026, { year })
    const client = createHolidayApiClient({ httpsModule: fakeHttps({ body: JSON.stringify(invalid) }) })
    await assert.rejects(client.fetchYear(2026), /invalid holiday response/)
  }
})

test('拒绝接口非零状态码和响应年份不一致', async () => {
  for (const invalid of [payload(2026, { code: 1 }), payload(2026, { year: 2025 })]) {
    const client = createHolidayApiClient({ httpsModule: fakeHttps({ body: JSON.stringify(invalid) }) })
    await assert.rejects(client.fetchYear(2026), /invalid holiday response/)
  }
})

test('拒绝计数不一致、重复日期、缺失日期和非法休息标记', async () => {
  const cases = []
  const wrongCount = payload(2026)
  wrongCount.count -= 1
  cases.push(wrongCount)
  const duplicate = payload(2026)
  duplicate.data[1].date = duplicate.data[0].date
  cases.push(duplicate)
  const missing = payload(2026)
  missing.data.pop()
  missing.count = missing.data.length
  cases.push(missing)
  const invalidFlag = payload(2026)
  invalidFlag.data[20].is_holiday = true
  cases.push(invalidFlag)
  for (const invalid of cases) {
    const client = createHolidayApiClient({ httpsModule: fakeHttps({ body: JSON.stringify(invalid) }) })
    await assert.rejects(client.fetchYear(2026), /invalid holiday response/)
  }
})

test('拒绝非200响应、过大或非法 JSON 响应', async () => {
  await assert.rejects(
    createHolidayApiClient({ httpsModule: fakeHttps({ statusCode: 503, body: '{}' }) }).fetchYear(2026),
    /status 503/
  )
  await assert.rejects(
    createHolidayApiClient({ httpsModule: fakeHttps({ body: '123456' }), maxResponseBytes: 5 }).fetchYear(2026),
    /too large/
  )
  await assert.rejects(
    createHolidayApiClient({ httpsModule: fakeHttps({ body: '{' }) }).fetchYear(2026),
    /invalid JSON/
  )
})

test('网络错误和明确超时安全失败且不真实访问网络', async () => {
  await assert.rejects(
    createHolidayApiClient({ httpsModule: fakeHttps({ error: new Error('offline') }) }).fetchYear(2026),
    /offline/
  )
  await assert.rejects(
    createHolidayApiClient({ httpsModule: fakeHttps({ timeout: true }), timeoutMs: 25 }).fetchYear(2026),
    /timed out/
  )
})
