const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { safeOperationsRow, safeTimingDetail } = require('./operations-domain')
const { ownExactAccountIds } = require('./account-relationship-schema')

const PAGE_SIZE = 100
const MAX_ROWS = 5000
const ACCOUNT_QUERY_CHUNK = 20
const TIMING_SCAN_LIMIT = 100
const TIMING_VOTE_LIMIT = 100
const TIMING_CURSOR_VERSION = 1
const MAX_ANALYTICS_FACTS = 2000
const MAX_ANALYTICS_ROLLUPS = 20000

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

  async function requireCurrentActor(actor) {
    if (!actor || typeof actor._id !== 'string') throw createError('FORBIDDEN')
    const current = await readDocument(db, 'users', actor._id)
    if (!current || current.status !== 'active' || !['user', 'super_admin'].includes(current.role)) {
      throw createError('FORBIDDEN')
    }
    return current
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

  function assertAnalyticsKey(row) {
    if (!row || typeof row._id !== 'string' || !row._id || row._id.length > 200 ||
        typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) {
      throw createError('VALIDATION_ERROR')
    }
  }

  async function readAnalyticsDayRange(collectionName, baseWhere, range, limit) {
    const items = []
    let cursor = null
    while (items.length < limit) {
      const pageLimit = Math.min(PAGE_SIZE, limit - items.length)
      let page = []
      if (!cursor) {
        const result = await db.collection(collectionName).where({
          ...baseWhere,
          day: db.command.and(db.command.gte(range.startDate), db.command.lte(range.endDate))
        }).orderBy('day', 'asc').orderBy('_id', 'asc').limit(pageLimit).get()
        page = result.data || []
      } else {
        const sameDayResult = await db.collection(collectionName).where({
          ...baseWhere,
          day: cursor.day,
          _id: db.command.gt(cursor.id)
        }).orderBy('day', 'asc').orderBy('_id', 'asc').limit(pageLimit).get()
        page = sameDayResult.data || []
        if (page.length < pageLimit) {
          const laterResult = await db.collection(collectionName).where({
            ...baseWhere,
            day: db.command.and(db.command.gt(cursor.day), db.command.lte(range.endDate))
          }).orderBy('day', 'asc').orderBy('_id', 'asc').limit(pageLimit - page.length).get()
          page.push(...(laterResult.data || []))
        }
      }
      for (const row of page) assertAnalyticsKey(row)
      items.push(...page)
      if (page.length < pageLimit) break
      const last = page.at(-1)
      cursor = { day: last.day, id: last._id }
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

  function sameDate(left, right) {
    const leftDate = left instanceof Date ? left : new Date(left)
    const rightDate = right instanceof Date ? right : new Date(right)
    return !Number.isNaN(leftDate.getTime()) && !Number.isNaN(rightDate.getTime()) &&
      leftDate.getTime() === rightDate.getTime()
  }

  function timingCursorFor(round, range) {
    const startedAt = round.reviewStartedAt instanceof Date
      ? round.reviewStartedAt.toISOString()
      : new Date(round.reviewStartedAt).toISOString()
    return Buffer.from(JSON.stringify({
      v: TIMING_CURSOR_VERSION,
      at: startedAt,
      id: round._id,
      startDate: range.startDate,
      endDate: range.endDate,
      status: range.status || ''
    })).toString('base64url')
  }

  function decodeTimingCursor(value, range) {
    if (!value) return null
    try {
      const text = Buffer.from(value, 'base64url').toString('utf8')
      const parsed = JSON.parse(text)
      const keys = Reflect.ownKeys(parsed)
      const date = new Date(parsed.at)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          keys.length !== 6 || keys.some(key => !['v', 'at', 'id', 'startDate', 'endDate', 'status'].includes(key)) ||
          parsed.v !== TIMING_CURSOR_VERSION || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 200 ||
          typeof parsed.at !== 'string' || Number.isNaN(date.getTime()) || date.toISOString() !== parsed.at ||
          parsed.startDate !== range.startDate || parsed.endDate !== range.endDate ||
          parsed.status !== (range.status || '') ||
          Buffer.from(JSON.stringify(parsed)).toString('base64url') !== value) {
        throw new Error('bad cursor')
      }
      return { ...parsed, date }
    } catch {
      throw createError('VALIDATION_ERROR')
    }
  }

  async function queryTimingRounds(range) {
    const cursor = decodeTimingCursor(range.cursor, range)
    const collection = db.collection('node_review_rounds')
    if (!cursor) {
      const result = await collection
        .where({ reviewStartedAt: db.command.and(db.command.gte(range.startAt), db.command.lt(range.endAt)) })
        .orderBy('reviewStartedAt', 'desc').orderBy('_id', 'asc').limit(TIMING_SCAN_LIMIT).get()
      return result.data || []
    }
    const sameTimeResult = await collection
      .where({ reviewStartedAt: cursor.date, _id: db.command.gt(cursor.id) })
      .orderBy('reviewStartedAt', 'desc').orderBy('_id', 'asc').limit(TIMING_SCAN_LIMIT).get()
    const rows = sameTimeResult.data || []
    if (rows.length >= TIMING_SCAN_LIMIT) return rows
    const earlierResult = await collection
      .where({ reviewStartedAt: db.command.and(db.command.gte(range.startAt), db.command.lt(cursor.date)) })
      .orderBy('reviewStartedAt', 'desc').orderBy('_id', 'asc').limit(TIMING_SCAN_LIMIT - rows.length).get()
    return [...rows, ...(earlierResult.data || [])]
  }

  async function readVotes(round) {
    const result = await db.collection('node_review_votes')
      .where({ reviewRoundId: round._id })
      .orderBy('createdAt', 'asc').orderBy('_id', 'asc').limit(TIMING_VOTE_LIMIT + 1).get()
    const votes = result.data || []
    if (votes.length > TIMING_VOTE_LIMIT) throw createError('VALIDATION_ERROR')
    return votes
  }

  function validVoteAssociation(vote, round) {
    return vote && vote.reviewRoundId === round._id && vote.businessLineId === round.businessLineId &&
      vote.nodeId === round.nodeId && typeof vote.reviewerUserId === 'string' && vote.reviewerUserId
  }

  async function finalTimingEntry(actor, candidate, range) {
    const votes = await readVotes(candidate)
    return db.runTransaction(async transaction => {
      const currentActor = await readDocument(transaction, 'users', actor._id)
      if (!currentActor || currentActor.status !== 'active' || currentActor.role !== 'super_admin') {
        throw createError('FORBIDDEN')
      }
      const line = await readDocument(transaction, 'business_lines', candidate.businessLineId)
      const node = await readDocument(transaction, 'business_nodes', candidate.nodeId)
      const round = await readDocument(transaction, 'node_review_rounds', candidate._id)
      if (!line || !node || !round || node.businessLineId !== line._id ||
          round.businessLineId !== line._id || round.nodeId !== node._id ||
          node.workflowMode !== 'review' || !sameDate(round.reviewStartedAt, candidate.reviewStartedAt) ||
          !['active', 'completed', 'cancelled', 'closed', 'deleted'].includes(line.status) ||
          range.status && line.status !== range.status ||
          !votes.every(vote => validVoteAssociation(vote, round)) ||
          Number.isSafeInteger(round.voteCount) && round.voteCount !== votes.length ||
          Number.isSafeInteger(round.approvedVoteCount) &&
            round.approvedVoteCount !== votes.filter(vote => vote.decision === 'approved').length) {
        return null
      }
      try {
        return safeTimingDetail({ line, node, round, votes })
      } catch (error) {
        if (error && error.code === 'VALIDATION_ERROR') return null
        throw error
      }
    })
  }

  async function listTimingDetails({ actor, range }) {
    await requireCurrentAdmin(actor)
    const raw = await queryTimingRounds(range)
    const items = []
    let lastScanned = null
    let processed = 0
    for (const candidate of raw) {
      lastScanned = candidate
      processed += 1
      const entry = await finalTimingEntry(actor, candidate, range)
      if (entry) items.push(entry)
      if (items.length >= range.pageSize) break
    }
    await requireCurrentAdmin(actor)
    return {
      items,
      nextCursor: lastScanned ? timingCursorFor(lastScanned, range) : '',
      hasMore: processed < raw.length || raw.length === TIMING_SCAN_LIMIT
    }
  }

  function average(totalMinutes, sampleCount) {
    return sampleCount ? Math.round(totalMinutes * 10 / sampleCount) / 10 : null
  }

  function analyticsMetric(rows) {
    if (rows.some(row => Object.hasOwn(row, 'sampleCount'))) {
      const result = { sampleCount: 0, totalMinutes: 0, pendingCount: 0, unrecordedCount: 0 }
      for (const row of rows) {
        for (const key of Object.keys(result)) {
          if (!Number.isSafeInteger(row[key]) || row[key] < 0 || result[key] > Number.MAX_SAFE_INTEGER - row[key]) {
            throw createError('VALIDATION_ERROR')
          }
          result[key] += row[key]
        }
      }
      return { ...result, averageMinutes: average(result.totalMinutes, result.sampleCount) }
    }
    const calculated = rows.filter(row => row.timingStatus === 'calculated' &&
      Number.isSafeInteger(row.workMinutes) && row.workMinutes >= 0)
    let totalMinutes = 0
    for (const row of calculated) {
      if (totalMinutes > Number.MAX_SAFE_INTEGER - row.workMinutes) throw createError('VALIDATION_ERROR')
      totalMinutes += row.workMinutes
    }
    return {
      sampleCount: calculated.length,
      totalMinutes,
      averageMinutes: average(totalMinutes, calculated.length),
      pendingCount: rows.filter(row => row.timingStatus === 'pending_calendar').length,
      unrecordedCount: rows.filter(row => row.timingStatus === 'historical_unrecorded').length
    }
  }

  function analyticsBucket(day, grain) {
    if (grain === 'day') return day
    if (grain === 'month') return day.slice(0, 7)
    const date = new Date(`${day}T00:00:00.000Z`)
    const weekday = date.getUTCDay()
    date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1))
    return date.toISOString().slice(0, 10)
  }

  function factMatchesDimension(fact, range) {
    if (fact.metric === 'node_processing' && range.processorToken) {
      return fact.dimensionRole === 'processor' && fact.dimensionFilterToken === range.processorToken
    }
    if (['node_review', 'review_response'].includes(fact.metric) && range.reviewerToken) {
      return fact.dimensionRole === 'reviewer' && fact.dimensionFilterToken === range.reviewerToken
    }
    return fact.dimensionRole === 'global'
  }

  async function readAnalyticsFacts(range, { allDimensions = false } = {}) {
    if (!range.templateId) return []
    const facts = await readAnalyticsDayRange('operations_analytics_facts', {
      templateId: range.templateId
    }, range, MAX_ANALYTICS_FACTS + 1)
    if (facts.length > MAX_ANALYTICS_FACTS) throw createError('RANGE_TOO_LARGE')
    let allowedLineIds = null
    if (range.status) {
      const lineMap = await readAnalyticsLines(facts.map(fact => fact.businessLineId))
      allowedLineIds = new Set([...lineMap.values()].filter(line => line.status === range.status).map(line => line._id))
    }
    return facts.filter(fact =>
      fact.day >= range.startDate && fact.day <= range.endDate &&
      fact.templateId === range.templateId &&
      (range.templateVersion === null || fact.templateVersion === range.templateVersion) &&
      (!range.businessLineId || fact.businessLineId === range.businessLineId) &&
      (!range.stableNodeId || fact.stableNodeId === range.stableNodeId) &&
      (!range.metric || fact.metric === range.metric) &&
      (!allowedLineIds || allowedLineIds.has(fact.businessLineId)) &&
      (allDimensions || factMatchesDimension(fact, range)))
  }

  async function readAnalyticsRollupRole(range, dimensionRole, dimensionFilterToken = '') {
    const rows = await readAnalyticsDayRange('operations_analytics_daily', {
      templateId: range.templateId,
      dimensionRole,
      ...(dimensionFilterToken ? { dimensionFilterToken } : {})
    }, range, MAX_ANALYTICS_ROLLUPS + 1)
    if (rows.length > MAX_ANALYTICS_ROLLUPS) throw createError('RANGE_TOO_LARGE')
    return rows
  }

  async function readAnalyticsRollups(range) {
    const rows = await readAnalyticsRollupRole(range, 'global')
    if (range.processorToken) rows.push(...await readAnalyticsRollupRole(range, 'processor', range.processorToken))
    if (range.reviewerToken) rows.push(...await readAnalyticsRollupRole(range, 'reviewer', range.reviewerToken))
    return rows.filter(row =>
      row.day >= range.startDate && row.day <= range.endDate && row.templateId === range.templateId &&
      (range.templateVersion === null || row.templateVersion === range.templateVersion) &&
      (!range.stableNodeId || row.stableNodeId === range.stableNodeId) &&
      (!range.metric || row.metric === range.metric) && factMatchesDimension(row, range))
  }

  function safeTemplate(template) {
    return template && typeof template._id === 'string' && typeof template.name === 'string' && template.name.trim()
      ? { templateId: template._id, templateName: template.name.trim() }
      : null
  }

  async function getAnalyticsFilters({ actor, range }) {
    const currentActor = await requireCurrentActor(actor)
    const templateResult = await db.collection('templates').orderBy('name', 'asc').orderBy('_id', 'asc').limit(101).get()
    const templates = templateResult.data || []
    if (templates.length > 100) throw createError('RANGE_TOO_LARGE')
    const facts = range.templateId
      ? await readAnalyticsFacts({ ...range, metric: '', stableNodeId: '', businessLineId: '' }, { allDimensions: true })
      : []
    const people = new Map()
    const nodes = new Map()
    const versions = new Set()
    const businessIds = new Set()
    for (const fact of facts) {
      if (typeof fact.businessLineId === 'string' && fact.businessLineId) businessIds.add(fact.businessLineId)
      if (Number.isSafeInteger(fact.templateVersion)) versions.add(fact.templateVersion)
      if (fact.stableNodeId && typeof fact.nodeName === 'string' && Number.isSafeInteger(fact.nodeSequence)) {
        nodes.set(fact.stableNodeId, {
          stableNodeId: fact.stableNodeId,
          nodeName: fact.nodeName,
          sequence: fact.nodeSequence
        })
      }
      if (['processor', 'reviewer'].includes(fact.dimensionRole) &&
          /^[a-f0-9]{64}$/.test(fact.dimensionFilterToken || '') &&
          typeof fact.dimensionDisplayName === 'string' && fact.dimensionDisplayName.trim()) {
        people.set(`${fact.dimensionRole}:${fact.dimensionFilterToken}`, {
          token: fact.dimensionFilterToken,
          displayName: fact.dimensionDisplayName.trim(), role: fact.dimensionRole,
          userId: fact.dimensionUserId
        })
      }
    }
    const userMap = await readAnalyticsUsers([...people.values()].map(person => person.userId))
    for (const [key, person] of people) {
      const user = typeof person.userId === 'string' ? userMap.get(person.userId) : null
      if (!user || user.status !== 'active') people.delete(key)
    }
    const businesses = []
    const businessMap = await readAnalyticsLines([...businessIds])
    for (const id of businessIds) {
      const line = businessMap.get(id)
      if (!line || !canReadAnalyticsLine(currentActor, line)) continue
      const currentLine = await finalAuthorizedAnalyticsLine(actor, id)
      if (!currentLine || typeof currentLine.code !== 'string' || typeof currentLine.name !== 'string') continue
      businesses.push({ businessLineId: currentLine._id, businessCode: currentLine.code, businessName: currentLine.name })
    }
    await requireCurrentActor(actor)
    const allPeople = [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'))
    return {
      templates: templates.map(safeTemplate).filter(Boolean),
      templateVersions: [...versions].sort((a, b) => b - a),
      stableNodes: [...nodes.values()].sort((a, b) => a.sequence - b.sequence || a.stableNodeId.localeCompare(b.stableNodeId)),
      businesses: businesses.sort((a, b) => a.businessCode.localeCompare(b.businessCode)),
      processors: allPeople.filter(item => item.role === 'processor').map(({ role, userId, ...item }) => item),
      reviewers: allPeople.filter(item => item.role === 'reviewer').map(({ role, userId, ...item }) => item)
    }
  }

  async function getAnalyticsSummary({ actor, range }) {
    const currentActor = await requireCurrentActor(actor)
    await requireAnalyticsBusinessAccess(currentActor, range.businessLineId)
    const facts = !range.status && !range.businessLineId
      ? await readAnalyticsRollups(range)
      : await readAnalyticsFacts(range)
    const nodeMap = new Map()
    for (const fact of facts.filter(item => ['node_processing', 'node_review'].includes(item.metric))) {
      const key = fact.stableNodeId
      const current = nodeMap.get(key) || {
        stableNodeId: key,
        nodeName: typeof fact.nodeName === 'string' ? fact.nodeName : '历史节点',
        sequence: Number.isSafeInteger(fact.nodeSequence) ? fact.nodeSequence : Number.MAX_SAFE_INTEGER,
        processingRows: [], reviewRows: []
      }
      current[fact.metric === 'node_processing' ? 'processingRows' : 'reviewRows'].push(fact)
      nodeMap.set(key, current)
    }
    const nodeSeries = [...nodeMap.values()].sort((a, b) => a.sequence - b.sequence || a.stableNodeId.localeCompare(b.stableNodeId))
      .map(({ processingRows, reviewRows, ...node }) => ({
        ...node,
        processing: analyticsMetric(processingRows),
        review: analyticsMetric(reviewRows)
      }))
    const businessCompletionRows = facts.filter(item => item.metric === 'business_completion')
    const hasBusinessTotals = facts.some(item => item.metric === 'business_node_processing_total')
    const processingTrendMetric = range.stableNodeId || !hasBusinessTotals ? 'node_processing' : 'business_node_processing_total'
    const reviewTrendMetric = range.stableNodeId || !hasBusinessTotals ? 'node_review' : 'business_review_total'
    const buckets = new Map()
    for (const fact of facts.filter(item => [processingTrendMetric, reviewTrendMetric].includes(item.metric))) {
      const bucket = analyticsBucket(fact.day, range.grain)
      if (!buckets.has(bucket)) buckets.set(bucket, { processingRows: [], reviewRows: [] })
      buckets.get(bucket)[fact.metric === processingTrendMetric ? 'processingRows' : 'reviewRows'].push(fact)
    }
    await requireCurrentActor(actor)
    return {
      scopeNotice: '全局汇总可见；业务明细仍按当前账号权限过滤',
      templateMetrics: {
        businessCompletion: analyticsMetric(businessCompletionRows),
        nodeProcessingPerBusiness: analyticsMetric(facts.filter(item => item.metric === 'business_node_processing_total')),
        reviewPerBusiness: analyticsMetric(facts.filter(item => item.metric === 'business_review_total'))
      },
      nodeSeries,
      trendSeries: [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, rows]) => ({
        bucket,
        processing: analyticsMetric(rows.processingRows),
        review: analyticsMetric(rows.reviewRows)
      }))
    }
  }

  function canReadAnalyticsLine(actor, line) {
    if (actor.role === 'super_admin') return true
    const managers = ownExactAccountIds(line, 'managerUserIds', { nonEmpty: true })
    const members = ownExactAccountIds(line, 'memberUserIds', { nonEmpty: true })
    return Boolean(managers && members && (managers.includes(actor._id) || members.includes(actor._id)))
  }

  async function requireAnalyticsBusinessAccess(actor, businessLineId) {
    if (!businessLineId) return null
    const line = await finalAuthorizedAnalyticsLine(actor, businessLineId)
    if (!line) throw createError('FORBIDDEN')
    return line
  }

  async function finalAuthorizedAnalyticsLine(actor, businessLineId) {
    return db.runTransaction(async transaction => {
      const current = await readDocument(transaction, 'users', actor._id)
      const line = await readDocument(transaction, 'business_lines', businessLineId)
      if (!current || current.status !== 'active' || !['user', 'super_admin'].includes(current.role) ||
          !line || !canReadAnalyticsLine(current, line)) return null
      return line
    })
  }

  async function readAnalyticsLines(ids) {
    const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))]
    if (unique.length > MAX_ANALYTICS_FACTS) throw createError('RANGE_TOO_LARGE')
    const lines = new Map()
    for (let offset = 0; offset < unique.length; offset += ACCOUNT_QUERY_CHUNK) {
      const chunk = unique.slice(offset, offset + ACCOUNT_QUERY_CHUNK)
      const result = await db.collection('business_lines').where({ _id: db.command.in(chunk) })
        .limit(ACCOUNT_QUERY_CHUNK).get()
      for (const line of result.data || []) lines.set(line._id, line)
    }
    return lines
  }

  async function readAnalyticsUsers(ids) {
    const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))]
    if (unique.length > MAX_ANALYTICS_FACTS) throw createError('RANGE_TOO_LARGE')
    const users = new Map()
    for (let offset = 0; offset < unique.length; offset += ACCOUNT_QUERY_CHUNK) {
      const chunk = unique.slice(offset, offset + ACCOUNT_QUERY_CHUNK)
      const result = await db.collection('users').where({ _id: db.command.in(chunk) })
        .limit(ACCOUNT_QUERY_CHUNK).get()
      for (const user of result.data || []) users.set(user._id, user)
    }
    return users
  }

  function sampleQueryIdentity(range) {
    return [
      range.startDate, range.endDate, range.templateId, range.templateVersion, range.status,
      range.businessLineId, range.stableNodeId, range.processorToken, range.reviewerToken, range.metric
    ]
  }

  function sampleCursor(fact, range) {
    return Buffer.from(JSON.stringify({ v: 1, day: fact.day, id: fact._id, query: sampleQueryIdentity(range) }))
      .toString('base64url')
  }

  function decodeSampleCursor(value, range) {
    if (!value) return null
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1 ||
          typeof parsed.day !== 'string' || typeof parsed.id !== 'string' ||
          JSON.stringify(parsed.query) !== JSON.stringify(sampleQueryIdentity(range)) ||
          Buffer.from(JSON.stringify(parsed)).toString('base64url') !== value) throw new Error('bad cursor')
      return parsed
    } catch {
      throw createError('VALIDATION_ERROR')
    }
  }

  function sampleMinutes(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }

  function sampleText(value) {
    return typeof value === 'string' && value.trim() && value.length <= 100 ? value.trim() : '历史账号'
  }

  async function readSampleRounds(fact) {
    if (typeof fact.nodeId !== 'string' || !fact.nodeId) return []
    const roundResult = await db.collection('node_review_rounds').where({
      businessLineId: fact.businessLineId, nodeId: fact.nodeId
    }).orderBy('_id', 'asc').limit(101).get()
    const voteResult = await db.collection('node_review_votes').where({
      businessLineId: fact.businessLineId, nodeId: fact.nodeId
    }).orderBy('_id', 'asc').limit(101).get()
    const rounds = roundResult.data || []
    const votes = voteResult.data || []
    if (rounds.length > 100 || votes.length > 100) throw createError('RANGE_TOO_LARGE')
    const voteMap = new Map()
    for (const vote of votes) {
      if (!vote || typeof vote.reviewRoundId !== 'string' ||
          !['approved', 'rejected'].includes(vote.decision)) throw createError('VALIDATION_ERROR')
      if (!voteMap.has(vote.reviewRoundId)) voteMap.set(vote.reviewRoundId, [])
      voteMap.get(vote.reviewRoundId).push({
        reviewerDisplayName: sampleText(vote.reviewerDisplayName),
        decision: vote.decision,
        responseWorkMinutes: sampleMinutes(vote.reviewResponseWorkMinutes)
      })
    }
    return rounds.map(round => {
      if (!round || round.businessLineId !== fact.businessLineId || round.nodeId !== fact.nodeId ||
          !['pending', 'approved', 'rejected'].includes(round.status)) throw createError('VALIDATION_ERROR')
      return {
        processingRoundNumber: Number.isSafeInteger(round.processingRoundNumber) ? round.processingRoundNumber : null,
        reviewRoundNumber: Number.isSafeInteger(round.reviewRoundNumber) ? round.reviewRoundNumber : null,
        status: round.status,
        submittedByDisplayName: sampleText(round.submittedByDisplayName),
        processingWorkMinutes: sampleMinutes(round.processingRoundWorkMinutes),
        reviewWorkMinutes: sampleMinutes(round.reviewElapsedWorkMinutes),
        votes: voteMap.get(round._id) || []
      }
    })
  }

  async function listAnalyticsSamples({ actor, range }) {
    const currentActor = await requireCurrentActor(actor)
    await requireAnalyticsBusinessAccess(currentActor, range.businessLineId)
    const allFacts = (await readAnalyticsFacts(range)).filter(fact => !range.metric || fact.metric === range.metric)
    const metricStatistics = analyticsMetric(allFacts)
    const facts = allFacts.filter(fact => fact.timingStatus === 'calculated')
      .sort((left, right) => right.day.localeCompare(left.day) || left._id.localeCompare(right._id))
    const values = facts.map(fact => fact.workMinutes).sort((a, b) => a - b)
    const middle = Math.floor(values.length / 2)
    const medianMinutes = values.length === 0 ? null : values.length % 2
      ? values[middle]
      : Math.round((values[middle - 1] + values[middle]) * 5) / 10
    const lineMap = await readAnalyticsLines(facts.map(fact => fact.businessLineId))
    const visible = []
    for (const fact of facts) {
      const line = lineMap.get(fact.businessLineId)
      if (!line || !canReadAnalyticsLine(currentActor, line)) continue
      visible.push({ fact, line })
    }
    const cursor = decodeSampleCursor(range.cursor, range)
    const start = cursor ? visible.findIndex(entry => entry.fact.day === cursor.day && entry.fact._id === cursor.id) + 1 : 0
    if (cursor && start === 0) throw createError('VALIDATION_ERROR')
    const page = []
    let scannedIndex = start
    for (; scannedIndex < visible.length && page.length < range.pageSize; scannedIndex += 1) {
      const entry = visible[scannedIndex]
      const rounds = await readSampleRounds(entry.fact)
      const currentLine = await finalAuthorizedAnalyticsLine(actor, entry.line._id)
      if (currentLine) page.push({ ...entry, line: currentLine, rounds })
    }
    return {
      globalSampleCount: facts.length,
      visibleSampleCount: visible.length,
      visibilityNotice: facts.length > visible.length ? '全局样本多于当前账号可下钻的业务明细' : '',
      statistics: {
        averageMinutes: analyticsMetric(facts).averageMinutes,
        medianMinutes,
        minimumMinutes: values.length ? values[0] : null,
        maximumMinutes: values.length ? values.at(-1) : null,
        pendingCount: metricStatistics.pendingCount,
        unrecordedCount: metricStatistics.unrecordedCount
      },
      items: page.map(({ fact, line, rounds }) => ({
        businessCode: String(line.code || ''),
        businessName: String(line.name || ''),
        businessStatus: String(line.status || ''),
        nodeName: String(fact.nodeName || ''),
        completedDay: fact.day,
        workMinutes: fact.workMinutes,
        rounds
      })),
      nextCursor: page.length ? sampleCursor(page.at(-1).fact, range) : '',
      hasMore: scannedIndex < visible.length
    }
  }

  return {
    getDashboard,
    exportRows,
    listTimingDetails,
    getAnalyticsFilters,
    getAnalyticsSummary,
    listAnalyticsSamples
  }
}

module.exports = { createCloudOperationsRepository }
