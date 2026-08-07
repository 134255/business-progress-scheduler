# ADR-0003: Chunked feedback evidence reservations

## Status

Accepted on 2026-08-07.

## Context

A feedback may contain any business-level number of evidence files as long as their exact aggregate size does not exceed 20 MB. CloudBase transactions are limited to 100 document operations, so a single transaction cannot safely re-read and attach an unbounded number of fixed evidence documents. Adding a file-count limit would contradict the approved product rule, while publishing a feedback before all evidence is claimed would expose partial history and make flow advancement unsafe.

## Decision

- Use a deterministic hidden `node_feedback` reservation keyed by a SHA-256 identity derived from account ID, node ID, and request key. Store only safe hashes, counts, aggregate bytes, field snapshots, claim progress, lease/recovery metadata, and the eventual immutable feedback content; never store the raw request key or an unbounded evidence-ID manifest.
- Place one bounded claim identity on the current node. Different OR-sign requests wait/recheck that identity. `NODE_ALREADY_COMPLETED` is returned only when a published completed winner and the node/line state both prove that the flow completed; published non-completion winners are conflicts, live reservations return retryable `FEEDBACK_COMMIT_IN_PROGRESS`, and aborted or expired winners release their claims for a fresh attempt.
- Claim evidence by fixed document ID in chunks of at most 40. Each claim transaction re-reads the active actor, line, node, reservation, and evidence documents and stays below the 100-operation CloudBase limit. A tamper-evident cursor digest binds prefix count, aggregate bytes, and ordered-ID digest so a retry cannot skip, reorder, or corrupt claim progress.
- Link evidence to the stable final feedback ID while the feedback remains hidden. Clear orphan expiry during a live claim and retain rollback-only expiry metadata. History exposes only `publishState: published` feedback and obtains bounded safe evidence projections by `feedbackId`.
- A final transaction re-reads actor, line, node, and reservation, verifies complete counts/digests/bytes, publishes the next immutable revision, advances or completes the flow, freezes a completed line, and writes exactly one deterministic audit record. Only `completed` on the last node freezes the line. That transaction stores the authoritative `retentionStartedAt` and `purgeDueAt` on the completed line; ordinary feedback attachment does not stamp per-evidence retention metadata.
- Failed claims eagerly move the reservation through aborting to aborted, release the node lock, and restore evidence orphan state in bounded chunks. Reservations carry an expiry so the Task 11 worker can idempotently recover interrupted claims and must not delete evidence owned by a live claim.

## Consequences

- There is no application evidence-count cap; CloudBase request and document physical byte limits still apply and must be documented operationally rather than presented as a business rule.
- `node_feedback` and `evidences` contain internal reservation/recovery fields that are never returned by protected history projections.
- Task 11 must scan and recover expired non-published reservations before orphan cleanup, treating a non-expired claim as protected from deletion.
- Task 11 must also scan due completed lines and process every evidence record by `businessLineId` in bounded chunks. History and evidence access derive the ordinary effective deadline from the line, so evidence attached to earlier revisions is not retained indefinitely. Task 9 audit-amendment evidence may own a later explicit deadline, which takes precedence over the line deadline when Task 11 is implemented.
- Deployment must retain the planned `node_feedback.nodeId + revision` and evidence relationship indexes; history and recovery additionally query evidence by stable `feedbackId`.
