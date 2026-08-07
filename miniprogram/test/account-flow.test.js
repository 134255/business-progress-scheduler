const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const miniProgramRoot = path.resolve(__dirname, '..')

function freshRequire(relativePath) {
  const modulePath = path.join(miniProgramRoot, relativePath)
  delete require.cache[require.resolve(modulePath)]
  return require(modulePath)
}

function loadPage(relativePath, accountFake) {
  const accountPath = path.join(miniProgramRoot, 'services/account.js')
  const pagePath = path.join(miniProgramRoot, relativePath)
  const originalAccount = require.cache[require.resolve(accountPath)]
  let definition = null
  global.Page = value => { definition = value }
  require.cache[require.resolve(accountPath)] = {
    id: accountPath,
    filename: accountPath,
    loaded: true,
    exports: accountFake
  }

  try {
    delete require.cache[pagePath]
    require(pagePath)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  } finally {
    if (originalAccount) require.cache[require.resolve(accountPath)] = originalAccount
    else delete require.cache[require.resolve(accountPath)]
    delete global.Page
  }

  if (!definition) return null
  const instance = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      Object.assign(this.data, update)
    }
  }
  return instance
}

function loadDashboard(businessFake) {
  const businessPath = path.join(miniProgramRoot, 'services/business.js')
  const pagePath = path.join(miniProgramRoot, 'pages/dashboard/index.js')
  const originalBusiness = require.cache[require.resolve(businessPath)]
  let definition = null
  global.Page = value => { definition = value }
  require.cache[require.resolve(businessPath)] = {
    id: businessPath,
    filename: businessPath,
    loaded: true,
    exports: businessFake
  }
  try {
    delete require.cache[pagePath]
    require(pagePath)
  } finally {
    if (originalBusiness) require.cache[require.resolve(businessPath)] = originalBusiness
    else delete require.cache[require.resolve(businessPath)]
    delete global.Page
  }
  const instance = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      Object.assign(this.data, update)
    }
  }
  return instance
}

test('manual-login preference persists only a boolean and survives a module restart', () => {
  const stored = new Map()
  const writes = []
  global.wx = {
    setStorageSync(key, value) {
      writes.push([key, value])
      stored.set(key, value)
    },
    getStorageSync: key => stored.get(key),
    removeStorageSync: key => stored.delete(key)
  }

  let preference = freshRequire('utils/manual-login.js')
  preference.requireManualLogin()
  assert.equal(preference.isManualLoginRequired(), true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][1], true)

  preference = freshRequire('utils/manual-login.js')
  assert.equal(preference.isManualLoginRequired(), true)
  preference.clearManualLoginRequirement()
  assert.equal(preference.isManualLoginRequired(), false)
  assert.equal(stored.size, 0)
})

test('manual-login preference keeps the current process safe when storage operations fail', () => {
  global.wx = {
    setStorageSync() { throw new Error('write unavailable') },
    getStorageSync() { throw new Error('read unavailable') },
    removeStorageSync() { throw new Error('remove unavailable') }
  }

  const preference = freshRequire('utils/manual-login.js')
  preference.requireManualLogin()
  assert.equal(preference.isManualLoginRequired(), true)

  preference.clearManualLoginRequirement()
  assert.equal(preference.isManualLoginRequired(), false)
})

test('callBusinessApi preserves backend error codes and silent calls do not toast', async () => {
  const toasts = []
  global.wx = {
    cloud: {
      callFunction: async () => ({
        result: { ok: false, code: 'ACCOUNT_LOCKED', message: '账户已锁定' }
      })
    },
    showToast: options => toasts.push(options)
  }
  const { callBusinessApi } = freshRequire('utils/cloud.js')

  await assert.rejects(
    callBusinessApi('login', { username: 'operator' }, { silent: true }),
    error => error.code === 'ACCOUNT_LOCKED' && error.message === '账户已锁定'
  )
  assert.deepEqual(toasts, [])
})

