const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { ownDataValue, ownExactAccountIds } = require('./account-relationship-schema')

const CHUNK_SIZE = 40
const TEMP_URL_SECONDS = 300
const CLOUD_FILE_ID = /^cloud:\/\/[A-Za-z0-9._:/-]{1,1000}$/
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const SHA256 = /^[a-f0-9]{64}$/

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function shareIdForToken(token) {
  return `share-${crypto.createHash('sha256').update(token).digest('hex')}`
}

async function getRequired(reference, code = 'FORBIDDEN') {
  try {
    return (await reference.get()).data
  } catch (_error) {
    throw createError(code)
  }
}

function strictDate(value, code = 'FORBIDDEN') {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw createError(code)
  return value
}

function exactIds(value, key, { nonEmpty = true } = {}) {
  const result = ownExactAccountIds(value, key, { nonEmpty })
  if (!result) throw createError('FORBIDDEN')
  return result
}

function assertCreateAccess({ actor, line, node, round, businessLineId, nodeId }) {
  if (!actor || actor.status !== 'active' || line._id !== businessLineId || node._id !== nodeId ||
      node.businessLineId !== businessLineId || round.businessLineId !== businessLineId || round.nodeId !== nodeId ||
      !['active', 'in_progress', 'completed', 'closed', 'cancelled'].includes(line.status) ||
      node.status !== 'completed' || node.workflowMode !== 'review' ||
      node.lastReviewRoundId !== round._id || round.status !== 'approved' || round.finalDecision !== 'approved') {
    throw createError('FORBIDDEN')
  }
  const managers = exactIds(line, 'managerUserIds')
  const members = exactIds(line, 'memberUserIds')
  const processors = exactIds(node, 'processorUserIds')
  const reviewers = exactIds(node, 'reviewerUserIds')
  const roundReviewers = exactIds(round, 'reviewerUserIds')
  const canShare = managers.includes(actor._id) || processors.includes(actor._id) ||
    reviewers.includes(actor._id) && roundReviewers.includes(actor._id)
  if (!members.includes(actor._id) || !canShare) {
    throw createError('FORBIDDEN')
  }
  const evidenceIds = exactIds(round, 'evidenceIds', { nonEmpty: false })
  return evidenceIds
}

function safeText(value, maximum = 500) {
  return typeof value === 'string' && value.length <= maximum ? value : ''
}

function safeDefinitions(value) {
  if (!Array.isArray(value) || value.length > 100) throw createError('FORBIDDEN')
  const result = []
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))
    if (!item || !Object.hasOwn(item, 'value')) throw createError('FORBIDDEN')
    const definition = item.value
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw createError('FORBIDDEN')
    const keyField = ownDataValue(definition, 'fieldKey')
    const sequenceField = ownDataValue(definition, 'sequence')
    const nameField = ownDataValue(definition, 'name')
    const typeField = ownDataValue(definition, 'type')
    const requiredField = ownDataValue(definition, 'required')
    if (!keyField.valid || sequenceField.present && !sequenceField.valid ||
        nameField.present && !nameField.valid || typeField.present && !typeField.valid ||
        requiredField.present && !requiredField.valid) throw createError('FORBIDDEN')
    const fieldKey = safeText(keyField.value, 64)
    if (!SAFE_KEY.test(fieldKey)) throw createError('FORBIDDEN')
    if (sequenceField.present && !Number.isSafeInteger(sequenceField.value) ||
        requiredField.present && typeof requiredField.value !== 'boolean') throw createError('FORBIDDEN')
    result.push({
      fieldKey,
      sequence: sequenceField.present ? sequenceField.value : index,
      name: safeText(nameField.value, 100),
      type: safeText(typeField.value, 32),
      required: requiredField.value === true
    })
  }
  return result
}

function safeScalar(value) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string' && value.length <= 2000) return value
  if (Number.isFinite(value)) return value
  if (Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string' && item.length <= 500)) {
    return value.slice()
  }
  throw createError('FORBIDDEN')
}

function safeFieldValues(value, definitions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw createError('FORBIDDEN')
  const allowed = new Set(definitions.map(item => item.fieldKey))
  const result = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw createError('FORBIDDEN')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw createError('FORBIDDEN')
    result[key] = safeScalar(descriptor.value)
  }
  return result
}

