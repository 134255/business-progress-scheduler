# Persistent Logout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an explicit profile logout persist across Mini Program restarts until a successful account/password login, without unbinding WeChat or storing identity or credential data.

**Architecture:** A focused `manual-login` utility owns one boolean storage key and a process-local tri-state override. `app.js` exposes the utility through authentication-state methods; profile, login, and first-password-change pages use only those application methods, keeping storage details outside page code and preserving the backend one-WeChat-to-one-account invariant.

**Tech Stack:** Native WeChat Mini Program JavaScript, synchronous WeChat storage API, Node.js built-in test runner, existing CloudBase account API.

## Global Constraints

- Persist only a boolean manual-login requirement; never persist usernames, passwords, OpenID values, challenge tokens, recovery material, user objects, or other identity data.
- Logout must not unbind WeChat. Switching accounts still requires a super administrator to unbind the current WeChat identity first.
- `getSession` must continue to run on login-page load so first-super-administrator initialization remains discoverable.
- Initialization-required state takes precedence over the manual-login preference.
- No backend route, database collection, CloudBase environment, or dependency change is allowed.
- Preserve the pre-existing user edit in `docs/deployment/account-admin-setup.md`; never stage it with this work.

## File map

- Create `miniprogram/utils/manual-login.js`: own the storage key and process-local override; expose three boolean-preference operations.
- Modify `miniprogram/app.js`: expose the preference operations alongside existing in-memory authentication reset.
- Modify `miniprogram/pages/profile/index.js`: set the manual-login requirement before clearing authentication and correct the confirmation copy.
- Modify `miniprogram/pages/login/index.js`: suppress automatic restoration when required and clear the requirement after password authentication.
- Modify `miniprogram/pages/change-password/index.js`: clear the requirement after successful first-login password completion.
- Modify `miniprogram/test/account-flow.test.js`: cover preference persistence, restart behavior, login suppression, and successful-login clearing.
- Modify `miniprogram/test/admin-users-flow.test.js`: cover confirmed/cancelled profile logout and the corrected binding copy.
- Modify `docs/memory/STATUS.md`: replace the active logout blocker with exact verification evidence and manual re-acceptance steps.

---

### Task 1: Non-sensitive manual-login preference

**Files:**
- Create: `miniprogram/utils/manual-login.js`
- Modify: `miniprogram/app.js`
- Test: `miniprogram/test/account-flow.test.js`

**Interfaces:**
- Produces: `requireManualLogin(): void`, `isManualLoginRequired(): boolean`, and `clearManualLoginRequirement(): void` from `miniprogram/utils/manual-login.js`.
- Produces: application methods with the same three signatures from `getApp()`.
- Storage value: exactly `true` under one internal versioned key; clearing removes that key.

- [ ] **Step 1: Write failing preference tests**

Add focused tests that install a fake synchronous storage implementation, reload the utility to simulate a new Mini Program process, and verify that only `true` is persisted:

```js
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
```

Add a second test proving process-local fail-safe behavior: a failed write still returns `true` in the current module instance, and a failed remove returns `false` in the current instance.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
node --test --test-name-pattern="manual-login preference" miniprogram/test/account-flow.test.js
```

Expected: FAIL because `miniprogram/utils/manual-login.js` does not exist.

- [ ] **Step 3: Implement the minimal preference utility**

Create `miniprogram/utils/manual-login.js`:

```js
const STORAGE_KEY = 'business-progress.manual-login-required.v1'

let sessionOverride = null

function requireManualLogin() {
  sessionOverride = true
  try {
    wx.setStorageSync(STORAGE_KEY, true)
  } catch (_error) {}
}

function isManualLoginRequired() {
  if (sessionOverride !== null) return sessionOverride
  try {
    return wx.getStorageSync(STORAGE_KEY) === true
  } catch (_error) {
    return false
  }
}

function clearManualLoginRequirement() {
  sessionOverride = false
  try {
    wx.removeStorageSync(STORAGE_KEY)
  } catch (_error) {}
}

