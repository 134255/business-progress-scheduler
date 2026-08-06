const crypto = require('node:crypto')

const COLLECTIONS = Object.freeze({
  users: 'users',
  credentials: 'user_credentials',
  challenges: 'auth_challenges',
  bindings: 'wechat_bindings',
  settings: 'system_settings',
  audit: 'audit_logs'
})

const ADMIN_GUARD_ID = 'account_admin_state'

function defaultIdFactory(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`
}

function bindingIdForOpenid(openid) {
  return crypto.createHash('sha256').update(String(openid)).digest('hex')
}

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function assertCredentialVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw createError('ACCOUNT_STATE_INVALID')
  return value
}

function storedCredentialVersion(record) {
  return Object.prototype.hasOwnProperty.call(record, 'credentialVersion')
    ? assertCredentialVersion(record.credentialVersion)
    : 0
}

function requiredCredentialVersion(value) {
  return assertCredentialVersion(value)
}

function assertChallengeEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw createError('ACCOUNT_STATE_INVALID')
  return value
}

function storedChallengeEpoch(record) {
  return Object.prototype.hasOwnProperty.call(record, 'challengeEpoch')
    ? assertChallengeEpoch(record.challengeEpoch)
    : 0
}

function nextChallengeEpoch(record) {
  const currentEpoch = storedChallengeEpoch(record)
  if (currentEpoch === Number.MAX_SAFE_INTEGER) throw createError('ACCOUNT_STATE_INVALID')
  return currentEpoch + 1
}

function isActiveSuperAdmin(user) {
  return user && user.role === 'super_admin' && user.status === 'active'
}

function persistedUser(user) {
  const result = concreteDates(user)
  if (!result.openid) delete result.openid
  return result
}

function concreteDates(value) {
  const result = { ...value }
  for (const key of ['createdAt', 'updatedAt', 'expiresAt', 'lockedUntil', 'consumedAt']) {
    if (result[key] !== null && result[key] !== undefined && !(result[key] instanceof Date) &&
        (typeof result[key] === 'number' || typeof result[key] === 'string')) {
      result[key] = new Date(result[key])
    }
  }
  return result
}

function mapDuplicateError(error) {
  const text = `${error && error.code || ''} ${error && error.errCode || ''} ${error && error.message || ''}`.toLowerCase()
  if (!text.includes('duplicate') && !text.includes('-502005')) return error
  if (text.includes('openid')) return createError('OPENID_ALREADY_BOUND')
  return createError('USERNAME_TAKEN')
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase()
}

function sameUsername(user, username) {
  return user && (user.usernameNormalized || normalizeUsername(user.username)) === normalizeUsername(username)
}

function createCloudAccountRepository({ db, clock = () => new Date(), idFactory = defaultIdFactory }) {
  if (!db) throw new TypeError('db is required')

  async function readDocument(database, collectionName, id) {
    const result = await database.collection(collectionName).doc(id).get()
    return result && result.data ? result.data : null
  }

  async function countActiveSuperAdmins() {
    const guard = await readDocument(db, COLLECTIONS.settings, ADMIN_GUARD_ID)
    return assertGuard(guard).activeSuperAdminCount
  }

  function assertGuard(guard) {
    if (!guard || !Number.isSafeInteger(guard.activeSuperAdminCount) || guard.activeSuperAdminCount < 0 ||
        !Number.isSafeInteger(guard.revision) || guard.revision < 0) {
      throw createError('ACCOUNT_STATE_INVALID')
    }
    return guard
  }

  async function writeAudit(database, entry, auditId = idFactory('audit')) {
    const stored = { ...entry, createdAt: db.serverDate() }
    await database.collection(COLLECTIONS.audit).doc(auditId).set({ data: stored })
    return { _id: auditId, ...stored }
  }

  async function createAccountWithAdminGuard({ user, credential, audit }) {
    const userId = idFactory('user')
    const auditId = idFactory('audit')
    try {
      return await db.runTransaction(async transaction => {
        const guard = assertGuard(await readDocument(transaction, COLLECTIONS.settings, ADMIN_GUARD_ID))
        const storedUser = persistedUser(user)
        const challengeEpoch = storedChallengeEpoch(credential)
        await transaction.collection(COLLECTIONS.users).doc(userId).set({ data: storedUser })
        await transaction.collection(COLLECTIONS.credentials).doc(userId).set({
          data: { ...concreteDates(credential), userId, challengeEpoch, credentialVersion: 0 }
        })
        await transaction.collection(COLLECTIONS.settings).doc(ADMIN_GUARD_ID).update({
          data: {
            activeSuperAdminCount: guard.activeSuperAdminCount + (isActiveSuperAdmin(user) ? 1 : 0),
            revision: guard.revision + 1
          }
        })
        await writeAudit(transaction, { ...audit, targetUserId: userId }, auditId)
        return { _id: userId, ...storedUser }
      })
    } catch (error) {
      throw mapDuplicateError(error)
    }
  }

  function transactionRepository(transaction, options = {}) {
    async function findUserById(userId) {
      return readDocument(transaction, COLLECTIONS.users, userId)
    }

    async function findCredential(userId) {
      return readDocument(transaction, COLLECTIONS.credentials, userId)
    }

    async function getAdminGuard() {
      return readDocument(transaction, COLLECTIONS.settings, ADMIN_GUARD_ID)
    }

    async function countTransactionActiveSuperAdmins() {
      return assertGuard(await getAdminGuard()).activeSuperAdminCount
    }

    async function updateUserAndAdminGuard(userId, changes) {
      const user = await findUserById(userId)
      if (!user) throw createError('ACCOUNT_NOT_FOUND')
      const guard = assertGuard(await getAdminGuard())
      const updated = { ...user, ...changes }
      const nextCount = guard.activeSuperAdminCount + Number(isActiveSuperAdmin(updated)) - Number(isActiveSuperAdmin(user))
      if (!Number.isSafeInteger(nextCount) || nextCount < 0) throw createError('ACCOUNT_STATE_INVALID')
      const storedChanges = { ...changes }
      if (Object.prototype.hasOwnProperty.call(storedChanges, 'openid') && !storedChanges.openid) {
        if (user.openid) {
          const bindingId = bindingIdForOpenid(user.openid)
          const binding = await readDocument(transaction, COLLECTIONS.bindings, bindingId)
          if (binding && binding.userId !== userId) throw createError('ACCOUNT_STATE_INVALID')
          if (binding) await transaction.collection(COLLECTIONS.bindings).doc(bindingId).remove()
        }
        storedChanges.openid = db.command.remove()
      }
      const userResult = await transaction.collection(COLLECTIONS.users).doc(userId).update({ data: storedChanges })
      if (!userResult.stats || userResult.stats.updated !== 1) throw createError('ACCOUNT_NOT_FOUND')
      const guardResult = await transaction.collection(COLLECTIONS.settings).doc(ADMIN_GUARD_ID).update({
        data: { activeSuperAdminCount: nextCount, revision: guard.revision + 1 }
      })
      if (!guardResult.stats || guardResult.stats.updated !== 1) throw createError('ACCOUNT_STATE_INVALID')
      return { ...updated, openid: updated.openid || '' }
    }

    async function updateCredential(userId, changesOrUpdater) {
      const credential = await findCredential(userId)
      if (!credential) throw createError('ACCOUNT_NOT_FOUND')
      const currentVersion = storedCredentialVersion(credential)
      storedChallengeEpoch(credential)
      if (currentVersion === Number.MAX_SAFE_INTEGER) throw createError('ACCOUNT_STATE_INVALID')
      const requestedChanges = typeof changesOrUpdater === 'function'
        ? await changesOrUpdater({ ...credential })
        : changesOrUpdater
      const changes = concreteDates(requestedChanges)
      if (Object.prototype.hasOwnProperty.call(changes, 'challengeEpoch')) {
        assertChallengeEpoch(changes.challengeEpoch)
      }
      const nextVersion = currentVersion + 1
      await transaction.collection(COLLECTIONS.credentials).doc(userId).update({
        data: { ...changes, credentialVersion: nextVersion }
      })
      return { ...credential, ...changes, credentialVersion: nextVersion }
    }

    async function bindOpenid(userId, openid, expectedCredentialVersion) {
      const user = await findUserById(userId)
      const credential = await findCredential(userId)
      if (!user) throw createError('ACCOUNT_NOT_FOUND')
      if (!credential) throw createError('ACCOUNT_STATE_INVALID')
      if (storedCredentialVersion(credential) !== requiredCredentialVersion(expectedCredentialVersion) ||
          user.status !== 'active' || credential.mustChangePassword) {
        throw createError('CREDENTIAL_CHANGED')
      }
      if (user.openid && user.openid !== openid) throw createError('WECHAT_ALREADY_BOUND')
      const bindingId = bindingIdForOpenid(openid)
      const binding = await readDocument(transaction, COLLECTIONS.bindings, bindingId)
      if (binding && binding.userId !== userId) throw createError('OPENID_ALREADY_BOUND')
      await transaction.collection(COLLECTIONS.bindings).doc(bindingId).set({
        data: {
          userId,
          createdAt: binding && binding.createdAt ? binding.createdAt : db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      await transaction.collection(COLLECTIONS.users).doc(userId).update({ data: { openid } })
      const updatedCredential = await updateCredential(userId, { lastAuthenticatedAt: db.serverDate() })
      return { user: { ...user, openid }, credential: updatedCredential }
    }

    async function invalidateChallenges(userId, invalidatedAt) {
      return updateCredential(userId, credential => ({
        challengeEpoch: nextChallengeEpoch(credential),
        challengesInvalidatedAt: new Date(invalidatedAt === undefined ? clock() : invalidatedAt)
      }))
    }

    async function findTransactionUserByUsername(username) {
      if (!options.preResolvedUser || !sameUsername(options.preResolvedUser, username)) return null
      const current = await findUserById(options.preResolvedUser._id)
      return sameUsername(current, username) ? current : null
    }

    async function createInitialSuperAdmin({ username, displayName, openid, credential }) {
      if (!options.initialUserId) throw createError('ACCOUNT_STATE_INVALID')
      const guard = assertGuard(await getAdminGuard())
      if (guard.activeSuperAdminCount !== 0) throw createError('ALREADY_INITIALIZED')
      const normalized = normalizeUsername(username)
      const user = persistedUser({
        username: normalized,
        usernameNormalized: normalized,
        displayName: String(displayName || '').trim(),
        role: 'super_admin',
        status: 'active',
        avatarUrl: '',
        openid,
        wecomUserId: ''
      })
      if (openid) {
        const bindingId = bindingIdForOpenid(openid)
        const binding = await readDocument(transaction, COLLECTIONS.bindings, bindingId)
        if (binding && binding.userId !== options.initialUserId) throw createError('OPENID_ALREADY_BOUND')
        await transaction.collection(COLLECTIONS.bindings).doc(bindingId).set({
          data: { userId: options.initialUserId, createdAt: db.serverDate(), updatedAt: db.serverDate() }
        })
      }
      await transaction.collection(COLLECTIONS.users).doc(options.initialUserId).set({ data: user })
      await transaction.collection(COLLECTIONS.credentials).doc(options.initialUserId).set({
        data: {
          ...concreteDates(credential),
          userId: options.initialUserId,
          challengeEpoch: storedChallengeEpoch(credential),
          credentialVersion: 0
        }
      })
      await transaction.collection(COLLECTIONS.settings).doc(ADMIN_GUARD_ID).update({
        data: { activeSuperAdminCount: 1, revision: guard.revision + 1 }
      })
      return { _id: options.initialUserId, ...user }
    }

    return {
      bindOpenid,
      countActiveSuperAdmins: countTransactionActiveSuperAdmins,
      createInitialSuperAdmin,
      findCredential,
      findUserById,
      findUserByUsername: findTransactionUserByUsername,
      getAdminGuard,
      invalidateChallenges,
      updateCredential,
      updateUser: updateUserAndAdminGuard,
      updateUserAndAdminGuard,
      writeAudit: entry => writeAudit(transaction, entry, options.auditId),
      ...options.methods
    }
  }

  async function runUserTransaction(apply, options) {
    const transactionOptions = { auditId: idFactory('audit'), ...options }
    return db.runTransaction(transaction => apply(transactionRepository(transaction, transactionOptions)))
  }

  async function runAdminGuardTransaction(apply) {
    return runUserTransaction(apply)
  }

  async function findOneBy(criteria) {
    const result = await db.collection(COLLECTIONS.users).where(criteria).limit(1).get()
    return result.data && result.data[0] ? result.data[0] : null
  }

  async function findUserById(userId) {
    return readDocument(db, COLLECTIONS.users, userId)
  }

  async function findUserByUsername(usernameNormalized) {
    return findOneBy({ usernameNormalized })
  }

  async function findUserByOpenid(openid) {
    const binding = await readDocument(db, COLLECTIONS.bindings, bindingIdForOpenid(openid))
    if (!binding || !binding.userId) return null
    const user = await findUserById(binding.userId)
    return user && user.openid === openid ? user : null
  }

  async function findCredential(userId) {
    return readDocument(db, COLLECTIONS.credentials, userId)
  }

  async function listUsers({ page, pageSize, status, keyword }) {
    const users = []
    const batchSize = 100
    for (let offset = 0; ; offset += batchSize) {
      let query = db.collection(COLLECTIONS.users)
      if (status) query = query.where({ status })
      const result = await query.orderBy('_id', 'asc').skip(offset).limit(batchSize).get()
      users.push(...result.data)
      if (result.data.length < batchSize) break
    }
    const normalizedKeyword = String(keyword || '').toLowerCase()
    const filtered = users
      .filter(user => !normalizedKeyword || [user.username, user.displayName]
        .some(value => String(value || '').toLowerCase().includes(normalizedKeyword)))
      .sort((left, right) => String(left.usernameNormalized || '').localeCompare(String(right.usernameNormalized || '')) ||
        String(left._id).localeCompare(String(right._id)))
    const offset = (page - 1) * pageSize
    const selected = filtered.slice(offset, offset + pageSize)
    return {
      items: await Promise.all(selected.map(async user => ({ user, credential: await findCredential(user._id) }))),
      total: filtered.length
    }
  }

  async function updateCredential(userId, changesOrUpdater) {
    return runUserTransaction(transaction => transaction.updateCredential(userId, changesOrUpdater))
  }

  async function bindOpenid(userId, openid, expectedCredentialVersion) {
    return runUserTransaction(transaction => transaction.bindOpenid(userId, openid, expectedCredentialVersion))
  }

  async function createChallenge(challenge) {
    const challengeId = idFactory('challenge')
    return db.runTransaction(async transaction => {
      const credential = await readDocument(transaction, COLLECTIONS.credentials, challenge.userId)
      if (!credential) throw createError('ACCOUNT_STATE_INVALID')
      const currentVersion = storedCredentialVersion(credential)
      if (currentVersion !== requiredCredentialVersion(challenge.expectedCredentialVersion)) {
        throw createError('CREDENTIAL_CHANGED')
      }
      const stored = concreteDates({
        ...challenge,
        challengeEpoch: storedChallengeEpoch(credential),
        credentialVersion: currentVersion
      })
      delete stored.expectedCredentialVersion
      await transaction.collection(COLLECTIONS.challenges).doc(challengeId).set({ data: stored })
      return { _id: challengeId, ...stored }
    })
  }

  async function consumeChallenge({ tokenHash, openid, now, apply }) {
    const initialResult = await db.collection(COLLECTIONS.challenges).where({ tokenHash }).limit(1).get()
    const initial = initialResult.data && initialResult.data[0]
    if (!initial) throw createError('INVALID_CHALLENGE')
    const auditId = idFactory('audit')
    return db.runTransaction(async transaction => {
      const challenge = await readDocument(transaction, COLLECTIONS.challenges, initial._id)
      const credential = challenge && await readDocument(transaction, COLLECTIONS.credentials, challenge.userId)
      const user = challenge && await readDocument(transaction, COLLECTIONS.users, challenge.userId)
      const expiresAt = challenge && new Date(challenge.expiresAt).getTime()
      const currentTime = new Date(now === undefined ? clock() : now).getTime()
      if (!challenge || challenge.tokenHash !== tokenHash || challenge.openid !== openid || challenge.consumedAt ||
          !Number.isFinite(expiresAt) || expiresAt <= currentTime || !credential || !user ||
          storedChallengeEpoch(challenge) !== storedChallengeEpoch(credential) ||
          storedCredentialVersion(challenge) !== storedCredentialVersion(credential) ||
          !sameUsername(user, challenge.username)) {
        throw createError('INVALID_CHALLENGE')
      }
      const repository = transactionRepository(transaction, {
        auditId,
        preResolvedUser: user,
        methods: {
          async findUserByUsername(username) {
            return sameUsername(user, username)
              ? readDocument(transaction, COLLECTIONS.users, user._id)
              : null
          }
        }
      })
      const result = await apply(repository, challenge)
      await transaction.collection(COLLECTIONS.challenges).doc(challenge._id).update({
        data: { consumedAt: new Date(currentTime) }
      })
      return result
    })
  }

  async function getRecoveryState({ recoveryCodeHash }) {
    const guard = await readDocument(db, COLLECTIONS.settings, ADMIN_GUARD_ID)
    if (!guard || guard.recoveryCodeHash !== recoveryCodeHash) return null
    return {
      recoveryCodeHash: guard.recoveryCodeHash,
      consumedAt: guard.recoveryConsumedAt || null
    }
  }

  async function consumeRecoveryCode({ recoveryCodeHash, username, now, apply }) {
    const preResolvedUser = username ? await findUserByUsername(normalizeUsername(username)) : null
    const initialUserId = username ? null : idFactory('user')
    const auditId = idFactory('audit')
    try {
      return await db.runTransaction(async transaction => {
        const guard = assertGuard(await readDocument(transaction, COLLECTIONS.settings, ADMIN_GUARD_ID))
        if (guard.recoveryCodeHash !== recoveryCodeHash || guard.recoveryConsumedAt) {
          throw createError('INVALID_RECOVERY_CODE')
        }
        if (preResolvedUser) {
          const current = await readDocument(transaction, COLLECTIONS.users, preResolvedUser._id)
          if (!sameUsername(current, username)) throw createError('ACCOUNT_STATE_INVALID')
        }
        const repository = transactionRepository(transaction, {
          auditId,
          initialUserId,
          preResolvedUser
        })
        const result = await apply(repository, {
          recoveryCodeHash,
          consumedAt: null
        })
        await transaction.collection(COLLECTIONS.settings).doc(ADMIN_GUARD_ID).update({
          data: { recoveryConsumedAt: new Date(now === undefined ? clock() : now) }
        })
        return result
      })
    } catch (error) {
      throw mapDuplicateError(error)
    }
  }

  return {
    bindOpenid,
    countActiveSuperAdmins,
    consumeChallenge,
    consumeRecoveryCode,
    createAccountWithAdminGuard,
    createChallenge,
    findCredential,
    findUserById,
    findUserByOpenid,
    findUserByUsername,
    getRecoveryState,
    listUsers,
    runAdminGuardTransaction,
    runUserTransaction,
    updateCredential,
    writeAudit: entry => writeAudit(db, entry)
  }
}

module.exports = {
  ADMIN_GUARD_ID,
  bindingIdForOpenid,
  COLLECTIONS,
  createCloudAccountRepository
}
