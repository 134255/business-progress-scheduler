const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createCloudAccountRepository,
  ADMIN_GUARD_ID,
  bindingIdForOpenid
} = require('../lib/cloud-account-repository')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

function createRepository(seed = {}, ids = []) {
  const fake = createFakeCloudDatabase(seed)
  let idIndex = 0
  const repository = createCloudAccountRepository({
    db: fake.db,
    clock: () => new Date('2026-08-06T00:00:00.000Z'),
    idFactory: prefix => ids[idIndex++] || `${prefix}-${idIndex}`
  })
  return { fake, repository }
}

test('active super-admin count comes from the stable singleton guard document', async () => {
  const { fake, repository } = createRepository({
    system_settings: [{
      _id: 'account_admin_state',
      activeSuperAdminCount: 2,
      revision: 7
    }]
  })

  assert.equal(ADMIN_GUARD_ID, 'account_admin_state')
  assert.equal(await repository.countActiveSuperAdmins(), 2)
  assert.deepEqual(fake.transactionQueries, [])
})

test('active super-admin count fails closed when the singleton guard is missing or corrupt', async () => {
  const missing = createRepository()
  await assert.rejects(missing.repository.countActiveSuperAdmins(), error => error.code === 'ACCOUNT_STATE_INVALID')
  const corrupt = createRepository({
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: -1, revision: 0 }]
  })
  await assert.rejects(corrupt.repository.countActiveSuperAdmins(), error => error.code === 'ACCOUNT_STATE_INVALID')
})

test('fixed-document reads normalize only CloudBase missing-document failures', async () => {
  const { repository } = createRepository()

  assert.equal(await repository.findUserByOpenid('wx-unbound'), null)

  const permissionFailure = new Error('document.get:fail permission denied')
  const failingRepository = createCloudAccountRepository({
    db: {
      collection() {
        return {
          doc() {
            return { get: async () => { throw permissionFailure } }
          }
        }
      }
    }
  })

  await assert.rejects(
    failingRepository.findUserById('unreadable-user'),
    error => error === permissionFailure
  )
})

test('guarded account creation atomically writes user, credential, guard, and patched audit', async () => {
  const { fake, repository } = createRepository({
    system_settings: [{
      _id: ADMIN_GUARD_ID,
      activeSuperAdminCount: 1,
      revision: 3
    }]
  }, ['user-created', 'audit-created'])

  const created = await repository.createAccountWithAdminGuard({
    user: {
      username: 'Admin Two',
      usernameNormalized: 'admin two',
      displayName: 'Admin Two',
      role: 'super_admin',
      status: 'active',
      openid: ''
    },
    credential: {
      algorithm: 'scrypt',
      salt: 'test-salt',
      hash: 'test-hash',
      mustChangePassword: true
    },
    audit: {
      action: 'CREATE_USER',
      targetUserId: undefined,
      resultCode: 'USER_CREATED',
      createdAt: new Date('2000-01-01T00:00:00.000Z')
    }
  })

  assert.equal(created._id, 'user-created')
  assert.equal(Object.hasOwn(fake.documents('users')[0], 'openid'), false)
  assert.equal(fake.documents('user_credentials')[0]._id, 'user-created')
  assert.equal(fake.documents('user_credentials')[0].userId, 'user-created')
  assert.deepEqual(fake.documents('system_settings')[0], {
    _id: ADMIN_GUARD_ID,
    activeSuperAdminCount: 2,
    revision: 4
  })
  const audit = fake.documents('audit_logs')[0]
  assert.equal(audit.targetUserId, 'user-created')
  assert.deepEqual(audit.createdAt, { __serverDate: 1 })
  assert.deepEqual(fake.transactionQueries, [])
  assert.equal(fake.transactionRuns.length, 1)
})

