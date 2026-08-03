const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const COLLECTIONS = {
  users: 'users',
  lines: 'business_lines',
  nodes: 'business_nodes',
  feedback: 'node_feedback',
  evidences: 'evidences',
  notifications: 'notifications',
  audit: 'audit_logs'
}

function ok(data) {
  return { ok: true, data }
}

function fail(message, code) {
  return { ok: false, code: code || 'BUSINESS_ERROR', message }
}

function assert(condition, message, code) {
  if (!condition) {
    const error = new Error(message)
    error.code = code || 'VALIDATION_ERROR'
    throw error
  }
}

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function now() {
  return db.serverDate()
}

function isManager(line, openid) {
  return Array.isArray(line.managerIds) && line.managerIds.includes(openid)
}

function isMember(line, openid) {
  return isManager(line, openid) || (Array.isArray(line.memberIds) && line.memberIds.includes(openid))
}

async function getLine(id) {
  assert(id, '缺少业务线 ID')
  const result = await db.collection(COLLECTIONS.lines).doc(id).get()
  assert(result.data && result.data.status !== 'deleted', '业务线不存在', 'NOT_FOUND')
  return result.data
}

async function writeAudit(openid, action, targetType, targetId, snapshot) {
  await db.collection(COLLECTIONS.audit).add({
    data: { openid, action, targetType, targetId, snapshot: snapshot || null, createdAt: now() }
  })
}

async function bootstrap(openid) {
  const users = db.collection(COLLECTIONS.users)
  const existing = await users.where({ openid }).limit(1).get()
  if (existing.data.length) return existing.data[0]

  const user = {
    openid,
    displayName: '微信用户',
    avatarUrl: '',
    status: 'active',
    createdAt: now(),
    updatedAt: now()
  }
  const created = await users.add({ data: user })
  return Object.assign({ _id: created._id }, user)
}

async function dashboard(openid) {
  const lines = await db.collection(COLLECTIONS.lines)
    .where({ memberIds: openid, status: _.neq('deleted') })
    .orderBy('updatedAt', 'desc')
    .limit(20)
    .get()

  const mine = await db.collection(COLLECTIONS.nodes)
    .where({ assigneeIds: openid, status: _.in(['ready', 'in_progress', 'blocked']) })
    .count()

  const items = lines.data
  return {
    stats: {
      active: items.filter(item => item.status === 'active').length,
      pendingMine: mine.total,
      completed: items.filter(item => item.status === 'completed').length
    },
    recent: items.slice(0, 5)
  }
}

async function listBusinessLines(openid, payload) {
  const query = payload || {}
  const result = await db.collection(COLLECTIONS.lines)
    .where({ memberIds: openid, status: _.neq('deleted') })
    .orderBy('updatedAt', 'desc')
    .limit(100)
    .get()

  const keyword = String(query.keyword || '').trim().toLowerCase()
  const start = query.startDate ? new Date(`${query.startDate}T00:00:00+08:00`) : null
  const end = query.endDate ? new Date(`${query.endDate}T23:59:59+08:00`) : null

  const items = result.data.filter(item => {
    const keywordMatch = !keyword || String(item.name || '').toLowerCase().includes(keyword) || String(item.code || '').toLowerCase().includes(keyword)
    const itemDate = item.plannedStartDate ? new Date(item.plannedStartDate) : null
    const dateMatch = (!start || (itemDate && itemDate >= start)) && (!end || (itemDate && itemDate <= end))
    return keywordMatch && dateMatch
  })

  return { items }
}

async function getBusinessLine(openid, payload) {
  const line = await getLine(payload.id)
  assert(isMember(line, openid), '你不是该业务线的关联成员', 'FORBIDDEN')

  const nodesResult = await db.collection(COLLECTIONS.nodes)
    .where({ businessLineId: line._id })
    .orderBy('sequence', 'asc')
    .get()

  const nodes = nodesResult.data.map(node => Object.assign({}, node, {
    canFeedback: isManager(line, openid) || (node.assigneeIds || []).includes(openid),
    assigneeNamesText: (node.assigneeNames || []).join('、')
  }))

  return { line, nodes, canManage: isManager(line, openid) }
}

