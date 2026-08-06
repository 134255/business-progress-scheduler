# Account and Super Administrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build controlled account/password login, WeChat OpenID binding, super-administrator recovery, and administrator-managed user lifecycle without allowing self-registration.

**Architecture:** Keep `businessApi` as the deployed interactive cloud-function entry while moving password, authentication, recovery, and user-administration rules into focused CommonJS modules with dependency injection. Use CloudBase collections as repositories, trusted `OPENID` as the WeChat binding input, and internal user `_id` as the stable account identifier; scheduled and business-identity migrations remain separate later phases.

**Tech Stack:** Native WeChat Mini Program (WXML/WXSS/JavaScript), CloudBase, Node.js CommonJS, built-in `node:crypto`, `wx-server-sdk`, and `node:test`.

## Global Constraints

- Do not allow public self-registration; only a super administrator creates ordinary accounts.
- A username is globally unique after trimming and lower-casing.
- First login uses a temporary password, requires a new password, and only then binds the trusted current OpenID.
- One account binds at most one OpenID and one OpenID binds at most one account.
- After binding, subsequent launches use OpenID auto-login unless the account is disabled, locked, or requires a password change.
- Lock an account for 30 minutes after 5 consecutive password failures.
- Never delete, disable, or demote the last active super administrator.
- Store only salted password hashes; never log or return passwords, hashes, salts, recovery codes, AppSecret, enterprise-WeChat Secret, or access tokens.
- The normal administrator UI and the one-time developer-tool recovery route must both write audit records.
- Emergency recovery uses `ADMIN_RECOVERY_CODE_SHA256` from cloud-function environment configuration; a successful code hash is recorded as consumed and cannot be reused until the environment value is rotated.
- Keep existing business relationships on OpenID during this phase for compatibility; Phase 2 migrates business/member/assignee references to stable user `_id` values before templates assign unbound accounts.
- Preserve all pre-existing workspace changes. Every commit stages explicit file paths and verifies `git diff --cached --name-only` before committing.
- Use test-driven development: add a failing test, run it, implement the smallest behavior, and rerun the focused and complete suites.
- Password policy for V1: 8–64 characters with at least one ASCII letter and one digit; leading and trailing spaces are part of the password and are not trimmed.

---

## File and Module Map

### Cloud function

- `cloudfunctions/businessApi/lib/password.js`: password policy, scrypt hashing, verification, and constant-time digest comparison.
- `cloudfunctions/businessApi/lib/auth-service.js`: session lookup, login challenge, first password change, OpenID binding, normal password change, first-super-admin initialization, and emergency recovery.
- `cloudfunctions/businessApi/lib/admin-user-service.js`: list/create/update/disable/unlock/reset/unbind users and protect the final active super administrator.
- `cloudfunctions/businessApi/lib/cloud-account-repository.js`: CloudBase access for `users`, `user_credentials`, `auth_challenges`, `system_settings`, and `audit_logs`.
- `cloudfunctions/businessApi/index.js`: route wiring, public-route allow-list, authenticated actor guard, and compatibility handoff to existing business handlers.
- `cloudfunctions/businessApi/test/password.test.js`: password primitive tests.
- `cloudfunctions/businessApi/test/auth-service.test.js`: login, challenge, binding, lockout, initialization, and recovery tests.
- `cloudfunctions/businessApi/test/admin-user-service.test.js`: administrator permissions and user lifecycle tests.

### Mini program

- `miniprogram/services/account.js`: client wrappers for session, login, first-password completion, password change, and logout/reset of local state.
- `miniprogram/services/admin-users.js`: client wrappers for administrator user operations.
- `miniprogram/utils/cloud.js`: preserve backend error code and allow callers to suppress automatic toast where the page owns the error state.
- `miniprogram/app.js`: global current-user state and auth-state reset helper.
- `miniprogram/app.json`: register login, forced-password-change, and administrator pages.
- `miniprogram/pages/login/index.{js,json,wxml,wxss}`: session probe and username/password login.
- `miniprogram/pages/change-password/index.{js,json,wxml,wxss}`: complete temporary-password challenge or change an authenticated password.
- `miniprogram/pages/admin-users/index.{js,json,wxml,wxss}`: searchable/paginated user list and lifecycle actions.
- `miniprogram/pages/admin-user-edit/index.{js,json,wxml,wxss}`: create/edit role, display name, username, temporary password, and status.
- `miniprogram/pages/dashboard/index.{js,wxml,wxss}`: require an authenticated session and expose the management center to super administrators only.
- `miniprogram/pages/profile/index.{js,wxml,wxss}`: show username/role and provide change-password/logout actions.

