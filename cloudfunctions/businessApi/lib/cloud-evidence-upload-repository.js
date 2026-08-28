const { APPLICATION_ERROR_MARKER } = require('./cloud-template-repository')
const { FEEDBACK_TOTAL_LIMIT, classifyHeader } = require('./evidence-policy')
const {
  effectiveAllowedEvidenceTypes,
  hasOwnAccountRelationship
} = require('./cloud-evidence-repository')
const { ownExactAccountIds } = require('./account-relationship-schema')

const COLLECTIONS = Object.freeze({
  users: 'users',
  lines: 'business_lines',
  nodes: 'business_nodes',
  evidences: 'evidences'
})
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/
const TOKEN_HASH = /^[a-f0-9]{64}$/
const OBJECT_KEY = /^evidence-uploads\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/(evidence-[a-f0-9]{64})\.([a-z0-9]+)$/
const ACTIVE_NODE_STATUSES = new Set(['ready', 'in_progress', 'blocked'])
const QUERY_PAGE_SIZE = 100
const HEADER_BYTES = 64
const COS_UPLOAD_ACTIONS = Object.freeze([
  'name/cos:PutObject',
  'name/cos:InitiateMultipartUpload',
  'name/cos:ListMultipartUploads',
  'name/cos:ListParts',
  'name/cos:UploadPart',
  'name/cos:CompleteMultipartUpload',
  'name/cos:AbortMultipartUpload'
])

function createError(code) {
  const error = new Error(code)
  error.code = code
  error[APPLICATION_ERROR_MARKER] = true
  return error
}

function safeDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null
}

function exactId(value) {
  if (typeof value !== 'string' || !DOCUMENT_ID.test(value)) throw createError('EVIDENCE_NOT_ATTACHABLE')
  return value
}

function memberships(value) {
  return Array.isArray(value) ? value : []
}

function usesAccountAuthorization(line, node) {
  return hasOwnAccountRelationship(line) || hasOwnAccountRelationship(node)
}

function isMember(line, actor, accountSchema) {
  return accountSchema
    ? [...memberships(line.managerUserIds), ...memberships(line.memberUserIds)].includes(actor._id)
    : Boolean(actor.openid) && [...memberships(line.managerIds), ...memberships(line.memberIds)].includes(actor.openid)
}

function isCurrentNode(line, node) {
  if (Object.prototype.hasOwnProperty.call(line, 'currentNodeId')) return line.currentNodeId === node._id
  return Number.isSafeInteger(line.currentNodeIndex) && Number(node.sequence) === line.currentNodeIndex
}

function isProcessor(node, actor, accountSchema) {
  if (node.workflowMode === 'review') {
    if (!accountSchema) return false
    const processors = ownExactAccountIds(node, 'processorUserIds', { nonEmpty: true })
    const reviewers = ownExactAccountIds(node, 'reviewerUserIds', { nonEmpty: true })
    return Boolean(processors && reviewers && !processors.some(id => reviewers.includes(id)) &&
      processors.includes(actor._id) && !Object.prototype.hasOwnProperty.call(node, 'assigneeUserIds'))
  }
  if (Object.prototype.hasOwnProperty.call(node, 'workflowMode')) return false
  if (accountSchema) {
    const assignees = ownExactAccountIds(node, 'assigneeUserIds', { nonEmpty: true })
    return Boolean(assignees && assignees.includes(actor._id) &&
      !Object.prototype.hasOwnProperty.call(node, 'processorUserIds') &&
      !Object.prototype.hasOwnProperty.call(node, 'reviewerUserIds'))
  }
  return Boolean(actor.openid) && memberships(node.assigneeIds).includes(actor.openid)
}

