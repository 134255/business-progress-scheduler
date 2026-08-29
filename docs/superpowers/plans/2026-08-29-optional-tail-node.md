# 可选追加节点与全节点可免审核 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模板可在必经流程末尾配置一个由候选处理人决定开启或跳过的可选追加节点，同时让任何新版节点在审核人留空时由处理人直接完成。

**Architecture:** 在模板与售后实例之间保留不可变的 `activationMode` 和角色快照，并用统一的节点完成转移分类器驱动审核通过、无审核直接完成两条路径。待决定操作由独立服务和 CloudBase 事务仓储提供，通过售后线/节点版本与确定性请求指纹保证首个成功决定生效。提醒、检索、分享、统计和保留只消费权威状态，不从客户端推测。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、CloudBase Node.js 16 云函数、CloudBase 文档数据库事务、`node:test`、现有内存 CloudBase 测试夹具。

**Spec:** `docs/superpowers/specs/2026-08-29-optional-tail-node-design.md`

## Global Constraints

- 每个模板最多一个 `optional_tail`，且必须是最后一个节点；旧数据缺失 `activationMode` 时按 `required` 解释。
- 无审核人节点必须仍为 `workflowMode: "review"`，只是 `reviewerUserIds` 为空；不能回退到旧直接反馈流程。
- 处理人仍必填且与审核人不得重叠；发起人角色在售后创建事务内解析后再执行重叠检查。
- 可选节点在售后创建时预生成稳定编号和完整快照，但以 `awaiting_decision` 休眠；模板后续修改不得影响实例。
- 待决定期不写 `processingStartedAt`、不计处理截止时间、不计处理逾期；开启时才启动普通节点计时。
- 跳过可选节点不产生处理/审核时长样本；开启后不得再改为跳过。
- 售后只在无可选节点、可选节点被跳过，或已开启可选节点真正完成时写入完成、冻结、统计和 60 天保留边界。
- 多候选人决定使用事务内活动账号、角色快照、售后版本、节点版本和请求指纹复核；只有首个有效决定成功。
- 新状态与字段只接受对象自有数据属性；访问器、继承值、稀疏/重复数组、未知枚举和损坏时间失败关闭。
- 不新增集合、不迁移历史数据、不改变旧售后已存审核历史；部署前只增加实现查询确认必需的组合索引。
- 所有生产改动必须先写可观察行为测试并运行得到预期 RED，再写最小 GREEN；每个任务单独提交。
- 不读取业务含义、不修改、不暂存、不提交用户自有的 `project.config.json` 和 `outputs/deploy/`。

---

### Task 1：模板域与稳定定义摘要

**Files:**

- Create: `cloudfunctions/businessApi/lib/optional-tail-domain.js`
- Modify: `cloudfunctions/businessApi/lib/template-domain.js`
- Modify: `cloudfunctions/businessApi/test/template-domain.test.js`
- Modify: `cloudfunctions/businessApi/test/template-service.test.js`

**Interfaces:**

- Produces: `ACTIVATION_MODE = { REQUIRED: 'required', OPTIONAL_TAIL: 'optional_tail' }`
- Produces: `normalizeActivationMode(node): 'required' | 'optional_tail'`
- Produces: `classifyCompletedNodeTransition({ line, node, nextNode }): 'next_node' | 'await_optional_decision' | 'complete_line'`
- Produces: normalized template-node property `activationMode`
- Consumes: existing `normalizeDefinitionNodes`, `templateDefinitionDigest`, `validateTemplateForEnable`

- [ ] **Step 1: Write failing template-domain tests**

Add explicit assertions:

```js
assert.equal(normalizeTemplateNode({ ...reviewNode }).activationMode, 'required')
assert.equal(normalizeTemplateNode({
  ...reviewNode,
  activationMode: 'optional_tail',
  reviewerUserIds: []
}).activationMode, 'optional_tail')
assert.doesNotThrow(() => validateTemplateForEnable(template, [{
  ...reviewNode,
  reviewerAssignmentMode: 'fixed_accounts',
  reviewerUserIds: []
}], activeUserIds))
assert.throws(() => validateTemplateForEnable(template, [
  { ...reviewNode, sequence: 0, activationMode: 'optional_tail' },
  { ...reviewNode, nodeKey: 'second', sequence: 1, activationMode: 'required' }
], activeUserIds), error => error.code === 'TEMPLATE_INVALID')
assert.throws(() => validateTemplateForEnable(template, [
  { ...reviewNode, sequence: 0, activationMode: 'optional_tail' },
  { ...reviewNode, nodeKey: 'second', sequence: 1, activationMode: 'optional_tail' }
], activeUserIds), error => error.code === 'TEMPLATE_INVALID')
```

