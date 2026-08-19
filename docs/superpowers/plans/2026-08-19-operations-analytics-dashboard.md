# 运营统计看板与历史工时分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有运营明细页升级为所有活动用户可查看的模板节点统计柱状图、日/周/月历史趋势与权限受控业务下钻，并通过独立统计工作器生成可恢复的派生事实和每日汇总。

**Architecture:** 权威业务、节点、审核轮次和投票继续保存业务事实；完成事务只标记统计待生成。独立 `operationsAnalytics` 以可信 Timer、固定 40 条批次和持久游标生成确定性事实并事务化应用到每日汇总。`businessApi` 从每日汇总提供全局统计，从事实集合提供权限受控下钻；小程序使用原生 WXML/WXSS 绘制并列柱状图。

**Tech Stack:** 微信小程序原生 JavaScript/WXML/WXSS、CloudBase Node.js 16 云函数、`wx-server-sdk@4.0.2`、`node:test`、现有内存 CloudBase 测试夹具。

**Spec:** `docs/superpowers/specs/2026-08-19-operations-analytics-dashboard-design.md`

## Global Constraints

- 全部生产改动执行 RED → GREEN；每项失败测试必须证明一个真实缺口。
- 不修改、不暂存、不提交操作员自己的 `project.config.json`。
- 所有工作分钟使用完整经过分钟；0 合法，平均值显示一位小数。
- 节点处理样本累计全部处理轮；审核主指标累计全部终态审核轮从 `reviewStartedAt` 到 `decidedAt` 的工作分钟。
- `pending_calendar` 不作为零值；缺少历史快照时标记 `historical_unrecorded`，不得推测。
- 所有活动账号可读取全局汇总；普通账号下钻仍受当前业务权限约束；只有活动超级管理员可导出全量 CSV。
- 客户端不得收到内部账号编号、OpenID、成员数组、请求摘要、永久文件编号、云路径、租约或内部游标结构。
- `operationsAnalytics` 每批固定最多 40 条，只信任 `process.env.TRIGGER_SRC === 'timer'` 和服务端时钟。
- 单个 CloudBase 事务不得超过 100 次文档操作；所有候选扫描、事实和下钻列表均使用固定上限与稳定 keyset 游标。
- `calendarSync`、`workflowReminder`、`evidenceRetention` 的职责和触发器策略保持不变；新工作器初始必须是空触发器。
- 不增加第三方图表依赖，不改变现有 CSV 列。

---

### Task 1：统计领域公式、事实编号与时间分桶

**Files:**

- Create: `cloudfunctions/operationsAnalytics/lib/analytics-domain.js`
- Create: `cloudfunctions/operationsAnalytics/test/analytics-domain.test.js`
- Create: `cloudfunctions/operationsAnalytics/package.json`
- Create: `cloudfunctions/operationsAnalytics/package-lock.json`

**Interfaces:**

- Produces: `factId(type, sourceIds) -> string`
- Produces: `dailyRollupId({ day, templateId, templateVersion, stableNodeId, metric, dimensionRole, dimensionUserId }) -> string`
- Produces: `summarizeNodeFacts({ rounds, votes, reviewMinuteByRoundId }) -> object`
- Produces: `bucketDay(day, grain) -> string`
- Produces: `aggregateRollups(rows, grain) -> chart buckets`
- Produces: `safeAverage(totalMinutes, sampleCount) -> number | null`

- [ ] **Step 1：写领域 RED**

```js
test('节点样本累计全部处理轮和全部终态审核轮', () => {
  const result = summarizeNodeFacts({
    rounds: [
      { _id: 'r1', processingRoundWorkMinutes: 20, status: 'rejected' },
      { _id: 'r2', processingRoundWorkMinutes: 10, status: 'approved' }
    ],
    votes: [],
    reviewMinuteByRoundId: new Map([['r1', 8], ['r2', 4]])
  })
  assert.equal(result.processingWorkMinutes, 30)
  assert.equal(result.reviewProcessWorkMinutes, 12)
})
```

同时覆盖处理人分组、实际审核人轮次筛选、0 分钟、`pending_calendar`、`historical_unrecorded`、上海日/周一/月分桶、跨模板版本默认合并、确定性编号和一位小数。

- [ ] **Step 2：运行 RED**