function dateText(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function getNodeHistory(openid, payload) {
  const line = await getLine(payload.businessLineId)
  assert(isMember(line, openid), '你不是该业务线的关联成员', 'FORBIDDEN')
  const nodeResult = await db.collection(COLLECTIONS.nodes).doc(payload.nodeId).get()
  const node = nodeResult.data
  assert(node && node.businessLineId === line._id, '节点不存在', 'NOT_FOUND')

  const [feedbackResult, evidenceResult] = await Promise.all([
    db.collection(COLLECTIONS.feedback).where({ nodeId: node._id }).orderBy('createdAt', 'desc').limit(100).get(),
    db.collection(COLLECTIONS.evidences).where({ nodeId: node._id }).orderBy('createdAt', 'desc').limit(100).get()
  ])
  const labels = { in_progress: '处理中', blocked: '受阻', completed: '已完成' }
  return {
    canFeedback: isManager(line, openid) || (node.assigneeIds || []).includes(openid),
    history: feedbackResult.data.map(item => Object.assign({}, item, { statusLabel: labels[item.status] || item.status, createdAtText: dateText(item.createdAt) })),
    evidences: evidenceResult.data.map(item => Object.assign({}, item, { createdAtText: dateText(item.createdAt) }))
  }
}

async function createBusinessLine(openid, payload) {
  const name = String(payload.name || '').trim()
  const code = String(payload.code || '').trim()
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : []
  assert(name, '业务线名称不能为空')
  assert(code, '业务线编号不能为空')
  assert(nodes.length > 0, '至少需要一个业务节点')
  assert(nodes.every(node => String(node.name || '').trim()), '节点名称不能为空')

  const duplicate = await db.collection(COLLECTIONS.lines).where({ code, status: _.neq('deleted') }).limit(1).get()
  assert(!duplicate.data.length, '业务线编号已存在', 'DUPLICATE_CODE')

  const createdAt = now()
  const lineData = {
    name,
    code,
    description: String(payload.description || '').trim(),
    status: 'active',
    managerIds: [openid],
    memberIds: [openid],
    currentNodeIndex: 0,
    currentNodeName: String(nodes[0].name).trim(),
    nodeCount: nodes.length,
    progress: 0,
    plannedStartDate: payload.plannedStartDate || '',
    plannedEndDate: payload.plannedEndDate || '',
    templateId: payload.templateId || '',
    createdBy: openid,
    version: 1,
    createdAt,
    updatedAt: createdAt
  }
  const lineResult = await db.collection(COLLECTIONS.lines).add({ data: lineData })

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    await db.collection(COLLECTIONS.nodes).add({
      data: {
        businessLineId: lineResult._id,
        sequence: index,
        name: String(node.name).trim(),
        status: index === 0 ? 'ready' : 'pending',
        assigneeIds: unique(node.assigneeIds),
        assigneeNames: unique(node.assigneeNames),
        watcherIds: unique(node.watcherIds),
        requiresEvidence: Boolean(node.requiresEvidence),
        evidenceTypes: node.evidenceTypes || ['pdf', 'png', 'jpg', 'jpeg'],
        dueDate: node.dueDate || '',
        createdAt,
        updatedAt: createdAt
      }
    })
  }

  await writeAudit(openid, 'create', 'business_line', lineResult._id, { name, code, nodeCount: nodes.length })
  return { id: lineResult._id }
}

async function deleteBusinessLine(openid, payload) {
  const line = await getLine(payload.id)
  assert(isManager(line, openid), '只有业务线管理员可以删除', 'FORBIDDEN')

  await db.collection(COLLECTIONS.lines).doc(line._id).update({
    data: { status: 'deleted', deletedAt: now(), deletedBy: openid, updatedAt: now() }
  })
  await writeAudit(openid, 'delete', 'business_line', line._id, { name: line.name, code: line.code })
  return { id: line._id }
}

