const test = require('node:test')
const assert = require('node:assert/strict')
const { verifyPassword } = require('../lib/password')
const { createAdminUserHarness } = require('./helpers/admin-user-harness')

function assertPublicUser(user) {
  for (const forbiddenKey of ['openid', 'algorithm', 'salt', 'hash', 'keyLength', 'failedAttempts', 'lockedUntil']) {
    assert.equal(Object.prototype.hasOwnProperty.call(user, forbiddenKey), false)
  }
  assert.equal(typeof user.openidBound, 'boolean')
}

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

function assertAuditPrivacy(audit, forbiddenValues = []) {
  for (const key of auditKeys(audit)) {
    assert.doesNotMatch(key.replace(/[^a-z0-9]/gi, ''), /password|credential|salt|hash|digest|challenge|token|openid/i)
  }
  const serialized = JSON.stringify(audit)
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false)
}

test('ordinary users cannot list or modify accounts', async () => {
  const harness = createAdminUserHarness()
  const actor = harness.seedUser('user-actor')
  harness.seedUser('user-target')
  const operations = [
    () => harness.service.listUsers({ actor, query: {} }),
    () => harness.service.createUser({ actor, input: { username: 'new-user', displayName: 'New User', temporaryPassword: 'TempPass8', role: 'user' } }),
    () => harness.service.updateUser({ actor, userId: 'user-target', changes: { displayName: 'Changed' } }),
    () => harness.service.resetUserPassword({ actor, userId: 'user-target', temporaryPassword: 'ResetPass8' }),
    () => harness.service.unlockUser({ actor, userId: 'user-target' }),
    () => harness.service.unbindWechat({ actor, userId: 'user-target' })
  ]
  const before = structuredClone(harness.state)
  for (const operation of operations) {
    await assert.rejects(operation(), error => error.code === 'FORBIDDEN')
  }
  assert.deepEqual(harness.state, before)
})

test('administrator creates an active account with normalized unique username and temporary password', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  const created = await harness.service.createUser({
    actor: admin,
    input: { username: ' Staff01 ', displayName: '业务人员', temporaryPassword: 'TempPass8', role: 'user' }
  })
  const storedUser = harness.state.users.find(item => item._id === created._id)
  const credential = harness.state.credentials.find(item => item.userId === created._id)
  assert.equal(created.username, 'Staff01')
  assert.equal(created.status, 'active')
  assert.equal(storedUser.usernameNormalized, 'staff01')
  assert.equal(storedUser.openid, '')
  assert.equal(credential.mustChangePassword, true)
  assert.equal(verifyPassword('TempPass8', credential), true)
  assert.deepEqual(harness.state.adminGuard, {
    _id: 'account-admin-state',
    activeSuperAdminCount: 1,
    revision: 1
  })
  assertPublicUser(created)
})

test('creating an active super administrator increments the shared admin guard', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  await harness.service.createUser({
    actor: admin,
    input: { username: 'Admin02', displayName: 'Second Admin', temporaryPassword: 'TempPass8', role: 'super_admin' }
  })
  assert.equal(harness.state.adminGuard.activeSuperAdminCount, 2)
  assert.equal(harness.state.adminGuard.revision, 1)
  assert.equal(harness.state.audit.length, 1)
})

test('username uniqueness is enforced after trimming and case normalization', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', { username: 'Staff01' })
  await assert.rejects(
    harness.service.createUser({
      actor: admin,
      input: { username: ' staff01 ', displayName: 'Duplicate', temporaryPassword: 'TempPass8', role: 'user' }
    }),
    error => error.code === 'USERNAME_TAKEN'
  )
  assert.equal(harness.state.users.length, 2)
  assert.equal(harness.state.audit.length, 0)
})

test('concurrent creates with the same normalized username commit one account, credential, guard touch, and audit', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  const results = await Promise.allSettled([
    harness.service.createUser({
      actor: admin,
      input: { username: ' Staff02 ', displayName: 'First Attempt', temporaryPassword: 'FirstPass8', role: 'user' }
    }),
    harness.service.createUser({
      actor: admin,
      input: { username: 'staff02', displayName: 'Second Attempt', temporaryPassword: 'SecondPass8', role: 'user' }
    })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'USERNAME_TAKEN').length, 1)
  assert.equal(harness.state.users.filter(user => user.usernameNormalized === 'staff02').length, 1)
  assert.equal(harness.state.credentials.filter(credential => credential.userId !== 'admin-1').length, 1)
  assert.equal(harness.state.audit.length, 1)
  assert.equal(harness.state.adminGuard.activeSuperAdminCount, 1)
  assert.equal(harness.state.adminGuard.revision, 1)
})

