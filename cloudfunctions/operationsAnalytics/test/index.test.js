'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOperationsAnalyticsHandler } = require('../index')

test('运营统计入口只信任平台 Timer 来源并忽略事件中的时间和批量', async () => {
  const calls = []
  const now = new Date('2026-08-19T03:00:00.000Z')
  const service = { async runCycle(value) { calls.push(value); return {
    decisionExamined: 1, decisionGenerated: 1, nodeExamined: 2, businessExamined: 1,
    failed: 0, secret: 'hidden'
  } } }
  for (const [context, source] of [[{ OPENID: 'client' }, 'timer'], [{}, 'Timer'], [{ TRIGGER_SRC: 'timer' }, '']]) {
    const handler = createOperationsAnalyticsHandler({ service, getContext: () => context, getTriggerSource: () => source })
    await assert.rejects(handler({ Type: 'Timer' }), error => error.code === 'FORBIDDEN')
  }
  assert.equal(calls.length, 0)
  const handler = createOperationsAnalyticsHandler({ service, getContext: () => ({}), getTriggerSource: () => 'timer', clock: () => now })
  assert.deepEqual(await handler({ now: '2039-01-01', batchSize: 999 }), {
    decisionExamined: 1, nodeExamined: 2, businessExamined: 1, refreshExamined: 0,
    decisionGenerated: 1, nodeGenerated: 0, businessGenerated: 0, refreshed: 0, failed: 0
  })
  assert.deepEqual(calls, [{ now, batchSize: 40 }])
})

test('运营统计失败只返回稳定中文错误且日志不含底层信息', async () => {
  const logs = []
  const handler = createOperationsAnalyticsHandler({
    service: { async runCycle() { throw new Error('secret index business_nodes') } },
    getContext: () => ({}), getTriggerSource: () => 'timer',
    logger: { error(event, detail) { logs.push([event, detail]) } }
  })
  await assert.rejects(handler({}), error => error.code === 'OPERATIONS_ANALYTICS_FAILED' && !/secret|index/i.test(error.message))
  assert.doesNotMatch(JSON.stringify(logs), /secret|index|business_nodes/i)
})

test('field recovery starts only after unchanged timing runCycle and has its own fixed five-second budget', async () => {
  const events = []
  const now = new Date('2026-09-11T03:00:00.000Z')
  let timingFinished = false
  const handler = createOperationsAnalyticsHandler({
    service: { async runCycle(input) {
      events.push(['timing', input]); await Promise.resolve(); timingFinished = true
      return { nodeGenerated: 7, failed: 2 }
    } },
    fieldRecovery: { async runCycle(input) {
      assert.equal(timingFinished, true)
      events.push(['fields', input]); return { examined: 40, generated: 12, failed: 1, hasMore: true, private: 'omit' }
    } },
    getTriggerSource: () => 'timer', clock: () => now
  })
  const result = await handler({ batchSize: 999, timeBudgetMs: 999999 })
  assert.deepEqual(events, [['timing', { now, batchSize: 40 }], ['fields', { batchSize: 40, timeBudgetMs: 5000 }]])
  assert.equal(result.nodeGenerated, 7); assert.equal(result.failed, 2)
  assert.deepEqual([result.fieldExamined, result.fieldGenerated, result.fieldFailed, result.fieldHasMore], [40, 12, 1, true])
  assert.equal(Object.hasOwn(result, 'private'), false)
})

test('field-stage failure preserves completed timing counts and emits no private error detail', async () => {
  const logs = []
  const handler = createOperationsAnalyticsHandler({
    service: { async runCycle() { return { nodeGenerated: 3, refreshed: 2, failed: 4 } } },
    fieldRecovery: { async runCycle() { throw new Error('private customer value or missing collection') } },
    getTriggerSource: () => 'timer', logger: { error(...args) { logs.push(args) } }
  })
  const result = await handler()
  assert.equal(result.nodeGenerated, 3); assert.equal(result.refreshed, 2); assert.equal(result.failed, 4)
  assert.deepEqual([result.fieldExamined, result.fieldGenerated, result.fieldFailed, result.fieldHasMore], [0, 0, 1, true])
  assert.doesNotMatch(JSON.stringify([result, logs]), /private|customer|collection/)
})

test('unauthorized calls and a failed timing stage cannot invoke field recovery', async () => {
  let calls = 0
  const fieldRecovery = { async runCycle() { calls++; return {} } }
  for (const [source, context] of [['', {}], ['Timer', {}], ['timer', { OPENID: 'synthetic-client' }]]) {
    const handler = createOperationsAnalyticsHandler({ service: { async runCycle() { throw new Error('must not run') } },
      fieldRecovery, getTriggerSource: () => source, getContext: () => context })
    await assert.rejects(handler(), { code: 'FORBIDDEN' })
  }
  const failing = createOperationsAnalyticsHandler({ service: { async runCycle() { throw new Error('timing failure') } },
    fieldRecovery, getTriggerSource: () => 'timer', logger: { error() {} } })
  await assert.rejects(failing(), { code: 'OPERATIONS_ANALYTICS_FAILED' })
  assert.equal(calls, 0)
})

test('default SDK assembly performs real selection recovery using only the injected database boundary', async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const vm = require('node:vm')
  const { createFakeCloudDatabase } = require('../../businessApi/test/helpers/fake-cloud-database')
  const { fieldSource } = require('../../businessApi/test/helpers/field-fixtures')
  const source = fieldSource({ node: { analyticsSnapshotStatus: 'generated' } })
  const fake = createFakeCloudDatabase({ business_lines: [source.line], business_nodes: [source.node],
    node_feedback: [source.feedback], node_review_rounds: [], node_review_votes: [], system_settings: [],
    operations_analytics_facts: [], operations_analytics_daily: [], operations_field_snapshots: [] }, { rejectExplicitIdOnSet: true })
  const entry = { exports: {} }
  const sdk = { init() {}, DYNAMIC_CURRENT_ENV: 'synthetic-environment', database: () => fake.db, getWXContext: () => ({}) }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), {
    exports: entry.exports, module: entry, Date, console,
    process: { env: { TRIGGER_SRC: 'timer' } },
    require(name) { return name === 'wx-server-sdk' ? sdk : require(path.join(__dirname, '..', name)) }
  })
  const result = await entry.exports.main()
  assert.equal(result.nodeGenerated, 0)
  assert.equal(result.fieldGenerated, 1)
  assert.equal(fake.documents('operations_field_snapshots')[0].sourceHeader,
    require('../../businessApi/lib/operations-field-domain').fieldSourceHeader(source))
})
