const test = require('node:test')
const assert = require('node:assert/strict')
const { createAuthHarness } = require('./helpers/auth-harness')
const { hashPassword, verifyPassword } = require('../lib/password')

const RECOVERY_CODE = 'RECOVERY9-TEST-ONLY'
const INVALID_OPENIDS = [undefined, '', '   ', 42]

function auditKeys(value, keys = []) {
  if (!value || typeof value !== 'object') return keys
  if (Array.isArray(value)) {
    for (const item of value) auditKeys(item, keys)
    return keys
  }
  for (const [key, item] of Object.entries(value)) {
    keys.push(key)
    auditKeys(item, keys)
  }
  return keys
}

function assertAuditPrivacy(audit, forbiddenValues) {
  const forbiddenKey = /password|credential|salt|hash|digest|challenge|token|recoverycode/i
  for (const key of auditKeys(audit)) {
    assert.doesNotMatch(key.replace(/[^a-z0-9]/gi, ''), forbiddenKey)
  }
  const serialized = JSON.stringify(audit)
  for (const forbiddenValue of forbiddenValues) {
    assert.equal(serialized.includes(forbiddenValue), false)
  }
}

test('unknown OpenID is unauthenticated and is not auto-created', async () => {
  const harness = createAuthHarness()
  const result = await harness.service.getSession({ openid: 'wx-new' })
  assert.deepEqual(result, { authenticated: false, requiresInitialization: true })
  assert.equal(harness.state.users.length, 0)
})

test('getSession rejects missing, blank, and non-string trusted OpenID without authenticating or mutating state', async () => {
  for (const openid of INVALID_OPENIDS) {
    const harness = createAuthHarness()
    harness.seedAccount({ username: 'user01', password: 'TempPass8', openid: '' })
    const before = structuredClone(harness.state)
    await assert.rejects(harness.service.getSession({ openid }), error => error.code === 'INVALID_WECHAT_IDENTITY')
    assert.deepEqual(harness.state, before)
  }
})

test('a bound user without a credential fails closed instead of receiving a session', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', openid: 'wx-1' })
  harness.state.credentials.splice(0)
  await assert.rejects(
    harness.service.getSession({ openid: 'wx-1' }),
    error => error.code === 'ACCOUNT_STATE_INVALID'
  )
})

test('temporary-password login returns a ten-minute challenge and does not bind early', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const result = await harness.service.login({ openid: 'wx-1', username: 'USER01', password: 'TempPass8' })
  assert.equal(result.passwordChangeRequired, true)
  assert.equal(typeof result.challengeToken, 'string')
  assert.equal(harness.state.users[0].openid, '')
  assert.notEqual(harness.state.challenges[0].tokenHash, result.challengeToken)
  assert.equal(harness.state.challenges[0].expiresAt - harness.state.challenges[0].createdAt, 10 * 60 * 1000)
  assert.equal(harness.state.challenges[0].credentialVersion, 1)
})

test('temporary login fails closed when an administrator reset lands before challenge creation', async () => {
  const harness = createAuthHarness()
  const user = harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const createChallenge = harness.repository.createChallenge
  harness.repository.createChallenge = async challenge => {
    await harness.repository.updateCredential(user._id, {
      ...hashPassword('ResetPass9'),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null
    })
    return createChallenge(challenge)
  }

  await assert.rejects(
    harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' }),
    error => error.code === 'CREDENTIAL_CHANGED'
  )
  assert.equal(harness.state.challenges.length, 0)
  assert.equal(verifyPassword('ResetPass9', harness.state.credentials[0]), true)
})

test('login rejects missing, blank, and non-string trusted OpenID without challenge, binding, or audit mutation', async () => {
  for (const openid of INVALID_OPENIDS) {
    const harness = createAuthHarness()
    harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
    const before = structuredClone(harness.state)
    await assert.rejects(
      harness.service.login({ openid, username: 'user01', password: 'TempPass8' }),
      error => error.code === 'INVALID_WECHAT_IDENTITY'
    )
    assert.deepEqual(harness.state, before)
  }
})