Also cover unknown/accessor/inherited `activationMode`, optional tail without processors, empty fixed reviewers, creator reviewer mode, resolved processor/reviewer overlap, digest difference between required and optional definitions, and unchanged legacy-node normalization.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js
```

Expected: failures show missing `activationMode`, duplicate/misordered optional tails accepted, and empty reviewers rejected by the old enablement rule.

- [ ] **Step 3: Implement the strict domain contract**

Create `optional-tail-domain.js` with descriptor-safe constants and a pure transition classifier:

```js
const ACTIVATION_MODE = Object.freeze({ REQUIRED: 'required', OPTIONAL_TAIL: 'optional_tail' })

function classifyCompletedNodeTransition({ line, node, nextNode }) {
  if (node.sequence + 1 >= line.nodeCount) return 'complete_line'
  if (nextNode.activationMode === ACTIVATION_MODE.OPTIONAL_TAIL) return 'await_optional_decision'
  return 'next_node'
}
```

Normalize absence to `required`, include the field in `templateDefinitionDigest`, allow a strictly empty fixed reviewer array, enforce exactly zero or one optional tail at the end, and retain nonempty active processors plus role separation.

- [ ] **Step 4: Run GREEN and commit**

Run the focused command again, then:

```powershell
git add -- cloudfunctions/businessApi/lib/optional-tail-domain.js cloudfunctions/businessApi/lib/template-domain.js cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js
git commit -m "feat: define optional tail template nodes"
```

---

### Task 2：模板管理页配置可选节点和免审核

**Files:**

- Modify: `miniprogram/pages/admin-template-node-edit/index.js`
- Modify: `miniprogram/pages/admin-template-node-edit/index.wxml`
- Modify: `miniprogram/pages/admin-template-node-edit/index.wxss`
- Modify: `miniprogram/pages/admin-template-edit/index.js`
- Modify: `miniprogram/pages/admin-template-edit/index.wxml`
- Modify: `miniprogram/test/template-flow.test.js`

**Interfaces:**

- Consumes: Task 1 node field `activationMode`
- Produces: node editor draft `{ activationMode, reviewerUserIds: [] }`
- Produces: template editor route parameter `optionalTailExistsOutsideCurrentNode: '1' | '0'`

- [ ] **Step 1: Write failing client-flow tests**

Add assertions proving the node editor:

```js
assert.equal(page.data.activationMode, 'required')
page.onOptionalTailChange({ detail: { value: true } })
assert.equal(page.data.activationMode, 'optional_tail')
page.setData({ reviewerAssignmentMode: 'fixed_accounts', reviewerUserIds: [] })
assert.doesNotThrow(() => page.buildSubmission())
assert.match(renderedWxml, /无需审核，处理人可直接完成/)
```

Also assert a second optional tail is disabled with an explanatory message, an optional tail cannot move upward, a required node can still move normally, read-only enabled templates cannot toggle either setting, and the summary displays `可选追加节点` plus `无需审核`.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test miniprogram/test/template-flow.test.js
```

Expected: failures show the missing toggle/summary and the old client validation message requiring at least one reviewer.

- [ ] **Step 3: Implement the editor behavior**

Add the switch and explanatory copy, keep an existing optional tail fixed at the final position, block choosing another one, remove the fixed-reviewer nonempty validation, and hide/disable review mode controls when reviewers are empty. Preserve processor checks and role-overlap checks.

- [ ] **Step 4: Run GREEN and commit**

Run the focused test and WXML structure test:

```powershell
node --test miniprogram/test/template-flow.test.js
node tools/test-wxml-structure.mjs
git add -- miniprogram/pages/admin-template-node-edit/index.js miniprogram/pages/admin-template-node-edit/index.wxml miniprogram/pages/admin-template-node-edit/index.wxss miniprogram/pages/admin-template-edit/index.js miniprogram/pages/admin-template-edit/index.wxml miniprogram/test/template-flow.test.js
git commit -m "feat: configure optional and reviewerless nodes"
```

---

### Task 3：售后创建快照与读投影

**Files:**

- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/lib/business-service.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/business-service.test.js`
- Modify: `cloudfunctions/businessApi/test/dashboard-workspace-service.test.js`
- Modify: `cloudfunctions/businessApi/test/node-workspace-service.test.js`

**Interfaces:**

- Consumes: Task 1 `ACTIVATION_MODE`
- Produces business line fields: `optionalTailNodeId`, `optionalTailState: 'none' | 'pending' | 'activated' | 'skipped' | 'completed'`
- Produces optional node initial state: `status: 'awaiting_decision'`
- Produces node snapshot fields: `activationMode`, strict `reviewerUserIds` that may be empty
- Produces workspace flags: `isOptionalTail`, `requiresReview`, `canDecideOptionalTail`

- [ ] **Step 1: Write failing snapshot tests**

Create a two-required-plus-one-optional template and assert:

```js
assert.equal(line.optionalTailState, 'none')
assert.equal(line.optionalTailNodeId, optionalNode._id)
assert.equal(optionalNode.activationMode, 'optional_tail')
assert.equal(optionalNode.status, 'awaiting_decision')
assert.equal(optionalNode.processingStartedAt, undefined)
assert.deepEqual(optionalNode.reviewerUserIds, [])
```

Also mutate the source template after creation and prove the instance snapshot does not change; assert a template without optional tail omits the node id and uses `optionalTailState: 'none'`; assert read projections accept an own empty reviewer array but reject missing/accessor/inherited/corrupt relationship arrays.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/dashboard-workspace-service.test.js cloudfunctions/businessApi/test/node-workspace-service.test.js
```

Expected: optional nodes start as ordinary `waiting`, empty reviewers fail projection, and optional line metadata is absent.

- [ ] **Step 3: Implement immutable instance snapshots**

During `preparedSnapshot`, copy `activationMode`, use `awaiting_decision` for the optional tail, and keep only the first required node `ready`. Resolve creator/fixed roles exactly as today, allowing only a valid own empty reviewer array. Store the optional node id on the line and expose only safe booleans/enums through workspaces.

- [ ] **Step 4: Run GREEN and commit**

Run the focused command, then:

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/lib/business-service.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/dashboard-workspace-service.test.js cloudfunctions/businessApi/test/node-workspace-service.test.js
git commit -m "feat: snapshot optional tail instances"
```

---

### Task 4：待决定操作的服务、事务与路由

**Files:**

- Create: `cloudfunctions/businessApi/lib/optional-tail-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-optional-tail-repository.js`
- Create: `cloudfunctions/businessApi/test/optional-tail-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-optional-tail-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**

- Produces: `createOptionalTailService({ repository, workTimeService, clock, businessSearchClient })`
- Produces: `decide({ actor, input }): Promise<{ decision, lineStatus, nodeStatus, lineVersion, nodeVersion }>`
- Input: `{ businessLineId, nodeId, expectedLineVersion, expectedNodeVersion, decision: 'activate' | 'skip', comment, requestKey }`
- Repository methods: `inspectDecision(value)` and `commitDecision({ ...value, context, timing })`
- Route: protected action `decideOptionalTailNode`
- Produces node decision fields: `decisionStartedAt`, `decisionAt`, `decisionActorId`, `decisionComment`, `decisionTimingStatus: 'calculated' | 'pending_calendar'`, `decisionWorkMinutes`, `decisionCalendarVersion`

- [ ] **Step 1: Write failing service and repository tests**

Cover these literal outcomes:

```js
assert.deepEqual(await service.decide({ actor, input: activateInput }), {
  decision: 'activate', lineStatus: 'active', nodeStatus: 'ready', lineVersion: 6, nodeVersion: 2
})
await assert.rejects(
  service.decide({ actor: unrelatedActor, input: activateInput }),
  error => error.code === 'FORBIDDEN'
)
```

Repository tests must prove: active candidate authorization; inactive candidate denial; exact pending line/node relationship; both decisions calculate work minutes from `decisionStartedAt` to `decisionAt`, preserving `pending_calendar` when the calendar is incomplete; activate writes `processingStartedAt` and calculated/pending-calendar due fields; skip writes `status: 'skipped'`, completes/freezes the line, starts retention, marks analytics pending, stores decision actor/time/comment; both paths write redacted audit and notification; same request is idempotent; a different concurrent decision with old versions returns `VERSION_CONFLICT`; activate cannot later skip; no client identity field is accepted.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/optional-tail-service.test.js cloudfunctions/businessApi/test/cloud-optional-tail-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

Expected: module-not-found failures for the new service/repository and unknown action for the route.

- [ ] **Step 3: Implement the decision path**