function createCloudEvidenceUploadRepository({ db, storage, clock = () => new Date(), cloudFilePrefix }) {
  if (!db || !storage || typeof storage.headObject !== 'function' || typeof storage.readObjectHeader !== 'function') {
    throw new TypeError('db and storage are required')
  }
  if (typeof cloudFilePrefix !== 'string' || !/^cloud:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cloudFilePrefix)) {
    throw new TypeError('cloudFilePrefix is invalid')
  }

  async function readDocument(database, collectionName, id) {
    try {
      const result = await database.collection(collectionName).doc(id).get()
      return result && result.data ? result.data : null
    } catch (error) {
      const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
      if (String(error && (error.code || error.errCode) || '').toUpperCase() === 'DOCUMENT_NOT_FOUND' ||
          text.includes('document with _id') && text.includes('does not exist')) return null
      throw error
    }
  }

  async function authorize(database, actorId, businessLineId, nodeId, expectedNodeVersion) {
    const actor = await readDocument(database, COLLECTIONS.users, actorId)
    if (!actor || actor.status !== 'active') throw createError('FORBIDDEN')
    const line = await readDocument(database, COLLECTIONS.lines, businessLineId)
    if (!line || line.status === 'creating') throw createError('NOT_FOUND')
    if (line.status !== 'active') throw createError('NODE_NOT_ACTIVE')
    const node = await readDocument(database, COLLECTIONS.nodes, nodeId)
    if (!node || node.businessLineId !== line._id) throw createError('NOT_FOUND')
    const accountSchema = usesAccountAuthorization(line, node)
    if (!isMember(line, actor, accountSchema) || !isCurrentNode(line, node) ||
        !ACTIVE_NODE_STATUSES.has(node.status)) throw createError('NODE_NOT_ACTIVE')
    if (!isProcessor(node, actor, accountSchema)) throw createError('FORBIDDEN')
    if (node.version !== expectedNodeVersion) throw createError('VERSION_CONFLICT')
    if (!Number.isSafeInteger(node.processingRoundNumber) || node.processingRoundNumber < 1) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    return {
      actor,
      line,
      node,
      processingRoundNumber: node.processingRoundNumber,
      allowedTypes: effectiveAllowedEvidenceTypes(node, accountSchema)
    }
  }

  function validateReservation(actor, reservation) {
    const actorId = exactId(actor && actor._id)
    if (!reservation || typeof reservation !== 'object' || reservation.actorId !== actorId) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    const evidenceId = exactId(reservation.evidenceId)
    const businessLineId = exactId(reservation.businessLineId)
    const nodeId = exactId(reservation.nodeId)
    const match = typeof reservation.objectKey === 'string' ? OBJECT_KEY.exec(reservation.objectKey) : null
    if (!match || match[1] !== businessLineId || match[2] !== nodeId || match[3] !== evidenceId ||
        match[4] !== reservation.extension || !TOKEN_HASH.test(reservation.uploadSessionTokenHash) ||
        !Number.isSafeInteger(reservation.expectedNodeVersion) || reservation.expectedNodeVersion < 1 ||
        !Number.isSafeInteger(reservation.declaredSize) || reservation.declaredSize < 1 ||
        reservation.declaredSize > FEEDBACK_TOTAL_LIMIT || !safeDate(reservation.uploadSessionExpiresAt) ||
        !safeDate(reservation.orphanExpiresAt) || reservation.orphanExpiresAt <= reservation.uploadSessionExpiresAt) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    return { actorId, evidenceId, businessLineId, nodeId }
  }

  async function reserveUpload({ actor, reservation }) {
    const value = validateReservation(actor, reservation)
    return db.runTransaction(async transaction => {
      const current = await authorize(
        transaction, value.actorId, value.businessLineId, value.nodeId, reservation.expectedNodeVersion
      )
      const existing = await readDocument(transaction, COLLECTIONS.evidences, value.evidenceId)
      if (existing) throw createError('EVIDENCE_NOT_ATTACHABLE')
      if (!current.allowedTypes.includes(reservation.extension)) throw createError('UNSUPPORTED_FILE_TYPE')
      const at = clock()
      if (!safeDate(at)) throw new TypeError('clock must return a Date')
      const fileId = `${cloudFilePrefix}/${reservation.objectKey}`
      await transaction.collection(COLLECTIONS.evidences).doc(value.evidenceId).set({
        data: {
          businessLineId: value.businessLineId,
          nodeId: value.nodeId,
          processingRoundNumber: current.processingRoundNumber,
          nodeVersionAtUpload: reservation.expectedNodeVersion,
          fileId,
          fileName: reservation.fileName,
          extension: reservation.extension,
          declaredSize: reservation.declaredSize,
          objectKey: reservation.objectKey,
          uploadedBy: value.actorId,
          storageStatus: 'uploading',
          attachmentState: 'unattached',
          uploadSessionTokenHash: reservation.uploadSessionTokenHash,
          uploadSessionExpiresAt: reservation.uploadSessionExpiresAt,
          orphanExpiresAt: reservation.orphanExpiresAt,
          createdAt: at,
          updatedAt: at
        }
      })
      return { evidenceId: value.evidenceId, processingRoundNumber: current.processingRoundNumber }
    })
  }

  function safeAvailableProjection(evidence) {
    return {
      evidenceId: evidence._id,
      fileName: evidence.fileName,
      category: evidence.category,
      size: evidence.size,
      storageStatus: 'available'
    }
  }

  async function preflightFinalize(actor, evidenceId, tokenHash, expectedNodeVersion) {
    return db.runTransaction(async transaction => {
      const evidence = await readDocument(transaction, COLLECTIONS.evidences, evidenceId)
      if (!evidence || evidence.uploadedBy !== actor._id || evidence.uploadSessionTokenHash !== tokenHash) {
        throw createError('FORBIDDEN')
      }
      if (evidence.nodeVersionAtUpload !== expectedNodeVersion) throw createError('VERSION_CONFLICT')
      const user = await readDocument(transaction, COLLECTIONS.users, actor._id)
      if (!user || user.status !== 'active') throw createError('FORBIDDEN')
      if (evidence.storageStatus === 'available') return { available: safeAvailableProjection(evidence) }
      if (evidence.storageStatus !== 'uploading') throw createError('EVIDENCE_NOT_ATTACHABLE')
      const expiresAt = safeDate(evidence.uploadSessionExpiresAt)
      const at = clock()
      if (!safeDate(at)) throw new TypeError('clock must return a Date')
      if (!expiresAt || expiresAt <= at) throw createError('EVIDENCE_UPLOAD_EXPIRED')
      const authorized = await authorize(
        transaction, actor._id, evidence.businessLineId, evidence.nodeId, expectedNodeVersion
      )
      if (authorized.processingRoundNumber !== evidence.processingRoundNumber) throw createError('VERSION_CONFLICT')
      return { evidence, allowedTypes: authorized.allowedTypes }
    })
  }

  async function sumAvailableEvidence(businessLineId, nodeId, processingRoundNumber, excludedId) {
    let offset = 0
    let total = 0
    while (true) {
      const response = await db.collection(COLLECTIONS.evidences).where({
        businessLineId,
        nodeId,
        processingRoundNumber,
        storageStatus: 'available'
      }).orderBy('_id', 'asc').skip(offset).limit(QUERY_PAGE_SIZE).get()
      const items = response && Array.isArray(response.data) ? response.data : []
      for (const item of items) {
        if (item._id === excludedId) continue
        if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > FEEDBACK_TOTAL_LIMIT - total) {
          throw createError('FEEDBACK_TOTAL_TOO_LARGE')
        }
        total += item.size
      }
      if (items.length < QUERY_PAGE_SIZE) return total
      offset += items.length
    }
  }

  async function finalizeUpload({ actor, evidenceId, uploadSessionTokenHash, expectedNodeVersion }) {
    if (!actor || typeof actor._id !== 'string' || !DOCUMENT_ID.test(actor._id) ||
        !DOCUMENT_ID.test(evidenceId) || !TOKEN_HASH.test(uploadSessionTokenHash) ||
        !Number.isSafeInteger(expectedNodeVersion) || expectedNodeVersion < 1) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    const preflight = await preflightFinalize(actor, evidenceId, uploadSessionTokenHash, expectedNodeVersion)
    if (preflight.available) return preflight.available
    const evidence = preflight.evidence
    const head = await storage.headObject({ objectKey: evidence.objectKey })
    if (!head || !Number.isSafeInteger(head.size) || head.size < 1 || head.size !== evidence.declaredSize) {
      throw createError('EVIDENCE_NOT_ATTACHABLE')
    }
    if (head.size > FEEDBACK_TOTAL_LIMIT) throw createError('FILE_TOO_LARGE')
    const header = await storage.readObjectHeader({ objectKey: evidence.objectKey, maximumBytes: HEADER_BYTES })
    const classified = classifyHeader({
      fileName: evidence.fileName,
      declaredSize: head.size,
      bytes: header,
      allowedTypes: preflight.allowedTypes
    })
    const baseline = await sumAvailableEvidence(
      evidence.businessLineId, evidence.nodeId, evidence.processingRoundNumber, evidenceId
    )
    if (classified.size > FEEDBACK_TOTAL_LIMIT - baseline) throw createError('FEEDBACK_TOTAL_TOO_LARGE')
    return db.runTransaction(async transaction => {
      const current = await readDocument(transaction, COLLECTIONS.evidences, evidenceId)
      if (!current || current.uploadedBy !== actor._id ||
          current.nodeVersionAtUpload !== expectedNodeVersion ||
          current.uploadSessionTokenHash !== uploadSessionTokenHash) throw createError('FORBIDDEN')
      if (current.storageStatus === 'available') return safeAvailableProjection(current)
      if (current.storageStatus !== 'uploading' || current.objectKey !== evidence.objectKey ||
          current.declaredSize !== head.size || current.processingRoundNumber !== evidence.processingRoundNumber) {
        throw createError('VERSION_CONFLICT')
      }
      const authorized = await authorize(
        transaction, actor._id, current.businessLineId, current.nodeId, expectedNodeVersion
      )
      if (authorized.processingRoundNumber !== current.processingRoundNumber ||
          !authorized.allowedTypes.includes(current.extension)) throw createError('VERSION_CONFLICT')
      const nodeTotal = authorized.node.evidenceUploadRoundNumber === current.processingRoundNumber &&
        Number.isSafeInteger(authorized.node.evidenceUploadAvailableBytes)
        ? authorized.node.evidenceUploadAvailableBytes
        : baseline
      if (classified.size > FEEDBACK_TOTAL_LIMIT - nodeTotal) throw createError('FEEDBACK_TOTAL_TOO_LARGE')
      const at = clock()
      if (!safeDate(at)) throw new TypeError('clock must return a Date')
      await transaction.collection(COLLECTIONS.nodes).doc(current.nodeId).update({ data: {
        evidenceUploadRoundNumber: current.processingRoundNumber,
        evidenceUploadAvailableBytes: nodeTotal + classified.size,
        updatedAt: at
      } })
      const integrityAlgorithm = head.crc64 ? 'cos-crc64' : 'cos-etag'
      const integrityValue = String(head.crc64 || head.etag || '')
      if (!integrityValue || integrityValue.length > 256) throw createError('EVIDENCE_NOT_ATTACHABLE')
      await transaction.collection(COLLECTIONS.evidences).doc(evidenceId).update({ data: {
        storageStatus: 'available',
        category: classified.category,
        size: classified.size,
        integrityAlgorithm,
        integrityValue,
        verifiedAt: at,
        updatedAt: at,
        objectKey: db.command.remove(),
        uploadSessionExpiresAt: db.command.remove()
      } })
      return safeAvailableProjection({
        ...current,
        category: classified.category,
        size: classified.size,
        storageStatus: 'available'
      })
    })
  }

  return { reserveUpload, finalizeUpload }
}