test('account service sends the five account actions through silent cloud calls', async () => {
  const calls = []
  const cloudPath = path.join(miniProgramRoot, 'utils/cloud.js')
  const accountPath = path.join(miniProgramRoot, 'services/account.js')
  const originalCloud = require.cache[require.resolve(cloudPath)]
  require.cache[require.resolve(cloudPath)] = {
    id: cloudPath,
    filename: cloudPath,
    loaded: true,
    exports: {
      callBusinessApi: async (...args) => {
        calls.push(args)
        return { action: args[0] }
      }
    }
  }

  let account = null
  try {
    delete require.cache[accountPath]
    account = require(accountPath)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  } finally {
    if (originalCloud) require.cache[require.resolve(cloudPath)] = originalCloud
    else delete require.cache[require.resolve(cloudPath)]
  }

  assert.ok(account, 'account service should exist')
  await account.getSession()
  await account.login('operator', 'secret-value')
  await account.completeFirstLogin('challenge-value', 'replacement-value')
  await account.changePassword('current-value', 'replacement-value')
  await account.initializeSuperAdmin(
    'first-admin',
    '首位管理员',
    'temporary-pass-8',
    'paper-recovery-code'
  )

  assert.deepEqual(calls, [
    ['getSession', {}, { silent: true }],
    ['login', { username: 'operator', password: 'secret-value' }, { silent: true }],
    ['completeFirstLogin', { challengeToken: 'challenge-value', newPassword: 'replacement-value' }, { silent: true }],
    ['changePassword', { currentPassword: 'current-value', newPassword: 'replacement-value' }, { silent: true }],
    [
      'initializeSuperAdmin',
      {
        username: 'first-admin',
        displayName: '首位管理员',
        temporaryPassword: 'temporary-pass-8',
        recoveryCode: 'paper-recovery-code'
      },
      { silent: true }
    ]
  ])
})

test('login restores an authenticated session into app state and opens the dashboard', async () => {
  const user = { _id: 'user-1', displayName: '测试用户', role: 'member' }
  const app = { globalData: { currentUser: null, loginChallenge: null } }
  const launches = []
  global.getApp = () => app
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/login/index.js', {
    getSession: async () => ({ authenticated: true, user }),
    login: async () => { throw new Error('not used') }
  })

  assert.ok(page, 'login page should exist')
  await page.onLoad()

  assert.equal(app.globalData.currentUser, user)
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])
  assert.equal(page.data.checking, false)
})

test('login keeps the password form after explicit logout even when the binding is authenticated', async () => {
  const user = { _id: 'user-1', displayName: 'bound user', role: 'user' }
  const app = {
    globalData: { currentUser: null, loginChallenge: null },
    isManualLoginRequired: () => true
  }
  const launches = []
  global.getApp = () => app
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/login/index.js', {
    getSession: async () => ({ authenticated: true, requiresInitialization: false, user })
  })

  await page.onLoad()

  assert.equal(app.globalData.currentUser, null)
  assert.deepEqual(launches, [])
  assert.equal(page.data.checking, false)
  assert.equal(page.data.requiresInitialization, false)
})

test('login reports initialization state without exposing a credential form as ready', async () => {
  const app = {
    globalData: { currentUser: null, loginChallenge: null },
    isManualLoginRequired: () => true
  }
  global.getApp = () => app
  global.wx = { reLaunch: () => assert.fail('must not launch') }
  const page = loadPage('pages/login/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true })
  })

  assert.ok(page, 'login page should exist')
  await page.onLoad()

  assert.equal(page.data.checking, false)
  assert.equal(page.data.requiresInitialization, true)
  assert.equal(page.data.errorMessage, '系统尚未初始化，请创建首位超级管理员')
})

test('login opens the guarded initialization page only when initialization is required', () => {
  const navigations = []
  global.wx = { navigateTo: options => navigations.push(options) }
  const page = loadPage('pages/login/index.js', {})

  page.openInitialization()
  assert.deepEqual(navigations, [])

  page.setData({ requiresInitialization: true })
  page.openInitialization()
  assert.deepEqual(navigations, [{ url: '/pages/admin-initialize/index' }])
})

