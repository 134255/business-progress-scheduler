# 业务发起人节点负责人及个人工时明细 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为每个模板节点增加“业务发起人作为唯一处理人”的独立配置，并把实际处理人每轮处理工作分钟、实际审核人每票响应工作分钟安全固化和展示在运营看板明细中。

**Architecture:** 模板定义只保存负责人来源策略；创建业务时在事务内把策略解析成不可变节点账号快照。提交审核时把本轮实际提交人和本轮处理计时写入 `node_review_rounds`，投票时把实际投票人的个人响应计时写入 `node_review_votes`。日历缺失时只保存不可变边界，由 `calendarSync` 的独立有界游标补算。运营查询读取已固化事实，不在查询阶段重算，也不返回内部账号标识。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、CloudBase 云函数、Node.js 16、`node:test`、现有内存 CloudBase 测试夹具。

**Spec:** `docs/superpowers/specs/2026-08-18-initiator-processor-worktime-analytics-design.md`

## Global Constraints

- 全部生产改动严格执行 RED → GREEN；失败测试必须命名其防止的真实破坏。
- 新账号关系只接受对象自身的数据属性、严格数组和合法内部账号编号；访问器、继承值、重复、未知模式一律失败关闭。
- 历史记录缺少新字段时只显示“历史数据未记录”，不得推断、伪造或批量回填。
- `workflowReminder` 与 `evidenceRetention` 的正式触发器策略保持不变；`evidenceRetention` 继续保持 `triggers: []`。
- 不修改、不暂存用户自己的 `project.config.json`。
- 所有错误对客户端使用稳定中文映射；不得泄漏 OpenID、账号内部编号、集合名、索引细节、请求摘要或底层异常。
- 单个事务不超过 CloudBase 100 次文档操作；候选扫描与补算每批不超过 40 条。

---

## Task 1：模板节点负责人来源契约与管理端交互

**Files:**

- Modify: `cloudfunctions/businessApi/lib/template-domain.js`
- Modify: `cloudfunctions/businessApi/test/template-domain.test.js`
- Modify: `cloudfunctions/businessApi/test/template-service.test.js`
- Modify: `miniprogram/pages/admin-template-node-edit/index.js`
- Modify: `miniprogram/pages/admin-template-node-edit/index.wxml`
- Modify: `miniprogram/pages/admin-template-node-edit/index.wxss`
- Modify: `miniprogram/test/template-flow.test.js`
- Modify: `miniprogram/test/wxml-structure.test.js`（若该文件不存在，则扩展现有 WXML 门禁对应测试）

### Step 1：写失败测试

覆盖以下可观察行为：

- 缺少 `processorAssignmentMode` 的旧节点规范化为 `fixed_accounts`。
- `fixed_accounts` 必须有非空、严格、无重复的 `processorUserIds`。
- `business_creator` 必须把 `processorUserIds` 规范化为空数组，但仍要求审核人非空。
- 未知模式、继承属性、访问器或模式与处理人数组冲突时失败关闭。
- 管理端开关逐节点保存；开启后清空并禁用手工处理人，关闭后恢复选择且不影响其他节点和排序。
- 已启用模板页面仍只读并展示负责人来源。

### Step 2：运行 RED

```powershell
node --test cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js miniprogram/test/template-flow.test.js
node tools/test-wxml-structure.mjs
```

确认失败只来自新模式尚未实现或页面尚无开关。

### Step 3：最小实现并运行 GREEN

新增统一常量和严格规范化分支；页面保存 `processorAssignmentMode`，所有节点操作保留该字段。再次运行上述命令，直至全绿。

### Step 4：提交

```powershell
git add -- cloudfunctions/businessApi/lib/template-domain.js cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js miniprogram/pages/admin-template-node-edit/index.js miniprogram/pages/admin-template-node-edit/index.wxml miniprogram/pages/admin-template-node-edit/index.wxss miniprogram/test/template-flow.test.js
git commit -m "feat: 配置节点负责人来源"
```