async function submitNodeFeedback(openid, payload) {
  assert(payload.businessLineId && payload.nodeId, '缺少业务线或节点 ID')
  assert(['in_progress', 'blocked', 'completed'].includes(payload.status), '不支持的节点状态')

  const line = await getLine(payload.businessLineId)
  const nodeResult = await db.collection(COLLECTIONS.nodes).doc(payload.nodeId).get()
  const node = nodeResult.data
  assert(node && node.businessLineId === line._id, '节点不存在', 'NOT_FOUND')
  assert(isManager(line, openid) || (node.assigneeIds || []).includes(openid), '只有节点负责人或业务线管理员可以反馈', 'FORBIDDEN')

  const evidences = Array.isArray(payload.evidences) ? payload.evidences : []
  if (payload.status === 'completed' && node.requiresEvidence) {
    assert(evidences.length > 0, '该节点完成时必须上传凭证')
  }

  const evidenceIds = []
  for (const evidence of evidences) {
    assert(evidence.fileId && evidence.fileName, '凭证信息不完整')
    const stored = await db.collection(COLLECTIONS.evidences).add({
      data: {
        businessLineId: line._id,
        nodeId: node._id,
        fileId: evidence.fileId,
        fileName: evidence.fileName,
        mimeType: evidence.mimeType || '',
        size: Number(evidence.size || 0),
        uploadedBy: openid,
        createdAt: now()
      }
    })
    evidenceIds.push(stored._id)
  }

  await db.collection(COLLECTIONS.feedback).add({
    data: {
      businessLineId: line._id,
      nodeId: node._id,
      status: payload.status,
      comment: String(payload.comment || '').trim(),
      evidenceIds,
      submittedBy: openid,
      createdAt: now()
    }
  })

  await db.collection(COLLECTIONS.nodes).doc(node._id).update({
    data: {
      status: payload.status,
      latestComment: String(payload.comment || '').trim(),
      latestEvidenceIds: evidenceIds,
      updatedAt: now(),
      completedAt: payload.status === 'completed' ? now() : null
    }
  })

  if (payload.status === 'completed') {
    const nextResult = await db.collection(COLLECTIONS.nodes)
      .where({ businessLineId: line._id, sequence: node.sequence + 1 })
      .limit(1)
      .get()
    const next = nextResult.data[0]

    if (next) {
      await db.collection(COLLECTIONS.nodes).doc(next._id).update({ data: { status: 'ready', activatedAt: now(), updatedAt: now() } })
      const progress = Math.round(((node.sequence + 1) / Math.max(line.nodeCount || node.sequence + 2, 1)) * 100)
      await db.collection(COLLECTIONS.lines).doc(line._id).update({
        data: { currentNodeIndex: next.sequence, currentNodeName: next.name, progress, updatedAt: now() }
      })
      for (const recipientId of next.assigneeIds || []) {
        await db.collection(COLLECTIONS.notifications).add({
          data: {
            recipientId,
            businessLineId: line._id,
            nodeId: next._id,
            type: 'node_activated',
            status: 'pending',
            createdAt: now()
          }
        })
      }
    } else {
      await db.collection(COLLECTIONS.lines).doc(line._id).update({
        data: { status: 'completed', progress: 100, currentNodeName: node.name, completedAt: now(), updatedAt: now() }
      })
    }
  } else {
    await db.collection(COLLECTIONS.lines).doc(line._id).update({
      data: { status: payload.status === 'blocked' ? 'blocked' : 'active', updatedAt: now() }
    })
  }

  await writeAudit(openid, 'feedback', 'business_node', node._id, { status: payload.status, evidenceCount: evidenceIds.length })
  return { id: node._id, status: payload.status }
}

exports.main = async event => {
  const context = cloud.getWXContext()
  const openid = context.OPENID
  const action = event.action
  const payload = event.payload || {}

  try {
    assert(openid, '无法识别当前微信用户', 'UNAUTHORIZED')
    const routes = {
      bootstrap: () => bootstrap(openid),
      dashboard: () => dashboard(openid),
      listBusinessLines: () => listBusinessLines(openid, payload),
      getBusinessLine: () => getBusinessLine(openid, payload),
      getNodeHistory: () => getNodeHistory(openid, payload),
      createBusinessLine: () => createBusinessLine(openid, payload),
      deleteBusinessLine: () => deleteBusinessLine(openid, payload),
      submitNodeFeedback: () => submitNodeFeedback(openid, payload)
    }
    assert(routes[action], '不支持的操作', 'UNKNOWN_ACTION')
    return ok(await routes[action]())
  } catch (error) {
    console.error('[businessApi]', action, error)
    return fail(error.message || '服务异常', error.code || 'INTERNAL_ERROR')
  }
}