Normalize only the declared input keys, hash the request identity, calculate decision work minutes for both outcomes, calculate the processing deadline only for `activate`, and let the transaction re-read the actor, line, node and versions. Use deterministic audit/notification ids derived from the request hash without storing the raw request key. For `skip`, set `optionalTailState: 'skipped'`; for activation set it to `activated` and clear decision-reminder fields. Persist audit actions `ACTIVATE_OPTIONAL_TAIL` or `SKIP_OPTIONAL_TAIL`; activation emits the ordinary `node_processing_started` notification and skip emits the ordinary terminal-completion notification without exposing the raw comment.

- [ ] **Step 4: Wire default production dependencies**

Instantiate `cloud-optional-tail-repository` beside the existing business/review repositories, add `createOptionalTailRoutes`, and expose only:

```js
new Set([
  'businessLineId', 'nodeId', 'expectedLineVersion', 'expectedNodeVersion',
  'decision', 'comment', 'requestKey'
])
```

- [ ] **Step 5: Run GREEN and commit**

Run the focused command, then:

```powershell
git add -- cloudfunctions/businessApi/lib/optional-tail-service.js cloudfunctions/businessApi/lib/cloud-optional-tail-repository.js cloudfunctions/businessApi/test/optional-tail-service.test.js cloudfunctions/businessApi/test/cloud-optional-tail-repository.test.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js
git commit -m "feat: add optional tail decisions"
```

---

### Task 5：无审核人节点直接完成

**Files:**

- Modify: `cloudfunctions/businessApi/lib/feedback-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`
- Modify: `cloudfunctions/businessApi/test/feedback-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- Modify: `cloudfunctions/businessApi/lib/node-submit-service.js`
- Modify: `cloudfunctions/businessApi/test/node-submit-service.test.js`

**Interfaces:**

- Extends: `saveNodeProgress` action union with `'complete_node'`
- Consumes: Task 1 `classifyCompletedNodeTransition`
- Produces feedback reservation field: `completionTransition: 'next_node' | 'await_optional_decision' | 'complete_line'`
- Produces result: `{ feedbackId, revision, nodeStatus, lineStatus, nextNodeId, optionalTailState }`

- [ ] **Step 1: Write failing direct-completion tests**

Add cases proving:

```js
const result = await service.saveNodeProgress({ actor: processor, input: {
  ...validProgressInput,
  action: 'complete_node'
} })
assert.equal(result.nodeStatus, 'completed')
assert.equal(reviewRounds.length, 0)
assert.equal(reviewVotes.length, 0)
```

Also prove `complete_node` rejects nodes with nonempty reviewers, missing required fields/evidence, non-processor, stale version, non-current node, and dormant optional tail. Cover all three transitions: required next node becomes `ready`; optional tail becomes `awaiting_decision` and line stays active; real terminal completes/freezes line exactly once. Retry with the same request returns the same result and does not duplicate evidence claims/audit/notifications.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/node-submit-service.test.js
```

Expected: `complete_node` fails input normalization and old `freezesLine` logic cannot enter `await_optional_decision`.

- [ ] **Step 3: Implement direct completion through the feedback reservation**

Map `complete_node` to persisted feedback status `completed`, require an own empty `reviewerUserIds`, and preserve the existing field/evidence validation and chunked reservation. Replace `freezesLine` with the explicit transition. On `await_optional_decision`, complete the current node, move the line pointer to the optional tail, set `decisionStartedAt`, initialize `nextDecisionReminderWorkHour: 1`, and create exactly one deterministic `optional_tail_decision_started` notification without writing processing due fields. Direct completion records audit action `COMPLETE_NODE_WITHOUT_REVIEW`.

- [ ] **Step 4: Keep combined submit behavior explicit**

Make `node-submit-service` reject a reviewerless node for `save_and_submit_review`; the client must call `saveNodeProgress` with `complete_node` instead. This prevents accidental creation of empty-reviewer rounds.

- [ ] **Step 5: Run GREEN and commit**

Run the focused command, then:

```powershell
git add -- cloudfunctions/businessApi/lib/feedback-service.js cloudfunctions/businessApi/lib/cloud-feedback-repository.js cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/lib/node-submit-service.js cloudfunctions/businessApi/test/node-submit-service.test.js
git commit -m "feat: complete reviewerless nodes directly"
```

---

### Task 6：审核通过路径接入统一转移

**Files:**

- Modify: `cloudfunctions/businessApi/lib/review-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`
- Modify: `cloudfunctions/businessApi/test/review-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`

**Interfaces:**

- Consumes: Task 1 `classifyCompletedNodeTransition`
- Extends review transition union with `'await_optional_decision'`
- Produces review result fields: `lineStatus: 'active'`, `nextNodeId`, `optionalTailState: 'pending'` for this transition

