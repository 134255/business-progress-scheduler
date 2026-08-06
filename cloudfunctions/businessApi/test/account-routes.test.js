const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { createFakeCloudDatabase } = require('./helpers/fake-cloud-database')

const originalLoad = Module._load
const defaultFake = createFakeCloudDatabase({
  system_settings: [{ _id: 'account_admin_state', activeSuperAdminCount: 1, revision: 0 }]
})
Module._load = function loadWithCloudStub(request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database: () => defaultFake.db,
      getWXContext: () => ({ OPENID: 'wx-default', REQUESTID: 'default-request' })
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { createBusinessApi, isPublicAction, main } = require('../index')
Module._load = originalLoad

test('only session and credential-establishment actions are public', () => {
  assert.equal(isPublicAction('getSession'), true)
  assert.equal(isPublicAction('bootstrap'), true)
  assert.equal(isPublicAction('login'), true)
  assert.equal(isPublicAction('completeFirstLogin'), true)
  assert.equal(isPublicAction('initializeSuperAdmin'), true)
  assert.equal(isPublicAction('recoverSuperAdmin'), true)
  assert.equal(isPublicAction('dashboard'), false)
  assert.equal(isPublicAction('listUsers'), false)
})

test('deployed getSession wiring returns an unauthenticated session without auto-creating a user', async () => {
  const result = await main({ action: 'getSession', payload: {} })
  assert.equal(result.ok, true)
  assert.equal(result.data.authenticated, false)
  assert.equal(defaultFake.documents('users').length, 0)
})

function createRouteHarness({ user, credential, contextOpenid = 'wx-context' } = {}) {
  const calls = []
  const errors = []
  const repository = {
    async findUserByOpenid(openid) {
      calls.push(['findUserByOpenid', openid])
      return user === undefined
        ? { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active', openid: 'wx-bound' }
        : user
    },
    async findCredential(userId) {
      calls.push(['findCredential', userId])
      return credential === undefined
        ? { userId, mustChangePassword: false, lockedUntil: null }
        : credential
    }
  }
  const method = name => async input => {
    calls.push([name, input])
    return { route: name, input }
  }
  const authService = {
    getSession: method('getSession'),
    login: method('login'),
    completeFirstLogin: method('completeFirstLogin'),
    changePassword: method('changePassword'),
    initializeSuperAdmin: method('initializeSuperAdmin'),
    recoverSuperAdmin: method('recoverSuperAdmin')
  }
  const api = createBusinessApi({
    repository,
    authService,
    adminUserService: {
      listUsers: method('listUsers'),
      createUser: method('createUser'),
      updateUser: method('updateUser'),
      resetUserPassword: method('resetUserPassword'),
      unlockUser: method('unlockUser'),
      unbindWechat: method('unbindWechat')
    },
    legacyRoutes: {
      dashboard: (openid, payload) => method('dashboard')({ openid, payload })
    },
    getContext: () => ({ OPENID: contextOpenid, REQUESTID: 'request-1' }),
    clock: () => Date.parse('2026-08-06T00:00:00.000Z'),
    logger: { error: (...args) => errors.push(args) }
  })
  return { api, authService, calls, errors }
}

test('public account routes use trusted context and bootstrap remains only a getSession alias', async () => {
  const harness = createRouteHarness({ user: null, credential: null })
  const bootstrap = await harness.api.main({ action: 'bootstrap', payload: { openid: 'forged' } })
  const login = await harness.api.main({ action: 'login', payload: { openid: 'forged', username: 'user01', password: 'secret' } })
  const recovery = await harness.api.main({ action: 'recoverSuperAdmin', payload: { username: 'root' } })

  assert.equal(bootstrap.ok, true)
  assert.equal(bootstrap.data.route, 'getSession')
  assert.equal(bootstrap.data.input.openid, 'wx-context')
  assert.equal(login.data.input.openid, 'wx-context')
  assert.equal(recovery.data.input.openid, undefined)
  assert.equal(harness.calls.some(call => call[0] === 'findUserByOpenid'), false)
})

test('protected account and legacy routes receive the resolved actor and its bound OpenID', async () => {
  const harness = createRouteHarness()
  const listed = await harness.api.main({ action: 'listUsers', payload: { page: 2, pageSize: 10 } })
  const dashboard = await harness.api.main({ action: 'dashboard', payload: { ignored: true } })

  assert.equal(listed.ok, true)
  assert.equal(listed.data.input.actor._id, 'actor-1')
  assert.deepEqual(listed.data.input.query, { page: 2, pageSize: 10 })
  assert.equal(dashboard.data.input.openid, 'wx-bound')
  assert.deepEqual(dashboard.data.input.payload, { ignored: true })
})

test('changePassword ignores a forged payload actor and uses the trusted resolved account', async () => {
  const harness = createRouteHarness()
  const result = await harness.api.main({
    action: 'changePassword',
    payload: {
      actor: { _id: 'forged-user', username: 'victim' },
      currentPassword: 'KnownPass8',
      newPassword: 'ChangedPass9'
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.input.actor._id, 'actor-1')
  assert.equal(result.data.input.currentPassword, 'KnownPass8')
})

test('protected routes fail closed for missing, disabled, locked, and password-change-required account state', async t => {
  const cases = [
    { name: 'missing user', user: null, credential: null, code: 'UNAUTHORIZED' },
    { name: 'missing credential', user: { _id: 'u-1', status: 'active' }, credential: null, code: 'ACCOUNT_STATE_INVALID' },
    { name: 'disabled user', user: { _id: 'u-1', status: 'disabled' }, credential: { lockedUntil: null }, code: 'ACCOUNT_DISABLED' },
    { name: 'locked user', user: { _id: 'u-1', status: 'active' }, credential: { lockedUntil: Date.parse('2026-08-06T00:30:00.000Z') }, code: 'ACCOUNT_LOCKED' },
    { name: 'temporary credential', user: { _id: 'u-1', status: 'active' }, credential: { mustChangePassword: true }, code: 'PASSWORD_CHANGE_REQUIRED' }
  ]
  for (const item of cases) {
    await t.test(item.name, async () => {
      const harness = createRouteHarness(item)
      const result = await harness.api.main({ action: 'dashboard', payload: {} })
      assert.equal(result.ok, false)
      assert.equal(result.code, item.code)
    })
  }
})

test('route error logging excludes payloads, passwords, identity values, and error messages', async () => {
  const harness = createRouteHarness()
  harness.authService.login = async () => {
    const error = new Error('secret-password wx-sensitive')
    error.code = 'INVALID_CREDENTIALS'
    throw error
  }
  const result = await harness.api.main({
    action: 'login',
    payload: { username: 'secret-user', password: 'secret-password', openid: 'wx-forged', userId: 'target-must-not-log' }
  })

  assert.equal(result.code, 'INVALID_CREDENTIALS')
  assert.equal(harness.errors.length, 1)
  const logged = JSON.stringify(harness.errors)
  assert.doesNotMatch(logged, /secret-password|secret-user|wx-sensitive|wx-forged|target-must-not-log/)
  assert.match(logged, /INVALID_CREDENTIALS/)
  assert.match(logged, /request-1/)
})

test('route error logging preserves known application codes and maps all other codes to INTERNAL_ERROR', async () => {
  for (const { code, loggedCode } of [
    { code: 'INVALID_CREDENTIALS', loggedCode: 'INVALID_CREDENTIALS' },
    { code: 'SECRET_API_TOKEN', loggedCode: 'INTERNAL_ERROR' },
    { code: 'SDK_RUNTIME_ERROR', loggedCode: 'INTERNAL_ERROR' },
    { code: 'INVALID\nsecret-code', loggedCode: 'INTERNAL_ERROR' }
  ]) {
    const harness = createRouteHarness()
    harness.authService.login = async () => {
      const error = new Error('secret-error-message')
      error.code = code
      throw error
    }

    const result = await harness.api.main({ action: 'login', payload: {} })
    assert.equal(result.ok, false)
    const logged = JSON.stringify(harness.errors)
    assert.match(logged, new RegExp(loggedCode))
    if (loggedCode === 'INTERNAL_ERROR') assert.equal(logged.includes(code), false)
    assert.doesNotMatch(logged, /secret-error-message|secret-code/)
  }
})

test('prototype property names are rejected as unknown actions', async () => {
  for (const action of ['toString', 'constructor', '__proto__']) {
    const harness = createRouteHarness()
    const result = await harness.api.main({ action, payload: {} })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNKNOWN_ACTION')
  }
})

test('unknown actions are sanitized in logs and never contribute a payload target id', async () => {
  const harness = createRouteHarness()
  const result = await harness.api.main({
    action: 'secret-action-name',
    payload: { userId: 'target-must-not-log' }
  })
  assert.equal(result.code, 'UNKNOWN_ACTION')
  const logged = JSON.stringify(harness.errors)
  assert.doesNotMatch(logged, /secret-action-name|target-must-not-log/)
  assert.match(logged, /UNKNOWN_ACTION/)
})

test('only validated admin target actions may add a safe target id to logs', async () => {
  for (const { targetId, expected } of [
    { targetId: 'user_123-safe', expected: true },
    { targetId: '../sensitive', expected: false },
    { targetId: 'x'.repeat(65), expected: false },
    { targetId: 42, expected: false }
  ]) {
    const harness = createRouteHarness({ user: null, credential: null })
    await harness.api.main({ action: 'updateUser', payload: { userId: targetId, changes: { status: 'disabled' } } })
    const logged = JSON.stringify(harness.errors)
    assert.equal(logged.includes(String(targetId)), expected)
  }
})
