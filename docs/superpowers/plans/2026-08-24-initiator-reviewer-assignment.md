# 业务发起人作为节点唯一审核人 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个新版审核模板节点增加“业务发起人作为本节点唯一审核人”配置，在业务创建事务中固化唯一审核人快照，并与现有七日公开只读分享共同交付小程序 `1.0.1`。

**Architecture:** 模板只保存审核人来源策略；业务创建事务读取当前活动发起人，把策略解析成现有 `reviewerUserIds` 与显示名称快照。审核、提醒、个人响应时间和运营统计继续消费统一快照，不增加旁路授权。公开分享不改架构，只做回归与体验版验收闭环。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、CloudBase 云函数、Node.js 16、`node:test`、现有内存 CloudBase 测试夹具。

**Spec:** `docs/superpowers/specs/2026-08-24-initiator-reviewer-assignment-design.md`

## Global Constraints

- 所有生产改动必须先写可观察行为测试并运行得到预期 RED，再写最小 GREEN。
- `reviewerAssignmentMode` 只允许 `fixed_accounts` 或 `business_creator`；旧模板缺字段默认固定审核人。
- 新关系字段只接受对象自身数据属性；访问器、继承值、稀疏数组、重复账号和模式混用失败关闭。
- 同一节点处理人与审核人不得重叠；冲突时整笔业务创建失败，不自动删人或修改模板。
- 业务创建后只使用不可变审核人快照；旧业务不迁移。
- 单个 CloudBase 事务不超过 100 次文档操作，参与账号去重读取。
- 不新增集合、组合索引或环境变量，不改变任何正式 Timer 配置。
- 不读取、不修改、不暂存或提交用户自己的 `project.config.json`。

---

### Task 1：模板域审核人来源契约

**Files:**

- Modify: `cloudfunctions/businessApi/lib/template-domain.js`
- Modify: `cloudfunctions/businessApi/test/template-domain.test.js`
- Modify: `cloudfunctions/businessApi/test/template-service.test.js`

**Interfaces:**

- Produces: `REVIEWER_ASSIGNMENT_MODE = { FIXED_ACCOUNTS, BUSINESS_CREATOR }`
- Produces: normalized node field `reviewerAssignmentMode`
- Consumes: existing `PROCESSOR_ASSIGNMENT_MODE`, `normalizeTemplateNode`, `validateTemplateForEnable`

- [ ] **Step 1: Write failing domain tests**

Add literal cases proving:

```js
assert.equal(normalizeTemplateNode(legacyNode).reviewerAssignmentMode, 'fixed_accounts')
assert.deepEqual(normalizeTemplateNode({
  ...reviewNode,
  reviewerAssignmentMode: 'business_creator',
  reviewerUserIds: []
}).reviewerUserIds, [])
assert.throws(() => normalizeTemplateNode({
  ...reviewNode,
  reviewerAssignmentMode: 'business_creator',
  reviewerUserIds: ['reviewer-1']
}), error => error.code === 'TEMPLATE_INVALID')
assert.throws(() => validateTemplateForEnable(template, [{
  ...reviewNode,
  processorAssignmentMode: 'business_creator',
  processorUserIds: [],
  reviewerAssignmentMode: 'business_creator',
  reviewerUserIds: []
}], []), error => error.code === 'ROLE_OVERLAP')
```

