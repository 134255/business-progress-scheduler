# 凭证保留提醒通知编号兼容 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `businessApi` 严格识别现有 `evidence-retention:<businessLineId>:1|7|15` 通知编号，使已创建的凭证保留提醒可在通知中心显示并可标记已读，同时不放宽任何其他文档编号边界。

**Architecture:** 新增一个无副作用的通知编号判定模块，统一供服务入口和云仓储使用。该模块继续接受原有普通通知编号，并只额外接受固定前缀、合法业务编号和三种保留天数组成的凭证保留提醒编号；列表投影、已读入口和事务内二次授权使用同一规则。

**Tech Stack:** Node.js 16、CommonJS、`node:test`、腾讯云 CloudBase 数据库事务、微信小程序通知中心。

## Global Constraints

- 所有新增说明、项目记忆和任务报告以中文为主，专业标识符保留英文。
- 必须先写失败测试并观察 RED，再写最小生产实现并观察 GREEN。
- 不修改 `evidenceRetention` 已生成的通知记录，不重新运行清理任务，不改变任何 Timer 配置。
- 不修改通用 `DOCUMENT_ID`；兼容范围仅限 `evidence-retention:<businessLineId>:1|7|15`。
- `<businessLineId>` 只允许 `[A-Za-z0-9_-]{1,128}`；错误前缀、额外分段、路径字符、空值、超长值和非 `1|7|15` 天数必须失败关闭。
- 不改变通知安全投影、收件人授权、超级管理员角色授权、活动账号复核和每账号独立已读标记结构。
- 保护用户未提交的 `project.config.json`，只暂存本计划明确列出的路径。
- 部署范围只有 `businessApi`；`calendarSync`、`workflowReminder`、`evidenceRetention` 继续保持空触发器。

---

## 文件结构

- 新建 `cloudfunctions/businessApi/lib/notification-id.js`：唯一负责判定普通通知编号和凭证保留提醒编号，不读取数据库、不抛业务错误。
- 修改 `cloudfunctions/businessApi/lib/review-service.js`：`markNotificationRead` 使用通知专用编号规范化，不影响业务、节点、轮次等其他编号。
- 修改 `cloudfunctions/businessApi/lib/cloud-review-repository.js`：通知列表投影和事务内已读授权使用同一通知编号判定。
- 修改 `cloudfunctions/businessApi/test/review-service.test.js`：覆盖服务入口的合法兼容与非法编号拒绝。
- 修改 `cloudfunctions/businessApi/test/cloud-review-repository.test.js`：覆盖真实列表可见、已读幂等、收件人隔离及畸形编号失败关闭。
- 修改 `docs/memory/STATUS.md`：记录 RED、GREEN、全量验证及真实 CloudBase 待重新部署边界。

### Task 1: 建立通知专用编号契约并收紧服务入口

**Files:**
- Create: `cloudfunctions/businessApi/lib/notification-id.js`
- Modify: `cloudfunctions/businessApi/lib/review-service.js:1-40,390-397`
- Test: `cloudfunctions/businessApi/test/review-service.test.js:363-390`

**Interfaces:**
- Consumes: 普通通知编号规则 `[A-Za-z0-9_-]{1,128}` 和凭证保留提醒格式 `evidence-retention:<businessLineId>:<days>`。
- Produces: `isNotificationId(value): boolean`；服务内部 `normalizeNotificationId(value): string`，非法值抛出 `VALIDATION_ERROR`。

- [ ] **Step 1: 写服务入口失败测试**

在 `review-service.test.js` 的严格输入校验用例旁新增以下行为断言；仓储 mock 必须记录实际收到的编号：

```js
for (const days of [1, 7, 15]) {
  const notificationId = `evidence-retention:business-1:${days}`
  await service.markNotificationRead({ actor, notificationId })
  assert.equal(calls.at(-1).notificationId, notificationId)
}

for (const notificationId of [
  'evidence_retention:business-1:15',
  'evidence-retention::15',
  'evidence-retention:business-1:0',
  'evidence-retention:business-1:2',
  'evidence-retention:business-1:16',
  'evidence-retention:../business-1:15',
  'evidence-retention:business-1:15:extra',
  `evidence-retention:${'a'.repeat(129)}:15`
]) {
  await assert.rejects(
    service.markNotificationRead({ actor, notificationId }),
    error => error && error.code === 'VALIDATION_ERROR'
  )
}
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js
```

