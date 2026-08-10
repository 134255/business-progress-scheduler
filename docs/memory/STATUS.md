# Current Status

Status captured: 2026-08-10 (Asia/Shanghai)

## Verified state

- Task 8-R is an explicitly approved follow-up after Task 8 exhausted its five formal-review fix rounds. The accepted design removes the remaining actor-facing recovery race by starting expired-reservation recovery atomically in the same transaction that reloads and authorizes the current actor, line, node, and winner. Actorless chunked rollback may only continue an already-`aborting` reservation; it may not initiate a user-request recovery or clear a node claim. The written design is pending user review before an implementation plan or production change.
- Task 8 of the template/node/field plan is implemented on its isolated worktree; formal-review round five fixes are locally verified but remain pending reviewer acceptance. Every actor-facing feedback reservation path transactionally revalidates the current active actor and account relationships before deciding reservation absence/status or comparing stored request fingerprints and input hashes. This includes every OR-contention poll: each iteration uses only the trusted actor/account ID plus line/node IDs, atomically rereads current user/line/node state, fails `FORBIDDEN` on account or relationship changes before reading the winner, and only then reads and interprets the missing/reserved/published/aborted winner state; an authorized aborted cleanup clears the stale claim in that same transaction. Public lookup, begin, claim, finalization, and history retain the same fail-closed ordering, while expired-reservation recovery remains an actorless internal maintenance hook outside the feedback service and routes. Active account-ID assignees append immutable typed revisions, while history binds new evidence to the exact safe feedback revision and admits new records only for the exact `business_line/node_feedback` or `evidence/audit_amendment` scope/source pair; missing scope is confined to the explicit legacy `evidenceIds` adapter. Evidence attachment has no business count cap: 40-document claims stay below 100 operations and a digest binds cursor count, bytes, and ordered IDs. OR contention distinguishes completed winners, non-completion conflicts, live retryable leases, and recoverable expired/aborted claims. Only final-node completion starts retention. A shared strict classifier governs access and history: ordinary evidence on `completed`, `cancelled`, `closed`, or `deleted` lines requires a valid non-null line `purgeDueAt`; amendment evidence requires its own valid deadline; unknown, mismatched, missing, or malformed new-record metadata fails closed before temporary-URL issuance or history projection; and unattached uploads retain their 24-hour orphan lease. Task 11 must recover expired reservations, clear node claims whose reservation is missing, then scan due terminal lines and process all evidence by `businessLineId` in bounded chunks. Physical CloudBase request/document byte limits remain platform constraints. The durable protocol is recorded in `ADR-0003`.
- Task 7 of the template/node/field plan is implemented on its isolated worktree: authenticated `registerEvidenceUpload` and `getEvidenceAccess` routes now delegate only trusted account actors through a focused evidence service and CloudBase repository. Registration accepts only CloudBase file IDs, rejects a declared size above the universal 20 MB ceiling before authorization or cloud egress, authorizes an active business member who is the current active-node assignee or business owner before any download, and rechecks the same fixed documents before persistence. Relationship-schema precedence is evidence-wide: any own line or node relationship key following the `UserId`/`UserIds` convention selects account-ID authorization for registration and access; inherited or prototype keys are ignored, malformed or unrecognized account fields grant nothing, singular fields only trigger schema selection, and only wholly legacy line/node relationships may use the current transactional OpenID binding. Downloaded bytes, not client MIME, determine JPEG, PNG, PDF, or ISO-BMFF video category; extension, exact declared/actual size, per-file limits, node snapshot allowlist, and SHA-256 are enforced. Successful uploads persist secret-free unattached metadata with `available` storage state and a 24-hour orphan expiry while responses omit file IDs, hashes, bytes, and storage details. Evidence access revalidates the active account, business, and evidence node; only `null` or `undefined` timestamps are absent, while every present orphan, purge-due, or purged timestamp must be a finite Date or strict ISO string. Malformed timestamps, non-available storage, any purged marker, and deadlines at or before the current time return `EVIDENCE_EXPIRED` without issuing a temporary URL. Authorized access returns only a five-minute HTTPS temporary URL projection. The exported aggregate helper enforces a 20 MB feedback total without imposing a file-count limit; attachment and feedback completion remain Task 8, while Tasks 10 and 11 still own client upload behavior and orphan/retention cleanup.
- Task 6 of the template/node/field plan is implemented on its isolated worktree: the ordinary template list is fully server-backed with loading, failure, empty, available, and safely mapped unavailable states; unavailable-reason lookup accepts only own string keys, so prototype property names and malformed values always become a safe Chinese fallback string across cards, selection toasts, and create previews. Navigation carries only the selected template ID and no demo definition remains. Create mode previews the enabled-template availability projection, accepts only name, description, and planned dates, validates real calendar dates and ordering, synchronously prevents duplicate submission, and reuses one request key across a failed request retry before redirecting to the protected detail read. Edit mode renders generated codes and snapshot nodes as immutable, submits only metadata plus `expectedVersion`, and surfaces completed/closed/frozen state. A new protected metadata action authorizes account-ID managers (with legacy manager compatibility), revalidates both the active actor and the current legacy binding in a fixed-document transaction, rejects stale versions and creating/frozen/deleted records, updates only the four metadata fields, and writes one secret-free audit record without changing codes, nodes, members, or template snapshots. The dashboard adapter now derives recent lines from the protected account-aware list route, so newly created account-ID snapshots are not omitted; because the protected list does not yet expose an assignment aggregate, `pendingMine` is explicitly unavailable (`null` plus an availability flag) and the UI shows an em dash with a temporary-unavailability label instead of a fabricated zero.
- Task 5 of the template/node/field plan is implemented on its isolated worktree: `createBusinessFromTemplate` accepts only authenticated, validated template-backed metadata, and the deployed legacy manual-create route is disabled while legacy reads remain available. Business codes use the Asia/Shanghai day and expand beyond four digits; immutable node codes expand beyond three digits; and a deterministic actor/request reservation makes retries idempotent without storing the raw request key. The CloudBase repository revalidates the enabled template version, the active creator, and every active assignee in a bounded fixed-document transaction that atomically reserves the daily sequence and writes an invisible `creating` line plus all snapshot nodes. A second bounded transaction verifies every deterministic node, publishes the line as `active`, and writes one secret-free audit record. Snapshots preserve the source template/version, copied field definitions, creator manager/member membership, all assignees, and ready/waiting node state. Actor-aware list/detail reads use account IDs whenever either new membership field is present and OpenID only when both are absent; malformed new membership values grant no rights and never fall back to legacy arrays. Manager-only and member-only records remain visible under their selected schema, and `creating` reservations remain hidden, so a create response ID can open its published detail. A shared creator-aware operation predicate prevents over-budget templates from being enabled or advertised as available while preserving the maximum-48 node contract. Optimistic transaction tests now prove overlapping counter reservations conflict and retry to unique codes or one idempotent result.
- Task 4 of the template/node/field plan is implemented on its isolated worktree: the Mini Program now has a super-administrator-only template list, template editor, and node/field editor; all seven protected Task 3 actions have exact client wrappers; active assignee choices use account document IDs; stable node and field keys survive edit and reorder; enabled definitions render read-only until disabled; optimistic conflicts reload the latest definition; and server-owned `TEMPLATE_LIMIT_EXCEEDED` messages remain visible. Load and mutation boundaries recheck the current active-super-administrator role, including after lifecycle confirmations and every awaited load, save, lifecycle mutation, or refresh, so demotion makes stale continuations fail closed before page-state changes, success UI, refresh, or navigation. Node submission uses a synchronous single-flight guard before mutating the owner page. Template definitions and assignee identities stay out of navigation URLs because the node editor exchanges data only through the previous page instance.
- Task 3 of the template/node/field plan is implemented on its isolated worktree: protected template routes now expose administrator lifecycle operations and an ordinary-user enabled-template projection; the template service enforces super-administrator writes, disabled-before-edit, active account-document assignees, stable keys, optimistic versions, logical deletion, and a formally supported maximum of 48 nodes. The CloudBase repository paginates beyond the SDK's 100-document query window and atomically writes template metadata, fixed-ID node replacements, and one secret-free audit record using server dates after fixed-document template and active-assignee revalidation. Distinct assignee reads count against the 100-operation transaction budget; definitions that exceed the node or operation boundary return the safe `TEMPLATE_LIMIT_EXCEEDED` code and maximum-bearing message. Only template application errors carrying the shared private server-side `Symbol` may retain an allowlisted response; unmarked infrastructure failures return generic `INTERNAL_ERROR`.
- Task 2 of the template/node/field plan is implemented on its isolated worktree: pure CommonJS `field-domain` and `template-domain` modules normalize the seven supported field types, validate denormalized submitted-value snapshots, enforce stable node/field keys and contiguous sequences, apply the 22-work-hour SLA default, restrict evidence types, require active assignee account document IDs for enablement, and reject definition edits while a template is enabled. Text regular-expression definitions use a conservative non-grouped grammar so stored patterns cannot trigger catastrophic backtracking during feedback validation.
- Task 1 of the template/node/field plan is implemented on its isolated worktree: `createBusinessApi` accepts injected `protectedRoutes`; recognized protected actions receive the trusted resolved actor and payload separately, are rejected before handler invocation when authentication fails, and retain the existing account and legacy-route behavior.
- The project owner approved the complete template/node/field refinement covering stable identifiers, disabled-before-edit template rules, generated business and node codes, immutable feedback revisions, previous-node rejection without SLA reset, completed-business freezing, audited super-administrator corrections, video evidence, and 60-calendar-day cloud-object retention. The confirmed specification is `docs/superpowers/specs/2026-08-07-template-node-fields-design.md`, and the executable task plan is `docs/superpowers/plans/2026-08-07-template-node-fields.md`. Tasks 1 through 8 are implemented; Task 9 is next.
- WeChat DevTools account-administration smoke acceptance now covers automatic dashboard restoration, the authoritative super-administrator list state, creation of two ordinary test accounts and a second super administrator, case-insensitive duplicate-username rejection, safe disable/re-enable of the second administrator, rejection of disabling or demoting the final active super administrator, five-failure account lockout, administrator unlock, and read-only compatibility navigation through dashboard, business list, business detail, node feedback/history, and profile pages. No credential or identity value was recorded.
- The obsolete `account-admin` linked worktree is fully cleaned up: its accidental deployment-manual edit was explicitly discarded, Git worktree registration and contents were removed, the merged local `codex/account-admin` branch was deleted through the non-force path, and the final empty `.worktrees/account-admin` directory was removed after WeChat DevTools released it.
- Local `main` was fast-forwarded from `22a78f3` to the accepted account-administration head `f39c89e`. The merged result passed the full backend, client, WXML, syntax, diff, and project-memory checks. `origin/main` was then fast-forwarded through the integrated milestone and cleanup record at `b314785`.
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

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round five:

| Command or boundary | Result |
|---|---|
| Deterministic contention-barrier RED | Failed 1 of 1 as expected with 19 findings: published winners leaked `NODE_ALREADY_COMPLETED`, missing winners leaked `FEEDBACK_COMMIT_IN_PROGRESS`, aborted winners changed the node claim before denial, and one moved-node case surfaced `NOT_FOUND`. |
| Deterministic contention-barrier GREEN | Passed: 1 test, 0 failures. The matrix covers 18 account/relationship mutation by winner-state cases plus five active-contender outcomes. |
| Focused OR-contention and retry regressions | Passed: 5 tests, 0 failures. |
| Complete feedback repository suite | Passed: 31 tests, 0 failures; the 105-evidence claim-chunk boundary remains at or below 100 operations per transaction. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 293 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the repository, regression suite, and injected-wait harness | Passed: 3 files, 0 syntax errors. |

Formal-review round five acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round four:

| Command or boundary | Result |
|---|---|
| Disabled-actor reservation matrix RED | Failed 1 of 1 as expected and reported nine oracle rows: missing/reserved `findPublishedFeedback` calls returned, a missing published lookup returned, reserved changed `beginFeedback` returned `VERSION_CONFLICT`, and published missing-key begin returned `NODE_ALREADY_COMPLETED`. |
| Focused authorization-order GREEN | Passed: 3 tests, 0 failures, covering published lookup, the 39-row reservation existence/status/payload matrix across find/begin/claim/finalize/history, and late claim/finalization. |
| Complete feedback repository suite | Passed: 30 tests, 0 failures; the 105-evidence boundary still kept every measured transaction at or below 100 operations. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 292 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the changed repository and regression suite | Passed: 2 files, 0 syntax errors. |

