const { assertPasswordPolicy, hashPassword, verifyPassword } = require('./password')

const MAX_FAILURES = 5
const LOCK_MS = 30 * 60 * 1000
const CHALLENGE_MS = 10 * 60 * 1000

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase()
}

function assertTrustedOpenid(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createError('INVALID_WECHAT_IDENTITY')
  }
}

function publicUser(user, credential) {
  return {
    _id: user._id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    avatarUrl: user.avatarUrl || '',
    openidBound: Boolean(user.openid),
    wecomUserIdBound: Boolean(user.wecomUserId),
    mustChangePassword: Boolean(credential && credential.mustChangePassword)
  }
}

function createAuthService({ repository, clock, randomToken, sha256, recoveryCodeHash }) {
  async function audit(writer, entry) {
    await writer({ ...entry, createdAt: clock() })
  }

  async function accountRecords(username) {
    const user = await repository.findUserByUsername(normalizeUsername(username))
    if (!user) return { user: null, credential: null }
    return { user, credential: await repository.findCredential(user._id) }
  }

  function assertAvailable(user, credential) {
    if (user.status !== 'active') throw createError('ACCOUNT_DISABLED')
    if (credential && credential.lockedUntil && credential.lockedUntil > clock()) {
      throw createError('ACCOUNT_LOCKED')
    }
  }

  async function rejectLogin(username, code) {
    await audit(repository.writeAudit, {
      action: 'LOGIN',
      username: normalizeUsername(username),
      resultCode: code
    })
    throw createError(code)
  }

  async function recordBadPassword(user) {
    const updatedCredential = await repository.updateCredential(user._id, current => {
      const lockExpired = current.lockedUntil && current.lockedUntil <= clock()
      const failedAttempts = (lockExpired ? 0 : Number(current.failedAttempts || 0)) + 1
      return {
        failedAttempts,
        lockedUntil: failedAttempts >= MAX_FAILURES ? clock() + LOCK_MS : null
      }
    })
    const code = updatedCredential.failedAttempts >= MAX_FAILURES ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS'
    return rejectLogin(user.username, code)
  }

  async function verifyRecoveryCode(recoveryCode) {
    if (sha256(recoveryCode) !== recoveryCodeHash) throw createError('INVALID_RECOVERY_CODE')
    const recoveryState = await repository.getRecoveryState({ recoveryCodeHash })
    if (!recoveryState || recoveryState.consumedAt) throw createError('INVALID_RECOVERY_CODE')
  }

  async function getSession({ openid }) {
    assertTrustedOpenid(openid)
    const user = await repository.findUserByOpenid(openid)
    const requiresInitialization = (await repository.countActiveSuperAdmins()) === 0
    if (!user) return { authenticated: false, requiresInitialization }
    const credential = await repository.findCredential(user._id)
    if (!credential) throw createError('ACCOUNT_STATE_INVALID')
    assertAvailable(user, credential)
    if (credential && credential.mustChangePassword) {
      return {
        authenticated: false,
        passwordChangeRequired: true,
        requiresInitialization,
        user: publicUser(user, credential)
      }
    }
    return { authenticated: true, requiresInitialization, user: publicUser(user, credential) }
  }

  async function login({ openid, username, password }) {
    assertTrustedOpenid(openid)
    const normalized = normalizeUsername(username)
    const { user, credential } = await accountRecords(normalized)
    if (!user || !credential) return rejectLogin(normalized, 'INVALID_CREDENTIALS')
    try {
      assertAvailable(user, credential)
    } catch (error) {
      return rejectLogin(normalized, error.code)
    }
    if (!verifyPassword(password, credential)) return recordBadPassword(user)

    await repository.updateCredential(user._id, { failedAttempts: 0, lockedUntil: null })
    credential.failedAttempts = 0
    credential.lockedUntil = null

    if (user.openid && user.openid !== openid) return rejectLogin(normalized, 'WECHAT_ALREADY_BOUND')

    if (credential.mustChangePassword) {
      const challengeToken = randomToken()
      const createdAt = clock()
      await repository.createChallenge({
        userId: user._id,
        username: user.username,
        openid,
        tokenHash: sha256(challengeToken),
        createdAt,
        expiresAt: createdAt + CHALLENGE_MS,
        consumedAt: null
      })
      await audit(repository.writeAudit, {
        action: 'LOGIN',
        username: user.username,
        resultCode: 'PASSWORD_CHANGE_REQUIRED'
      })
      return { authenticated: false, passwordChangeRequired: true, challengeToken, expiresAt: createdAt + CHALLENGE_MS }
    }

    const authenticatedUser = user.openid ? user : await repository.bindOpenid(user._id, openid)
    await audit(repository.writeAudit, { action: 'LOGIN', username: user.username, resultCode: 'AUTHENTICATED' })
    return { authenticated: true, user: publicUser(authenticatedUser, credential) }
  }

  async function completeFirstLogin({ openid, challengeToken, newPassword }) {
    assertTrustedOpenid(openid)
    assertPasswordPolicy(newPassword)
    const passwordRecord = hashPassword(newPassword)
    const result = await repository.consumeChallenge({
      tokenHash: sha256(challengeToken),
      openid,
      now: clock(),
      apply: async (transactionRepository, challenge) => {
        const user = await transactionRepository.findUserByUsername(challenge.username)
        const credential = user && await transactionRepository.findCredential(user._id)
        if (!user || !credential || user._id !== challenge.userId || !credential.mustChangePassword) {
          throw createError('INVALID_CHALLENGE')
        }
        assertAvailable(user, credential)
        const updatedCredential = await transactionRepository.updateCredential(user._id, {
          ...passwordRecord,
          mustChangePassword: false,
          failedAttempts: 0,
          lockedUntil: null
        })
        const updatedUser = await transactionRepository.bindOpenid(user._id, openid)
        await audit(transactionRepository.writeAudit, {
          action: 'COMPLETE_FIRST_LOGIN',
          username: user.username,
          resultCode: 'PASSWORD_CHANGED_AND_BOUND'
        })
        return { user: updatedUser, credential: updatedCredential }
      }
    })
    return { authenticated: true, user: publicUser(result.user, result.credential) }
  }

  async function changePassword({ actor, currentPassword, newPassword }) {
    const user = actor && await repository.findUserByUsername(actor.username)
    if (!user || user._id !== actor._id) throw createError('UNAUTHENTICATED')
    const credential = await repository.findCredential(user._id)
    if (!credential) throw createError('ACCOUNT_STATE_INVALID')
    assertAvailable(user, credential)
    if (!verifyPassword(currentPassword, credential)) {
      return recordBadPassword(user)
    }
    assertPasswordPolicy(newPassword)
    const updatedCredential = await repository.updateCredential(user._id, {
      ...hashPassword(newPassword),
      mustChangePassword: false,
      failedAttempts: 0,
      lockedUntil: null
    })
    await audit(repository.writeAudit, {
      action: 'CHANGE_PASSWORD',
      username: user.username,
      resultCode: 'PASSWORD_CHANGED'
    })
    return { user: publicUser(user, updatedCredential) }
  }

  async function initializeSuperAdmin({ openid, username, displayName, temporaryPassword, recoveryCode }) {
    assertTrustedOpenid(openid)
    const normalized = normalizeUsername(username)
    assertPasswordPolicy(temporaryPassword)
    await verifyRecoveryCode(recoveryCode)
    if ((await repository.countActiveSuperAdmins()) !== 0) throw createError('ALREADY_INITIALIZED')
    const credential = {
      ...hashPassword(temporaryPassword),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null
    }
    const user = await repository.consumeRecoveryCode({
      recoveryCodeHash,
      now: clock(),
      apply: async transactionRepository => {
        if ((await transactionRepository.countActiveSuperAdmins()) !== 0) throw createError('ALREADY_INITIALIZED')
        const created = await transactionRepository.createInitialSuperAdmin({
          username: normalized,
          displayName,
          openid,
          credential
        })
        await audit(transactionRepository.writeAudit, {
          action: 'INITIALIZE_SUPER_ADMIN',
          username: normalized,
          roleBefore: null,
          roleAfter: 'super_admin',
          statusBefore: null,
          statusAfter: 'active',
          resultCode: 'SUPER_ADMIN_INITIALIZED'
        })
        return created
      }
    })
    return { user: publicUser(user, credential) }
  }

  async function recoverSuperAdmin({ username, temporaryPassword, recoveryCode }) {
    const normalized = normalizeUsername(username)
    assertPasswordPolicy(temporaryPassword)
    await verifyRecoveryCode(recoveryCode)
    const passwordRecord = hashPassword(temporaryPassword)
    const result = await repository.consumeRecoveryCode({
      recoveryCodeHash,
      now: clock(),
      username: normalized,
      apply: async transactionRepository => {
        const user = await transactionRepository.findUserByUsername(normalized)
        if (!user) throw createError('ACCOUNT_NOT_FOUND')
        const credential = await transactionRepository.findCredential(user._id)
        if (!credential) throw createError('ACCOUNT_NOT_FOUND')
        const roleBefore = user.role
        const statusBefore = user.status
        const updatedUser = await transactionRepository.updateUser(user._id, {
          role: 'super_admin',
          status: 'active',
          openid: ''
        })
        const updatedCredential = await transactionRepository.updateCredential(user._id, {
          ...passwordRecord,
          mustChangePassword: true,
          failedAttempts: 0,
          lockedUntil: null
        })
        await transactionRepository.invalidateChallenges(user._id, clock())
        await audit(transactionRepository.writeAudit, {
          action: 'RECOVER_SUPER_ADMIN',
          priority: 'high',
          username: user.username,
          roleBefore,
          roleAfter: 'super_admin',
          statusBefore,
          statusAfter: 'active',
          resultCode: 'SUPER_ADMIN_RECOVERED'
        })
        return { user: updatedUser, credential: updatedCredential }
      }
    })
    return { user: publicUser(result.user, result.credential) }
  }

  return {
    getSession,
    login,
    completeFirstLogin,
    changePassword,
    initializeSuperAdmin,
    recoverSuperAdmin
  }
}

module.exports = { createAuthService }
