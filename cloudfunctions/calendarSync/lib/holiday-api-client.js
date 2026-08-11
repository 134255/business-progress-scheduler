'use strict'

const crypto = require('node:crypto')
const https = require('node:https')

const BASE_URL = 'https://holiday.ailcc.com/api/holiday/allyear/'

function expectedDates(year) {
  const dates = []
  for (let at = Date.UTC(year, 0, 1); new Date(at).getUTCFullYear() === year; at += 86400000) {
    dates.push(new Date(at).toISOString().slice(0, 10))
  }
  return dates
}

function invalidResponse() {
  return new Error('invalid holiday response')
}

function normalizePayload(payload, requestedYear) {
  if (!payload || typeof payload !== 'object' || payload.code !== 0 || payload.year !== requestedYear ||
      !Number.isSafeInteger(payload.count) || !Array.isArray(payload.data) || payload.count !== payload.data.length) {
    throw invalidResponse()
  }
  const expected = expectedDates(requestedYear)
  if (payload.data.length !== expected.length) throw invalidResponse()
  const byDate = new Map()
  for (const row of payload.data) {
    if (!row || typeof row !== 'object' || typeof row.date !== 'string' ||
        (row.is_holiday !== 0 && row.is_holiday !== 1) || byDate.has(row.date)) {
      throw invalidResponse()
    }
    byDate.set(row.date, row.is_holiday)
  }
  const days = expected.map(date => {
    if (!byDate.has(date)) throw invalidResponse()
    return { date, isWorkday: byDate.get(date) === 0 }
  })
  const digestInput = expected.map(date => `${date}:${byDate.get(date)}`).join('\n')
  return {
    year: requestedYear,
    days,
    sourceVersion: `ailcc:${requestedYear}:${crypto.createHash('sha256').update(digestInput).digest('hex')}`
  }
}

function createHolidayApiClient({
  httpsModule = https,
  timeoutMs = 5000,
  maxResponseBytes = 2 * 1024 * 1024
} = {}) {
  if (!httpsModule || typeof httpsModule.get !== 'function') throw new TypeError('httpsModule.get is required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive')
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError('maxResponseBytes must be positive')
  }

  async function fetchYear(year) {
    if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) throw new TypeError('year is invalid')
    const body = await new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        callback(value)
      }
      const request = httpsModule.get(`${BASE_URL}${year}`, {
        headers: { accept: 'application/json', 'user-agent': 'business-calendar-sync/1.0' }
      }, response => {
        if (response.statusCode !== 200) {
          if (typeof response.resume === 'function') response.resume()
          finish(reject, new Error(`holiday API status ${response.statusCode}`))
          return
        }
        const chunks = []
        let size = 0
        response.on('data', chunk => {
          if (settled) return
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > maxResponseBytes) {
            finish(reject, new Error('holiday API response too large'))
            if (typeof request.destroy === 'function') request.destroy()
            return
          }
          chunks.push(buffer)
        })
        response.on('error', error => finish(reject, error))
        response.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')))
      })
      request.on('error', error => finish(reject, error))
      request.setTimeout(timeoutMs, () => {
        const error = new Error(`holiday API timed out after ${timeoutMs}ms`)
        finish(reject, error)
        if (typeof request.destroy === 'function') request.destroy(error)
      })
    })
    let payload
    try {
      payload = JSON.parse(body)
    } catch (error) {
      throw new Error('holiday API returned invalid JSON')
    }
    return normalizePayload(payload, year)
  }

  return { fetchYear }
}

module.exports = { createHolidayApiClient, normalizePayload }
