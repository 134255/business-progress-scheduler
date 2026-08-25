const { createBusinessService } = require('../../lib/business-service')

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function businessTemplate(overrides = {}) {
  return {
    template: {
      _id: 'template-1',
      name: '交付模板',
      status: 'enabled',
      version: 3,
      nodeCount: 2,
      ...clone(overrides.template || {})
    },
    nodes: overrides.nodes || [
      {
        _id: 'template-node-1', templateId: 'template-1', nodeKey: 'node-a', sequence: 0,
        name: '启动', description: '', workflowMode: 'review', processorUserIds: ['user-2'],
        reviewerUserIds: ['user-3'], reviewMode: 'any', processingSlaWorkHours: 8, reviewSlaWorkHours: 4,
        requiresEvidence: false, allowedEvidenceTypes: ['pdf'], fields: []
      },
      {
        _id: 'template-node-2', templateId: 'template-1', nodeKey: 'node-b', sequence: 1,
        name: '交付', description: '', workflowMode: 'review', processorUserIds: ['user-3'],
        reviewerUserIds: ['user-4'], reviewMode: 'all', processingSlaWorkHours: 22, reviewSlaWorkHours: 8,
        requiresEvidence: true, allowedEvidenceTypes: ['pdf'], fields: []
      }
    ]
  }
}

function createBusinessHarness({
  definition = businessTemplate(),
  existing = null,
  createError,
  dueResult = {
    status: 'calculated',
    dueAt: new Date('2026-08-07T10:30:00.000Z'),
    calendarVersion: 'calendar-v1'
  },
  businessSearchClient = null
} = {}) {
  const calls = []
  const workTimeCalls = []
  const repository = {
    async findCreationResult(input) {
      calls.push(['findCreationResult', clone(input)])
      return clone(existing)
    },
    async getTemplateDefinition(templateId) {
      calls.push(['getTemplateDefinition', templateId])
      return clone(definition)
    },
    async createBusinessSnapshot(input) {
      calls.push(['createBusinessSnapshot', clone(input)])
      if (createError) throw createError
      return { id: 'business-1', code: 'BL-20260807-0001' }
    },
    async listBusinessLines(input) {
      calls.push(['listBusinessLines', clone(input)])
      return { items: [], page: 1, pageSize: 20, total: 0, hasMore: false }
    },
    async getBusinessLine(input) {
      calls.push(['getBusinessLine', clone(input)])
      return { line: { _id: input.lineId }, nodes: [] }
    },
    async listMyPendingProcessing(input) {
      calls.push(['listMyPendingProcessing', clone(input)])
      return { items: [], cursor: '', hasMore: false, total: 0 }
    },
    async getMyBusinessSummary(input) {
      calls.push(['getMyBusinessSummary', clone(input)])
      return { stats: { active: 0, completed: 0, pendingProcessing: 0 }, recent: [], complete: true }
    }
  }
  const service = createBusinessService({
    repository,
    businessSearchClient,
    clock: () => new Date('2026-08-07T02:30:00.000Z'),
    workTimeService: {
      async tryAddWorkMinutes(startAt, minutes) {
        workTimeCalls.push([new Date(startAt), minutes])
        return clone(dueResult)
      }
    }
  })
  return {
    service,
    repository,
    calls,
    workTimeCalls,
    actor: { _id: 'user-1', role: 'user', status: 'active' }
  }
}

