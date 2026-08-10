# Task 8-R Atomic Feedback Recovery Design

## Status

Approved approach: A — actor-facing expired-reservation recovery starts atomically inside the authorized contention-poll transaction.

This follow-up is intentionally separate from Task 8 because Task 8 exhausted its five formal-review fix rounds. Task 8-R addresses one remaining concurrency defect and does not redesign feedback submission, evidence attachment, history, retention, or Task 11 cleanup.

## Problem

`waitForWinner` currently performs two transactions when it encounters an expired or malformed competing reservation:

1. It reloads the current account, business line, node, and winner reservation and authorizes the actor.
2. After that transaction finishes, it calls actorless `releaseReservation`, which rereads the reservation and mutates the reservation and node claim.

An administrator can disable the actor or remove the actor's relationship between those transactions. The request then eventually returns `FORBIDDEN`, but the second transaction may already have cleared the node claim and changed the winner reservation to `aborted`. An unauthorized request must never mutate either record.

## Security Invariant

Every actor-facing recovery transition must be linearizable with authorization:

- If revocation commits before the recovery transaction, the request returns `FORBIDDEN` and changes no reservation, node claim, evidence, or audit state.
- If the authorized recovery transaction commits before revocation, its mutation is valid at that transaction's serialization point.
- No actor-facing path may initiate recovery in a later actorless transaction based on an earlier authorization result.

## Chosen Architecture

### Authorized recovery start

The existing contention-poll transaction remains the authority boundary. After it reloads and validates the current actor, line, node, and winner, it will also:

1. Parse and validate the winner lease while still inside the transaction.
2. For an expired or malformed `reserved` winner, change that exact reservation to `aborting` with bounded recovery metadata.
3. Clear `feedbackClaimId`, `feedbackClaimHash`, and `feedbackClaimExpiresAt` only when the current node claim still equals the exact winner feedback ID.
4. Return an internal outcome indicating that rollback continuation is required.

Authorization, expiry classification, reservation transition, and matching node-claim release therefore commit atomically. A transaction conflict caused by concurrent revocation forces a retry, which rereads the now-disabled or unrelated actor and fails `FORBIDDEN` before mutation.

### Actorless rollback continuation

Evidence rollback may require multiple bounded transactions because a feedback can reference an unrestricted number of files. The existing recovery logic will be split conceptually into two responsibilities:

- **Start recovery:** changes `reserved` to `aborting` and releases the matching node claim. Actor-facing code may do this only in its authorized contention transaction. Task 11 may later have a separate internal maintenance entry point.
- **Continue recovery:** restores evidence orphan metadata in chunks and changes only an already-`aborting` reservation to `aborted`. It cannot turn `reserved` into `aborting` and cannot clear a node claim.

The actor-facing path may call only the continuation after its authorized transaction has committed the `aborting` state. A failure during continuation leaves a recoverable `aborting` record for idempotent retry or Task 11; it does not recreate the authorization race.

### Preserved behavior

- Published completed winners still produce `NODE_ALREADY_COMPLETED` only when line and node state prove completion.
- Published non-completion winners still produce `VERSION_CONFLICT`.
- Live reservations still end with retryable `FEEDBACK_COMMIT_IN_PROGRESS` after bounded polling.
- Missing winner records do not permit claim mutation.
- Already-aborted winners release only their exact matching stale claim inside the authorized poll transaction.
- Claim-chunk transactions and the 100-document-operation budget are unchanged.
- Internal Task 11 recovery remains actorless by design, but it must remain unreachable from public routes and ordinary feedback service calls.

## Error Handling

- Revoked, disabled, missing, unbound, reassigned, moved-node, or schema-changed actors receive `FORBIDDEN` before any recovery mutation.
- A claim ID mismatch is treated as non-owned state and is never cleared.
- A malformed lease is recoverable only for a currently authorized actor and is handled the same as an expired lease.
- Rollback continuation is idempotent. Repeating it against `aborting` or `aborted` state must not duplicate audit data or corrupt evidence metadata.
- Unexpected persistence failures retain the existing safe internal-error boundary; no reservation internals are exposed to the client.

## Test Design

Add a deterministic repository regression that pauses precisely after the first authorization read would previously have completed but before recovery mutation. For each revocation variant — disabled user, missing user, member removal, assignee removal, node movement, and relationship-schema change — assert:

- the public result is `FORBIDDEN`;
- the node retains the original winner claim;
- the winner remains `reserved`;
- evidence and audit records are unchanged.

Add authorized cases asserting that:

- an expired or malformed winner becomes `aborting` and the exact matching claim is cleared in the same transaction;
- a mismatched claim ID is not cleared;
- rollback continuation reaches `aborted` and restores evidence metadata idempotently;
- a fresh OR signer can retry after authorized recovery;
- published, live, missing, and already-aborted winner semantics remain unchanged;
- existing high-evidence-count transaction-budget coverage still passes.

The focused regression must fail against commit `2751617` before production code changes. Completion requires the focused repository suite, full backend suite, Mini Program tests, WXML structure test, JavaScript syntax checks, `git diff --check`, and project-memory validation.

## Scope

Expected production change:

- `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`

Expected tests and durable documentation:

- `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- test-harness code only if a deterministic between-transaction barrier cannot be expressed through the existing hooks
- `docs/memory/STATUS.md`
- `docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md` only after implementation verifies the refined invariant
- the Task 8-R implementation plan and review artifacts

No route, client UI, database collection, public response schema, business rule, or retention period changes are included.