Also cover unknown mode, accessor, inherited marker, sparse reviewer array, fixed mode with empty reviewers, and fixed reviewer activity validation.

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js
```

Expected: failures show missing `reviewerAssignmentMode` normalization and missing double-creator conflict; existing processor-mode tests remain green.

- [ ] **Step 3: Implement minimal domain support**

Add strict descriptor-based normalization parallel to processor mode:

```js
const REVIEWER_ASSIGNMENT_MODE = Object.freeze({
  FIXED_ACCOUNTS: 'fixed_accounts',
  BUSINESS_CREATOR: 'business_creator'
})
```

Normalize legacy absence to fixed, require empty template reviewer array for creator mode, require nonempty active fixed reviewers at enablement, and reject both creator modes on one node with `ROLE_OVERLAP`.

- [ ] **Step 4: Run GREEN and commit**

Run the focused command again, then:

```powershell
git add -- cloudfunctions/businessApi/lib/template-domain.js cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js
git commit -m "feat: 定义节点审核人来源"
```

---

### Task 2：模板管理页面审核人来源

**Files:**

- Modify: `miniprogram/pages/admin-template-node-edit/index.js`
- Modify: `miniprogram/pages/admin-template-node-edit/index.wxml`
- Modify: `miniprogram/pages/admin-template-edit/index.js`
- Modify: `miniprogram/pages/admin-template-edit/index.wxml`
- Modify: `miniprogram/test/template-flow.test.js`

**Interfaces:**

- Consumes/produces node field: `reviewerAssignmentMode`
- Produces event handler: `onReviewerAssignmentModeChange(event)`
- Preserves existing `processorAssignmentMode` behavior

- [ ] **Step 1: Write failing page tests**

Add tests proving:

```js
assert.equal(page.data.reviewerAssignmentMode, 'fixed_accounts')
page.onReviewerAssignmentModeChange({ detail: { value: 'business_creator' } })
assert.equal(page.data.reviewerAssignmentMode, 'business_creator')
assert.deepEqual(page.data.reviewerUserIds, [])
```

Verify creator-reviewer mode hides/disables fixed reviewer checkboxes, switching back does not restore cleared reviewers, a node cannot select both creator modes, saved payload preserves each node independently, old nodes default fixed, and read-only templates show the source without enabling controls.

- [ ] **Step 2: Run RED**

```powershell
node --test miniprogram/test/template-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: failures identify the missing reviewer source state, handler, markup and payload field.

- [ ] **Step 3: Implement minimal page behavior**

Add state:

```js
reviewerAssignmentMode: 'fixed_accounts'
```

When selecting creator mode, clear `reviewerUserIds` and recompute `reviewerSelected`. When selecting fixed mode, require a fresh reviewer choice. Preserve the field through node edit and final template save. Render two mutually exclusive reviewer source choices and a clear explanatory sentence.

- [ ] **Step 4: Run GREEN and commit**

```powershell
git add -- miniprogram/pages/admin-template-node-edit/index.js miniprogram/pages/admin-template-node-edit/index.wxml miniprogram/pages/admin-template-edit/index.js miniprogram/pages/admin-template-edit/index.wxml miniprogram/test/template-flow.test.js
git commit -m "feat: 配置发起人唯一审核人"
```

---

### Task 3：业务创建解析唯一审核人快照

**Files:**

- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/business-service.test.js`
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/test/business-template-flow.test.js`

**Interfaces:**

- Consumes template node `reviewerAssignmentMode`
- Produces business node fields `reviewerAssignmentMode`, resolved `reviewerUserIds`, `reviewerDisplayNames`
- Preserves stable error `CREATOR_REVIEWER_CONFLICT`

- [ ] **Step 1: Write failing snapshot tests**

Use the real in-memory repository to prove a creator-reviewer node stores:

```js
assert.equal(storedNode.reviewerAssignmentMode, 'business_creator')
assert.deepEqual(storedNode.reviewerUserIds, ['user-1'])
assert.deepEqual(storedNode.reviewerDisplayNames, ['发起人'])
```

Add cases for fixed reviewer preservation, fixed processor containing the creator, both creator modes, creator disabled during transaction, template version change, same-key retry, cross-node participation allowed, member/index budget, and exact 100/101 operation boundaries. Assert rejected creation leaves no line, node, counter or audit half-product.

Update the client expectation to the approved literal message:

```text
业务发起人不能同时担任同一节点的处理人和审核人，请调整模板或由其他账号发起
```

- [ ] **Step 2: Run RED**

```powershell
node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/business-service.test.js miniprogram/test/business-template-flow.test.js
```

Expected: creator reviewer mode is rejected as an empty reviewer or not resolved; fixed-processor creator overlap is not yet rejected; old message assertion fails.

- [ ] **Step 3: Implement minimal snapshot resolution**

Replace processor-only resolution with one strict resolver that returns both arrays:

```js
return {
  ...node,
  processorAssignmentMode,
  reviewerAssignmentMode,
  processorUserIds: processorAssignmentMode === 'business_creator'
    ? [creatorUserId]
    : node.processorUserIds,
  reviewerUserIds: reviewerAssignmentMode === 'business_creator'
    ? [creatorUserId]
    : node.reviewerUserIds
}
```

After resolving, reject any per-node array intersection. Perform budget checks and participant account reads against the resolved nodes. Persist reviewer source and safe display snapshot.

- [ ] **Step 4: Run GREEN and commit**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/business-service.test.js miniprogram/services/business.js miniprogram/test/business-template-flow.test.js
git commit -m "feat: 快照化发起人唯一审核人"
```

---

### Task 4：下游审核、提醒、统计与分享回归

**Files:**

- Modify: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-operations-repository.test.js`
- Modify: `cloudfunctions/workflowReminder/test/cloud-reminder-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-share-repository.test.js`
- Modify: `miniprogram/test/review-flow.test.js`
- Modify: `miniprogram/test/public-node-share-flow.test.js`

**Interfaces:**

- Consumes only resolved business-node `reviewerUserIds`
- No new production API unless a failing integration test proves an existing consumer rejects the valid new snapshot

- [ ] **Step 1: Add integration regression fixtures**

Create business-node fixtures with:

```js
reviewerAssignmentMode: 'business_creator',
reviewerUserIds: ['creator-1'],
reviewerDisplayNames: ['业务发起人']
```

Prove the creator receives the pending review, can cast the unique vote, receives reminders only while unvoted, contributes a personal response-time fact only after voting, and no internal ID appears in client projections. Prove completed nodes still generate and read public fixed snapshots with the same seven-day boundary.

- [ ] **Step 2: Run focused regression**

```powershell
node --test cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/cloud-share-repository.test.js
npm.cmd test --prefix cloudfunctions/workflowReminder
node --test miniprogram/test/review-flow.test.js miniprogram/test/public-node-share-flow.test.js
```

If all tests pass immediately, keep only tests that exercise a new end-to-end fixture and would fail if snapshot resolution emitted an empty/fixed reviewer. Do not add production branches without a real RED.

- [ ] **Step 3: Apply only proven compatibility fixes**

If a test exposes a consumer that validates `reviewerAssignmentMode`, extend its strict enum while continuing to authorize from resolved `reviewerUserIds`. Do not special-case business creators in vote, reminder, analytics or share authorization.

- [ ] **Step 4: Run GREEN and commit**

Stage only files that changed. Use:

```powershell
git commit -m "test: 回归发起人审核与公开分享"
```

---

### Task 5：全量验证、项目记忆与交付

**Files:**

- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`
- Modify: `docs/deployment/template-node-fields-setup.md`
- Create: `.superpowers/sdd/2026-08-24-initiator-reviewer-assignment/task-report.md`

**Interfaces:**

- Documents exact verified counts and unverified real-environment boundaries
- Produces deployment checklist for `businessApi` and Mini Program `1.0.1`

- [ ] **Step 1: Run complete verification**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
npm.cmd test --prefix cloudfunctions/operationsAnalytics
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

Run `node --check` for every changed production JavaScript file and record exact counts.

- [ ] **Step 2: Update deployment and memory evidence**

Document that no new collection/index/environment variable is required; deploy current `businessApi`, upload Mini Program `1.0.1`, and keep existing formal Timer decisions unchanged. Record experience-version checks for creator reviewer assignment, conflict rejection and real friend/group public sharing as `unverified` until the operator performs them.

- [ ] **Step 3: Run final gates**

```powershell
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
git status --short
```

Confirm the worktree contains no secrets and no `project.config.json` change.

- [ ] **Step 4: Commit delivery evidence**

```powershell
git add -- docs/memory/PROJECT.md docs/memory/STATUS.md docs/deployment/template-node-fields-setup.md
git diff --cached --check
git commit -m "docs: 记录发起人审核交付证据"
```

If `PROJECT.md` or the deployment manual has no actual stable change, do not modify or stage it merely to satisfy the file list.