test('completing first login changes password, consumes challenge, and binds OpenID', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const login = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
  const result = await harness.service.completeFirstLogin({ openid: 'wx-1', challengeToken: login.challengeToken, newPassword: 'NewPass99' })
  assert.equal(result.user.openidBound, true)
  assert.equal(result.user.mustChangePassword, false)
  await assert.rejects(
    harness.service.completeFirstLogin({ openid: 'wx-1', challengeToken: login.challengeToken, newPassword: 'OtherPass9' }),
    error => error.code === 'INVALID_CHALLENGE'
  )
  const relogin = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'NewPass99' })
  assert.equal(relogin.authenticated, true)
  assert.equal(harness.state.credentials[0].credentialVersion, 5)
})

test('completeFirstLogin rejects missing, blank, and non-string trusted OpenID before consuming a challenge', async () => {
  for (const openid of INVALID_OPENIDS) {
    const harness = createAuthHarness()
    harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
    const login = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
    const before = structuredClone(harness.state)
    await assert.rejects(
      harness.service.completeFirstLogin({ openid, challengeToken: login.challengeToken, newPassword: 'NewPass99' }),
      error => error.code === 'INVALID_WECHAT_IDENTITY'
    )
    assert.deepEqual(harness.state, before)
  }
})

test('five bad passwords lock the account for thirty minutes', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: false })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(harness.service.login({ openid: 'wx-1', username: 'user01', password: 'Wrong999' }))
  }
  assert.equal(harness.state.credentials[0].failedAttempts, 5)
  assert.equal(harness.state.credentials[0].credentialVersion, 5)
  assert.equal(harness.state.credentials[0].lockedUntil - Date.parse('2026-08-06T00:00:00.000Z'), 30 * 60 * 1000)
  await assert.rejects(
    harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' }),
    error => error.code === 'ACCOUNT_LOCKED'
  )
})

test('five concurrent bad passwords are counted atomically and lock the account', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: false })
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () => harness.service.login({ openid: 'wx-1', username: 'user01', password: 'Wrong999' }))
  )
  assert.equal(attempts.every(attempt => attempt.status === 'rejected'), true)
  assert.equal(harness.state.credentials[0].failedAttempts, 5)
  assert.equal(harness.state.credentials[0].lockedUntil - Date.parse('2026-08-06T00:00:00.000Z'), 30 * 60 * 1000)
})

test('an account already bound to another OpenID cannot be rebound by login', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: false, openid: 'wx-old' })
  await assert.rejects(
    harness.service.login({ openid: 'wx-new', username: 'user01', password: 'TempPass8' }),
    error => error.code === 'WECHAT_ALREADY_BOUND'
  )
})

test('a valid permanent password resets failures and immediately binds an unbound account', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: false })
  harness.state.credentials[0].failedAttempts = 2
  const result = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
  assert.equal(result.authenticated, true)
  assert.equal(result.user.openidBound, true)
  assert.equal(harness.state.users[0].openid, 'wx-1')
  assert.equal(harness.state.credentials[0].failedAttempts, 0)
  assert.equal(harness.state.credentials[0].lockedUntil, null)
  assert.equal(harness.state.credentials[0].credentialVersion, 2)
})

test('permanent login cannot bind after an administrator reset changes the credential version', async () => {
  const harness = createAuthHarness()
  const user = harness.seedAccount({ username: 'user01', password: 'OldPass88', mustChangePassword: false })
  const bindOpenid = harness.repository.bindOpenid
  harness.repository.bindOpenid = async (...args) => {
    await harness.repository.updateCredential(user._id, {
      ...hashPassword('ResetPass9'),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null
    })
    return bindOpenid(...args)
  }

  await assert.rejects(
    harness.service.login({ openid: 'wx-1', username: 'user01', password: 'OldPass88' }),
    error => error.code === 'CREDENTIAL_CHANGED'
  )
  assert.equal(harness.state.users[0].openid, '')
  assert.equal(verifyPassword('ResetPass9', harness.state.credentials[0]), true)
})

test('disabled accounts cannot obtain sessions or log in', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', status: 'disabled', openid: 'wx-disabled' })
  await assert.rejects(harness.service.getSession({ openid: 'wx-disabled' }), error => error.code === 'ACCOUNT_DISABLED')
  await assert.rejects(
    harness.service.login({ openid: 'wx-disabled', username: 'user01', password: 'TempPass8' }),
    error => error.code === 'ACCOUNT_DISABLED'
  )
})

