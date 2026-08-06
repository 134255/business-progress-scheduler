const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const miniProgramRoot = path.resolve(__dirname, '..')

function withFakeModule(relativePath, exports, callback) {
  const modulePath = path.join(miniProgramRoot, relativePath)
  const original = require.cache[require.resolve(modulePath)]
  require.cache[require.resolve(modulePath)] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  }
  try {
    return callback()
  } finally {
    if (original) require.cache[require.resolve(modulePath)] = original
    else delete require.cache[require.resolve(modulePath)]
  }
}

function loadPage(relativePath, serviceRelativePath, serviceFake) {
  let definition = null
  global.Page = value => { definition = value }

  try {
    withFakeModule(serviceRelativePath, serviceFake, () => {
      const pagePath = path.join(miniProgramRoot, relativePath)
      delete require.cache[pagePath]
      require(pagePath)
    })
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  } finally {
    delete global.Page
  }

  if (!definition) return null
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      Object.assign(this.data, update)
    }
  }
}

test('administrator service forwards all six protected actions with exact payloads', async () => {
  const calls = []
  let adminUsers = null

  withFakeModule('utils/cloud.js', {
    callBusinessApi: async (...args) => {
      calls.push(args)
      return { action: args[0] }
    }
  }, () => {
    const servicePath = path.join(miniProgramRoot, 'services/admin-users.js')
    try {
      delete require.cache[servicePath]
      adminUsers = require(servicePath)
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  })

  assert.ok(adminUsers, 'administrator service should exist')
  await adminUsers.listUsers({ page: 2, pageSize: 20, status: 'active', keyword: 'ops' })
  await adminUsers.createUser({ username: 'operator', temporaryPassword: 'Secret123' })
  await adminUsers.updateUser('user-1', { status: 'disabled' })
  await adminUsers.resetUserPassword('user-1', 'Reset123')
  await adminUsers.unlockUser('user-1')
  await adminUsers.unbindWechat('user-1')

  assert.deepEqual(calls, [
    ['listUsers', { page: 2, pageSize: 20, status: 'active', keyword: 'ops' }],
    ['createUser', { username: 'operator', temporaryPassword: 'Secret123' }],
    ['updateUser', { userId: 'user-1', changes: { status: 'disabled' } }],
    ['resetUserPassword', { userId: 'user-1', temporaryPassword: 'Reset123' }],
    ['unlockUser', { userId: 'user-1' }],
    ['unbindWechat', { userId: 'user-1' }]
  ])
})

test('application starts at login, registers administrator pages, and keeps password inputs masked', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, 'app.json'), 'utf8'))
  assert.equal(appConfig.pages[0], 'pages/login/index')
  assert.ok(appConfig.pages.includes('pages/admin-users/index'))
  assert.ok(appConfig.pages.includes('pages/admin-user-edit/index'))

  const expectedMaskedInputs = [
    ['pages/login/index.wxml', ['password']],
    ['pages/change-password/index.wxml', ['current-password', 'new-password', 'confirm-password']],
    ['pages/admin-user-edit/index.wxml', ['temporary-password']]
  ]
  for (const [relativePath, ids] of expectedMaskedInputs) {
    const source = fs.readFileSync(path.join(miniProgramRoot, relativePath), 'utf8')
    for (const id of ids) {
      const input = source.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))
      assert.ok(input, `${relativePath} should contain #${id}`)
      assert.match(input[0], /\bpassword="true"/)
    }
  }
})

test('administrator list refuses non-super-administrators before loading account data', () => {
  const launches = []
  let listCalls = 0
  global.getApp = () => ({ globalData: { currentUser: { role: 'user', status: 'active' } } })
  global.wx = { reLaunch: options => launches.push(options) }
  const page = loadPage('pages/admin-users/index.js', 'services/admin-users.js', {
    listUsers: async () => { listCalls += 1 }
  })

  assert.ok(page, 'administrator list page should exist')
  page.onShow()

  assert.equal(listCalls, 0)
  assert.deepEqual(launches, [{ url: '/pages/dashboard/index' }])
})