Formal-review round four acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round three:

| Command or boundary | Result |
|---|---|
| Terminal retention, authorization-order, and history-scope RED | Failed 5 of 5 as expected: terminal ordinary evidence without a strict line deadline remained accessible, disabled changed retries returned `VERSION_CONFLICT`, and new history admitted missing or mismatched scope metadata. |
| Explicit legacy terminal-history RED | Failed 1 of 1 as expected because a terminal legacy row without any effective deadline remained visible. |
| Changed-request-key late-claim RED/GREEN | RED failed 1 of 1 because claim compared the derived feedback ID before actor revalidation; GREEN passed after authorization moved ahead of that conflict. |
| Focused round-three GREEN | Passed 5 of 5 for the terminal status/deadline matrix, public and late published-retry authorization order, exact revision binding, and strict history scope classification. |
| Combined evidence/feedback repository suites | Passed: 60 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 291 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the shared retention classifier and both changed repositories | Passed: 3 files, 0 syntax errors. |

Formal-review round three acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round two:

| Command or boundary | Result |
|---|---|
| Late-path idempotency RED | Failed 2 of 2 as expected with `VERSION_CONFLICT` when publication won before a duplicate reached claim/finalization; a follow-up RED caught published-identity shortcut returns that skipped inactive-actor revalidation. |
| Late-path idempotency GREEN | Passed 2 of 2 for concurrent identical public requests and direct claim/finalization publication races on both next-node and final-line completion; changed payload and inactive-actor checks remained closed. |
| History revision association RED/GREEN | RED exposed 4 included rows instead of one exact revision; GREEN passed the exact-revision case plus legacy/history regressions. |
| Retention-access RED/GREEN | RED exposed ignored line deadlines and malformed retention metadata; GREEN passed ordinary line, unattached orphan, explicit amendment, strict timestamp, and unknown-scope cases. |
| Combined evidence/feedback repository suites | Passed: 58 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 289 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |

Formal-review round two acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round one:

| Command or boundary | Result |
|---|---|
| Service retry/input RED | Failed as expected: 5 focused failures proved published lookup happened too late and inherited/missing request properties were accepted. |
| Repository hardening RED | Failed as expected: 16 passed and 6 failed for missing deterministic published lookup, false completion contention, premature retention, stale expired leases, stale legacy binding, and weak cursor validation. |
| Focused service/repository/route suites | Passed: 64 tests, 0 failures. |
| Repository extended concurrency/history/counter suite | Passed: 25 tests, 0 failures; includes 105 evidences within the 100-operation ceiling and 106 history revisions across query pages. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 283 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |

Real CloudBase deployment and WeChat DevTools acceptance remain unverified. Task 11 must implement expired-reservation recovery plus due-line evidence scanning before orphan/retention deletion and verify the required indexes in the target environment.

Executed on 2026-08-07 for template/node/field Task 8 immutable feedback and OR-sign completion:

| Command or boundary | Result |
|---|---|
| Service TDD RED: `node --test cloudfunctions/businessApi/test/feedback-service.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/feedback-service` did not yet exist. |
| Repository TDD RED: `node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js` | Failed as expected with `MODULE_NOT_FOUND` because the repository did not yet exist; the first implementation run passed 6 of 10 tests and exposed deterministic next-node and completion-race gaps. |
| Recovery/cursor TDD RED | Passed 1 of 4 focused tests and failed 3 as expected because eager abort, expired-reservation recovery, and corrupt-cursor cleanup were absent. |
| Transaction-budget and attached-orphan RED checks | Failed as expected before per-transaction operation instrumentation and orphan-expiry clearing/restoration were implemented. |
| Focused Task 8 service/repository/route suites | Passed: 53 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 272 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment and WeChat DevTools acceptance remain unverified. Task 11 must implement scheduled expired-reservation recovery before orphan deletion and verify the `node_feedback`/evidence query indexes in the target environment.

Executed on 2026-08-07 for template/node/field Task 7 review fix round 2:

| Command or boundary | Result |
|---|---|
| Relationship-detector RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 25 tests passed and 2 failed because the shared own-property detector was absent and line-level `watcherUserIds`/`ownerUserId` still fell through to legacy OpenID authorization; registration reached the cloud/persistence path instead of returning `FORBIDDEN`. |
| Repository GREEN: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Passed: 27 tests, 0 failures. Own line and node relationship keys select the account schema, inherited fields are ignored, and unsupported singular or malformed fields grant nothing. |
| Final focused Task 7 suites | Passed: 65 tests, 0 failures. Registration and access deny mixed line schemas before download, persistence, or temporary-URL issuance while pure legacy and explicitly supported account manager/member relationships remain valid. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 247 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |

Task 7 has no open review finding from this fix round. Tasks 10 and 11 still own client upload acceptance and orphan/retention cleanup; real CloudBase and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-07 for template/node/field Task 7 review fix round 1:

| Command or boundary | Result |
|---|---|
| Schema, timestamp, and pre-download limit RED: `node --test cloudfunctions/businessApi/test/evidence-service.test.js cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 23 tests passed and 5 failed because mixed node account fields still allowed legacy OpenID authorization, a legacy manager survived mixed-schema selection, a declared size above 20 MB reached cloud download, malformed false/zero timestamps were treated as absent, and the service delegated the oversized declaration. |
| Access-schema RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 20 tests passed and 5 failed; the added access case proved an evidence node with a present account relationship still inherited legacy line membership. |
| Final focused Task 7 suites | Passed: 63 tests, 0 failures. Mixed registration/access fails before cloud egress or temporary-URL issuance, pure new and pure legacy authorization remains valid, timestamp type/deadline precedence is deterministic, and actual-buffer/mismatch enforcement remains covered. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 245 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |

Task 7 has no open review finding from this fix round. Tasks 10 and 11 still own client upload acceptance and orphan/retention cleanup; real CloudBase and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-07 for template/node/field Task 7 evidence registration and access authorization:

| Command or boundary | Result |
|---|---|
| Policy, service, and repository initial TDD RED commands | Failed as expected with `MODULE_NOT_FOUND` before each planned production module existed. |
| Route TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 26 tests passed and 2 failed because the two evidence actions were not registered and safe evidence codes still returned `UNKNOWN_ACTION`. |
| Oversized-buffer regression RED: `node --test cloudfunctions/businessApi/test/evidence-policy.test.js` | Failed as expected: 5 tests passed and 1 failed because a downloaded buffer above the image limit returned declared-size mismatch instead of `FILE_TOO_LARGE`. |
| Immutable-ID regression RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 18 tests passed and 1 failed because a generated metadata ID collision could overwrite the existing record. |
| Malformed-expiry regression RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 18 tests passed and 1 failed because malformed orphan or purge timestamps were treated as unexpired instead of failing closed. |
| Malformed-actor regression RED: `node --test cloudfunctions/businessApi/test/evidence-service.test.js` | Failed as expected: 2 tests passed and 1 failed because numeric actor IDs were string-coerced before delegation. |
| Final focused Task 7 suites | Passed: 56 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 238 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the changed production files, `git diff --check`, and project-memory validation | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, temporary-URL issuance, and WeChat DevTools upload/preview acceptance remain unverified until the later deployment and client tasks run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 6 review fix round 2:

| Command or boundary | Result |
|---|---|
| Prototype-safe fallback RED: `node --test miniprogram/test/business-template-flow.test.js` | Failed as expected: 11 tests passed and 1 failed because `constructor` resolved through `Object.prototype` and produced a function instead of a safe message. The regression also covers `toString`, `__proto__`, an unknown string, and malformed non-string inputs. |
| Focused GREEN: same command | Passed: 12 tests, 0 failures; list cards, selection toasts, create previews, and create error state all receive the normalized fallback string. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 208 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` and `node --check miniprogram/services/templates.js` | Passed: 1 WXML test and the changed production JavaScript syntax check. |

Real CloudBase deployment and WeChat DevTools acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 6 review fix round 1:

| Command or boundary | Result |
|---|---|
| Review-regression RED: `node --test miniprogram/test/business-template-flow.test.js miniprogram/test/account-flow.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Failed as expected: 70 tests passed and 8 failed, reproducing missing component registration, stale legacy-binding authorization, stale dashboard continuation, fabricated pending count, leaked/unmapped availability codes, and inconsistent create-preview messaging. |
| Focused GREEN: same command | Passed: 78 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 208 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| JavaScript syntax checks for all changed JavaScript and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment and WeChat DevTools acceptance for template availability errors, idempotent create retry, generated-code detail navigation, account-ID and legacy metadata authorization, honest dashboard presentation, and frozen-state presentation remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 6 ordinary template-backed creation and account-aware metadata editing:

| Command or boundary | Result |
|---|---|
| Client TDD RED: `node --test miniprogram/test/business-template-flow.test.js` | Failed as expected: 9 tests failed because the client still exposed demo/manual creation and lacked the protected template-create wrapper, availability states, date validation, retry key, single-flight submission, immutable edit projection, frozen state, and post-await account rechecks. |
| Initial client GREEN: same command | Passed: 9 tests, 0 failures; an intermediate run passed 8 and failed 1 until duplicate authentication redirects after a stale read were suppressed. |
| Protected metadata TDD RED: `node --test cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js miniprogram/test/business-template-flow.test.js` | Failed as expected: 58 tests passed and 14 failed because the protected metadata action and account-ID repository transaction did not exist and the client still targeted the legacy update wrapper. |
| Protected metadata focused GREEN: same command | Passed: 72 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 80 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 207 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| JavaScript syntax checks for all changed JavaScript and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment and WeChat DevTools acceptance for template selection, idempotent create retry, generated-code detail navigation, account-ID metadata edit, and frozen-state presentation remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 5 review fix round 2:

| Command or boundary | Result |
|---|---|
| Malformed-membership TDD RED: `node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Failed as expected: 14 tests passed and 2 failed because a present `null` account-membership field inherited legacy OpenID access and manager-only account/legacy records were omitted from listing queries. |
| Repository GREEN: same command | Passed: 16 tests, 0 failures. Present malformed account membership values grant no rights, any new-field presence selects account schema, valid hybrid arrays use account IDs, and pure legacy records remain compatible. |
| Focused business service, repository, and route suites | Passed: 51 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 195 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the changed repository and regression test; `git diff --check`; project-memory validator | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, collection/index setup, and concurrent multi-account acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 5 review fix round 1:

| Command or boundary | Result |
|---|---|
| Legacy-create route RED/GREEN: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | RED: 23 passed and 1 failed because the deployed legacy-map factory/guard did not exist; GREEN: 24 tests passed after the manual creator was removed from the default route map. |
| Dual-schema read RED/GREEN: business service, repository, and route suites | RED: 43 passed and 4 failed because list/detail remained on the legacy OpenID path; a second RED passed 46 and failed 1 until the fake query reproduced CloudBase array membership. GREEN: 47 tests passed with account-ID snapshots, OpenID legacy compatibility, authorization, redirect-by-ID detail, and `creating` invisibility. |
| Creator-race RED/GREEN: business repository suite | RED reproduced a creator disabled after route resolution still writing a snapshot; GREEN revalidated fixed `users/<actorId>` before all reservation writes and left no counter, line, node, or audit data. |
| Snapshot-budget RED/GREEN: template service and business repository suites | RED: 24 passed and 3 failed because creation counted neither the creator read nor enable/availability parity. GREEN: 27 tests passed with one shared worst-case predicate and a budget-specific safe message that does not claim 48 nodes exceed the node maximum. |
| Optimistic concurrency RED/GREEN: business repository suite | RED: 13 passed and 1 failed because no overlapping conflict harness existed. GREEN: 14 tests passed; callbacks overlapped, at least one snapshot revision conflict retried, distinct requests received unique codes, and same-key requests converged on one result. |
| Mixed-schema precedence RED/GREEN: business repository suite | RED: 13 passed and 1 failed because a hybrid new record could fall back to legacy OpenID membership; GREEN: account-ID fields take precedence and the unauthorized record is absent. |
| Combined focused Task 5, template repository/service, and account-route suites | Passed: 78 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 193 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for all fix-round JavaScript; `git diff --check`; project-memory validator | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, collection/index setup, and concurrent multi-account acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 5 generated numbering and atomic snapshots:

| Command or boundary | Result |
|---|---|
| Numbering TDD RED: `node --test cloudfunctions/businessApi/test/business-numbering.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/business-numbering` did not yet exist. |
| Service TDD RED: `node --test cloudfunctions/businessApi/test/business-service.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../../lib/business-service` did not yet exist. |
| Repository TDD RED: `node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/cloud-business-repository` did not yet exist. |
| Unique-index fake boundary RED | Failed as expected: 9 passed and 1 failed because the fake CloudBase database did not yet reproduce the real unique business/node code indexes; after adding only those index checks, the repository suite passed 10 tests with 0 failures. |
| Route TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 22 passed and 1 failed because `createBusinessFromTemplate` was not wired and returned `UNKNOWN_ACTION`. |
| Focused GREEN: `node --test cloudfunctions/businessApi/test/business-numbering.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Passed: 21 tests, 0 failures. |
| `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Passed: 23 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 184 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for all changed backend/test JavaScript; `git diff --check`; project-memory validator | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, collection/index setup, and concurrent multi-account acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 4 fix round 2:

