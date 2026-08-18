# 业务发起人节点负责人及个人工时明细设计

日期：2026-08-18

状态：产品规则与四部分设计均已确认，允许直接生成实施计划并进入开发。

## 1. 目标

本次改动解决两个相互关联的问题：

1. 每个模板节点可以独立选择“业务发起人作为本节点唯一处理人”；未选择的节点继续使用现有多名候选处理人机制。
2. 运营看板可以按处理轮次查看实际提交人的有效处理分钟，并按实际投票查看审核人的个人有效响应分钟。

计时结果必须基于权威工作日历固化，不能在查询时按当前日历重新推算。历史记录缺少新快照时显示“历史数据未记录”，不得猜测或批量回填。

## 2. 非目标

- 不改变节点顺序，也不把某个节点的负责人来源传播到其他节点。
- 不为未提交处理结果的候选处理人生成零时长记录。
- 不为未投票的审核人生成响应时长记录。
- 不做人员绩效排名、评分、奖金或跨节点难度比较。
- 不修改 `workflowReminder` 或 `evidenceRetention` 的触发器配置。
- 不迁移或推断旧审核票的个人响应时长。

## 3. 模板节点负责人来源

### 3.1 数据契约

新版审核模板节点新增：

```js
processorAssignmentMode: 'fixed_accounts' | 'business_creator'
```

- 缺少该字段的历史模板节点按 `fixed_accounts` 兼容。
- `fixed_accounts` 要求 `processorUserIds` 为非空、严格、自有、无重复且满足索引预算的账号数组。
- `business_creator` 要求 `processorUserIds` 为空数组；模板仍必须配置非空审核人数组。
- 该字段进入模板节点规范化结果、持久化定义、可用模板投影和业务节点快照。
- 未知值、访问器、继承值、混合旧关系字段或与模式不一致的处理人数组失败关闭。

### 3.2 管理端交互

节点编辑页增加开关“业务发起人作为本节点唯一处理人”。

- 开启时清空并禁用手工处理人选择，审核人选择保持可用。
- 关闭时恢复现有多候选处理人选择，至少选择一名处理人。
- 已启用模板继续只读；只读页显示当前负责人来源。
- 每个节点独立保存该字段；排序、移动、复制和编辑其他节点不得改变它。

### 3.3 启用与创建校验

模板启用时只能校验已知的固定账号：固定处理人和全部审核人必须处于活动状态，固定处理人与审核人不得重叠。业务发起人模式在模板启用时尚不知道未来发起人，因此不伪造占位账号。

创建业务时，服务端以当前事务内重新读取的活动发起人账号解析所有 `business_creator` 节点：

- 若发起人出现在该节点 `reviewerUserIds` 中，返回稳定错误 `CREATOR_REVIEWER_CONFLICT`，整笔业务不创建。
- 否则该业务节点固化 `processorUserIds: [creator._id]`、受控显示名称快照和 `processorAssignmentMode: 'business_creator'`。
- 固定账号节点保持原处理人数组，并固化 `processorAssignmentMode: 'fixed_accounts'`。
- 业务成员数组、索引字节预算和 100 次事务操作预算按“解析后的实际参与账号”计算；同一账号跨节点和跨角色去重读取。
- 幂等重试重新校验当前活动账号和输入摘要；同一成功请求返回原快照，不因模板后来修改而变化。

## 4. 处理轮次归属与计时快照

每次提交审核都会创建一个不可变审核轮次，它同时是该处理轮次的事实载体。新轮次增加：

```js
submittedByDisplayName: '受控显示名称',
processorAssignmentMode: 'fixed_accounts' | 'business_creator',
processingRoundTimingStatus: 'calculated' | 'pending_calendar',
processingRoundWorkMinutes: 120 | null,
processingRoundCalendarVersion: '版本' | null,
processingRoundStartedAt: Date,
processingRoundEndedAt: Date
```

- `submittedBy` 继续保存内部账号编号，但运营接口不得投影该编号。
- `submittedByDisplayName` 从提交事务内重新读取的活动账号生成，不信任客户端。
- `processingRoundWorkMinutes` 只表示本轮从 `processingStartedAt` 到提交审核时刻的完整有效工作分钟，不是节点跨轮累计分钟。
- 现有 `processingElapsedWorkMinutes`、剩余和逾期字段继续承担节点 SLA 累计语义，两套字段不能互相替代。
- 驳回后新一轮由实际再次提交的人独立归属；其他候选处理人没有记录。
- 日历缺失时写入起止边界和 `pending_calendar`；既有处理时长补算事务在修正累计值时同步修正本轮分钟，并继续执行版本与边界复核。
- 旧轮次缺少上述字段时，运营接口返回 `historical_unrecorded`，不从累计值反推本轮值。

## 5. 审核人个人响应时长

每条新投票记录增加：

```js
reviewResponseTimingStatus: 'calculated' | 'pending_calendar',
reviewResponseWorkMinutes: 60 | null,
reviewResponseCalendarVersion: '版本' | null,
reviewResponseStartedAt: Date,
reviewResponseEndedAt: Date
```

