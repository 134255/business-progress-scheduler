// Keep output order without unbounded fan-out. On failure, stop taking queued
// items and drain already-started mappers before propagating the first error.
async function boundedMap(items, mapper, concurrency = 4) {
  if (!Array.isArray(items) || typeof mapper !== 'function' ||
      !Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('boundedMap requires an array, a mapper and a positive integer concurrency')
  }
  const results = new Array(items.length)
  let next = 0
  let failed = false
  let firstError
  // Cooperative read boundary only: never abort already-started I/O or skip
  // necessary steps inside a transaction. Each map call owns its own signal.
  const signal = Object.freeze({
    throwIfStopped() {
      if (failed) throw firstError
    }
  })
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await mapper(items[index], index, signal)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  if (failed) throw firstError
  return results
}

module.exports = { boundedMap }
