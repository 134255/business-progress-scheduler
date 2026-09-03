# 售后分支流程与条件字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将模板、售后快照和节点流转升级为单活动节点的通用有向无环路由，并交付单选字段级联、发起人加入处理人、全链路授权与下游一致性。

**Architecture:** 在现有 `businessApi` 中新增两个纯领域边界：`conditional-field-domain.js` 负责字段可见性、候选项和提交值规范化，`workflow-routing-domain.js` 负责流程图规范化、启用校验和完成节点后的唯一目标解析。模板启用时校验并摘要绑定完整图，售后创建时固化模式版本 2 快照；完成、审核和人工决定事务共同调用同一套路由投影，所有下游只消费实例的实际路线状态。

**Tech Stack:** Node.js CommonJS、`node:test`、腾讯 CloudBase 数据库事务、原生微信小程序 JavaScript/WXML/WXSS。

**Spec:** `docs/superpowers/specs/2026-09-03-branching-workflow-and-conditional-fields-design.md`

## Global Constraints

- 不新增外部工作流服务、付费模型、第三方运行时依赖、权限扩张或配额；若实现发现需要，立即停止并取得项目所有者确认。
- 模板最多 48 个节点；CloudBase 单事务保持不超过 100 次操作。
- 流程模式版本 2 恰好一个入口、全部节点可达、无自环或有向循环，允许嵌套分支和重新汇合，但同一售后只能有一个活动节点。
- 每个节点恰好使用 `end`、`default`、`single_select`、`manual` 一种后续模式，所有出口显式指向同模板稳定节点键或 `end`。
- 字段只能依赖同节点中位于自己之前的一个父单选字段；可多层级联，隐藏字段不得保存、检索或参与必填校验，节点凭证不随字段切换删除。
- 发起人通过独立标记加入固定处理人并去重；唯一发起人审核规则保持不变；实例解析后的处理人与审核人有交集即拒绝创建。
- 旧模板和旧售后不迁移；过渡读取必须失败关闭。真实数据清理必须在维护模式、只读清单、完整备份、精确数量及费用复核后再次取得破坏性操作确认。
- 任何节点完成、审核、人工决定和售后结束均使用版本比较与幂等键，不得重复激活、重复通知或重复产生派生来源。

---

### Task 1: 条件字段纯领域模型

**Files:**
- Create: `cloudfunctions/businessApi/lib/conditional-field-domain.js`
- Modify: `cloudfunctions/businessApi/lib/field-domain.js`
- Test: `cloudfunctions/businessApi/test/conditional-field-domain.test.js`
- Test: `cloudfunctions/businessApi/test/field-domain.test.js`

**Interfaces:**
- Produces: `normalizeConditionalFields(fields) -> FieldDefinition[]`
- Produces: `resolveConditionalFields(fields, submitted) -> { visibleDefinitions, valuesByKey, normalizedValues }`
- Produces: `clearInvalidConditionalValues(fields, submitted) -> { values, clearedFieldKeys }`
- Produces: `conditionalFieldDigestProjection(fields) -> object[]`

- [ ] **Step 1: Write failing normalization tests.** Cover a parent single-select, a child visible for selected parent values, per-parent child option sets, two-level nesting, duplicate rules, forward references, non-single-select parents, sparse/inherited/accessor arrays, dangerous keys, and invalid options.
- [ ] **Step 2: Run `node --test cloudfunctions/businessApi/test/conditional-field-domain.test.js`; expect failures because the module does not exist.**
- [ ] **Step 3: Implement strict own-data normalization.** Store each conditional field as `condition: { parentFieldKey, visibleWhen: string[], optionsByParentValue?: Record<string,string[]> }`; require its parent to precede it and require every configured option to come from the parent or child base option list.
- [ ] **Step 4: Add failing resolution tests.** Hand-check literals for visible required fields, hidden-field injection rejection, current-parent option rejection, descendant hiding, and cascade clearing after a parent changes.
- [ ] **Step 5: Extend `validateFieldValues` to call the conditional resolver and return only visible, sequence-sorted values; implement `clearInvalidConditionalValues` without mutating input.**
- [ ] **Step 6: Run `node --test cloudfunctions/businessApi/test/conditional-field-domain.test.js cloudfunctions/businessApi/test/field-domain.test.js`; expect all tests to pass.**
- [ ] **Step 7: Commit explicit Task 1 paths with `feat: add conditional field domain`.**

