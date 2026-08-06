# Current Status

Status captured: 2026-08-06 (Asia/Shanghai)

## Verified state

- Feature branch `codex/account-admin` implements the reviewed backend account-administration milestone through Task 4 of `docs/superpowers/plans/2026-08-05-account-admin.md`.
- Implemented: password hashing, account/password authentication, first-login password change, lockout, emergency initialization/recovery, super-administrator user lifecycle, last-active-admin protection, CloudBase repositories, protected routes, deterministic WeChat identity reservations, and audit-safe logging.
- CloudBase account state uses a singleton `system_settings/account_admin_state` guard so all active-super-admin transitions contend on one document.
- WeChat identity uniqueness uses `wechat_bindings/<sha256(openid)>`; it does not rely on an unsupported sparse unique `users.openid` index.
- Credential mutations use monotonic `credentialVersion`; challenge invalidation uses strict monotonic `challengeEpoch`. Both fail closed on corrupt or overflowing state.
- `wx-server-sdk` is pinned and locked at `4.0.2`.

## Verification

Executed on 2026-08-06 for commit `db8dbf3`:

| Command | Result |
|---|---|
| `npm.cmd ci --ignore-scripts` | Passed; installed the locked 4.0.2 SDK tree. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks | Passed. |
| `git diff --check` | Passed. |
| Independent formal review | READY; no remaining Critical, Important, or Minor code findings. |

## Blockers

- `npm audit` reports six transitive findings (one moderate, five high) through the official `wx-server-sdk@4.0.2` dependency tree. npm proposes a major downgrade to 2.5.3; it was not applied because it would invalidate the reviewed transaction behavior. Track the upstream SDK and reassess on a reviewed release.
- Cloud deployment, creation/backfill of `wechat_bindings`, removal of the legacy `users.openid` unique index, real transaction-conflict behavior, and simulator acceptance are unverified.
- Client login/password-change UI and super-administrator account-management UI (Tasks 5 and 6) are not yet implemented.
- Enterprise WeChat production identifiers and secret remain intentionally unavailable; strong-message delivery is deferred.

## Next actions

1. Execute Task 5: Mini Program login, first-login password change, session state, and dashboard guard.
2. Execute Task 6: super-administrator user-management pages.
3. Execute Task 7: deployment/migration runbook, including binding backfill, guard initialization, recovery hash configuration, and dependency-risk note.
4. Run Task 8 manual WeChat DevTools deployment and simulator/database acceptance for the exact commit.
5. Continue the approved templates, SLA/calendar, evidence/video, reminder, and Enterprise WeChat adapter phases.
