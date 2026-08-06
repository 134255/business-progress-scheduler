const ALLOWED_ROLES = new Set(['user', 'super_admin'])
const ALLOWED_STATUSES = new Set(['active', 'disabled'])
const ALLOWED_UPDATE_FIELDS = new Set(['displayName', 'role', 'status'])

function createError(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

function requireSuperAdmin(actor) {
  if (!actor || actor.role !== 'super_admin' || actor.status !== 'active') {
    throw createError('FORBIDDEN', '仅超级管理员可以执行该操作')
  }
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function displayUsername(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function assertRole(role) {
  if (!ALLOWED_ROLES.has(role)) throw createError('INVALID_ROLE')
}

function assertStatus(status) {
  if (!ALLOWED_STATUSES.has(status)) throw createError('INVALID_STATUS')
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateListQuery(query) {
  if (!isPlainObject(query)) throw createError('INVALID_QUERY')
  if (hasOwn(query, 'page') &&
      (typeof query.page !== 'number' || !Number.isSafeInteger(query.page) || query.page <= 0)) {
    throw createError('INVALID_PAGINATION')
  }
  if (hasOwn(query, 'pageSize') &&
      (typeof query.pageSize !== 'number' || !Number.isSafeInteger(query.pageSize) || query.pageSize <= 0 || query.pageSize > 100)) {
    throw createError('INVALID_PAGINATION')
  }
  const page = hasOwn(query, 'page') ? query.page : 1
  const pageSize = hasOwn(query, 'pageSize') ? query.pageSize : 20
  if (!Number.isSafeInteger((page - 1) * pageSize)) throw createError('INVALID_PAGINATION')
  if (hasOwn(query, 'status') &&
      (typeof query.status !== 'string' || (query.status !== 'all' && !ALLOWED_STATUSES.has(query.status)))) {
    throw createError('INVALID_STATUS')
  }
  if (hasOwn(query, 'keyword') && typeof query.keyword !== 'string') throw createError('INVALID_KEYWORD')
  return {
    page,
    pageSize,
    status: query.status && query.status !== 'all' ? query.status : undefined,
    keyword: hasOwn(query, 'keyword') ? query.keyword.trim().toLowerCase() : ''
  }
}

function createAdminUserService({ repository, hashPassword, clock }) {
  function publicUser(user, credential) {
    const result = {
      _id: user._id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      avatarUrl: user.avatarUrl || '',
      openidBound: Boolean(user.openid),
      wecomUserIdBound: Boolean(user.wecomUserId)
    }
    if (credential) {
      result.mustChangePassword = Boolean(credential.mustChangePassword)
      result.locked = Boolean(credential.lockedUntil && credential.lockedUntil > clock())
    }
    return result
  }

  function audit(actor, target, action, resultCode, details = {}) {
    return {
      action,
      actorUserId: actor._id,
      targetUserId: target && target._id,
      username: target && target.username,
      resultCode,
      ...details,
      createdAt: clock()
    }
  }

  async function listUsers({ actor, query }) {
    requireSuperAdmin(actor)
    const { page, pageSize, status, keyword } = validateListQuery(query)
    const result = await repository.listUsers({ page, pageSize, status, keyword })
    return {
      items: result.items.map(item => item && item.user
        ? publicUser(item.user, item.credential)
        : publicUser(item)),
      page,
      pageSize,
      total: result.total,
      hasMore: page * pageSize < result.total
    }
  }

  async function createUser({ actor, input = {} }) {
    requireSuperAdmin(actor)
    const username = displayUsername(input.username)
    const usernameNormalized = normalizeUsername(input.username)
    if (!usernameNormalized) throw createError('INVALID_USERNAME')
    const role = input.role || 'user'
    assertRole(role)
    const createdAt = clock()
    const user = {
      username,
      usernameNormalized,
      displayName: typeof input.displayName === 'string' ? input.displayName.trim() : '',
      role,
      status: 'active',
      avatarUrl: '',
      openid: '',
      wecomUserId: '',
      createdAt,
      updatedAt: createdAt
    }
    const credential = {
      ...hashPassword(input.temporaryPassword),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
      createdAt,
      updatedAt: createdAt
    }
    const created = await repository.createAccountWithAdminGuard({
      user,
      credential,
      audit: audit(actor, user, 'CREATE_USER', 'USER_CREATED', {
        roleBefore: null,
        roleAfter: role,
        statusBefore: null,
        statusAfter: 'active'
      })
    })
    return publicUser(created, credential)
  }

  function validatedChanges(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw createError('INVALID_CHANGES')
    const keys = Object.keys(changes)
    if (keys.includes('username') || keys.includes('usernameNormalized')) throw createError('IMMUTABLE_USERNAME')
    if (keys.length === 0 || keys.some(key => !ALLOWED_UPDATE_FIELDS.has(key))) throw createError('INVALID_CHANGES')
    if (Object.prototype.hasOwnProperty.call(changes, 'role')) assertRole(changes.role)
    if (Object.prototype.hasOwnProperty.call(changes, 'status')) assertStatus(changes.status)
    return {
      ...(Object.prototype.hasOwnProperty.call(changes, 'displayName')
        ? { displayName: typeof changes.displayName === 'string' ? changes.displayName.trim() : '' }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(changes, 'role') ? { role: changes.role } : {}),
      ...(Object.prototype.hasOwnProperty.call(changes, 'status') ? { status: changes.status } : {})
    }
  }

  async function updateUser({ actor, userId, changes }) {
    requireSuperAdmin(actor)
    const safeChanges = validatedChanges(changes)
    return repository.runAdminGuardTransaction(async transactionRepository => {
      const user = await transactionRepository.findUserById(userId)
      if (!user) throw createError('ACCOUNT_NOT_FOUND')
      const roleAfter = safeChanges.role || user.role
      const statusAfter = safeChanges.status || user.status
      const wasActiveSuperAdmin = user.role === 'super_admin' && user.status === 'active'
      const isActiveSuperAdmin = roleAfter === 'super_admin' && statusAfter === 'active'
      const guard = await transactionRepository.getAdminGuard()
      if (!guard || !Number.isSafeInteger(guard.activeSuperAdminCount) || guard.activeSuperAdminCount < 0) {
        throw createError('ACCOUNT_STATE_INVALID')
      }
      if (wasActiveSuperAdmin && !isActiveSuperAdmin && guard.activeSuperAdminCount <= 1) {
        throw createError('LAST_SUPER_ADMIN')
      }
      const updated = await transactionRepository.updateUserAndAdminGuard(userId, { ...safeChanges, updatedAt: clock() })
      await transactionRepository.writeAudit(audit(actor, updated, 'UPDATE_USER', 'USER_UPDATED', {
        roleBefore: user.role,
        roleAfter: updated.role,
        statusBefore: user.status,
        statusAfter: updated.status
      }))
      const credential = await transactionRepository.findCredential(userId)
      return publicUser(updated, credential)
    })
  }

  async function resetUserPassword({ actor, userId, temporaryPassword }) {
    requireSuperAdmin(actor)
    const passwordRecord = hashPassword(temporaryPassword)
    return repository.runUserTransaction(async transactionRepository => {
      const user = await transactionRepository.findUserById(userId)
      if (!user) throw createError('ACCOUNT_NOT_FOUND')
      const credential = await transactionRepository.findCredential(userId)
      if (!credential) throw createError('ACCOUNT_NOT_FOUND')
      const updatedCredential = await transactionRepository.updateCredential(userId, {
        ...passwordRecord,
        mustChangePassword: true,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: clock()
      })
      await transactionRepository.invalidateChallenges(userId, clock())
      await transactionRepository.writeAudit(audit(actor, user, 'RESET_USER_PASSWORD', 'PASSWORD_RESET'))
      return publicUser(user, updatedCredential)
    })
  }

  async function unlockUser({ actor, userId }) {
    requireSuperAdmin(actor)
    return repository.runUserTransaction(async transactionRepository => {
      const user = await transactionRepository.findUserById(userId)
      if (!user) throw createError('ACCOUNT_NOT_FOUND')
      const credential = await transactionRepository.findCredential(userId)
      if (!credential) throw createError('ACCOUNT_NOT_FOUND')
      const updatedCredential = await transactionRepository.updateCredential(userId, {
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: clock()
      })
      await transactionRepository.writeAudit(audit(actor, user, 'UNLOCK_USER', 'USER_UNLOCKED'))
      return publicUser(user, updatedCredential)
    })
  }

  async function unbindWechat({ actor, userId }) {
    requireSuperAdmin(actor)
    return repository.runUserTransaction(async transactionRepository => {
      const user = await transactionRepository.findUserById(userId)
      if (!user) throw createError('ACCOUNT_NOT_FOUND')
      const updated = await transactionRepository.updateUser(userId, { openid: '', updatedAt: clock() })
      await transactionRepository.writeAudit(audit(actor, updated, 'UNBIND_WECHAT', 'WECHAT_UNBOUND'))
      const credential = await transactionRepository.findCredential(userId)
      return publicUser(updated, credential)
    })
  }

  return { listUsers, createUser, updateUser, resetUserPassword, unlockUser, unbindWechat }
}

module.exports = { createAdminUserService }