Expected: 三个合法凭证保留提醒编号均因现有 `DOCUMENT_ID` 不接受冒号而失败；普通通知编号的既有断言继续通过。

- [ ] **Step 3: 新增纯判定模块**

创建 `notification-id.js`：

```js
'use strict'

const ORDINARY_NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,128}$/
const EVIDENCE_RETENTION_NOTIFICATION_ID = /^evidence-retention:[A-Za-z0-9_-]{1,128}:(?:1|7|15)$/

function isNotificationId(value) {
  return typeof value === 'string' &&
    (ORDINARY_NOTIFICATION_ID.test(value) || EVIDENCE_RETENTION_NOTIFICATION_ID.test(value))
}

module.exports = { isNotificationId }
```

- [ ] **Step 4: 仅替换已读通知入口的编号规范化**

在 `review-service.js` 导入 `isNotificationId`，新增通知专用规范化函数，并只在 `markNotificationRead` 使用它：

```js
const { isNotificationId } = require('./notification-id')

function normalizeNotificationId(value) {
  if (!isNotificationId(value)) throw createError('VALIDATION_ERROR')
  return value
}
```

```js
return reviewRepository.markNotificationRead({
  actor: normalizeActor(actor),
  notificationId: normalizeNotificationId(notificationId)
})
```

不得替换 `normalizeDocumentId` 的其他调用点。

- [ ] **Step 5: 运行服务测试确认 GREEN**

Run:

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js
```

Expected: 全部通过；合法 `1/7/15` 编号原样传给仓储，非法格式全部为 `VALIDATION_ERROR`。

- [ ] **Step 6: 暂存并提交 Task 1**

```powershell
git add cloudfunctions/businessApi/lib/notification-id.js cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/test/review-service.test.js
git commit -m "fix: 兼容凭证保留提醒编号入口"
```

### Task 2: 让通知列表与已读事务共享严格编号规则

**Files:**
- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js:1-30,304-318,1400-1440,1490-1515`
- Test: `cloudfunctions/businessApi/test/cloud-review-repository.test.js:483-710`

**Interfaces:**
- Consumes: Task 1 的 `isNotificationId(value): boolean`。
- Produces: 合法凭证保留提醒可由收件人列出并标记已读；非法冒号编号不可见且不可生成已读标记。

- [ ] **Step 1: 写仓储列表 RED 测试**

在通知仓储测试中为当前活动账号插入三条真实格式提醒，并验证稳定排序后的结果包含精确编号：

```js
for (const days of [1, 7, 15]) {
  db.seed('notifications', {
    _id: `evidence-retention:business-1:${days}`,
    type: 'evidence_retention',
    recipientUserIds: ['reviewer-1'],
    status: 'pending',
    createdAt: new Date(`2026-08-${10 + days}T00:00:00.000Z`)
  })
}

const result = await repository.listNotifications({
  actor: { _id: 'reviewer-1' },
  page: 1,
  pageSize: 10
})
assert.deepEqual(
  new Set(result.items.map(item => item.notificationId)),
  new Set([
    'evidence-retention:business-1:1',
    'evidence-retention:business-1:7',
    'evidence-retention:business-1:15'
  ])
)
```

- [ ] **Step 2: 写仓储已读与攻击格式 RED 测试**

验证合法提醒可创建当前账号的独立 read marker，再次调用幂等；同时插入以下畸形编号并断言列表隐藏、直接标记已读返回 `FORBIDDEN`：

```js
const invalidIds = [
  'evidence-retention:business-1:2',
  'evidence-retention:../business-1:15',
  'evidence-retention:business-1:15:extra',
  'other-prefix:business-1:15'
]
```

还必须保留以下既有安全断言：非收件人不可见、停用账号不可见、损坏 `recipientUserIds` 失败关闭、跨账号 marker 碰撞拒绝、普通 `notification-1` 与 `legacy-retention` 编号继续可用。

- [ ] **Step 3: 运行仓储测试确认 RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

Expected: 合法凭证保留提醒被 `safeNotificationShape` 过滤，列表或已读断言失败；原通知安全矩阵继续通过。

- [ ] **Step 4: 在仓储投影中使用共享判定**

在 `cloud-review-repository.js` 导入纯函数：

```js
const { isNotificationId } = require('./notification-id')
```

