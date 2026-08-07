# Super-administrator Recovery Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe Mini Program entry for the existing one-time super-administrator recovery route, automatically hand a successful recovery to forced password change, and keep all recovery material memory-only.

**Architecture:** Extend the existing account service with one silent API wrapper and expose recovery from the initialized login form. A dedicated public page owns the recovery form, calls recovery exactly once, clears page-bound secrets as soon as recovery settles, then uses a function-scoped temporary password for one immediate login call and stores only the returned first-login challenge in application memory.

**Tech Stack:** Native WeChat Mini Program JavaScript/WXML/WXSS, existing CloudBase `businessApi`, Node.js built-in test runner, repository WXML validator.

## Global Constraints

- Use the existing public `recoverSuperAdmin` backend action; do not change backend routes, database collections, indexes, dependencies, environment identifiers, transaction logic, or guard invariants.
- Never place real operator usernames, passwords, recovery codes, digests, OpenID values, user records, or user identifiers in storage, route parameters, datasets, logs, telemetry, fixtures, project memory, or Git history. Automated tests use only clearly synthetic fixed values.
- The recovery page must never call `getSession` and must not require an authenticated account.
- The login-page recovery entry is available only after session checking completes and `requiresInitialization` is false.
- Recovery is called at most once per page instance. After recovery succeeds, automatic-login failure must return to ordinary login without retrying recovery.
- Password policy is exactly 8–64 characters with at least one ASCII letter and one digit.
- All three secret inputs—temporary password, confirmation, and recovery code—must use `password="true"`.
- Only a nonempty first-login challenge may enter `getApp().globalData.loginChallenge`; no other recovery form value enters global state.
- Preserve the pre-existing user edit in `docs/deployment/account-admin-setup.md`; never stage it with this work.

## File Map

- Modify `miniprogram/services/account.js`: add the silent `recoverSuperAdmin` request wrapper.
- Modify `miniprogram/app.json`: register `pages/admin-recovery/index`.
- Modify `miniprogram/pages/login/index.js`: guard and open the recovery page.
- Modify `miniprogram/pages/login/index.wxml`: render the visible secondary recovery action only for initialized systems.
- Modify `miniprogram/pages/login/index.wxss`: space the secondary action below ordinary login.
- Create `miniprogram/pages/admin-recovery/index.js`: validate, recover once, hand off to login, clear secrets, and own failure fallback.
- Create `miniprogram/pages/admin-recovery/index.json`: set the recovery page title.
- Create `miniprogram/pages/admin-recovery/index.wxml`: render masked recovery inputs.
- Create `miniprogram/pages/admin-recovery/index.wxss`: style the dedicated card and safety hint.
- Modify `miniprogram/test/account-flow.test.js`: cover the service, guarded navigation, success, validation, failure, unload, and sensitive-data boundaries.
- Modify `docs/memory/STATUS.md`: record exact automated evidence and remaining manual recovery acceptance.

---

### Task 1: Recovery service and guarded login entry

**Files:**
- Modify: `miniprogram/services/account.js:1-31`
- Modify: `miniprogram/app.json:2-15`
- Modify: `miniprogram/pages/login/index.js:1-83`
- Modify: `miniprogram/pages/login/index.wxml:1-30`
- Modify: `miniprogram/pages/login/index.wxss:1-34`
- Test: `miniprogram/test/account-flow.test.js:138-266`

**Interfaces:**
- Produces: `accountService.recoverSuperAdmin(username, temporaryPassword, recoveryCode): Promise<object>`.
- Produces: login-page method `openRecovery(): void` navigating to `/pages/admin-recovery/index` only when checking is complete and initialization is not required.
- Preserves: existing `getSession`, password login, explicit-logout suppression, and initialization entry behavior.

- [ ] **Step 1: Extend the account-service test and add a guarded-navigation test**

Rename the service test to `account service sends the six account actions through silent cloud calls`, call:

```js
await account.recoverSuperAdmin(
  'recovery-admin',
  'temporary-pass-8',
  'one-time-recovery-code'
)
```

and append this exact expected call:

```js
[
  'recoverSuperAdmin',
  {
    username: 'recovery-admin',
    temporaryPassword: 'temporary-pass-8',
    recoveryCode: 'one-time-recovery-code'
  },
  { silent: true }
]
```

Add this focused login test:

```js
test('login opens super-administrator recovery only after initialization is ruled out', async () => {
  const navigations = []
  global.getApp = () => ({
    globalData: { currentUser: null, loginChallenge: null },
    isManualLoginRequired: () => true
  })
  global.wx = { navigateTo: options => navigations.push(options) }
  const page = loadPage('pages/login/index.js', {
    getSession: async () => ({ authenticated: false, requiresInitialization: false })
  })

  page.openRecovery()
  assert.deepEqual(navigations, [])

  await page.onLoad()
  page.openRecovery()
  assert.deepEqual(navigations, [{ url: '/pages/admin-recovery/index' }])

  page.setData({ requiresInitialization: true })
  page.openRecovery()
  assert.equal(navigations.length, 1)
})
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```powershell
node --test --test-name-pattern="six account actions|recovery only after" miniprogram/test/account-flow.test.js
```

Expected: FAIL because `recoverSuperAdmin` and `openRecovery` do not exist.

- [ ] **Step 3: Add the silent account-service wrapper**

Add before `module.exports` in `miniprogram/services/account.js`:

```js
function recoverSuperAdmin(username, temporaryPassword, recoveryCode) {
  return callBusinessApi('recoverSuperAdmin', {
    username,
    temporaryPassword,
    recoveryCode
  }, { silent: true })
}
```

Export `recoverSuperAdmin` beside `initializeSuperAdmin`. Do not add OpenID or another payload field.

- [ ] **Step 4: Register the page and implement guarded navigation**

Add `"pages/admin-recovery/index"` immediately after `"pages/admin-initialize/index"` in `miniprogram/app.json`.

Add to the login page definition:

```js
openRecovery() {
  if (this.data.checking || this.data.requiresInitialization) return
  wx.navigateTo({ url: '/pages/admin-recovery/index' })
},
```

Inside the existing initialized-system `wx:else` block, after the ordinary login button, add:

```xml
<button
  class="secondary-button recovery-entry"
  disabled="{{submitting}}"
  bindtap="openRecovery"
>超级管理员紧急恢复</button>
```

Add to `miniprogram/pages/login/index.wxss`:

```css
.recovery-entry {
  margin-top: 20rpx;
}
```

- [ ] **Step 5: Run focused and complete client tests**

Run:

```powershell
node --test --test-name-pattern="six account actions|recovery only after" miniprogram/test/account-flow.test.js
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: all commands PASS with zero failures.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- miniprogram/services/account.js miniprogram/app.json miniprogram/pages/login/index.js miniprogram/pages/login/index.wxml miniprogram/pages/login/index.wxss miniprogram/test/account-flow.test.js
git diff --cached --check
git commit -m "feat: add super-admin recovery entry"
```

Do not stage `docs/deployment/account-admin-setup.md`.

---

### Task 2: Memory-only recovery form and forced-password handoff

**Files:**
- Create: `miniprogram/pages/admin-recovery/index.js`
- Create: `miniprogram/pages/admin-recovery/index.json`
- Create: `miniprogram/pages/admin-recovery/index.wxml`
- Create: `miniprogram/pages/admin-recovery/index.wxss`
- Test: `miniprogram/test/account-flow.test.js`

**Interfaces:**
- Consumes: `accountService.recoverSuperAdmin(username, temporaryPassword, recoveryCode)` from Task 1.
- Consumes: existing `accountService.login(username, password)` returning `{ passwordChangeRequired, challengeToken }`.
- Produces: page methods `submit()`, `clearSensitiveFields()`, `clearAllFields()`, input handlers, and `onUnload()`.
- Produces: only `getApp().globalData.loginChallenge` on successful handoff.

- [ ] **Step 1: Add RED tests for validation, success, and double submission**

Add tests using `loadPage('pages/admin-recovery/index.js', accountFake)` that prove:

```js
test('super-administrator recovery rejects incomplete weak and mismatched credentials', async () => {
  let recoverCalls = 0
  let loginCalls = 0
  global.getApp = () => ({ globalData: { currentUser: null, loginChallenge: null } })
  global.wx = {}
  const page = loadPage('pages/admin-recovery/index.js', {
    recoverSuperAdmin: async () => { recoverCalls += 1 },
    login: async () => { loginCalls += 1 }
  })

  await page.submit()
  assert.match(page.data.errorMessage, /完整填写/)

  page.setData({
    username: 'admin', temporaryPassword: 'onlyletters',
    confirmPassword: 'onlyletters', recoveryCode: 'recovery-value'
  })
  await page.submit()
  assert.match(page.data.errorMessage, /8-64/)

  page.setData({
    temporaryPassword: 'temporary-pass-8', confirmPassword: 'different-pass-9'
  })
  await page.submit()
  assert.match(page.data.errorMessage, /不一致/)
  assert.equal(recoverCalls, 0)
  assert.equal(loginCalls, 0)
})
```

Add a successful handoff test with fake storage and log methods that fail immediately if called. Start `submit()` twice before awaiting either promise, resolve recovery once, and assert:

```js
assert.deepEqual(calls, [
  ['recover', 'Recovery-Admin', 'temporary-pass-8', 'one-time-recovery-code'],
  ['login', 'Recovery-Admin', 'temporary-pass-8']
])
assert.equal(app.globalData.loginChallenge, 'memory-only-recovery-challenge')
assert.equal(page.data.temporaryPassword, '')
assert.equal(page.data.confirmPassword, '')
assert.equal(page.data.recoveryCode, '')
assert.deepEqual(navigations, [{ url: '/pages/change-password/index?mode=first' }])
```

- [ ] **Step 2: Add RED tests for post-recovery failure, retryable recovery failure, unload, and source boundaries**

Add four tests:

1. Recovery succeeds and login throws: assert one recovery call, one login call, all secrets cleared, a non-secret modal appears, and `wx.reLaunch({ url: '/pages/login/index' })` occurs.
2. Recovery throws an `INVALID_RECOVERY_CODE` error: assert no login call, username remains for controlled retry, all three secret fields clear, the backend message is shown, and a second explicit `submit()` may call recovery again only after the operator re-enters all secret fields.
3. Input handlers update only their named fields and `onUnload()` clears username plus all three secret fields.
4. Source/WXML boundary test:

```js
const appConfig = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, 'app.json'), 'utf8'))
const source = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-recovery/index.js'), 'utf8')
const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/admin-recovery/index.wxml'), 'utf8')