test('administrator initialization page rechecks an available initialization state', async () => {
  const launches = []
  global.getApp = () => ({ globalData: { loginChallenge: null, currentUser: null } })
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true })
  })

  assert.ok(page)
  await page.onLoad()

  assert.equal(page.data.checking, false)
  assert.equal(page.data.available, true)
  assert.deepEqual(launches, [])
})

test('administrator initialization page returns to login when initialization is no longer required', async () => {
  const launches = []
  global.getApp = () => ({ globalData: { loginChallenge: null, currentUser: null } })
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: false })
  })

  assert.ok(page)
  await page.onLoad()

  assert.equal(page.data.available, false)
  assert.deepEqual(launches, [{ url: '/pages/login/index' }])
})

test('administrator initialization page restores an authenticated session', async () => {
  const launches = []
  const user = { _id: 'admin-1', role: 'super_admin' }
  const app = { globalData: { loginChallenge: null, currentUser: null } }
  global.getApp = () => app
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: true, user })
  })

  assert.ok(page)
  await page.onLoad()

  assert.equal(app.globalData.currentUser, user)
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])
})

test('administrator initialization rejects incomplete and invalid temporary credentials before calling services', async () => {
  let initializationCalls = 0
  let loginCalls = 0
  global.getApp = () => ({ globalData: { loginChallenge: null, currentUser: null } })
  global.wx = { reLaunch: () => assert.fail('must not relaunch') }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true }),
    initializeSuperAdmin: async () => { initializationCalls += 1 },
    login: async () => { loginCalls += 1 }
  })
  await page.onLoad()

  await page.submit()
  assert.match(page.data.errorMessage, /完整填写/)

  page.setData({
    username: 'first-admin',
    displayName: '首位管理员',
    temporaryPassword: 'onlyletters',
    confirmPassword: 'onlyletters',
    recoveryCode: 'paper-recovery-code'
  })
  await page.submit()
  assert.match(page.data.errorMessage, /8-64/)
  assert.equal(initializationCalls, 0)
  assert.equal(loginCalls, 0)
})

test('administrator initialization rejects mismatched temporary passwords before calling services', async () => {
  let initializationCalls = 0
  global.getApp = () => ({ globalData: { loginChallenge: null, currentUser: null } })
  global.wx = { reLaunch: () => assert.fail('must not relaunch') }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true }),
    initializeSuperAdmin: async () => { initializationCalls += 1 }
  })
  await page.onLoad()
  page.setData({
    username: 'first-admin',
    displayName: '首位管理员',
    temporaryPassword: 'temporary-pass-8',
    confirmPassword: 'different-pass-9',
    recoveryCode: 'paper-recovery-code'
  })

  await page.submit()

  assert.match(page.data.errorMessage, /不一致/)
  assert.equal(initializationCalls, 0)
})

test('administrator initialization consumes the form once and enters forced password change', async () => {
  const calls = []
  const navigations = []
  const app = { globalData: { currentUser: null, loginChallenge: null } }
  global.getApp = () => app
  global.wx = {
    navigateTo: options => navigations.push(options),
    reLaunch: () => assert.fail('must not relaunch on success'),
    setStorage: () => assert.fail('must not persist initialization material'),
    setStorageSync: () => assert.fail('must not persist initialization material')
  }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true }),
    initializeSuperAdmin: async (...args) => {
      calls.push(['initialize', ...args])
      return { user: { username: 'first-admin', mustChangePassword: true } }
    },
    login: async (...args) => {
      calls.push(['login', ...args])
      return { passwordChangeRequired: true, challengeToken: 'memory-only-challenge' }
    }
  })
  await page.onLoad()
  page.setData({
    username: ' First-Admin ',
    displayName: ' 首位管理员 ',
    temporaryPassword: 'temporary-pass-8',
    confirmPassword: 'temporary-pass-8',
    recoveryCode: 'paper-recovery-code'
  })

  await page.submit()

  assert.deepEqual(calls, [
    ['initialize', 'First-Admin', '首位管理员', 'temporary-pass-8', 'paper-recovery-code'],
    ['login', 'First-Admin', 'temporary-pass-8']
  ])
  assert.equal(app.globalData.loginChallenge, 'memory-only-challenge')
  assert.equal(page.data.temporaryPassword, '')
  assert.equal(page.data.confirmPassword, '')
  assert.equal(page.data.recoveryCode, '')
  assert.deepEqual(navigations, [{ url: '/pages/change-password/index?mode=first' }])
})