function cosCall(client, method, params) {
  return new Promise((resolve, reject) => {
    client[method](params, (error, data) => error ? reject(error) : resolve(data))
  })
}

function createCosStorageAdapter({ client, bucket, region }) {
  if (!client || typeof client.headObject !== 'function' || typeof client.getObject !== 'function' ||
      typeof bucket !== 'string' || !bucket || typeof region !== 'string' || !region) {
    throw new TypeError('COS client, bucket and region are required')
  }
  return {
    async headObject({ objectKey }) {
      const data = await cosCall(client, 'headObject', { Bucket: bucket, Region: region, Key: objectKey, Headers: {} })
      const headers = data && data.headers || {}
      const size = Number(headers['content-length'] || headers['Content-Length'])
      return {
        size,
        etag: data && (data.ETag || data.etag) || headers.etag || '',
        crc64: headers['x-cos-hash-crc64ecma'] || headers['X-Cos-Hash-Crc64ecma'] || ''
      }
    },
    async readObjectHeader({ objectKey, maximumBytes }) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > HEADER_BYTES) {
        throw new TypeError('maximumBytes is invalid')
      }
      const data = await cosCall(client, 'getObject', {
        Bucket: bucket,
        Region: region,
        Key: objectKey,
        Headers: { Range: `bytes=0-${maximumBytes - 1}` }
      })
      return Buffer.isBuffer(data && data.Body) ? data.Body : Buffer.from(data && data.Body || '')
    }
  }
}