test('guarded account creation maps duplicate usernames and rolls back the whole transaction', async () => {
  const { fake, repository } = createRepository({
    users: [{ _id: 'existing', usernameNormalized: 'taken', role: 'user', status: 'active' }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 5 }]
  }, ['user-collision', 'audit-unused'])

  await assert.rejects(
    repository.createAccountWithAdminGuard({
      user: { username: 'Taken', usernameNormalized: 'taken', role: 'user', status: 'active', openid: '' },
      credential: { hash: 'test-hash' },
      audit: { action: 'CREATE_USER' }
    }),
    error => error.code === 'USERNAME_TAKEN'
  )

  assert.equal(fake.documents('users').length, 1)
  assert.equal(fake.documents('user_credentials').length, 0)
  assert.equal(fake.documents('audit_logs').length, 0)
  assert.equal(fake.documents('system_settings')[0].revision, 5)
})

test('multiple unbound accounts persist without OpenID fields or binding reservations', async () => {
  const { fake, repository } = createRepository({
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 0 }]
  }, ['user-1', 'audit-1', 'user-2', 'audit-2'])
  for (const username of ['first', 'second']) {
    await repository.createAccountWithAdminGuard({
      user: { username, usernameNormalized: username, role: 'user', status: 'active', openid: '' },
      credential: { hash: `hash-${username}` },
      audit: { action: 'CREATE_USER' }
    })
  }
  assert.equal(fake.documents('users').length, 2)
  assert.equal(fake.documents('users').every(user => !Object.hasOwn(user, 'openid')), true)
  assert.equal(fake.documents('wechat_bindings').length, 0)
})

test('guarded user transitions update the user and singleton count from the same snapshot', async () => {
  const { fake, repository } = createRepository({
    users: [{
      _id: 'user-1',
      username: 'user01',
      usernameNormalized: 'user01',
      role: 'user',
      status: 'disabled',
      openid: 'wx-old'
    }],
    user_credentials: [{ _id: 'user-1', userId: 'user-1', hash: 'test-hash' }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 8 }]
  }, ['audit-transition'])

  const result = await repository.runAdminGuardTransaction(async transactionRepository => {
    const before = await transactionRepository.findUserById('user-1')
    assert.equal(before.role, 'user')
    assert.deepEqual(await transactionRepository.getAdminGuard(), {
      _id: ADMIN_GUARD_ID,
      activeSuperAdminCount: 1,
      revision: 8
    })
    const updated = await transactionRepository.updateUserAndAdminGuard('user-1', {
      role: 'super_admin',
      status: 'active',
      openid: ''
    })
    await transactionRepository.writeAudit({ action: 'UPDATE_USER', targetUserId: 'user-1' })
    return updated
  })

  assert.equal(result.role, 'super_admin')
  assert.equal(Object.hasOwn(fake.documents('users')[0], 'openid'), false)
  assert.equal(fake.documents('system_settings')[0].activeSuperAdminCount, 2)
  assert.equal(fake.documents('system_settings')[0].revision, 9)
  assert.deepEqual(fake.documents('audit_logs')[0].createdAt, { __serverDate: 1 })
  assert.deepEqual(fake.transactionQueries, [])
})

test('transaction-local updateUser also maintains the shared guard invariant for recovery transitions', async () => {
  const { fake, repository } = createRepository({
    users: [{ _id: 'recover-1', username: 'recover', usernameNormalized: 'recover', role: 'user', status: 'disabled' }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 4 }]
  })

  await repository.runUserTransaction(transactionRepository => transactionRepository.updateUser('recover-1', {
    role: 'super_admin',
    status: 'active'
  }))

  assert.equal(fake.documents('system_settings')[0].activeSuperAdminCount, 2)
  assert.equal(fake.documents('system_settings')[0].revision, 5)
  assert.deepEqual(fake.transactionQueries, [])
})

