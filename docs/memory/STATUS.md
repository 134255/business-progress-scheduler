# Current Status

Status captured: 2026-08-07 (Asia/Shanghai)

## Verified state

- Local `main` was fast-forwarded from `22a78f3` to the accepted account-administration head `f39c89e`. The merged result passed the full backend, client, WXML, syntax, diff, and project-memory checks. It remains local and has not been pushed to `origin/main`.
- The safe Mini Program super-administrator recovery entry is implemented at `8e62b98` and `f38f26d` and manually accepted in WeChat DevTools. The operator rotated the one-time recovery state through the approved offline workflow, completed recovery and forced permanent-password change, entered the dashboard, and confirmed redacted guard, credential, binding, recovery-consumption, and audit outcomes. No secret or identity value was recorded.
- Persistent-logout manual acceptance is complete for the corrected flow: explicit logout remained on the password form, recompilation preserved the logged-out state, successful forced password completion cleared the manual-login preference, and the next recompilation restored the bound session automatically.
- Persistent explicit logout is implemented at `c4c5fea` and `b0e9cbf`. A focused utility persists only a boolean manual-login requirement, `app.js` exposes it through the authentication owner, profile logout sets it before clearing memory, the login page still checks initialization but suppresses binding-based restoration while it is active, and successful password authentication clears it. No backend or database interface changed.
- Manual CloudBase acceptance completed the guarded first-super-administrator initialization, forced first-login password change, dashboard entry, and redacted post-initialization checks. The singleton guard reports one active super administrator with consumed recovery state; the user, credential, binding, and initialization/password-change audit outcomes were confirmed without recording sensitive values.
- Manual acceptance originally exposed a persistent-logout defect in which profile logout cleared only in-memory state and `getSession` immediately restored the permanently bound account. The corrected boolean-preference flow and its restart behavior have now passed manual re-acceptance.
- Feature branch `codex/account-admin` implements the locally verifiable account-administration milestone through Task 7, including reviewed UI fixes at `cdf2977` and the reviewed deployment/runbook closeout at `7feac41`.
- The guarded first-super-administrator Mini Program flow is implemented through `a1db212`, `62b8cdf`, and `9b8b034`: the account service exposes initialization, the login page gates the entry, and the dedicated page rechecks server state, submits credentials from the trusted Mini Program runtime, clears sensitive fields, and hands successful initialization to forced password change.
- CloudBase fixed-document reads now normalize only explicit missing-document failures to `null` through `0f16140` and the reviewed boundary correction at `5fc1957`; collection, permission, network, timeout, and other database failures still propagate. The test database now reproduces the real SDK behavior instead of returning a synthetic null record.
- Implemented: password hashing, account/password authentication, first-login password change, lockout, emergency initialization/recovery, super-administrator user lifecycle, last-active-admin protection, CloudBase repositories, protected routes, deterministic WeChat identity reservations, and audit-safe logging.
- Mini Program account flow now includes silent account service calls with preserved backend error codes, session restoration, initialization gating, memory-only first-login challenge handoff, forced and normal password change, app-owned auth reset, and a dashboard guard without legacy profile bootstrapping.
- The Mini Program now includes protected super-administrator user listing, creation, editing, status changes, password reset, unlock, WeChat unbind, last-active-administrator messaging, gated dashboard entry, and profile password/logout controls. Password values stay out of global state, storage, datasets, and navigation parameters.
- CloudBase account state uses a singleton `system_settings/account_admin_state` guard so all active-super-admin transitions contend on one document.
- WeChat identity uniqueness uses `wechat_bindings/<sha256(openid)>`; it does not rely on an unsupported sparse unique `users.openid` index.
- Credential mutations use monotonic `credentialVersion`; challenge invalidation uses strict monotonic `challengeEpoch`. Both fail closed on corrupt or overflowing state.
- `wx-server-sdk` is pinned and locked at `4.0.2`.
- Task 7 adds `docs/deployment/account-admin-setup.md` and README guidance for collection/index setup, guarded migration order, initial administrator setup, recovery rotation, and local verification. It documents the implemented `INVALID_RECOVERY_CODE` result for consumed or mismatched recovery state rather than the stale-plan `RECOVERY_CODE_USED` value. Formal-review round one adds an explicit post-index-removal rollback sequence and a password-manager-only recovery-hash workflow.

