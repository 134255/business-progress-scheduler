function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function createFakeCloudDatabase(seed = {}) {
  const removeValue = { __remove: true }
  const state = {}
  const transactionQueries = []
  const transactionRuns = []
  const beforeTransactionHooks = []
  let serverDateSequence = 0
  let transactionQueue = Promise.resolve()

  for (const [name, documents] of Object.entries(seed)) {
    state[name] = new Map(documents.map(document => [document._id, clone(document)]))
  }

  function documents(name) {
    if (!state[name]) state[name] = new Map()
    return state[name]
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

  function enforceUserIndexes(candidate, id) {
    for (const user of documents('users').values()) {
      if (user._id === id) continue
      if (candidate.usernameNormalized && user.usernameNormalized === candidate.usernameNormalized) {
        throw duplicateError('username_normalized_unique')
      }
    }
  }

  function createDocument(name, id) {
    return {
      async get() {
        const document = documents(name).get(id)
        if (!document) {
          throw new Error(`document.get:fail document with _id ${id} does not exist`)
        }
        return { data: clone(document) }
      },
      async set({ data }) {
        const stored = materialize(data, id)
        if (name === 'users') enforceUserIndexes(stored, id)
        if (name === 'wechat_bindings') {
          const current = documents(name).get(id)
          if (current && current.userId !== stored.userId) throw duplicateError('wechat_binding_primary')
        }
        documents(name).set(id, stored)
        return { stats: { created: 1, updated: 0 } }
      },
      async update({ data }) {
        const current = documents(name).get(id)
        if (!current) return { stats: { updated: 0 } }
        const updated = merge(current, data)
        if (name === 'users') enforceUserIndexes(updated, id)
        documents(name).set(id, updated)
        return { stats: { updated: 1 } }
      },
      async remove() {
        const removed = documents(name).delete(id)
        return { stats: { removed: removed ? 1 : 0 } }
      }
    }
  }

  function matches(document, criteria) {
    return Object.entries(criteria || {}).every(([key, value]) => document[key] === value)
  }

  function createQuery(name, transaction, criteria = null, order = [], offset = 0, maximum = Infinity) {
    function rejectTransactionQuery(operation) {
      if (!transaction) return
      transactionQueries.push({ collection: name, operation })
      throw new Error(`transaction query forbidden: ${name}.${operation}`)
    }

    return {
      doc(id) {
        return createDocument(name, id)
      },
      where(nextCriteria) {
        rejectTransactionQuery('where')
        return createQuery(name, transaction, nextCriteria, order, offset, maximum)
      },
      orderBy(field, direction) {
        rejectTransactionQuery('orderBy')
        return createQuery(name, transaction, criteria, [...order, [field, direction]], offset, maximum)
      },
      skip(nextOffset) {
        rejectTransactionQuery('skip')
        return createQuery(name, transaction, criteria, order, nextOffset, maximum)
      },
      limit(nextMaximum) {
        rejectTransactionQuery('limit')
        return createQuery(name, transaction, criteria, order, offset, nextMaximum)
      },
      async get() {
        rejectTransactionQuery('get')
        let result = [...documents(name).values()].filter(document => matches(document, criteria))
        for (const [field, direction] of order.slice().reverse()) {
          result.sort((left, right) => {
            const comparison = String(left[field] || '').localeCompare(String(right[field] || ''))
            return direction === 'desc' ? -comparison : comparison
          })
        }
        return { data: clone(result.slice(offset, offset + maximum)) }
      },
      async count() {
        rejectTransactionQuery('count')
        return { total: [...documents(name).values()].filter(document => matches(document, criteria)).length }
      },
      async add({ data }) {
        rejectTransactionQuery('add')
        const id = `generated-${documents(name).size + 1}`
        await createDocument(name, id).set({ data })
        return { _id: id }
      }
    }
  }

  function snapshot() {
    const result = {}
    for (const [name, collection] of Object.entries(state)) {
      result[name] = [...collection.values()].map(clone)
    }
    return result
  }

  function restore(saved) {
    for (const name of Object.keys(state)) delete state[name]
    for (const [name, collection] of Object.entries(saved)) {
      state[name] = new Map(collection.map(document => [document._id, clone(document)]))
    }
  }

  const db = {
    command: { remove: () => removeValue },
    collection(name) {
      return createQuery(name, false)
    },
    serverDate() {
      serverDateSequence += 1
      return { __serverDate: serverDateSequence }
    },
    async runTransaction(callback) {
      const previous = transactionQueue
      let release
      transactionQueue = new Promise(resolve => {
        release = resolve
      })
      await previous
      try {
        const hook = beforeTransactionHooks.shift()
        if (hook) await hook()
        const saved = snapshot()
        const record = { callbacks: 0 }
        transactionRuns.push(record)
        try {
          record.callbacks += 1
          return await callback({
            collection(name) {
              return createQuery(name, true)
            }
          })
        } catch (error) {
          restore(saved)
          throw error
        }
      } finally {
        release()
      }
    }
  }

  return {
    db,
    state,
    transactionQueries,
    transactionRuns,
    documents(name) {
      return [...documents(name).values()].map(clone)
    },
    replace(name, id, document) {
      documents(name).set(id, { _id: id, ...clone(document) })
    },
    beforeNextTransaction(hook) {
      beforeTransactionHooks.push(hook)
    }
  }
}

module.exports = { createFakeCloudDatabase }