module.exports = {
  requireManualLogin,
  isManualLoginRequired,
  clearManualLoginRequirement
}
```

- [ ] **Step 4: Expose the utility through the application authentication owner**

At the top of `miniprogram/app.js`, require the utility. Add these methods without changing `resetAuthState()` or CloudBase initialization:

```js
requireManualLogin() {
  manualLogin.requireManualLogin()
},

isManualLoginRequired() {
  return manualLogin.isManualLoginRequired()
},

clearManualLoginRequirement() {
  manualLogin.clearManualLoginRequirement()
},
```

Extend the existing application-state test to assert all three methods exist and delegate correctly using the fake storage map. The test must inspect stored values and assert every value is boolean `true` rather than inspecting or persisting any identity fixture.

- [ ] **Step 5: Run focused and complete client tests**

Run:

```powershell
node --test --test-name-pattern="manual-login preference|app owns" miniprogram/test/account-flow.test.js
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
```

Expected: both commands PASS with zero failures.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- miniprogram/utils/manual-login.js miniprogram/app.js miniprogram/test/account-flow.test.js
git diff --cached --check
git commit -m "feat: add persistent manual-login preference"
```

Do not stage `docs/deployment/account-admin-setup.md`.

---

### Task 2: Enforce explicit logout across account pages

**Files:**
- Modify: `miniprogram/pages/profile/index.js`
- Modify: `miniprogram/pages/login/index.js`
- Modify: `miniprogram/pages/change-password/index.js`
- Test: `miniprogram/test/account-flow.test.js`
- Test: `miniprogram/test/admin-users-flow.test.js`

**Interfaces:**
- Consumes: `getApp().requireManualLogin(): void` from Task 1.
- Consumes: `getApp().isManualLoginRequired(): boolean` from Task 1.
- Consumes: `getApp().clearManualLoginRequirement(): void` from Task 1.
- Preserves: existing `accountService.getSession`, `accountService.login`, and `accountService.completeFirstLogin` request and result shapes.

- [ ] **Step 1: Write failing login-flow tests**

Add a test proving a persisted manual-login requirement suppresses an otherwise authenticated session:

```js
test('login keeps the password form after explicit logout even when the binding is authenticated', async () => {
  const user = { _id: 'user-1', role: 'user' }
  const launches = []
  const app = {
    globalData: { currentUser: null, loginChallenge: null },
    isManualLoginRequired: () => true
  }
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
```

Extend the successful permanent-password login test with `clearManualLoginRequirement()` and assert it runs exactly once before dashboard navigation. Extend the first-login password-completion test with the same assertion. Keep the existing initialization-required test and add `isManualLoginRequired: () => true` to prove initialization still takes precedence.

- [ ] **Step 2: Write failing profile-logout tests**

Replace the existing profile logout expectation with an application fake that records call order:

```js
const events = []
const app = {
  globalData: { currentUser: user, loginChallenge: 'stale' },
  requireManualLogin() { events.push('require-manual-login') },
  resetAuthState() {
    events.push('reset-auth')
    this.globalData.currentUser = null
    this.globalData.loginChallenge = null
  }
}
```

Assert `events` is exactly `['require-manual-login', 'reset-auth']`, then assert relaunch to `/pages/login/index`. Capture the modal options and assert its content says password re-entry is required and account switching requires administrator unbinding.

Add a cancellation test where `showModal` returns `{ confirm: false }` and assert neither application method nor `wx.reLaunch` is called.

- [ ] **Step 3: Run account-page tests and confirm RED**

Run:

```powershell
node --test --test-name-pattern="explicit logout|profile.*logout|successful.*login|first-login password" miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
```

Expected: FAIL because pages do not yet consume the manual-login application methods and the old modal copy is still present.

- [ ] **Step 4: Implement login-page suppression and successful-login clearing**

In `miniprogram/pages/login/index.js`, obtain the app and manual-login state before applying the authenticated session result:

```js
const app = getApp()
const manualLoginRequired = typeof app.isManualLoginRequired === 'function' &&
  app.isManualLoginRequired()

if (session.requiresInitialization) {
  this.setData({
    requiresInitialization: true,
    errorMessage: INITIALIZATION_MESSAGE
  })
  return
}
if (session.authenticated && !manualLoginRequired) {
  app.globalData.currentUser = session.user
  wx.reLaunch({ url: '/pages/dashboard/index' })
  return
}
```