### Operations and documentation

- `docs/deployment/account-admin-setup.md`: required collections, indexes, environment variable hash generation, first initialization, recovery rotation, and manual acceptance steps.
- `README.md`: replace auto-provisioning instructions with controlled account setup and test commands.

---

### Task 0: Preserve the Verified Existing Baseline

**Files:**
- Verify current tracked and untracked workspace files shown by `git status --short`.
- Commit only the already-existing implementation changes; do not include this plan or later account implementation in the baseline commit.

**Interfaces:**
- Consumes: current working tree and existing `businessApi` tests.
- Produces: a clean, reproducible baseline commit containing the already-tested CloudBase integration, profile page, bootstrap duplicate-key fix, WXML structure test, and current scheduling deliverable.

- [ ] **Step 1: Record the exact existing change set**

Run:

```powershell
git status --short
git diff -- README.md cloudfunctions miniprogram project.config.json tools/build_schedule.mjs
```

Expected: changes match the already-demonstrated business CRUD/profile/bootstrap work; no password, token, Secret, recovery code, or unrelated personal file appears.

- [ ] **Step 2: Run the existing automated baseline tests**

Run:

```powershell
node --test cloudfunctions/businessApi/test/*.test.js
node tools/test-wxml-structure.mjs
```

Expected: all Node tests pass and the WXML checker exits with code 0.

- [ ] **Step 3: Check patch formatting**

Run:

```powershell
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 4: Stage the existing baseline with explicit paths**

Run:

```powershell
git add -- README.md cloudfunctions/businessApi miniprogram project.config.json tools/build_schedule.mjs tools/test-wxml-structure.mjs outputs/019fc5c9/业务进度管理微信小程序开发排期.xlsx
git diff --cached --name-only
```

Expected: only the known pre-account baseline files are staged. If the displayed output contains a secret-bearing file or an unrelated file, unstage that exact path before continuing.

- [ ] **Step 5: Commit the verified baseline**

Run:

```powershell
git commit -m "feat: complete initial cloud integration"
```

Expected: one baseline commit; `git status --short` no longer shows those files as modified.

---

### Task 1: Password Hashing and Policy

**Files:**
- Create: `cloudfunctions/businessApi/lib/password.js`
- Create: `cloudfunctions/businessApi/test/password.test.js`

**Interfaces:**
- Consumes: Node built-in `crypto` only.
- Produces: `assertPasswordPolicy(password)`, `hashPassword(password, options?)`, and `verifyPassword(password, record)`.
- `hashPassword` returns `{ algorithm: 'scrypt', salt, hash, keyLength: 64 }`, with `salt` and `hash` Base64 encoded.

- [ ] **Step 1: Write failing password tests**

Create `cloudfunctions/businessApi/test/password.test.js` with these assertions:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { assertPasswordPolicy, hashPassword, verifyPassword } = require('../lib/password')

test('hashes a valid password without storing plaintext and verifies it', () => {
  const record = hashPassword('Account9', { salt: Buffer.alloc(16, 7) })
  assert.equal(record.algorithm, 'scrypt')
  assert.notEqual(record.hash, 'Account9')
  assert.equal(verifyPassword('Account9', record), true)
  assert.equal(verifyPassword('Wrong999', record), false)
})

test('requires 8-64 characters with an ASCII letter and digit', () => {
  assert.throws(() => assertPasswordPolicy('short1'), error => error.code === 'WEAK_PASSWORD')
  assert.throws(() => assertPasswordPolicy('onlyletters'), error => error.code === 'WEAK_PASSWORD')
  assert.throws(() => assertPasswordPolicy('12345678'), error => error.code === 'WEAK_PASSWORD')
  assert.doesNotThrow(() => assertPasswordPolicy('ValidPass8'))
})
```

- [ ] **Step 2: Verify the tests fail**

Run:

```powershell
node --test cloudfunctions/businessApi/test/password.test.js
```

Expected: FAIL because `../lib/password` does not exist.

- [ ] **Step 3: Implement the password primitive**

Create `cloudfunctions/businessApi/lib/password.js` using this contract:

```js
const crypto = require('node:crypto')

function createError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw createError('WEAK_PASSWORD', '密码需为8-64位，且至少包含一个字母和一个数字')
  }
}

function hashPassword(password, options = {}) {
  assertPasswordPolicy(password)
  const saltBuffer = options.salt || crypto.randomBytes(16)
  const keyLength = 64
  const hashBuffer = crypto.scryptSync(password, saltBuffer, keyLength)
  return {
    algorithm: 'scrypt',
    salt: saltBuffer.toString('base64'),
    hash: hashBuffer.toString('base64'),
    keyLength
  }
}

function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'scrypt') return false
  const actual = crypto.scryptSync(password, Buffer.from(record.salt, 'base64'), Number(record.keyLength || 64))
  const expected = Buffer.from(record.hash, 'base64')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

module.exports = { assertPasswordPolicy, hashPassword, verifyPassword }
```