test('account lookup and listing use top-level queries and return paired credentials', async () => {
  const alphaBindingId = bindingIdForOpenid('wx-alpha')
  const { repository } = createRepository({
    users: [
      { _id: 'u-1', username: 'Alpha', usernameNormalized: 'alpha', displayName: 'First', role: 'user', status: 'active', openid: 'wx-alpha' },
      { _id: 'u-2', username: 'Beta', usernameNormalized: 'beta', displayName: 'Second Match', role: 'user', status: 'disabled' },
      { _id: 'u-3', username: 'GammaMatch', usernameNormalized: 'gammamatch', displayName: 'Third', role: 'user', status: 'disabled' }
    ],
    user_credentials: [
      { _id: 'u-1', userId: 'u-1', mustChangePassword: false },
      { _id: 'u-2', userId: 'u-2', mustChangePassword: true },
      { _id: 'u-3', userId: 'u-3', mustChangePassword: false }
    ],
    wechat_bindings: [{ _id: alphaBindingId, userId: 'u-1' }]
  })

  assert.equal((await repository.findUserByUsername('alpha'))._id, 'u-1')
  assert.equal((await repository.findUserByOpenid('wx-alpha'))._id, 'u-1')
  assert.equal((await repository.findUserById('u-2')).usernameNormalized, 'beta')
  assert.equal((await repository.findCredential('u-3')).userId, 'u-3')
  const result = await repository.listUsers({ page: 1, pageSize: 1, status: 'disabled', keyword: 'match' })
  assert.equal(result.total, 2)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].user._id, 'u-2')
  assert.equal(result.items[0].credential.mustChangePassword, true)
})

test('credential updates are atomic, date fields are concrete Dates, and audit timestamps are server dates', async () => {
  const { fake, repository } = createRepository({
    user_credentials: [{
      _id: 'u-1',
      userId: 'u-1',
      failedAttempts: 4,
      lockedUntil: null,
      expiresAt: null
    }]
  }, ['audit-login'])

  const updated = await repository.updateCredential('u-1', current => ({
    failedAttempts: current.failedAttempts + 1,
    lockedUntil: Date.parse('2026-08-06T00:30:00.000Z')
  }))
  await repository.writeAudit({
    action: 'LOGIN',
    createdAt: new Date('2000-01-01T00:00:00.000Z')
  })

  assert.equal(updated.failedAttempts, 5)
  assert.equal(updated.credentialVersion, 1)
  assert.equal(updated.lockedUntil instanceof Date, true)
  assert.equal(fake.documents('user_credentials')[0].lockedUntil instanceof Date, true)
  assert.equal(fake.transactionRuns.length, 1)
  assert.deepEqual(fake.documents('audit_logs')[0].createdAt, { __serverDate: 1 })
  assert.deepEqual(fake.transactionQueries, [])
})

test('challenge creation stores concrete dates and concurrent consumption invokes the callback once', async () => {
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'user01', usernameNormalized: 'user01', role: 'user', status: 'active' }],
    user_credentials: [{ _id: 'u-1', userId: 'u-1', challengeEpoch: 0, credentialVersion: 0 }]
  }, ['challenge-1'])
  await repository.createChallenge({
    userId: 'u-1',
    username: 'user01',
    openid: 'wx-1',
    tokenHash: 'token-digest',
    createdAt: Date.parse('2026-08-06T00:00:00.000Z'),
    expiresAt: Date.parse('2026-08-06T00:10:00.000Z'),
    consumedAt: null,
    expectedCredentialVersion: 0
  })
  assert.equal(fake.documents('auth_challenges')[0].expiresAt instanceof Date, true)
  assert.equal(fake.documents('auth_challenges')[0].credentialVersion, 0)
  let callbackCount = 0
  const consume = () => repository.consumeChallenge({
    tokenHash: 'token-digest',
    openid: 'wx-1',
    now: new Date('2026-08-06T00:05:00.000Z'),
    apply: async (transactionRepository, challenge) => {
      callbackCount += 1
      assert.equal(challenge._id, 'challenge-1')
      assert.equal((await transactionRepository.findUserByUsername('user01'))._id, 'u-1')
      return 'consumed'
    }
  })

  const attempts = await Promise.allSettled([consume(), consume()])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(result => result.status === 'rejected' && result.reason.code === 'INVALID_CHALLENGE').length, 1)
  assert.equal(callbackCount, 1)
  assert.equal(fake.documents('auth_challenges')[0].consumedAt instanceof Date, true)
  assert.deepEqual(fake.transactionQueries, [])
})