- [ ] **Step 1: Write failing review transition tests**

Add repository/service cases where the final required node is approved before an optional tail:

```js
assert.equal(context.transition, 'await_optional_decision')
assert.equal(result.lineStatus, 'active')
assert.equal(result.nextNodeId, optionalNode._id)
assert.equal(optionalNodeAfter.status, 'awaiting_decision')
assert.equal(lineAfter.optionalTailState, 'pending')
assert.equal(lineAfter.completedAt, undefined)
assert.equal(lineAfter.retentionStartedAt, undefined)
```

Also prove a required next node with empty reviewers can be activated, ordinary reviewed nodes retain all OR/ALL/reject/rework behavior, no-optional final approval still completes, and retry reconstruction validates the same transition instead of trusting saved context.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

Expected: old code classifies the last required node as `next_node` but rejects the optional node's empty reviewers, or completes the line too early.

- [ ] **Step 3: Implement the shared transition contract**

Permit own empty reviewer arrays only on the *next* node snapshot, add `await_optional_decision` to service timing validation with no processing deadline calculation, and write the same pending-decision fields/notification contract as Task 5. Keep current-round reviewer authorization strictly nonempty. Reuse the exact `optional_tail_decision_started` notification and decision-reminder initialization contract from Task 5 so both completion routes project the same state.

- [ ] **Step 4: Run GREEN and commit**

Run the focused command, then:

```powershell
git add -- cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
git commit -m "feat: await optional tail after review"
```

---

### Task 7：待处理、通知和工作小时提醒

**Files:**

- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `cloudfunctions/workflowReminder/lib/reminder-service.js`
- Modify: `cloudfunctions/workflowReminder/lib/cloud-reminder-repository.js`
- Modify: `cloudfunctions/workflowReminder/test/reminder-service.test.js`
- Modify: `cloudfunctions/workflowReminder/test/cloud-reminder-repository.test.js`
- Modify: `miniprogram/pages/notification-list/index.js`
- Modify: `miniprogram/test/pending-processing-flow.test.js`
- Modify: `miniprogram/test/notification-flow.test.js`

**Interfaces:**

- Extends pending-processing node statuses with `'awaiting_decision'`
- Produces reminder repository methods: `listDueOptionalTailDecisions`, `createOptionalTailDecisionReminder`, `advanceOptionalTailDecisionCursor`
- Produces notification type: `optional_tail_decision_reminder`
- Extends cycle result with `decisionCreated: number`

- [ ] **Step 1: Write failing pending/reminder tests**

Prove all active candidate processors receive a pending item with `actionKind: 'optional_tail_decision'`, unrelated/disabled users do not, and ordinary pending nodes remain unchanged. For the worker, assert one due pending node creates one deterministic reminder, advances `nextDecisionReminderWorkHour` from 1 to 2, a second run in the same hour creates zero, and activate/skip/line terminal/account-disabled states stop future reminders.

Use a precise expected response:

```js
assert.deepEqual(await service.runCycle(), {
  processingCreated: 0,
  reviewCreated: 0,
  decisionCreated: 1
})
```

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/workflowReminder/test/reminder-service.test.js cloudfunctions/workflowReminder/test/cloud-reminder-repository.test.js miniprogram/test/pending-processing-flow.test.js miniprogram/test/notification-flow.test.js
```

Expected: pending projection omits `awaiting_decision`, the worker lacks decision methods, and the client has no copy/route for the new notification.

- [ ] **Step 3: Implement bounded reminder scanning**

Query only `optionalTailState: 'pending'` nodes with a valid `decisionStartedAt` and `nextDecisionReminderWorkHour`, re-read line/node/accounts before each write, calculate elapsed work seconds with the existing work-time service, and notify only currently active candidate processors. Advance the cursor transactionally only when the same pending version remains.

- [ ] **Step 4: Implement client pending/notification presentation**

Label the item `追加节点待决定`, route it to the sale detail, and keep all actual decision authorization on the server.

- [ ] **Step 5: Run GREEN and commit**

Run the focused command, then:

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/workflowReminder/lib/reminder-service.js cloudfunctions/workflowReminder/lib/cloud-reminder-repository.js cloudfunctions/workflowReminder/test/reminder-service.test.js cloudfunctions/workflowReminder/test/cloud-reminder-repository.test.js miniprogram/pages/notification-list/index.js miniprogram/test/pending-processing-flow.test.js miniprogram/test/notification-flow.test.js
git commit -m "feat: remind optional tail decisions"
```