```powershell
npm.cmd test --prefix cloudfunctions/operationsAnalytics
```

预期：`MODULE_NOT_FOUND`，因为领域模块尚不存在。

- [ ] **Step 3：最小实现领域函数**

```js
function safeAverage(totalMinutes, sampleCount) {
  if (!Number.isSafeInteger(totalMinutes) || totalMinutes < 0 ||
      !Number.isSafeInteger(sampleCount) || sampleCount < 0) throw validationError()
  return sampleCount === 0 ? null : Math.round(totalMinutes * 10 / sampleCount) / 10
}
```

编号使用 SHA-256 和带分隔符的规范字符串；任何访问器、继承值、未知枚举、重复关联或非安全整数失败关闭。

- [ ] **Step 4：运行 GREEN**

```powershell
npm.cmd test --prefix cloudfunctions/operationsAnalytics
```

- [ ] **Step 5：提交 Task 1**

```powershell
git add -- cloudfunctions/operationsAnalytics/package.json cloudfunctions/operationsAnalytics/package-lock.json cloudfunctions/operationsAnalytics/lib/analytics-domain.js cloudfunctions/operationsAnalytics/test/analytics-domain.test.js
git commit -m "feat: 定义运营统计事实与分桶公式"
```

---

### Task 2：在节点与业务完成时标记统计待生成

**Files:**

- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`

**Interfaces:**

- Produces on `business_nodes`: `analyticsSnapshotStatus`, `analyticsSourceVersion`, `analyticsCompletedAt`
- Produces on `business_lines`: `analyticsSnapshotStatus`, `analyticsSourceVersion`, `analyticsCompletedAt`
- Preserves stable node identity: existing `sourceTemplateNodeKey` is the only cross-business node grouping key
- Consumes: existing final approval, business completion, cancellation and amendment invariants

- [ ] **Step 1：写完成事务 RED**

覆盖：

- 节点最终通过后写 `analyticsSnapshotStatus: 'pending'`、安全递增版本和权威 `completedAt`；
- 末节点完成业务时，节点与业务均写独立 pending 标记；
- 快照继续保存并严格读取 `sourceTemplateNodeKey`；不得按可修改的节点名称或业务节点 `_id` 合并历史；
- 驳回、保存进度、提交审核、非末节点等待状态不生成业务完成任务；
- 幂等投票重试不重复提升统计版本；
- 日历待补算仍可标记待生成；
- 事务竞争只有唯一终态和唯一来源版本；
- 已冻结业务的审计修订不重写历史统计来源；
- 事务操作数继续不超过 100。

- [ ] **Step 2：运行 RED**

```powershell
node --test cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js
```

- [ ] **Step 3：最小写入 pending 标记**

```js
const analyticsPatch = {
  analyticsSnapshotStatus: 'pending',
  analyticsSourceVersion: nextSafeVersion(current.analyticsSourceVersion),
  analyticsCompletedAt: decidedAt
}
```

统计标记必须与业务终态写入同一事务，但不能增加任何查询或扫描。

- [ ] **Step 4：运行 GREEN 与预算断言**

```powershell
node --test cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js
```

- [ ] **Step 5：提交 Task 2**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js
git commit -m "feat: 标记运营统计待生成来源"
```

---

### Task 3：`operationsAnalytics` 可信入口与候选游标

**Files:**

- Create: `cloudfunctions/operationsAnalytics/index.js`
- Create: `cloudfunctions/operationsAnalytics/lib/analytics-service.js`
- Create: `cloudfunctions/operationsAnalytics/lib/cloud-analytics-repository.js`
- Create: `cloudfunctions/operationsAnalytics/test/index.test.js`
- Create: `cloudfunctions/operationsAnalytics/test/analytics-service.test.js`
- Create: `cloudfunctions/operationsAnalytics/test/cloud-analytics-repository.test.js`
- Reuse: `cloudfunctions/businessApi/test/helpers/fake-cloud-database.js`

**Interfaces:**

- Produces: `createOperationsAnalyticsHandler({ service, getContext, getTriggerSource, clock, logger })`
- Produces: `service.runCycle({ now, batchSize: 40 })`
- Produces repository methods: `claimNodeCandidates`, `claimBusinessCandidates`, `readNodeSource`, `readBusinessSource`

- [ ] **Step 1：写入口与游标 RED**