test('expired challenges are rejected without changing credentials or binding', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const login = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
  harness.advanceTime(10 * 60 * 1000 + 1)
  await assert.rejects(
    harness.service.completeFirstLogin({ openid: 'wx-1', challengeToken: login.challengeToken, newPassword: 'NewPass99' }),
    error => error.code === 'INVALID_CHALLENGE'
  )
  assert.equal(harness.state.credentials[0].mustChangePassword, true)
  assert.equal(harness.state.users[0].openid, '')
})

test('a challenge cannot be used from a different OpenID', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const login = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
  await assert.rejects(
    harness.service.completeFirstLogin({ openid: 'wx-other', challengeToken: login.challengeToken, newPassword: 'NewPass99' }),
    error => error.code === 'INVALID_CHALLENGE'
  )
})

test('failed first-login binding rolls back challenge and credential changes', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const login = await harness.service.login({ openid: 'wx-shared', username: 'user01', password: 'TempPass8' })
  harness.seedAccount({ username: 'user02', password: 'OtherPass8', openid: 'wx-shared' })
  await assert.rejects(
    harness.service.completeFirstLogin({ openid: 'wx-shared', challengeToken: login.challengeToken, newPassword: 'NewPass99' }),
    error => error.code === 'OPENID_ALREADY_BOUND'
  )
  assert.equal(harness.state.challenges[0].consumedAt, null)
  assert.equal(harness.state.credentials[0].mustChangePassword, true)
  assert.equal(harness.state.users[0].openid, '')
})

test('a rolling-back transaction cannot erase an unrelated concurrent audit write', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
  let transactionStarted
  let releaseTransaction
  const started = new Promise(resolve => {
    transactionStarted = resolve
  })
  const paused = new Promise(resolve => {
    releaseTransaction = resolve
  })
  const transaction = harness.repository.consumeChallenge({
    tokenHash: harness.state.challenges[0].tokenHash,
    openid: 'wx-1',
    now: Date.parse('2026-08-06T00:00:00.000Z'),
    apply: async () => {
      transactionStarted()
      await paused
      const error = new Error('test rollback')
      error.code = 'TEST_ROLLBACK'
      throw error
    }
  })
  await started
  const auditWrite = harness.repository.writeAudit({
    action: 'UNRELATED_TEST_EVENT',
    username: 'user01',
    resultCode: 'RECORDED'
  })
  releaseTransaction()
  await assert.rejects(transaction, error => error.code === 'TEST_ROLLBACK')
  await auditWrite
  assert.equal(harness.state.audit.some(entry => entry.action === 'UNRELATED_TEST_EVENT'), true)
})

test('a top-level read cannot observe transaction state that later rolls back', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true, role: 'user' })
  await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
  let transactionStarted
  let releaseTransaction
  const started = new Promise(resolve => {
    transactionStarted = resolve
  })
  const paused = new Promise(resolve => {
    releaseTransaction = resolve
  })
  const transaction = harness.repository.consumeChallenge({
    tokenHash: harness.state.challenges[0].tokenHash,
    openid: 'wx-1',
    now: Date.parse('2026-08-06T00:00:00.000Z'),
    apply: async (transactionRepository, challenge) => {
      transactionRepository.updateUser(challenge.userId, { role: 'super_admin' })
      transactionStarted()
      await paused
      const error = new Error('test rollback')
      error.code = 'TEST_ROLLBACK'
      throw error
    }
  })
  await started
  const read = harness.repository.findUserByUsername('user01')
  releaseTransaction()
  await assert.rejects(transaction, error => error.code === 'TEST_ROLLBACK')
  const observedUser = await read
  assert.equal(observedUser.role, 'user')
})

test('concurrent first-login completions consume a challenge only once', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const login = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' })
  const attempts = await Promise.allSettled([
    harness.service.completeFirstLogin({ openid: 'wx-1', challengeToken: login.challengeToken, newPassword: 'NewPass99' }),
    harness.service.completeFirstLogin({ openid: 'wx-1', challengeToken: login.challengeToken, newPassword: 'OtherPass9' })
  ])
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected' && attempt.reason.code === 'INVALID_CHALLENGE').length, 1)
})