test('administrator initialization clears secrets and reports an initialization failure', async () => {
  let loginCalls = 0
  const failure = new Error('恢复码无效')
  failure.code = 'INVALID_RECOVERY_CODE'
  global.getApp = () => ({ globalData: { currentUser: null, loginChallenge: null } })
  global.wx = { reLaunch: () => assert.fail('must not relaunch for retryable failure') }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true }),
    initializeSuperAdmin: async () => { throw failure },
    login: async () => { loginCalls += 1 }
  })
  await page.onLoad()
  page.setData({
    username: 'first-admin',
    displayName: '首位管理员',
    temporaryPassword: 'temporary-pass-8',
    confirmPassword: 'temporary-pass-8',
    recoveryCode: 'paper-recovery-code'
  })

  await page.submit()

  assert.equal(loginCalls, 0)
  assert.equal(page.data.username, 'first-admin')
  assert.equal(page.data.displayName, '首位管理员')
  assert.equal(page.data.temporaryPassword, '')
  assert.equal(page.data.confirmPassword, '')
  assert.equal(page.data.recoveryCode, '')
  assert.equal(page.data.errorMessage, '恢复码无效')
})

test('administrator initialization never retries initialization after automatic login fails', async () => {
  let initializationCalls = 0
  const launches = []
  const modals = []
  global.getApp = () => ({ globalData: { currentUser: null, loginChallenge: null } })
  global.wx = {
    showModal: async options => { modals.push(options) },
    reLaunch: options => launches.push(options)
  }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true }),
    initializeSuperAdmin: async () => { initializationCalls += 1 },
    login: async () => { throw new Error('temporary login failed') }
  })
  await page.onLoad()
  page.setData({
    username: 'first-admin',
    displayName: '首位管理员',
    temporaryPassword: 'temporary-pass-8',
    confirmPassword: 'temporary-pass-8',
    recoveryCode: 'paper-recovery-code'
  })

  await page.submit()

  assert.equal(initializationCalls, 1)
  assert.equal(page.data.temporaryPassword, '')
  assert.equal(page.data.confirmPassword, '')
  assert.equal(page.data.recoveryCode, '')
  assert.deepEqual(modals, [{
    title: '初始化已完成',
    content: '管理员已创建，请返回登录页使用临时密码登录',
    showCancel: false
  }])
  assert.deepEqual(launches, [{ url: '/pages/login/index' }])
})

test('administrator initialization returns to login when another initializer already completed', async () => {
  let loginCalls = 0
  const launches = []
  const failure = new Error('already initialized')
  failure.code = 'ALREADY_INITIALIZED'
  global.getApp = () => ({ globalData: { currentUser: null, loginChallenge: null } })
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/admin-initialize/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: true }),
    initializeSuperAdmin: async () => { throw failure },
    login: async () => { loginCalls += 1 }
  })
  await page.onLoad()
  page.setData({
    username: 'first-admin',
    displayName: '首位管理员',
    temporaryPassword: 'temporary-pass-8',
    confirmPassword: 'temporary-pass-8',
    recoveryCode: 'paper-recovery-code'
  })

  await page.submit()

  assert.equal(loginCalls, 0)
  assert.equal(page.data.username, '')
  assert.equal(page.data.displayName, '')
  assert.equal(page.data.temporaryPassword, '')
  assert.equal(page.data.confirmPassword, '')
  assert.equal(page.data.recoveryCode, '')
  assert.deepEqual(launches, [{ url: '/pages/login/index' }])
})