test('challenge consumption revalidates expiry and identity before invoking the callback', async () => {
  const { repository } = createRepository({
    users: [{ _id: 'u-1', username: 'user01', usernameNormalized: 'user01', role: 'user', status: 'active' }],
    user_credentials: [{ _id: 'u-1', userId: 'u-1', challengeEpoch: 0, credentialVersion: 0 }],
    auth_challenges: [{
      _id: 'challenge-1',
      userId: 'u-1',
      username: 'user01',
      openid: 'wx-1',
      tokenHash: 'token-digest',
      challengeEpoch: 0,
      credentialVersion: 0,
      expiresAt: new Date('2026-08-06T00:10:00.000Z'),
      consumedAt: null
    }]
  })
  let callbackCount = 0

  await assert.rejects(repository.consumeChallenge({
    tokenHash: 'token-digest',
    openid: 'wx-other',
    now: new Date('2026-08-06T00:05:00.000Z'),
    apply: async () => { callbackCount += 1 }
  }), error => error.code === 'INVALID_CHALLENGE')
  await assert.rejects(repository.consumeChallenge({
    tokenHash: 'token-digest',
    openid: 'wx-1',
    now: new Date('2026-08-06T00:10:00.000Z'),
    apply: async () => { callbackCount += 1 }
  }), error => error.code === 'INVALID_CHALLENGE')
  assert.equal(callbackCount, 0)
})

test('challenge invalidation is an O(1) credential epoch change that rejects every older unused challenge', async () => {
  const oldChallenges = Array.from({ length: 101 }, (_, index) => ({
    _id: `challenge-${index}`,
    userId: 'u-1',
    username: 'user01',
    openid: 'wx-1',
    tokenHash: `digest-${index}`,
    challengeEpoch: 0,
    expiresAt: new Date('2026-08-06T01:00:00.000Z'),
    consumedAt: null
  }))
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'user01', usernameNormalized: 'user01', role: 'user', status: 'active' }],
    user_credentials: [{ _id: 'u-1', userId: 'u-1', challengeEpoch: 0, credentialVersion: 0 }],
    auth_challenges: oldChallenges
  })

  await repository.runUserTransaction(transactionRepository =>
    transactionRepository.invalidateChallenges('u-1', new Date('2026-08-06T00:15:00.000Z')))

  assert.equal(fake.documents('user_credentials')[0].challengeEpoch, 1)
  assert.equal(fake.documents('user_credentials')[0].credentialVersion, 1)
  assert.equal(fake.documents('auth_challenges').filter(challenge => challenge.consumedAt).length, 0)
  assert.deepEqual(fake.transactionQueries, [])
  let callbackCount = 0
  await assert.rejects(repository.consumeChallenge({
    tokenHash: 'digest-100',
    openid: 'wx-1',
    now: new Date('2026-08-06T00:20:00.000Z'),
    apply: async () => { callbackCount += 1 }
  }), error => error.code === 'INVALID_CHALLENGE')
  assert.equal(callbackCount, 0)
})

test('recovery prelookup is revalidated by fixed user document and prevents TOCTOU substitution', async () => {
  const recoveryCodeHash = 'recovery-digest'
  const { fake, repository } = createRepository({
    users: [{ _id: 'recover-1', username: 'recover', usernameNormalized: 'recover', role: 'user', status: 'disabled' }],
    user_credentials: [{ _id: 'recover-1', userId: 'recover-1', challengeEpoch: 0 }],
    system_settings: [{
      _id: ADMIN_GUARD_ID,
      activeSuperAdminCount: 1,
      revision: 2,
      recoveryCodeHash,
      recoveryConsumedAt: null
    }]
  })
  let callbackCount = 0
  fake.beforeNextTransaction(() => {
    fake.replace('users', 'recover-1', {
      username: 'substitute',
      usernameNormalized: 'substitute',
      role: 'super_admin',
      status: 'active'
    })
  })

  await assert.rejects(repository.consumeRecoveryCode({
    recoveryCodeHash,
    username: 'recover',
    now: new Date('2026-08-06T00:00:00.000Z'),
    apply: async () => { callbackCount += 1 }
  }), error => error.code === 'ACCOUNT_STATE_INVALID')

  assert.equal(callbackCount, 0)
  assert.equal(fake.documents('system_settings')[0].recoveryConsumedAt, null)
  assert.deepEqual(fake.transactionQueries, [])
})