- [ ] **Step 4: Run focused and complete cloud tests**

Run:

```powershell
node --test cloudfunctions/businessApi/test/password.test.js
node --test cloudfunctions/businessApi/test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit password primitives**

Run:

```powershell
git add -- cloudfunctions/businessApi/lib/password.js cloudfunctions/businessApi/test/password.test.js
git diff --cached --check
git commit -m "feat: add secure account password hashing"
```

---

### Task 2: Authentication, First Login, Binding, and Lockout

**Files:**
- Create: `cloudfunctions/businessApi/lib/auth-service.js`
- Create: `cloudfunctions/businessApi/test/auth-service.test.js`
- Create: `cloudfunctions/businessApi/test/helpers/auth-harness.js`

**Interfaces:**
- Consumes repository methods `findUserByOpenid`, `findUserByUsername`, `findCredential`, `updateCredential`, `createChallenge`, `consumeChallenge`, `bindOpenid`, `countActiveSuperAdmins`, `createInitialSuperAdmin`, `getRecoveryState`, `consumeRecoveryCode`, and `writeAudit`.
- Consumes password methods from Task 1 and injected `clock()`, `randomToken()`, `sha256(value)`, and `recoveryCodeHash`.
- Produces `createAuthService(dependencies)` with methods:
  - `getSession({ openid })`
  - `login({ openid, username, password })`
  - `completeFirstLogin({ openid, challengeToken, newPassword })`
  - `changePassword({ actor, currentPassword, newPassword })`
  - `initializeSuperAdmin({ openid, username, displayName, temporaryPassword, recoveryCode })`
  - `recoverSuperAdmin({ username, temporaryPassword, recoveryCode })`

- [ ] **Step 1: Write failing authentication tests**

Create `cloudfunctions/businessApi/test/auth-service.test.js` with independent in-memory repositories and these named cases:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAuthHarness } = require('./helpers/auth-harness')

test('unknown OpenID is unauthenticated and is not auto-created', async () => {
  const harness = createAuthHarness()
  const result = await harness.service.getSession({ openid: 'wx-new' })
  assert.deepEqual(result, { authenticated: false, requiresInitialization: true })
  assert.equal(harness.state.users.length, 0)
})

test('temporary-password login returns a ten-minute challenge and does not bind early', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: true })
  const result = await harness.service.login({ openid: 'wx-1', username: 'USER01', password: 'TempPass8' })
  assert.equal(result.passwordChangeRequired, true)
  assert.equal(typeof result.challengeToken, 'string')
  assert.equal(harness.state.users[0].openid, '')
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
})

test('five bad passwords lock the account for thirty minutes', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: false })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(harness.service.login({ openid: 'wx-1', username: 'user01', password: 'Wrong999' }))
  }
  await assert.rejects(
    harness.service.login({ openid: 'wx-1', username: 'user01', password: 'TempPass8' }),
    error => error.code === 'ACCOUNT_LOCKED'
  )
})

test('an account already bound to another OpenID cannot be rebound by login', async () => {
  const harness = createAuthHarness()
  harness.seedAccount({ username: 'user01', password: 'TempPass8', mustChangePassword: false, openid: 'wx-old' })
  await assert.rejects(
    harness.service.login({ openid: 'wx-new', username: 'user01', password: 'TempPass8' }),
    error => error.code === 'WECHAT_ALREADY_BOUND'
  )
})
```

`test/helpers/auth-harness.js` must export `createAuthHarness()`. The returned object has `{ service, state, seedAccount }`; `state` contains arrays named `users`, `credentials`, `challenges`, `recoveryStates`, and `audit`, while `seedAccount({ username, password, mustChangePassword, openid, role, status })` creates one user and one matching credential through Task 1's `hashPassword`.

The file must also test disabled accounts, expired challenges, a challenge used from a different OpenID, successful normal password change, first-super-admin initialization, reused recovery-code rejection, and emergency recovery clearing the old OpenID.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/auth-service.test.js
```

Expected: FAIL because `createAuthService` does not exist.

- [ ] **Step 3: Implement authentication service**

Implement these exact state rules in `lib/auth-service.js`:

```js
const MAX_FAILURES = 5
const LOCK_MS = 30 * 60 * 1000
const CHALLENGE_MS = 10 * 60 * 1000

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase()
}

