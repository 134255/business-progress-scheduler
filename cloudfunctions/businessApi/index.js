const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const {
  unique,
  isManager,
  isMember,
  canFeedback,
  canTransitionNode,
  calculateProgress,
  normalizeLineInput
} = require('./lib/domain')
const { bootstrapUser } = require('./lib/bootstrap-user')

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

function now() {
  return db.serverDate()
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
  return bootstrapUser({
    users: db.collection(COLLECTIONS.users),
    openid,
    now
  })
}

async function updateUserProfile(openid, payload) {
  const displayName = String(payload.displayName || '').trim()
  const avatarUrl = String(payload.avatarUrl || '').trim()
  assert(displayName.length >= 1 && displayName.length <= 30, '昵称长度需为 1-30 个字符')
  assert(!avatarUrl || avatarUrl.startsWith('cloud://') || avatarUrl.startsWith('https://'), '头像地址不合法')

  const users = db.collection(COLLECTIONS.users)
  const existing = await users.where({ openid }).limit(1).get()
  assert(existing.data.length, '用户档案不存在', 'NOT_FOUND')
  await users.doc(existing.data[0]._id).update({ data: { displayName, avatarUrl, updatedAt: now() } })
  await writeAudit(openid, 'update_profile', 'user', existing.data[0]._id, { displayName })
  return Object.assign({}, existing.data[0], { displayName, avatarUrl })
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
  const page = Math.max(1, Number(query.page || 1))
  const pageSize = Math.min(50, Math.max(5, Number(query.pageSize || 20)))
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

  const offset = (page - 1) * pageSize
  return {
    items: items.slice(offset, offset + pageSize),
    page,
    pageSize,
    total: items.length,
    hasMore: offset + pageSize < items.length
  }
}

async function getBusinessLine(openid, payload) {
  const line = await getLine(payload.id)
  assert(isMember(line, openid), '你不是该业务线的关联成员', 'FORBIDDEN')

  const nodesResult = await db.collection(COLLECTIONS.nodes)
    .where({ businessLineId: line._id })
    .orderBy('sequence', 'asc')
    .get()

  const nodes = nodesResult.data.map(node => Object.assign({}, node, {
    canFeedback: canFeedback(line, node, openid),
    assigneeNamesText: (node.assigneeNames || []).join('、')
  }))

  const canManage = isManager(line, openid)
  const canEditNodes = canManage && Number(line.progress || 0) === 0 && nodes.every(node => ['pending', 'ready'].includes(node.status) && !node.latestComment)
  return { line, nodes, canManage, canEditNodes }
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
    canFeedback: canFeedback(line, node, openid),
    history: feedbackResult.data.map(item => Object.assign({}, item, { statusLabel: labels[item.status] || item.status, createdAtText: dateText(item.createdAt) })),
    evidences: evidenceResult.data.map(item => Object.assign({}, item, { createdAtText: dateText(item.createdAt) }))
  }
}

async function createBusinessLine(openid, payload) {
  const normalized = normalizeLineInput(payload)
  const { name, code, description, plannedStartDate, plannedEndDate } = normalized
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
    description,
    status: 'active',
    managerIds: [openid],
    memberIds: [openid],
    currentNodeIndex: 0,
    currentNodeName: String(nodes[0].name).trim(),
    nodeCount: nodes.length,
    progress: 0,
    plannedStartDate,
    plannedEndDate,
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

async function updateBusinessLine(openid, payload) {
  const line = await getLine(payload.id)
  assert(isManager(line, openid), '只有业务线管理员可以编辑', 'FORBIDDEN')
  assert(Number(payload.version) === Number(line.version), '业务线已被其他人更新，请刷新后重试', 'VERSION_CONFLICT')

  const normalized = normalizeLineInput(payload)
  assert(normalized.name, '业务线名称不能为空')
  assert(normalized.code, '业务线编号不能为空')
  const duplicate = await db.collection(COLLECTIONS.lines).where({ code: normalized.code, status: _.neq('deleted') }).limit(5).get()
  assert(!duplicate.data.some(item => item._id !== line._id), '业务线编号已存在', 'DUPLICATE_CODE')

  const nodes = Array.isArray(payload.nodes) ? payload.nodes : []
  const replaceNodes = Boolean(payload.replaceNodes)
  if (replaceNodes) {
    assert(Number(line.progress || 0) === 0, '业务已开始流转，不能再修改节点结构', 'NODE_STRUCTURE_LOCKED')
    assert(nodes.length > 0 && nodes.every(node => String(node.name || '').trim()), '至少需要一个有效业务节点')
    const existingNodes = await db.collection(COLLECTIONS.nodes).where({ businessLineId: line._id }).get()
    assert(existingNodes.data.every(node => ['pending', 'ready'].includes(node.status) && !node.latestComment), '节点已有反馈，不能修改节点结构', 'NODE_STRUCTURE_LOCKED')
  }

  const nextVersion = Number(line.version || 1) + 1
  const lineChanges = Object.assign({}, normalized, { version: nextVersion, updatedAt: now() })
  if (replaceNodes) {
    lineChanges.nodeCount = nodes.length
    lineChanges.currentNodeIndex = 0
    lineChanges.currentNodeName = String(nodes[0].name).trim()
  }
  const updated = await db.collection(COLLECTIONS.lines).where({ _id: line._id, version: line.version }).update({ data: lineChanges })
  assert(updated.stats && updated.stats.updated === 1, '业务线已被其他人更新，请刷新后重试', 'VERSION_CONFLICT')

  if (replaceNodes) {
    await db.collection(COLLECTIONS.nodes).where({ businessLineId: line._id }).remove()
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]
      await db.collection(COLLECTIONS.nodes).add({
        data: {
          businessLineId: line._id,
          sequence: index,
          name: String(node.name).trim(),
          status: index === 0 ? 'ready' : 'pending',
          assigneeIds: unique(node.assigneeIds),
          assigneeNames: unique(node.assigneeNames),
          watcherIds: unique(node.watcherIds),
          requiresEvidence: Boolean(node.requiresEvidence),
          evidenceTypes: node.evidenceTypes || ['pdf', 'png', 'jpg', 'jpeg'],
          dueDate: node.dueDate || '',
          createdAt: now(),
          updatedAt: now()
        }
      })
    }
  }

  await writeAudit(openid, 'update', 'business_line', line._id, { beforeVersion: line.version, afterVersion: nextVersion, replaceNodes })
  return { id: line._id, version: nextVersion }
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
  assert(canFeedback(line, node, openid), '只有节点负责人或业务线管理员可以反馈', 'FORBIDDEN')
  assert(canTransitionNode(node.status, payload.status), '当前节点状态不允许执行该操作', 'INVALID_TRANSITION')

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
      const progress = calculateProgress(node.sequence + 1, line.nodeCount || node.sequence + 2)
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
      updateUserProfile: () => updateUserProfile(openid, payload),
      dashboard: () => dashboard(openid),
      listBusinessLines: () => listBusinessLines(openid, payload),
      getBusinessLine: () => getBusinessLine(openid, payload),
      getNodeHistory: () => getNodeHistory(openid, payload),
      createBusinessLine: () => createBusinessLine(openid, payload),
      updateBusinessLine: () => updateBusinessLine(openid, payload),
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