---

## Task 2：创建业务时解析发起人唯一处理快照

**Files:**

- Modify: `cloudfunctions/businessApi/lib/business-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/business-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `miniprogram/test/business-template-flow.test.js`
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/utils/safe-error.js`

### Step 1：写失败测试

用真实服务与仓储边界覆盖：

- `business_creator` 节点在创建事务中只写当前活动发起人一个 `processorUserId` 和安全显示名快照。
- 同一模板的其他固定节点完全不受影响。
- 发起人同时位于该节点审核人数组时返回 `CREATOR_REVIEWER_CONFLICT`，不留下业务、节点或计数器半成品。
- 创建人被停用、关系字段损坏或事务中模板版本变化时失败关闭。
- 幂等重试返回原业务快照，不因模板后续修改而改变。
- 成员数组、索引字段预算和事务 100 次预算按解析后的实际参与账号去重计算；100 次允许、101 次事务前拒绝。
- 客户端把冲突码映射为明确中文，不显示原始码。

### Step 2：运行 RED

```powershell
node --test cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js miniprogram/test/business-template-flow.test.js
```

### Step 3：最小实现并运行 GREEN

在服务预计算与事务最终复核之间传递模板模式，但只在事务读取当前活动创建人后解析最终处理人数组。节点快照明确写入 `processorAssignmentMode`。错误映射使用白名单，不暴露内部账号。

### Step 4：提交

```powershell
git add -- cloudfunctions/businessApi/lib/business-service.js cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js miniprogram/test/business-template-flow.test.js miniprogram/services/business.js miniprogram/utils/safe-error.js
git commit -m "feat: 快照化发起人节点负责人"
```

---

## Task 3：固化实际提交人和每轮处理时间

**Files:**

- Modify: `cloudfunctions/businessApi/lib/review-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`
- Modify: `cloudfunctions/businessApi/test/review-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- Modify: `cloudfunctions/calendarSync/lib/calendar-sync-service.js`
- Modify: `cloudfunctions/calendarSync/lib/cloud-calendar-repository.js`
- Modify: `cloudfunctions/calendarSync/test/calendar-sync-service.test.js`
- Modify: `cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js`

### Step 1：写失败测试

- 多候选处理人只把本轮时间归属给实际提交者，且写入安全显示名快照和负责人来源。
- 驳回后的第二轮由第二次实际提交者单独归属，第一轮快照不变。
- `processingRoundWorkMinutes` 只表示当前处理段，不复用节点累计值。
- 日历齐全写 `calculated`；日历缺失写 `pending_calendar`、不可变开始/结束边界和空分钟，不阻断提交审核。
- 同请求幂等重试不改变提交者、结束时间或分钟；改请求冲突。
- 旧轮次字段缺失保持历史未记录，不进入补算候选。
- 处理时长延续补算同时保持现有节点累计/锁版本语义和新增轮次段语义一致。

### Step 2：运行 RED

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/calendarSync/test/calendar-sync-service.test.js cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js
```

### Step 3：最小实现并运行 GREEN

复用现有工作时间结果，把当前处理段和累计处理时间分别持久化。补算只处理显式新状态和完整边界；更新轮次与节点锁版本时保持原事务不变量，单条事务继续低于 100 次操作。

### Step 4：提交

```powershell
git add -- cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/calendarSync/lib/calendar-sync-service.js cloudfunctions/calendarSync/lib/cloud-calendar-repository.js cloudfunctions/calendarSync/test/calendar-sync-service.test.js cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js
git commit -m "feat: 固化处理轮次个人工时"
```

---

## Task 4：固化实际审核人的个人响应时间

**Files:**

- Modify: `cloudfunctions/businessApi/lib/review-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`
- Modify: `cloudfunctions/businessApi/test/review-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`

### Step 1：写失败测试

