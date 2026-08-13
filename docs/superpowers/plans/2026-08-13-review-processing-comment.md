# 审核处理说明快照实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将处理人当前处理轮次最新反馈中的说明固化为审核轮次不可变快照，并在审核详情中安全、只读地展示。

**Architecture:** 反馈仓储负责从最新已发布反馈严格读取 `comment`，并以 `processingComment` 交给审核服务；审核服务把它纳入草稿摘要，审核仓储在事务内重新核验原反馈、保存审核轮次并通过安全投影返回。客户端只展示服务端投影；历史轮次缺少该字段时显示“暂无处理说明”，不迁移、不回填、不读取实时反馈。

**Tech Stack:** Node.js 16、CommonJS、`node:test`、腾讯云 CloudBase 数据库事务、微信小程序原生 JavaScript/WXML。

## Global Constraints

- 使用已确认设计：`docs/superpowers/specs/2026-08-13-review-processing-comment-design.md`。
- `processingComment` 必须是字符串，最长 1000 个字符；新审核提交遇到缺失、继承属性、访问器属性或超长值时失败关闭为 `VERSION_CONFLICT`。
- 新审核轮次必须保存不可变 `processingComment`；草稿摘要、幂等重试和事务内原反馈复核都必须覆盖该字段。
- 历史审核轮次完全缺少 `processingComment` 时兼容为空字符串；字段存在但结构非法时失败关闭，不执行 getter。
- 审核详情客户端不得查询实时 `node_feedback`，不得显示原始错误、账号 ID、文件 ID、哈希或内部摘要。
- 当前已存在的验收审核轮次不回填；部署后先显示“暂无处理说明”，再通过新的处理/审核轮次验证真实说明快照。
- 保留用户未提交的 `project.config.json` 修改；每次仅暂存本任务明确文件。
- 所有新增代码先 RED、后 GREEN；完成前运行完整回归、WXML 结构检查、差异检查和项目记忆校验。

## 文件与职责映射

- `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`：聚合当前处理轮最新反馈，产生严格的 `processingComment` 草稿字段。
- `cloudfunctions/businessApi/lib/review-service.js`：把 `processingComment` 纳入不可变草稿摘要。
- `cloudfunctions/businessApi/lib/cloud-review-repository.js`：事务内复核原反馈说明、保存轮次快照、校验幂等重试并安全投影历史说明。
- `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`：覆盖最新说明提取及访问器、继承、缺失、超长失败关闭。
- `cloudfunctions/businessApi/test/review-service.test.js`：覆盖不同处理说明产生不同草稿摘要且说明随创建请求传递。
- `cloudfunctions/businessApi/test/cloud-review-repository.test.js`：覆盖持久化、事务复核、幂等篡改拒绝、安全详情投影和旧轮次兼容。
- `miniprogram/pages/review-detail/index.js`：把安全投影映射为只读中文显示文案。
- `miniprogram/pages/review-detail/index.wxml`：新增“处理说明”展示区。
- `miniprogram/test/review-flow.test.js`：覆盖有说明和旧轮次无说明两种页面状态。
- `docs/memory/PROJECT.md`：记录审核轮次持久化处理说明快照这一稳定事实。
- `docs/memory/STATUS.md`：记录精确 RED/GREEN、完整门禁和真实环境未验证边界。

---

### Task 1: 从最新已发布反馈生成严格处理说明草稿

**Files:**
- Modify: `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/review-service.test.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`
- Modify: `cloudfunctions/businessApi/lib/review-service.js`

**Interfaces:**
- Consumes: 最新已发布反馈的自有数据属性 `comment: string`。
- Produces: `draft.processingComment: string`，并将其纳入 `draftHash`。

- [ ] **Step 1: 为反馈草稿补充说明提取与失败关闭 RED**

在 `cloud-feedback-repository.test.js` 的审核流程种子中，为合法反馈补充 `comment`；在分页聚合用例中让最后一版反馈包含唯一说明并断言：

```js
assert.equal(result.processingComment, '第 101 版处理说明')
```

新增表驱动用例，对最新反馈分别构造：缺少 `comment`、原型继承 `comment`、访问器 `comment`、字符串长度 1001。四种情况都必须拒绝，而且访问器计数保持 0：

```js
await assert.rejects(
  repository.getCurrentProcessingRoundDraft({
    actor: { _id: 'account-a' },
    businessLineId: 'line-1',
    nodeId: 'node-1',
    expectedNodeVersion: 2
  }),
  error => error && error.code === 'VERSION_CONFLICT'
)
assert.equal(getterCalls, 0)
```