将 `safeNotificationShape` 对通知 `_id` 的通用文档编号检查替换为：

```js
if (!notification || !isNotificationId(notification._id) ||
    !NOTIFICATION_TYPES.has(notification.type)) return null
```

其他业务、节点、审核轮次、投票、凭证和账号字段仍使用原 `DOCUMENT_ID`。

- [ ] **Step 5: 复核已读事务不绕过授权**

保持 `markNotificationRead` 的事务顺序不变：重读活动账号、读取通知、调用 `safeNotificationShape` 复核收件关系、检查确定性 marker 冲突、写入当前账号 marker。不得因为编号兼容提前返回通知，也不得跳过当前账号和收件关系校验。

- [ ] **Step 6: 运行仓储与服务聚焦测试确认 GREEN**

Run:

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

Expected: 全部通过；真实格式提醒可列出和标记已读，攻击格式全部失败关闭，既有通知矩阵无回归。

- [ ] **Step 7: 暂存并提交 Task 2**

```powershell
git add cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
git commit -m "fix: 恢复凭证保留提醒可见性"
```

### Task 3: 全量验证、项目记忆与部署交接

**Files:**
- Modify: `docs/memory/STATUS.md`
- Verify: `cloudfunctions/businessApi/lib/notification-id.js`
- Verify: `cloudfunctions/businessApi/lib/review-service.js`
- Verify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的生产实现与回归测试。
- Produces: 可部署的 `businessApi` 提交，以及不改动 Timer 和现有提醒数据的真实环境验收步骤。

- [ ] **Step 1: 运行完整自动化门禁**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/notification-flow.test.js
node tools/test-wxml-structure.mjs
node --check cloudfunctions/businessApi/lib/notification-id.js
node --check cloudfunctions/businessApi/lib/review-service.js
node --check cloudfunctions/businessApi/lib/cloud-review-repository.js
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: 所有命令退出码为 0；若任一命令失败，不得把任务标记完成，必须记录实际失败并返回对应任务补 RED。

- [ ] **Step 2: 检查安全差异与未授权文件**

```powershell
git status --short
git diff -- cloudfunctions/businessApi/lib/notification-id.js cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

Expected: 生产差异只放宽通知编号这一条严格格式；`project.config.json` 仍为用户原有未暂存修改，不出现在任何本任务提交中。

- [ ] **Step 3: 更新中文项目状态**

在 `docs/memory/STATUS.md` 记录：

- 真实 Timer 已创建合法 15 天 `evidence_retention` 通知，但旧 `businessApi` 因编号规则不一致而隐藏；
- 聚焦 RED 的精确失败数、GREEN 的精确通过数；
- `businessApi`、`evidenceRetention`、小程序通知测试及 WXML 的最新精确结果；
- 只需重新部署 `businessApi`，现有通知数据和三个定时函数触发器不变；
- 真实通知中心显示、跳转与标记已读仍为部署后未验证。

- [ ] **Step 4: 运行记忆与差异最终门禁**

```powershell
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: 两项均通过。

- [ ] **Step 5: 显式暂存并创建最终修复提交**

```powershell
git add cloudfunctions/businessApi/lib/notification-id.js cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js docs/memory/STATUS.md
git commit -m "fix: 兼容凭证保留提醒编号"
```

- [ ] **Step 6: 真实 CloudBase 部署验收**

按以下顺序操作，不运行新的 `evidenceRetention` Timer：

1. 上传部署最新 `businessApi`，核对运行时、超时和既有环境变量不变。
2. 保持 `calendarSync`、`workflowReminder`、`evidenceRetention` 的 `triggers: []`。
3. 用当前 `recipientUserIds` 中且状态为 active 的账号重新编译并进入“通知中心”。
4. 确认现有 15 天 `evidence_retention` 提醒直接出现，内容仍为脱敏摘要。
5. 点击提醒，确认只能导航到安全业务入口，不暴露永久文件 ID、云路径、哈希或内部租约。
6. 标记已读并刷新，确认同一账号显示已读，其他账号的独立已读状态不受影响。
7. 核对数据库只新增当前账号的确定性 `notification_read_marker`，原提醒记录未被改写或重复创建。

Expected: 现有提醒无需迁移或重建即可显示并标记已读；若列表仍不可见，立即停止后续破坏性保留验收并采集 `businessApi` 安全错误码，不再运行清理 Timer。