---

### Task 8：售后详情与节点处理交互

**Files:**

- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/business-detail/index.js`
- Modify: `miniprogram/pages/business-detail/index.wxml`
- Modify: `miniprogram/pages/business-detail/index.wxss`
- Modify: `miniprogram/pages/node-feedback/index.js`
- Modify: `miniprogram/pages/node-feedback/index.wxml`
- Modify: `miniprogram/test/business-template-flow.test.js`
- Modify: `miniprogram/test/node-feedback-v2.test.js`
- Modify: `miniprogram/test/review-flow.test.js`

**Interfaces:**

- Produces client method: `decideOptionalTailNode(input)`
- Consumes workspace flags from Task 3 and backend route from Task 4
- Produces UI actions: `activate_optional_tail`, `skip_optional_tail`, `complete_node`

- [ ] **Step 1: Write failing UI tests**

Assert the detail page maps pending state to `必经流程已完成 · 待决定`, does not render `100%`, shows both actions only for authorized candidates, and renders `未启用` plus decision metadata after skip. Assert activation refreshes to `必经流程已完成 · 追加处理中`.

For the node page, assert:

```js
assert.equal(page.data.requiresReview, false)
assert.equal(page.data.primaryActionLabel, '完成节点')
await page.onPrimaryAction()
assert.equal(calls[0].action, 'complete_node')
```

Also prove reviewed nodes retain `提交审核`, a pending optional tail cannot open the editor/upload, double taps remain single-flight, cancellation leaves state unchanged, and version conflict refreshes rather than erasing local fields.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test miniprogram/test/business-template-flow.test.js miniprogram/test/node-feedback-v2.test.js miniprogram/test/review-flow.test.js
```

Expected: missing decision client method and old UI always showing `提交审核`/ordinary progress.

- [ ] **Step 3: Implement the detail decision panel**

Use a page-owned confirmation panel with an optional textarea instead of relying on platform-specific editable modals. Disable both actions while one request is active, send the current line/node versions and a generated request key, and always refresh the authoritative workspace after success or `VERSION_CONFLICT`.

- [ ] **Step 4: Implement reviewerless completion UI**

Select the primary action from `requiresReview`; keep all existing field, evidence, 120 MiB upload, dirty-draft and stale-response protections. `complete_node` sends the same current form snapshot through `saveNodeProgress` and clears local state only after an authoritative success.

- [ ] **Step 5: Run GREEN and commit**

Run the focused command and WXML structure test, then:

```powershell
git add -- miniprogram/services/business.js miniprogram/pages/business-detail/index.js miniprogram/pages/business-detail/index.wxml miniprogram/pages/business-detail/index.wxss miniprogram/pages/node-feedback/index.js miniprogram/pages/node-feedback/index.wxml miniprogram/test/business-template-flow.test.js miniprogram/test/node-feedback-v2.test.js miniprogram/test/review-flow.test.js
git commit -m "feat: add optional tail workflow UI"
```

---

### Task 9：检索、固定分享、运营统计与保留边界

**Files:**

- Modify: `cloudfunctions/businessApi/lib/cloud-share-repository.js`
- Modify: `cloudfunctions/businessApi/test/cloud-share-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/share-service.test.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-operations-repository.js`
- Modify: `cloudfunctions/businessApi/lib/operations-domain.js`
- Modify: `cloudfunctions/businessApi/test/cloud-operations-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/operations-domain.test.js`
- Modify: `cloudfunctions/operationsAnalytics/lib/analytics-domain.js`
- Modify: `cloudfunctions/operationsAnalytics/lib/cloud-analytics-repository.js`
- Modify: `cloudfunctions/operationsAnalytics/test/analytics-domain.test.js`
- Modify: `cloudfunctions/operationsAnalytics/test/cloud-analytics-repository.test.js`
- Modify: `cloudfunctions/businessSearch/lib/cloud-search-repository.js`
- Modify: `cloudfunctions/businessSearch/test/cloud-search-repository.test.js`
- Modify: `cloudfunctions/calendarSync/lib/calendar-sync-service.js`
- Modify: `cloudfunctions/calendarSync/lib/cloud-calendar-repository.js`
- Modify: `cloudfunctions/calendarSync/test/calendar-sync-service.test.js`
- Modify: `cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js`
- Modify: `miniprogram/pages/admin-operations/index.js`
- Modify: `miniprogram/pages/admin-operations/index.wxml`
- Modify: `miniprogram/test/admin-operations-flow.test.js`

**Interfaces:**