test('administrator initialization clears every form field when unloaded', () => {
  global.getApp = () => ({ globalData: { currentUser: null, loginChallenge: null } })
  global.wx = {}
  const page = loadPage('pages/admin-initialize/index.js', {})
  page.setData({
    username: 'first-admin',
    displayName: '首位管理员',
    temporaryPassword: 'temporary-pass-8',
    confirmPassword: 'temporary-pass-8',
    recoveryCode: 'paper-recovery-code'
  })

  page.onUnload()

  assert.equal(page.data.username, '')
  assert.equal(page.data.displayName, '')
  assert.equal(page.data.temporaryPassword, '')
  assert.equal(page.data.confirmPassword, '')
  assert.equal(page.data.recoveryCode, '')
})

test('administrator initialization input handlers update only their intended fields', () => {
  global.getApp = () => ({ globalData: { currentUser: null, loginChallenge: null } })
  global.wx = {}
  const page = loadPage('pages/admin-initialize/index.js', {})

  page.onUsernameInput({ detail: { value: 'first-admin' } })
  page.onDisplayNameInput({ detail: { value: '首位管理员' } })
  page.onTemporaryPasswordInput({ detail: { value: 'temporary-pass-8' } })
  page.onConfirmPasswordInput({ detail: { value: 'temporary-pass-8' } })
  page.onRecoveryCodeInput({ detail: { value: 'paper-recovery-code' } })

  assert.equal(page.data.username, 'first-admin')
  assert.equal(page.data.displayName, '首位管理员')
  assert.equal(page.data.temporaryPassword, 'temporary-pass-8')
  assert.equal(page.data.confirmPassword, 'temporary-pass-8')
  assert.equal(page.data.recoveryCode, 'paper-recovery-code')
})

test('administrator initialization page keeps sensitive material out of persistence logs and datasets', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, 'app.json'), 'utf8'))
  const source = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-initialize/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-initialize/index.wxml'), 'utf8')

  assert.equal(appConfig.pages.includes('pages/admin-initialize/index'), true)
  assert.doesNotMatch(source, /setStorage|setStorageSync|console\.(?:log|info|debug|warn|error)/)
  assert.doesNotMatch(wxml, /data-(?:password|recovery|challenge)/)
  assert.equal((wxml.match(/password="true"/g) || []).length, 3)
})

test('login keeps only the first-login challenge in app memory and clears the password field', async () => {
  const app = { globalData: { currentUser: null, loginChallenge: null } }
  const navigations = []
  let receivedUsername
  let receivedPassword
  global.getApp = () => app
  global.wx = {
    navigateTo: options => navigations.push(options),
    setStorage: () => assert.fail('credentials and challenges must not be persisted')
  }
  const page = loadPage('pages/login/index.js', {
    getSession: async () => ({ authenticated: false }),
    login: async (username, password) => {
      receivedUsername = username
      receivedPassword = password
      return { authenticated: false, passwordChangeRequired: true, challengeToken: 'temporary-challenge' }
    }
  })
  assert.ok(page, 'login page should exist')
  page.setData({ username: 'operator', password: 'temporary-password' })

  await page.submit()

  assert.equal(receivedUsername, 'operator')
  assert.equal(receivedPassword, 'temporary-password')
  assert.equal(app.globalData.loginChallenge, 'temporary-challenge')
  assert.equal(app.globalData.currentUser, null)
  assert.equal(page.data.password, '')
  assert.deepEqual(navigations, [{ url: '/pages/change-password/index?mode=first' }])
})

test('login stores a successfully authenticated public user and clears any stale challenge', async () => {
  const user = { _id: 'user-1', displayName: '测试用户', role: 'member' }
  let clearCalls = 0
  const app = {
    globalData: { currentUser: null, loginChallenge: 'stale-challenge' },
    clearManualLoginRequirement() { clearCalls += 1 }
  }
  const launches = []
  global.getApp = () => app
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/login/index.js', {
    getSession: async () => ({ authenticated: false }),
    login: async () => ({ authenticated: true, user })
  })
  page.setData({ username: 'operator', password: 'permanent-password' })

  await page.submit()

  assert.equal(app.globalData.currentUser, user)
  assert.equal(app.globalData.loginChallenge, null)
  assert.equal(clearCalls, 1)
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])
})

