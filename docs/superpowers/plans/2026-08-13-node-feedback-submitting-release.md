# 节点处理保存后加载态释放实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复处理进度保存成功并刷新到新节点版本后，三个操作按钮持续转圈且不可操作的问题，同时保留全部异步写回安全边界。

**Architecture:** 保留 `writeStillCurrent(operation)` 对业务结果写回的严格版本校验，新增不比较节点版本的页面操作所有权判断，只用于 `finally` 释放本次操作的 `submitting`。测试先模拟保存后服务端节点版本从 4 升至 5 并让权威刷新读到版本 5，确认现实现无法释放加载态，再验证账号、页面、节点和操作序号边界未被放宽。

**Tech Stack:** 微信小程序原生 JavaScript/WXML、CommonJS、Node.js `node:test`。

## Global Constraints

- 使用已确认设计：`docs/superpowers/specs/2026-08-13-node-feedback-submitting-release-design.md`。
- `writeStillCurrent(operation)` 的账号、页面存活、业务编号、节点编号、操作序号和节点版本校验不得放宽。
- 新的 UI 释放判断只允许省略节点版本比较；账号、页面存活、业务编号、节点编号和操作序号必须全部匹配。
- 只修改节点处理页面、对应客户端测试和中文 `STATUS.md`；不修改服务端接口、数据库、WXML、幂等请求键或版本协议。
- 保留用户未提交的 `project.config.json` 修改且不得暂存。
- 必须先取得准确 RED，再写最小生产修复；完成前运行全部小程序、四套云函数、WXML、语法、差异和项目记忆校验。

## 文件与职责映射

- `miniprogram/test/review-flow.test.js`：复现保存后节点版本升级时加载态不释放，并断言三个按钮仍共用 `submitting`。
- `miniprogram/pages/node-feedback/index.js`：新增当前操作 UI 所有权判断，且只在处理进度操作的 `finally` 使用。
- `docs/memory/STATUS.md`：记录真机缺陷、RED/GREEN、完整门禁和重新编译复验边界。

---

### Task 1: 用真实版本升级流程复现按钮持续加载

**Files:**
- Modify: `miniprogram/test/review-flow.test.js`

**Interfaces:**
- Consumes: `Page.performProgressAction('save_progress')` 和页面状态 `submitting`。
- Produces: 一个在现有实现上失败、在修复后通过的版本升级回归。

- [ ] **Step 1: 强化已有保存进度回归夹具**

在“单独保存处理进度后清除已登记本地文件并恢复服务端最新字段草稿”用例中，让首次读取返回版本 4，让保存后刷新返回版本 5，而不是始终复用同一个版本 4 节点：

```js
const initialNode = reviewNode({ requiresEvidence: true, version: 4 })
const refreshedNode = reviewNode({ requiresEvidence: true, version: 5 })
let detailReads = 0

getBusinessLine: async () => {
  detailReads += 1
  return {
    line: { _id: 'line-1', status: 'active', version: 8 + detailReads },
    nodes: [detailReads === 1 ? initialNode : refreshedNode]
  }
}
```

`getNodeHistory` 使用与本次详情读取对应的节点，保存服务返回：

```js
submitFeedback: async input => {
  calls.push(['feedback', input])
  return { feedbackId: 'feedback-1', nodeVersion: 5 }
}
```

- [ ] **Step 2: 增加加载态与 WXML 共用状态断言**

保存结束后增加：

```js
assert.equal(page.data.expectedNodeVersion, 5)
assert.equal(page.data.submitting, false)

const wxml = fs.readFileSync(path.join(miniProgramRoot, 'pages/node-feedback/index.wxml'), 'utf8')
assert.match(wxml, /保存处理进度[^>]*loading="\{\{submitting\}\}"/)
assert.match(wxml, /标记受阻[^>]*loading="\{\{submitting\}\}"/)
assert.match(wxml, /提交审核[^>]*loading="\{\{submitting\}\}"/)
```

这里不新增新的页面状态；三个按钮继续共用 `submitting`，避免产生相互矛盾的多套加载标记。

- [ ] **Step 3: 运行聚焦测试确认 RED**

Run:

```powershell
node --test miniprogram/test/review-flow.test.js
```

Expected: 只有新增的 `submitting === false` 断言失败，实际值为 `true`；保存结果、版本 5、最新草稿和历史断言继续通过，证明失败来自 UI 加载态释放，而不是保存或刷新失败。

---

### Task 2: 拆分严格写回判断和 UI 加载态所有权