function publicUser(user, credential) {
  return {
    _id: user._id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    avatarUrl: user.avatarUrl || '',
    openidBound: Boolean(user.openid),
    wecomUserIdBound: Boolean(user.wecomUserId),
    mustChangePassword: Boolean(credential && credential.mustChangePassword)
  }
}
```

Behavior requirements:

1. `getSession` returns no user when OpenID is unknown; it never creates one.
2. `getSession` returns `requiresInitialization: true` only when no active super administrator exists.
3. Disabled users receive `ACCOUNT_DISABLED`; locked users receive `ACCOUNT_LOCKED`; `mustChangePassword` users are not granted a normal session.
4. Bad password increments `failedAttempts`; the fifth sets `lockedUntil = clock() + LOCK_MS`.
5. Correct password resets failure fields.
6. Temporary-password login stores only `sha256(challengeToken)`, expires after 10 minutes, and does not bind OpenID.
7. `completeFirstLogin` atomically consumes the challenge, replaces the credential hash, clears `mustChangePassword`, and binds OpenID after enforcing both one-to-one constraints.
8. Initialization is allowed only when active-super-admin count is zero and the recovery code hash matches the environment hash and has not been consumed.
9. Recovery activates the target account, promotes it to `super_admin`, resets to the supplied temporary password, clears lock fields and old OpenID, sets `mustChangePassword`, and consumes the recovery code hash.
10. Audit snapshots contain usernames, role/status transitions, and result codes but never passwords, credential records, raw challenge tokens, or raw recovery codes.
11. A valid permanent password binds an unbound account immediately; a valid already-bound account authenticates only when the trusted OpenID matches.
12. A bound account whose credential has `mustChangePassword: true` returns an unauthenticated password-change-required session until the temporary-password challenge is completed.

- [ ] **Step 4: Run focused and complete tests**

Run:

```powershell
node --test cloudfunctions/businessApi/test/auth-service.test.js
node --test cloudfunctions/businessApi/test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit authentication behavior**

Run:

```powershell
git add -- cloudfunctions/businessApi/lib/auth-service.js cloudfunctions/businessApi/test/auth-service.test.js cloudfunctions/businessApi/test/helpers/auth-harness.js
git diff --cached --check
git commit -m "feat: add controlled account authentication"
```

---

### Task 3: Administrator User Lifecycle and Last-Admin Protection

**Files:**
- Create: `cloudfunctions/businessApi/lib/admin-user-service.js`
- Create: `cloudfunctions/businessApi/test/admin-user-service.test.js`
- Create: `cloudfunctions/businessApi/test/helpers/admin-user-harness.js`

**Interfaces:**
- Consumes repository user/credential list, create, update, count, uniqueness, and audit methods plus `hashPassword` and `clock`.
- Produces `createAdminUserService(dependencies)` with methods `listUsers`, `createUser`, `updateUser`, `resetUserPassword`, `unlockUser`, and `unbindWechat`.

- [ ] **Step 1: Write failing administrator tests**

Create tests covering these exact cases:

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdminUserHarness } = require('./helpers/admin-user-harness')

test('ordinary users cannot list or modify accounts', async () => {
  const harness = createAdminUserHarness()
  await assert.rejects(harness.service.listUsers({ actor: { role: 'user' }, query: {} }), error => error.code === 'FORBIDDEN')
})

test('administrator creates an active account with normalized unique username and temporary password', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  const created = await harness.service.createUser({
    actor: admin,
    input: { username: ' Staff01 ', displayName: '业务人员', temporaryPassword: 'TempPass8', role: 'user' }
  })
  assert.equal(created.username, 'Staff01')
  assert.equal(harness.state.users.find(item => item._id === created._id).usernameNormalized, 'staff01')
  assert.equal(harness.state.credentials.find(item => item.userId === created._id).mustChangePassword, true)
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
})

test('password reset issues a temporary password state without logging the password', async () => {
  const harness = createAdminUserHarness()
  const admin = harness.seedAdmin('admin-1')
  harness.seedUser('user-1')
  await harness.service.resetUserPassword({ actor: admin, userId: 'user-1', temporaryPassword: 'ResetPass8' })
  assert.equal(harness.state.credentials.find(item => item.userId === 'user-1').mustChangePassword, true)
  assert.equal(JSON.stringify(harness.state.audit).includes('ResetPass8'), false)
})
```

`test/helpers/admin-user-harness.js` must export `createAdminUserHarness()`. It returns `{ service, state, seedAdmin, seedUser }`; `seedAdmin(id)` and `seedUser(id)` add matching user and credential records and return the public user actor.

Also test username conflict, user unlock, OpenID unbind, promoting another administrator before demoting the current one, pagination, status filter, and keyword filter.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/admin-user-service.test.js
```