- Adds analytics metrics: `optional_tail_decision_duration`, `optional_tail_activation`
- `optional_tail_decision_duration`: normal timing fact from `decisionStartedAt` to `decisionAt`
- `optional_tail_activation`: event fact with `sampleValue: 1` for activated and `0` for skipped; summary exposes `activationRatePercent`
- Adds calendar candidate kind: `optional_tail_decision` for nodes with `decisionTimingStatus: 'pending_calendar'`
- Direct-complete share source: latest published completed feedback when `lastReviewRoundId` is absent

- [ ] **Step 1: Write failing boundary tests**

Prove dormant/skipped optional nodes contribute no search document, no node duration fact and no share. Prove an activated direct-complete optional node is searchable from its latest effective published feedback, can create a fixed share for an authorized processor, and emits normal processing facts without rounds. Prove both activated and skipped decisions emit exactly one decision-duration sample and one activation event, and summary calculation returns:

```js
assert.equal(summary.optionalTail.activationCount, 1)
assert.equal(summary.optionalTail.decisionCount, 2)
assert.equal(summary.optionalTail.activationRatePercent, 50)
assert.equal(summary.optionalTail.averageDecisionMinutes, 7)
```

Also assert a missing calendar leaves the decided node at `decisionTimingStatus: 'pending_calendar'`; `calendarSync` later computes the interval, writes the calendar version and marks only that exact node/version `calculated`. True terminal completion alone supplies `completedAt`, `retentionStartedAt`, `purgeDueAt`, line analytics pending state and business completion facts.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-share-repository.test.js cloudfunctions/businessApi/test/share-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/operationsAnalytics/test/analytics-domain.test.js cloudfunctions/operationsAnalytics/test/cloud-analytics-repository.test.js cloudfunctions/businessSearch/test/cloud-search-repository.test.js cloudfunctions/calendarSync/test/calendar-sync-service.test.js cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js miniprogram/test/admin-operations-flow.test.js
```

Expected: direct-complete share requires a review round, optional metrics are unknown, and no activation-rate summary exists.

- [ ] **Step 3: Implement strict derived projections**

For sharing, require `status: 'completed'`, use the immutable approved round path when present, otherwise require an own empty reviewer array and the latest published completed feedback. For search, include only activated/completed optional nodes with a latest effective snapshot. Extend the bounded calendar candidate scan with its own validated cursor document (`calendar-optional-tail-decision-cursor`), re-read the exact node/version before applying `workingMinutesBetween`, and preserve pending status plus the existing warning path when calendar data is still missing. For analytics, generate duration facts only from calculated decision timing and store activation event facts separately from minute facts so zero-minute decisions and skipped nodes are not mistaken for missing timing data.

- [ ] **Step 4: Present optional-tail statistics**

Add two compact cards under the existing global summary: `追加节点启用率` and `平均决定工作时长`. Preserve existing all-active-user aggregate visibility and role-filtered sample drill-down; do not expose decision actor identities in global aggregates.

- [ ] **Step 5: Run GREEN and commit**

Run the focused command, then:

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-share-repository.js cloudfunctions/businessApi/test/cloud-share-repository.test.js cloudfunctions/businessApi/test/share-service.test.js cloudfunctions/businessApi/lib/cloud-operations-repository.js cloudfunctions/businessApi/lib/operations-domain.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/operationsAnalytics/lib/analytics-domain.js cloudfunctions/operationsAnalytics/lib/cloud-analytics-repository.js cloudfunctions/operationsAnalytics/test/analytics-domain.test.js cloudfunctions/operationsAnalytics/test/cloud-analytics-repository.test.js cloudfunctions/businessSearch/lib/cloud-search-repository.js cloudfunctions/businessSearch/test/cloud-search-repository.test.js cloudfunctions/calendarSync/lib/calendar-sync-service.js cloudfunctions/calendarSync/lib/cloud-calendar-repository.js cloudfunctions/calendarSync/test/calendar-sync-service.test.js cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js miniprogram/pages/admin-operations/index.js miniprogram/pages/admin-operations/index.wxml miniprogram/test/admin-operations-flow.test.js
git commit -m "feat: project optional tail outcomes"
```

---

### Task 10：部署契约、索引和隔离验收脚本

**Files:**

- Modify: `docs/deployment/template-node-fields-setup.md`
- Create: `qa/optional-tail-node-acceptance.md`
- Modify: `cloudfunctions/workflowReminder/index.js`
- Modify: `cloudfunctions/workflowReminder/test/scheduled-entry.test.js`

**Interfaces:**