assert.equal(appConfig.pages.includes('pages/admin-recovery/index'), true)
assert.doesNotMatch(source, /getSession|setStorage|setStorageSync|console\.(?:log|info|debug|warn|error)/)
assert.doesNotMatch(source, /[?&](?:username|password|recoveryCode)=/)
assert.doesNotMatch(wxml, /data-(?:username|password|recovery|challenge|openid|user)/i)
assert.equal((wxml.match(/password="true"/g) || []).length, 3)
```

- [ ] **Step 3: Run recovery-page tests and confirm RED**

Run:

```powershell
node --test --test-name-pattern="super-administrator recovery" miniprogram/test/account-flow.test.js
```

Expected: FAIL because the recovery page files do not exist.

- [ ] **Step 4: Implement the recovery page controller**

Create `miniprogram/pages/admin-recovery/index.js` with this behavior:

```js
const accountService = require('../../services/account')

const REQUIRED_MESSAGE = '请完整填写管理员用户名、临时密码、确认密码和一次性恢复码'
const PASSWORD_MESSAGE = '临时密码须为 8-64 位，并至少包含一个英文字母和一个数字'
const MISMATCH_MESSAGE = '两次输入的临时密码不一致'
const RECOVERY_COMPLETED_MESSAGE = '恢复已完成，请返回登录页使用刚才设置的临时密码登录'

function isValidPassword(value) {
  return typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 64 &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
}