| Command or boundary | Result |
|---|---|
| Async-continuation TDD RED: `node --test miniprogram/test/template-flow.test.js` | Failed as expected: 11 passed and 5 failed. Pending list, active-account, and definition loads applied stale data after demotion; pending lifecycle/save actions still continued success UI, refresh, or navigation. |
| Focused GREEN: `node --test miniprogram/test/template-flow.test.js` | Passed: 16 tests, 0 failures; all stale continuations fail closed and the node-submit single-flight regression remains green. |
| `node --test miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 71 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --check` for the two changed page files, unchanged node editor, and focused test; `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |
| Project-memory validator | Passed for the Task 4 worktree. |


Executed on 2026-08-07 for template/node/field Task 4 fix round 1:

| Command or boundary | Result |
|---|---|
| Authorization and node-submit TDD RED: `node --test miniprogram/test/template-flow.test.js` | Failed as expected: 9 passed and 2 failed. A demoted user still started `listTemplates`, and two immediate node submissions invoked the owner callback twice. |
| Focused GREEN: `node --test miniprogram/test/template-flow.test.js` | Passed: 11 tests, 0 failures; load/mutation boundaries recheck authority and node commit is single-flight before the owner callback. |
| `node --test miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 66 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --check` for the three changed page JavaScript files and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |
| Independent fix-round review | READY: boundary authorization, post-confirmation checks, synchronous node-submit commitment, disabled/loading UI state, and focused behavioral coverage were confirmed; no Critical or Important findings remain in scope. |


Executed on 2026-08-07 for template/node/field Task 4 administrator template pages:

| Command or boundary | Result |
|---|---|
| Service/registration/list TDD RED: `node --test miniprogram/test/template-flow.test.js` | Failed as expected: 3 tests failed because the template client service, three registered pages, dashboard gate, and protected list page did not exist. |
| Service/registration/list GREEN: same focused suite | Passed: 3 tests, 0 failures. |
| Editor TDD RED: same focused suite | Failed as expected: 3 passed and 4 failed because the template and node/field editor pages did not exist. |
| Editor GREEN | Passed: 7 tests, 0 failures, covering active-account pagination, stable keys and reorder, non-empty nodes, limit rendering, stale refresh, read-only behavior, and previous-page transfer. |
| WXML compatibility RED/GREEN | RED: 7 passed and 1 failed on unsupported array-method expressions; GREEN: 8 tests, 0 failures after precomputing view state. |
| Enabled-definition view RED/GREEN | RED: 7 passed and 1 failed because read-only nodes could not be opened for inspection; GREEN: 8 tests, 0 failures with navigation retained and mutations still blocked. |
| Review-fix RED/GREEN | RED: 8 passed and 1 failed because unsaved nodes had no unique client key; GREEN: 9 tests, 0 failures after unique UI keys were preserved through reorder and stripped from API definitions. |
| `node --test miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 64 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| Changed JavaScript syntax checks | Passed for the template service and all three administrator template pages. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| Independent review and focused re-review | Initial review found one Important unsaved-row WXML key defect; focused re-review confirmed unique client-only keys are preserved and stripped from API payloads. No Critical or Important findings remain. |


Executed on 2026-08-07 for template/node/field Task 3 fix round 1:

| Command or boundary | Result |
|---|---|
| Error-trust TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 21 passed and 1 failed because an unmarked infrastructure `NOT_FOUND` retained its raw message and code. |
| Error-trust GREEN: same route suite | Passed: 22 tests, 0 failures; protected authentication codes remained compatible. |
| Transactional-assignee TDD RED: `node --test cloudfunctions/businessApi/test/cloud-template-repository.test.js` | Failed as expected: 9 passed and 3 failed because creation, update, and enablement did not revalidate active assignee documents in their write transactions. |
| Transactional-assignee GREEN plus account regression: service, template repository, and cloud-account repository suites | Passed: 51 tests, 0 failures. |
| Limit-contract TDD RED: final Task 3 focused suites | Failed as expected: 42 passed and 4 failed because limit violations still used `TEMPLATE_INVALID` and the route did not allow the new dedicated code. |
| Enable-limit review RED: `node --test cloudfunctions/businessApi/test/template-service.test.js` | Failed as expected: 11 passed and 1 failed because a legacy 49-node disabled template could still be enabled. |
| Final Task 3 focused suites | Passed: 47 tests, 0 failures. |
| `node --test cloudfunctions/businessApi/test/cloud-account-repository.test.js` | Passed: 28 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax, `git diff --check`, and project-memory validation | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |
| Read-only fix review and re-review | Passed after the enable-path limit regression and private `Symbol` hardening; no Critical or Important code findings remain. |

Executed on 2026-08-07 for template/node/field Task 3 template persistence and protected routes:

| Command or boundary | Result |
|---|---|
| Service TDD RED: `node --test cloudfunctions/businessApi/test/template-service.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/template-service` did not yet exist. |
| Repository TDD RED: `node --test cloudfunctions/businessApi/test/cloud-template-repository.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/cloud-template-repository` did not yet exist. |
| Route TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 2 failures because default template routes were not wired and template errors returned `UNKNOWN_ACTION`. |
| Review-regression RED: focused Task 3 suites | Failed as expected: 3 failures exposed the 100-document query window, missing transaction-node cap, and unsanitized unknown error response. |
| Transaction-boundary RED: focused service/repository suites | Failed as expected: 2 failures exposed the 49-to-49 replacement's 101-operation cost. |
| Final focused Task 3 suites | Passed: 41 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 156 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| Read-only formal review and fix re-review | Passed; no Critical or Important findings remain. |

Executed on 2026-08-07 for template/node/field Task 2 fix round 1 safe regular-expression policy:

| Command or boundary | Result |
|---|---|
| Regression TDD RED: `node --test cloudfunctions/businessApi/test/field-domain.test.js` | Failed as expected: nested quantified pattern `(a+)+$` was accepted, so the regression assertion reported a missing expected exception. |
| Focused field GREEN: `node --test cloudfunctions/businessApi/test/field-domain.test.js` | Passed: 6 tests, 0 failures. |
| Focused field and template suites: `node --test cloudfunctions/businessApi/test/field-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js` | Passed: 10 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 133 tests, 0 failures; npm emitted two pre-existing malformed user-config warnings. |