- 响应区间固定为该审核轮次 `reviewStartedAt` 到该审核人实际投票时刻。
- 或签、会签与驳回都使用同一规则；只记录实际投票人。
- 服务层在写票前使用现有工作时间服务计算完整有效分钟；秒和毫秒按既有完整分钟规则处理。
- 投票事务重新读取活动审核人、业务、节点、轮次和确定性票据，核对计算边界后再写入。
- 同请求重试返回原投票及原计时结果；不得用重试时刻覆盖第一次投票时刻。
- 日历缺失不阻断投票，写入 `pending_calendar` 和不可变边界。

### 5.1 审核响应补算

`calendarSync` 增加独立、持久、公平的审核票响应补算游标：

```text
system_settings/calendar-review-vote-response-cursor
```

候选查询依赖：

```text
node_review_votes(reviewResponseTimingStatus ASC, _id ASC)
```

- 单次原始扫描和返回均不超过 40 条。
- 全失效页仍推进游标，尾页安全回绕；损坏游标失败关闭。
- 每条补算在固定文档事务中重读投票、轮次、节点和业务，校验投票归属、起止边界、审核轮次及 `pending_calendar` 状态。
- 事务只允许把响应计时从 `pending_calendar` 改为 `calculated`；不得修改决定、评论、审核人显示名称、请求摘要或投票时刻。
- 缺少全部新字段的历史投票不进入候选扫描，运营页面显示“历史数据未记录”。

## 6. 运营看板明细

新增受保护接口：

```js
listOperationsTimingDetails({
  fromDate,
  toDate,
  status,
  cursor,
  pageSize
})
```

- 仅当前事务内仍为活动超级管理员的账号可调用。
- `pageSize` 最大 20；每次原始扫描最多 100 个审核轮次，游标基于最后扫描的 `reviewStartedAt` 与 `_id`，即使状态过滤后本页不足也能继续前进。
- 日期范围按处理提交时间 `reviewStartedAt` 过滤，上海自然日闭区间，最大 366 天。
- 业务状态按当前权威业务状态过滤。
- 每个条目对应一个处理/审核轮次，返回业务和节点编号、名称、处理轮次、实际提交人显示名称、负责人来源、处理起止时间、本轮有效分钟、累计逾期和计时状态。
- 条目内只返回该轮实际投票的安全投影：审核人显示名称、决定、投票时间、个人响应分钟和计时状态。
- 不返回账号编号、OpenID、请求摘要、永久文件编号、凭证地址、内部版本、租约或补算游标。
- 查询开始与返回前均重新验证超级管理员；撤权、停用或角色变化后不返回旧结果。

小程序运营看板在现有指标和 CSV 按钮下增加“节点处理时间明细”：

- 使用现有日期和业务状态筛选条件。
- 稳定分页并支持“加载更多”。
- 默认展示轮次处理事实，展开后展示实际投票人的个人响应时间。
- `calculated` 显示“X 分钟”；`pending_calendar` 显示“待补算”；字段缺失显示“历史数据未记录”。
- 本阶段不改变现有 CSV 列和导出语义，避免一行多投票导致处理时长重复统计。

新增运营查询索引：

```text
node_review_rounds(reviewStartedAt DESC, _id ASC)
```

## 7. 错误与并发边界

- 发起人与同节点审核人冲突：`CREATOR_REVIEWER_CONFLICT`，客户端显示明确中文提示。
- 模板模式或关系字段损坏：`TEMPLATE_INVALID` 或 `VALIDATION_ERROR`，不回退到旧 OpenID。
- 账号、业务、节点、轮次或版本在计算窗口内变化：`FORBIDDEN` 或 `VERSION_CONFLICT`，不写入旧快照。
- 日历缺失：业务写入继续，计时诚实标记待补算。
- 补算候选损坏：跳过或失败关闭，不覆盖业务决定。
- 查询基础设施异常：统一安全错误，不回传集合、索引或数据库细节。

## 8. 测试与验收

自动化测试必须先 RED 后 GREEN，至少覆盖：

1. 模板开关保存、只读、排序不串值和旧模板默认兼容。
2. 发起人模式禁止手工处理人、固定模式仍要求非空处理人。
3. 创建时发起人唯一快照、同节点审核冲突、其他节点不受影响、幂等与 100 次预算。
4. 多候选只归属实际提交人；驳回后每轮分别归属。
5. 本轮分钟与节点累计分钟不混淆；日历缺失后处理轮补算。
6. 每个实际投票人的响应分钟、未投票无记录、同票重试不改时刻。
7. 审核票待补算的 40 条游标、公平回绕、损坏关闭、事务不超过 100 次操作。
8. 历史轮次和历史票显示“历史数据未记录”。
9. 运营明细日期/状态/分页、撤权、脱敏、访问器与损坏字段矩阵。
10. 完整 `businessApi`、`calendarSync`、小程序、WXML、语法、差异和项目记忆门禁。

真实 CloudBase 验收包括新增组合索引、云函数部署、模板开关、发起人冲突、多轮处理归属、多人会签响应时间、待补算恢复和运营页面展示。三个定时函数的正式触发器策略不因本设计自动改变。

