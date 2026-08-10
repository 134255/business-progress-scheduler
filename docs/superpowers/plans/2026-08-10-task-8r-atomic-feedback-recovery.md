# Task 8-R Atomic Feedback Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the feedback-recovery authorization race by making every actor-facing transition from `reserved` to `aborting` atomic with current actor and relationship authorization.

**Architecture:** Keep the existing hidden feedback reservation protocol and split recovery into an authorization-bound start plus an idempotent bounded continuation. Actor-facing paths start recovery only in a transaction that rereads the active actor, business line, node, and exact reservation; the internal Task 11 entry may start expired recovery without an actor, while shared continuation can only process an already-`aborting` reservation.

**Tech Stack:** Node.js CommonJS, Tencent CloudBase fixed-document transactions, Node.js built-in test runner, existing fake and optimistic CloudBase harnesses.

## Global Constraints

- Use strict TDD: reproduce the reviewer's inter-transaction revocation window against commit `2751617`, observe the expected failure, implement the minimum atomic transition, and rerun focused plus full regressions.
- Preserve all Task 8 public route names, response projections, safe error codes, idempotency fingerprints, OR-sign behavior, history, evidence limits, and retention rules.
- An actor-facing request may change `reserved` to `aborting` only in a transaction that rereads and authorizes the current actor, line, node, and exact reservation before writes.
- Actorless rollback continuation may restore evidence and finalize only an already-`aborting` reservation; it may not initiate recovery or clear a node claim.
- `recoverExpiredReservation(feedbackId)` remains an internal repository-only maintenance entry for Task 11 and must remain absent from feedback services and routes.
- Clear a node claim only when `node.feedbackClaimId === reservation._id`; never clear mismatched or missing claims.
- Keep every fixed-document transaction within the existing 100-operation CloudBase ceiling and retain the 40-evidence claim chunk size.
- Add no collection, index, runtime dependency, client page, or public response field.
- Update durable project memory with exact evidence and keep deployment/real-CloudBase acceptance marked unverified.
- Stage explicit paths only; never stage the operator-owned `project.config.json` change or unrelated files.

---

## Planned File Structure

- `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`: separate recovery start from continuation and route every actor-facing recovery through an authorization-bound transaction.
- `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`: deterministic revocation-window, linearization, exact-claim, idempotent continuation, and preserved-semantics regressions.
- `cloudfunctions/businessApi/test/helpers/fake-cloud-database.js`: add only the narrow successful-transaction observation hook needed to reproduce the old two-transaction window, if the existing harness cannot expose it without production test seams.
- `cloudfunctions/businessApi/test/helpers/feedback-harness.js`: pass the optional deterministic transaction observer to the fake database, if required.
- `docs/memory/STATUS.md`: record RED/GREEN evidence, final review state, deployment boundary, and next action.
- `docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md`: refine the accepted reservation invariant after verification so actor-facing recovery start is authorization-atomic and maintenance recovery remains internal.
- `.superpowers/sdd/2026-08-10-task-8r-atomic-feedback-recovery/`: fresh Task 8-R brief, ledger, implementation report, and review artifacts; do not reopen Task 8's exhausted fix ledger.

---

### Task 1: Make actor-facing recovery authorization-atomic

**Files:**
- Modify: `cloudfunctions/businessApi/lib/cloud-feedback-repository.js:280-369,558-708`
- Modify: `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js:156-190,393-491,604-621`
- Modify only if required: `cloudfunctions/businessApi/test/helpers/fake-cloud-database.js:1-220`
- Modify only if required: `cloudfunctions/businessApi/test/helpers/feedback-harness.js:70-90`
- Modify: `docs/memory/STATUS.md`
- Modify: `docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md`
- Create: `.superpowers/sdd/2026-08-10-task-8r-atomic-feedback-recovery/task-brief.md`
- Create: `.superpowers/sdd/2026-08-10-task-8r-atomic-feedback-recovery/review-ledger.md`
- Create: `.superpowers/sdd/2026-08-10-task-8r-atomic-feedback-recovery/task-1-report.md`

**Interfaces:**
- Consumes: `readSubmissionDocuments(transaction, actorId, { businessLineId, nodeId })`, `assertContentionPollAuthorization(actor, line, node)`, `assertCurrentActorAuthorization(actor, line, node)`, `parseDeadline(value)`, `readDocument(transaction, collection, id)`, and existing CloudBase `db.command.remove()` semantics.
- Produces internally: `markReservationAborting(transaction, { reservation, node, reason, at }) -> Promise<boolean>` and `continueReservationRollback(feedbackId, at) -> Promise<boolean>` (names may change only if the same responsibility split remains explicit).
- Preserves externally: `commitFeedback(value)`, `recoverExpiredReservation(feedbackId)`, `findPublishedFeedback`, `beginFeedback`, `claimEvidenceChunk`, `finalizeFeedback`, and `getNodeHistory` signatures and public behavior.

