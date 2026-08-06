const { createAdminUserService } = require('../../lib/admin-user-service')
const { hashPassword } = require('../../lib/password')

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function createAdminUserHarness() {
  const now = Date.parse('2026-08-06T00:00:00.000Z')
  let sequence = 0
  let operationQueue = Promise.resolve()
  const calls = []
  const state = {
    users: [],
    credentials: [],
    challenges: [],
    audit: [],
    adminGuard: {
      _id: 'account-admin-state',
      activeSuperAdminCount: 0,
      revision: 0
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

  function restore(snapshot) {
    for (const key of Object.keys(state)) {
      if (Array.isArray(state[key])) {
        state[key].splice(0, state[key].length, ...snapshot[key])
      } else {
        for (const field of Object.keys(state[key])) delete state[key][field]
        Object.assign(state[key], snapshot[key])
      }
    }
  }

  function findUserById(userId) {
    return state.users.find(user => user._id === userId) || null
  }

  function findCredential(userId) {
    return state.credentials.find(credential => credential.userId === userId) || null
  }

  function usernameExists(usernameNormalized) {
    return state.users.some(user => user.usernameNormalized === usernameNormalized)
  }

  function writeAudit(entry) {
    state.audit.push(clone(entry))
  }

  function transactionRepository() {
    return {
      getAdminGuard() {
        return clone(state.adminGuard)
      },
      findCredential(userId) {
        return clone(findCredential(userId))
      },
      findUserById(userId) {
        return clone(findUserById(userId))
      },
      invalidateChallenges(userId, consumedAt) {
        for (const challenge of state.challenges) {
          if (challenge.userId === userId && !challenge.consumedAt) challenge.consumedAt = consumedAt
        }
      },
      updateCredential(userId, changes) {
        const credential = findCredential(userId)
        if (!credential) throw createError('ACCOUNT_NOT_FOUND')
        Object.assign(credential, clone(changes))
        return clone(credential)
      },
      updateUser(userId, changes) {
        const user = findUserById(userId)
        if (!user) throw createError('ACCOUNT_NOT_FOUND')
        Object.assign(user, clone(changes))
        return clone(user)
      },
      updateUserAndAdminGuard(userId, changes) {
        const user = findUserById(userId)
        if (!user) throw createError('ACCOUNT_NOT_FOUND')
        const wasActiveSuperAdmin = user.role === 'super_admin' && user.status === 'active'
        Object.assign(user, clone(changes))
        const isActiveSuperAdmin = user.role === 'super_admin' && user.status === 'active'
        state.adminGuard.activeSuperAdminCount += Number(isActiveSuperAdmin) - Number(wasActiveSuperAdmin)
        state.adminGuard.revision += 1
        return clone(user)
      },
      writeAudit
    }
  }

  const repository = {
    async createAccountWithAdminGuard({ user, credential, audit }) {
      calls.push('createAccountWithAdminGuard')
      return serialize(async () => {
        await Promise.resolve()
        const snapshot = clone(state)
        try {
          if (usernameExists(user.usernameNormalized)) throw createError('USERNAME_TAKEN')
          sequence += 1
          const storedUser = { _id: `created-user-${sequence}`, ...clone(user) }
          state.users.push(storedUser)
          state.credentials.push({ userId: storedUser._id, ...clone(credential) })
          if (storedUser.role === 'super_admin' && storedUser.status === 'active') {
            state.adminGuard.activeSuperAdminCount += 1
          }
          state.adminGuard.revision += 1
          writeAudit({ ...clone(audit), targetUserId: storedUser._id })
          return clone(storedUser)
        } catch (error) {
          restore(snapshot)
          throw error
        }
      })
    },
    listUsers({ page, pageSize, status, keyword }) {
      calls.push('listUsers')
      const normalizedKeyword = String(keyword || '').toLowerCase()
      const filtered = state.users
        .filter(user => !status || user.status === status)
        .filter(user => !normalizedKeyword || [user.username, user.displayName]
          .some(value => String(value || '').toLowerCase().includes(normalizedKeyword)))
        .sort((left, right) => left.usernameNormalized.localeCompare(right.usernameNormalized) || left._id.localeCompare(right._id))
      const offset = (page - 1) * pageSize
      return {
        items: filtered.slice(offset, offset + pageSize).map(user => ({
          user: clone(user),
          credential: clone(findCredential(user._id))
        })),
        total: filtered.length
      }
    },
    runAdminGuardTransaction(apply) {
      calls.push('runAdminGuardTransaction')
      return serialize(async () => {
        await Promise.resolve()
        const snapshot = clone(state)
        try {
          return await apply(transactionRepository())
        } catch (error) {
          restore(snapshot)
          throw error
        }
      })
    },
    runUserTransaction(apply) {
      calls.push('runUserTransaction')
      return serialize(async () => {
        await Promise.resolve()
        const snapshot = clone(state)
        try {
          return await apply(transactionRepository())
        } catch (error) {
          restore(snapshot)
          throw error
        }
      })
    }
  }

  const service = createAdminUserService({
    repository,
    hashPassword,
    clock: () => now
  })

  function seedAccount(id, {
    username = id,
    displayName = `Test ${id}`,
    role = 'user',
    status = 'active',
    openid = '',
    failedAttempts = 0,
    lockedUntil = null,
    mustChangePassword = false,
    password = 'SeedPass8'
  } = {}) {
    const displayUsername = String(username).trim()
    const user = {
      _id: id,
      username: displayUsername,
      usernameNormalized: displayUsername.toLowerCase(),
      displayName,
      role,
      status,
      avatarUrl: '',
      openid,
      wecomUserId: ''
    }
    state.users.push(user)
    state.credentials.push({
      userId: id,
      ...hashPassword(password, { salt: Buffer.alloc(16, (++sequence % 250) + 1) }),
      mustChangePassword,
      failedAttempts,
      lockedUntil
    })
    if (user.role === 'super_admin' && user.status === 'active') {
      state.adminGuard.activeSuperAdminCount += 1
    }
    return {
      _id: user._id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      avatarUrl: '',
      openidBound: Boolean(user.openid),
      wecomUserIdBound: false,
      mustChangePassword
    }
  }

  function seedAdmin(id, options = {}) {
    return seedAccount(id, { ...options, role: 'super_admin', status: 'active' })
  }

  function seedUser(id, options = {}) {
    return seedAccount(id, { ...options, role: 'user' })
  }

  return { repository, service, state, calls, seedAdmin, seedUser }
}

module.exports = { createAdminUserHarness }