Page({
  data: {
    submitting: false,
    username: '',
    temporaryPassword: '',
    confirmPassword: '',
    recoveryCode: '',
    errorMessage: ''
  },

  onUsernameInput(event) { this.setData({ username: event.detail.value }) },
  onTemporaryPasswordInput(event) { this.setData({ temporaryPassword: event.detail.value }) },
  onConfirmPasswordInput(event) { this.setData({ confirmPassword: event.detail.value }) },
  onRecoveryCodeInput(event) { this.setData({ recoveryCode: event.detail.value }) },

  async submit() {
    if (this.data.submitting || this.recoveryCompleted) return
    const username = this.data.username.trim()
    const temporaryPassword = this.data.temporaryPassword
    const recoveryCode = this.data.recoveryCode.trim()

    if (!username || !temporaryPassword || !this.data.confirmPassword || !recoveryCode) {
      this.setData({ errorMessage: REQUIRED_MESSAGE })
      return
    }
    if (!isValidPassword(temporaryPassword)) {
      this.setData({ errorMessage: PASSWORD_MESSAGE })
      return
    }
    if (temporaryPassword !== this.data.confirmPassword) {
      this.setData({ errorMessage: MISMATCH_MESSAGE })
      return
    }

    this.setData({ submitting: true, errorMessage: '' })
    try {
      await accountService.recoverSuperAdmin(username, temporaryPassword, recoveryCode)
    } catch (error) {
      this.clearSensitiveFields()
      this.setData({
        submitting: false,
        errorMessage: error && error.message ? error.message : '网络异常，请稍后重试'
      })
      return
    }

    this.recoveryCompleted = true
    this.clearSensitiveFields()
    try {
      const result = await accountService.login(username, temporaryPassword)
      if (!result.passwordChangeRequired || !result.challengeToken) {
        throw new Error(RECOVERY_COMPLETED_MESSAGE)
      }
      getApp().globalData.loginChallenge = result.challengeToken
      wx.navigateTo({ url: '/pages/change-password/index?mode=first' })
    } catch (_error) {
      try {
        await wx.showModal({
          title: '恢复已完成',
          content: RECOVERY_COMPLETED_MESSAGE,
          showCancel: false
        })
      } catch (_modalError) {
      } finally {
        wx.reLaunch({ url: '/pages/login/index' })
      }
    } finally {
      this.setData({ submitting: false })
    }
  },

  clearSensitiveFields() {
    this.setData({ temporaryPassword: '', confirmPassword: '', recoveryCode: '' })
  },

  clearAllFields() {
    this.setData({ username: '', temporaryPassword: '', confirmPassword: '', recoveryCode: '' })
  },

  onUnload() {
    this.clearAllFields()
  }
})
```

The `username` and `temporaryPassword` constants are function-scoped. The page clears bound secrets immediately after recovery settles; after the immediate login call finishes, those constants become unreachable.

- [ ] **Step 5: Create page registration metadata and masked WXML**

Create `miniprogram/pages/admin-recovery/index.json`:

```json
{
  "navigationBarTitleText": "超级管理员紧急恢复"
}
```

Create `miniprogram/pages/admin-recovery/index.wxml`:

```xml
<view class="page recovery-page">
  <view class="card recovery-card">
    <view class="title">超级管理员紧急恢复</view>
    <text class="muted intro">恢复码仅可成功使用一次；恢复后必须立即设置正式密码</text>
    <view class="error" wx:if="{{errorMessage}}">{{errorMessage}}</view>

    <view class="field">
      <label class="field-label" for="username">管理员用户名</label>
      <input id="username" class="input" value="{{username}}" maxlength="64" placeholder="请输入管理员用户名" bindinput="onUsernameInput" />
    </view>
    <view class="field">
      <label class="field-label" for="temporary-password">新临时密码</label>
      <input id="temporary-password" class="input" value="{{temporaryPassword}}" password="true" maxlength="64" placeholder="8-64 位，至少包含字母和数字" bindinput="onTemporaryPasswordInput" />
    </view>
    <view class="field">
      <label class="field-label" for="confirm-password">确认临时密码</label>
      <input id="confirm-password" class="input" value="{{confirmPassword}}" password="true" maxlength="64" placeholder="请再次输入临时密码" bindinput="onConfirmPasswordInput" />
    </view>
    <view class="field">
      <label class="field-label" for="recovery-code">一次性恢复码</label>
      <input id="recovery-code" class="input recovery-input" value="{{recoveryCode}}" password="true" maxlength="128" placeholder="请从离线密码管理器输入" bindinput="onRecoveryCodeInput" confirm-type="done" bindconfirm="submit" />
      <text class="hint">请勿截图、复制到聊天或保存在设备中</text>
    </view>
    <button class="primary-button submit" loading="{{submitting}}" disabled="{{submitting}}" bindtap="submit">恢复并设置正式密码</button>
  </view>