function displayNames(round, key) {
  const field = ownDataValue(round, key)
  if (!field.valid) throw createError('FORBIDDEN')
  const value = field.value
  if (!Array.isArray(value) || value.length > 100 ||
      value.length !== Object.keys(value).length ||
      value.some(item => typeof item !== 'string' || !item.trim() || item.length > 100)) {
    throw createError('FORBIDDEN')
  }
  return value.map(item => item.trim())
}

function headerSnapshot({
  line, node, round, shareId, actorId, createdAt, expiresAt, evidenceCount, requestKeyHash, inputHash
}) {
  const definitions = safeDefinitions(node.fieldDefinitions || [])
  return {
    _id: shareId,
    publishState: 'reserved',
    businessLineId: line._id,
    nodeId: node._id,
    reviewRoundId: round._id,
    createdByUserId: actorId,
    requestKeyHash,
    inputHash,
    createdAt,
    expiresAt,
    evidenceCount,
    claimedCount: 0,
    chunkCount: Math.ceil(evidenceCount / CHUNK_SIZE),
    businessCode: safeText(line.code, 128),
    businessName: safeText(line.name, 200),
    nodeCode: safeText(node.nodeCode, 128),
    nodeName: safeText(node.name, 200),
    completedAt: strictDate(node.completedAt || round.decidedAt),
    processingRoundNumber: Number.isSafeInteger(round.processingRoundNumber) ? round.processingRoundNumber : 0,
    reviewRoundNumber: Number.isSafeInteger(round.reviewRoundNumber) ? round.reviewRoundNumber : 0,
    processingComment: safeText(round.processingComment, 2000),
    fieldDefinitions: definitions,
    fieldValues: safeFieldValues(round.fieldValues || {}, definitions),
    processorDisplayNames: displayNames(round, 'processorDisplayNames'),
    reviewerDisplayNames: displayNames(round, 'reviewerDisplayNames')
  }
}

function chunkDocumentId(shareId, index) {
  return `${shareId}-chunk-${String(index).padStart(6, '0')}`
}

function maxHold(current, expiresAt) {
  return current instanceof Date && !Number.isNaN(current.getTime()) && current > expiresAt ? current : expiresAt
}