test('administrator list loads filtered users and replaces page state', async () => {
  const user = {
    _id: 'user-1',
    username: 'operator',
    displayName: '操作员',
    role: 'user',
    status: 'active',
    openidBound: true,
    locked: false
  }
  const queries = []
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = { reLaunch: () => assert.fail('must not redirect') }
  const page = loadPage('pages/admin-users/index.js', 'services/admin-users.js', {
    listUsers: async query => {
      queries.push(query)
      return { items: [user], page: 1, pageSize: 20, total: 1, hasMore: false }
    }
  })
  assert.ok(page, 'administrator list page should exist')
  page.setData({ keyword: '  操作  ', status: 'active', page: 4, items: [{ _id: 'stale' }] })

  await page.search()

  assert.deepEqual(queries, [{ keyword: '操作', status: 'active', page: 1, pageSize: 20 }])
  assert.deepEqual(page.data.items, [user])
  assert.equal(page.data.total, 1)
  assert.equal(page.data.hasMore, false)
  assert.equal(page.data.loading, false)
})

test('failed loadMore preserves the page number so retry requests the same next page', async () => {
  const requestedPages = []
  let attempt = 0
  global.getApp = () => ({ globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } })
  global.wx = { reLaunch: () => assert.fail('must not redirect') }
  const page = loadPage('pages/admin-users/index.js', 'services/admin-users.js', {
    listUsers: async query => {
      requestedPages.push(query.page)
      attempt += 1
      if (attempt === 1) throw new Error('temporary failure')
      return {
        items: [{ _id: 'user-2' }],
        page: 2,
        pageSize: 20,
        total: 2,
        hasMore: false
      }
    }
  })
  assert.ok(page, 'administrator list page should exist')
  page.setData({ page: 1, pageSize: 20, total: 2, hasMore: true, items: [{ _id: 'user-1' }] })

  await page.loadMore()
  assert.equal(page.data.page, 1)

  await page.loadMore()

  assert.deepEqual(requestedPages, [2, 2])
  assert.equal(page.data.page, 2)
  assert.deepEqual(page.data.items, [{ _id: 'user-1' }, { _id: 'user-2' }])
})

test('confirmed account mutations refresh the user list and cancelled ones do nothing', async () => {
  const updates = []
  let listCalls = 0
  const modalResults = [
    { confirm: false },
    { confirm: true }
  ]
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = {
    showModal: async () => modalResults.shift(),
    showToast: () => {}
  }
  const page = loadPage('pages/admin-users/index.js', 'services/admin-users.js', {
    listUsers: async () => {
      listCalls += 1
      return { items: [], page: 1, pageSize: 20, total: 0, hasMore: false }
    },
    updateUser: async (...args) => {
      updates.push(args)
      return { _id: 'user-1', role: 'user', status: 'disabled', openidBound: true, mustChangePassword: false }
    }
  })
  assert.ok(page, 'administrator list page should exist')
  const event = { currentTarget: { dataset: { id: 'user-1', status: 'active' } } }

  await page.toggleStatus(event)
  await page.toggleStatus(event)

  assert.deepEqual(updates, [['user-1', { status: 'disabled' }]])
  assert.equal(listCalls, 1)
})

test('password reset validates the untrimmed value, confirms, clears it, and refreshes', async () => {
  const resetCalls = []
  let listCalls = 0
  const modalResults = [
    { confirm: true, content: ' short ' },
    { confirm: true, content: ' Passcode8 ' }
  ]
  const toasts = []
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = {
    showModal: async () => modalResults.shift(),
    showToast: options => toasts.push(options)
  }
  const page = loadPage('pages/admin-users/index.js', 'services/admin-users.js', {
    listUsers: async () => {
      listCalls += 1
      return { items: [], page: 1, pageSize: 20, total: 0, hasMore: false }
    },
    resetUserPassword: async (...args) => {
      resetCalls.push(args)
      return { _id: 'user-1', role: 'user', status: 'active', openidBound: true, mustChangePassword: true }
    }
  })
  assert.ok(page, 'administrator list page should exist')
  const event = { currentTarget: { dataset: { id: 'user-1' } } }

  await page.resetPassword(event)
  await page.resetPassword(event)

  assert.equal(toasts[0].title, '密码须为 8-64 位，并至少包含一个英文字母和一个数字')
  assert.deepEqual(resetCalls, [['user-1', ' Passcode8 ']])
  assert.equal(listCalls, 1)
  assert.equal(page.pendingPassword, undefined)
})