function createOptimisticBusinessDatabase(seed = {}) {
  const clone = value => value === undefined ? undefined : structuredClone(value)
  const buildState = source => Object.fromEntries(Object.entries(source).map(([name, documents]) => [
    name,
    new Map(documents.map(document => [document._id, clone(document)]))
  ]))
  const cloneState = source => Object.fromEntries(Object.entries(source).map(([name, documents]) => [
    name,
    new Map([...documents.entries()].map(([id, document]) => [id, clone(document)]))
  ]))
  let state = buildState(seed)
  let revision = 0
  let serverDateSequence = 0
  let commitQueue = Promise.resolve()
  const metrics = { activeCallbacks: 0, maxActiveCallbacks: 0, conflicts: 0, retries: 0 }

  function documents(source, name) {
    if (!source[name]) source[name] = new Map()
    return source[name]
  }

  function duplicateError(indexName) {
    const error = new Error(`duplicate key error: ${indexName}`)
    error.errCode = -502005
    return error
  }

  function enforceIndexes(source, name, candidate, id) {
    const uniqueField = name === 'business_lines'
      ? 'code'
      : name === 'business_nodes'
        ? 'nodeCode'
        : null
    if (!uniqueField || !candidate[uniqueField]) return
    for (const document of documents(source, name).values()) {
      if (document._id !== id && document[uniqueField] === candidate[uniqueField]) {
        throw duplicateError(`${name}_${uniqueField}_unique`)
      }
    }
  }

  function matches(document, criteria) {
    return Object.entries(criteria || {}).every(([key, value]) => Array.isArray(document[key])
      ? document[key].includes(value)
      : document[key] === value)
  }

  function collection(source, name, context = null, criteria = null, order = [], offset = 0, maximum = 100) {
    return {
      doc(id) {
        return {
          async get() {
            await Promise.resolve()
            const document = documents(source, name).get(id)
            if (!document) throw new Error(`document.get:fail document with _id ${id} does not exist`)
            return { data: clone(document) }
          },
          async set({ data }) {
            await Promise.resolve()
            const stored = { _id: id, ...clone(data) }
            enforceIndexes(source, name, stored, id)
            documents(source, name).set(id, stored)
            if (context) context.dirty = true
            return { stats: { created: 1, updated: 0 } }
          },
          async update({ data }) {
            await Promise.resolve()
            const current = documents(source, name).get(id)
            if (!current) return { stats: { updated: 0 } }
            const stored = { ...current, ...clone(data) }
            enforceIndexes(source, name, stored, id)
            documents(source, name).set(id, stored)
            if (context) context.dirty = true
            return { stats: { updated: 1 } }
          }
        }
      },
      where(nextCriteria) {
        return collection(source, name, context, nextCriteria, order, offset, maximum)
      },
      orderBy(field, direction) {
        return collection(source, name, context, criteria, [...order, [field, direction]], offset, maximum)
      },
      skip(nextOffset) {
        return collection(source, name, context, criteria, order, nextOffset, maximum)
      },
      limit(nextMaximum) {
        return collection(source, name, context, criteria, order, offset, nextMaximum)
      },
      async get() {
        await Promise.resolve()
        let result = [...documents(source, name).values()].filter(document => matches(document, criteria))
        for (const [field, direction] of order.slice().reverse()) {
          result.sort((left, right) => {
            const comparison = String(left[field] || '').localeCompare(String(right[field] || ''))
            return direction === 'desc' ? -comparison : comparison
          })
        }
        return { data: clone(result.slice(offset, offset + maximum)) }
      }
    }
  }

  async function commit(baseRevision, local, context, result) {
    const previous = commitQueue
    let release
    commitQueue = new Promise(resolve => { release = resolve })
    await previous
    try {
      if (revision !== baseRevision) return { conflict: true }
      if (context.dirty) {
        state = local
        revision += 1
      }
      return { conflict: false, result }
    } finally {
      release()
    }
  }

  const db = {
    command: { remove: () => ({ __remove: true }) },
    collection(name) {
      return collection(state, name)
    },
    serverDate() {
      serverDateSequence += 1
      return { __serverDate: serverDateSequence }
    },
    async runTransaction(callback) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const baseRevision = revision
        const local = cloneState(state)
        const context = { dirty: false }
        metrics.activeCallbacks += 1
        metrics.maxActiveCallbacks = Math.max(metrics.maxActiveCallbacks, metrics.activeCallbacks)
        let result
        try {
          await Promise.resolve()
          result = await callback({
            collection(name) {
              return collection(local, name, context)
            }
          })
        } finally {
          metrics.activeCallbacks -= 1
        }
        const committed = await commit(baseRevision, local, context, result)
        if (!committed.conflict) return committed.result
        metrics.conflicts += 1
        metrics.retries += 1
      }
      throw new Error('optimistic transaction retry limit exceeded')
    }
  }

  return {
    db,
    metrics,
    documents(name) {
      return [...documents(state, name).values()].map(clone)
    }
  }
}

module.exports = { businessTemplate, createBusinessHarness, createOptimisticBusinessDatabase }