function createScopedCosCredentialProvider({ sts, secretId, secretKey, bucket, region, durationSeconds = 900 }) {
  if (!sts || typeof sts.getCredential !== 'function' || typeof secretId !== 'string' || !secretId ||
      typeof secretKey !== 'string' || !secretKey || typeof bucket !== 'string' || !bucket ||
      typeof region !== 'string' || !region || !Number.isSafeInteger(durationSeconds) || durationSeconds < 1) {
    throw new TypeError('STS credentials, bucket and region are required')
  }
  const separator = bucket.lastIndexOf('-')
  const appId = separator > 0 ? bucket.slice(separator + 1) : ''
  if (!/^\d+$/.test(appId)) throw new TypeError('bucket must end with an app id')
  return {
    async issue({ objectKey }) {
      if (typeof objectKey !== 'string' || !OBJECT_KEY.test(objectKey)) throw createError('EVIDENCE_NOT_ATTACHABLE')
      const policy = {
        version: '2.0',
        statement: [{
          action: COS_UPLOAD_ACTIONS,
          effect: 'allow',
          resource: [`qcs::cos:${region}:uid/${appId}:${bucket}/${objectKey}`]
        }]
      }
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (error, data) => {
          if (settled) return
          settled = true
          if (error) reject(error)
          else resolve(data)
        }
        try {
          const returned = sts.getCredential(
            { secretId, secretKey, durationSeconds, region, policy },
            finish
          )
          if (returned && typeof returned.then === 'function') {
            returned.then(data => finish(null, data), finish)
          }
        } catch (error) {
          finish(error)
        }
      })
    }
  }
}

module.exports = {
  HEADER_BYTES,
  COS_UPLOAD_ACTIONS,
  createCloudEvidenceUploadRepository,
  createCosStorageAdapter,
  createScopedCosCredentialProvider
}
