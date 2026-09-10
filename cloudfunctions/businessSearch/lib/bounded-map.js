// A per-operation pool, not a process-wide queue. Pull lazily so a failed
// operation stops further dispatch, including validation of later write jobs.
async function mapBounded(items, mapper) {
  const iterator = items[Symbol.iterator]()
  const results = []
  let nextIndex = 0
  let failed = false
  let firstError

  async function worker() {
    while (!failed) {
      try {
        const next = iterator.next()
        if (next.done) return
        const index = nextIndex++
        results[index] = await mapper(next.value, index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
        return
      }
    }
  }

  // Workers capture failures themselves: this barrier drains every started
  // operation before the caller can either publish or report a failure.
  await Promise.all(Array.from({ length: 4 }, () => worker()))
  if (failed) throw firstError
  return results
}

module.exports = { mapBounded }