- 每条新票写入从本轮 `reviewStartedAt` 到实际投票时刻的个人工作分钟和日历版本。
- 或签第一票、会签中间票、最终票和驳回票都保存自己的响应快照。
- 未投票审核人不生成票，也不生成零分钟记录。
- 日历缺失时票仍成功，写 `pending_calendar` 和不可变边界。
- 同票同输入幂等返回原时间；修改决定或评论返回 `VOTE_CONFLICT`。
- 投票人与当前账号、轮次、节点、业务关联或版本变化时先拒绝，再比较请求摘要。

### Step 2：运行 RED

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

### Step 3：最小实现并运行 GREEN

服务把现有投票时工作时间计算结果传入仓储；仓储在同一投票事务中写入 `reviewResponse*` 字段，不能把终态轮次累计审核时间误当作个人响应时间。

### Step 4：提交

```powershell
git add -- cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
git commit -m "feat: 固化审核人响应工时"
```

---

## Task 5：审核票响应时间的日历补算游标

**Files:**

- Modify: `cloudfunctions/calendarSync/lib/calendar-sync-service.js`
- Modify: `cloudfunctions/calendarSync/lib/cloud-calendar-repository.js`
- Modify: `cloudfunctions/calendarSync/test/calendar-sync-service.test.js`
- Modify: `cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js`
- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `docs/memory/decisions/ADR-0006-index-budget-and-history-snapshots.md`

### Step 1：写失败测试

- 新增固定游标 `calendar-review-vote-response-cursor`，每批最多 40 条原始候选。
- 只选择自有、严格 `reviewResponseTimingStatus: pending_calendar` 且完整边界的新票。
- 事务内重读票、轮次、节点和业务，验证不可变关联、边界、决定、创建时间和当前版本链后才更新。
- 40 条损坏候选不能永久遮挡第 41 条合法候选；空页回绕；并发领取不重复；崩溃后有限回绕；损坏游标和版本溢出失败关闭。
- 已计算票、旧票和未投票审核人永不被扫描或改写。
- 单条补算与游标领取事务均不超过 100 次操作。

### Step 2：运行 RED

```powershell
npm.cmd test --prefix cloudfunctions/calendarSync
```

### Step 3：最小实现并运行 GREEN

沿用现有公平游标/CAS 模式，增加独立票据补算路径；部署手册新增非唯一组合索引：

```text
node_review_votes(reviewResponseTimingStatus ASC, _id ASC)
```

不改变任何正式 Timer 配置。

### Step 4：提交

```powershell
git add -- cloudfunctions/calendarSync/lib/calendar-sync-service.js cloudfunctions/calendarSync/lib/cloud-calendar-repository.js cloudfunctions/calendarSync/test/calendar-sync-service.test.js cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js docs/deployment/template-node-fields-setup.md docs/memory/decisions/ADR-0006-index-budget-and-history-snapshots.md
git commit -m "feat: 补算审核人响应工时"
```

---

## Task 6：受保护的运营工时明细接口

**Files:**

- Modify: `cloudfunctions/businessApi/lib/operations-domain.js`
- Modify: `cloudfunctions/businessApi/lib/operations-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-operations-repository.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/operations-domain.test.js`
- Modify: `cloudfunctions/businessApi/test/operations-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-operations-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `docs/deployment/template-node-fields-setup.md`

### Step 1：写失败测试

- 新增受保护动作 `listOperationsTimingDetails`，只接受活动超级管理员。
- 日期范围按上海自然日且最多 366 天；状态白名单；`pageSize` 最大 20；游标严格、确定、不可伪造。
- 按 `reviewStartedAt DESC, _id ASC` 稳定 keyset 扫描，原始扫描窗口最多 100 条，过滤后仍推进原始游标避免饥饿。
- 每个轮次投影业务编号/名称、节点编号/名称、处理轮次、提交人显示名、负责人来源、本轮分钟/逾期/状态。
- 展开票据仅投影审核人显示名、决定、投票时间、个人响应分钟/状态；不返回内部账号 ID、OpenID、请求摘要、永久文件 ID 或租约。
- 查询期间撤销超级管理员、冻结业务或损坏关联时最终复核失败关闭。
- 历史字段缺失投影为 `recorded: false`，不能变成 0。

### Step 2：运行 RED

```powershell
node --test cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