test('unlock and WeChat unbind each require confirmation and refresh after success', async () => {
  const unlockCalls = []
  const unbindCalls = []
  let listCalls = 0
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = {
    showModal: async () => ({ confirm: true }),
    showToast: () => {}
  }
  const page = loadPage('pages/admin-users/index.js', 'services/admin-users.js', {
    listUsers: async () => {
      listCalls += 1
      return { items: [], page: 1, pageSize: 20, total: 0, hasMore: false }
    },
    unlockUser: async userId => {
      unlockCalls.push(userId)
      return { _id: userId, role: 'user', status: 'active', openidBound: true, mustChangePassword: false }
    },
    unbindWechat: async userId => {
      unbindCalls.push(userId)
      return { _id: userId, role: 'user', status: 'active', openidBound: false, mustChangePassword: false }
    }
  })
  assert.ok(page, 'administrator list page should exist')
  const event = { currentTarget: { dataset: { id: 'user-1' } } }

  await page.unlock(event)
  await page.unbindWechat(event)

  assert.deepEqual(unlockCalls, ['user-1'])
  assert.deepEqual(unbindCalls, ['user-1'])
  assert.equal(listCalls, 2)
})

test('self-targeted credential/status/role/binding mutations route safely and clean or synchronize auth', async () => {
  const scenarios = [
    {
      name: 'credential reset',
      pagePath: 'pages/admin-users/index.js',
      result: { _id: 'admin-1', role: 'super_admin', status: 'active', openidBound: true, mustChangePassword: true },
      serviceMethod: 'resetUserPassword',
      execute: page => page.resetPassword({ currentTarget: { dataset: { id: 'admin-1' } } }),
      expectedRoute: '/pages/login/index',
      expectedReset: 1
    },
    {
      name: 'status disable',
      pagePath: 'pages/admin-users/index.js',
      result: { _id: 'admin-1', role: 'super_admin', status: 'disabled', openidBound: true, mustChangePassword: false },
      serviceMethod: 'updateUser',
      execute: page => page.toggleStatus({ currentTarget: { dataset: { id: 'admin-1', status: 'active' } } }),
      expectedRoute: '/pages/login/index',
      expectedReset: 1
    },
    {
      name: 'role demotion',
      pagePath: 'pages/admin-user-edit/index.js',
      result: { _id: 'admin-1', username: 'admin', displayName: '管理员', role: 'user', status: 'active', openidBound: true, mustChangePassword: false },
      serviceMethod: 'updateUser',
      prepare: async page => {
        await page.onLoad({ id: 'admin-1', username: 'admin', displayName: '管理员', role: 'super_admin', status: 'active' })
        page.setData({ role: 'user' })
      },
      execute: page => page.submit(),
      expectedRoute: '/pages/dashboard/index',
      expectedReset: 0
    },
    {
      name: 'binding removal',
      pagePath: 'pages/admin-users/index.js',
      result: { _id: 'admin-1', role: 'super_admin', status: 'active', openidBound: false, mustChangePassword: false },
      serviceMethod: 'unbindWechat',
      execute: page => page.unbindWechat({ currentTarget: { dataset: { id: 'admin-1' } } }),
      expectedRoute: '/pages/login/index',
      expectedReset: 1
    }
  ]

  for (const scenario of scenarios) {
    const launches = []
    let resetCalls = 0
    let listCalls = 0
    const currentUser = {
      _id: 'admin-1',
      username: 'admin',
      displayName: '管理员',
      role: 'super_admin',
      status: 'active',
      openidBound: true,
      mustChangePassword: false
    }
    const app = {
      globalData: { currentUser, loginChallenge: null },
      resetAuthState() {
        resetCalls += 1
        this.globalData.currentUser = null
        this.globalData.loginChallenge = null
      }
    }
    global.getApp = () => app
    global.wx = {
      showModal: async () => ({ confirm: true, content: 'Valid1234' }),
      showToast: () => {},
      reLaunch: options => launches.push(options),
      navigateBack: () => assert.fail(`${scenario.name} must not navigate back`),
      setNavigationBarTitle: () => {}
    }
    const serviceFake = {
      listUsers: async () => {
        listCalls += 1
        return { items: [currentUser], page: 1, pageSize: 100, total: 1, hasMore: false }
      },
      [scenario.serviceMethod]: async () => scenario.result
    }
    const page = loadPage(scenario.pagePath, 'services/admin-users.js', serviceFake)
    assert.ok(page, `${scenario.name} page should exist`)
    if (scenario.prepare) await scenario.prepare(page)

    await scenario.execute(page)

    assert.equal(resetCalls, scenario.expectedReset, scenario.name)
    assert.deepEqual(launches, [{ url: scenario.expectedRoute }], scenario.name)
    assert.equal(listCalls, scenario.pagePath.includes('admin-user-edit') ? 1 : 0, scenario.name)
    if (scenario.expectedReset === 0) assert.equal(app.globalData.currentUser.role, 'user', scenario.name)
    else assert.equal(app.globalData.currentUser, null, scenario.name)
  }
})

