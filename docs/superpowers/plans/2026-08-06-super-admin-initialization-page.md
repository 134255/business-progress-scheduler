# 首位超级管理员安全初始化页面实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在小程序登录流程中增加受后端守卫保护的首位超级管理员初始化页面，并在初始化成功后自动进入现有强制改密流程。

**Architecture:** 登录页只负责发现 `requiresInitialization` 并导航；独立初始化页重新核对初始化状态、收集一次性输入、依次调用初始化与临时密码登录；账户服务继续作为唯一客户端云函数边界。后端初始化事务和恢复码消费逻辑保持不变，敏感字段只存在于页面内存和当前异步调用栈中。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、`wx.cloud.callFunction`、Node.js 内置测试运行器、现有 `businessApi` 云函数。

## Global Constraints

- 初始化请求只能发送 `username`、`displayName`、`temporaryPassword`、`recoveryCode`，不得发送 OpenID。
- 临时密码、确认密码、恢复码和挑战令牌不得进入持久化存储、URL、dataset、日志或错误消息。
- 初始化页面必须在加载时重新调用 `getSession`，不能只信任登录页导航状态。
- 后端仍是密码规则、可信微信身份、零活动超级管理员和一次性恢复码消费的最终判定者。
- 初始化成功后自动登录只允许一次；自动登录失败时不得重试初始化。
- 页面卸载、初始化失败、自动登录失败和成功跳转前必须清空敏感字段。
- 不增加第三方依赖，不修改后端账户事务和恢复码实现。
- 保留工作树中任何预先存在且不属于本计划的改动；只暂存本任务的明确文件和补丁块。

---

### Task 1: 扩展账户服务初始化接口

**Files:**
- Modify: `miniprogram/services/account.js`
- Test: `miniprogram/test/account-flow.test.js`

**Interfaces:**
- Consumes: `callBusinessApi(action, payload, { silent: true })` from `miniprogram/utils/cloud.js`.
- Produces: `initializeSuperAdmin(username, displayName, temporaryPassword, recoveryCode): Promise<{ user: object }>`.

- [ ] **Step 1: 将账户服务调用测试扩展为五个公开动作**

把现有测试名称改为 `account service sends the five account actions through silent cloud calls`，在 `changePassword` 后增加：

```js
await account.initializeSuperAdmin(
  'first-admin',
  '首位管理员',
  'temporary-pass-8',
  'paper-recovery-code'
)
```

并在预期调用数组末尾增加：

```js
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
```

- [ ] **Step 2: 运行聚焦测试并确认失败**

Run:

```powershell
node --test --test-name-pattern="account service sends the five account actions" miniprogram/test/account-flow.test.js
```

Expected: FAIL，错误表明 `account.initializeSuperAdmin` 不存在。

- [ ] **Step 3: 实现最小账户服务方法**

在 `miniprogram/services/account.js` 增加：

```js
function initializeSuperAdmin(username, displayName, temporaryPassword, recoveryCode) {
  return callBusinessApi('initializeSuperAdmin', {
    username,
    displayName,
    temporaryPassword,
    recoveryCode
  }, { silent: true })
}
```

并显式导出：

```js
module.exports = {
  getSession,
  login,
  completeFirstLogin,
  changePassword,
  initializeSuperAdmin
}
```

- [ ] **Step 4: 运行聚焦测试并确认通过**

Run:

```powershell
node --test --test-name-pattern="account service sends the five account actions" miniprogram/test/account-flow.test.js
```

Expected: PASS，1 项匹配测试通过，其他测试因名称过滤而跳过。

- [ ] **Step 5: 提交账户服务边界**

```powershell
git add -- miniprogram/services/account.js miniprogram/test/account-flow.test.js
git commit -m "feat: expose administrator initialization call"
```

---

### Task 2: 在登录页提供受状态控制的初始化入口

**Files:**
- Modify: `miniprogram/pages/login/index.js`
- Modify: `miniprogram/pages/login/index.wxml`
- Test: `miniprogram/test/account-flow.test.js`

**Interfaces:**
- Consumes: `requiresInitialization` already returned by `accountService.getSession()`.
- Produces: `openInitialization()` that navigates to `/pages/admin-initialize/index` only while `requiresInitialization === true`.

- [ ] **Step 1: 写登录页导航失败测试**

在 `miniprogram/test/account-flow.test.js` 增加：

```js
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
```

- [ ] **Step 2: 运行聚焦测试并确认失败**

Run:

```powershell
node --test --test-name-pattern="login opens the guarded initialization page" miniprogram/test/account-flow.test.js
```

Expected: FAIL，错误表明 `page.openInitialization` 不存在。

- [ ] **Step 3: 实现登录页导航方法**

