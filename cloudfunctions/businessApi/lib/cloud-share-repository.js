const crypto = require('node:crypto')

const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { ownDataValue, ownExactAccountIds } = require('./account-relationship-schema')

const CHUNK_SIZE = 40
const RELATION_PAGE_SIZE = 100
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

function assertCreateAccess({ actor, line, node, source, reviewed, businessLineId, nodeId }) {
  if (!actor || actor.status !== 'active' || line._id !== businessLineId || node._id !== nodeId ||
      node.businessLineId !== businessLineId || source.businessLineId !== businessLineId || source.nodeId !== nodeId ||
      !['active', 'in_progress', 'completed', 'closed', 'cancelled'].includes(line.status) ||
      node.status !== 'completed' || node.workflowMode !== 'review' ||
      (reviewed
        ? node.lastReviewRoundId !== source._id || source.status !== 'approved' || source.finalDecision !== 'approved'
        : node.lastReviewRoundId != null || source.action !== 'complete_node' || source.status !== 'completed' ||
          source.publishState !== 'published' || source._id !== node.latestFeedbackId ||
          source.revision !== node.latestFeedbackRevision || source.processingRoundNumber !== node.processingRoundNumber)) {
    throw createError('FORBIDDEN')
  }
  const managers = exactIds(line, 'managerUserIds')
  const members = exactIds(line, 'memberUserIds')
  const processors = exactIds(node, 'processorUserIds')
  const reviewers = exactIds(node, 'reviewerUserIds', { nonEmpty: reviewed })
  const sourceReviewers = reviewed ? exactIds(source, 'reviewerUserIds') : []
  if (!reviewed && reviewers.length) throw createError('FORBIDDEN')
  const canShare = managers.includes(actor._id) || processors.includes(actor._id) ||
    reviewers.includes(actor._id) && sourceReviewers.includes(actor._id)
  if (!members.includes(actor._id) || !canShare) {
    throw createError('FORBIDDEN')
  }
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
  if (Array.isArray(value)) {
    if (value.length !== definitions.length || value.length > 100) throw createError('FORBIDDEN')
    const definitionsByKey = new Map(definitions.map(item => [item.fieldKey, item]))
    const result = {}
    for (let index = 0; index < value.length; index += 1) {
      const itemField = Object.getOwnPropertyDescriptor(value, String(index))
      if (!itemField || !Object.hasOwn(itemField, 'value')) throw createError('FORBIDDEN')
      const item = itemField.value
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Reflect.ownKeys(item).some(key => typeof key !== 'string' ||
            !['fieldKey', 'name', 'type', 'value'].includes(key))) {
        throw createError('FORBIDDEN')
      }
      const keyField = ownDataValue(item, 'fieldKey')
      const nameField = ownDataValue(item, 'name')
      const typeField = ownDataValue(item, 'type')
      const valueField = ownDataValue(item, 'value')
      if (!keyField.valid || !nameField.valid || !typeField.valid || !valueField.valid ||
          typeof keyField.value !== 'string' || typeof nameField.value !== 'string' ||
          typeof typeField.value !== 'string' || Object.hasOwn(result, keyField.value)) {
        throw createError('FORBIDDEN')
      }
      const definition = definitionsByKey.get(keyField.value)
      if (!definition || definition.name !== nameField.value || definition.type !== typeField.value) {
        throw createError('FORBIDDEN')
      }
      result[keyField.value] = safeScalar(valueField.value)
    }
    return result
  }
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
  line, node, source, reviewed, shareId, actorId, createdAt, expiresAt, evidenceCount, requestKeyHash, inputHash
}) {
  const definitions = safeDefinitions(node.fieldDefinitions || [])
  return {
    publishState: 'reserved',
    businessLineId: line._id,
    nodeId: node._id,
    reviewRoundId: reviewed ? source._id : null,
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
    completedAt: strictDate(node.completedAt || source.decidedAt || source.createdAt),
    processingRoundNumber: Number.isSafeInteger(source.processingRoundNumber) ? source.processingRoundNumber : 0,
    reviewRoundNumber: reviewed && Number.isSafeInteger(source.reviewRoundNumber) ? source.reviewRoundNumber : 0,
    processingComment: safeText(source.processingComment, 2000),
    fieldDefinitions: definitions,
    fieldValues: safeFieldValues(source.fieldValues || {}, definitions),
    processorDisplayNames: displayNames(source, 'processorDisplayNames'),
    reviewerDisplayNames: displayNames(source, 'reviewerDisplayNames')
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

  async function preloadDirectEvidence(businessLineId, nodeId) {
    const node = await getRequired(nodes.doc(nodeId))
    if (typeof node.lastReviewRoundId === 'string' && node.lastReviewRoundId) return null
    const feedbackId = typeof node.latestFeedbackId === 'string' ? node.latestFeedbackId : ''
    if (!feedbackId) throw createError('FORBIDDEN')
    const ordered = []
    let cursor = ''
    while (true) {
      const criteria = { feedbackId }
      if (cursor) criteria._id = db.command.gt(cursor)
      const page = await evidences.where(criteria).orderBy('_id', 'asc').limit(RELATION_PAGE_SIZE).get()
      if (!page || !Array.isArray(page.data)) throw createError('FORBIDDEN')
      for (const evidence of page.data) {
        const order = ownDataValue(evidence, 'feedbackEvidenceOrder')
        if (!evidence || evidence.businessLineId !== businessLineId || evidence.nodeId !== nodeId ||
            evidence.feedbackId !== feedbackId || evidence.attachmentState !== 'attached' ||
            !order.valid || !Number.isSafeInteger(order.value) || order.value < 0) throw createError('FORBIDDEN')
        ordered.push({ id: evidence._id, order: order.value })
      }
      if (page.data.length < RELATION_PAGE_SIZE) break
      const nextCursor = page.data.at(-1)._id
      if (typeof nextCursor !== 'string' || !nextCursor || nextCursor === cursor) throw createError('FORBIDDEN')
      cursor = nextCursor
    }
    ordered.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].order !== index || index > 0 && ordered[index - 1].id === ordered[index].id) {
        throw createError('FORBIDDEN')
      }
    }
    return { feedbackId, evidenceIds: ordered.map(item => item.id) }
  }

  async function readCreationState(transaction, actorId, businessLineId, nodeId, directEvidence) {
    const actor = await getRequired(transaction.collection('users').doc(actorId))
    const line = await getRequired(transaction.collection('business_lines').doc(businessLineId))
    const node = await getRequired(transaction.collection('business_nodes').doc(nodeId))
    const roundId = typeof node.lastReviewRoundId === 'string' ? node.lastReviewRoundId : ''
    const reviewed = Boolean(roundId)
    let source = reviewed
      ? await getRequired(transaction.collection('node_review_rounds').doc(roundId))
      : await getRequired(transaction.collection('node_feedback').doc(node.latestFeedbackId || ''))
    if (!reviewed) {
      const comment = ownDataValue(source, 'comment')
      if (!comment.valid || typeof comment.value !== 'string' || comment.value.length > 1000) {
        throw createError('FORBIDDEN')
      }
      source = {
        ...source,
        processingComment: comment.value,
        processorDisplayNames: displayNames(node, 'processorDisplayNames'),
        reviewerDisplayNames: []
      }
    }
    assertCreateAccess({ actor, line, node, source, reviewed, businessLineId, nodeId })
    const evidenceIds = reviewed
      ? exactIds(source, 'evidenceIds', { nonEmpty: false })
      : directEvidence && directEvidence.feedbackId === source._id &&
          Number.isSafeInteger(source.evidenceCount) && source.evidenceCount === directEvidence.evidenceIds.length &&
          Number.isSafeInteger(source.claimedCount) && source.claimedCount === source.evidenceCount
        ? directEvidence.evidenceIds.slice()
        : (() => { throw createError('FORBIDDEN') })()
    return { actor, line, node, source, reviewed, evidenceIds }
  }

  return {
    async createSnapshot({
      actor, businessLineId, nodeId, token, createdAt, expiresAt, requestKeyHash, inputHash
    }) {
      strictDate(createdAt)
      strictDate(expiresAt)
      if (!SHA256.test(requestKeyHash) || !SHA256.test(inputHash)) throw createError('VALIDATION_ERROR')
      const shareId = shareIdForToken(token)
      const directEvidence = await preloadDirectEvidence(businessLineId, nodeId)
      const reservation = await db.runTransaction(async transaction => {
        const current = await readCreationState(transaction, actor._id, businessLineId, nodeId, directEvidence)
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
          const current = await readCreationState(transaction, actor._id, businessLineId, nodeId, directEvidence)
          if (JSON.stringify(current.evidenceIds) !== JSON.stringify(reservation.evidenceIds)) throw createError('VERSION_CONFLICT')
          const header = await getRequired(transaction.collection('public_node_shares').doc(shareId))
          if (header.publishState !== 'reserved' || header.claimedCount !== offset ||
              strictDate(header.expiresAt).getTime() !== effectiveExpiresAt.getTime()) throw createError('VERSION_CONFLICT')
          const publicEvidences = []
          for (let index = 0; index < ids.length; index += 1) {
            const id = ids[index]
            const evidence = await getRequired(transaction.collection('evidences').doc(id))
            if (evidence.businessLineId !== businessLineId || evidence.nodeId !== nodeId ||
                evidence.storageStatus !== 'available' || evidence.purgedAt != null ||
                typeof evidence.fileId !== 'string' || !CLOUD_FILE_ID.test(evidence.fileId) ||
                typeof evidence.fileName !== 'string' || !evidence.fileName || evidence.fileName.length > 255 ||
                typeof evidence.category !== 'string' || !evidence.category || evidence.category.length > 32 ||
                !Number.isSafeInteger(evidence.size) || evidence.size < 0 ||
                !current.reviewed && (evidence.feedbackId !== current.source._id ||
                  evidence.attachmentState !== 'attached' ||
                  evidence.feedbackEvidenceOrder !== offset + index)) throw createError('FORBIDDEN')
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
        await readCreationState(transaction, actor._id, businessLineId, nodeId, directEvidence)
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