### Task 2: 流程图规范化、校验与目标解析

**Files:**
- Create: `cloudfunctions/businessApi/lib/workflow-routing-domain.js`
- Test: `cloudfunctions/businessApi/test/workflow-routing-domain.test.js`
- Modify: `cloudfunctions/businessApi/lib/template-domain.js`
- Test: `cloudfunctions/businessApi/test/template-domain.test.js`

**Interfaces:**
- Consumes: `conditionalFieldDigestProjection(fields)` from Task 1.
- Produces: `FLOW_SCHEMA_VERSION = 2` and `NEXT_MODE = { END, DEFAULT, SINGLE_SELECT, MANUAL }`.
- Produces: `normalizeWorkflowGraph({ entryNodeKey, nodes }) -> { flowSchemaVersion, entryNodeKey, nodes }`.
- Produces: `validateWorkflowGraph(graph) -> true`.
- Produces: `resolveCompletedNodeTarget({ node, fieldValues }) -> { kind: 'end' } | { kind: 'node', nodeKey: string } | { kind: 'manual' }`.

- [ ] **Step 1: Write failing graph tests.** Cover explicit end/default, complete single-select option mapping, manual activate/skip targets, nested branches, convergence, unknown target, duplicate stable key, multiple/missing entry, unreachable node, self-loop, longer cycle and 48/49-node boundaries.
- [ ] **Step 2: Run `node --test cloudfunctions/businessApi/test/workflow-routing-domain.test.js`; expect module-not-found failure.**
- [ ] **Step 3: Implement strict normalization and DFS reachability/cycle validation.** Normalize node routing as `next: { mode, targetNodeKey? , fieldKey?, optionTargets?, activateTarget?, skipTarget? }`, using the literal string `end` only as a terminal target.
- [ ] **Step 4: Add failing resolution tests.** Verify final field values choose exactly one option target, missing/hidden routing values fail with `BUSINESS_STATE_INVALID`, and manual mode returns no automatic target.
- [ ] **Step 5: Implement target resolution and integrate mode/version/entry/routing into `normalizeTemplateNode`, `templateDefinitionDigest`, participant collection and enable validation.** Retain a read-only legacy normalization path only until the approved reset.
- [ ] **Step 6: Run the routing and template domain suites; expect all tests to pass.**
- [ ] **Step 7: Commit explicit Task 2 paths with `feat: validate branching workflow graphs`.**

### Task 3: 模板服务、持久化和定义摘要

