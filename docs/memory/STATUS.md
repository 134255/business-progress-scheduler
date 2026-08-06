# Current Status

Status captured: 2026-08-06 (Asia/Shanghai)

## Verified state

- Git is on `main`, two commits ahead of `origin/main` before the memory initialization commit.
- The working tree already contains a large, pre-existing uncommitted baseline across the cloud function, Mini Program pages/services, project configuration, tests, tooling, README, and a generated schedule workbook. These changes belong to the user and must remain isolated from the memory-only commit.
- Current code implements WeChat-context bootstrap, profile update, dashboard/list/detail queries, business-line create/edit/logical-delete, node history/feedback, evidence metadata, sequential node activation, basic notifications, audit records, membership/manager checks, and optimistic business-line version checks.
- Current Mini Program routes include dashboard, business list/detail/edit, node feedback, a template-list UI stub, and profile pages.
- Project configuration currently points to the real AppID and CloudBase environment identifiers recorded in `PROJECT.md`.
- The global `maintaining-project-memory` skill is installed under the user Codex skills directory; its staged and installed files had matching SHA-256 hashes and the skill-creator validator reported `Skill is valid!`.

The current implementation is a baseline, not the approved V1. In particular, the account/password administrator subsystem, controlled template lifecycle, SLA calendar engine, hourly reminder scheduler, server-side evidence type/size/content validation, video flow, and Enterprise WeChat adapter are not implemented in the current code.

## Verification

Executed on 2026-08-06:

| Command | Result |
|---|---|
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 5 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `git diff --check` | Passed; only expected LF-to-CRLF working-copy warnings were printed. |
| Installed project-memory validator | Passed against the initialized repository structure. |
| Skill behavior pressure tests | Passed: startup-memory preflight, dirty-tree/unverified completion, and sensitive-data scenarios followed the installed rules. |
| Memory validator positive/negative fixtures | Passed: complete fixture accepted; credential/unfinished-marker fixture rejected with two errors. |

## Blockers

- No local blocker prevents the next account-administration implementation task.
- Deployment of the exact current dirty working tree, simulator acceptance, database indexes, and end-to-end CloudBase behavior are `unverified` in this task.
- Enterprise WeChat production identifiers and secret are intentionally unavailable; real strong-message delivery remains deferred.
- Holiday API production terms and availability require re-verification before production release.

## Next actions

1. Resume `docs/superpowers/plans/2026-08-05-account-admin.md` at Task 0: preserve, verify, explicitly stage, and commit the existing baseline without mixing the memory commit.
2. Execute Tasks 1–8 with test-driven development: password primitives, authentication/binding, administrator lifecycle, protected cloud routes, login UI, administrator UI, deployment runbook, and full acceptance.
3. After account administration, implement templates, SLA/calendar, evidence/video enforcement, scheduled reminders, and the disabled-by-default Enterprise WeChat adapter from the approved V1 design.
4. Deploy through WeChat DevTools and record simulator/database acceptance evidence for the exact commit tested.
