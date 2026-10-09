const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const crypto = require('node:crypto')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')
const SECRET = 'synthetic-runtime-secret-for-tests-12345678'

// Execute the actual cloud entry, substituting only external SDK/service work
// and a deterministic clock. No production-only test hooks or cloud requests.
function fixture(options = {}) {
  let now = 0, failedLoad = false, failedBootstrap = false
  const logs = [], calls = []
  const result = { indexStatus: 'generated', privateValue: 'synthetic-private-result' }
  const sink = options.logger || { info: (...args) => logs.push(args), error() {} }
  function maybeFail(stage) {
    if (options.failStage === stage && !failedBootstrap) {
      failedBootstrap = true; throw options.bootstrapError
    }
  }
  const service = {
    async indexRequest({ token }) {
      calls.push(['index', token]); now += 19
      if (options.execute) return options.execute(token, result)
      return result
    },
    async queryRequest() { calls.push(['query']); return result },
    async runCycle() { calls.push(['cycle']); return {} }
  }
  function load(file) {
    const filename = path.resolve(__dirname, '..', file)
    const nativeRequire = createRequire(filename)
    const module = { exports: {} }
    const customRequire = name => {
      if (name === 'node:perf_hooks') return { performance: { now() {
        if (options.clockThrows) throw new Error('clock down')
        if (options.clockRejects) return Promise.reject(new Error('clock down'))
        return options.invalidClock ? NaN : now * (options.timeScale || 1)
      } } }
      if (name === 'wx-server-sdk') {
        calls.push(['sdk_load']); now += 11
        if (options.loadError && !failedLoad) { failedLoad = true; throw options.loadError }
        return { DYNAMIC_CURRENT_ENV: 'synthetic-env',
          init(input) { assert.equal(input.env, 'synthetic-env'); calls.push(['sdk_init']); now += 5; maybeFail('sdk_init') },
          database() { calls.push(['database']); now += 7; maybeFail('database_create'); return options.db || {} }, getWXContext: () => ({}) }
      }
      if (name === './lib/search-service') return { createSearchService(args) {
        calls.push(['service_create']); now += 3
        return options.realService ? nativeRequire(name).createSearchService({ ...args, logger: sink }) : service
      } }
      if (name === './lib/cloud-search-repository') return { createCloudSearchRepository(args) {
        calls.push(['repository_create']); now += 2; maybeFail('handler_create')
        return options.realService ? nativeRequire(name).createCloudSearchRepository(args) : {}
      } }
      if (name === './lib/runtime-timing') return load('lib/runtime-timing.js')
      return nativeRequire(name)
    }
    vm.runInNewContext('(function(require,module,exports,process,console){' + fs.readFileSync(filename, 'utf8') + '\n})',
      {}, { filename })(customRequire, module, module.exports,
      { env: { BUSINESS_SEARCH_HMAC_SECRET: SECRET, TRIGGER_SRC: options.triggerSource || '' } }, sink)
    return module.exports
  }
  return { main: load('index.js').main, logs, calls, result }
}

const event = { operation: 'index', ticket: 'synthetic-private-ticket',
  handlerReused: true, durationMs: 999999, payload: 'synthetic-private-payload' }
const plain = value => JSON.parse(JSON.stringify(value))

test('entry diagnostics include SDK load/init/database/assembly and execution once, then identify reuse', async () => {
  const h = fixture()
  assert.equal(await h.main(event), h.result)
  assert.equal(h.logs.length, 1, 'entry timing summary is missing')
  const [tag, first] = plain(h.logs[0])
  assert.equal(tag, '[businessSearch.runtimeTiming]')
  assert.deepEqual(first, { schemaVersion: 1, action: 'index', handlerReused: false, outcome: 'OK', durationMs: 47,
    stages: { sdk_load: { durationMs: 11, failed: false }, sdk_init: { durationMs: 5, failed: false },
      database_create: { durationMs: 7, failed: false }, handler_create: { durationMs: 5, failed: false },
      handler_execute: { durationMs: 19, failed: false } } })
  assert.equal(await h.main(event), h.result)
  assert.deepEqual(plain(h.logs[1][1]), { schemaVersion: 1, action: 'index', handlerReused: true,
    outcome: 'OK', durationMs: 19, stages: { handler_execute: { durationMs: 19, failed: false } } })
  assert.equal(h.calls.filter(([name]) => name === 'sdk_load').length, 1)
  assert.equal(h.calls.filter(([name]) => name === 'index').length, 2)
  assert.equal(JSON.stringify(h.logs).includes('synthetic-'), false)
})