test('login owns backend errors and clears credentials when unloaded', async () => {
  const backendError = new Error('凭据无效')
  backendError.code = 'INVALID_CREDENTIALS'
  const app = { globalData: { currentUser: null, loginChallenge: null } }
  global.getApp = () => app
  global.wx = { reLaunch: () => assert.fail('must not launch') }
  const page = loadPage('pages/login/index.js', {
    getSession: async () => ({ authenticated: false }),
    login: async () => { throw backendError }
  })
  assert.ok(page, 'login page should exist')
  page.setData({ username: 'operator', password: 'temporary-password' })

  await page.submit()
  assert.equal(page.data.errorMessage, '凭据无效')
  assert.equal(page.data.submitting, false)

  page.onUnload()
  assert.equal(page.data.username, '')
  assert.equal(page.data.password, '')
})

test('first-login password change refuses to open without an in-memory challenge', () => {
  const launches = []
  const app = { globalData: { currentUser: null, loginChallenge: null } }
  global.getApp = () => app
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/change-password/index.js', {
    completeFirstLogin: async () => assert.fail('must not call without a challenge')
  })

  assert.ok(page, 'change-password page should exist')
  page.onLoad({ mode: 'first' })

  assert.equal(page.data.firstLogin, true)
  assert.deepEqual(launches, [{ url: '/pages/login/index' }])
})

test('first-login password change validates confirmation before calling the backend', async () => {
  const app = { globalData: { currentUser: null, loginChallenge: 'temporary-challenge' } }
  global.getApp = () => app
  global.wx = { reLaunch: () => assert.fail('must not launch') }
  const page = loadPage('pages/change-password/index.js', {
    completeFirstLogin: async () => assert.fail('must not call for mismatched confirmation')
  })
  assert.ok(page, 'change-password page should exist')
  page.onLoad({ mode: 'first' })
  page.setData({ newPassword: 'replacement-one', confirmPassword: 'replacement-two' })

  await page.submit()

  assert.equal(page.data.errorMessage, '两次输入的新密码不一致')
  assert.equal(page.data.submitting, false)
})

test('first-login password change consumes the memory challenge and opens the dashboard', async () => {
  const user = { _id: 'user-1', displayName: '测试用户', role: 'member' }
  const launches = []
  const calls = []
  let clearCalls = 0
  const app = {
    globalData: { currentUser: null, loginChallenge: 'temporary-challenge' },
    resetAuthState() {
      this.globalData.currentUser = null
      this.globalData.loginChallenge = null
    },
    clearManualLoginRequirement() { clearCalls += 1 }
  }
  global.getApp = () => app
  global.wx = {
    reLaunch: options => launches.push(options),
    setStorage: () => assert.fail('passwords and challenges must not be persisted')
  }
  const page = loadPage('pages/change-password/index.js', {
    completeFirstLogin: async (...args) => {
      calls.push(args)
      return { authenticated: true, user }
    }
  })
  assert.ok(page, 'change-password page should exist')
  page.onLoad({ mode: 'first' })
  page.setData({ newPassword: 'replacement-value', confirmPassword: 'replacement-value' })

  await page.submit()

  assert.deepEqual(calls, [['temporary-challenge', 'replacement-value']])
  assert.equal(app.globalData.loginChallenge, null)
  assert.equal(app.globalData.currentUser, user)
  assert.equal(clearCalls, 1)
  assert.equal(page.data.newPassword, '')
  assert.equal(page.data.confirmPassword, '')
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])
})