- [ ] **Step 1: Create a fresh Task 8-R SDD workspace and baseline**

Create the fresh task brief and ledger with:

```markdown
# Task 8-R: Atomic actor-facing feedback recovery

Base commit: e04c866
Scope: one recovery concurrency defect from Task 8 formal review.
Invariant: no actor-facing request may initiate reservation recovery unless current authorization and the recovery-start writes commit in the same transaction.
Maximum fix rounds: 5 for Task 8-R; Task 8's exhausted ledger remains closed.
```

Record the clean branch, base commit, accepted design path, and focused/full verification commands. Do not copy raw reviewer logs or identity values.

- [ ] **Step 2: Add a deterministic failing regression for the old two-transaction window**

Add a test named like:

```js
test('revocation between contention authorization and recovery start cannot mutate the winner claim', async () => {
  // Seed an expired reserved winner owned by the current node.
  // Observe the successful transaction result that old code returns as { type: 'reserved' }.
  // Before the next transaction begins, disable/remove the contender.
  // Invoke commitFeedback as account-b.
  // Expect FORBIDDEN and assert the node claim and winner publishState are unchanged.
})
```

If the current fake cannot pause exactly after a successful transaction, add an optional test-only observer to `createFakeCloudDatabase` and thread it through `createFeedbackHarness`. The observer must receive a cloned successful callback result and execute after that transaction's writes are committed but before `runTransaction` resolves. It must be disabled by default and must not change production code.

Cover all six current authorization mutations using the existing mutation helpers: disabled user, missing user, removed line member, removed node assignee, moved node, and account/legacy schema change. Capture the pre-call node, reservation, evidences, and audit collections and compare them after `FORBIDDEN`.

- [ ] **Step 3: Run the focused RED test against the current implementation**

Run:

```powershell
node --test --test-name-pattern "revocation between contention authorization and recovery start" cloudfunctions/businessApi/test/cloud-feedback-repository.test.js
```

Expected RED: at least one case returns `FORBIDDEN` while `feedbackClaimId` is removed or the winner changes from `reserved` to `aborted`/`aborting`. Record the exact observed assertion in the Task 8-R report.

- [ ] **Step 4: Add RED coverage for every actor-facing recovery start and continuation boundary**

Add focused cases that prove:

```js
// Same-request expired/malformed reservation:
// current authorization and reserved -> aborting happen atomically.

// OR competing expired/malformed reservation:
// current authorization, exact winner validation, reserved -> aborting,
// and exact matching claim removal happen atomically.

// Submission-failure compensation:
// an active actor may mark its exact reservation aborting;
// a revoked actor leaves reserved/claim/evidence unchanged for Task 11.

// Continuation:
// only aborting is accepted; reserved cannot be initiated by continuation;
// evidence orphan metadata is restored once; final state becomes aborted;
// repeating continuation is safe.

// Maintenance:
// recoverExpiredReservation remains able to start only an actually expired
// or malformed reservation without being exposed through a route/service.
```

Also assert a mismatched `feedbackClaimId` survives both actor and maintenance recovery starts.