test('recovery callback runs once and atomically consumes recovery state with the shared admin guard', async () => {
  const recoveryCodeHash = 'recovery-digest'
  const previousOpenid = 'wx-recovery-old'
  const { fake, repository } = createRepository({
    users: [{ _id: 'recover-1', username: 'recover', usernameNormalized: 'recover', role: 'user', status: 'disabled', openid: previousOpenid }],
    user_credentials: [{ _id: 'recover-1', userId: 'recover-1', challengeEpoch: 0 }],
    wechat_bindings: [{ _id: bindingIdForOpenid(previousOpenid), userId: 'recover-1' }],
    system_settings: [{
      _id: ADMIN_GUARD_ID,
      activeSuperAdminCount: 1,
      revision: 2,
      recoveryCodeHash,
      recoveryConsumedAt: null
    }]
  })
  let callbackCount = 0
  await repository.consumeRecoveryCode({
    recoveryCodeHash,
    username: 'recover',
    now: new Date('2026-08-06T00:00:00.000Z'),
    apply: async transactionRepository => {
      callbackCount += 1
      const user = await transactionRepository.findUserByUsername('recover')
      await transactionRepository.updateUser(user._id, { role: 'super_admin', status: 'active', openid: '' })
      await transactionRepository.invalidateChallenges(user._id, new Date('2026-08-06T00:00:00.000Z'))
      return user._id
    }
  })

  assert.equal(callbackCount, 1)
  assert.equal(fake.documents('system_settings')[0].activeSuperAdminCount, 2)
  assert.equal(fake.documents('system_settings')[0].revision, 3)
  assert.equal(fake.documents('system_settings')[0].recoveryConsumedAt instanceof Date, true)
  assert.equal(fake.documents('user_credentials')[0].challengeEpoch, 1)
  assert.equal(fake.documents('wechat_bindings').length, 0)
  await assert.rejects(repository.consumeRecoveryCode({
    recoveryCodeHash,
    username: 'recover',
    apply: async () => { callbackCount += 1 }
  }), error => error.code === 'INVALID_RECOVERY_CODE')
  assert.equal(callbackCount, 1)
  assert.deepEqual(fake.transactionQueries, [])
})

test('initial super-admin creation uses a pre-generated random id and increments the same guard', async () => {
  const recoveryCodeHash = 'recovery-digest'
  const { fake, repository } = createRepository({
    system_settings: [{
      _id: ADMIN_GUARD_ID,
      activeSuperAdminCount: 0,
      revision: 0,
      recoveryCodeHash,
      recoveryConsumedAt: null
    }]
  }, ['initial-user', 'audit-initialize'])

  const user = await repository.consumeRecoveryCode({
    recoveryCodeHash,
    now: new Date('2026-08-06T00:00:00.000Z'),
    apply: async transactionRepository => {
      assert.equal(await transactionRepository.countActiveSuperAdmins(), 0)
      const created = await transactionRepository.createInitialSuperAdmin({
        username: 'rootadmin',
        displayName: 'Root Admin',
        openid: 'wx-root',
        credential: { hash: 'test-hash', mustChangePassword: true }
      })
      await transactionRepository.writeAudit({ action: 'INITIALIZE_SUPER_ADMIN' })
      return created
    }
  })

  assert.equal(user._id, 'initial-user')
  assert.equal(fake.documents('user_credentials')[0]._id, 'initial-user')
  assert.equal(fake.documents('system_settings')[0].activeSuperAdminCount, 1)
  assert.equal(fake.documents('system_settings')[0].revision, 1)
  assert.equal(fake.documents('system_settings')[0].recoveryConsumedAt instanceof Date, true)
  assert.equal(fake.documents('wechat_bindings')[0]._id, bindingIdForOpenid('wx-root'))
  assert.equal(fake.documents('wechat_bindings')[0].userId, 'initial-user')
  assert.deepEqual(fake.transactionQueries, [])
})