test('normal password change sends the current password and clears all fields on unload', async () => {
  const user = { _id: 'user-1', displayName: '测试用户', role: 'member' }
  const calls = []
  const launches = []
  const app = { globalData: { currentUser: user, loginChallenge: null } }
  global.getApp = () => app
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/change-password/index.js', {
    changePassword: async (...args) => {
      calls.push(args)
      return { user }
    }
  })
  assert.ok(page, 'change-password page should exist')
  page.onLoad({})
  page.setData({
    currentPassword: 'current-value',
    newPassword: 'replacement-value',
    confirmPassword: 'replacement-value'
  })

  await page.submit()

  assert.deepEqual(calls, [['current-value', 'replacement-value']])
  assert.equal(app.globalData.currentUser, user)
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])

  page.onUnload()
  assert.equal(page.data.currentPassword, '')
  assert.equal(page.data.newPassword, '')
  assert.equal(page.data.confirmPassword, '')
})

test('app owns resettable in-memory authentication state and preserves the CloudBase environment', () => {
  let definition
  const cloudInitializations = []
  const stored = new Map()
  const storageWrites = []
  global.App = value => { definition = value }
  global.wx = {
    cloud: {
      init: options => cloudInitializations.push(options)
    },
    setStorageSync(key, value) {
      storageWrites.push([key, value])
      stored.set(key, value)
    },
    getStorageSync: key => stored.get(key),
    removeStorageSync: key => stored.delete(key)
  }
  freshRequire('app.js')
  delete global.App

  assert.equal(definition.globalData.loginChallenge, null)
  assert.equal(typeof definition.resetAuthState, 'function')
  definition.globalData.currentUser = { _id: 'user-1' }
  definition.globalData.loginChallenge = 'temporary-challenge'
  definition.resetAuthState()
  assert.equal(definition.globalData.currentUser, null)
  assert.equal(definition.globalData.loginChallenge, null)

  assert.equal(typeof definition.requireManualLogin, 'function')
  assert.equal(typeof definition.isManualLoginRequired, 'function')
  assert.equal(typeof definition.clearManualLoginRequirement, 'function')
  definition.requireManualLogin()
  assert.equal(definition.isManualLoginRequired(), true)
  assert.deepEqual(storageWrites.map(([, value]) => value), [true])
  definition.clearManualLoginRequirement()
  assert.equal(definition.isManualLoginRequired(), false)
  assert.equal(stored.size, 0)

  definition.onLaunch()
  assert.deepEqual(cloudInitializations, [{ env: 'cloud1-d5gxt99rh492670d9', traceUser: true }])
  assert.equal(definition.globalData.cloudReady, true)
})

test('dashboard redirects before loading business data when no current user exists', () => {
  const launches = []
  let dashboardCalls = 0
  let bootstrapCalls = 0
  global.getApp = () => ({ globalData: { currentUser: null } })
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadDashboard({
    bootstrap: async () => { bootstrapCalls += 1 },
    dashboard: async () => { dashboardCalls += 1 }
  })

  page.onShow()

  assert.deepEqual(launches, [{ url: '/pages/login/index' }])
  assert.equal(bootstrapCalls, 0)
  assert.equal(dashboardCalls, 0)
})

test('dashboard uses the authenticated app user and no longer bootstraps a profile', async () => {
  const user = { _id: 'user-1', displayName: '测试用户', role: 'member' }
  let bootstrapCalls = 0
  let dashboardCalls = 0
  global.getApp = () => ({ globalData: { currentUser: user } })
  global.wx = { reLaunch: () => assert.fail('must not redirect') }
  const page = loadDashboard({
    bootstrap: async () => {
      bootstrapCalls += 1
      return { _id: 'legacy-profile' }
    },
    dashboard: async () => {
      dashboardCalls += 1
      return { stats: { active: 2, pendingMine: 1, completed: 3 }, recent: [] }
    }
  })

  await page.onShow()

  assert.equal(bootstrapCalls, 0)
  assert.equal(dashboardCalls, 1)
  assert.equal(page.data.profile, user)
  assert.deepEqual(page.data.stats, { active: 2, pendingMine: 1, completed: 3 })
  assert.equal(page.data.loading, false)
})