test('actual exported entry still consumes one ticket and publishes a full generation with both timing summaries', async () => {
  const now = new Date()
  const id = crypto.createHmac('sha256', SECRET).update(event.ticket).digest('hex')
  const search = { searchSourceVersion: 1, searchGeneratedVersion: 0, searchIndexStatus: 'pending' }
  const fake = createFakeCloudDatabase({
    business_lines: [{ _id: 'synthetic-line', code: 'SYNTHETIC-CODE', name: 'synthetic-name', description: '',
      status: 'active', nodeCount: 1, ...search }],
    business_nodes: [{ _id: 'synthetic-node', businessLineId: 'synthetic-line', sequence: 0,
      name: 'synthetic-node-name', nodeCode: 'SYNTHETIC-NODE', status: 'ready', processingRoundNumber: 1, ...search }],
    business_search_requests: [{ _id: id, operation: 'index', actorId: 'synthetic-actor', businessLineId: 'synthetic-line',
      sourceVersion: 1, status: 'pending', createdAt: now, expiresAt: new Date(now.getTime() + 60000) }]
  })
  const h = fixture({ db: fake.db, realService: true })
  assert.deepEqual(await h.main(event), { businessLineId: 'synthetic-line', sourceVersion: 1, indexStatus: 'generated' })
  assert.equal(fake.documents('business_lines')[0].searchIndexStatus, 'generated')
  assert.equal(fake.documents('business_search_requests')[0].status, 'consumed')
  assert(fake.documents('business_search_documents').length > 0)
  assert.deepEqual(h.logs.map(([tag]) => tag), ['[businessSearch.indexTiming]', '[businessSearch.runtimeTiming]'])
  assert.equal(h.logs[1][1].handlerReused, false)
  assert.equal(JSON.stringify(h.logs).includes('synthetic-'), false)
  assert.equal(JSON.stringify(h.logs).includes(id), false)
  assert.equal(JSON.stringify(h.logs).includes(SECRET), false)
})

test('failed bootstrap preserves original error, logs only failed stage, and retries bootstrap on next request', async () => {
  const failure = new Error('synthetic-private-error')
  const h = fixture({ loadError: failure })
  await assert.rejects(h.main(event), error => error === failure)
  assert.equal(h.logs.length, 1)
  assert.deepEqual(plain(h.logs[0][1]), { schemaVersion: 1, action: 'index', handlerReused: false,
    outcome: 'ERROR', durationMs: 11, stages: { sdk_load: { durationMs: 11, failed: true } } })
  assert.equal(await h.main(event), h.result)
  assert.equal(h.logs[1][1].handlerReused, false)
  assert.equal(JSON.stringify(h.logs).includes('synthetic-'), false)
})

for (const phase of ['sdk_init', 'database_create', 'handler_create']) {
  test(`failed ${phase} never caches a partial handler or skips initialization on retry`, async () => {
    const error = new Error('synthetic-private-bootstrap')
    const h = fixture({ failStage: phase, bootstrapError: error })
    await assert.rejects(h.main(event), value => value === error)
    assert.equal(h.logs[0][1].stages[phase].failed, true)
    assert.equal(h.logs[0][1].stages.handler_execute, undefined)
    assert.equal(await h.main(event), h.result)
    assert.equal(h.logs[1][1].handlerReused, false)
    assert.equal(h.calls.filter(([name]) => name === 'index').length, 1)
    assert.equal(JSON.stringify(h.logs).includes('synthetic-'), false)
  })
}

test('execution error preserves original authorization rejection and keeps initialized handler reusable', async () => {
  const failure = Object.assign(new Error('synthetic-private-denied'), { code: 'FORBIDDEN' })
  const h = fixture({ execute: () => { throw failure } })
  await assert.rejects(h.main(event), error => error === failure)
  await assert.rejects(h.main(event), error => error === failure)
  assert.equal(h.logs.length, 2)
  assert.equal(h.logs[0][1].outcome, 'ERROR')
  assert.equal(h.logs[0][1].stages.handler_execute.failed, true)
  assert.equal(h.logs[1][1].handlerReused, true)
  assert.equal(JSON.stringify(h.logs).includes('synthetic-'), false)
})

test('query or rejected ordinary invocation retains routing and does not emit index runtime logs', async () => {
  const h = fixture()
  assert.equal(await h.main({ operation: 'query', ticket: 'synthetic-query' }), h.result)
  await assert.rejects(h.main({}), { code: 'FORBIDDEN' })
  assert.equal(h.logs.length, 0)
  assert.equal(await h.main(event), h.result)
  assert.equal(h.logs.length, 1)
  assert.equal(h.logs[0][1].handlerReused, true)
  assert.equal(h.logs[0][1].stages.sdk_load, undefined)
})