In the `result.authenticated` branch of `submit()`, clear the preference before setting the public user and relaunching:

```js
if (typeof app.clearManualLoginRequirement === 'function') {
  app.clearManualLoginRequirement()
}
app.globalData.currentUser = result.user
```

Do not clear the preference for invalid credentials or before a first-login challenge is completed.

- [ ] **Step 5: Implement profile logout and corrected copy**

In `miniprogram/pages/profile/index.js`, change the confirmation message to:

```text
退出后需重新输入账号密码。当前微信绑定不会解除；如需切换账号，请先由超级管理员解除微信绑定。
```

After confirmation and before `resetAuthState()`, call:

```js
if (typeof app.requireManualLogin === 'function') app.requireManualLogin()
```

Keep cancellation side-effect free and keep the existing relaunch target.

- [ ] **Step 6: Clear the preference after first-login password completion**

In `miniprogram/pages/change-password/index.js`, after a successful `completeFirstLogin` result and the existing challenge reset, call `app.clearManualLoginRequirement()` when available, then set `currentUser` and relaunch the dashboard. Normal in-session password changes may call the same idempotent clear method after success.

- [ ] **Step 7: Run focused and complete client verification**

Run:

```powershell
node --test --test-name-pattern="explicit logout|profile.*logout|successful.*login|first-login password" miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: all commands PASS with zero failures.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- miniprogram/pages/profile/index.js miniprogram/pages/login/index.js miniprogram/pages/change-password/index.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
git diff --cached --check
git commit -m "fix: keep explicit logout until password login"
```

Do not stage `docs/deployment/account-admin-setup.md`.

---

### Task 3: Full verification and durable handoff

**Files:**
- Modify: `docs/memory/STATUS.md`

**Interfaces:**
- Consumes: the completed client behavior and test evidence from Tasks 1 and 2.
- Produces: exact local verification results and the remaining WeChat DevTools acceptance sequence.

- [ ] **Step 1: Run JavaScript syntax checks**

Run:

```powershell
node --check miniprogram/utils/manual-login.js
node --check miniprogram/app.js
node --check miniprogram/pages/profile/index.js
node --check miniprogram/pages/login/index.js
node --check miniprogram/pages/change-password/index.js
```

Expected: every command exits with code 0 and no syntax error.

- [ ] **Step 2: Run the full repository verification suite**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: backend tests, client tests, WXML checks, diff checks, and project-memory validation all PASS. Any skipped or failed command must be recorded as unverified rather than complete.

- [ ] **Step 3: Inspect scope and sensitive-storage boundaries**

Run:

```powershell
git diff --stat HEAD~2..HEAD
git status --short
rg -n "setStorageSync|removeStorageSync|getStorageSync" miniprogram
```

Confirm only the manual-login utility invokes synchronous storage, only boolean `true` is written, no credential or identity value is passed, and `docs/deployment/account-admin-setup.md` remains an unstaged user change.

- [ ] **Step 4: Update project status with exact evidence**

In `docs/memory/STATUS.md`:

- move the persistent-logout implementation into verified state only if the commands above pass;
- remove the implementation blocker only if local tests pass;
- retain WeChat DevTools restart acceptance as unverified until the operator completes it;
- list the next manual sequence: logout, remain on login, restart and remain on login, password login, restart and confirm ordinary automatic restoration.

- [ ] **Step 5: Revalidate memory and commit the handoff**

Run:

```powershell
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
git add -- docs/memory/STATUS.md
git diff --cached --check
git commit -m "docs: record persistent logout verification"
```

Expected: validation and staged diff check PASS; the commit contains only `docs/memory/STATUS.md`.

- [ ] **Step 6: Manual WeChat DevTools acceptance**

After the commits are uploaded to the branch and the Mini Program is recompiled:

1. Open profile and confirm logout.
2. Confirm the normal login form remains visible.
3. Close and reopen the Mini Program; confirm it remains logged out.
4. Enter the currently bound account's username and password; confirm the dashboard opens.
5. Close and reopen again; confirm ordinary automatic restoration resumes.

Record the outcome without storing credentials, OpenID values, screenshots containing identity data, or raw database records.