function createCloudShareRepository({ db, cloud, clock = () => new Date() }) {
  const users = db.collection('users')
  const lines = db.collection('business_lines')
  const nodes = db.collection('business_nodes')
  const rounds = db.collection('node_review_rounds')
  const evidences = db.collection('evidences')
  const shares = db.collection('public_node_shares')
  const chunks = db.collection('public_node_share_chunks')

  async function readCreationState(transaction, actorId, businessLineId, nodeId) {
    const actor = await getRequired(transaction.collection('users').doc(actorId))
    const line = await getRequired(transaction.collection('business_lines').doc(businessLineId))
    const node = await getRequired(transaction.collection('business_nodes').doc(nodeId))
    const roundId = typeof node.lastReviewRoundId === 'string' ? node.lastReviewRoundId : ''
    if (!roundId) throw createError('FORBIDDEN')
    const round = await getRequired(transaction.collection('node_review_rounds').doc(roundId))
    const evidenceIds = assertCreateAccess({ actor, line, node, round, businessLineId, nodeId })
    return { actor, line, node, round, evidenceIds }
  }

  return {
    async createSnapshot({
      actor, businessLineId, nodeId, token, createdAt, expiresAt, requestKeyHash, inputHash
    }) {
      strictDate(createdAt)
      strictDate(expiresAt)
      if (!SHA256.test(requestKeyHash) || !SHA256.test(inputHash)) throw createError('VALIDATION_ERROR')
      const shareId = shareIdForToken(token)
      const reservation = await db.runTransaction(async transaction => {
        const current = await readCreationState(transaction, actor._id, businessLineId, nodeId)
        let existing = null
        try { existing = (await transaction.collection('public_node_shares').doc(shareId).get()).data } catch (_error) {}
        if (existing) {
          const existingExpiry = strictDate(existing.expiresAt)
          if (existing.businessLineId !== businessLineId || existing.nodeId !== nodeId ||
              existing.createdByUserId !== actor._id || existing.requestKeyHash !== requestKeyHash ||
              existing.inputHash !== inputHash || existing.evidenceCount !== current.evidenceIds.length ||
              !Number.isSafeInteger(existing.claimedCount) || existing.claimedCount < 0 ||
              existing.claimedCount > existing.evidenceCount || existingExpiry <= createdAt ||
              !['reserved', 'published'].includes(existing.publishState)) throw createError('VERSION_CONFLICT')
          return {
            evidenceIds: current.evidenceIds,
            claimedCount: existing.claimedCount,
            expiresAt: existingExpiry,
            published: existing.publishState === 'published'
          }
        }
        const header = headerSnapshot({
          ...current, shareId, actorId: actor._id, createdAt, expiresAt,
          evidenceCount: current.evidenceIds.length, requestKeyHash, inputHash
        })
        await transaction.collection('public_node_shares').doc(shareId).set({ data: header })
        return { evidenceIds: current.evidenceIds, claimedCount: 0, expiresAt, published: false }
      })

      if (reservation.published) return { shareId, expiresAt: reservation.expiresAt }
      const effectiveExpiresAt = reservation.expiresAt

      for (let offset = reservation.claimedCount; offset < reservation.evidenceIds.length; offset += CHUNK_SIZE) {
        const ids = reservation.evidenceIds.slice(offset, offset + CHUNK_SIZE)
        await db.runTransaction(async transaction => {
          const current = await readCreationState(transaction, actor._id, businessLineId, nodeId)
          if (JSON.stringify(current.evidenceIds) !== JSON.stringify(reservation.evidenceIds)) throw createError('VERSION_CONFLICT')
          const header = await getRequired(transaction.collection('public_node_shares').doc(shareId))
          if (header.publishState !== 'reserved' || header.claimedCount !== offset ||
              strictDate(header.expiresAt).getTime() !== effectiveExpiresAt.getTime()) throw createError('VERSION_CONFLICT')
          const publicEvidences = []
          for (const id of ids) {
            const evidence = await getRequired(transaction.collection('evidences').doc(id))
            if (evidence.businessLineId !== businessLineId || evidence.nodeId !== nodeId ||
                evidence.storageStatus !== 'available' || evidence.purgedAt != null ||
                typeof evidence.fileId !== 'string' || !CLOUD_FILE_ID.test(evidence.fileId) ||
                typeof evidence.fileName !== 'string' || !evidence.fileName || evidence.fileName.length > 255 ||
                typeof evidence.category !== 'string' || !evidence.category || evidence.category.length > 32 ||
                !Number.isSafeInteger(evidence.size) || evidence.size < 0) throw createError('FORBIDDEN')
            publicEvidences.push({ evidenceId: id, fileName: evidence.fileName, category: evidence.category, size: evidence.size })
            await transaction.collection('evidences').doc(id).update({
              data: { publicShareHoldUntil: maxHold(evidence.publicShareHoldUntil, effectiveExpiresAt) }
            })
          }
          const chunkId = chunkDocumentId(shareId, offset / CHUNK_SIZE)
          await transaction.collection('public_node_share_chunks').doc(chunkId).set({
            data: { shareId, index: offset / CHUNK_SIZE, evidences: publicEvidences, createdAt, expiresAt: effectiveExpiresAt }
          })
          await transaction.collection('public_node_shares').doc(shareId).update({ data: { claimedCount: offset + ids.length } })
        })
      }

      await db.runTransaction(async transaction => {
        await readCreationState(transaction, actor._id, businessLineId, nodeId)
        const header = await getRequired(transaction.collection('public_node_shares').doc(shareId))
        if (header.publishState !== 'reserved' || header.claimedCount !== header.evidenceCount) {
          throw createError('VERSION_CONFLICT')
        }
        await transaction.collection('public_node_shares').doc(shareId).update({ data: { publishState: 'published' } })
        await transaction.collection('audit_logs').doc(`${shareId}-created`).set({ data: {
          actorId: actor._id,
          action: 'CREATE_PUBLIC_NODE_SHARE',
          targetType: 'public_node_share',
          targetId: shareId,
          businessLineId,
          nodeId,
          resultCode: 'PUBLIC_NODE_SHARE_CREATED',
          createdAt
        } })
      })
      return { shareId, expiresAt: reservation.expiresAt }
    },

    async getPublicSnapshot({ token, cursor = '', pageSize = 40 }) {
      const shareId = shareIdForToken(token)
      const now = clock()
      strictDate(now, 'SHARE_UNAVAILABLE')
      const header = await getRequired(shares.doc(shareId), 'SHARE_UNAVAILABLE')
      const expiresAt = strictDate(header.expiresAt, 'SHARE_UNAVAILABLE')
      if (header.publishState !== 'published' || expiresAt <= now) throw createError('SHARE_UNAVAILABLE')
      const offset = cursor === '' ? 0 : Number(cursor)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 40) {
        throw createError('VALIDATION_ERROR')
      }
      if (!Number.isSafeInteger(header.evidenceCount) || header.evidenceCount < 0 ||
          !Number.isSafeInteger(header.chunkCount) || header.chunkCount !== Math.ceil(header.evidenceCount / CHUNK_SIZE)) {
        throw createError('SHARE_UNAVAILABLE')
      }
      if (offset > header.evidenceCount) throw createError('VALIDATION_ERROR')
      const selected = []
      let position = offset
      while (selected.length < pageSize && position < header.evidenceCount) {
        const chunkIndex = Math.floor(position / CHUNK_SIZE)
        const chunk = await getRequired(chunks.doc(chunkDocumentId(shareId, chunkIndex)), 'SHARE_UNAVAILABLE')
        const expectedChunkLength = Math.min(CHUNK_SIZE, header.evidenceCount - chunkIndex * CHUNK_SIZE)
        if (chunk.shareId !== shareId || chunk.index !== chunkIndex || !Array.isArray(chunk.evidences) ||
            chunk.evidences.length !== expectedChunkLength) throw createError('SHARE_UNAVAILABLE')
        const innerOffset = position % CHUNK_SIZE
        if (innerOffset >= chunk.evidences.length) throw createError('SHARE_UNAVAILABLE')
        const take = Math.min(pageSize - selected.length, chunk.evidences.length - innerOffset)
        selected.push(...chunk.evidences.slice(innerOffset, innerOffset + take))
        position += take
      }
      const currentEvidences = []
      for (const item of selected) {
        const evidence = await getRequired(evidences.doc(item.evidenceId), 'SHARE_UNAVAILABLE')
        if (evidence.storageStatus !== 'available' || evidence.purgedAt != null ||
            !(evidence.publicShareHoldUntil instanceof Date) || evidence.publicShareHoldUntil <= now ||
            evidence.fileName !== item.fileName || evidence.category !== item.category || evidence.size !== item.size ||
            typeof evidence.fileId !== 'string' || !CLOUD_FILE_ID.test(evidence.fileId)) {
          throw createError('SHARE_UNAVAILABLE')
        }
        currentEvidences.push({ ...item, fileId: evidence.fileId })
      }
      let urls = []
      if (currentEvidences.length) {
        const result = await cloud.getTempFileURL({
          fileList: currentEvidences.map(item => ({ fileID: item.fileId, maxAge: TEMP_URL_SECONDS }))
        })
        if (!result || !Array.isArray(result.fileList) || result.fileList.length !== currentEvidences.length) {
          throw createError('SHARE_UNAVAILABLE')
        }
        urls = result.fileList.map(item => item.tempFileURL)
        if (urls.some(url => typeof url !== 'string' || !/^https:\/\//.test(url))) throw createError('SHARE_UNAVAILABLE')
      }
      const finalHeader = await getRequired(shares.doc(shareId), 'SHARE_UNAVAILABLE')
      if (finalHeader.publishState !== 'published' || strictDate(finalHeader.expiresAt, 'SHARE_UNAVAILABLE') <= clock()) {
        throw createError('SHARE_UNAVAILABLE')
      }
      const nextOffset = offset + selected.length
      return {
        businessCode: header.businessCode,
        businessName: header.businessName,
        nodeCode: header.nodeCode,
        nodeName: header.nodeName,
        completedAt: header.completedAt,
        processingRoundNumber: header.processingRoundNumber,
        reviewRoundNumber: header.reviewRoundNumber,
        processingComment: header.processingComment,
        fieldDefinitions: header.fieldDefinitions,
        fieldValues: header.fieldValues,
        expiresAt,
        evidences: currentEvidences.map((item, index) => ({
          fileName: item.fileName, category: item.category, size: item.size, url: urls[index]
        })),
        hasMore: nextOffset < header.evidenceCount,
        nextCursor: nextOffset < header.evidenceCount ? String(nextOffset) : ''
      }
    }
  }
}

module.exports = { CHUNK_SIZE, createCloudShareRepository, shareIdForToken }
