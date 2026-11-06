# Analytics Recovery Preread Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce fixed-ID preread requests in field recovery without removing authoritative publication checks or changing business data.

**Architecture:** Add one call-local, bounded preread helper for line/feedback documents and consume its entries only at original node visits. Preserve fresh node/review/vote reads, full pre-result versus transaction-result comparison, cursor CAS and deadlines. Derive the deployable payload from a fresh cloud backup, replacing only the recovery integration and new helper.

**Tech Stack:** Existing CommonJS Node runtime, pinned wx-server-sdk4.0.2, node:test, official WeChat Developer Tools CLI. No dependency installation/update.

**Spec:** docs/superpowers/specs/2026-11-06-analytics-recovery-preread-batching-design.md

## Global Constraints

- Maximum4 adjacent candidates, fixed-ID line/feedback reads only; single/unsafe groups retain original exact reads.
- Preserve40 raw nodes/5-second cooperative budget, per-node cursor claim/CAS and complete transactional source validation.
- No cross-call or transaction authorization cache; unknown transport/commit is not retried as singles.
- No Timer/IAM/index/resource/log/SDK/client/business/station/WeCom-rule changes; no Git commit/push.
- User explicitly authorized current-workspace implementation and testing plus minimal direct deployment; execute inline without another same-scope approval pause.
- Existing dirty state belongs to the user. Freeze before-images and verify unrelated source hashes; do not reset/reconstruct from HEAD.

## Review Focus

- A future malformed candidate must not prevent the already-claimed healthy prefix from completing.
- A changed fixed pointer must not consume another node's stale prepared content or trigger retry after an unknown query result.
- Shared line IDs and duplicate response IDs must not alias mutable objects or silently discard corruption.
- A query crossing the deadline must not permit another query or publication; unfinished/empty pages must incur no new content prereads.
- A future excluded/missing/deleted source or early exit may waste prefetched rows: count that cost, preserve fairness and reject unjustified deployment.

---

### Task 1: Bounded helper, integration and differential evidence

**Files:**
- Create: cloudfunctions/operationsAnalytics/lib/field-source-prereads.js
- Modify: cloudfunctions/operationsAnalytics/lib/field-snapshot-recovery.js
- Create: cloudfunctions/operationsAnalytics/test/field-snapshot-recovery-preread-batching.test.js
- Create: outputs/qa/analytics-preread-20261106/{freeze.cjs,run.cjs,compare.cjs} and generated evidence.

**Interfaces:**
- Helper consumes `{db,budget,own,documentId}`; exports `createFieldSourcePrereads(...)`.
- Call-local helper produces `prepare({page,index,node})`, `read({node,collection,id,fallback})` and `discard()`; preparation/read are async, discard only invalidates hints.
- Recovery passes the original page/current index/current fresh node; `fallback()` is the existing exact document read. Helper never receives a transaction database or writes data.

- [x] Step1: Freeze all existing source hashes and the original recovery file; run `npm.cmd test --prefix cloudfunctions/operationsAnalytics` and require exit0.
- [x] Step2: Write integration tests against real recovery/fake DB: four healthy completed sources produce identical snapshots with8 exact line/feedback prereads replaced by2 bounded queries; all transaction content reads remain; unfinished/single pages have no extra queries. Run new tests against frozen/original code and observe the missing-feature assertions fail.
- [x] Step3: Implement the smallest helper and recovery integration; run new tests and the existing44 recovery tests to green.
- [x] Step4: Add RED→GREEN boundaries for malformed/duplicate/outside IDs, per-candidate error timing, known pointer changes, unknown batch failures, shared objects, current source mutations, deadlines, cursor conflicts and slow/bad suffix fairness. Do not weaken old rejection assertions.
- [x] Step5: Run the full Analytics suite, businessApi suite, WXML checker and hash/diff/memory gates. Capture exact failures or exit0, not historical results.
- [x] Step6: Compare frozen original/current candidate on empty,30 unfinished,30 completed,30 reviewed,150 reviewed first page, shared lines and bounded early exit; assert same protected state and expected results, record returned documents/bytes and unused rows. Request counts must decrease for mature normal completed layouts without higher normal returned-document counts; failures stop deployment.
- [x] Step7: Obtain one fresh-context final security/correctness review of exact before-images/changed files/spec; fix Critical/Important with failing regression tests and rerun green suites. Record any material ruling.
- [x] Step8: Preserve changes uncommitted (user did not request Git operations); mark Task1 evidence complete only after all gates pass.

### Task 2: Exact minimal deployment and independent readback

**Files:**
- Create: outputs/deploy/analytics-preread-20261106/{official.cjs,prepare.cjs,deploy.cjs,verify.cjs} and generated frozen backup/candidate/upload/receipts.
- Create: docs/deployment/analytics-recovery-preread-batching-acceptance.md
- Update: docs/memory/STATUS.md and ADR0019 only for the accepted durable implementation boundary.

**Interfaces:**
- Consumes Task1 tested runtime pair, exact immutable hashes and green review/evidence.
- Produces a complete cloud-derived candidate and minimal upload containing only `lib/field-snapshot-recovery.js` and `lib/field-source-prereads.js`; final independent full-package readback must equal candidate manifest.

- [x] Step1: Official CLI info/download only: safe metadata whitelist, fresh original code backup, no environment-variable dump, no invocation. Refuse existing backup overwrite.
- [x] Step2: Verify original cloud recovery matches the frozen TDD baseline; preserve every other cloud runtime/dependency/config file, insert only the two tested target files. If unrelated function runtime differs from tested local dependencies, test the actual candidate rather than overwriting it with local versions.
- [x] Step3: Build an isolated QA copy of that exact cloud-derived runtime with current tests/support outside upload; run complete Analytics tests plus minimal-payload/unchanged-file checks. Require all green and source hashes stable.
- [x] Step4: Print exact incremental payload size and known existing-cost scope before deployment. No new subscription/IAM/Timer/config commitment is allowed; suspend on such a prompt.
- [x] Step5: Write a persistent one-attempt marker, perform only one official incremental update for operationsAnalytics. Unknown result is read back, never blindly retried; retain original backup for a specifically scoped restore if needed.
- [x] Step6: Independently download the complete resulting package and safe metadata; compare every file/hash and status/runtime/timeout. Update acceptance/memory with actual deployment outcome, limitations and next same-scope billing validation. Do not claim a verified cash reduction from local SDK counts.

## Self-review and execution note

Task1's exact hashes and accepted semantics are Task2's release inputs; Task2 must not upload unrelated dirty files. The user already authorized implementation/testing/direct deployment, so this written plan is an execution record, not another approval request. Where Unix-only helper scripts cannot run, record a Windows-native equivalent in this plan's ledger without changing other plans' scratch data. Do not discard this ledger while its evidence is uncommitted.