test('a signed-in actor can change a permanent password', async () => {
  const harness = createAuthHarness()
  const actor = harness.seedAccount({ username: 'user01', password: 'OldPass88', openid: 'wx-1' })
  const result = await harness.service.changePassword({ actor, currentPassword: 'OldPass88', newPassword: 'NewPass99' })
  assert.equal(result.user.mustChangePassword, false)
  await assert.rejects(harness.service.login({ openid: 'wx-1', username: 'user01', password: 'OldPass88' }))
  const login = await harness.service.login({ openid: 'wx-1', username: 'user01', password: 'NewPass99' })
  assert.equal(login.authenticated, true)
})

test('password change verifies the current password against the latest reset credential atomically', async () => {
  const harness = createAuthHarness()
  const actor = harness.seedAccount({ username: 'user01', password: 'OldPass88', openid: 'wx-1' })
  const updateCredential = harness.repository.updateCredential
  let intercepted = false
  harness.repository.updateCredential = async (...args) => {
    if (!intercepted) {
      intercepted = true
      await updateCredential(actor._id, {
        ...hashPassword('ResetPass9'),
        mustChangePassword: true,
        failedAttempts: 0,
        lockedUntil: null
      })
    }
    return updateCredential(...args)
  }

  await assert.rejects(
    harness.service.changePassword({ actor, currentPassword: 'OldPass88', newPassword: 'ChangedPass9' }),
    error => error.code === 'INVALID_CREDENTIALS'
  )
  assert.equal(verifyPassword('ResetPass9', harness.state.credentials[0]), true)
  assert.equal(verifyPassword('ChangedPass9', harness.state.credentials[0]), false)
})

test('password change fails closed when the actor credential is missing', async () => {
  const harness = createAuthHarness()
  const actor = harness.seedAccount({ username: 'user01', password: 'OldPass88', openid: 'wx-1' })
  harness.state.credentials.splice(0)
  await assert.rejects(
    harness.service.changePassword({ actor, currentPassword: 'OldPass88', newPassword: 'NewPass99' }),
    error => error.code === 'ACCOUNT_STATE_INVALID'
  )
})

test('the first super administrator can be initialized exactly once', async () => {
  const harness = createAuthHarness()
  const result = await harness.service.initializeSuperAdmin({
    openid: 'wx-admin',
    username: 'RootAdmin',
    displayName: 'Test Administrator',
    temporaryPassword: 'AdminTemp9',
    recoveryCode: RECOVERY_CODE
  })
  assert.equal(result.user.role, 'super_admin')
  assert.equal(result.user.openidBound, true)
  assert.equal(result.user.mustChangePassword, true)
  assert.equal(harness.state.bindings.length, 1)
  await assert.rejects(
    harness.service.initializeSuperAdmin({
      openid: 'wx-second',
      username: 'SecondAdmin',
      displayName: 'Second Test Administrator',
      temporaryPassword: 'AdminTemp8',
      recoveryCode: RECOVERY_CODE
    }),
    error => ['ALREADY_INITIALIZED', 'INVALID_RECOVERY_CODE'].includes(error.code)
  )
})

test('initialization rejects missing, blank, and non-string trusted OpenID before consuming recovery state', async () => {
  for (const openid of INVALID_OPENIDS) {
    const harness = createAuthHarness()
    const before = structuredClone(harness.state)
    await assert.rejects(
      harness.service.initializeSuperAdmin({
        openid,
        username: 'rootadmin',
        displayName: 'Test Administrator',
        temporaryPassword: 'AdminTemp9',
        recoveryCode: RECOVERY_CODE
      }),
      error => error.code === 'INVALID_WECHAT_IDENTITY'
    )
    assert.deepEqual(harness.state, before)
  }
})