test('username is immutable and only displayName, role, and status are accepted updates', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', { username: 'Staff01' })
  const updated = await harness.service.updateUser({
    actor: admin,
    userId: 'user-1',
    changes: { displayName: 'Renamed Staff', role: 'super_admin', status: 'active' }
  })
  assert.equal(updated.displayName, 'Renamed Staff')
  assert.equal(updated.role, 'super_admin')
  assert.equal(updated.username, 'Staff01')
  assertPublicUser(updated)

  await assert.rejects(
    harness.service.updateUser({ actor: admin, userId: 'user-1', changes: { username: 'changed' } }),
    error => error.code === 'IMMUTABLE_USERNAME'
  )
  await assert.rejects(
    harness.service.updateUser({ actor: admin, userId: 'user-1', changes: { openid: 'wx-injected' } }),
    error => error.code === 'INVALID_CHANGES'
  )
  await assert.rejects(
    harness.service.updateUser({ actor: admin, userId: 'user-1', changes: { role: 'administrator' } }),
    error => error.code === 'INVALID_ROLE'
  )
  await assert.rejects(
    harness.service.updateUser({ actor: admin, userId: 'user-1', changes: { status: 'deleted' } }),
    error => error.code === 'INVALID_STATUS'
  )
  assert.equal(harness.state.audit.length, 1)
})

test('cannot disable or demote the final active super administrator', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  await assert.rejects(
    harness.service.updateUser({ actor: admin, userId: 'admin-1', changes: { status: 'disabled' } }),
    error => error.code === 'LAST_SUPER_ADMIN'
  )
  await assert.rejects(
    harness.service.updateUser({ actor: admin, userId: 'admin-1', changes: { role: 'user' } }),
    error => error.code === 'LAST_SUPER_ADMIN'
  )
  assert.equal(harness.state.audit.length, 0)
  assert.equal(harness.state.adminGuard.activeSuperAdminCount, 1)
  assert.equal(harness.state.adminGuard.revision, 0)
})

test('promoting another administrator allows the current administrator to be demoted', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1')
  await harness.service.updateUser({ actor: admin, userId: 'user-1', changes: { role: 'super_admin' } })
  const demoted = await harness.service.updateUser({ actor: admin, userId: 'admin-1', changes: { role: 'user' } })
  assert.equal(demoted.role, 'user')
  assert.equal(harness.state.users.filter(user => user.role === 'super_admin' && user.status === 'active').length, 1)
  assert.equal(harness.state.adminGuard.activeSuperAdminCount, 1)
  assert.equal(harness.state.adminGuard.revision, 2)
})

test('concurrent demote and disable operations cannot remove all active super administrators', async () => {
  const harness = createAdminUserHarness()
  const firstAdmin = harness.seedAdmin('admin-1')
  const secondAdmin = harness.seedAdmin('admin-2')
  const results = await Promise.allSettled([
    harness.service.updateUser({ actor: firstAdmin, userId: 'admin-1', changes: { status: 'disabled' } }),
    harness.service.updateUser({ actor: secondAdmin, userId: 'admin-2', changes: { role: 'user' } })
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'LAST_SUPER_ADMIN').length, 1)
  assert.equal(harness.state.users.filter(user => user.role === 'super_admin' && user.status === 'active').length, 1)
  assert.equal(harness.state.audit.length, 1)
  assert.equal(harness.state.adminGuard.activeSuperAdminCount, 1)
  assert.equal(harness.state.adminGuard.revision, 1)
})

