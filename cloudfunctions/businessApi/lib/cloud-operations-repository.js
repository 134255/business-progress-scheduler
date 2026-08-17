const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { safeOperationsRow } = require('./operations-domain')
const { ownExactAccountIds } = require('./account-relationship-schema')

const PAGE_SIZE = 100
const MAX_ROWS = 5000
const ACCOUNT_QUERY_CHUNK = 20

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function missing(error) {
  return /document\.get:fail.*does not exist/i.test(String(error && error.message || ''))
}

function createCloudOperationsRepository({ db }) {
  if (!db) throw new TypeError('db is required')

  async function readDocument(database, collection, id) {
    try {
      const result = await database.collection(collection).doc(id).get()
      return result.data || null
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  async function requireCurrentAdmin(actor) {
    if (!actor || typeof actor._id !== 'string') throw createError('FORBIDDEN')
    return db.runTransaction(async transaction => {
      const current = await readDocument(transaction, 'users', actor._id)
      if (!current || current.status !== 'active' || current.role !== 'super_admin') throw createError('FORBIDDEN')
      return current
    })
  }

  async function readAll(buildQuery, limit = MAX_ROWS + 1) {
    const items = []
    for (let offset = 0; items.length < limit; offset += PAGE_SIZE) {
      const result = await buildQuery().skip(offset).limit(Math.min(PAGE_SIZE, limit - items.length)).get()
      const page = result.data || []
      items.push(...page)
      if (page.length < PAGE_SIZE) break
    }
    return items
  }

  function safeAccountName(user) {
    if (!user || typeof user !== 'object') return '历史账号'
    for (const key of ['displayName', 'username']) {
      const descriptor = Object.getOwnPropertyDescriptor(user, key)
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' &&
          descriptor.value.trim() && descriptor.value.length <= 100) {
        return `${descriptor.value.trim()}${user.status === 'active' ? '' : '（已停用）'}`
      }
    }
    return '历史账号'
  }

  function relationshipIds(node, key) {
    const ids = ownExactAccountIds(node, key, { nonEmpty: true })
    if (!ids) throw createError('VALIDATION_ERROR')
    return ids
  }

  function relationshipNameSnapshot(node, key, ids) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key)
    if (!descriptor) return null
    if (!Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value) ||
        descriptor.value.length !== ids.length || descriptor.value.some(name =>
          typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name))) {
      throw createError('VALIDATION_ERROR')
    }
    return descriptor.value.map(name => name.trim())
  }

  async function participantNames(nodes) {
    const ids = [...new Set(nodes.filter(node => node.workflowMode === 'review').flatMap(node => {
      const processors = relationshipIds(node, 'processorUserIds')
      const reviewers = relationshipIds(node, 'reviewerUserIds')
      return [
        ...(relationshipNameSnapshot(node, 'processorDisplayNames', processors) ? [] : processors),
        ...(relationshipNameSnapshot(node, 'reviewerDisplayNames', reviewers) ? [] : reviewers)
      ]
    }))]
    if (ids.length > MAX_ROWS) throw createError('VALIDATION_ERROR')
    const names = new Map()
    for (let offset = 0; offset < ids.length; offset += ACCOUNT_QUERY_CHUNK) {
      const pageIds = ids.slice(offset, offset + ACCOUNT_QUERY_CHUNK)
      const result = await db.collection('users').where({ _id: db.command.in(pageIds) }).limit(ACCOUNT_QUERY_CHUNK).get()
      for (const user of result.data || []) names.set(user._id, safeAccountName(user))
    }
    return names
  }

  function decorateNode(node, names) {
    if (node.workflowMode !== 'review') {
      const legacyNames = Array.isArray(node.assigneeNames)
        ? node.assigneeNames.filter(name => typeof name === 'string' && name.length <= 100)
        : []
      return { line: null, node, processorDisplayNames: legacyNames, reviewerDisplayNames: [] }
    }
    const processors = relationshipIds(node, 'processorUserIds')
    const reviewers = relationshipIds(node, 'reviewerUserIds')
    return {
      line: null,
      node,
      processorDisplayNames: relationshipNameSnapshot(node, 'processorDisplayNames', processors) ||
        processors.map(id => names.get(id) || '历史账号'),
      reviewerDisplayNames: relationshipNameSnapshot(node, 'reviewerDisplayNames', reviewers) ||
        reviewers.map(id => names.get(id) || '历史账号')
    }
  }

  async function dataset(actor, range) {
    await requireCurrentAdmin(actor)
    const scannedLines = await readAll(() => db.collection('business_lines')
      .where({ createdAt: db.command.and(db.command.gte(range.startAt), db.command.lt(range.endAt)) })
      .orderBy('createdAt', 'desc').orderBy('_id', 'asc'))
    if (scannedLines.length > MAX_ROWS) throw createError('VALIDATION_ERROR')
    const lines = range.status ? scannedLines.filter(line => line.status === range.status) : scannedLines
    const lineIds = new Set(lines.map(line => line._id))
    const nodes = []
    for (const line of lines) {
      const page = await readAll(() => db.collection('business_nodes')
        .where({ businessLineId: line._id }).orderBy('sequence', 'asc').orderBy('_id', 'asc'), 100)
      nodes.push(...page)
    }
    const rounds = await readAll(() => db.collection('node_review_rounds')
      .where({ status: 'pending' }).orderBy('createdAt', 'desc').orderBy('_id', 'asc'))
    const names = await participantNames(nodes)
    await requireCurrentAdmin(actor)
    return {
      lines,
      lineIds,
      nodes: nodes.map(node => decorateNode(node, names)),
      rounds: rounds.filter(round => lineIds.has(round.businessLineId))
    }
  }

  async function getDashboard({ actor, range }) {
    const data = await dataset(actor, range)
    const currentNodeIds = new Set(data.lines.filter(line => line.status === 'active').map(line => line.currentNodeId))
    return {
      stats: {
        businesses: data.lines.length,
        active: data.lines.filter(line => line.status === 'active').length,
        completed: data.lines.filter(line => line.status === 'completed').length,
        frozen: data.lines.filter(line => ['cancelled', 'closed', 'deleted'].includes(line.status)).length,
        pendingProcessing: data.nodes.filter(entry => currentNodeIds.has(entry.node._id) &&
          ['ready', 'in_progress', 'blocked'].includes(entry.node.status)).length,
        pendingReview: data.rounds.length,
        overdueProcessing: data.nodes.filter(entry => Number(entry.node.processingOverdueWorkMinutes || 0) > 0).length,
        overdueReview: data.rounds.filter(round => Number(round.reviewOverdueWorkMinutes || 0) > 0).length,
        pendingCalendar: data.nodes.filter(entry => entry.node.processingDueStatus === 'pending_calendar').length +
          data.rounds.filter(round => round.reviewDueStatus === 'pending_calendar').length
      },
      range: { startDate: range.startDate || '', endDate: range.endDate || '', status: range.status || '' }
    }
  }

  function cursorFor(entry) {
    return Buffer.from(JSON.stringify([entry.line._id, entry.node.sequence, entry.node._id])).toString('base64url')
  }

  function decodeCursor(value) {
    if (!value) return null
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
      if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' ||
          !Number.isSafeInteger(parsed[1]) || typeof parsed[2] !== 'string') throw new Error('bad cursor')
      return parsed
    } catch {
      throw createError('VALIDATION_ERROR')
    }
  }

  async function exportRows({ actor, range }) {
    const data = await dataset(actor, range)
    const lineMap = new Map(data.lines.map(line => [line._id, line]))
    const entries = data.nodes.map(entry => ({ ...entry, line: lineMap.get(entry.node.businessLineId) }))
      .filter(entry => entry.line)
      .sort((left, right) => {
        const dateCompare = String(right.line.createdAt || '').localeCompare(String(left.line.createdAt || ''))
        return dateCompare || String(left.line._id).localeCompare(String(right.line._id)) ||
          Number(left.node.sequence) - Number(right.node.sequence) ||
          String(left.node._id).localeCompare(String(right.node._id))
      })
    const cursor = decodeCursor(range.cursor)
    const start = cursor ? entries.findIndex(entry => cursorFor(entry) === range.cursor) + 1 : 0
    if (cursor && start === 0) throw createError('VALIDATION_ERROR')
    const page = entries.slice(start, start + range.pageSize)
    return {
      items: page.map(safeOperationsRow),
      nextCursor: page.length ? cursorFor(page[page.length - 1]) : '',
      hasMore: start + page.length < entries.length
    }
  }

  return { getDashboard, exportRows }
}

module.exports = { createCloudOperationsRepository }