覆盖：客户端 OpenID、空来源、事件伪造 Timer、`getWXContext().TRIGGER_SRC` 和客户端时间全部不能授权；只有 `process.env.TRIGGER_SRC === 'timer'` 可运行。处理批量固定 40，返回只含安全计数。

仓储覆盖 40 条失效候选后第 41 条有限可达、空页回绕、损坏游标关闭、并发领取恰一推进、领取后崩溃可在尾部回绕再次到达、版本溢出关闭。

- [ ] **Step 2：运行 RED**

```powershell
npm.cmd test --prefix cloudfunctions/operationsAnalytics
```

预期：生产模块或 package 尚不存在。

- [ ] **Step 3：最小实现可信入口和 CAS 游标**

```js
if (hasClientIdentity || getTriggerSource() !== 'timer') {
  throw safeError('FORBIDDEN', '运营统计任务调用未经授权')
}
return service.runCycle({ now: clock(), batchSize: 40 })
```

固定游标文档分别为 `operations-analytics-node-cursor` 和 `operations-analytics-business-cursor`，查询按 `analyticsSnapshotStatus ASC, _id ASC`。

- [ ] **Step 4：运行 GREEN**

```powershell
npm.cmd test --prefix cloudfunctions/operationsAnalytics
```

- [ ] **Step 5：提交 Task 3**

```powershell
git add -- cloudfunctions/operationsAnalytics
git commit -m "feat: 建立运营统计可信工作器"
```

---

### Task 4：生成确定性事实并应用每日汇总

**Files:**

- Modify: `cloudfunctions/operationsAnalytics/lib/analytics-service.js`
- Modify: `cloudfunctions/operationsAnalytics/lib/cloud-analytics-repository.js`
- Modify: `cloudfunctions/operationsAnalytics/test/analytics-service.test.js`
- Modify: `cloudfunctions/operationsAnalytics/test/cloud-analytics-repository.test.js`
- Modify: `cloudfunctions/operationsAnalytics/lib/analytics-domain.js`
- Modify: `cloudfunctions/operationsAnalytics/test/analytics-domain.test.js`
- Create: `cloudfunctions/operationsAnalytics/lib/work-time-service.js`
- Create: `cloudfunctions/operationsAnalytics/lib/cloud-work-calendar-repository.js`
- Create: `cloudfunctions/operationsAnalytics/test/work-time-service.test.js`
- Create: `cloudfunctions/operationsAnalytics/test/cloud-work-calendar-repository.test.js`

**Interfaces:**

- Produces: `materializeNodeSource({ line, node, rounds, votes }) -> facts[]`
- Produces: `materializeBusinessSource({ line, nodes, nodeFacts }) -> facts[]`
- Produces repository methods: `upsertFact`, `applyFactToDailyRollup`, `markSourceGenerated`
- Produces: `workingMinutesBetween(createdAt, completedAt)` using authoritative `work_calendar_entries`
- Fact lifecycle: `pending_calendar -> calculated`; `historical_unrecorded` terminal

- [ ] **Step 1：写事实与汇总 RED**

使用两轮处理、一轮驳回、一轮通过和多人投票夹具验证：

- 一个节点事实累计全部处理轮和全部审核流程分钟；
- 每个实际提交账号每节点只有一个贡献事实；
- 每个实际投票账号每节点只有一个审核流程贡献事实；
- 每张实际票保留独立个人响应事实；
- 业务事实只在最终完成时生成，并累计其全部节点事实；
- 业务完成工时按业务 `createdAt` 到最终 `completedAt` 的完整工作分钟计算；缺失日历时进入 `pending_calendar`，不得用自然分钟代替；
- 节点聚合必须使用快照的 `sourceTemplateNodeKey`，缺失或损坏时写 `historical_unrecorded`，不得按名称猜测；
- 确定性 `_id` 重跑不重复；
- 事实与每日汇总来源版本匹配后才把源标为 generated；
- `pending_calendar` 不增加有效 `sampleCount`，补算后只转换一次；
- `historical_unrecorded` 只增加缺失计数；
- 每条事实应用事务固定读取事实和汇总，远低于 100 次操作。

- [ ] **Step 2：运行 RED**

```powershell
npm.cmd test --prefix cloudfunctions/operationsAnalytics
```

- [ ] **Step 3：实现事实状态机与汇总账本**