test('user listing rejects malformed queries with typed errors before repository access', async t => {
  const cases = [
    { name: 'undefined query', query: undefined, code: 'INVALID_QUERY' },
    { name: 'null query', query: null, code: 'INVALID_QUERY' },
    { name: 'boolean query', query: true, code: 'INVALID_QUERY' },
    { name: 'false query', query: false, code: 'INVALID_QUERY' },
    { name: 'array query', query: [], code: 'INVALID_QUERY' },
    { name: 'date query', query: new Date(0), code: 'INVALID_QUERY' },
    { name: 'string page', query: { page: '1' }, code: 'INVALID_PAGINATION' },
    { name: 'boolean page', query: { page: true }, code: 'INVALID_PAGINATION' },
    { name: 'fractional page', query: { page: 1.5 }, code: 'INVALID_PAGINATION' },
    { name: 'unsafe page', query: { page: Number.MAX_SAFE_INTEGER + 1 }, code: 'INVALID_PAGINATION' },
    { name: 'zero page', query: { page: 0 }, code: 'INVALID_PAGINATION' },
    { name: 'string page size', query: { pageSize: '20' }, code: 'INVALID_PAGINATION' },
    { name: 'boolean page size', query: { pageSize: false }, code: 'INVALID_PAGINATION' },
    { name: 'fractional page size', query: { pageSize: 1.5 }, code: 'INVALID_PAGINATION' },
    { name: 'zero page size', query: { pageSize: 0 }, code: 'INVALID_PAGINATION' },
    { name: 'oversized page size', query: { pageSize: 101 }, code: 'INVALID_PAGINATION' },
    { name: 'non-string status', query: { status: 1 }, code: 'INVALID_STATUS' },
    { name: 'unknown status', query: { status: 'blocked' }, code: 'INVALID_STATUS' },
    { name: 'empty status', query: { status: '' }, code: 'INVALID_STATUS' },
    { name: 'non-string keyword', query: { keyword: 1 }, code: 'INVALID_KEYWORD' }
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const harness = createAdminUserHarness()
      const admin = harness.seedAdmin('admin-1')
      await assert.rejects(
        harness.service.listUsers({ actor: admin, query: item.query }),
        error => error.code === item.code
      )
      assert.deepEqual(harness.calls, [])
    })
  }
})

test('user listing supports pagination and returns public projections only', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1', { username: 'root' })
  harness.seedUser('user-1', { username: 'alpha' })
  harness.seedUser('user-2', { username: 'bravo' })
  harness.seedUser('user-3', { username: 'charlie' })
  harness.seedUser('user-4', {
    username: 'delta',
    openid: 'wx-delta',
    failedAttempts: 5,
    lockedUntil: Date.parse('2026-08-06T00:30:00.000Z')
  })
  const result = await harness.service.listUsers({ actor: admin, query: { page: 2, pageSize: 2 } })
  assert.equal(result.page, 2)
  assert.equal(result.pageSize, 2)
  assert.equal(result.total, 5)
  assert.deepEqual(result.items.map(user => user.username), ['charlie', 'delta'])
  for (const user of result.items) assertPublicUser(user)
  assert.equal(result.items[1].openidBound, true)
  assert.equal(result.items[1].locked, true)
})

test('user listing filters by status', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', { username: 'active-user' })
  harness.seedUser('user-2', { username: 'disabled-user', status: 'disabled' })
  const result = await harness.service.listUsers({ actor: admin, query: { status: 'disabled' } })
  assert.equal(result.total, 1)
  assert.deepEqual(result.items.map(user => user.username), ['disabled-user'])
})

test('user listing applies a trimmed case-insensitive keyword to username and display name', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', { username: 'Staff01', displayName: 'East Region' })
  harness.seedUser('user-2', { username: 'worker02', displayName: 'North Staff' })
  harness.seedUser('user-3', { username: 'worker03', displayName: 'South Region' })
  const result = await harness.service.listUsers({ actor: admin, query: { keyword: '  STAFF  ' } })
  assert.equal(result.total, 2)
  assert.deepEqual(result.items.map(user => user.username), ['Staff01', 'worker02'])
})