## Verification

Executed on 2026-08-07 after fast-forwarding local `main` to `f39c89e`:

| Command or boundary | Result |
|---|---|
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures; the two pre-existing malformed npm user-config warnings remain. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 55 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax, `git diff --check`, and project-memory validation | Passed on the merged `main` tree. |

Executed on 2026-08-07 for the super-administrator recovery page at `8e62b98` and `f38f26d`:

| Command or boundary | Result |
|---|---|
| Task 1 TDD RED | Two expected failures: the recovery service method and guarded login-page navigation did not exist. |
| Task 2 TDD RED | Seven expected failures: the recovery page and its security boundary did not exist; the pre-existing login-entry test remained green. |
| Focused recovery tests | Passed: 8 tests, 0 failures. |
| JavaScript syntax checks for the account service, login page, and recovery page | Passed: 3 files, 0 syntax errors. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures. npm also emitted two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 55 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| Recovery sensitive-boundary scan | Passed: exactly 3 masked inputs and 0 forbidden session, storage, log, or sensitive-dataset matches. |
| `git diff --check` and project-memory validation | Passed; line-ending warnings only. |
| Scope inspection | Recovery commits changed only the 10 planned Mini Program and test files; the pre-existing deployment-manual edit remains unstaged and untouched. |

Manual recovery acceptance on 2026-08-07:

| Check | Result |
|---|---|
| Offline recovery rotation | Operator-confirmed that a new recovery value was stored safely, both digest locations were updated in order, the consumed marker alone was reset, and the local helper/clipboard were cleared. No value was recorded. |
| Mini Program recovery and forced password change | Operator-confirmed that the guarded recovery form opened, handed off to forced password change, and entered the dashboard. |
| Redacted CloudBase state | Operator-confirmed active-super-admin count one, consumed recovery state, unlocked permanent credential, restored user/binding state, and both recovery and first-login audit outcomes. |
| Persistent-logout restart completion | Operator-confirmed that recompilation after successful password completion automatically restored the bound session and dashboard. |

Executed on 2026-08-07 for persistent logout at `c4c5fea` and `b0e9cbf`:

| Command or boundary | Result |
|---|---|
| Preference TDD RED | Failed as expected because the utility and application methods did not exist. |
| Account-page TDD RED | Four expected failures reproduced automatic restoration and the three missing page-side effects. |
| JavaScript syntax checks for the utility, app, profile, login, and password-change pages | Passed: 5 files, 0 syntax errors. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures. npm also emitted two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 47 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `git diff --check` and project-memory validation | Passed; line-ending warnings only. |
| Storage-boundary scan | Production synchronous storage calls exist only in `miniprogram/utils/manual-login.js`; the sole written value is boolean `true`. |

WeChat DevTools restart acceptance for the exact persistent-logout commits remains unverified.

Manual operator acceptance on 2026-08-07:

| Check | Result |
|---|---|
| Updated `businessApi` deployment and environment configuration | Operator-confirmed successful; the required environment variable remained effective. |
| Guarded initialization, forced password change, and dashboard entry | Operator-confirmed successful in WeChat DevTools. |
| Redacted guard, user, credential, binding, and audit outcomes | Operator-confirmed correct without recording sensitive values. |
| Historical pre-fix explicit profile logout | Failed as expected before the correction: the login page immediately restored the bound account. Root cause is recorded in the persistent-logout design. |
| Corrected explicit logout and restart sequence | Operator-confirmed passed: logout and recompilation stayed on login; successful password completion then restored ordinary automatic login on the next recompilation. |

Executed on 2026-08-07 for the CloudBase missing-document fix at `0f16140` and reviewed boundary correction at `5fc1957`:

| Command | Result |
|---|---|
| Focused regression test before the production fix | RED as expected: 1 failure with the explicit CloudBase missing-document error. |
| Focused regression test after the production fix | GREEN: 1 test, 0 failures; a non-missing permission failure remained visible. |
| Collection-error boundary RED/GREEN | RED reproduced an incorrectly swallowed collection error; GREEN preserved collection, permission, network, and timeout failures while supporting structured and text-form document-not-found results. |
| Repository and account-route tests | Passed: 44 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 43 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax, `git diff --check`, and project-memory validation | Passed. |
| Independent review after boundary correction | Passed: no remaining Critical or Important findings. |