- [ ] **Step 2: 运行反馈仓储测试确认 RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js
```

Expected: 新增说明断言失败；非法结构用例未全部失败关闭。

- [ ] **Step 3: 最小实现严格说明提取**

在 `aggregateProcessingRoundDraft` 选定 `latest` 后，使用现有 `ownDataValue` 读取自有数据属性，不执行访问器：

```js
const latestComment = ownDataValue(latest, 'comment')
if (!latestComment.valid || typeof latestComment.value !== 'string' ||
    latestComment.value.length > 1000) {
  throw createError('VERSION_CONFLICT')
}
```

将返回值扩展为：

```js
return {
  line: clone(context.line),
  node: clone(context.node),
  feedbackId: latest._id,
  feedbackRevision: latest.revision,
  processingRoundNumber,
  processingComment: latestComment.value,
  fieldSnapshots: clone(latest.fieldValues),
  evidenceIds,
  evidenceTotalBytes
}
```

不得使用 `String(value)`、`trim()` 或默认空串修复非法数据；草稿必须与已发布反馈的真实值一致。

- [ ] **Step 4: 为服务摘要补充 RED**

在 `review-service.test.js` 的 `draft()` 合法夹具中加入：

```js
processingComment: '最新处理说明',
```

新增用例分别提交仅 `processingComment` 不同的两个合法草稿，并比较传给 `createReviewRound` 的 `draftHash`：

```js
assert.notEqual(firstCreate.draftHash, secondCreate.draftHash)
assert.equal(firstCreate.draft.processingComment, '说明甲')
assert.equal(secondCreate.draft.processingComment, '说明乙')
```

- [ ] **Step 5: 运行服务测试确认 RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js
```

Expected: 两个摘要仍相同，证明说明尚未进入摘要。

- [ ] **Step 6: 将处理说明纳入草稿摘要**

把 `review-service.js` 的 `hashDraft` 固定顺序改为：

```js
function hashDraft(actorId, input, draft) {
  return sha256(JSON.stringify([
    actorId, input.businessLineId, input.nodeId, input.expectedNodeVersion,
    draft.feedbackId, draft.feedbackRevision, draft.processingRoundNumber,
    draft.processingComment, draft.fieldSnapshots,
    draft.evidenceIds, draft.evidenceTotalBytes
  ]))
}
```

禁止另设第二套摘要规则；审核仓储后续必须使用完全相同的字段顺序复算。

- [ ] **Step 7: 运行 Task 1 聚焦测试确认 GREEN**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/review-service.test.js
```

Expected: 全部通过，访问器计数为 0。

- [ ] **Step 8: 独立提交 Task 1**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-feedback-repository.js cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/review-service.test.js
git diff --cached --check
git commit -m "fix: 固化审核处理说明草稿"
```

---

### Task 2: 持久化审核轮次说明并安全投影

