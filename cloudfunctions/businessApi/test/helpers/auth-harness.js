const crypto = require('node:crypto')
const { createAuthService } = require('../../lib/auth-service')
const { hashPassword } = require('../../lib/password')

const TEST_RECOVERY_CODE = 'RECOVERY9-TEST-ONLY'

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function clone(value) {
  return structuredClone(value)
}

function createAuthHarness() {
  let now = Date.parse('2026-08-06T00:00:00.000Z')
  let sequence = 0
  let operationQueue = Promise.resolve()
  const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex')
  const recoveryCodeHash = sha256(TEST_RECOVERY_CODE)
  const state = {
    users: [],
    credentials: [],
    bindings: [],
    challenges: [],
    recoveryStates: [{ recoveryCodeHash, consumedAt: null }],
    audit: []
  }

  function restore(snapshot) {
    for (const key of Object.keys(state)) {
      state[key].splice(0, state[key].length, ...snapshot[key])
    }
  }

  async function serialize(work) {
    const previous = operationQueue
    let release
    operationQueue = new Promise(resolve => {
      release = resolve
    })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }

  function findUserByOpenid(openid) {
    const binding = state.bindings.find(candidate => candidate._id === sha256(openid))
    const user = binding && state.users.find(candidate => candidate._id === binding.userId)
    return user && user.openid === openid ? user : null
  }

  function findUserByUsername(username) {
    const normalized = String(username || '').trim().toLowerCase()
    return state.users.find(user => user.username === normalized) || null
  }

  function findCredential(userId) {
    return state.credentials.find(credential => credential.userId === userId) || null
  }

  function updateUser(userId, changes) {
    const user = state.users.find(candidate => candidate._id === userId)
    if (!user) throw createError('ACCOUNT_NOT_FOUND')
    if (Object.prototype.hasOwnProperty.call(changes, 'openid') && !changes.openid && user.openid) {
      const bindingIndex = state.bindings.findIndex(binding => binding._id === sha256(user.openid) && binding.userId === userId)
      if (bindingIndex >= 0) state.bindings.splice(bindingIndex, 1)
    }
    Object.assign(user, clone(changes))
    return user
  }

  function directUpdateCredential(userId, changesOrUpdater) {
    const credential = findCredential(userId)
    if (!credential) throw createError('ACCOUNT_NOT_FOUND')
    const changes = typeof changesOrUpdater === 'function'
      ? changesOrUpdater(clone(credential))
      : changesOrUpdater
    Object.assign(credential, clone(changes), {
      credentialVersion: Number(credential.credentialVersion || 0) + 1
    })
    return credential
  }

  async function updateCredential(userId, changesOrUpdater) {
    return serialize(async () => {
      await Promise.resolve()
      return directUpdateCredential(userId, changesOrUpdater)
    })
  }

  function bindOpenid(userId, openid, expectedCredentialVersion) {
    const user = state.users.find(candidate => candidate._id === userId)
    const credential = findCredential(userId)
    if (!user) throw createError('ACCOUNT_NOT_FOUND')
    if (!credential) throw createError('ACCOUNT_STATE_INVALID')
    if (Number(credential.credentialVersion || 0) !== Number(expectedCredentialVersion)) {
      throw createError('CREDENTIAL_CHANGED')
    }
    if (user.status !== 'active' || credential.mustChangePassword) throw createError('CREDENTIAL_CHANGED')
    const bindingId = sha256(openid)
    const binding = state.bindings.find(candidate => candidate._id === bindingId)
    if (binding && binding.userId !== userId) {
      throw createError('OPENID_ALREADY_BOUND')
    }
    if (openid && user.openid && user.openid !== openid) {
      throw createError('WECHAT_ALREADY_BOUND')
    }
    const updated = { ...user, openid: openid || '' }
    state.users.splice(state.users.indexOf(user), 1, updated)
    if (!binding) state.bindings.push({ _id: bindingId, userId })
    const updatedCredential = directUpdateCredential(userId, { lastAuthenticatedAt: now })
    return { user: updated, credential: clone(updatedCredential) }
  }

  function countActiveSuperAdmins() {
    return state.users.filter(user => user.role === 'super_admin' && user.status === 'active').length
  }

  function createInitialSuperAdmin({ username, displayName, openid, credential }) {
    if (countActiveSuperAdmins() !== 0) throw createError('ALREADY_INITIALIZED')
    if (findUserByUsername(username)) throw createError('USERNAME_TAKEN')
    if (openid && state.bindings.some(binding => binding._id === sha256(openid))) throw createError('OPENID_ALREADY_BOUND')
    sequence += 1
    const user = {
      _id: `test-user-${sequence}`,
      username,
      displayName,
      role: 'super_admin',
      status: 'active',
      avatarUrl: '',
      openid: openid || '',
      wecomUserId: ''
    }
    state.users.push(user)
    if (openid) state.bindings.push({ _id: sha256(openid), userId: user._id })
    state.credentials.push({ userId: user._id, credentialVersion: 0, ...clone(credential) })
    return user
  }

  function createChallenge(challenge) {
    const credential = findCredential(challenge.userId)
    if (!credential || Number(credential.credentialVersion || 0) !== Number(challenge.expectedCredentialVersion)) {
      throw createError('CREDENTIAL_CHANGED')
    }
    sequence += 1
    const stored = {
      _id: `test-challenge-${sequence}`,
      ...clone(challenge),
      credentialVersion: Number(credential.credentialVersion || 0)
    }
    delete stored.expectedCredentialVersion
    state.challenges.push(stored)
    return stored
  }

  function invalidateChallenges(userId, consumedAt) {
    for (const challenge of state.challenges) {
      if (challenge.userId === userId && !challenge.consumedAt) challenge.consumedAt = consumedAt
    }
    directUpdateCredential(userId, {
      challengeEpoch: Number(findCredential(userId).challengeEpoch || 0) + 1
    })
  }

  function writeAudit(entry) {
    state.audit.push(clone(entry))
  }

  function transactionRepository() {
    return {
      bindOpenid,
      countActiveSuperAdmins,
      createInitialSuperAdmin,
      findCredential,
      findUserByUsername,
      invalidateChallenges,
      updateCredential: directUpdateCredential,
      updateUser,
      writeAudit
    }
  }

  async function consumeChallenge({ tokenHash, openid, now: consumedAt, apply }) {
    return serialize(async () => {
      const challenge = state.challenges.find(candidate => candidate.tokenHash === tokenHash)
      const credential = challenge && findCredential(challenge.userId)
      if (!challenge || !credential || challenge.consumedAt || challenge.expiresAt <= consumedAt || challenge.openid !== openid ||
          Number(challenge.credentialVersion || 0) !== Number(credential.credentialVersion || 0)) {
        throw createError('INVALID_CHALLENGE')
      }
      await Promise.resolve()
      const snapshot = clone(state)
      try {
        const result = await apply(transactionRepository(), clone(challenge))
        challenge.consumedAt = consumedAt
        return result
      } catch (error) {
        restore(snapshot)
        throw error
      }
    })
  }

  function getRecoveryState({ recoveryCodeHash: candidateHash }) {
    return state.recoveryStates.find(candidate => candidate.recoveryCodeHash === candidateHash) || null
  }

  async function consumeRecoveryCode({ recoveryCodeHash: candidateHash, now: consumedAt, apply }) {
    return serialize(async () => {
      const recoveryState = state.recoveryStates.find(candidate => candidate.recoveryCodeHash === candidateHash)
      if (!recoveryState || recoveryState.consumedAt) throw createError('INVALID_RECOVERY_CODE')
      await Promise.resolve()
      const snapshot = clone(state)
      try {
        const result = await apply(transactionRepository(), clone(recoveryState))
        recoveryState.consumedAt = consumedAt
        return result
      } catch (error) {
        restore(snapshot)
        throw error
      }
    })
  }

  const repository = {
    bindOpenid: (...args) => serialize(() => bindOpenid(...args)),
    countActiveSuperAdmins: () => serialize(() => countActiveSuperAdmins()),
    createChallenge: (...args) => serialize(() => createChallenge(...args)),
    createInitialSuperAdmin: (...args) => serialize(() => createInitialSuperAdmin(...args)),
    consumeChallenge,
    consumeRecoveryCode,
    findCredential: (...args) => serialize(() => clone(findCredential(...args))),
    findUserByOpenid: (...args) => serialize(() => clone(findUserByOpenid(...args))),
    findUserByUsername: (...args) => serialize(() => clone(findUserByUsername(...args))),
    getRecoveryState: (...args) => serialize(() => clone(getRecoveryState(...args))),
    invalidateChallenges: (...args) => serialize(() => invalidateChallenges(...args)),
    updateCredential,
    updateUser: (...args) => serialize(() => updateUser(...args)),
    writeAudit: (...args) => serialize(() => writeAudit(...args))
  }

  const service = createAuthService({
    repository,
    clock: () => now,
    randomToken: () => `challenge-token-${++sequence}-test-only`,
    sha256,
    recoveryCodeHash
  })

  function seedAccount({
    username,
    password,
    mustChangePassword = false,
    openid = '',
    role = 'user',
    status = 'active'
  }) {
    sequence += 1
    const normalized = String(username || '').trim().toLowerCase()
    const user = {
      _id: `test-user-${sequence}`,
      username: normalized,
      displayName: `Test ${normalized}`,
      role,
      status,
      avatarUrl: '',
      openid,
      wecomUserId: ''
    }
    state.users.push(user)
    if (openid) state.bindings.push({ _id: sha256(openid), userId: user._id })
    state.credentials.push({
      userId: user._id,
      ...hashPassword(password),
      mustChangePassword,
      failedAttempts: 0,
      lockedUntil: null,
      credentialVersion: 0
    })
    return user
  }

  return {
    repository,
    service,
    state,
    seedAccount,
    advanceTime(milliseconds) {
      now += milliseconds
    }
  }
}

module.exports = { createAuthHarness }