test('failed initialization rolls back recovery-code consumption', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'rootadmin', password: 'Existing9' })
  await assert.rejects(
    harness.service.initializeSuperAdmin({
      openid: 'wx-admin',
      username: 'rootadmin',
      displayName: 'Test Administrator',
      temporaryPassword: 'AdminTemp9',
      recoveryCode: RECOVERY_CODE
    }),
    error => error.code === 'USERNAME_TAKEN'
  )
  assert.equal(harness.state.recoveryStates[0].consumedAt, null)
  const result = await harness.service.initializeSuperAdmin({
    openid: 'wx-admin',
    username: 'newroot',
    displayName: 'Test Administrator',
    temporaryPassword: 'AdminTemp9',
    recoveryCode: RECOVERY_CODE
  })
  assert.equal(result.user.username, 'newroot')
})

test('a consumed recovery code cannot be reused', async () => {
  const harness = createAuthHarness()
  await harness.service.initializeSuperAdmin({
    openid: 'wx-admin',
    username: 'rootadmin',
    displayName: 'Test Administrator',
    temporaryPassword: 'AdminTemp9',
    recoveryCode: RECOVERY_CODE
  })
  await assert.rejects(
    harness.service.recoverSuperAdmin({ username: 'rootadmin', temporaryPassword: 'ResetPass9', recoveryCode: RECOVERY_CODE }),
    error => error.code === 'INVALID_RECOVERY_CODE'
  )
})

test('concurrent initialization consumes the recovery code only once', async () => {
  const harness = createAuthHarness()
  const attempts = await Promise.allSettled([
    harness.service.initializeSuperAdmin({
      openid: 'wx-admin-1',
      username: 'rootadmin1',
      displayName: 'Test Administrator One',
      temporaryPassword: 'AdminTemp9',
      recoveryCode: RECOVERY_CODE
    }),
    harness.service.initializeSuperAdmin({
      openid: 'wx-admin-2',
      username: 'rootadmin2',
      displayName: 'Test Administrator Two',
      temporaryPassword: 'OtherTemp9',
      recoveryCode: RECOVERY_CODE
    })
  ])
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected').length, 1)
  assert.equal(harness.state.users.length, 1)
  assert.equal(harness.state.recoveryStates[0].consumedAt !== null, true)
})

test('emergency recovery requires no OpenID, promotes and activates the account, and writes a high-priority audit', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({
    username: 'admin01',
    password: 'OldPass88',
    mustChangePassword: false,
    openid: 'wx-old',
    role: 'user',
    status: 'disabled'
  })
  harness.state.credentials[0].failedAttempts = 5
  harness.state.credentials[0].lockedUntil = Date.parse('2026-08-06T00:30:00.000Z')
  const result = await harness.service.recoverSuperAdmin({
    username: 'ADMIN01',
    temporaryPassword: 'ResetPass9',
    recoveryCode: RECOVERY_CODE
  })
  assert.equal(result.user.role, 'super_admin')
  assert.equal(result.user.status, 'active')
  assert.equal(result.user.openidBound, false)
  assert.equal(harness.state.bindings.length, 0)
  assert.equal(result.user.mustChangePassword, true)
  assert.equal(harness.state.credentials[0].failedAttempts, 0)
  assert.equal(harness.state.credentials[0].lockedUntil, null)
  assert.equal(harness.state.credentials[0].credentialVersion, 2)
  const recoveryAudit = harness.state.audit.find(entry => entry.action === 'RECOVER_SUPER_ADMIN')
  assert.equal(recoveryAudit.priority, 'high')
  assert.equal(recoveryAudit.roleBefore, 'user')
  assert.equal(recoveryAudit.roleAfter, 'super_admin')
  assert.equal(recoveryAudit.statusBefore, 'disabled')
  assert.equal(recoveryAudit.statusAfter, 'active')
  assert.equal(recoveryAudit.resultCode, 'SUPER_ADMIN_RECOVERED')
})

test('emergency recovery gives the repository the normalized username for transactional document revalidation', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({
    username: 'admin01',
    password: 'OldPass88',
    role: 'user',
    status: 'disabled'
  })
  const consumeRecoveryCode = harness.repository.consumeRecoveryCode
  let requestedUsername
  harness.repository.consumeRecoveryCode = options => {
    requestedUsername = options.username
    return consumeRecoveryCode(options)
  }

  await harness.service.recoverSuperAdmin({
    username: '  ADMIN01  ',
    temporaryPassword: 'ResetPass9',
    recoveryCode: RECOVERY_CODE
  })

  assert.equal(requestedUsername, 'admin01')
})