- Requires composite index: `business_nodes(optionalTailState ASC, nextDecisionReminderWorkHour ASC, decisionStartedAt ASC, _id ASC)`
- Requires composite index: `business_nodes(decisionTimingStatus ASC, _id ASC)`
- Keeps all current Timer configurations unchanged during deployment; only `workflowReminder` code is replaced before manual validation

- [ ] **Step 1: Add a failing deployment-contract assertion**

Extend the scheduled-entry test to require that trusted Timer output contains exactly the three nonnegative counters and still rejects client/openid/event-forged timer calls:

```js
assert.deepEqual(result, {
  processingCreated: 0,
  reviewCreated: 0,
  decisionCreated: 0
})
```

- [ ] **Step 2: Run RED and then GREEN**

Run:

```powershell
node --test cloudfunctions/workflowReminder/test/scheduled-entry.test.js
```

Expected RED: `decisionCreated` is absent. Implement only the safe response extension in the Timer entry and rerun until the test passes.

- [ ] **Step 3: Write the exact deployment sequence**

Document this order:

1. back up `templates`, `template_nodes`, `business_lines`, `business_nodes`, `node_feedback`, `node_review_rounds`, `node_review_votes`, `notifications`, `audit_logs`, `operations_analytics_facts`, and `operations_analytics_daily`;
2. create/verify both exact `business_nodes` indexes above: decision reminders and decision-timing backfill;
3. deploy `businessApi`, then `workflowReminder`, preserving every environment variable and current trigger configuration;
4. compile/upload the Mini Program development version;
5. create three isolated templates: reviewerless required flow, optional tail without reviewers, optional tail with reviewers;
6. run skip, activate/direct-complete, activate/reject/rework/approve, reminder dedupe, search, share, analytics and 60-day retention checks;
7. rollback client first and functions second without deleting created records.

- [ ] **Step 4: Commit deployment documentation**

```powershell
git add -- docs/deployment/template-node-fields-setup.md qa/optional-tail-node-acceptance.md cloudfunctions/workflowReminder/index.js cloudfunctions/workflowReminder/test/scheduled-entry.test.js
git commit -m "docs: add optional tail deployment checks"
```

---

### Task 11：全量回归、安全边界与项目记忆收尾

**Files:**

- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`
- Create: `docs/memory/decisions/ADR-0015-optional-tail-and-reviewerless-node-transitions.md`

**Interfaces:**

- Consumes: all Tasks 1–10
- Produces: durable architecture record, exact verified evidence, remaining CloudBase/manual acceptance boundary

- [ ] **Step 1: Run every function suite**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/businessSearch
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/operationsAnalytics
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

Expected: every suite exits 0 with zero failed tests. Existing dependency audit warnings are recorded separately and never described as test failures.

- [ ] **Step 2: Run syntax, safety and diff gates**

```powershell
Get-ChildItem cloudfunctions,miniprogram -Recurse -Filter *.js | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\vendor\\' } | ForEach-Object { node --check $_.FullName }
rg -n "PUBLIC_NODE_SHARE_HMAC_SECRET|EVIDENCE_COS_SECRET|OPENID" cloudfunctions miniprogram docs/superpowers/plans/2026-08-29-optional-tail-node.md
git diff --check
```

Expected: syntax checks exit 0; unfinished markers and secret literals have zero unsafe matches; `OPENID` matches occur only in pre-existing trusted identity boundaries/tests; diff check exits 0.

- [ ] **Step 3: Update durable memory and ADR**

Record only implemented stable behavior in `PROJECT.md`; record exact commands/counts, failures, deployment status and next manual action in `STATUS.md`. ADR-0015 must explain why direct-complete remains inside the review workflow, why completion classification is shared, and why pending-decision timing is separate from processing timing.

- [ ] **Step 4: Validate memory**

```powershell
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: exit 0 with no validation errors.

- [ ] **Step 5: Inspect scope and commit explicit paths**

```powershell
git status --short
git diff --stat
git diff -- docs/memory/PROJECT.md docs/memory/STATUS.md docs/memory/decisions/ADR-0015-optional-tail-and-reviewerless-node-transitions.md
git add -- docs/memory/PROJECT.md docs/memory/STATUS.md docs/memory/decisions/ADR-0015-optional-tail-and-reviewerless-node-transitions.md
git commit -m "docs: record optional tail workflow"
```

Expected: `project.config.json` and `outputs/deploy/` remain unstaged and unchanged; every feature commit is local until the user separately authorizes GitHub push and CloudBase deployment.
