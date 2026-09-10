const test = require('node:test')
const assert = require('node:assert/strict')

function mapper() {
  let exported
  try { exported = require('../lib/bounded-map') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  assert.equal(typeof (exported && exported.boundedMap), 'function', 'boundedMap must be implemented')
  return exported.boundedMap
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const turn = () => new Promise(resolve => setImmediate(resolve))

test('boundedMap overlaps at most four tasks and preserves input order under reverse completion', async () => {
  const boundedMap = mapper()
  const gates = Array.from({ length: 9 }, deferred)
  const started = []
  const result = boundedMap(gates, async (gate, index) => {
    started.push(index)
    await gate.promise
    return index * 10
  })
  await turn()
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[3].resolve()
  await turn()
  assert.deepEqual(started, [0, 1, 2, 3, 4])
  for (const gate of gates.slice().reverse()) gate.resolve()
  assert.deepEqual(await result, [0, 10, 20, 30, 40, 50, 60, 70, 80])
})

test('boundedMap stops dispatch on first rejection and drains all in-flight tasks before rejecting', async () => {
  const boundedMap = mapper()
  const gates = Array.from({ length: 8 }, deferred)
  const started = []
  const firstError = new Error('first read failed')
  let settled = false
  const result = boundedMap(gates, async (gate, index) => {
    started.push(index)
    return gate.promise
  }).then(() => { settled = true }, error => { settled = true; return error })
  await turn()
  gates[1].reject(firstError)
  await turn()
  assert.equal(settled, false)
  gates[0].resolve()
  gates[2].reject(new Error('second read failed'))
  await turn()
  assert.equal(settled, false)
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[3].resolve()
  assert.equal(await result, firstError)
  assert.deepEqual(started, [0, 1, 2, 3])
})

test('boundedMap stops immediately on synchronous throws, including falsy rejection reasons', async () => {
  const boundedMap = mapper()
  for (const reason of [new Error('sync'), undefined, null, 0]) {
    const started = []
    let rejected = false
    await boundedMap([0, 1, 2, 3, 4], value => {
      started.push(value)
      throw reason
    }).then(() => assert.fail('must reject'), error => {
      rejected = true
      assert.equal(error, reason)
    })
    assert.equal(rejected, true)
    assert.deepEqual(started, [0])
  }
})

test('boundedMap lets in-flight readers stop their next I/O while draining and preserving even a falsy first error', async () => {
  const boundedMap = mapper()
  for (const failure of [new Error('first page failed'), undefined, null, 0]) {
    const gates = Array.from({ length: 4 }, deferred)
    const nextReads = []
    let settled = false
    const result = boundedMap([0, 1, 2, 3, 4], async (value, index, signal) => {
      await gates[index].promise
      signal?.throwIfStopped()
      nextReads.push(value)
    }).then(() => assert.fail('must reject'), error => { settled = true; return error })
    gates[0].reject(failure)
    await turn()
    assert.equal(settled, false)
    // A separate operation must not inherit the stopped operation's signal.
    assert.deepEqual(await boundedMap([7], (value, index, signal) => {
      signal?.throwIfStopped()
      return value
    }), [7])
    gates[1].resolve()
    gates[2].reject(new Error('later failure'))
    await turn()
    assert.equal(settled, false)
    gates[3].resolve()
    assert.equal(await result, failure)
    assert.deepEqual(nextReads, [], 'stopped in-flight readers must not start their next I/O')
  }
})

test('boundedMap handles empty input and explicit smaller concurrency without invoking extra work', async () => {
  const boundedMap = mapper()
  assert.deepEqual(await boundedMap([], () => assert.fail('empty input')), [])
  const gates = [deferred(), deferred(), deferred()]
  const started = []
  const result = boundedMap(gates, async (gate, index) => {
    started.push(index)
    await gate.promise
    return index
  }, 1)
  await turn()
  assert.deepEqual(started, [0])
  gates.forEach(gate => gate.resolve())
  assert.deepEqual(await result, [0, 1, 2])
})

test('boundedMap rejects invalid inputs before starting mapper tasks', async () => {
  const boundedMap = mapper()
  for (const concurrency of [0, -1, 1.5, Infinity, '4']) {
    await assert.rejects(boundedMap([1], () => assert.fail('invalid concurrency'), concurrency), TypeError)
  }
  await assert.rejects(boundedMap(null, () => {}), TypeError)
  await assert.rejects(boundedMap([1], null), TypeError)
})