test('bound temporary-password accounts get only a password-change-required session', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true, openid: 'wx-1' })
  const result = await harness.service.getSession({ openid: 'wx-1' })
  assert.equal(result.authenticated, false)
  assert.equal(result.passwordChangeRequired, true)
  assert.equal(result.user.mustChangePassword, true)
})

test('all sensitive authentication paths write required audit evidence without secret-derived fields', async () => {
  const firstLoginHarness = createAuthHarness()
  firstLoginHarness.seedAccount({ username: 'firstuser', password: 'FirstTemp8', mustChangePassword: true })
  const login = await firstLoginHarness.service.login({ openid: 'wx-first', username: 'firstuser', password: 'FirstTemp8' })
  await firstLoginHarness.service.completeFirstLogin({
    openid: 'wx-first',
    challengeToken: login.challengeToken,
    newPassword: 'FirstNew9'
  })

  const initializationHarness = createAuthHarness()
  await initializationHarness.service.initializeSuperAdmin({
    openid: 'wx-admin',
    username: 'rootadmin',
    displayName: 'Test Administrator',
    temporaryPassword: 'AdminTemp9',
    recoveryCode: RECOVERY_CODE
  })

  const recoveryHarness = createAuthHarness()
  recoveryHarness.seedAccount({
    username: 'recoveradmin',
    password: 'BeforeRecover8',
    openid: 'wx-previous',
    role: 'user',
    status: 'disabled'
  })
  await recoveryHarness.service.recoverSuperAdmin({
    username: 'recoveradmin',
    temporaryPassword: 'AfterRecover9',
    recoveryCode: RECOVERY_CODE
  })

  const passwordHarness = createAuthHarness()
  const actor = passwordHarness.seedAccount({ username: 'changeuser', password: 'BeforeChange8', openid: 'wx-change' })
  await passwordHarness.service.changePassword({ actor, currentPassword: 'BeforeChange8', newPassword: 'AfterChange9' })

  const audit = [
    ...firstLoginHarness.state.audit,
    ...initializationHarness.state.audit,
    ...recoveryHarness.state.audit,
    ...passwordHarness.state.audit
  ]
  const firstLoginAudit = audit.find(entry => entry.action === 'COMPLETE_FIRST_LOGIN')
  assert.equal(firstLoginAudit.username, 'firstuser')
  assert.equal(firstLoginAudit.resultCode, 'PASSWORD_CHANGED_AND_BOUND')
  const initializationAudit = audit.find(entry => entry.action === 'INITIALIZE_SUPER_ADMIN')
  assert.equal(initializationAudit.username, 'rootadmin')
  assert.equal(initializationAudit.roleBefore, null)
  assert.equal(initializationAudit.roleAfter, 'super_admin')
  assert.equal(initializationAudit.statusBefore, null)
  assert.equal(initializationAudit.statusAfter, 'active')
  assert.equal(initializationAudit.resultCode, 'SUPER_ADMIN_INITIALIZED')
  const recoveryAudit = audit.find(entry => entry.action === 'RECOVER_SUPER_ADMIN')
  assert.equal(recoveryAudit.username, 'recoveradmin')
  assert.equal(recoveryAudit.priority, 'high')
  assert.equal(recoveryAudit.roleBefore, 'user')
  assert.equal(recoveryAudit.roleAfter, 'super_admin')
  assert.equal(recoveryAudit.statusBefore, 'disabled')
  assert.equal(recoveryAudit.statusAfter, 'active')
  assert.equal(recoveryAudit.resultCode, 'SUPER_ADMIN_RECOVERED')
  const passwordAudit = audit.find(entry => entry.action === 'CHANGE_PASSWORD')
  assert.equal(passwordAudit.username, 'changeuser')
  assert.equal(passwordAudit.resultCode, 'PASSWORD_CHANGED')
  assertAuditPrivacy(audit, [
    'FirstTemp8',
    'FirstNew9',
    login.challengeToken,
    'AdminTemp9',
    RECOVERY_CODE,
    'BeforeRecover8',
    'AfterRecover9',
    'BeforeChange8',
    'AfterChange9'
  ])
})