```js
const FACT_STATES = new Set(['calculated', 'pending_calendar', 'historical_unrecorded'])

function rollupDelta(fact) {
  if (fact.timingStatus === 'calculated') {
    return { sampleCount: 1, totalMinutes: fact.workMinutes, pendingCount: 0, unrecordedCount: 0 }
  }
  if (fact.timingStatus === 'pending_calendar') {
    return { sampleCount: 0, totalMinutes: 0, pendingCount: 1, unrecordedCount: 0 }
  }
  return { sampleCount: 0, totalMinutes: 0, pendingCount: 0, unrecordedCount: 1 }
}
```

事实记录保存 `rollupAppliedVersion`；事实状态升级时事务先撤销旧增量再应用新增量，禁止重复或逆向转换。工作日历读取严格校验日期、活动代际和 `isWorkday`，复用现有 09:00–20:00 上海工作时间口径。

- [ ] **Step 4：运行 GREEN 与全量工作器测试**

```powershell
npm.cmd test --prefix cloudfunctions/operationsAnalytics
```

- [ ] **Step 5：提交 Task 4**

```powershell
git add -- cloudfunctions/operationsAnalytics/lib cloudfunctions/operationsAnalytics/test
git commit -m "feat: 生成运营事实与每日汇总"
```

---

### Task 5：全局汇总、模板节点图表与筛选目录接口

**Files:**

- Modify: `cloudfunctions/businessApi/lib/operations-domain.js`
- Modify: `cloudfunctions/businessApi/lib/operations-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-operations-repository.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/operations-domain.test.js`
- Modify: `cloudfunctions/businessApi/test/operations-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-operations-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**

- Produces protected action: `getOperationsAnalyticsFilters`
- Produces protected action: `getOperationsAnalyticsSummary`
- Summary input: `{ startDate, endDate, grain, templateId, templateVersion?, status?, businessLineId?, stableNodeId?, processorUserId?, reviewerUserId? }`
- Summary output: `{ notice, templateMetrics, nodeSeries, trendSeries, missingCounts }`

- [ ] **Step 1：写汇总 RED**

覆盖：

- 任意活动账号可查汇总，停用账号和不存在账号拒绝；
- 查询开始和返回前均重读当前账号；
- 日期最大 366 天，粒度只允许 day/week/month，所有输入只接受自有数据属性；
- 模板、版本、节点和受控人员目录来自服务端，不信任客户端名称；
- 默认跨版本合并，指定版本严格过滤；
- 日/周/月组合每日汇总，平均值一位小数，0 分钟合法；
- 节点顺序来自模板稳定节点定义，不按名称排序；
- 返回只含安全名称与统计值，不含内部账号编号或汇总文档结构；
- 处理人和审核人筛选分别使用对应维度汇总。

- [ ] **Step 2：运行 RED**

```powershell
node --test cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

- [ ] **Step 3：实现严格规范化和安全投影**

```js
const ANALYTICS_GRAINS = new Set(['day', 'week', 'month'])

async function getAnalyticsSummary({ actor, query }) {
  requireActiveActor(actor)
  return repository.getAnalyticsSummary({ actor, query: normalizeAnalyticsQuery(query, clock()) })
}
```

人员筛选请求使用服务端签发的短期不透明筛选值或受控编码；客户端不得直接获得内部账号编号。

- [ ] **Step 4：运行 GREEN**

```powershell
node --test cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

- [ ] **Step 5：提交 Task 5**

```powershell
git add -- cloudfunctions/businessApi/lib/operations-domain.js cloudfunctions/businessApi/lib/operations-service.js cloudfunctions/businessApi/lib/cloud-operations-repository.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
git commit -m "feat: 提供模板节点统计汇总"
```

---

### Task 6：精确中位数与权限受控业务下钻

**Files:**

- Modify: `cloudfunctions/businessApi/lib/operations-domain.js`
- Modify: `cloudfunctions/businessApi/lib/operations-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-operations-repository.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/operations-domain.test.js`
- Modify: `cloudfunctions/businessApi/test/operations-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-operations-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**

- Produces protected action: `listOperationsAnalyticsSamples`
- Input binds the exact summary filter plus `{ metric, bucket, cursor, pageSize }`
- Output: `{ statistics, items, nextCursor, hasMore, globalSampleCount, visibleSampleCount }`