test('create page rejects incomplete passwords and submits the exact untrimmed password', async () => {
  const calls = []
  const navigations = []
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = {
    navigateBack: options => navigations.push(options),
    reLaunch: () => assert.fail('must not redirect'),
    setNavigationBarTitle: () => {},
    showToast: () => {}
  }
  const page = loadPage('pages/admin-user-edit/index.js', 'services/admin-users.js', {
    createUser: async input => {
      calls.push(input)
      return { _id: 'user-1' }
    }
  })
  assert.ok(page, 'administrator edit page should exist')
  page.onLoad({})
  page.setData({
    username: ' Operator ',
    displayName: ' 操作员 ',
    role: 'user',
    temporaryPassword: 'abcdefgh'
  })
  await page.submit()
  assert.deepEqual(calls, [])
  assert.equal(page.data.errorMessage, '密码须为 8-64 位，并至少包含一个英文字母和一个数字')

  page.setData({ temporaryPassword: ' Passcode8 ' })
  await page.submit()

  assert.deepEqual(calls, [{
    username: 'Operator',
    displayName: '操作员',
    role: 'user',
    temporaryPassword: ' Passcode8 '
  }])
  assert.equal(page.data.temporaryPassword, '')
  assert.deepEqual(navigations, [{ delta: 1 }])
})

test('edit refreshes authoritative state and is immune to stale role/status route parameters', async () => {
  const authoritative = {
    _id: 'user-1',
    username: 'operator',
    displayName: '服务端姓名',
    role: 'user',
    status: 'disabled',
    openidBound: false,
    locked: false
  }
  const listQueries = []
  const updateCalls = []
  global.getApp = () => ({ globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } })
  global.wx = {
    reLaunch: () => assert.fail('must not redirect'),
    navigateBack: () => {},
    setNavigationBarTitle: () => {},
    showModal: () => assert.fail('unchanged authoritative role/status must not require confirmation'),
    showToast: () => {}
  }
  const page = loadPage('pages/admin-user-edit/index.js', 'services/admin-users.js', {
    listUsers: async query => {
      listQueries.push(query)
      return { items: [authoritative], page: 1, pageSize: 100, total: 1, hasMore: false }
    },
    updateUser: async (...args) => {
      updateCalls.push(args)
      return Object.assign({}, authoritative, args[1])
    }
  })
  assert.ok(page, 'administrator edit page should exist')

  await page.onLoad({
    id: 'user-1',
    username: 'operator',
    displayName: '过期姓名',
    role: 'super_admin',
    status: 'active'
  })

  assert.deepEqual(listQueries, [{ keyword: 'operator', status: 'all', page: 1, pageSize: 100 }])
  assert.equal(page.data.displayName, '服务端姓名')
  assert.equal(page.data.role, 'user')
  assert.equal(page.data.status, 'disabled')

  page.setData({ displayName: ' 新姓名 ' })
  await page.submit()

  assert.deepEqual(updateCalls, [['user-1', { displayName: '新姓名' }]])
})

test('edit fails closed when authoritative targeted lookup is absent or ambiguous', async () => {
  for (const items of [
    [],
    [
      { _id: 'user-1', username: 'operator', displayName: '一', role: 'user', status: 'active' },
      { _id: 'user-1', username: 'operator', displayName: '二', role: 'user', status: 'active' }
    ]
  ]) {
    let updateCalls = 0
    global.getApp = () => ({ globalData: { currentUser: { _id: 'admin-1', role: 'super_admin', status: 'active' } } })
    global.wx = {
      reLaunch: () => assert.fail('must not redirect'),
      navigateBack: () => assert.fail('unverified target must not navigate'),
      setNavigationBarTitle: () => {},
      showToast: () => {}
    }
    const page = loadPage('pages/admin-user-edit/index.js', 'services/admin-users.js', {
      listUsers: async () => ({ items, page: 1, pageSize: 100, total: items.length, hasMore: false }),
      updateUser: async () => { updateCalls += 1 }
    })
    assert.ok(page, 'administrator edit page should exist')

    await page.onLoad({ id: 'user-1', username: 'operator', role: 'super_admin', status: 'disabled' })
    await page.submit()

    assert.equal(updateCalls, 0)
    assert.equal(page.data.errorMessage, '无法确认用户最新状态，请返回列表重试')
  }
})