**Files:**
- Modify: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`

**Interfaces:**
- Consumes: Task 1 产生的 `draft.processingComment: string` 和对应 `draftHash`。
- Produces: `node_review_rounds.processingComment: string`；`getReviewDetail()` 返回 `processingComment: string`。

- [ ] **Step 1: 更新合法夹具与摘要复算规则**

在 `seed().node_feedback[0]` 增加：

```js
comment: '处理说明快照',
```

在 `request().draft` 增加：

```js
processingComment: '处理说明快照',
```

在测试辅助函数 `retryValue()` 的摘要数组中，按 Task 1 的固定位置加入 `value.draft.processingComment`，确保测试没有维护另一套旧摘要契约。

- [ ] **Step 2: 编写创建、重试和详情安全 RED**

在创建轮次测试中断言：

```js
assert.equal(round.processingComment, '处理说明快照')
```

在幂等篡改矩阵中加入：

```js
round => { round.processingComment = '被篡改的处理说明' }
```

在事务复核测试中把原反馈 `comment` 改为不同值，要求 `createReviewRound` 和 `findReviewRoundRetry` 都返回 `VERSION_CONFLICT`。

在审核详情测试中断言合法轮次返回：

```js
assert.equal(detail.processingComment, '处理说明快照')
```

新增旧轮次兼容和非法结构矩阵：

```js
delete oldRound.processingComment
assert.equal((await repository.getReviewDetail(input)).processingComment, '')
```

字段存在但为数字、超长字符串、访问器或继承属性时必须返回 `FORBIDDEN`；访问器不得执行。

- [ ] **Step 3: 运行审核仓储测试确认 RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

Expected: 创建结果缺字段、篡改未被识别、详情缺投影或非法历史结构未失败关闭。

- [ ] **Step 4: 增加统一的轮次处理说明读取器**

在 `cloud-review-repository.js` 增加单一内部函数：

```js
function roundProcessingComment(round, { allowMissing = false, errorCode = 'FORBIDDEN' } = {}) {
  const descriptor = round && Object.getOwnPropertyDescriptor(round, 'processingComment')
  if (!descriptor) {
    if ((round && 'processingComment' in round) || !allowMissing) throw createError(errorCode)
    return ''
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      typeof descriptor.value !== 'string' || descriptor.value.length > 1000) {
    throw createError(errorCode)
  }
  return descriptor.value
}
```

调用约束：

- 幂等重试使用 `{ errorCode: 'VERSION_CONFLICT' }`；轮次结构错误直接成为版本冲突。
- 详情读取使用 `{ allowMissing: true, errorCode: 'FORBIDDEN' }`；只有字段完全不存在的旧轮次返回空串，继承和访问器仍为 `FORBIDDEN`。
- 新草稿不使用历史兼容读取器；必须直接用 `ownDataValue` 校验自有数据属性。

- [ ] **Step 5: 事务内绑定草稿说明与原反馈说明**

在 `validateDraft(value, node, feedback)` 中用 `ownDataValue` 同时读取草稿 `processingComment` 和反馈 `comment` 的自有数据描述符，并补充以下条件：

```js
draftComment.valid &&
typeof draftComment.value === 'string' &&
draftComment.value.length <= 1000 &&
feedbackComment.valid &&
typeof feedbackComment.value === 'string' &&
feedbackComment.value.length <= 1000 &&
feedbackComment.value === draftComment.value
```

任何缺失、访问器、继承、类型错误、超长或内容不一致都抛 `VERSION_CONFLICT`，且不得执行 getter。

- [ ] **Step 6: 持久化并覆盖全部幂等校验路径**

创建 `round` 时加入：

```js
processingComment: value.draft.processingComment,
```

`assertIdempotentRound` 通过安全读取器增加轮次快照与请求草稿相等校验：

```js
roundProcessingComment(round, { errorCode: 'VERSION_CONFLICT' }) !== value.draft.processingComment
```

`findReviewRoundRetry` 的摘要复算数组按 Task 1 顺序加入：

```js
value.draft.processingComment,
```

这样创建、已存在轮次返回、响应丢失重试三条路径都使用同一不可变说明。

- [ ] **Step 7: 安全投影审核说明**

`getReviewDetail()` 在第三次授权复核仍成功后返回：

```js
processingComment: roundProcessingComment(second.round, { allowMissing: true }),
```

不得返回原反馈文档、`submittedBy`、请求摘要、内部账号 ID 或其他未列入安全响应的字段。

- [ ] **Step 8: 运行 Task 2 聚焦与后端组合回归**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

Expected: 全部通过；旧轮次缺字段得到空字符串；非法结构失败关闭；访问器计数为 0。

- [ ] **Step 9: 独立提交 Task 2**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
git diff --cached --check
git commit -m "fix: 保存审核处理说明快照"
```

---

### Task 3: 审核详情只读展示、全量验证与真机验收交接

**Files:**
- Modify: `miniprogram/test/review-flow.test.js`
- Modify: `miniprogram/pages/review-detail/index.js`
- Modify: `miniprogram/pages/review-detail/index.wxml`
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`

**Interfaces:**
- Consumes: `getReviewDetail()` 的 `processingComment: string` 安全投影。
- Produces: 页面状态 `processingCommentText: string`，取值为快照内容或“暂无处理说明”。

- [ ] **Step 1: 编写客户端映射与展示 RED**

在审核详情测试的服务端返回中加入：

```js
processingComment: '无敏感内容',
```

页面加载后断言：

```js
assert.equal(page.data.processingCommentText, '无敏感内容')
```

再增加旧轮次响应 `processingComment: ''` 的用例，断言：

```js
assert.equal(page.data.processingCommentText, '暂无处理说明')
```

读取真实 `review-detail/index.wxml`，断言“处理说明”和 `{{processingCommentText}}` 都存在，保证数据映射确实接入声明式页面而非成为未使用状态。

- [ ] **Step 2: 运行客户端聚焦测试确认 RED**

Run:

```powershell
node --test miniprogram/test/review-flow.test.js
```

Expected: `processingCommentText` 不存在，WXML 缺少处理说明区。

- [ ] **Step 3: 最小实现只读页面状态**

在 `review-detail/index.js` 的初始 `data` 中加入：

```js
processingCommentText: '暂无处理说明',
```

在 `loadDetail()` 的 `setData` 中加入严格映射：

```js
processingCommentText: typeof detail.processingComment === 'string' && detail.processingComment
  ? detail.processingComment
  : '暂无处理说明',