- [ ] **Step 1：写下钻 RED**

覆盖：

- 所有活动账号可调用，但普通账号只返回其现有业务关系允许读取的样本；
- 超级管理员返回全部合法样本；
- 查询候选后停用账号、撤业务成员/处理/审核关系或改变业务关联时最终复核隐藏；
- 无权、缺失和损坏业务统一隐藏，不形成存在性探针；
- 精确中位数使用完整选定事实集合，样本超过固定安全上限时返回 `ANALYTICS_RANGE_TOO_LARGE`；
- keyset 游标绑定全部筛选、指标和时间桶，不能跨筛选复用；
- 页面统计可显示全局样本数大于普通用户可见明细数；
- 展开节点只投影处理轮、终态审核轮、实际提交人安全名称、实际票及个人响应分钟。

- [ ] **Step 2：运行 RED**

```powershell
node --test cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

- [ ] **Step 3：实现固定文档最终授权与精确统计**

```js
function exactMedian(values) {
  if (values.length > 2000) throw createError('ANALYTICS_RANGE_TOO_LARGE')
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
```

普通用户授权复用业务详情已有的新账号关系与纯旧兼容边界；不得新增更宽松的历史读取路径。

- [ ] **Step 4：运行 GREEN**

```powershell
node --test cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

- [ ] **Step 5：提交 Task 6**

```powershell
git add -- cloudfunctions/businessApi/lib/operations-domain.js cloudfunctions/businessApi/lib/operations-service.js cloudfunctions/businessApi/lib/cloud-operations-repository.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/operations-domain.test.js cloudfunctions/businessApi/test/operations-service.test.js cloudfunctions/businessApi/test/cloud-operations-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
git commit -m "feat: 开放权限受控统计下钻"
```

---

### Task 7：原生柱状图、趋势和筛选抽屉

**Files:**

- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/dashboard/index.js`
- Modify: `miniprogram/pages/dashboard/index.wxml`
- Modify: `miniprogram/pages/admin-operations/index.js`
- Modify: `miniprogram/pages/admin-operations/index.wxml`
- Modify: `miniprogram/pages/admin-operations/index.wxss`
- Modify: `miniprogram/test/admin-operations-flow.test.js`
- Modify: `miniprogram/test/account-flow.test.js`
- Modify: `miniprogram/test/business-template-flow.test.js`
- Verify: `tools/test-wxml-structure.mjs`

**Interfaces:**

- Consumes: `getOperationsAnalyticsFilters`, `getOperationsAnalyticsSummary`, `listOperationsAnalyticsSamples`
- Produces client state: `filters`, `grainOptions`, `templateMetrics`, `nodeSeries`, `trendSeries`, `detailDrawer`

- [ ] **Step 1：写客户端 RED**

覆盖：

- 运营看板入口对所有活动账号可见；停用或无当前账号仍拒绝；
- 默认日期 30 天、粒度 week，常用筛选直接显示，高级筛选抽屉显示启用数量；
- 模板节点按稳定顺序绘制处理/审核并列柱和统一比例尺；
- 日/周/月趋势手动切换；
- 模板级三个指标显示平均值和样本数；
- 点击柱子打开明细抽屉，显示平均、中位、最短/最长、待补算、历史未记录和分页业务；
- 普通用户显示“全局汇总，明细按权限展示”；
- 请求 single-flight，日期/模板/账号/页面隐藏变化使旧响应失效；
- 待补算、历史未记录、空状态、范围过大和基础设施错误使用固定中文；
- CSV 按钮只对超级管理员显示且原行为不变。

- [ ] **Step 2：运行 RED**

```powershell
node --test miniprogram/test/admin-operations-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/business-template-flow.test.js
node tools/test-wxml-structure.mjs
```

- [ ] **Step 3：实现原生图表与安全交互**

```js
function barWidth(value, maxValue) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(maxValue) || maxValue <= 0) return 0
  return Math.max(value === 0 ? 0 : 4, Math.round(value * 100 / maxValue))
}
```

WXML 使用 `scroll-view scroll-x`、两种柱色、可点击数据集和底部抽屉；不得拼接 HTML 或执行服务端文本。

- [ ] **Step 4：运行 GREEN**

```powershell
node --test miniprogram/test/admin-operations-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/business-template-flow.test.js
node tools/test-wxml-structure.mjs
```

- [ ] **Step 5：提交 Task 7**

```powershell
git add -- miniprogram/services/business.js miniprogram/pages/dashboard/index.js miniprogram/pages/dashboard/index.wxml miniprogram/pages/admin-operations/index.js miniprogram/pages/admin-operations/index.wxml miniprogram/pages/admin-operations/index.wxss miniprogram/test/admin-operations-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/business-template-flow.test.js
git commit -m "feat: 展示模板节点统计柱状图"
```

---

### Task 8：部署手册、索引契约与项目记忆

**Files:**

- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`
- Modify: `docs/memory/decisions/ADR-0010-operations-analytics-materialized-facts.md`
- Create: `.superpowers/sdd/2026-08-19-operations-analytics-dashboard/task-report.md`（若受既有 ignore，则保留本地）
- Create or Modify: deployment contract test under the existing documentation test location