### Step 3：最小实现并运行 GREEN

查询使用当前活动超级管理员固定文档事务授权，列表返回前再做最终账号/角色复核。新增索引：

```text
node_review_rounds(reviewStartedAt DESC, _id ASC)
```

保留现有聚合指标和 CSV 输出不变。

### Step 4：提交

```powershell
git add -- cloudfunctions/businessApi/lib/operations-domain.js cloudfunctions/businessApi/lib/operations-service.js cloudfunctions/businessApi/lib/cloud-operations-repository.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js docs/deployment/template-node-fields-setup.md
git commit -m "feat: 提供运营个人工时明细"
```

---

## Task 7：运营看板工时明细页面

**Files:**

- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/admin-operations/index.js`
- Modify: `miniprogram/pages/admin-operations/index.wxml`
- Modify: `miniprogram/pages/admin-operations/index.wxss`
- Modify: `miniprogram/test/admin-operations-flow.test.js`
- Modify: `miniprogram/test/wxml-structure.test.js`（若不存在则扩展当前 WXML 门禁）

### Step 1：写失败测试

- 页面加载指标后独立加载“节点处理时间明细”，加载失败不伪造空数据。
- 日期/状态变化使旧请求结果失效，分页追加按轮次 ID 去重，重复点击 single-flight。
- 展开轮次显示实际投票明细；未投票人不存在；`calculated`、`pending_calendar`、历史未记录三种状态文案准确。
- 发起人模式显示“业务发起人”，固定模式显示“固定候选处理人”。
- 账号切换、页面隐藏或撤权后旧结果不得写回。
- 原指标、CSV 按钮、空状态和中文安全错误保持正常。

### Step 2：运行 RED

```powershell
node --test miniprogram/test/admin-operations-flow.test.js
node tools/test-wxml-structure.mjs
```

### Step 3：最小实现并运行 GREEN

新增服务包装与页面明细状态；所有格式化在客户端只处理服务端安全投影，不接受底层错误原文。

### Step 4：提交

```powershell
git add -- miniprogram/services/business.js miniprogram/pages/admin-operations/index.js miniprogram/pages/admin-operations/index.wxml miniprogram/pages/admin-operations/index.wxss miniprogram/test/admin-operations-flow.test.js
git commit -m "feat: 展示节点个人工时明细"
```

---

## Task 8：全量门禁、项目记忆与部署交付

**Files:**

- Modify: `docs/memory/STATUS.md`
- Modify: `docs/memory/PROJECT.md`（仅当稳定规则确实变化）
- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `.superpowers/sdd/2026-08-18-initiator-processor-worktime-analytics/task-report.md`（本地报告，若受仓库忽略则不强行暂存）

### Step 1：运行完整验证

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

对所有改动生产 JavaScript 运行 `node --check`，并检查真实测试计数与失败输出。

### Step 2：更新证据与部署步骤

在 `STATUS.md` 写入精确 RED/GREEN、完整门禁计数、提交号、未验证边界和下一步。部署手册明确两个新索引、云函数部署顺序、模板开关、多轮/会签/待补算/运营明细验收；所有定时函数仍默认空触发器，除非另行批准一次性验收。

### Step 3：最终门禁

```powershell
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
git status --short
```

确认只有允许文件，`project.config.json` 未暂存。

### Step 4：最终证据提交

```powershell
git add -- docs/memory/STATUS.md docs/memory/PROJECT.md docs/deployment/template-node-fields-setup.md
git diff --cached --check
git commit -m "docs: 记录节点个人工时交付证据"
```

若 `PROJECT.md` 的稳定规则没有变化，则不得为了凑齐文件而修改或暂存它。完成后报告：各阶段本地提交号、各套测试精确计数、CloudBase/开发者工具/真机未验证项，以及用户下一步只需执行的部署清单。