</view>
```

- [ ] **Step 6: Create the page stylesheet**

Create `miniprogram/pages/admin-recovery/index.wxss`:

```css
.recovery-page {
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.recovery-card {
  width: 100%;
  max-width: 680rpx;
  margin: 0;
  padding: 44rpx 36rpx;
}

.intro {
  display: block;
  margin: 16rpx 0 36rpx;
  line-height: 1.6;
}

.error {
  margin-bottom: 28rpx;
  padding: 20rpx;
  border: 1rpx solid #fecaca;
  border-radius: 12rpx;
  background: #fef2f2;
  color: #b91c1c;
  line-height: 1.5;
}

.hint {
  display: block;
  margin-top: 10rpx;
  color: #6b7280;
  font-size: 24rpx;
  line-height: 1.5;
}

.recovery-input { font-family: monospace; }
.submit { margin-top: 36rpx; }
```

- [ ] **Step 7: Run focused and complete client verification**

Run:

```powershell
node --test --test-name-pattern="super-administrator recovery" miniprogram/test/account-flow.test.js
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
node --check miniprogram/pages/admin-recovery/index.js
```

Expected: all commands PASS with zero failures; recovery is called exactly once in the double-submit and post-recovery-login-failure tests.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- miniprogram/pages/admin-recovery/index.js miniprogram/pages/admin-recovery/index.json miniprogram/pages/admin-recovery/index.wxml miniprogram/pages/admin-recovery/index.wxss miniprogram/test/account-flow.test.js
git diff --cached --check
git commit -m "feat: add secure super-admin recovery flow"
```

Do not stage `docs/deployment/account-admin-setup.md`.

---

### Task 3: Repository verification and recovery handoff

**Files:**
- Modify: `docs/memory/STATUS.md`

**Interfaces:**
- Consumes: completed recovery entry and page from Tasks 1 and 2.
- Produces: exact verification evidence and the redacted CloudBase/WeChat DevTools acceptance sequence.

- [ ] **Step 1: Run syntax and focused sensitive-data scans**

Run:

```powershell
node --check miniprogram/services/account.js
node --check miniprogram/pages/login/index.js
node --check miniprogram/pages/admin-recovery/index.js
rg -n "getSession|setStorage|setStorageSync|console\.(log|info|debug|warn|error)" miniprogram/pages/admin-recovery
rg -n "data-(username|password|recovery|challenge|openid|user)" miniprogram/pages/admin-recovery/index.wxml
```

Expected: syntax checks exit 0. The scan may find neither forbidden controller calls nor sensitive WXML datasets; inspect any match rather than suppressing it.

- [ ] **Step 2: Run the complete repository verification suite**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: backend, client, WXML, diff, and project-memory checks all PASS. Any skipped or failed check remains explicitly unverified.

- [ ] **Step 3: Inspect scope and preserve the user-owned edit**

Run:

```powershell
git status --short
git diff --stat HEAD~2..HEAD
git diff -- docs/deployment/account-admin-setup.md
```

Confirm the recovery implementation touches only the file map above, and the existing `docs/deployment/account-admin-setup.md` edit remains unstaged and unchanged by this work.

- [ ] **Step 4: Update durable project status**

In `docs/memory/STATUS.md`, record:

- exact backend, client, WXML, syntax, diff, sensitive-boundary, and memory-validator results;
- that recovery implementation is locally verified only if every applicable command passed;
- that rotating the one-time recovery state and performing CloudBase/WeChat DevTools recovery remain manual and unverified;
- the next sequence: rotate both approved digest locations, clear only `recoveryConsumedAt`, recover through the Mini Program, force permanent-password change, verify redacted guard/credential/binding/audit outcomes, then finish persistent-logout restart acceptance.

Do not include any username, password, recovery code, digest, OpenID, record identifier, or raw database record.

- [ ] **Step 5: Revalidate and commit the handoff**

Run:

```powershell
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
git add -- docs/memory/STATUS.md
git diff --cached --check
git commit -m "docs: record super-admin recovery verification"
```

Expected: validation and staged diff checks PASS; the commit contains only `docs/memory/STATUS.md`.

- [ ] **Step 6: Manual WeChat DevTools and CloudBase acceptance**

After uploading the exact `businessApi` already in the branch and recompiling the Mini Program:

1. Use the offline helper to generate a new recovery code and digest; store the plaintext only in the approved password manager.
2. Update `ADMIN_RECOVERY_CODE_SHA256`, then the guard `recoveryCodeHash`, then set only `recoveryConsumedAt` to `null`.
3. Open `超级管理员紧急恢复`, enter values locally, and confirm forced password change opens.
4. Set a new permanent password and confirm dashboard entry.
5. Confirm, without copying raw records, that active-super-admin count is one, recovery is consumed, the credential is unlocked with `mustChangePassword=false`, the current WeChat binding exists, and recovery/password-change audit records exist.
6. Restart after password login and confirm ordinary automatic restoration resumes.

If recovery succeeds but automatic login does not, return to ordinary login and use the selected temporary password; do not rotate or submit recovery again unless that temporary password was lost.