test('trusted Timer through the actual entry keeps cycle routing and emits no index runtime log', async () => {
  const h = fixture({ triggerSource: 'timer' })
  assert.deepEqual(plain(await h.main({ Type: 'Timer', durationMs: 9999 })),
    { examined: 0, generated: 0, failed: 0, cleaned: 0 })
  assert.equal(h.calls.filter(([name]) => name === 'cycle').length, 1)
  assert.equal(h.logs.length, 0)
  assert.equal(await h.main(event), h.result)
  assert.equal(h.logs[0][1].handlerReused, true)
})

test('trusted Timer with an index label but no valid ticket is not classified as an index request', async () => {
  const h = fixture({ triggerSource: 'timer' })
  for (const ticket of [undefined, '', 123]) {
    assert.deepEqual(plain(await h.main({ operation: 'index', ticket })),
      { examined: 0, generated: 0, failed: 0, cleaned: 0 })
  }
  assert.equal(h.calls.filter(([name]) => name === 'cycle').length, 3)
  assert.equal(h.logs.length, 0)
  assert.equal(await h.main(event), h.result)
  assert.equal(h.logs[0][1].handlerReused, true)
})

test('concurrent reused requests have isolated outcomes and do not serialize business execution', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const failure = Object.assign(new Error('synthetic-denied'), { code: 'FORBIDDEN' })
  const h = fixture({ execute: (token, result) => token === 'slow' ? pending : token === 'bad' ? Promise.reject(failure) : result })
  await h.main(event)
  const first = h.main({ operation: 'index', ticket: 'slow' })
  await assert.rejects(h.main({ operation: 'index', ticket: 'bad' }), error => error === failure)
  release(h.result)
  assert.equal(await first, h.result)
  assert.equal(h.logs.length, 3)
  assert.deepEqual(h.logs.map(([, value]) => value.outcome), ['OK', 'ERROR', 'OK'])
  assert.notEqual(h.logs[1][1].stages, h.logs[2][1].stages)
})

test('unavailable clocks stay unknown rather than fabricated zero and do not prevent execution', async () => {
  for (const options of [{ invalidClock: true }, { clockThrows: true }]) {
    const h = fixture(options)
    assert.equal(await h.main(event), h.result)
    assert.equal(h.logs.length, 1)
    assert.equal(h.logs[0][1].durationMs, null)
    assert(Object.values(h.logs[0][1].stages).every(stage => stage.durationMs === null))
  }
})

test('rejecting asynchronous clocks are ignored without unhandled rejections or changing results', async () => {
  const h = fixture({ clockRejects: true })
  assert.equal(await h.main(event), h.result)
  assert.equal(h.logs[0][1].durationMs, null)
  assert(Object.values(h.logs[0][1].stages).every(stage => stage.durationMs === null))
  await new Promise(resolve => setImmediate(resolve))
})

test('diagnostics cap extreme elapsed times without logging event-supplied metadata', async () => {
  const h = fixture({ timeScale: 1000000 })
  await h.main(event)
  assert.equal(h.logs[0][1].durationMs, 3600000)
  assert(Object.values(h.logs[0][1].stages).every(stage => stage.durationMs === 3600000))
  assert.equal(h.logs[0][1].handlerReused, false)
})

test('diagnostic event inspection does not invoke operation getters or change routing access count', async () => {
  const h = fixture()
  let reads = 0
  const request = { ticket: 'synthetic-private-ticket' }
  Object.defineProperty(request, 'operation', { get() { reads++; return 'index' } })
  assert.equal(await h.main(request), h.result)
  assert.equal(reads, 2, 'only the original handler may evaluate the operation accessor')
  assert.equal(h.logs.length, 0)
})

test('throwing, rejecting, or never-settling log sink never replaces or delays results/errors', async () => {
  for (const logger of [{ info() { throw new Error('sink down') } },
    { info() { return Promise.reject(new Error('sink down')) } },
    { info() { return new Promise(() => {}) } },
    Object.defineProperty({}, 'info', { get() { throw new Error('getter down') } })]) {
    const h = fixture({ logger })
    assert.equal(await h.main(event), h.result)
    const error = Object.assign(new Error('synthetic-private-denied'), { code: 'FORBIDDEN' })
    const bad = fixture({ logger, execute: () => { throw error } })
    await assert.rejects(bad.main(event), value => value === error)
  }
  await new Promise(resolve => setImmediate(resolve))
})