- [ ] **Step 5: Run the expanded focused tests and confirm RED is caused by the missing responsibility split**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js
```

Expected RED: actor-facing paths still call `releaseReservation` to initiate recovery outside their authorization transaction, and continuation can still initiate `reserved -> aborting`.

- [ ] **Step 6: Implement one transaction-local recovery-start helper**

In `cloud-feedback-repository.js`, extract the write set without opening a transaction:

```js
async function markReservationAborting(transaction, { reservation, node, reason, at }) {
  if (!reservation || reservation.publishState !== 'reserved') return false
  await transaction.collection(COLLECTIONS.feedback).doc(reservation._id).update({ data: {
    publishState: 'aborting',
    recoveryCount: increment(reservation.recoveryCount === undefined ? 0 : reservation.recoveryCount),
    recoveryReason: reason,
    recoveryStartedAt: at,
    updatedAt: db.serverDate()
  } })
  if (node && node.feedbackClaimId === reservation._id) {
    await transaction.collection(COLLECTIONS.nodes).doc(node._id).update({ data: {
      feedbackClaimId: db.command.remove(),
      feedbackClaimHash: db.command.remove(),
      feedbackClaimExpiresAt: db.command.remove()
    } })
  }
  return true
}
```

Do not let this helper read stale documents or open its own transaction. Callers must supply documents read in the same transaction.

- [ ] **Step 7: Make same-request and OR-contention expiry start recovery inside their authorized transactions**

For `beginFeedback`, replace `RESERVATION_RECOVERY_REQUIRED` after an expired/malformed exact reservation with a transaction-local call to `markReservationAborting`, then return an internal `recoveryRequired` outcome. In `commitFeedback`, continue rollback and retry only after that transaction commits.

For `waitForWinner`, parse the lease inside the existing authorized poll transaction. When the exact `reserved` winner is expired or malformed, call `markReservationAborting` there and return an internal `recover` outcome. Remove both post-transaction calls to actorless `releaseReservation` from the `reserved` branch.

The resulting shape should be equivalent to:

```js
if (winner && winner.publishState === 'reserved') {
  const expired = malformedOrAtOrBefore(winner.claimExpiresAt, at)
  if (expired) {
    const started = await markReservationAborting(transaction, {
      reservation: winner, node: current.node, reason: 'CLAIM_EXPIRED', at
    })
    return started ? { type: 'recover', feedbackId: winner._id, at } : { type: 'wait' }
  }
  return { type: 'reserved' }
}
```

Keep authorization before winner existence/status/lease classification and before every write.

- [ ] **Step 8: Split bounded continuation from actor and maintenance recovery starts**

Refactor the current `releaseReservation` body so `continueReservationRollback(feedbackId, at)`:

1. queries claimed evidence by `feedbackId` outside a transaction as today;
2. in each bounded chunk rereads the reservation and proceeds only when `publishState === 'aborting'`;
3. restores matching evidence metadata;
4. finalizes only `aborting -> aborted`;
5. never changes `reserved -> aborting` and never clears node claims.

Keep `recoverExpiredReservation(feedbackId)` as the repository-only Task 11 maintenance entry. Its first actorless transaction may validate an expired/malformed lease and call `markReservationAborting`; only then may it call the shared continuation. Confirm `rg -n "recoverExpiredReservation" cloudfunctions/businessApi` finds no service or route registration.

- [ ] **Step 9: Make submission-failure compensation authorization-bound**

Replace the catch block's direct `releaseReservation(reservation.feedbackId, ...)` call with a fixed-document transaction that rereads `value.actor._id`, the trusted line/node IDs, and the exact reservation, calls `assertCurrentActorAuthorization`, verifies the reservation belongs to that actor/input, and invokes `markReservationAborting`. Only when that transaction succeeds may the catch block invoke continuation.

If reauthorization fails, preserve the original public error and leave the live/expired reservation for internal Task 11 recovery. Do not convert the original error into a recovery detail or expose reservation state.

- [ ] **Step 10: Run focused GREEN and inspect transaction budgets**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js
node --test cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

Expected: all focused tests pass; the existing 105-evidence case remains at or below 100 operations per transaction; no transaction query is introduced.

- [ ] **Step 11: Run the complete automated verification gate**

Run from the worktree root:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
node --check cloudfunctions/businessApi/lib/cloud-feedback-repository.js
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: every test and validator passes. Treat CloudBase deployment, real SDK contention behavior, and WeChat DevTools acceptance as unverified.

- [ ] **Step 12: Update durable memory and ADR-0003**

In `STATUS.md`, replace the pending-design statement with exact RED/GREEN counts, the final commit/review state, and the next action. In ADR-0003, add the verified invariant:

```markdown
- Every actor-facing transition from `reserved` to `aborting` commits in the same fixed-document transaction that reloads and authorizes the current actor, business line, node, and exact reservation. Actorless continuation can process only an already-`aborting` reservation. The repository-only Task 11 maintenance entry may start expired recovery without an actor and is never exposed through ordinary services or routes.
```

Do not update `PROJECT.md` unless implementation establishes a stable fact not already represented by ADR-0003.

- [ ] **Step 13: Inspect, stage explicit paths, and commit the implementation**

Run:

```powershell
git status --short
git diff -- cloudfunctions/businessApi/lib/cloud-feedback-repository.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/helpers/fake-cloud-database.js cloudfunctions/businessApi/test/helpers/feedback-harness.js docs/memory/STATUS.md docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md
git add -- cloudfunctions/businessApi/lib/cloud-feedback-repository.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js docs/memory/STATUS.md docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md
```

Add either helper file explicitly only if it changed. Verify the staged diff, then commit:

```powershell
git diff --cached --check
git commit -m "fix: make feedback recovery authorization atomic"
```

- [ ] **Step 14: Run a fresh two-stage Task 8-R review**

First review exact compliance with the approved Task 8-R design and test matrix. Then use a different fresh reviewer for code quality/security review of only `e04c866..<implementation-head>`. Any finding belongs to the new Task 8-R ledger and its five-round limit; do not append another Task 8 fix round.

Acceptance requires no open Critical or Important finding. Record Minor findings explicitly and either fix them within the Task 8-R limit or obtain an explicit deferral decision. After any fix, rerun the proportional focused suite plus the complete verification gate before updating the ledger.