**Interfaces:**

- Documents exact collections, permissions, indexes, empty-trigger deployment and acceptance order

- [ ] **Step 1：写部署契约 RED**

契约测试必须从生产 `.where().orderBy()` 查询提取或明确匹配以下类别：待生成节点、待生成业务、事实完成日/模板/节点/参与者、每日汇总日期/模板/版本/节点/人员、事实下钻完成时间游标。手册缺一项即失败。

- [ ] **Step 2：运行 RED**

```powershell
node --test cloudfunctions/operationsAnalytics/test/deployment-contract.test.js
```

- [ ] **Step 3：更新中文部署手册与记忆**

手册必须要求：

- 两个新集合先备份检查、创建并设为仅云函数读写；
- 索引全部生效后才部署工作器；
- `operationsAnalytics` 初始和回滚状态均为 `triggers: []`；
- 一次性 Timer 只用无敏感隔离数据；
- 多账号核对全局汇总和下钻权限；
- 每 15 分钟正式触发器仍需验收后单独批准；
- `project.config.json` 不属于功能提交。

ADR 状态在真实实现完成后改为“已接受并已本地实现，真实部署未验证”。

- [ ] **Step 4：运行 GREEN**

```powershell
node --test cloudfunctions/operationsAnalytics/test/deployment-contract.test.js
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

- [ ] **Step 5：提交 Task 8**

```powershell
git add -- docs/deployment/template-node-fields-setup.md docs/memory/PROJECT.md docs/memory/STATUS.md docs/memory/decisions/ADR-0010-operations-analytics-materialized-facts.md cloudfunctions/operationsAnalytics/test/deployment-contract.test.js
git commit -m "docs: 记录运营统计部署与验收"
```

---

### Task 9：全量门禁、独立复审与交付冻结

**Files:**

- Modify: `docs/memory/STATUS.md`（只更新最终精确证据）
- Modify: `.superpowers/sdd/2026-08-19-operations-analytics-dashboard/task-report.md`

**Interfaces:**

- Produces a clean, locally committed implementation with exact verification evidence

- [ ] **Step 1：运行全部套件**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/operationsAnalytics
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

- [ ] **Step 2：运行生产语法、差异与记忆门禁**

对全部变更生产 JavaScript 执行 `node --check`，然后运行：

```powershell
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
git status --short
```

确认 `project.config.json` 始终未暂存。

- [ ] **Step 3：执行安全自审**

逐项检查：全局汇总无明细泄漏、普通账号下钻关系复核、停用账号旧响应、人员筛选不暴露内部编号、事实状态转换、汇总重复应用、中位数完整性、每事务 100 次预算、Timer 来源和所有中文错误边界。

- [ ] **Step 4：请求只读代码复审并修复所有 Critical/Important**

复审范围从设计提交 `0ae7eb1` 的后继实现提交开始，仅审查本计划范围。任何 Critical/Important 必须新增 RED、最小 GREEN、全量复验和独立修复提交；不得仅更新报告宣称解决。

- [ ] **Step 5：冻结最终证据提交**

```powershell
git add -- docs/memory/STATUS.md
git diff --cached --check
git commit -m "docs: 冻结运营统计交付证据"
```

最终报告必须给出每个本地提交、各套测试精确计数、工作树状态，以及真实 CloudBase 集合/索引/Timer、多账号、开发者工具和真机仍未验证的边界；不得自动推送远端或启用正式触发器。