test('OpenID binding uses a deterministic reservation document and maps collisions to a stable code', async () => {
  const boundId = bindingIdForOpenid('wx-bound')
  const { fake, repository } = createRepository({
    users: [
      { _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active' },
      { _id: 'u-2', username: 'second', usernameNormalized: 'second', role: 'user', status: 'active', openid: 'wx-bound' }
    ],
    user_credentials: [
      { _id: 'u-1', userId: 'u-1', credentialVersion: 0, mustChangePassword: false },
      { _id: 'u-2', userId: 'u-2', credentialVersion: 0, mustChangePassword: false }
    ],
    wechat_bindings: [{ _id: boundId, userId: 'u-2' }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 1 }]
  })

  await assert.rejects(repository.bindOpenid('u-1', 'wx-bound', 0), error => error.code === 'OPENID_ALREADY_BOUND')
  assert.equal(Object.hasOwn(fake.documents('users').find(user => user._id === 'u-1'), 'openid'), false)
  const bound = await repository.bindOpenid('u-1', 'wx-new', 0)
  assert.equal(bound.user.openid, 'wx-new')
  assert.equal(bound.credential.credentialVersion, 1)
  assert.equal(fake.documents('users').find(user => user._id === 'u-1').openid, 'wx-new')
  assert.equal(fake.documents('wechat_bindings').find(binding => binding.userId === 'u-1')._id, bindingIdForOpenid('wx-new'))
})

test('binding fails closed when the credential changes after password verification', async () => {
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active' }],
    user_credentials: [{ _id: 'u-1', userId: 'u-1', credentialVersion: 0, mustChangePassword: false }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 1 }]
  })
  fake.beforeNextTransaction(() => {
    fake.replace('user_credentials', 'u-1', {
      userId: 'u-1',
      credentialVersion: 1,
      mustChangePassword: true
    })
  })

  await assert.rejects(repository.bindOpenid('u-1', 'wx-new', 0), error => error.code === 'CREDENTIAL_CHANGED')
  assert.equal(fake.documents('wechat_bindings').length, 0)
  assert.equal(Object.hasOwn(fake.documents('users')[0], 'openid'), false)
})

test('challenge creation rejects an administrator reset instead of adopting the newer credential version', async () => {
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active' }],
    user_credentials: [{ _id: 'u-1', userId: 'u-1', credentialVersion: 0, mustChangePassword: true }]
  }, ['challenge-stale'])
  fake.beforeNextTransaction(() => {
    fake.replace('user_credentials', 'u-1', {
      userId: 'u-1',
      credentialVersion: 1,
      mustChangePassword: true
    })
  })

  await assert.rejects(repository.createChallenge({
    userId: 'u-1',
    username: 'first',
    openid: 'wx-new',
    tokenHash: 'digest',
    expiresAt: new Date('2026-08-06T00:10:00.000Z'),
    expectedCredentialVersion: 0
  }), error => error.code === 'CREDENTIAL_CHANGED')
  assert.equal(fake.documents('auth_challenges').length, 0)
})

test('unbind removes the binding atomically so another account can reserve the same OpenID', async () => {
  const openid = 'wx-rebind'
  const bindingId = bindingIdForOpenid(openid)
  const { fake, repository } = createRepository({
    users: [
      { _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active', openid },
      { _id: 'u-2', username: 'second', usernameNormalized: 'second', role: 'user', status: 'active' }
    ],
    user_credentials: [
      { _id: 'u-1', userId: 'u-1', credentialVersion: 0, mustChangePassword: false },
      { _id: 'u-2', userId: 'u-2', credentialVersion: 0, mustChangePassword: false }
    ],
    wechat_bindings: [{ _id: bindingId, userId: 'u-1' }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 1 }]
  })

  await repository.runUserTransaction(transactionRepository => transactionRepository.updateUser('u-1', { openid: '' }))
  const rebound = await repository.bindOpenid('u-2', openid, 0)
  assert.equal(rebound.user._id, 'u-2')
  assert.equal(fake.documents('wechat_bindings').find(binding => binding._id === bindingId).userId, 'u-2')
  assert.equal(Object.hasOwn(fake.documents('users').find(user => user._id === 'u-1'), 'openid'), false)
})