**Files:**
- Modify: `miniprogram/pages/node-feedback/index.js`
- Test: `miniprogram/test/review-flow.test.js`

**Interfaces:**
- Consumes: 冻结操作对象 `{ actorId, sequence, lineId, nodeId, nodeVersion }`。
- Produces: `operationStillOwnsPage(operation): boolean`，仅用于清除当前操作的 `submitting`。

- [ ] **Step 1: 新增页面操作所有权判断**

紧邻 `writeStillCurrent(operation)` 新增：

```js
operationStillOwnsPage(operation) {
  return Boolean(operation) && this.pageAlive && currentUserId() === operation.actorId &&
    this.writeSequence === operation.sequence && this.data.lineId === operation.lineId &&
    this.data.nodeId === operation.nodeId
},
```

不得调用或改写 `writeStillCurrent()`，也不得把该新函数用于上传、登记、服务端结果、成功提示、失败提示或幂等请求键处理。

- [ ] **Step 2: 只替换处理进度操作 finally 的判断**

把 `performProgressAction()` 的：

```js
if (this.writeStillCurrent(operation)) this.setData({ submitting: false })
```

改为：

```js
if (this.operationStillOwnsPage(operation)) this.setData({ submitting: false })
```

`onSubmitReview()` 和旧流程 `submit()` 的现有成功/失败与页面跳转语义不在本任务修改范围内。

- [ ] **Step 3: 运行聚焦测试确认 GREEN**

Run:

```powershell
node --test miniprogram/test/review-flow.test.js
```

Expected: 全部通过；版本刷新到 5 后 `submitting` 为 `false`。

- [ ] **Step 4: 运行客户端安全回归**

Run:

```powershell
node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/review-flow.test.js miniprogram/test/admin-business-amend-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: 全部通过；账号切换、页面卸载、节点变化、等待期冻结、上传错误脱敏和两步提交回归保持绿色。

---

### Task 3: 完整验证、中文记忆与本地提交

**Files:**
- Modify: `docs/memory/STATUS.md`
- Verify: `miniprogram/pages/node-feedback/index.js`
- Verify: `miniprogram/test/review-flow.test.js`

**Interfaces:**
- Consumes: Task 2 的客户端修复及测试结果。
- Produces: 可追溯的本地提交和真机复验交接。

- [ ] **Step 1: 运行完整自动化门禁**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
node --check miniprogram/pages/node-feedback/index.js
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: 全部 0 失败；只允许既有换行或 npm 用户配置警告。

- [ ] **Step 2: 更新中文状态记忆**

在 `docs/memory/STATUS.md` 顶部增加一条安全摘要，记录：

- 真机保存成功并出现反馈历史，但三个按钮持续加载；退出重进恢复；
- 根因是权威刷新提升节点版本后，`finally` 错用严格版本守卫；
- RED 的精确测试数和唯一失败断言；
- GREEN 的聚焦及完整套件计数；
- 生产修复只拆分 UI 状态释放判断，业务写回版本校验未放宽；
- 重新编译和真机原页保存后按钮恢复仍为 `unverified`。

不得记录账号标识、业务编号、处理说明原文、凭证编号或云端记录全文。

- [ ] **Step 3: 复核并显式暂存**

Run:

```powershell
git diff -- miniprogram/pages/node-feedback/index.js miniprogram/test/review-flow.test.js docs/memory/STATUS.md
git add -- miniprogram/pages/node-feedback/index.js miniprogram/test/review-flow.test.js docs/memory/STATUS.md
git diff --cached --check
git diff --cached --name-only
git status --short
```

Expected: 暂存区只有以上三个文件，`project.config.json` 仍为未暂存修改。

- [ ] **Step 4: 创建本地提交**

```powershell
git commit -m "fix: 释放处理进度按钮加载态"
```

- [ ] **Step 5: 真机复验交接**

按顺序执行：

1. 微信开发者工具重新编译当前小程序；本任务没有服务端改动，无需重新部署 `businessApi`。
2. 使用当前第二节点处理账号进入活动处理页，填写一条无敏感测试说明。
3. 点击“保存处理进度”，确认出现成功提示和新反馈历史。
4. 不退出页面，等待刷新结束；确认保存处理进度、标记受阻、提交审核三个按钮不再转圈并恢复可用。
5. 再点击“提交审核”继续原隔离业务验收；不得为了测试加载态重复提交相同处理内容。

真机结果在用户逐项确认前保持 `unverified`。