**Files:**
- Modify: `cloudfunctions/businessApi/lib/template-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-template-repository.js`
- Test: `cloudfunctions/businessApi/test/template-service.test.js`
- Test: `cloudfunctions/businessApi/test/cloud-template-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Test: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- Consumes: `normalizeWorkflowGraph`, `validateWorkflowGraph`, `FLOW_SCHEMA_VERSION`.
- Produces: template DTO fields `flowSchemaVersion`, `entryNodeKey`, node `next`, field `condition`, and `includeBusinessCreatorAsProcessor`.
- Preserves: template head `definitionNodeIds` plus `definitionDigest` atomically bind the full version-2 definition.

- [ ] **Step 1: Add failing service/repository tests for create, update, enable and read of a nested converging graph.** Assert digest changes when any edge, field condition, conditional option set or creator-processing flag changes.
- [ ] **Step 2: Run focused template suites and confirm expected missing-property or digest failures.**
- [ ] **Step 3: Replace mutually exclusive creator processor mode with `includeBusinessCreatorAsProcessor: boolean`; normalize legacy `business_creator` to true plus an empty fixed list only on the compatibility read path.** Keep `reviewerAssignmentMode` unchanged.
- [ ] **Step 4: Persist and return graph/condition fields through fixed-document transaction reads; recompute the complete digest before mutation and before enable.**
- [ ] **Step 5: Enforce worst-case transaction budget using source-node reads, snapshot writes, distinct fixed/creator participants and fixed operations; reject over-budget definitions before enable.**
- [ ] **Step 6: Run `node --test cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js`; expect pass.**
- [ ] **Step 7: Commit explicit Task 3 paths with `feat: persist versioned workflow definitions`.**

### Task 4: 售后创建快照与角色解析

**Files:**
- Modify: `cloudfunctions/businessApi/lib/business-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Test: `cloudfunctions/businessApi/test/business-service.test.js`
- Test: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/helpers/business-harness.js`

**Interfaces:**
- Produces line fields: `flowSchemaVersion`, `entryNodeId`, `currentNodeId`, `traversedNodeIds`, `routeDecisionVersion`.
- Produces node fields: immutable `nodeKey`, `next`, conditional `fields`, `routeState: 'dormant'|'active'|'completed'|'skipped'` and existing workflow/SLA/evidence policies.
- Produces role snapshots where `processorUserIds = unique(fixedProcessorUserIds + creator when flagged)`.

- [ ] **Step 1: Add failing snapshot tests for one active entry and dormant non-entry nodes, nested/converging edges translated from stable keys to snapshot node IDs, and creator/fixed processor merge and dedupe.**
- [ ] **Step 2: Add failing security tests for empty resolved processors, inactive participant, any processor/reviewer overlap including creator, tampered digest, unknown edge and transaction budget overflow.**
- [ ] **Step 3: Run focused business service/repository tests and confirm expected failures.**
- [ ] **Step 4: Implement immutable version-2 snapshot preparation and fixed-document transactional revalidation.** Only entry receives processing timestamps/due state; dormant nodes receive no clocks, pending state, notifications or search source.
- [ ] **Step 5: Return actual-path DTOs and keep legacy DTO parsing separate and failure-closed for malformed mixed schemas.**
- [ ] **Step 6: Run focused tests; expect pass and no regression in generated names, numbering or 120 MiB evidence policy.**
- [ ] **Step 7: Commit explicit Task 4 paths with `feat: snapshot branching after-sales workflows`.**

### Task 5: 通用原子路由推进器

**Files:**
- Create: `cloudfunctions/businessApi/lib/workflow-transition-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-workflow-transition-repository.js`
- Test: `cloudfunctions/businessApi/test/workflow-transition-service.test.js`
- Test: `cloudfunctions/businessApi/test/cloud-workflow-transition-repository.test.js`
- Modify: `cloudfunctions/businessApi/lib/optional-tail-domain.js`

**Interfaces:**
- Consumes: `resolveCompletedNodeTarget({ node, fieldValues })`.
- Produces: `inspectCompletion({ actor, businessLineId, nodeId, expectedLineVersion, expectedNodeVersion })`.
- Produces: `commitCompletion({ actor, input, context, timing, requestKeyHash, inputHash }) -> { nodeStatus, lineStatus, currentNodeId, routeState }`.
- Produces transition kinds: `complete_line`, `activate_node`, `await_manual_decision`, `finalized_retry`.

- [ ] **Step 1: Write failing service tests for end, default, single-select branches, second-level branch, convergence and manual wait.**
- [ ] **Step 2: Write failing repository tests proving compare-and-swap, one active node, idempotent retry, duplicate completion suppression, target integrity, no clock on dormant/skipped nodes and exact line freeze.**
- [ ] **Step 3: Run both new suites and confirm module-not-found failures.**
- [ ] **Step 4: Implement pure transition planning plus transaction reservation/commit using fixed line/current/target documents and existing work-calendar timing helpers.**
- [ ] **Step 5: Atomically mark the completed node route state, append to `traversedNodeIds`, activate exactly one target or freeze the line, and emit one notification/search/analytics source version.**
- [ ] **Step 6: Run new suites and existing optional-tail suite; expect pass.**
- [ ] **Step 7: Commit explicit Task 5 paths with `feat: add atomic workflow transitions`.**

### Task 6: 无审核完成、审核通过与驳回改选接入

**Files:**
- Modify: `cloudfunctions/businessApi/lib/feedback-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`
- Modify: `cloudfunctions/businessApi/lib/review-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`
- Modify: `cloudfunctions/businessApi/lib/node-submit-service.js`
- Test: `cloudfunctions/businessApi/test/feedback-service.test.js`
- Test: `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- Test: `cloudfunctions/businessApi/test/review-service.test.js`
- Test: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- Test: `cloudfunctions/businessApi/test/node-submit-service.test.js`

**Interfaces:**
- Consumes: Task 1 authoritative `validateFieldValues`; Task 5 transition context and commit contract.
- Produces: every successful node completion returns `routeTransition` and current target state.