```

页面不得允许编辑或提交该字段，也不得额外调用反馈查询接口。

- [ ] **Step 4: 新增 WXML 只读展示区**

在业务摘要卡片与“字段快照”之间插入：

```xml
<view class="section-title">处理说明</view>
<view class="card">
  <text class="block">{{processingCommentText}}</text>
</view>
```

不新增按钮、输入框、复制入口或内部调试字段。

- [ ] **Step 5: 运行客户端与 WXML 聚焦验证**

Run:

```powershell
node --test miniprogram/test/review-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: 审核详情聚焦测试全部通过，WXML 结构测试全部通过。

- [ ] **Step 6: 运行完整自动化门禁**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
npm.cmd test --prefix miniprogram
node tools/test-wxml-structure.mjs
node --check cloudfunctions/businessApi/lib/cloud-feedback-repository.js
node --check cloudfunctions/businessApi/lib/review-service.js
node --check cloudfunctions/businessApi/lib/cloud-review-repository.js
node --check miniprogram/pages/review-detail/index.js
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: 所有套件 0 失败；仅允许既有 npm 用户配置警告；差异检查和记忆校验通过。

- [ ] **Step 7: 更新中文项目记忆**

`PROJECT.md` 只增加稳定事实：审核轮次持久化最新处理反馈的 `processingComment` 不可变快照，历史缺字段只读为空。

`STATUS.md` 记录：

- RED 的精确测试数与失败原因；
- GREEN 的聚焦和完整套件精确通过数；
- 提交哈希；
- 当前云端旧审核轮次不会回填，只显示“暂无处理说明”；
- `businessApi` 重新部署、小程序重新编译、新轮次真机展示仍为 `unverified`，直到用户逐项确认。

不得写入真实 OpenID、用户隐私、文件路径、原始业务说明或云端记录全文。

- [ ] **Step 8: 最终差异复核并提交 Task 3**

```powershell
git add -- miniprogram/pages/review-detail/index.js miniprogram/pages/review-detail/index.wxml miniprogram/test/review-flow.test.js docs/memory/PROJECT.md docs/memory/STATUS.md
git diff --cached --check
git status --short
git commit -m "fix: 展示审核处理说明"
```

确认 `project.config.json` 仍是未暂存用户改动，提交中不得出现。

- [ ] **Step 9: CloudBase 与真机验收交接**

按以下顺序执行，所有真实环境步骤在用户确认前保持 `unverified`：

1. 上传部署当前 `businessApi`，核对超时和环境变量仍有效。
2. 微信开发者工具重新编译；旧审核轮次详情应显示“暂无处理说明”，且现有投票功能不受影响。
3. 在隔离验收业务中由当前审核人驳回旧轮次，填写无敏感驳回原因。
4. 处理人进入新的处理轮次，保存一条无敏感处理说明，再提交审核；凭证按模板规则可不新增或选择非敏感测试文件。
5. 审核人进入新轮次详情，确认“处理说明”显示刚保存的文本；字段快照、凭证、审核截止和投票按钮仍正常。
6. CloudBase 核对新 `node_review_rounds.processingComment` 与新轮次一致，旧轮次仍无该字段；不得人工补字段。
7. 完成后把真实验收证据以“通过/失败/未验证”更新到 `STATUS.md`，不记录原始账号标识或敏感业务数据。

---

## 自审清单

- 设计中的最新反馈来源、1000 字符上限、不可变摘要、事务复核、安全投影、旧轮次兼容和只读 UI 均分别有任务与测试。
- 后端创建与响应丢失重试使用同一个字段顺序计算 `draftHash`。
- 只有字段完全缺失的历史轮次可兼容；继承、访问器、非法类型和超长一律失败关闭。
- 当前旧审核轮次不迁移；真实说明必须通过新轮次验证。
- 未新增集合、索引、客户端写接口或实时反馈查询。
- 全文步骤均给出实际路径、命令与实现片段，无占位步骤。
