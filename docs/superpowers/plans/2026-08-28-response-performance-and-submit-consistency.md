# Response Performance and Submit Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce common-page cloud-function round trips and ensure successful authoritative submissions are always presented as successful.

**Architecture:** Add server-composed dashboard and node workspaces, then replace the dirty-draft two-call client submission with one idempotent orchestration route. Pages use user-keyed in-memory stale-while-revalidate data, while search indexing remains a recoverable derived projection whose failure cannot override an authoritative commit.

**Tech Stack:** Node.js 16.13, CloudBase document database, WeChat Mini Program JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-28-large-evidence-upload-and-response-performance-design.md`

## Global Constraints

- Dashboard first load uses one client cloud-function call instead of three.
- Node workspace first load uses one client cloud-function call instead of two serial calls.
- Dirty-draft submit without new uploads uses one client business call instead of save-then-submit calls.
- Cache is in-memory, keyed by internal account ID, cleared on account/session changes, and never persists business content.
- Authoritative write success remains success when `businessSearch` is pending.
- Existing authorization, version, request-key, reservation, review, notification, and audit invariants remain intact.

---

### Task 1: Add safe request timing

**Files:**
- Modify: `miniprogram/utils/cloud.js`
- Create: `miniprogram/test/cloud-performance.test.js`

**Interfaces:**
- Produces: `callBusinessApi` development timing events containing only action, duration, and safe outcome code.

- [ ] Write a failing test that forbids payload/account/content logging and expects one timing event per call.
- [ ] Run `node --test miniprogram/test/cloud-performance.test.js` and observe RED.
- [ ] Implement a clock-injected safe timing hook with no production content logging.
- [ ] Re-run the test and full mini-program suite; expect GREEN.
- [ ] Commit only Task 1 files as `perf: add safe cloud call timing`.

### Task 2: Compose the dashboard in one server call

**Files:**
- Create: `cloudfunctions/businessApi/lib/dashboard-workspace-service.js`
- Create: `cloudfunctions/businessApi/test/dashboard-workspace-service.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/dashboard/index.js`
- Modify: `miniprogram/test/business-template-flow.test.js`
- Modify: `miniprogram/test/notification-flow.test.js`

**Interfaces:**
- Produces: `getDashboardWorkspace({ actor }) -> { stats, recent }` with pending-review and unread-notification counts.

- [ ] Write failing service/route/client tests proving one client call and parallel independent reads.
- [ ] Run the focused tests and observe the old three-call behavior fail.
- [ ] Implement the composed service and route, replace client `Promise.all`, and preserve the safe projection.
- [ ] Add account-keyed in-memory stale-while-revalidate behavior that keeps existing cards visible on return.
- [ ] Run focused tests and the full businessApi/mini-program suites.
- [ ] Commit Task 2 files as `perf: compose dashboard workspace`.

### Task 3: Compose the node workspace in one server call

**Files:**
- Create: `cloudfunctions/businessApi/lib/node-workspace-service.js`
- Create: `cloudfunctions/businessApi/test/node-workspace-service.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/node-feedback/index.js`
- Modify: `miniprogram/test/node-feedback-v2.test.js`

**Interfaces:**
- Produces: `getNodeWorkspace({ actor, businessLineId, nodeId }) -> { line, node, canSubmit, history }`.

- [ ] Write failing tests proving one client call, strict line/node authorization, one safe projection, and no dirty-draft overwrite.
- [ ] Run focused tests and observe RED because the page calls detail then history.
- [ ] Implement the service using existing repositories, parallelizing only reads that are independent after authorization.
- [ ] Replace page `loadData` with the workspace call and retain sequence/account/version guards.
- [ ] Run focused and full suites.
- [ ] Commit Task 3 files as `perf: compose node workspace`.

### Task 4: Make search synchronization non-authoritative

**Files:**
- Modify: `cloudfunctions/businessApi/lib/business-service.js`
- Modify: `cloudfunctions/businessApi/lib/business-lifecycle-service.js`
- Modify: `cloudfunctions/businessApi/lib/feedback-service.js`
- Modify: `cloudfunctions/businessApi/lib/review-service.js`
- Modify: corresponding four `cloudfunctions/businessApi/test/*service.test.js` files

**Interfaces:**
- Produces: successful authoritative response with `searchIndexStatus: 'pending'` when `ensureIndexed` fails after commit.

- [ ] Change existing tests first so an indexing timeout expects authoritative success and a pending marker, while retries remain side-effect free.
- [ ] Run the four focused suites and observe RED against `BUSINESS_SEARCH_PENDING`.
- [ ] Implement one shared safe synchronization-result helper and use it in all four services.
- [ ] Run focused suites and the full businessApi suite.
- [ ] Commit Task 4 files as `fix: preserve authoritative success when search is pending`.

### Task 5: Add one-call save-and-submit orchestration

**Files:**
- Create: `cloudfunctions/businessApi/lib/node-submit-service.js`
- Create: `cloudfunctions/businessApi/test/node-submit-service.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/node-feedback/index.js`
- Modify: `miniprogram/test/review-flow.test.js`
- Modify: `miniprogram/test/node-feedback-v2.test.js`

**Interfaces:**
- Produces: `saveAndSubmitNodeForReview({ actor, input }) -> { feedbackId, reviewRoundId, nodeVersion, nodeStatus, searchIndexStatus }`.
- Input carries independent `progressRequestKey` and `reviewRequestKey`, the original expected node version, fields, comment, and evidence IDs.

- [ ] Write failing tests for one client call, save/review idempotency, response loss retry, partial completion recovery, version conflict, required evidence, and no duplicate audit/notification/review round.
- [ ] Run focused tests and observe RED because orchestration does not exist.
- [ ] Implement the service by composing existing idempotent feedback and review services, explicitly recovering a committed feedback before review retry.
- [ ] Replace dirty-draft page submission with the new route; keep the clean-stored-draft fast path.
- [ ] On ambiguous transport failure, reload `getNodeWorkspace` with the same request identity and treat `pending_review`/matching round as success; otherwise unlock without clearing fields/evidence.
- [ ] Run focused and full suites.
- [ ] Commit Task 5 files as `perf: submit node review in one business call`.

### Task 6: Local refresh and deployment performance gate

**Files:**
- Modify: `miniprogram/pages/business-detail/index.js`
- Modify: `miniprogram/test/business-template-flow.test.js`
- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `docs/memory/STATUS.md`

**Interfaces:**
- Preserves rendered detail during `onShow` background refresh and records the 256/512 MB A/B acceptance procedure.

- [ ] Write a failing page test proving an existing detail remains rendered during refresh and account changes clear it.
- [ ] Run focused RED, implement minimal stale-while-revalidate state, and run GREEN.
- [ ] Execute full cloud-function, mini-program, WXML, syntax, diff, and memory gates.
- [ ] Document measured client call counts and mark real-device latency and 512 MB A/B results `unverified` until deployment.
- [ ] Commit Task 6 files as `perf: keep rendered detail during refresh`.