- [ ] **Step 1: Add failing tests that both reviewerless completion and final approving vote select the same branch from the immutable final field snapshot.**
- [ ] **Step 2: Add failing tests for hidden-field injection, missing visible required field, invalid conditional option, processor first-winner concurrency, reviewer overlap denial and idempotent retries.**
- [ ] **Step 3: Add failing reject/resubmit tests proving parent selection may change before approval, stale descendants are cleared, and approved route becomes immutable.**
- [ ] **Step 4: Run focused feedback/review suites and confirm failures in the old sequential/optional-tail transitions.**
- [ ] **Step 5: Replace duplicated sequence/optional-tail completion branches with the transition repository while preserving immutable feedback, evidence reservations and review timing.**
- [ ] **Step 6: Run all five focused suites; expect pass.**
- [ ] **Step 7: Commit explicit Task 6 paths with `feat: route approved node completions`.**

### Task 7: 通用人工路由决定

**Files:**
- Create: `cloudfunctions/businessApi/lib/manual-route-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-manual-route-repository.js`
- Test: `cloudfunctions/businessApi/test/manual-route-service.test.js`
- Test: `cloudfunctions/businessApi/test/cloud-manual-route-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `miniprogram/services/business.js`
- Test: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- Produces API action `decideNodeRoute` with exact input `{ businessLineId, nodeId, expectedLineVersion, expectedNodeVersion, decision: 'activate'|'skip', comment, requestKey }`.
- Produces result `{ decision, lineStatus, currentNodeId, nodeVersion, lineVersion, searchIndexStatus? }`.

- [ ] **Step 1: Add failing tests for candidate-target-processor authorization, activate target, skip-to-target, skip-to-end, comment limits, inactive/unrelated account denial, concurrent first-success and exact idempotent replay.**
- [ ] **Step 2: Run focused tests and confirm the action/repositories are absent.**
- [ ] **Step 3: Implement inspect/commit with separate decision timing and target processing timing; authorize against the chosen target's immutable processor snapshot and never client-supplied participants.**
- [ ] **Step 4: Register the protected API route and client service.** Keep `decideOptionalTailNode` only as a legacy compatibility adapter until reset, not as a version-2 path.
- [ ] **Step 5: Run new suites plus route, optional-tail and business repository suites; expect pass.**
- [ ] **Step 6: Commit explicit Task 7 paths with `feat: add manual workflow decisions`.**

### Task 8: 工作区、待办、分享、搜索、提醒、日历、统计与保留一致性

**Files:**
- Modify: `cloudfunctions/businessApi/lib/node-workspace-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-share-repository.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-operations-repository.js`
- Modify: `cloudfunctions/businessSearch/lib/cloud-search-repository.js`
- Modify: `cloudfunctions/workflowReminder/lib/cloud-reminder-repository.js`
- Modify: `cloudfunctions/calendarSync/lib/cloud-calendar-repository.js`
- Modify: `cloudfunctions/operationsAnalytics/lib/analytics-domain.js`
- Modify: `cloudfunctions/operationsAnalytics/lib/cloud-analytics-repository.js`
- Modify: `cloudfunctions/evidenceRetention/lib/cloud-retention-repository.js`
- Test: matching repository/domain suites under each function.

**Interfaces:**
- Consumes route-state invariant: only `active`, `completed`, and `awaiting_manual_decision` nodes belong to the actual route; `dormant` and `skipped` never produce pending or historical projections.
- Produces actual-route display fields `completedNodeCount`, `traversedNodeCount`, `currentNodeName`, `awaitingManualDecision`.

- [ ] **Step 1: Add failing projection tests in each subsystem using the same fixture: one completed entry, one skipped branch, one active branch target, one dormant merge target.**
- [ ] **Step 2: Assert dormant/skipped nodes are absent from pending work, reminders, calendar recalculation, search text, public sharing and analytics samples; assert line-level retention begins only at true terminal state.**
- [ ] **Step 3: Run all focused downstream suites and confirm old sequence/optional-tail assumptions fail.**
- [ ] **Step 4: Update each query and integrity check to use snapshotted `routeState` plus line `traversedNodeIds/currentNodeId`; preserve authorization rechecks and bounded scans.**
- [ ] **Step 5: Generalize optional-tail decision metrics to manual-route decision metrics while retaining legacy reads until reset; keep source versions/idempotency unchanged.**
- [ ] **Step 6: Run the businessApi, businessSearch, workflowReminder, calendarSync, operationsAnalytics and evidenceRetention test suites; expect pass.**
- [ ] **Step 7: Commit explicit Task 8 paths with `feat: project only actual workflow routes`.**

### Task 9: 管理员模板编辑与只读流程预览

**Files:**
- Modify: `miniprogram/pages/admin-template-edit/index.js`
- Modify: `miniprogram/pages/admin-template-edit/index.wxml`
- Modify: `miniprogram/pages/admin-template-edit/index.wxss`
- Modify: `miniprogram/pages/admin-template-node-edit/index.js`
- Modify: `miniprogram/pages/admin-template-node-edit/index.wxml`
- Modify: `miniprogram/pages/admin-template-node-edit/index.wxss`
- Create: `miniprogram/pages/admin-template-flow/index.js`
- Create: `miniprogram/pages/admin-template-flow/index.json`
- Create: `miniprogram/pages/admin-template-flow/index.wxml`
- Create: `miniprogram/pages/admin-template-flow/index.wxss`
- Modify: `miniprogram/app.json`
- Test: `miniprogram/test/template-flow.test.js`

**Interfaces:**
- Consumes/produces the Task 3 template DTO without client-side alternative schema.
- Preview page receives only `templateId` and loads the authoritative definition via `getTemplate`.

- [ ] **Step 1: Add failing page-controller tests for creator-as-processor coexistence, all four next modes, option-to-node/end mapping, manual activate/skip targets, multiple branching nodes, nested graph and server validation error navigation.**
- [ ] **Step 2: Add failing conditional-field editor tests for parent selection, visible options, child option sets, dependency ordering and deletion guards.**
- [ ] **Step 3: Add failing flow-preview tests for entry, branches, convergence, nested branch, end targets and unreachable/cycle diagnostic rendering.**
- [ ] **Step 4: Run `node --test miniprogram/test/template-flow.test.js`; confirm old optional-tail-only UI fails.**
- [ ] **Step 5: Implement progressive forms and compact read-only list/tree preview; do not add phone drag-and-drop.** Remove the “固定唯一处理人” copy and use “售后发起人作为该节点处理人”.
- [ ] **Step 6: Run the template flow suite and WXML structure validator; expect pass.**
- [ ] **Step 7: Commit explicit Task 9 paths with `feat: edit and preview branching templates`.**

### Task 10: 节点填写级联、清空确认与智能填充

**Files:**
- Modify: `miniprogram/pages/node-feedback/index.js`
- Modify: `miniprogram/pages/node-feedback/index.wxml`
- Modify: `miniprogram/pages/node-feedback/index.wxss`
- Modify: `cloudfunctions/businessApi/lib/node-text-recognition-service.js`
- Test: `miniprogram/test/node-feedback-v2.test.js`
- Test: `miniprogram/test/node-text-recognition-flow.test.js`
- Test: `cloudfunctions/businessApi/test/node-text-recognition-service.test.js`

**Interfaces:**
- Client helper: `deriveConditionalForm(fields, fieldValues) -> { visibleFields, fieldValues, clearedFieldKeys }`.
- AI parsing receives only currently visible definitions and returned candidates are revalidated against current conditional option sets.

- [ ] **Step 1: Add failing client tests for initial hiding, parent selection reveal, per-parent picker options, multi-level reveal and user-confirmed cascade clearing while evidence list remains unchanged.**
- [ ] **Step 2: Add failing tests for canceling a branch change, preserving unrelated field values, draft reload, server refresh and submit payload excluding hidden values.**
- [ ] **Step 3: Add failing recognition tests proving hidden fields are not offered to the parser and stale/invalid child options are rejected after the parent changes.**
- [ ] **Step 4: Run the three focused suites and confirm expected failures.**
- [ ] **Step 5: Implement one immutable form-state update path for input/blur/picker/AI application; show an explicit confirmation before clearing non-empty descendants and preserve node evidence.**
- [ ] **Step 6: Run focused suites plus global form-style and WXML validators; expect pass.**
- [ ] **Step 7: Commit explicit Task 10 paths with `feat: add cascading node fields`.**

### Task 11: 售后详情、实际路径进度和人工决定 UI

**Files:**
- Modify: `miniprogram/pages/business-detail/index.js`
- Modify: `miniprogram/pages/business-detail/index.wxml`
- Modify: `miniprogram/pages/business-detail/index.wxss`
- Modify: `miniprogram/pages/dashboard/index.js`
- Modify: `miniprogram/pages/dashboard/index.wxml`
- Test: `miniprogram/test/business-template-flow.test.js`
- Test: `miniprogram/test/pending-processing-flow.test.js`
- Test: `miniprogram/test/public-node-share-flow.test.js`

**Interfaces:**
- Consumes Task 8 actual-route DTO and Task 7 `decideNodeRoute` API.
- Shows no percentage while a version-2 line is active; terminal completed lines show 100%.

- [ ] **Step 1: Add failing tests for completed-count/current-node/path display, omission of dormant/skipped node cards, no active percentage, terminal 100%, and manual-decision actions visible only to authorized target processors.**
- [ ] **Step 2: Add failing tests for activate/skip confirmation, request key stability, retry/idempotent result, target refresh and unrelated-user denial.**
- [ ] **Step 3: Run focused suites and confirm old percentage/optional-tail assumptions fail.**
- [ ] **Step 4: Implement actual-route cards and manual decision UI using the existing visual system and safe error messages.**
- [ ] **Step 5: Run focused suites and WXML validator; expect pass.**
- [ ] **Step 6: Commit explicit Task 11 paths with `feat: show actual after-sales workflow paths`.**

### Task 12: 受控重置工具、部署手册和自动验收

**Files:**
- Create: `tools/branch-workflow-reset-dry-run.mjs`
- Create: `tools/test-branch-workflow-reset-dry-run.mjs`
- Create: `docs/deployment/branch-workflow-v2.md`
- Modify: `docs/memory/STATUS.md`

**Interfaces:**
- Dry-run accepts environment-provided read-only connection configuration and emits only collection/object counts plus opaque internal IDs; it never deletes and never writes secrets/log records.
- Destructive mode is intentionally absent from this task and requires a separate exact-target approval after backup verification.

- [ ] **Step 1: Write a failing fixture-driven test that inventories every approved cleanup collection, derives exact managed COS object keys from valid evidence records, excludes accounts/security/counters/audits, and rejects malformed or cross-prefix objects.**
- [ ] **Step 2: Run `node tools/test-branch-workflow-reset-dry-run.mjs`; confirm the script is absent.**
- [ ] **Step 3: Implement the read-only inventory script with pagination, bounded output and redaction; do not add any delete API.**
- [ ] **Step 4: Write the deployment order: backup verification, deploy exact commits, create/check indexes without permission expansion, upload Mini Program, isolated v2 acceptance, read-only inventory, renewed destructive confirmation, maintenance reset, post-reset login/data/object checks and rollback.**
- [ ] **Step 5: Document the manual matrix for DevTools, iPhone, Android/HarmonyOS and Mac: nested single-select route, manual route, convergence, creator processor, role-overlap denial, search/share/pending/analytics exclusions and 120 MiB upload regression.**
- [ ] **Step 6: Run the dry-run test, `git diff --check` and project-memory validator; expect pass.**
- [ ] **Step 7: Commit explicit Task 12 paths with `docs: add branch workflow deployment gates`.**

### Task 13: 全量验证、审查与发布准备

**Files:**
- Modify: `docs/memory/STATUS.md`
- Modify only if stable facts changed: `docs/memory/PROJECT.md`

**Interfaces:**
- Produces a reviewable branch whose functional commits exclude `project.config.json`, operator deployment output and secrets.

- [ ] **Step 1: Run `npm.cmd test --prefix cloudfunctions/businessApi`.**
- [ ] **Step 2: Run every other cloud function suite with `npm.cmd test --prefix` for `businessSearch`, `workflowReminder`, `calendarSync`, `operationsAnalytics` and `evidenceRetention`.**
- [ ] **Step 3: Run `node --test miniprogram/test/*.test.js` using a PowerShell-expanded explicit file list, then `node tools/test-wxml-structure.mjs`.**
- [ ] **Step 4: Run JavaScript syntax checks for every changed `.js`/`.mjs`, `git diff --check`, and inspect `git diff --stat`, `git status --short` and every staged path.**
- [ ] **Step 5: Review mutations for wrong edge target, missing visibility filter, duplicate activation, stale version acceptance, unauthorized manual decision, hidden-field injection, dormant-node projection and accidental evidence deletion; add a RED/GREEN regression test for every uncovered mutation.**
- [ ] **Step 6: Update `docs/memory/STATUS.md` with exact pass/fail counts, unverified real-cloud boundaries and the next deployment action; update `PROJECT.md` only for verified stable facts.**
- [ ] **Step 7: Run `python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .`; expect pass.**
- [ ] **Step 8: Commit only explicit feature/memory paths, prepare an exact deployment manifest and stop before any paid, permission-expanding or destructive operation for renewed approval.**