test('password reset issues a temporary password state, clears locks, and invalidates unused challenges', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', {
    failedAttempts: 5,
    lockedUntil: Date.parse('2026-08-06T00:30:00.000Z'),
    password: 'BeforePass8'
  })
  harness.state.challenges.push(
    { _id: 'challenge-unused', userId: 'user-1', consumedAt: null },
    { _id: 'challenge-used', userId: 'user-1', consumedAt: 123 },
    { _id: 'challenge-other', userId: 'other-user', consumedAt: null }
  )
  const result = await harness.service.resetUserPassword({ actor: admin, userId: 'user-1', temporaryPassword: 'ResetPass8' })
  const credential = harness.state.credentials.find(item => item.userId === 'user-1')
  assert.equal(credential.mustChangePassword, true)
  assert.equal(credential.failedAttempts, 0)
  assert.equal(credential.lockedUntil, null)
  assert.equal(verifyPassword('ResetPass8', credential), true)
  assert.equal(harness.state.challenges.find(item => item._id === 'challenge-unused').consumedAt, Date.parse('2026-08-06T00:00:00.000Z'))
  assert.equal(harness.state.challenges.find(item => item._id === 'challenge-used').consumedAt, 123)
  assert.equal(harness.state.challenges.find(item => item._id === 'challenge-other').consumedAt, null)
  assertPublicUser(result)
  assertAuditPrivacy(harness.state.audit, ['BeforePass8', 'ResetPass8'])
})

test('unlock clears lock state without changing password material', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', { failedAttempts: 5, lockedUntil: Date.parse('2026-08-06T00:30:00.000Z') })
  const before = structuredClone(harness.state.credentials.find(item => item.userId === 'user-1'))
  const result = await harness.service.unlockUser({ actor: admin, userId: 'user-1' })
  const after = harness.state.credentials.find(item => item.userId === 'user-1')
  assert.equal(after.failedAttempts, 0)
  assert.equal(after.lockedUntil, null)
  assert.equal(after.algorithm, before.algorithm)
  assert.equal(after.salt, before.salt)
  assert.equal(after.hash, before.hash)
  assertPublicUser(result)
})

test('OpenID unbind confirms the account exists and returns only bound state', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', { openid: 'wx-sensitive-user-1' })
  const result = await harness.service.unbindWechat({ actor: admin, userId: 'user-1' })
  assert.equal(harness.state.users.find(item => item._id === 'user-1').openid, '')
  assert.equal(result.openidBound, false)
  assertPublicUser(result)
  await assert.rejects(
    harness.service.unbindWechat({ actor: admin, userId: 'missing-user' }),
    error => error.code === 'ACCOUNT_NOT_FOUND'
  )
  assert.equal(harness.state.audit.length, 1)
  assertAuditPrivacy(harness.state.audit, ['wx-sensitive-user-1'])
})

test('each successful mutation writes exactly one secret-free audit record', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1', {
    openid: 'wx-sensitive-user-1',
    failedAttempts: 5,
    lockedUntil: Date.parse('2026-08-06T00:30:00.000Z')
  })
  const created = await harness.service.createUser({
    actor: admin,
    input: { username: 'Created01', displayName: 'Created User', temporaryPassword: 'CreatePass8', role: 'user' }
  })
  assert.equal(harness.state.audit.length, 1)
  await harness.service.updateUser({ actor: admin, userId: created._id, changes: { displayName: 'Updated User' } })
  assert.equal(harness.state.audit.length, 2)
  await harness.service.resetUserPassword({ actor: admin, userId: 'user-1', temporaryPassword: 'ResetPass8' })
  assert.equal(harness.state.audit.length, 3)
  await harness.service.unlockUser({ actor: admin, userId: 'user-1' })
  assert.equal(harness.state.audit.length, 4)
  await harness.service.unbindWechat({ actor: admin, userId: 'user-1' })
  assert.equal(harness.state.audit.length, 5)
  assert.deepEqual(harness.state.audit.map(entry => entry.action), [
    'CREATE_USER',
    'UPDATE_USER',
    'RESET_USER_PASSWORD',
    'UNLOCK_USER',
    'UNBIND_WECHAT'
  ])
  for (const entry of harness.state.audit) {
    assert.equal(entry.actorUserId, 'admin-1')
    assert.equal(typeof entry.targetUserId, 'string')
    assert.equal(entry.createdAt, Date.parse('2026-08-06T00:00:00.000Z'))
  }
  assertAuditPrivacy(harness.state.audit, ['CreatePass8', 'ResetPass8', 'wx-sensitive-user-1'])
})