test('edit page maps last-super-administrator protection to the approved message', async () => {
  const protectedError = new Error('LAST_SUPER_ADMIN')
  protectedError.code = 'LAST_SUPER_ADMIN'
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = {
    reLaunch: () => assert.fail('must not redirect'),
    setNavigationBarTitle: () => {},
    showModal: async () => ({ confirm: true })
  }
  const page = loadPage('pages/admin-user-edit/index.js', 'services/admin-users.js', {
    listUsers: async () => ({
      items: [{ _id: 'admin-1', username: 'admin', displayName: '管理员', role: 'super_admin', status: 'active' }],
      page: 1,
      pageSize: 100,
      total: 1,
      hasMore: false
    }),
    updateUser: async () => { throw protectedError }
  })
  assert.ok(page, 'administrator edit page should exist')
  await page.onLoad({ id: 'admin-1', username: 'admin', displayName: '管理员', role: 'super_admin', status: 'active' })
  page.setData({ status: 'disabled' })

  await page.submit()

  assert.equal(page.data.errorMessage, '必须至少保留一个启用状态的超级管理员')
  assert.equal(page.data.submitting, false)
})

test('edit page keeps username immutable and updates only editable account fields', async () => {
  const calls = []
  const navigations = []
  let modalCalls = 0
  global.getApp = () => ({ globalData: { currentUser: { role: 'super_admin', status: 'active' } } })
  global.wx = {
    reLaunch: () => assert.fail('must not redirect'),
    navigateBack: options => navigations.push(options),
    setNavigationBarTitle: () => {},
    showModal: async () => {
      modalCalls += 1
      return { confirm: true }
    },
    showToast: () => {}
  }
  const page = loadPage('pages/admin-user-edit/index.js', 'services/admin-users.js', {
    listUsers: async () => ({
      items: [{ _id: 'user-1', username: 'operator', displayName: '操作员', role: 'user', status: 'active' }],
      page: 1,
      pageSize: 100,
      total: 1,
      hasMore: false
    }),
    updateUser: async (...args) => {
      calls.push(args)
      return { _id: 'user-1', username: 'operator', displayName: '新名称', role: 'super_admin', status: 'disabled' }
    }
  })
  assert.ok(page, 'administrator edit page should exist')
  await page.onLoad({ id: 'user-1', username: 'operator', displayName: '操作员', role: 'user', status: 'active' })
  page.setData({ username: 'attempted-change', displayName: ' 新名称 ', role: 'super_admin', status: 'disabled' })

  await page.submit()

  assert.deepEqual(calls, [['user-1', { displayName: '新名称', role: 'super_admin', status: 'disabled' }]])
  assert.equal(modalCalls, 1)
  assert.deepEqual(navigations, [{ delta: 1 }])
})

test('profile uses the authenticated account and logout only resets in-memory auth state', () => {
  const launches = []
  let resetCalls = 0
  let bootstrapCalls = 0
  const user = { username: 'operator', displayName: '操作员', role: 'user', avatarUrl: '' }
  const app = {
    globalData: { currentUser: user, loginChallenge: 'stale' },
    resetAuthState() {
      resetCalls += 1
      this.globalData.currentUser = null
      this.globalData.loginChallenge = null
    }
  }
  global.getApp = () => app
  global.wx = {
    reLaunch: options => launches.push(options),
    showModal: async () => ({ confirm: true })
  }
  const page = loadPage('pages/profile/index.js', 'services/business.js', {
    bootstrap: async () => { bootstrapCalls += 1 }
  })
  assert.ok(page, 'profile page should exist')

  page.onLoad()
  return page.logout().then(() => {
    assert.equal(bootstrapCalls, 0)
    assert.equal(page.data.username, 'operator')
    assert.equal(page.data.roleLabel, '普通用户')
    assert.equal(resetCalls, 1)
    assert.equal(app.globalData.currentUser, null)
    assert.deepEqual(launches, [{ url: '/pages/login/index' }])
  })
})

test('dashboard opens user management only for an active super-administrator', () => {
  const navigations = []
  global.wx = { navigateTo: options => navigations.push(options) }
  const page = loadPage('pages/dashboard/index.js', 'services/business.js', {})
  assert.ok(page, 'dashboard page should exist')

  page.setData({ profile: { role: 'user', status: 'active' } })
  page.openAdminUsers()
  page.setData({ profile: { role: 'super_admin', status: 'active' } })
  page.openAdminUsers()

  assert.deepEqual(navigations, [{ url: '/pages/admin-users/index' }])
  const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/dashboard/index.wxml'), 'utf8')
  assert.match(wxml, /wx:if="{{profile && profile\.role === 'super_admin'}}"[^>]*bindtap="openAdminUsers"/)
})
