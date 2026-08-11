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
- Mark ordinary attached evidence with the explicit pair `retentionScope: business_line` and `retentionSource: node_feedback`; access and history derive its effective deadline from the strict line `purgeDueAt`. Every terminal line state (`completed`, `cancelled`, `closed`, or `deleted`) requires a valid non-null line deadline. Reserve `retentionScope: evidence` plus `retentionSource: audit_amendment` for Task 9 corrections, which require their own strict evidence deadline and may outlive the line. A shared classifier rejects unknown, mismatched, missing, or malformed retention metadata for new records; absent scope/source is accepted only through the explicit legacy `evidenceIds` history adapter. Unattached uploads remain governed by their orphan lease.
- Failed claims eagerly move the reservation through aborting to aborted, release the node lock, and restore evidence orphan state in bounded chunks. Reservations carry an expiry so the Task 11 worker can idempotently recover interrupted claims and must not delete evidence owned by a live claim.
- Every actor-facing transition from `reserved` to `aborting` commits in the same fixed-document transaction that reloads and authorizes the current actor, business line, node, and exact reservation. Before interpreting reservation state or lease metadata, same-request and OR paths require the stored reservation ID, business-line ID, and node ID to match the trusted request and node claim. OR recovery additionally requires the node to still claim that exact winner. Actorless rollback continuation can process only an already-`aborting` reservation. The repository-only Task 11 maintenance entry may start genuinely expired recovery without an actor, but may clear a node claim only when the node still belongs to the reservation business line; it is never exposed through ordinary services or routes.
- 新版审核节点沿用同一分块预约协议保存每次处理进度，并把 `processingRoundNumber` 固定到已发布反馈及其已认领凭证。提交审核时按每页 100 条读取当前处理轮的不可变反馈与凭证：字段取最新已发布修订的快照，凭证取本轮各修订中仍有效且归属一致的全集并按首次出现去重；审核轮次只引用这些既有凭证编号，不重新认领或修改附件归属。

## Consequences

- There is no application evidence-count cap; CloudBase request and document physical byte limits still apply and must be documented operationally rather than presented as a business rule.
- `node_feedback` and `evidences` contain internal reservation/recovery fields that are never returned by protected history projections.
- Task 11 must scan and recover expired non-published reservations before orphan cleanup, treating a non-expired claim as protected from deletion.
- Task 11 recovery must also clear a stale node claim when its referenced reservation document is missing; otherwise the node can remain permanently locked without a recoverable lease record.
- Task 11 must also scan due completed lines and process every evidence record by `businessLineId` in bounded chunks. History and evidence access derive the ordinary effective deadline from the line, so evidence attached to earlier revisions is not retained indefinitely. Task 9 audit-amendment evidence may own a later explicit deadline, which takes precedence over the line deadline when Task 11 is implemented.
- Deployment must retain the planned `node_feedback.nodeId + revision` and evidence relationship indexes; history and recovery additionally query evidence by stable `feedbackId`.
- 审核提交的分页聚合不增加单次事务文档预算；最终创建审核轮次的事务只复核固定文档，并保持在 CloudBase 100 次文档操作限制以内。