Uploading the updated `businessApi`, recompiling the Mini Program, and confirming the initialization entry in the real CloudBase environment remain unverified.

Executed on 2026-08-07 for the guarded initialization-page implementation at `9b8b034` plus the documentation closeout working tree:

| Command | Result |
|---|---|
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 43 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the account service, login page, and initialization page | Passed. |
| `git diff --check` | Passed (line-ending warnings only). |
| Sensitive-fixture scan outside tests and the implementation plan | Passed: no matches. |
| Project-memory validator | Passed. |
| Independent implementation and staged-candidate review | Passed after date correction: no remaining Critical or Important findings. |

CloudBase initialization, automatic-login handoff, forced password change, and redacted post-initialization database checks remain unverified manual acceptance items.

Executed on 2026-08-06 for commit `db8dbf3`:

| Command | Result |
|---|---|
| `npm.cmd ci --ignore-scripts` | Passed; installed the locked 4.0.2 SDK tree. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks | Passed. |
| `git diff --check` | Passed. |
| Independent formal review | READY; no remaining Critical, Important, or Minor code findings. |

Executed on 2026-08-06 for Task 7 completed at `7feac41`:

| Command | Result |
|---|---|
| `npm.cmd ci --ignore-scripts --prefix cloudfunctions/businessApi` | Unverified: local npm cache/filesystem returned `EPERM`; no dependency or source change was made. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 30 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `git diff --check` | Passed (line-ending warnings only). |

Cloud deployment, database migration, index creation, recovery configuration, and WeChat DevTools operator acceptance remain unverified until executed against the exact commit in the target environment.

Formal-review round one for Task 7 reran `git diff --check` and the project-memory validator after documentation-only corrections; both passed. Source and client test suites were not rerun because the review changed neither code nor verification commands.

Executed on 2026-08-06 in the Task 5 worktree based on `9ed0422`:

| Command | Result |
|---|---|
| `node --test miniprogram/test/account-flow.test.js` | Passed: 14 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| JavaScript syntax checks for changed client files | Passed. |

Executed on 2026-08-06 in the Task 6 worktree based on `d1482c8`:

| Command | Result |
|---|---|
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 26 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| JavaScript syntax checks for the Task 6 service, pages, and focused test | Passed. |
| `git diff --check` | Passed. |

Executed on 2026-08-06 for Task 6 formal-review fix round one based on `345a972`:

| Command | Result |
|---|---|
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 30 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| JavaScript syntax checks for the changed administrator pages and focused test | Passed. |
| `git diff --check` | Passed. |

## Blockers

- Cleanup of the linked `codex/account-admin` worktree and branch is deferred because that worktree still contains a pre-existing, unstaged user edit in `docs/deployment/account-admin-setup.md`. It must not be removed or overwritten without an explicit preservation decision.
- `npm audit` reports six transitive findings (one moderate, five high) through the official `wx-server-sdk@4.0.2` dependency tree. npm proposes a major downgrade to 2.5.3; it was not applied because it would invalidate the reviewed transaction behavior. Track the upstream SDK and reassess on a reviewed release.
- Task 5 simulator acceptance in WeChat DevTools is unverified.
- Task 6 WeChat DevTools compilation, navigation, rendering, and ordinary-user manual-route smoke acceptance are unverified.
- Enterprise WeChat production identifiers and secret remain intentionally unavailable; strong-message delivery is deferred.

## Next actions

1. Decide whether to preserve the linked-worktree deployment-manual edit by moving it to `main`, committing it separately, or keeping the worktree; only then clean up the worktree and feature branch.
2. Push local `main` to `origin/main` when remote publication is approved.
3. Run the remaining Task 5 and Task 6 WeChat DevTools page/navigation smoke acceptance if it is required before release.
4. Continue the approved templates, SLA/calendar, evidence/video, reminder, and Enterprise WeChat adapter phases.
