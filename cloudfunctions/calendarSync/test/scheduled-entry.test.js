'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCalendarSyncHandler } = require('../index')

test('入口接受 scheduled 或 manual 且把 now 规范化为日期', async () => {
  const calls = []
  const handler = createCalendarSyncHandler({ service: {
    async run(input) { calls.push(input); return { ok: true } }
  } })
  assert.deepEqual(await handler({ mode: 'manual', now: '2026-08-11T00:00:00.000Z' }), { ok: true })
  assert.equal(calls[0].mode, 'manual')
  assert.equal(calls[0].now.toISOString(), '2026-08-11T00:00:00.000Z')
  await assert.rejects(handler({ mode: 'other' }), /mode/)
})