test('unbind invalidation revokes a login credential version verified before the transaction', async () => {
  const openid = 'wx-revoked'
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active', openid }],
    user_credentials: [{ _id: 'u-1', userId: 'u-1', credentialVersion: 0, challengeEpoch: 0, mustChangePassword: false }],
    wechat_bindings: [{ _id: bindingIdForOpenid(openid), userId: 'u-1' }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 1 }]
  })

  await repository.runUserTransaction(async transactionRepository => {
    await transactionRepository.updateUser('u-1', { openid: '' })
    await transactionRepository.invalidateChallenges('u-1', new Date('2026-08-06T00:00:00.000Z'))
  })

  await assert.rejects(repository.bindOpenid('u-1', 'wx-attacker', 0), error => error.code === 'CREDENTIAL_CHANGED')
  assert.equal(fake.documents('wechat_bindings').length, 0)
  assert.equal(fake.documents('user_credentials')[0].credentialVersion, 1)
})

test('credential versions accept only an absent legacy value or a nonnegative safe integer', async () => {
  for (const corruptVersion of [null, false, '0', -1, Number.MAX_SAFE_INTEGER]) {
    const { fake, repository } = createRepository({
      user_credentials: [{ _id: 'u-1', userId: 'u-1', credentialVersion: corruptVersion }]
    })
    await assert.rejects(
      repository.updateCredential('u-1', { failedAttempts: 0 }),
      error => error.code === 'ACCOUNT_STATE_INVALID'
    )
    assert.equal(fake.documents('user_credentials')[0].credentialVersion, corruptVersion)
  }

  const { fake, repository } = createRepository({
    user_credentials: [{ _id: 'legacy', userId: 'legacy' }]
  })
  assert.equal((await repository.updateCredential('legacy', { failedAttempts: 0 })).credentialVersion, 1)
  assert.equal(fake.documents('user_credentials')[0].credentialVersion, 1)
})

test('binding and challenge creation reject coerced credential versions', async () => {
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active' }],
    user_credentials: [{ _id: 'u-1', userId: 'u-1', credentialVersion: 0, mustChangePassword: false }]
  }, ['challenge-invalid-version'])

  await assert.rejects(repository.bindOpenid('u-1', 'wx-new', '0'), error => error.code === 'ACCOUNT_STATE_INVALID')
  await assert.rejects(repository.createChallenge({
    userId: 'u-1',
    username: 'first',
    openid: 'wx-new',
    tokenHash: 'digest',
    expiresAt: new Date('2026-08-06T00:10:00.000Z'),
    expectedCredentialVersion: '0'
  }), error => error.code === 'ACCOUNT_STATE_INVALID')
  assert.equal(fake.documents('wechat_bindings').length, 0)
  assert.equal(fake.documents('auth_challenges').length, 0)
})

test('challenge epochs accept only absent legacy state or nonnegative safe integers during creation', async () => {
  for (const corruptEpoch of ['0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { fake, repository } = createRepository({
      user_credentials: [{ _id: 'u-1', userId: 'u-1', credentialVersion: 0, challengeEpoch: corruptEpoch }]
    }, ['challenge-corrupt-epoch'])
    await assert.rejects(repository.createChallenge({
      userId: 'u-1',
      username: 'first',
      openid: 'wx-new',
      tokenHash: 'digest',
      expiresAt: new Date('2026-08-06T00:10:00.000Z'),
      expectedCredentialVersion: 0
    }), error => error.code === 'ACCOUNT_STATE_INVALID')
    assert.equal(fake.documents('auth_challenges').length, 0)
    assert.equal(fake.documents('user_credentials')[0].challengeEpoch, corruptEpoch)
  }

  const { fake, repository } = createRepository({
    user_credentials: [{ _id: 'legacy', userId: 'legacy', credentialVersion: 0 }]
  }, ['challenge-legacy-epoch'])
  await repository.createChallenge({
    userId: 'legacy',
    username: 'legacy',
    openid: 'wx-legacy',
    tokenHash: 'legacy-digest',
    expiresAt: new Date('2026-08-06T00:10:00.000Z'),
    expectedCredentialVersion: 0
  })
  assert.equal(fake.documents('auth_challenges')[0].challengeEpoch, 0)
})