Expected: FAIL because `createAdminUserService` does not exist.

- [ ] **Step 3: Implement the service**

Use this allow-list for mutations:

```js
const ALLOWED_ROLES = new Set(['user', 'super_admin'])
const ALLOWED_STATUSES = new Set(['active', 'disabled'])

function requireSuperAdmin(actor) {
  if (!actor || actor.role !== 'super_admin' || actor.status !== 'active') {
    const error = new Error('仅超级管理员可以执行该操作')
    error.code = 'FORBIDDEN'
    throw error
  }
}
```

Implementation rules:

- `createUser` trims the display username, stores `usernameNormalized`, creates a separate credential document, sets `mustChangePassword: true`, and leaves `openid` empty.
- `updateUser` accepts only `displayName`, `role`, and `status`; username is immutable after creation in V1.
- Before disabling or demoting an active super administrator, count other active super administrators and reject with `LAST_SUPER_ADMIN` if zero.
- `resetUserPassword` hashes the supplied temporary password, clears lock fields, sets `mustChangePassword`, and invalidates unused auth challenges for the user.
- `unlockUser` clears `failedAttempts` and `lockedUntil` without changing the password.
- `unbindWechat` clears OpenID only after confirming the target account exists; later business-reference migration is outside this phase.
- Every successful mutation writes one audit record without credential material.

- [ ] **Step 4: Run focused and complete tests**

Run:

```powershell
node --test cloudfunctions/businessApi/test/admin-user-service.test.js
node --test cloudfunctions/businessApi/test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit administrator rules**

Run:

```powershell
git add -- cloudfunctions/businessApi/lib/admin-user-service.js cloudfunctions/businessApi/test/admin-user-service.test.js cloudfunctions/businessApi/test/helpers/admin-user-harness.js
git diff --cached --check
git commit -m "feat: add administrator user lifecycle"
```

---

### Task 4: CloudBase Repositories, Routes, and Auth Guard

**Files:**
- Create: `cloudfunctions/businessApi/lib/cloud-account-repository.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/package.json`
- Test: `cloudfunctions/businessApi/test/*.test.js`

**Interfaces:**
- Consumes Task 2 and Task 3 service factories.
- Produces cloud actions `getSession`, `login`, `completeFirstLogin`, `changePassword`, `initializeSuperAdmin`, `recoverSuperAdmin`, `listUsers`, `createUser`, `updateUser`, `resetUserPassword`, `unlockUser`, and `unbindWechat`.
- Existing business actions receive the authenticated user's bound OpenID for this phase, preserving existing records.

- [ ] **Step 1: Add a failing route-policy unit test**

Add an exported pure helper to a new test target and test the allow-list:

```js
test('only session and credential-establishment actions are public', () => {
  assert.equal(isPublicAction('getSession'), true)
  assert.equal(isPublicAction('login'), true)
  assert.equal(isPublicAction('completeFirstLogin'), true)
  assert.equal(isPublicAction('initializeSuperAdmin'), true)
  assert.equal(isPublicAction('recoverSuperAdmin'), true)
  assert.equal(isPublicAction('dashboard'), false)
  assert.equal(isPublicAction('listUsers'), false)
})
```

Expected failure: helper is not implemented.

- [ ] **Step 2: Implement the CloudBase repository**

Create repositories over these collections:

```js
const COLLECTIONS = {
  users: 'users',
  credentials: 'user_credentials',
  challenges: 'auth_challenges',
  settings: 'system_settings',
  audit: 'audit_logs'
}
```

Repository writes must use `db.serverDate()` for audit timestamps and concrete `Date` values from injected `clock()` for comparisons such as `lockedUntil` and `expiresAt`. `consumeChallenge` and `consumeRecoveryCode` must use a condition that only updates an unused record once.

- [ ] **Step 3: Wire routes and guards in `index.js`**

Replace automatic `bootstrapUser` creation with account-session lookup. Keep `bootstrap` as a temporary alias of `getSession` only long enough for the client change in Task 5.

Use this route policy:

```js
const PUBLIC_ACTIONS = new Set([
  'getSession',
  'bootstrap',
  'login',
  'completeFirstLogin',
  'initializeSuperAdmin',
  'recoverSuperAdmin'
])

function isPublicAction(action) {
  return PUBLIC_ACTIONS.has(action)
}
```

For every non-public route:

1. Resolve the user by trusted `context.OPENID`.
2. Reject missing user with `UNAUTHORIZED`.
3. Reject disabled, locked, or `mustChangePassword` users.
4. Pass the resolved actor to account/admin routes.
5. Pass `actor.openid` to legacy business handlers during this phase.

Do not log the full event for login/recovery actions. Error logs may contain action, safe error code, request ID, and target user ID only.

- [ ] **Step 4: Run cloud tests**

Run:

```powershell
npm test --prefix cloudfunctions/businessApi
```

Expected: all tests pass without network access.

- [ ] **Step 5: Commit route integration**

Run:

```powershell
git add -- cloudfunctions/businessApi/index.js cloudfunctions/businessApi/package.json cloudfunctions/businessApi/lib/cloud-account-repository.js cloudfunctions/businessApi/test
git diff --cached --check
git commit -m "feat: enforce authenticated cloud routes"
```

---

### Task 5: Mini Program Login and Password-Change Flow

**Files:**
- Create: `miniprogram/services/account.js`
- Modify: `miniprogram/utils/cloud.js`
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/app.json`
- Create: `miniprogram/pages/login/index.js`
- Create: `miniprogram/pages/login/index.json`
- Create: `miniprogram/pages/login/index.wxml`
- Create: `miniprogram/pages/login/index.wxss`
- Create: `miniprogram/pages/change-password/index.js`
- Create: `miniprogram/pages/change-password/index.json`
- Create: `miniprogram/pages/change-password/index.wxml`
- Create: `miniprogram/pages/change-password/index.wxss`
- Modify: `miniprogram/pages/dashboard/index.js`

**Interfaces:**
- Consumes Task 4 cloud actions.
- Produces a guarded login experience and `getApp().globalData.currentUser` for existing pages.

- [ ] **Step 1: Add client service functions and preserve error codes**

Create `miniprogram/services/account.js`:

```js
const { callBusinessApi } = require('../utils/cloud')

function getSession() { return callBusinessApi('getSession', {}, { silent: true }) }
function login(username, password) { return callBusinessApi('login', { username, password }, { silent: true }) }
function completeFirstLogin(challengeToken, newPassword) {
  return callBusinessApi('completeFirstLogin', { challengeToken, newPassword }, { silent: true })
}
function changePassword(currentPassword, newPassword) {
  return callBusinessApi('changePassword', { currentPassword, newPassword }, { silent: true })
}

module.exports = { getSession, login, completeFirstLogin, changePassword }
```

Change `callBusinessApi(action, payload, options)` so the thrown error retains `result.code`, and automatic toast is skipped when `options.silent` is true:

```js
const error = new Error(result.message || '服务暂时不可用')
error.code = result.code || 'BUSINESS_ERROR'
throw error
```

- [ ] **Step 2: Build the login page**

The page state is:

```js
data: {
  checking: true,
  submitting: false,
  username: '',
  password: '',
  errorMessage: ''
}
```

On load, call `getSession()`:

- Authenticated: store user and `wx.reLaunch({ url: '/pages/dashboard/index' })`.
- `requiresInitialization`: show “系统尚未初始化，请由超级管理员在开发者工具中完成初始化”。
- Otherwise: show the username/password form.

On login:

- `passwordChangeRequired`: save only the returned challenge token in `getApp().globalData.loginChallenge`, clear the password field, and navigate to `/pages/change-password/index?mode=first`.
- Success: store public user and re-launch dashboard.
- Failure: display the backend message; do not store username/password locally.

The WXML password input must use `password="true"`, and both fields must be cleared on page unload.

- [ ] **Step 3: Build the forced-password-change page**

First-login mode shows new password and confirmation fields, verifies equality locally, calls `completeFirstLogin`, clears the global challenge, then re-launches dashboard. Normal mode also shows current password and calls `changePassword`.

Never write passwords to `storage`, `globalData`, logs, dataset attributes, or page navigation parameters.

- [ ] **Step 4: Make login the launch page and guard dashboard**

Place `pages/login/index` first in `app.json`, register both new pages, and update dashboard `onShow` to redirect to login when `globalData.currentUser` is absent. Remove the old parallel call that automatically bootstraps a new profile.

- [ ] **Step 5: Run structural and cloud tests**

Run:

```powershell
node tools/test-wxml-structure.mjs
npm test --prefix cloudfunctions/businessApi
```

Expected: all checks pass.

- [ ] **Step 6: Commit login UI**

Run:

```powershell
git add -- miniprogram/services/account.js miniprogram/utils/cloud.js miniprogram/app.js miniprogram/app.json miniprogram/pages/login miniprogram/pages/change-password miniprogram/pages/dashboard/index.js
git diff --cached --check
git commit -m "feat: add account login and password change"
```

---

### Task 6: Administrator User Management UI

**Files:**
- Create: `miniprogram/services/admin-users.js`
- Create: `miniprogram/pages/admin-users/index.js`
- Create: `miniprogram/pages/admin-users/index.json`
- Create: `miniprogram/pages/admin-users/index.wxml`
- Create: `miniprogram/pages/admin-users/index.wxss`
- Create: `miniprogram/pages/admin-user-edit/index.js`
- Create: `miniprogram/pages/admin-user-edit/index.json`
- Create: `miniprogram/pages/admin-user-edit/index.wxml`
- Create: `miniprogram/pages/admin-user-edit/index.wxss`
- Modify: `miniprogram/pages/dashboard/index.js`
- Modify: `miniprogram/pages/dashboard/index.wxml`
- Modify: `miniprogram/pages/dashboard/index.wxss`
- Modify: `miniprogram/pages/profile/index.js`
- Modify: `miniprogram/pages/profile/index.wxml`
- Modify: `miniprogram/pages/profile/index.wxss`
- Modify: `miniprogram/app.json`

**Interfaces:**
- Consumes Task 4 administrator actions and Task 5 session state.
- Produces super-admin-only user administration and profile password/logout actions.

- [ ] **Step 1: Implement administrator service wrappers**

Create wrappers with these signatures:

```js
function listUsers(query) { return callBusinessApi('listUsers', query) }
function createUser(input) { return callBusinessApi('createUser', input) }
function updateUser(userId, changes) { return callBusinessApi('updateUser', { userId, changes }) }
function resetUserPassword(userId, temporaryPassword) {
  return callBusinessApi('resetUserPassword', { userId, temporaryPassword })
}
function unlockUser(userId) { return callBusinessApi('unlockUser', { userId }) }
function unbindWechat(userId) { return callBusinessApi('unbindWechat', { userId }) }
```

- [ ] **Step 2: Build user list page**

Use page state:

```js
data: {
  loading: false,
  keyword: '',
  status: 'all',
  page: 1,
  pageSize: 20,
  total: 0,
  hasMore: false,
  items: []
}
```

Each row shows display name, username, role, enabled/disabled, WeChat-bound/unbound, and locked/unlocked. Actions are edit, reset temporary password, unlock, unbind WeChat, enable, and disable. Destructive or identity-changing actions use `wx.showModal` confirmation and refresh the row after success.

- [ ] **Step 3: Build create/edit page**

Create mode requires username, display name, role, and temporary password. Edit mode allows display name, role, and status but renders username read-only. Validate password policy locally for immediate feedback while relying on the server as authority.

When backend returns `LAST_SUPER_ADMIN`, show: “必须至少保留一个启用状态的超级管理员”。

- [ ] **Step 4: Add role-gated entry and profile controls**

Dashboard shows “用户管理” only when `profile.role === 'super_admin'`. Profile shows username, role label, “修改密码”, and “退出登录”. Logout clears `globalData.currentUser` and re-launches the login page; it does not unbind OpenID.

- [ ] **Step 5: Run structural checks and manual simulator smoke test**

Run:

```powershell
node tools/test-wxml-structure.mjs
npm test --prefix cloudfunctions/businessApi
```

In WeChat DevTools, compile all new pages and confirm an ordinary user cannot navigate to the administrator page even by manually entering its route; the backend must return `FORBIDDEN`.

- [ ] **Step 6: Commit administrator UI**

Run:

```powershell
git add -- miniprogram/services/admin-users.js miniprogram/pages/admin-users miniprogram/pages/admin-user-edit miniprogram/pages/dashboard miniprogram/pages/profile miniprogram/app.json
git diff --cached --check
git commit -m "feat: add super administrator user management"
```

---

### Task 7: Deployment Setup, Initial Administrator, and Recovery Runbook

**Files:**
- Create: `docs/deployment/account-admin-setup.md`
- Modify: `README.md`
- Verify: `cloudfunctions/businessApi/index.js`

**Interfaces:**
- Consumes Tasks 1–6.
- Produces repeatable CloudBase setup and emergency recovery instructions without storing secret values.

- [ ] **Step 1: Document required collections and indexes**

Document creation of:

```text
users
user_credentials
auth_challenges
system_settings
audit_logs
```

Document indexes:

```text
users.usernameNormalized          UNIQUE
users.openid                      UNIQUE, sparse/omit the field while unbound
user_credentials.userId          UNIQUE
auth_challenges.tokenHash         UNIQUE
auth_challenges.userId+expiresAt  COMPOUND
audit_logs.createdAt              DESCENDING
```

Before creating the username index, upgrade or explicitly quarantine any legacy `users` document that lacks a controlled username. Do not delete the existing test user without exporting or confirming it is disposable.

- [ ] **Step 2: Document recovery-hash generation**

Use a one-time code generated by a password manager, then calculate its SHA-256 locally without printing the original code into shell history or a committed file. The runbook records the environment variable name only:

```text
ADMIN_RECOVERY_CODE_SHA256
```

The cloud configuration receives the hexadecimal hash. The original code is entered only when invoking initialization/recovery and is discarded after success.

- [ ] **Step 3: Document first-super-admin initialization**

From the WeChat DevTools cloud-function test panel, invoke:

```json
{
  "action": "initializeSuperAdmin",
  "payload": {
    "username": "administrator01",
    "displayName": "系统管理员",
    "temporaryPassword": "ExamplePass8",
    "recoveryCode": "ExampleRecovery9"
  }
}
```

The displayed values are non-secret examples and must never be reused for a real environment. The operator enters locally chosen values without copying them into the repository. Expected result: one active `super_admin`, one credential with `mustChangePassword: true`, one consumed recovery-code hash, and one audit record.

- [ ] **Step 4: Document emergency recovery and rotation**

Recovery invocation:

```json
{
  "action": "recoverSuperAdmin",
  "payload": {
    "username": "administrator01",
    "temporaryPassword": "RecoveryPass8",
    "recoveryCode": "RotatedRecovery9"
  }
}
```

Expected result: account active and promoted, lock cleared, old OpenID unbound, password-change required, new code hash consumed, audit record written. Before any later recovery, rotate `ADMIN_RECOVERY_CODE_SHA256`; reusing the consumed hash must return `RECOVERY_CODE_USED`.

- [ ] **Step 5: Update README test and startup flow**

Replace instructions that say every OpenID is automatically initialized. State that the operator creates the first administrator, deploys the cloud function, creates indexes, logs in with the temporary password, changes it, and then creates ordinary users.

- [ ] **Step 6: Commit runbook**

Run:

```powershell
git add -- docs/deployment/account-admin-setup.md README.md
git diff --cached --check
git commit -m "docs: add account administration runbook"
```

---

### Task 8: Full Verification and Developer-Tool Acceptance

**Files:**
- Verify all files from Tasks 1–7.
- Update only if verification exposes a specific defect; defect fixes require a failing regression test first.

**Interfaces:**
- Consumes the complete first-stage implementation.
- Produces an independently deployable and accepted account/administrator subsystem.

- [ ] **Step 1: Run complete local verification**

Run:

```powershell
npm test --prefix cloudfunctions/businessApi
node tools/test-wxml-structure.mjs
git diff --check
git status --short
```

Expected: all tests/checks pass; no secret-bearing or accidental file is staged.

- [ ] **Step 2: Deploy the cloud function**

In WeChat DevTools, right-click `cloudfunctions/businessApi`, select “上传并部署：云端安装依赖”, and verify deployment succeeds in environment `cloud1-d5gxt99rh492670d9`.

- [ ] **Step 3: Complete first administrator flow**

Follow `docs/deployment/account-admin-setup.md` to configure the recovery hash, initialize the first administrator, log in, change the temporary password, and verify the current OpenID is bound.

Expected database state:

```text
users: one active super_admin with non-empty openid
user_credentials: one scrypt credential with mustChangePassword=false, failedAttempts=0, and no active lock
system_settings: current recovery hash marked consumed
audit_logs: initialization, password-change, and binding events present without secret material
```

- [ ] **Step 4: Exercise administrator user lifecycle**

Create two ordinary users and a second super administrator. Verify:

1. Duplicate username is rejected case-insensitively.
2. First login requires password change and binds the current WeChat identity.
3. Five failures lock the account; administrator unlock restores login.
4. Password reset requires another password change.
5. Unbind allows a different WeChat identity to bind after valid login.
6. An ordinary user cannot call user-management routes.
7. The last active super administrator cannot be disabled or demoted.

- [ ] **Step 5: Verify legacy business compatibility**

Using a bound account that already owns the existing test business, verify dashboard, list, detail, profile, and feedback still work. Record that the stored business references remain OpenID-based until the Phase 2 identity migration.

- [ ] **Step 6: Verify repository cleanliness and record evidence**

Run:

```powershell
git status --short --branch
git log --oneline -10
git diff --check
```

Expected: only intentional post-verification changes remain; no password, recovery code, credential hash dump, or cloud secret exists in tracked files.

- [ ] **Step 7: Commit any regression fix separately**

If verification required a tested fix, stage only the regression test and its implementation and use:

```powershell
git commit -m "fix: harden account administration flow"
```

If no fix was required, do not create an empty commit.