Executed on 2026-08-07 for template/node/field Task 2 domain policies:

| Command or boundary | Result |
|---|---|
| Field-policy TDD RED: `node --test cloudfunctions/businessApi/test/field-domain.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/field-domain` did not yet exist. |
| Template-policy TDD RED: `node --test cloudfunctions/businessApi/test/template-domain.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/template-domain` did not yet exist. |
| Focused field and template suites: `node --test cloudfunctions/businessApi/test/field-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js` | Passed: 9 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 132 tests, 0 failures; npm emitted two pre-existing malformed user-config warnings. |

Executed on 2026-08-07 for template/node/field Task 1 protected-route seam:

| Command or boundary | Result |
|---|---|
| Focused route-seam TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 2 failures because `createBusinessApi` did not recognize injected protected routes; the authenticated route returned `UNKNOWN_ACTION`, and the unauthenticated route did not reach `UNAUTHORIZED`. |
| Focused route suite after implementation | Passed: 18 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 123 tests, 0 failures; npm emitted two pre-existing malformed user-config warnings. |

Executed on 2026-08-07 for the template/node/field implementation plan:

| Command or boundary | Result |
|---|---|
| Requirements-to-task review | Passed; the 12 tasks cover authenticated routing, template/field policy, persistence, administrator UI, generated numbering and snapshots, ordinary creation, evidence validation/access, immutable feedback, rejection/freeze/amendment, client flows, retention worker, and deployment acceptance. |
| Unfinished-marker and interface-consistency scan | Passed; no unfinished markers were found, all commit steps use explicit paths, and the snapshot-copy example uses a defined operation. |
| `git diff --check` | Passed; line-ending warning only. |
| Project-memory validation | Passed. |
| Application test suites | Not rerun because this planning step changes documentation only; no executable code changed. |

Executed on 2026-08-07 for the approved template/node/field design documentation:

| Command or boundary | Result |
|---|---|
| Unfinished-marker, conflict-marker, and rule-consistency review | Passed; no unfinished markers were found, and numbering overflow plus logical-delete retention boundaries were made explicit during self-review. |
| `git diff --check` | Passed; line-ending warnings only. |
| Project-memory validation | Passed. |
| Application test suites | Not rerun because this change contains design and memory documentation only; no executable code changed. |

Executed on 2026-08-07 before publishing the integrated `main` branch:

| Command or boundary | Result |
|---|---|
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures; the two pre-existing malformed npm user-config warnings remain. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 55 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `git diff --check` and project-memory validation | Passed on the clean `main` tree. |
| GitHub publication | `origin/main` was fetched, confirmed as an ancestor of local `main`, and fast-forwarded from `22a78f3` to `b314785` without force. |

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

- Administrator password reset manual acceptance is deferred because the current editable reset modal cannot mask the temporary password. The backend reset path remains automated-test covered; the client must move password entry to masked fields before manual use.
- First-login binding, unbinding, rebinding with another identity, and ordinary-user route denial remain unverified because they require a second WeChat identity. These do not block the next core feature phase.
- WeChat DevTools changed the uncommitted `project.config.json` base-library selection from `trial` to `3.17.1`. This operator-owned change is preserved and must not be mixed into feature commits without an explicit decision.
- `npm audit` reports six transitive findings (one moderate, five high) through the official `wx-server-sdk@4.0.2` dependency tree. npm proposes a major downgrade to 2.5.3; it was not applied because it would invalidate the reviewed transaction behavior. Track the upstream SDK and reassess on a reviewed release.
- Enterprise WeChat production identifiers and secret remain intentionally unavailable; strong-message delivery is deferred.

## Next actions

1. Obtain user review of `docs/superpowers/specs/2026-08-10-task-8r-atomic-feedback-recovery-design.md`, then write and execute the Task 8-R implementation plan using deterministic RED/GREEN concurrency coverage and fresh formal review.
2. Execute Task 9 from `docs/superpowers/plans/2026-08-07-template-node-fields.md`: add previous-node rejection, frozen-state enforcement, and audited amendments.
3. Continue the remaining client and evidence-retention tasks in plan order from the isolated `codex/` worktree.
4. Continue SLA/calendar, hourly reminder, and Enterprise WeChat adapter phases.
5. Replace the administrator reset-password editable modal with masked inputs, then complete the remaining second-identity binding/unbinding acceptance.