test('challenge invalidation rejects corrupt epochs and overflow without mutating credentials', async () => {
  for (const corruptEpoch of ['0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
    const { fake, repository } = createRepository({
      user_credentials: [{
        _id: 'u-1',
        userId: 'u-1',
        credentialVersion: 0,
        challengeEpoch: corruptEpoch,
        failedAttempts: 3
      }]
    })
    await assert.rejects(
      repository.runUserTransaction(transaction => transaction.invalidateChallenges('u-1', new Date('2026-08-06T00:00:00.000Z'))),
      error => error.code === 'ACCOUNT_STATE_INVALID'
    )
    assert.deepEqual(fake.documents('user_credentials')[0], {
      _id: 'u-1',
      userId: 'u-1',
      credentialVersion: 0,
      challengeEpoch: corruptEpoch,
      failedAttempts: 3
    })
  }
})

test('challenge epoch overflow rolls back an unbind transaction', async () => {
  const openid = 'wx-overflow'
  const bindingId = bindingIdForOpenid(openid)
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active', openid }],
    user_credentials: [{
      _id: 'u-1',
      userId: 'u-1',
      credentialVersion: 0,
      challengeEpoch: Number.MAX_SAFE_INTEGER,
      mustChangePassword: false
    }],
    wechat_bindings: [{ _id: bindingId, userId: 'u-1' }],
    system_settings: [{ _id: ADMIN_GUARD_ID, activeSuperAdminCount: 1, revision: 1 }]
  })

  await assert.rejects(repository.runUserTransaction(async transaction => {
    await transaction.updateUser('u-1', { openid: '' })
    await transaction.invalidateChallenges('u-1', new Date('2026-08-06T00:00:00.000Z'))
  }), error => error.code === 'ACCOUNT_STATE_INVALID')

  assert.equal(fake.documents('users')[0].openid, openid)
  assert.equal(fake.documents('wechat_bindings')[0]._id, bindingId)
  assert.equal(fake.documents('user_credentials')[0].challengeEpoch, Number.MAX_SAFE_INTEGER)
  assert.equal(fake.documents('user_credentials')[0].credentialVersion, 0)
})

test('challenge consumption validates both stored epochs exactly and rolls back before apply', async () => {
  for (const { challengeEpoch, credentialEpoch } of [
    { challengeEpoch: '0', credentialEpoch: 0 },
    { challengeEpoch: 0, credentialEpoch: -1 },
    { challengeEpoch: 0.5, credentialEpoch: 0 },
    { challengeEpoch: 0, credentialEpoch: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const { fake, repository } = createRepository({
      users: [{ _id: 'u-1', username: 'first', usernameNormalized: 'first', status: 'active' }],
      user_credentials: [{
        _id: 'u-1', userId: 'u-1', credentialVersion: 0, challengeEpoch: credentialEpoch
      }],
      auth_challenges: [{
        _id: 'challenge-1',
        userId: 'u-1',
        username: 'first',
        openid: 'wx-first',
        tokenHash: 'digest',
        expiresAt: new Date('2026-08-06T00:10:00.000Z'),
        consumedAt: null,
        credentialVersion: 0,
        challengeEpoch
      }]
    })
    let applied = false
    await assert.rejects(repository.consumeChallenge({
      tokenHash: 'digest',
      openid: 'wx-first',
      now: new Date('2026-08-06T00:00:00.000Z'),
      apply: async () => { applied = true }
    }), error => error.code === 'ACCOUNT_STATE_INVALID')
    assert.equal(applied, false)
    assert.equal(fake.documents('auth_challenges')[0].consumedAt, null)
    assert.equal(fake.documents('user_credentials')[0].challengeEpoch, credentialEpoch)
  }
})

test('OpenID lookup follows the deterministic binding to a fixed user document and revalidates it', async () => {
  const openid = 'wx-fixed'
  const bindingId = bindingIdForOpenid(openid)
  const { fake, repository } = createRepository({
    users: [{ _id: 'u-1', username: 'first', usernameNormalized: 'first', role: 'user', status: 'active', openid }],
    wechat_bindings: [{ _id: bindingId, userId: 'u-1' }]
  })
  assert.equal((await repository.findUserByOpenid(openid))._id, 'u-1')
  fake.replace('users', 'u-1', { username: 'first', usernameNormalized: 'first', role: 'user', status: 'active', openid: 'wx-other' })
  assert.equal(await repository.findUserByOpenid(openid), null)
})
