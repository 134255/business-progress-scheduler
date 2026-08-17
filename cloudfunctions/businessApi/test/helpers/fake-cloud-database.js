function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createFakeCloudDatabase(seed = {}, options = {}) {
  const removeValue = { __remove: true }
  const state = {}
  const transactionQueries = []
  const queryCalls = []
  const writeCalls = []
  const transactionRuns = []
  const beforeTransactionHooks = []
  const pendingWriteFailures = []
  const metrics = { activeCallbacks: 0, maxActiveCallbacks: 0, conflicts: 0, retries: 0 }
  let serverDateSequence = 0
  let stateVersion = 0
  let commitQueue = Promise.resolve()

  function readClone(name, document) {
    const value = clone(document)
    return typeof options.transformRead === 'function'
      ? options.transformRead({ collection: name, data: value }) || value
      : value
  }

  for (const [name, documents] of Object.entries(seed)) {
    state[name] = new Map(documents.map(document => [document._id, clone(document)]))
  }

  function documents(name, targetState = state) {
    if (!targetState[name]) targetState[name] = new Map()
    return targetState[name]
  }

  function materialize(data, id) {
    const stored = { _id: id }
    for (const [key, value] of Object.entries(data || {})) {
      if (value && value.__remove) continue
      stored[key] = clone(value)
    }
    return stored
  }

  function merge(current, changes) {
    const next = clone(current)
    for (const [key, value] of Object.entries(changes || {})) {
      if (value && value.__remove) delete next[key]
      else next[key] = clone(value)
    }
    return next
  }

  function duplicateError(indexName) {
    const error = new Error(`duplicate key error: ${indexName}`)
    error.errCode = -502005
    return error
  }

  function enforceUserIndexes(candidate, id, targetState) {
    for (const user of documents('users', targetState).values()) {
      if (user._id === id) continue
      if (candidate.usernameNormalized && user.usernameNormalized === candidate.usernameNormalized) {
        throw duplicateError('username_normalized_unique')
      }
    }
  }

  function enforceBusinessIndexes(name, candidate, id, targetState) {
    const uniqueField = name === 'business_lines'
      ? 'code'
      : name === 'business_nodes'
        ? 'nodeCode'
        : null
    if (!uniqueField || !candidate[uniqueField]) return
    for (const document of documents(name, targetState).values()) {
      if (document._id !== id && document[uniqueField] === candidate[uniqueField]) {
        throw duplicateError(`${name}_${uniqueField}_unique`)
      }
    }
  }

  function maybeFailWrite(name, operation) {
    const index = pendingWriteFailures.findIndex(failure =>
      failure.collection === name && failure.operation === operation)
    if (index < 0) return
    const [failure] = pendingWriteFailures.splice(index, 1)
    throw failure.error
  }

  function createDocument(name, id, transactionRecord = null, targetState = state) {
    function countOperation() {
      if (transactionRecord) transactionRecord.operations += 1
    }
    return {
      async get() {
        countOperation()
        const document = documents(name, targetState).get(id)
        if (!document) {
          throw new Error(`document.get:fail document with _id ${id} does not exist`)
        }
        return { data: readClone(name, document) }
      },
      async set({ data }) {
        countOperation()
        if (transactionRecord) {
          transactionRecord.writes += 1
          transactionRecord.writeDetails.push({ collection: name, id, operation: 'set', data: clone(data) })
        }
        maybeFailWrite(name, 'set')
        const stored = materialize(data, id)
        if (name === 'users') enforceUserIndexes(stored, id, targetState)
        enforceBusinessIndexes(name, stored, id, targetState)
        if (name === 'wechat_bindings') {
          const current = documents(name, targetState).get(id)
          if (current && current.userId !== stored.userId) throw duplicateError('wechat_binding_primary')
        }
        documents(name, targetState).set(id, stored)
        if (!transactionRecord) writeCalls.push({ collection: name, id, operation: 'set', data: clone(data) })
        if (targetState === state) stateVersion += 1
        return { stats: { created: 1, updated: 0 } }
      },
      async update({ data }) {
        countOperation()
        if (transactionRecord) {
          transactionRecord.writes += 1
          transactionRecord.writeDetails.push({ collection: name, id, operation: 'update', data: clone(data) })
        }
        maybeFailWrite(name, 'update')
        const current = documents(name, targetState).get(id)
        if (!current) return { stats: { updated: 0 } }
        const updated = merge(current, data)
        if (name === 'users') enforceUserIndexes(updated, id, targetState)
        enforceBusinessIndexes(name, updated, id, targetState)
        documents(name, targetState).set(id, updated)
        if (!transactionRecord) writeCalls.push({ collection: name, id, operation: 'update', data: clone(data) })
        if (targetState === state) stateVersion += 1
        return { stats: { updated: 1 } }
      },
      async remove() {
        countOperation()
        if (transactionRecord) {
          transactionRecord.writes += 1
          transactionRecord.writeDetails.push({ collection: name, id, operation: 'remove' })
        }
        maybeFailWrite(name, 'remove')
        const removed = documents(name, targetState).delete(id)
        if (removed && !transactionRecord) writeCalls.push({ collection: name, id, operation: 'remove' })
        if (removed && targetState === state) stateVersion += 1
        return { stats: { removed: removed ? 1 : 0 } }
      }
    }
  }

  function matches(document, criteria) {
    return Object.entries(criteria || {}).every(([key, value]) => {
      if (value && value.__operator === 'and') return value.values.every(entry => matches(document, { [key]: entry }))
      if (value && value.__operator === 'eq') return document[key] === value.value ||
        document[key] instanceof Date && value.value instanceof Date && document[key].getTime() === value.value.getTime()
      if (value && value.__operator === 'gt') return String(document[key] || '') > String(value.value)
      if (value && value.__operator === 'gte') return document[key] !== undefined && document[key] >= value.value
      if (value && value.__operator === 'lt') return document[key] !== undefined && document[key] < value.value
      if (value && value.__operator === 'lte') return document[key] !== undefined && document[key] <= value.value
      if (value && value.__operator === 'in') return Array.isArray(value.values) && value.values.includes(document[key])
      return Array.isArray(document[key]) ? document[key].includes(value) : document[key] === value
    })
  }

  function createQuery(name, transaction, criteria = null, order = [], offset = 0, maximum = 100,
    targetState = state) {
    function rejectTransactionQuery(operation) {
      if (!transaction) return
      transactionQueries.push({ collection: name, operation })
      throw new Error(`transaction query forbidden: ${name}.${operation}`)
    }

    return {
      doc(id) {
        return createDocument(name, id, transaction && typeof transaction === 'object' ? transaction : null,
          targetState)
      },
      where(nextCriteria) {
        rejectTransactionQuery('where')
        return createQuery(name, transaction, nextCriteria, order, offset, maximum, targetState)
      },
      orderBy(field, direction) {
        rejectTransactionQuery('orderBy')
        return createQuery(name, transaction, criteria, [...order, [field, direction]], offset, maximum,
          targetState)
      },
      skip(nextOffset) {
        rejectTransactionQuery('skip')
        return createQuery(name, transaction, criteria, order, nextOffset, maximum, targetState)
      },
      limit(nextMaximum) {
        rejectTransactionQuery('limit')
        return createQuery(name, transaction, criteria, order, offset, nextMaximum, targetState)
      },
      async get() {
        rejectTransactionQuery('get')
        queryCalls.push({ collection: name, criteria: clone(criteria), order: clone(order), limit: maximum })
        let result = [...documents(name, targetState).values()].filter(document => matches(document, criteria))
        for (const [field, direction] of order.slice().reverse()) {
          result.sort((left, right) => {
            const comparison = String(left[field] || '').localeCompare(String(right[field] || ''))
            return direction === 'desc' ? -comparison : comparison
          })
        }
        return { data: result.slice(offset, offset + maximum).map(document => readClone(name, document)) }
      },
      async count() {
        rejectTransactionQuery('count')
        return { total: [...documents(name, targetState).values()].filter(document =>
          matches(document, criteria)).length }
      },
      async add({ data }) {
        rejectTransactionQuery('add')
        const id = `generated-${documents(name, targetState).size + 1}`
        await createDocument(name, id, null, targetState).set({ data })
        return { _id: id }
      }
    }
  }

  function snapshot(source = state) {
    const result = {}
    for (const [name, collection] of Object.entries(source)) {
      result[name] = new Map([...collection.entries()].map(([id, document]) => [id, clone(document)]))
    }
    return result
  }

  function restore(saved) {
    for (const name of Object.keys(state)) delete state[name]
    for (const [name, collection] of Object.entries(saved)) {
      state[name] = new Map([...collection.entries()].map(([id, document]) => [id, clone(document)]))
    }
  }

  async function withCommitLock(callback) {
    const previous = commitQueue
    let release
    commitQueue = new Promise(resolve => { release = resolve })
    await previous
    try {
      return callback()
    } finally {
      release()
    }
  }

  const db = {
    command: {
      remove: () => removeValue,
      and: (...values) => ({ __operator: 'and', values }),
      eq: value => ({ __operator: 'eq', value }),
      gt: value => ({ __operator: 'gt', value }),
      gte: value => ({ __operator: 'gte', value }),
      lt: value => ({ __operator: 'lt', value }),
      lte: value => ({ __operator: 'lte', value }),
      in: values => ({ __operator: 'in', values })
    },
    collection(name) {
      return createQuery(name, false)
    },
    serverDate() {
      serverDateSequence += 1
      return { __serverDate: serverDateSequence }
    },
    async runTransaction(callback) {
      const hook = beforeTransactionHooks.shift()
      if (hook) await hook()
      const record = { callbacks: 0, operations: 0, conflicts: 0 }
      transactionRuns.push(record)
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const baseVersion = stateVersion
        const localState = snapshot()
        const attemptRecord = { operations: 0, writes: 0, writeDetails: [] }
        record.callbacks += 1
        metrics.activeCallbacks += 1
        metrics.maxActiveCallbacks = Math.max(metrics.maxActiveCallbacks, metrics.activeCallbacks)
        let result
        try {
          result = await callback({
            collection(name) {
              return createQuery(name, attemptRecord, null, [], 0, 100, localState)
            }
          })
        } catch (error) {
          record.operations = Math.max(record.operations, attemptRecord.operations)
          if (options.afterTransactionError) {
            await options.afterTransactionError({ error, record: clone(record) })
          }
          throw error
        } finally {
          metrics.activeCallbacks -= 1
        }
        record.operations = Math.max(record.operations, attemptRecord.operations)
        const committed = await withCommitLock(() => {
          if (stateVersion !== baseVersion) return false
          if (attemptRecord.writes > 0) {
            restore(localState)
            stateVersion += 1
          }
          return true
        })
        if (!committed) {
          record.conflicts += 1
          metrics.conflicts += 1
          metrics.retries += 1
          continue
        }
        writeCalls.push(...attemptRecord.writeDetails)
        if (options.afterTransaction) {
          await options.afterTransaction({ result: clone(result), record: clone(record) })
        }
        return result
      }
      const error = new Error('transaction conflict retry exhausted')
      error.code = 'TRANSACTION_CONFLICT'
      if (options.afterTransactionError) {
        await options.afterTransactionError({ error, record: clone(record) })
      }
      throw error
    }
  }

  return {
    db,
    state,
    transactionQueries,
    queryCalls,
    writeCalls,
    transactionRuns,
    metrics,
    documents(name) {
      return [...documents(name).values()].map(clone)
    },
    replace(name, id, document) {
      documents(name).set(id, { _id: id, ...clone(document) })
      stateVersion += 1
    },
    beforeNextTransaction(hook) {
      beforeTransactionHooks.push(hook)
    },
    failNextWrite(failure) {
      pendingWriteFailures.push(failure)
    }
  }
}

module.exports = { createFakeCloudDatabase }