在 `miniprogram/pages/login/index.js` 的输入处理方法之前增加：

```js
openInitialization() {
  if (!this.data.requiresInitialization) return
  wx.navigateTo({ url: '/pages/admin-initialize/index' })
},
```

- [ ] **Step 4: 将未初始化分支改为明确按钮**

保留现有错误提示，并在 `miniprogram/pages/login/index.wxml` 的 `wx:else` 分支中使用以下结构：

```xml
<block wx:if="{{requiresInitialization}}">
  <text class="muted intro">首次使用需要由授权操作员创建首位超级管理员</text>
  <button class="primary-button submit" bindtap="openInitialization">初始化首位管理员</button>
</block>

<block wx:else>
  <!-- 保留现有用户名、密码和登录按钮 -->
</block>
```

不得在按钮上增加 `data-password`、`data-recovery-code` 或其他敏感 dataset。

- [ ] **Step 5: 运行登录页测试和 WXML 结构检查**

Run:

```powershell
node --test --test-name-pattern="login reports initialization|login opens the guarded initialization page" miniprogram/test/account-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: 两项登录页测试 PASS；WXML 结构检查 1 项 PASS。

- [ ] **Step 6: 提交登录入口**

```powershell
git add -- miniprogram/pages/login/index.js miniprogram/pages/login/index.wxml miniprogram/test/account-flow.test.js
git commit -m "feat: add guarded initialization entry"
```

---

### Task 3: 实现独立初始化页面和自动强制改密衔接

**Files:**
- Create: `miniprogram/pages/admin-initialize/index.js`
- Create: `miniprogram/pages/admin-initialize/index.json`
- Create: `miniprogram/pages/admin-initialize/index.wxml`
- Create: `miniprogram/pages/admin-initialize/index.wxss`
- Modify: `miniprogram/app.json`
- Test: `miniprogram/test/account-flow.test.js`

**Interfaces:**
- Consumes: `accountService.getSession()`, `accountService.initializeSuperAdmin(...)`, `accountService.login(username, temporaryPassword)` and `getApp().globalData.loginChallenge`.
- Produces: page methods `onLoad`, five input handlers, `submit`, `clearSensitiveFields`, `clearAllFields`, and `onUnload`.
- Success transition: `/pages/change-password/index?mode=first` with challenge held only in app memory.

- [ ] **Step 1: 写初始化页面加载守卫失败测试**

增加测试，覆盖未初始化状态显示、已初始化状态返回登录页和已认证状态进入仪表盘：

```js
test('administrator initialization page rechecks session state before showing the form', async () => {
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
```

再增加两个独立测试实例：

```js
getSession: async () => ({ authenticated: false, requiresInitialization: false })
// Expected reLaunch: /pages/login/index

getSession: async () => ({ authenticated: true, user: { _id: 'admin-1' } })
// Expected currentUser updated and reLaunch: /pages/dashboard/index
```

- [ ] **Step 2: 写校验和成功数据流失败测试**

成功测试必须记录调用顺序并阻止持久化：

```js
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
```

增加输入不完整和两次密码不一致测试，断言两个服务方法均未调用，且 `errorMessage` 非空。

- [ ] **Step 3: 写初始化后自动登录失败与清理失败测试**

增加测试：初始化方法成功一次、登录方法抛错，断言初始化只调用一次、三个敏感字段为空、出现不可取消 Modal，并 `reLaunch` 到登录页。增加 `ALREADY_INITIALIZED` 测试，断言不调用登录且直接返回登录页。增加 `onUnload` 测试，断言五个表单字段全部清空。

Modal 断言形态：

```js
assert.deepEqual(modals, [{
  title: '初始化已完成',
  content: '管理员已创建，请返回登录页使用临时密码登录',
  showCancel: false
}])
```

- [ ] **Step 4: 运行新增页面测试并确认失败**

Run:

```powershell
node --test --test-name-pattern="administrator initialization" miniprogram/test/account-flow.test.js
```

Expected: FAIL，页面文件尚不存在或页面方法尚未定义。

- [ ] **Step 5: 注册页面并创建基础配置**

在 `miniprogram/app.json` 的登录页之后注册：

```json
"pages/admin-initialize/index"
```

创建 `miniprogram/pages/admin-initialize/index.json`：

```json
{
  "navigationBarTitleText": "初始化超级管理员"
}
```

- [ ] **Step 6: 实现初始化页面控制器**

`miniprogram/pages/admin-initialize/index.js` 使用以下状态和核心控制流：

```js
const accountService = require('../../services/account')

const PASSWORD_MESSAGE = '密码须为 8-64 位，并至少包含一个英文字母和一个数字'
const REQUIRED_MESSAGE = '请完整填写管理员用户名、显示名称、临时密码和恢复码'
const LOGIN_AFTER_INITIALIZATION_MESSAGE = '管理员已创建，请返回登录页使用临时密码登录'

function isValidPassword(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 64 &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
}

Page({
  data: {
    checking: true,
    available: false,
    submitting: false,
    username: '',
    displayName: '',
    temporaryPassword: '',
    confirmPassword: '',
    recoveryCode: '',
    errorMessage: ''
  },

  async onLoad() {
    try {
      const session = await accountService.getSession()
      if (session.authenticated) {
        getApp().globalData.currentUser = session.user
        wx.reLaunch({ url: '/pages/dashboard/index' })
        return
      }
      if (!session.requiresInitialization) {
        wx.reLaunch({ url: '/pages/login/index' })
        return
      }
      this.setData({ available: true })
    } catch (error) {
      this.setData({ errorMessage: error && error.message ? error.message : '网络异常，请稍后重试' })
    } finally {
      this.setData({ checking: false })
    }
  },

  async submit() {
    if (!this.data.available || this.data.submitting) return
    const username = this.data.username.trim()
    const displayName = this.data.displayName.trim()
    const temporaryPassword = this.data.temporaryPassword
    const recoveryCode = this.data.recoveryCode.trim()
    if (!username || !displayName || !temporaryPassword || !recoveryCode) {
      this.setData({ errorMessage: REQUIRED_MESSAGE })
      return
    }
    if (!isValidPassword(temporaryPassword)) {
      this.setData({ errorMessage: PASSWORD_MESSAGE })
      return
    }
    if (temporaryPassword !== this.data.confirmPassword) {
      this.setData({ errorMessage: '两次输入的临时密码不一致' })
      return
    }

    let initialized = false
    this.setData({ submitting: true, errorMessage: '' })
    try {
      await accountService.initializeSuperAdmin(username, displayName, temporaryPassword, recoveryCode)
      initialized = true
      this.clearSensitiveFields()
      const loginResult = await accountService.login(username, temporaryPassword)
      if (!loginResult.passwordChangeRequired || !loginResult.challengeToken) {
        throw new Error(LOGIN_AFTER_INITIALIZATION_MESSAGE)
      }
      getApp().globalData.loginChallenge = loginResult.challengeToken
      wx.navigateTo({ url: '/pages/change-password/index?mode=first' })
    } catch (error) {
      this.clearSensitiveFields()
      if (initialized) {
        await wx.showModal({
          title: '初始化已完成',
          content: LOGIN_AFTER_INITIALIZATION_MESSAGE,
          showCancel: false
        })
        wx.reLaunch({ url: '/pages/login/index' })
        return
      }
      if (error && error.code === 'ALREADY_INITIALIZED') {
        this.clearAllFields()
        wx.reLaunch({ url: '/pages/login/index' })
        return
      }
      this.setData({ errorMessage: error && error.message ? error.message : '网络异常，请稍后重试' })
    } finally {
      this.setData({ submitting: false })
    }
  }
})
```

补充五个输入处理方法，并实现：

```js
clearSensitiveFields() {
  this.setData({ temporaryPassword: '', confirmPassword: '', recoveryCode: '' })
},

clearAllFields() {
  this.setData({
    username: '',
    displayName: '',
    temporaryPassword: '',
    confirmPassword: '',
    recoveryCode: ''
  })
},

onUnload() {
  this.clearAllFields()
}
```

- [ ] **Step 7: 创建无敏感 dataset 的表单视图**

`miniprogram/pages/admin-initialize/index.wxml` 包含 checking、error、五个字段和提交按钮。三个敏感输入必须使用：

```xml
<input
  class="input"
  value="{{temporaryPassword}}"
  password="true"
  maxlength="64"
  bindinput="onTemporaryPasswordInput"
/>
```

确认密码和恢复码使用相同的 `password="true"` 模式；恢复码不得提供复制按钮。提交按钮使用：

```xml
<button
  class="primary-button"
  loading="{{submitting}}"
  disabled="{{submitting || checking || !available}}"
  bindtap="submit"
>创建并设置正式密码</button>
```

`index.wxss` 复用全局 `.page`、`.card`、`.input` 和 `.primary-button`，只增加初始化卡片宽度、字段间距、提示和错误样式，不引入资源 URL。

- [ ] **Step 8: 增加静态敏感数据边界测试**

读取新页面的 JS/WXML 源码并断言：

```js
assert.doesNotMatch(source, /setStorage|setStorageSync|data-(?:password|recovery|challenge)/)
assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/)
assert.match(wxml, /password="true"/)
```

- [ ] **Step 9: 运行初始化页面和客户端完整测试**

Run:

```powershell
node --test --test-name-pattern="administrator initialization" miniprogram/test/account-flow.test.js
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: 所有初始化页面测试 PASS；两个客户端测试文件 0 failures；WXML 结构检查 1 项 PASS。

- [ ] **Step 10: 提交初始化页面**

```powershell
git add -- miniprogram/app.json miniprogram/pages/admin-initialize/index.js miniprogram/pages/admin-initialize/index.json miniprogram/pages/admin-initialize/index.wxml miniprogram/pages/admin-initialize/index.wxss miniprogram/test/account-flow.test.js
git commit -m "feat: initialize first administrator in mini program"
```

---

### Task 4: 更新部署手册、项目记忆并完成整体验证

**Files:**
- Modify: `docs/deployment/account-admin-setup.md`（只暂存本任务修改的初始化章节补丁块）
- Modify: `docs/memory/STATUS.md`
- Modify: `docs/memory/PROJECT.md` only if the initialization route becomes a stable deployed architecture fact

**Interfaces:**
- Consumes: implemented `/pages/admin-initialize/index` flow and existing backend guard.
- Produces: current operator procedure and evidence-backed handoff state.

- [ ] **Step 1: 更新首位管理员运行步骤**

将 `docs/deployment/account-admin-setup.md` 的“初始化首位超级管理员”章节改为：

1. 部署 `businessApi` 并配置一致的两处恢复哈希。
2. 编译小程序，登录页检测到未初始化状态后点击“初始化首位管理员”。
3. 在小程序页面本地输入真实用户名、显示名称、临时密码和纸质恢复码。
4. 初始化成功后自动进入强制改密页；十分钟内设置正式密码。
5. 不使用本地云函数调试或 CloudBase 控制台模拟测试代替小程序调用，因为它们不提供本流程要求的可信小程序身份上下文。

保留现有非生产 JSON 示例时，明确标记为历史接口形态或删除示例，避免操作员再次把秘密放入测试面板。不要覆盖该文件中预先存在、与本任务无关的工作树改动；使用交互式暂存或等价的精确索引补丁只提交初始化章节。

- [ ] **Step 2: 更新项目记忆**

在 `docs/memory/STATUS.md` 记录：

- 初始化页面已本地实现及对应提交。
- 精确测试命令和通过数量。
- CloudBase 真实初始化、强制改密和脱敏数据库核对仍为 `unverified`，直到操作员完成。
- 下一动作是重新编译小程序并执行初始化验收。

如果页面已成为稳定架构事实，在 `docs/memory/PROJECT.md` 的客户端认证段补充“未初始化登录状态导航到独立初始化页面；页面从小程序运行时调用云函数并自动衔接强制改密”，不写任何操作值。

- [ ] **Step 3: 运行完整验证**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
node --check miniprogram/services/account.js
node --check miniprogram/pages/login/index.js
node --check miniprogram/pages/admin-initialize/index.js
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: 后端 120 tests、客户端账户测试全部通过、WXML 1 test、三个语法检查、差异检查和项目记忆校验全部成功。

- [ ] **Step 4: 检查敏感材料和暂存范围**

Run:

```powershell
rg -n -S "paper-recovery-code|temporary-pass-8|memory-only-challenge" miniprogram docs -g '!miniprogram/test/**' -g '!docs/superpowers/plans/**'
git status --short
git diff --cached --name-only
```

Expected: 示例秘密只存在测试或本计划中；源码、运行手册和项目记忆无命中。暂存列表不包含预先存在的无关补丁块。

- [ ] **Step 5: 提交运行手册和记忆**

仅暂存本任务的运行手册初始化章节、`STATUS.md` 和必要的 `PROJECT.md`：

```powershell
git add -- docs/memory/STATUS.md docs/memory/PROJECT.md
git add -p -- docs/deployment/account-admin-setup.md
git diff --cached --check
git commit -m "docs: update administrator initialization runbook"
```

- [ ] **Step 6: 推送验收分支**

```powershell
git push origin codex/account-admin
```

- [ ] **Step 7: 手工验收检查点**

操作员在微信开发者工具中重新编译并确认：

1. 登录页出现初始化入口。
2. 初始化表单不显示真实值截图，也不写入调试日志。
3. 初始化成功后自动进入强制改密页并完成正式密码设置。
4. 数据库只核对脱敏状态：`activeSuperAdminCount` 为 `1`、`recoveryConsumedAt` 非空、凭据 `mustChangePassword` 为 `false`、绑定和初始化审计记录存在。
5. 返回登录页后初始化入口不再出现。

手工验收未执行前，`STATUS.md` 必须继续标记为 `unverified`。
