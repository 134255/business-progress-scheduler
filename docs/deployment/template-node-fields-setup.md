# 模板、动态字段、凭证与定时清理部署手册

本手册用于把已经通过本地自动化验证的模板、业务快照、动态字段反馈、节点独立审核、驳回与冻结修订、120 MiB 处理轮大凭证、工作日历、处理/审核提醒以及 60 天清理能力部署到目标 CloudBase 环境。

目标环境标识为 `cloud1-d5gxt99rh492670d9`，小程序 AppID 标识为 `wx6dcce945f944e52f`。这些标识不是凭据。密码、恢复码、哈希、OpenID、真实客户数据和文件内容不得写入本手册、Git、截图说明或验收记录。

## 一、部署原则

- 必须按“备份、集合、唯一性检查、索引、业务云函数、定时云函数、触发器、验收”的顺序执行。
- `businessApi`、`businessSearch`、`nodeTextParser`、`calendarSync`、`workflowReminder`、`evidenceRetention` 和 `operationsAnalytics` 均选择“上传并部署：云端安装依赖”。不要上传本地 `node_modules`。
- 首次验收时 `businessSearch`、`nodeTextParser`、`calendarSync`、`workflowReminder`、`evidenceRetention` 与 `operationsAnalytics` 均保持 `triggers: []`；`nodeTextParser` 不配置任何 Timer，仅能消费 `businessApi` 签发的一次性内部票据。仅在隔离验收通过后分阶段启用日历每日同步和小时级提醒，检索回填与运营统计的周期任务必须另行批准。
- 不删除旧集合，不批量伪造旧业务编号，不用回滚为由删除凭证元数据或审计记录。
- 所有客户端读写继续经过云函数；模板、业务、节点、反馈、凭证和审计集合禁止小程序端直接写入。
- 每完成一阶段都记录时间、操作员、结果和可回退点，但只记录脱敏结论。

## 二、部署前检查

### 2.1 确认代码和环境

1. 确认使用待发布提交，而不是未保存的编辑器内容。
2. 在微信开发者工具中确认 `cloudfunctions` 当前环境勾选 `cloud1`，并核对完整环境 ID 为 `cloud1-d5gxt99rh492670d9`。
3. 确认 `businessApi` 的环境变量仍有效；不要把变量值复制到终端、文档或聊天中。
4. 在 CloudBase 控制台记录当前 `businessApi` 可回退版本号或上传时间。
5. 确认本地验证命令全部通过，且 `git status --short` 没有需要部署但尚未提交的源码。

### 2.2 备份并验证可读性

先导出以下集合：

- `templates`
- `template_nodes`
- `sequence_counters`（若已存在）
- `business_lines`
- `business_nodes`
- `node_feedback`
- `evidences`
- `notifications`
- `audit_logs`
- `node_review_rounds`
- `node_review_votes`
- `work_calendar_entries`
- `work_calendar_years`
- `calendar_sync_requests`
- `public_node_shares`
- `public_node_share_chunks`
- `operations_analytics_facts`
- `operations_analytics_daily`
- `business_search_documents`
- `business_search_requests`
- `node_text_parse_requests`
- `node_text_parse_usage`

对每份导出执行以下检查：

1. 下载完成且文件大小不是异常的 0 字节。
2. 在本地离线打开，确认格式可解析，并抽查首尾记录结构。
3. 对比控制台记录数与导出记录数；若导出工具采用分片，核对所有分片总数。
4. 把备份保存到受控位置，不提交 Git，不通过普通聊天发送。

`node_review_rounds`、`node_review_votes`、`work_calendar_entries`、`work_calendar_years`、`calendar_sync_requests`、`public_node_shares`、`public_node_share_chunks`、`operations_analytics_facts`、`operations_analytics_daily`、`business_search_documents`、`business_search_requests`、`node_text_parse_requests` 与 `node_text_parse_usage` 可能在首次部署前尚不存在：控制台明确显示集合不存在时，记录“未创建、无历史数据”，继续后续集合创建；一旦集合存在，其导出失败、无法读取或数量不一致时停止部署。其余已存在集合任一导出失败、无法读取或数量不一致时同样停止部署。

## 三、集合准备

在“数据库 → 集合管理”中确认以下集合存在；缺失时创建，已存在时不要重建：

| 集合 | 用途 |
|---|---|
| `templates` | 模板元数据与生命周期 |
| `template_nodes` | 节点、负责人、SLA、凭证规则和字段定义 |
| `sequence_counters` | 上海自然日业务编号计数器 |
| `business_lines` | 业务实例、成员、当前节点和冻结期限 |
| `business_nodes` | 模板节点快照与运行状态 |
| `node_feedback` | 不可变反馈版本及内部预约状态 |
| `evidences` | 文件元数据、关联、租约与清理状态 |
| `work_calendar_entries` | 按唯一 generation 保存的不可变工作日记录 |
| `work_calendar_years` | 每年活动 generation 指针与同步租约 |
| `calendar_sync_requests` | 超级管理员人工同步的短效一次性票据 |
| `node_review_rounds` | 节点处理提交后的独立审核轮次、双 SLA 快照和结论 |
| `node_review_votes` | 每位审核人的确定性不可变投票 |
| `system_settings` | 账号守卫及日历补算的无业务内容持久游标 |
| `notifications` | 站内通知和凭证到期提醒 |
| `audit_logs` | 模板、业务、反馈、修订和清理审计 |
| `public_node_shares` | 七日公开节点固定快照头与发布状态 |
| `public_node_share_chunks` | 每块最多 40 条的公开凭证快照 |
| `operations_analytics_facts` | 完成业务与节点的确定性统计事实、权限受控下钻样本 |
| `operations_analytics_daily` | 按上海自然日、模板、稳定节点和匿名参与人维度维护的每日汇总 |
| `business_search_documents` | 当前内容代际的安全检索条目和 HMAC 倒排令牌 |
| `business_search_requests` | `businessApi` 调用检索工作器的短效一次性票据摘要 |
| `node_text_parse_requests` | `businessApi` 调用 AI 解析工作器的五分钟单次票据摘要，不保存原文或候选值 |
| `node_text_parse_usage` | 按账号不可逆摘要维护分钟/上海自然日额度与单飞锁 |

集合权限使用“仅云函数/服务端可读写”或等效的最严格配置。不要为了调试开放全体用户读写。

## 四、唯一索引前置检查

### 4.1 `business_lines.code`

1. 检索所有非空 `code`。
2. 按 `code` 分组，确认不存在数量大于 1 的值。
3. 同时检查旧记录中的空值、`null` 和缺失字段。若控制台因多条空值记录而无法创建唯一索引，停止操作，不要临时填入虚假编号；另行设计可审计迁移。
4. 检查通过后创建 `code` 升序唯一索引。

### 4.2 `business_nodes.nodeCode`

按同样方法检查所有非空 `nodeCode`，确认没有重复值，并检查旧记录的空值或缺失字段。检查通过后创建 `nodeCode` 升序唯一索引。

唯一索引创建失败时不得继续上传新版创建入口，因为数据库唯一约束是并发编号的最终防重边界。

### 4.3 `node_review_votes.reviewRoundId + reviewerUserId`

1. 先导出并按 `reviewRoundId`、`reviewerUserId` 分组，确认每个组合数量均为 1。
2. 缺失、空值、无效账号编号或重复组合均停止部署；不得用删除投票或改写历史的方式临时绕过。
3. 通过后创建唯一复合索引：`reviewRoundId` 升序、`reviewerUserId` 升序。

该唯一索引是同一审核人同一轮次只能持久化一票的最终并发边界。

## 五、查询索引

字段方向要与表格一致。控制台已存在等价索引时不要重复创建；旧兼容索引只在目标环境仍保留旧成员字段时创建。

### 5.1 必需索引

| 集合 | 字段顺序 | 唯一 | 用途 |
|---|---|---:|---|
| `templates` | `name` 升序、`_id` 升序 | 否 | 运营统计模板筛选目录 |
| `business_lines` | `code` 升序 | 是 | 业务编号最终防重 |
| `business_lines` | `status` 升序、`updatedAt` 降序 | 否 | 状态筛选与后台检索 |
| `business_lines` | `memberUserIds` 升序、`updatedAt` 降序 | 否 | 新账号成员业务列表 |
| `business_lines` | `managerUserIds` 升序、`updatedAt` 降序 | 否 | 新账号管理员业务列表 |
| `business_lines` | `status` 升序、`purgeDueAt` 升序、`_id` 升序 | 否 | 冻结业务 15/7/1 日提醒的精确到期扫描 |
| `business_lines` | `createdAt` 降序、`_id` 升序 | 否 | 超级管理员运营看板日期范围扫描 |
| `template_nodes` | `templateId` 升序、`sequence` 升序 | 否 | 模板节点有序读取 |
| `business_nodes` | `nodeCode` 升序 | 是 | 节点编号最终防重 |
| `business_nodes` | `businessLineId` 升序、`sequence` 升序、`_id` 升序 | 否 | 业务节点时间线与运营导出 |
| `business_nodes` | `processorUserIds` 升序、`status` 升序、`updatedAt` 降序 | 否 | 新账号“待我处理”候选扫描 |
| `business_nodes` | `assigneeIds` 升序、`status` 升序、`updatedAt` 降序 | 否 | 纯旧 OpenID 节点“待我处理”兼容扫描；无旧业务时可记录为不适用 |
| `business_nodes` | `workflowMode` 升序、`processingDueStatus` 升序、`_id` 升序 | 否 | 审核节点处理提醒有界扫描 |
| `business_nodes` | `processingTimingStatus` 升序、`_id` 升序 | 否 | 待审核节点的处理工作分钟待补算扫描 |
| `business_nodes` | `processingDueStatus` 升序、`_id` 升序 | 否 | 日历恢复后的处理截止时间补算扫描 |
| `business_nodes` | `feedbackClaimExpiresAt` 升序、`_id` 升序 | 否 | 丢失反馈预约的过期节点锁扫描 |
| `business_nodes` | `feedbackClaimId` 升序、`_id` 升序 | 否 | 按固定反馈预约编号恢复节点锁 |
| `node_review_rounds` | `nodeId` 升序、`reviewRoundNumber` 升序 | 否 | 节点审核轮次时间线 |
| `node_review_rounds` | `businessLineId` 升序、`status` 升序、`updatedAt` 降序 | 否 | 业务状态下的审核轮次查询 |
| `node_review_rounds` | `reviewerUserIds` 升序、`status` 升序、`createdAt` 降序、`_id` 升序 | 否 | 审核人待办列表 |
| `node_review_rounds` | `status` 升序、`reviewDueStatus` 升序、`_id` 升序 | 否 | 审核提醒有界扫描 |
| `node_review_rounds` | `reviewDueStatus` 升序、`_id` 升序 | 否 | 日历恢复后的审核截止时间补算扫描 |
| `node_review_rounds` | `processingCarryoverStatus` 升序、`_id` 升序 | 否 | 审核结束后的处理时长补算扫描 |
| `node_review_rounds` | `reviewTimingCarryoverStatus` 升序、`_id` 升序 | 否 | 审核结束后的审核时长补算扫描 |
| `node_review_rounds` | `businessLineId` 升序、`nodeId` 升序、`_id` 升序 | 否 | 运营统计节点事实重建 |
| `node_review_rounds` | `status` 升序、`createdAt` 降序、`_id` 升序 | 否 | 运营看板待审核统计 |
| `node_review_rounds` | `reviewStartedAt` 降序、`_id` 升序 | 否 | 运营看板个人工时明细稳定游标扫描 |
| `node_review_votes` | `businessLineId` 升序、`nodeId` 升序、`createdAt` 升序 | 否 | 业务节点投票时间线 |
| `node_review_votes` | `reviewRoundId` 升序、`reviewerUserId` 升序 | 是 | 每名审核人每轮唯一投票 |
| `node_review_votes` | `reviewRoundId` 升序、`createdAt` 升序、`_id` 升序 | 否 | 审核详情投票时间线 |
| `node_review_votes` | `reviewResponseTimingStatus` 升序、`_id` 升序 | 否 | 实际投票人个人响应工作分钟待补算扫描 |
| `node_review_votes` | `businessLineId` 升序、`nodeId` 升序、`_id` 升序 | 否 | 运营统计节点投票事实重建 |
| `node_feedback` | `nodeId` 升序、`revision` 降序 | 否 | 节点反馈历史 |
| `node_feedback` | `publishState` 升序、`_id` 升序 | 否 | 恢复中反馈预约扫描 |
| `node_feedback` | `publishState` 升序、`claimExpiresAt` 升序、`_id` 升序 | 否 | 过期或恢复中反馈预约的有界扫描 |
| `evidences` | `businessLineId` 升序、`nodeId` 升序、`uploadedAt` 降序 | 否 | 业务节点凭证历史 |
| `evidences` | `storageStatus` 升序、`purgeDueAt` 升序 | 否 | 到期凭证治理 |
| `evidences` | `retentionScope` 升序、`storageStatus` 升序、`_id` 升序 | 否 | 业务统一期限下可用/失败保留凭证的状态游标扫描 |
| `evidences` | `retentionScope` 升序、`storageStatus` 升序、`purgeDueAt` 升序、`_id` 升序 | 否 | 独立修订期限下可用/失败保留凭证的到期游标扫描 |
| `evidences` | `retentionScope` 升序、`storageStatus` 升序、`purgeClaimExpiresAt` 升序、`_id` 升序 | 否 | 租约到期保留凭证的状态游标扫描 |
| `evidences` | `storageStatus` 升序、`orphanExpiresAt` 升序、`_id` 升序 | 否 | 可用/失败孤立凭证到期扫描 |
| `evidences` | `storageStatus` 升序、`purgeClaimExpiresAt` 升序、`_id` 升序 | 否 | 清理租约到期的孤立凭证扫描 |
| `evidences` | `feedbackId` 升序、`uploadedAt` 升序 | 否 | 反馈补偿与附件恢复 |
| `evidences` | `feedbackId` 升序、`_id` 升序 | 否 | 定时工作器分块恢复反馈预约 |
| `evidences` | `amendmentId` 升序、`_id` 升序 | 否 | 定时工作器分块恢复修订预约 |
| `audit_logs` | `targetType` 升序、`targetId` 升序、`createdAt` 降序 | 否 | 对象审计历史 |
| `audit_logs` | `targetId` 升序、`createdAt` 降序 | 否 | 冻结业务修订详情 |
| `audit_logs` | `action` 升序、`publishState` 升序、`_id` 升序 | 否 | 恢复中审计修订预约扫描 |
| `audit_logs` | `action` 升序、`publishState` 升序、`claimExpiresAt` 升序、`_id` 升序 | 否 | 过期或恢复中审计修订预约扫描 |
| `notifications` | `recipientUserIds` 升序、`createdAt` 降序、`_id` 升序 | 否 | 当前账号通知分页 |
| `notifications` | `audienceRole` 升序、`createdAt` 降序、`_id` 升序 | 否 | 超级管理员广播通知分页 |
| `work_calendar_entries` | `sourceYear` 升序、`generationId` 升序、`date` 升序 | 否 | 同版本全年完整性的有界分页校验 |
| `public_node_shares` | `expiresAt` 升序、`_id` 升序 | 否 | 到期公开分享有界清理 |
| `public_node_share_chunks` | `shareId` 升序、`_id` 升序 | 否 | 单个分享的凭证块有界清理 |
| `business_nodes` | `analyticsSnapshotStatus` 升序、`_id` 升序 | 否 | 运营统计工作器的待生成节点候选游标 |
| `business_lines` | `analyticsSnapshotStatus` 升序、`_id` 升序 | 否 | 运营统计工作器的待生成业务候选游标 |
| `operations_analytics_facts` | `businessLineId` 升序、`sourceType` 升序、`dimensionRole` 升序、`_id` 升序 | 否 | 业务事实汇总和来源重建 |
| `operations_analytics_facts` | `templateId` 升序、`day` 升序、`_id` 升序 | 否 | 模板日期范围事实、筛选目录与权限下钻 |
| `operations_analytics_facts` | `timingStatus` 升序、`_id` 升序 | 否 | 待日历补算事实的单向转换游标 |
| `operations_analytics_daily` | `templateId` 升序、`dimensionRole` 升序、`day` 升序、`_id` 升序 | 否 | 模板全局及角色每日汇总图表 |
| `operations_analytics_daily` | `templateId` 升序、`dimensionRole` 升序、`dimensionFilterToken` 升序、`day` 升序、`_id` 升序 | 否 | 实际处理人或审核人匿名筛选后的每日汇总图表 |
| `business_search_documents` | `documentType` 升序、`tokenHashes` 升序、`businessLineId` 升序 | 否 | 检索令牌候选的有界授权分页 |
| `business_search_documents` | `documentType` 升序、`businessLineId` 升序、`generationId` 升序、`entryId` 升序 | 否 | 当前代际安全条目读取 |
| `business_lines` | `searchIndexStatus` 升序、`updatedAt` 升序、`_id` 升序 | 否 | 检索失败恢复的持久游标扫描 |
| `business_lines` | `updatedAt` 升序、`_id` 升序 | 否 | 历史售后检索状态回填游标 |
| `business_search_documents` | `createdAt` 升序、`_id` 升序 | 否 | 旧内容代际有界清理游标 |
| `node_text_parse_requests` | `expiresAt` 升序、`_id` 升序 | 否 | 每次合法解析后最多清理 20 条过期票据 |

控制台字段方向的等价精确记法为：`documentType ASC, tokenHashes ASC, businessLineId ASC`、`documentType ASC, businessLineId ASC, generationId ASC, entryId ASC`、`searchIndexStatus ASC, updatedAt ASC, _id ASC`、`updatedAt ASC, _id ASC` 和 `createdAt ASC, _id ASC`。

`work_calendar_entries` 索引未在真实 CloudBase 验证前，不得将日历同步标记为可部署通过；索引错误应保留旧活动代际并返回安全失败。

所有进入必需多键索引的账号数组使用同一保守契约：单数组最多 50 个账号编号，按可见 BSON string-array 编码估算不得超过 768 字节；业务成员数组还必须为创建者预留一个最长 128 字节账号位，因此模板参与人理论人数上限为 49，实际还会受字节预算和 100 次事务操作上限共同限制。账号编号按 UTF-8 字节计算，不以 JSON 字符数猜测；30 个真实长度账号夹具已证明会越界并在模板验证、启用、可用性投影、业务创建和通知写入前失败关闭。CloudBase 未公开数组多键索引逐字节模型，768 字节是相对公开 1024 字节索引键上限预留至少 25% 的保守边界，仍须在目标环境用无敏感隔离账号验证。

`evidenceRetention` 的 `system_settings/evidence-retention:*` 文档只保存 `schemaVersion`、独立乐观 `revision`、阶段、该阶段最后扫描的 `afterSortValue`、`afterId`、迁移审计标志和更新时间。所有范围阶段均按上表相应到期字段升序、再按 `_id` 升序做持久复合 keyset；固定状态阶段按状态字段升序、再按 `_id` 升序。CloudBase 单查询不能表达元组 OR，因此续页先有界查询“排序值相同且 `_id` 更大”，余量再有界查询“排序值更大”，两段返回的原始记录合计仍不超过 40，不使用 `skip` 或全量读取。每条路径单次原始扫描与处理量均不超过 40；页尾按阶段轮转并最终回绕，进程在返回候选后崩溃只会使候选再次出现，由预约、租约和确定性通知编号保持幂等。部署旧版 `{phase, afterId}` 游标时，函数会在小事务中自动审计迁移：严格校验旧字段后保留原 phase、重置到该 phase 起点，保存旧 `afterId` 的不可逆摘要而不推断排序值或保存原值；并发迁移只会成功一次。禁止操作员人工伪造、修改、删除或覆盖游标。损坏旧游标，以及新版 `schemaVersion`、`revision`、阶段、`afterSortValue` 或 `afterId` 缺失、类型错误、溢出或不可严格反序列化时均失败关闭。上述复合索引的真实 CloudBase 选择仍未验证。

`calendarSync` 会自动创建或更新固定文档 `system_settings/calendar-review-processing-cursor`，其中只保存 `kind`、`cursorId`、`version` 和更新时间，不含业务正文或账号信息。部署前不要手工伪造该文档；若已有同编号但结构不符的文档，函数会失败关闭，应先停止触发器并按审计流程核查，不能直接删除或覆盖。该游标沿用上表的 `business_nodes(processingTimingStatus ASC, _id ASC)` 索引，不需要新增游标集合索引。

`calendarSync` 还会自动创建或更新 `system_settings/calendar-review-carryover-cursor`，用于有界、可回绕地扫描审核轮次的处理时长补算。该文档仅保存 `kind`、`cursorId`、`version` 和更新时间，同样不得手工伪造、删除或覆盖。该扫描依赖上表的 `node_review_rounds(processingCarryoverStatus ASC, _id ASC)` 组合索引；索引未在目标环境创建且生效前，不得启用 `calendarSync` 定时触发器。

审核终态还可能保存独立的审核时长待补算边界。`calendarSync` 会自动创建或更新 `system_settings/calendar-review-timing-carryover-cursor`，只保存 `kind`、`cursorId`、`version` 和更新时间；不得手工伪造、删除或覆盖。该扫描依赖 `node_review_rounds(reviewTimingCarryoverStatus ASC, _id ASC)` 组合索引。索引创建并确认生效前，不得启用 `calendarSync` 定时触发器。

每张新审核票还可能保存独立的个人响应待补算边界。`calendarSync` 会自动创建或更新 `system_settings/calendar-review-vote-response-cursor`，只保存 `kind: review_response`、`cursorId`、`version` 和更新时间，不含账号、评论或业务正文；不得手工伪造、删除或覆盖。该游标每次最多扫描 40 条 `reviewResponseTimingStatus=pending_calendar` 原始票据，损坏页仍推进、尾页回绕，并在固定文档事务内重读业务、节点、审核轮次和票据后才把个人响应状态改为 `calculated`。该扫描依赖 `node_review_votes(reviewResponseTimingStatus ASC, _id ASC)` 非唯一组合索引；索引创建并确认生效前，不得部署包含本能力的 `calendarSync` 或启用其定时触发器。

### 5.2 旧业务兼容索引

若目标环境仍有依赖旧 OpenID 成员数组的只读业务，保留：

- `business_lines.memberIds` 升序、`updatedAt` 降序。
- `business_lines.managerIds` 升序、`updatedAt` 降序。

这些索引只服务旧记录读取，不能作为新业务写入依据。不要重新建立 `users.openid` 唯一索引；账号绑定规则继续遵循账户管理手册。

## 六、上传 `businessApi`

若本次同时上线“节点文本智能识别”，先不要执行本节上传操作。必须先完成 **6.3** 的集合、索引、AI+ 模型、`nodeTextParser` 部署及空触发器核对，再返回本节部署 `businessApi`；不得让已开放识别路由的 `businessApi` 先于解析函数上线。

1. 在微信开发者工具中右键 `cloudfunctions/businessApi`。
2. 选择“上传并部署：云端安装依赖（不上传 `node_modules`）”。
3. 等待部署完成，不要在上传进度未结束时重复点击。
4. 在 CloudBase 控制台确认函数更新时间、Node.js 运行时和环境变量。
   为 `businessApi` 在安全配置界面新增 `PUBLIC_NODE_SHARE_HMAC_SECRET`：使用密码管理器生成至少 32 字节高熵随机值，只粘贴到目标环境，不写入仓库、终端历史、截图或验收记录。缺失或过短时只有“生成分享快照”失败关闭，其他接口不受影响。
   大凭证直传还需要在同一安全配置界面设置 `EVIDENCE_COS_BUCKET`、`EVIDENCE_COS_REGION`、`EVIDENCE_COS_SECRET_ID`、`EVIDENCE_COS_SECRET_KEY` 与 `EVIDENCE_CLOUD_FILE_PREFIX`。前两项分别是目标 COS 存储桶名称（含 AppID 后缀）和地域；长期 Secret 只存在于云函数环境变量，`EVIDENCE_CLOUD_FILE_PREFIX` 必须是目标 CloudBase 环境对应的 `cloud://...` 前缀。不得把任何变量值写入 Git、日志、截图或验收记录。任一变量缺失或损坏时，只有大凭证上传授权失败关闭，其他接口不受影响。
5. 查看一次函数日志，确认没有依赖安装错误、权限错误或集合/索引错误。
6. 暂不删除旧云函数版本，保留部署前记录的可回退版本。

### 6.1 大凭证 COS、STS 与域名前置配置

1. 在腾讯云访问管理中为 `businessApi` 使用的服务端身份配置最小权限。长期身份只允许签发临时凭证和核验目标存储桶；临时凭证必须精确收敛到函数生成的单一对象键 `evidence-uploads/<businessLineId>/<nodeId>/<evidenceId>.<ext>`，不得对存储桶、目录或 `*` 放权。
2. 临时凭证只授予 `name/cos:PutObject`、`name/cos:InitiateMultipartUpload`、`name/cos:ListMultipartUploads`、`name/cos:ListParts`、`name/cos:UploadPart`、`name/cos:CompleteMultipartUpload` 与 `name/cos:AbortMultipartUpload`。客户端不能指定对象键、存储桶、地域、权限动作、有效期或永久云文件编号。
3. 在微信公众平台“开发管理—开发设置—服务器域名”中，把目标存储桶的虚拟主机域名 `<bucket-appid>.cos.<region>.myqcloud.com` 加入 `uploadFile` 与 `downloadFile` 合法域名。不得填写控制台页面域名，也不要用通配符代替精确目标域名。
4. 原生小程序直传首先依赖第 3 步的合法域名。只有目标环境明确返回跨域错误，或后续另有浏览器/H5 来源复用同一存储桶时，才按真实 `Origin` 配置 COS 跨域规则：精确限制来源与所需方法/请求头并暴露 `ETag`，不要用 `*` 长期代替精确来源。无论是否需要 CORS，都分别用开发者工具、iPhone、Android/HarmonyOS 与 Mac/Windows 微信客户端复验。
5. 小程序使用仓库固定的 `cos-wx-sdk-v5@1.8.0` 高级 `uploadFile`：SDK 自动选择简单上传或分块上传，页面最多并发 3 个文件，并只对可重试网络/5xx/429 错误退避重试。上传会话有效 15 分钟；会话过期只允许重新申请同一业务范围的新会话，不能复用过期凭据。
6. 服务端 `finalizeEvidenceUpload` 会通过 `headObject` 和有界头部读取核对真实对象大小、扩展名、签名或容器品牌，再把 `uploading` 预约转换为 `available`。客户端 MIME、扩展名和声明大小都不是信任依据；不允许跳过完成登记后直接把对象编号提交给反馈接口。
7. 部署前先保持小程序旧版本可回退。若直传异常，先回退小程序，再回退 `businessApi`；保留所有 `available`、`uploading` 凭证元数据和云对象，由保留工作器按既有孤立规则处理，禁止为回滚批量删除对象或集合记录。

### 6.2 售后内容检索集合、密钥与 `businessSearch`

1. 部署前导出 `business_lines`、`business_nodes`、`node_feedback`、`node_review_rounds`、`node_review_votes`、`evidences` 与 `system_settings`。新建检索集合没有历史数据时，记录“未创建、无历史数据”后继续。
2. 创建 `business_search_documents` 与 `business_search_requests`，权限均设为“仅云函数读写”。不得开放客户端直接读写。
3. 创建上表五条检索索引并等待索引生效。`tokenHashes` 为数组多键索引；单个令牌块继续遵守保守 768 字节预算。
4. 使用密码管理器生成至少 32 字节高熵随机值，以同一个 `BUSINESS_SEARCH_HMAC_SECRET` 分别配置到 `businessApi` 和 `businessSearch`。不得写入 Git、日志、截图、项目记忆或验收记录，也不得与公开分享密钥复用。
5. 右键 `cloudfunctions/businessSearch`，选择“上传并部署：云端安装依赖”。函数名为 `businessSearch`，入口为 `index.main`，Node.js 16，内存先用 256 MB，超时 60 秒。
6. 首次部署、回滚和隔离验收结束后均保存并刷新确认 `{"triggers": []}`。不得通过控制台普通“测试”伪造 Timer 来源。
7. 不要手工创建、修改或删除 `system_settings/business-search-backfill-cursor`、`business-search-recovery-cursor` 和 `business-search-cleanup-cursor`。工作器每轮总共最多领取 40 条，使用 `updatedAt/createdAt + _id` 复合 keyset，损坏结构和版本溢出会失败关闭。
8. 仅在无敏感隔离数据、集合权限、索引和双函数密钥全部核对后，批准一次性 Timer 做历史回填。核对返回值只含 `examined/generated/failed/cleaned` 计数，普通用户只能命中原本有权查看的售后，活动超级管理员可检索全部售后；执行后立即恢复 `{"triggers": []}`。
9. 正式周期 Timer 不在首次部署范围内。隔离回填、失败恢复、撤权隐藏、超过 100 个候选的服务端游标和幂等复跑均通过后，再单独批准调度频率。

### 6.3 节点文本智能识别集合与 `nodeTextParser`

1. 创建 `node_text_parse_requests` 与 `node_text_parse_usage`，权限均设为“仅云函数读写”。不得开放客户端直接读取；两个集合不得写入原始粘贴文本、识别候选、OpenID 原值、显示名或业务正文。
2. 为 `node_text_parse_requests` 创建 `expiresAt ASC, _id ASC` 非唯一组合索引并等待生效；`node_text_parse_usage` 只按确定性文档编号固定读取，不需要组合索引。
3. 在 CloudBase AI+ 控制台确认代码默认的 `hy3` 模型已启用，同时设置费用/Token 告警；当前目标环境无需为此购买标准版。若默认模型在其他环境不可用，应先选定控制台明确支持的替代模型并通过服务端 `NODE_TEXT_PARSE_MODEL` 配置，不得先部署后碰运气。
4. 右键 `cloudfunctions/nodeTextParser`，选择“上传并部署：云端安装依赖”。函数名为 `nodeTextParser`，入口为 `index.main`，Node.js 16，内存先用 256 MB，超时至少 60 秒。
5. `nodeTextParser` 的触发器必须保存并刷新确认为 `{"triggers": []}`。不得建立 Timer，也不得用控制台普通“测试”绕过票据；小程序只能调用 `businessApi.recognizeNodeText`。
6. `NODE_TEXT_PARSE_MODEL` 可留空使用代码中的受支持默认模型；如目标环境需要指定模型，只能填写已在第 3 步确认可用的服务端模型名称，客户端不能覆盖。模型名称不是密钥，但仍不得由用户输入或写入日志。
7. `businessApi` 的 `NODE_TEXT_PARSE_DAILY_LIMIT` 可不配置，此时每个账号每个上海自然日默认 300 次。若配置，只接受十进制整数 `1..1000`；空白、0、非整数或越界会使识别入口失败关闭。不得把额度放入小程序配置或请求参数。完成后返回“六、上传 `businessApi`”，部署该函数并核对它能成功嵌套调用 `nodeTextParser`。
8. 首次隔离验收只使用无敏感测试文本，核对单飞、每分钟 10 次、每日 300 次边界、五分钟票据单次消费以及日志不含原文/候选/票据/身份/业务编号。

### 6.4 上传小程序 `1.0.1`

1. 部署本次 `businessApi` 后重新编译小程序，确认登录、业务概览、模板管理、待我处理、待我审核和运营看板均可进入。
2. 在开发者工具上传版本 `1.0.1`；版本备注只写“发起人唯一审核人、七日节点只读分享”，不得包含账号、业务正文、云文件编号或环境变量。
3. 先设置体验版并完成下表的发起人审核人与固定分享隔离验收，再决定是否提交审核；不要仅凭本地自动化通过直接发布。
4. 本次新增的仅是 `node_text_parse_requests`、`node_text_parse_usage`、前者的到期索引、`nodeTextParser` 以及可选的两个服务端环境变量；不得新增 Timer，也不改变现有 `calendarSync`、`workflowReminder`、`evidenceRetention`、`operationsAnalytics` 触发器。

## 七、上传 `calendarSync`

1. 在微信开发者工具中右键 `cloudfunctions/calendarSync`，选择“上传并部署：云端安装依赖（不上传 `node_modules`）”。
2. 初次上传保持 `triggers: []`，不要在验收前创建每日同步触发器。
3. 以超级管理员受保护入口手工同步当前年和下一年；逐年核对日期数量、来源和版本，确认旧活动版本只在完整新代际通过校验后切换。
4. 核对日历缺失时业务创建、提交审核、驳回返工和节点推进均只标记待补算并继续流转；恢复同步后仅补算仍处于匹配版本和活动状态的截止时间。

## 八、上传 `workflowReminder`

1. 在微信开发者工具中右键 `cloudfunctions/workflowReminder`，选择“上传并部署：云端安装依赖（不上传 `node_modules`）”。
2. 首次验收保持 `triggers: []`；不要在未完成隔离验收时建立小时级提醒。
3. 使用隔离业务核对处理提醒与审核提醒编号不同，重复调用不覆盖彼此；或签/会签的通过、驳回、账号停用、角色变化、业务冻结、轮次变化和日历待补算均应停止相应提醒。

## 九、上传 `evidenceRetention`

1. 在微信开发者工具中右键 `cloudfunctions/evidenceRetention`。
2. 选择“上传并部署：云端安装依赖（不上传 `node_modules`）”。
3. 在 CloudBase 控制台确认函数名为 `evidenceRetention`，入口为 `index.main`。
4. 内存先使用 256 MB。目标免费开发环境的控制台已验证执行超时只允许 1—60 秒，因此设置为 60 秒；保留工作器的有界分块，并在数据量增长后根据真实调用耗时决定是否需要更高配额或继续缩小单批规模。
5. 该函数不需要管理员恢复哈希或企业微信密钥。不要复制 `businessApi` 的敏感环境变量到此函数。
6. 初次部署后不要点击控制台“测试”直接调用；该入口会拒绝非 Timer 来源。先完成下面的候选数据检查，取得破坏性验收的单独批准后，再使用一次性 Timer。
7. 新版工作器把已过期的 `storageStatus=uploading` 会话纳入原 24 小时孤立清理扫描。它只删除服务端生成对象键对应的测试/孤立对象，成功或对象不存在后才把元数据标记为 `purged`；活动上传会话、已登记 `available` 凭证和已绑定反馈/审计记录不得被清理。

工作器返回值只包含以下脱敏计数，不包含身份、文件路径或业务正文：

```json
{
  "feedbackReservationsRecovered": 0,
  "amendmentReservationsRecovered": 0,
  "remindersCreated": 0,
  "objectsPurged": 0,
  "orphansPurged": 0,
  "failures": {}
}
```

## 十、上传 `operationsAnalytics`

1. 在微信开发者工具中右键 `cloudfunctions/operationsAnalytics`，选择“上传并部署：云端安装依赖（不上传 `node_modules`）”。
2. 在 CloudBase 控制台确认函数名为 `operationsAnalytics`、入口为 `index.main`、运行时为 Node.js 16，并先使用 256 MB、60 秒配置。
3. 首次部署及回滚时都必须保持 `operationsAnalytics` 的 `triggers: []`；控制台直接测试、事件正文伪造 Timer、客户端调用和缺少平台可信来源都会被拒绝。
4. 不要人工创建或修改 `system_settings/operations-analytics-node-cursor`、`system_settings/operations-analytics-business-cursor` 与 `system_settings/operations-analytics-refresh-cursor`。工作器会用固定批次 40、持久游标和确定性事实编号自动维护；第三个游标只扫描 `timingStatus=pending_calendar` 的事实，并在权威日历恢复后把事实和每日汇总原子、单向转换为有效样本。损坏游标会失败关闭。
5. 仅在两个统计集合、全部组合索引和权限生效后，使用无敏感隔离业务批准一次 `operationsAnalytics` 一次性 Timer。核对返回的节点/业务/待补算扫描与事实安全计数、事实与每日汇总幂等，再立即恢复空触发器。
6. 所有活动用户应能看到同一全局汇总；普通用户的业务明细仍按当前业务权限过滤，超级管理员可查看全部明细并保留安全 CSV 导出。客户端不得收到内部账号编号、成员数组或永久文件路径。
7. 每 15 分钟周期触发器不属于首次部署：必须在一次性 Timer、多账号权限和幂等复跑验收通过后单独批准、单独配置并记录回退点。

## 十一、配置触发器

首次隔离验收前，依次打开 `businessSearch`、`nodeTextParser`、`calendarSync`、`workflowReminder`、`evidenceRetention` 和 `operationsAnalytics` 的“触发管理/触发器”，核对并保存为 `{"triggers": []}`。若发现遗留非空配置，仅恢复空数组并记录脱敏变更。`nodeTextParser` 始终保持空触发器；`businessSearch` 只允许在检索集合、索引、双函数密钥和无敏感隔离数据全部核对后使用一次性回填 Timer；`evidenceRetention` 在破坏性候选、再次备份和云对象归属全部核对完成并取得单独批准前，不得创建、预创建或保存任何非空触发器配置。

隔离验收全部通过并取得单独批准后，才可按顺序单独处理 `calendarSync` 的每日同步触发器和 `workflowReminder` 的小时级提醒触发器：每次只启用一个函数，使用已批准的目标时刻，在控制台核对时区、下一次触发时间和脱敏日志后，再决定下一项。`evidenceRetention` 只允许为破坏性隔离验收临时保存一次性 Timer，每次执行并取得日志后立即恢复 `triggers: []`；正式周期调度属于后续独立变更，不包含在本手册的部署范围。

触发器会异步调用函数，平台可能重试，因此工作器以确定性提醒编号、短期清理租约和幂等状态转换防止重复处理。

## 十二、分阶段脱敏验收矩阵

所有项目初始状态均为“未验证”。操作员完成后只记录“通过/失败、时间、测试记录编号和脱敏现象”，不记录账号密码、OpenID、真实文件名、业务正文或云文件地址。

### 11.1 模板与业务创建

| 验收项 | 操作 | 通过标准 | 初始状态 |
|---|---|---|---|
| 模板生命周期 | 超级管理员创建草稿，添加、编辑、删除节点和字段；启用、停用、再编辑 | 启用模板只读，停用后可改，逻辑删除后不再提供新建 | 未验证 |
| 发起人唯一审核人 | 第二节点选择“业务发起人作为本节点唯一审核人”，保持第一节点为不重叠处理/审核账号，启用模板后由普通账号创建业务并完成第一节点 | 第二节点业务快照只有实际发起人一个审核人；发起人获得待审核任务并可投票；模板排序和其他节点审核人不变化 | 未验证 |
| 同节点角色冲突 | 先尝试把同一节点的处理人与审核人都设为发起人；再以恰好位于固定处理人列表的账号创建“发起人审核”业务 | 模板冲突不能保存；创建时冲突显示“业务发起人不能同时担任同一节点的处理人和审核人，请调整模板或由其他账号发起”，且不产生业务、节点、计数器或审计半成品 | 未验证 |
| 七类字段 | 配置短文本、长文本、数字、布尔、日期、单选、多选及约束 | 合法值可提交，必填、长度、范围、选项等非法值被拦截 | 未验证 |
| 失效负责人 | 停用一个待选负责人后尝试启用模板 | 服务端拒绝启用，不产生半成品模板 | 未验证 |
| 自动编号 | 普通用户从模板连续创建两条业务 | 业务编号全局唯一，节点编号由业务编号派生且不可编辑 | 未验证 |
| 快照隔离 | 创建业务后停用并修改原模板 | 已创建业务的节点、字段、负责人和规则不变化 | 未验证 |

### 11.2 节点审核、反馈、驳回与冻结

| 验收项 | 操作 | 通过标准 | 初始状态 |
|---|---|---|---|
| 节点独立审核 | 隔离模板配置处理人和不重叠审核人，处理人保存进度后提交审核 | 新节点不出现旧直接完成/旧驳回入口，审核轮次由服务端建立 | 未验证 |
| 或签与会签 | 分别以隔离账号执行任一通过与全员通过 | 或签任一通过、会签全员通过；投票唯一且重复请求幂等 | 未验证 |
| 末节点审核完成 | 让隔离业务的最后一个审核节点获得通过，并重新进入业务详情 | 仅在末节点审核通过后业务变为 `completed`，当前节点清空或呈现服务端终态；处理人、审核人均不能再走旧完成或旧驳回写入 | 未验证 |
| 审核驳回返工 | 审核人驳回当前轮，再由处理人重新提交 | 新处理轮可继续，原处理/审核轮次、投票和凭证仍可审计 | 未验证 |
| 双 SLA 与日历恢复 | 在日历缺失时提交、通过和驳回；随后同步恢复 | 不阻断流转；仅匹配版本及活动状态的截止时间补算 | 未验证 |
| 冻结写保护 | 完成、取消、关闭或逻辑删除业务后尝试普通编辑 | 普通写入全部拒绝，历史仍可查看 | 未验证 |
| 审计修订 | 超级管理员填写原因并修订允许字段 | 生成精确前后值和独立审计记录，原反馈不变化 | 未验证 |

末节点通过后，以超级管理员或被授权业务成员从受保护查询入口集中核对同一隔离业务：`node_review_rounds` 的每轮次、`node_review_votes` 的每位审核人一票、审核与节点推进审计记录、处理完成/审核开始/审核结论通知、处理与审核两套 SLA 字段及逾期分钟、日历待补算状态恢复后的匹配版本结果，以及每条 `node_feedback` 历史对原 `evidences` 编号的引用。通过标准是每项都可由安全投影或控制台脱敏记录追溯、没有伪造或丢失的轮次/投票/引用，且终态后普通写入被拒绝。

### 11.3 凭证

| 验收项 | 操作 | 通过标准 | 初始状态 |
|---|---|---|---|
| 图片 | 分别上传 JPG/JPEG/PNG/WebP/HEIC/HEIF，包含 iPhone HEIC 和 Android/HarmonyOS 常见图片 | 合法签名可登记；改扩展名、损坏头部或不在节点白名单的文件被拒绝 | 未验证 |
| PDF | 上传小型与大型 PDF，并用改扩展名伪造 PDF | 合法 PDF 可登记、预览或下载；伪造格式被拒绝 | 未验证 |
| 视频 | 分别上传 MP4/MOV/M4V，覆盖 H.264 与 H.265/HEVC 容器品牌 | 支持品牌可登记；未知或伪造容器失败关闭 | 未验证 |
| 120 MiB 合计 | 在同一处理轮分多批选择多个文件，验证 120 MiB 前后边界 | 当前有效凭证合计不超过 120 MiB 可上传；超过时在上传前或服务端预约时拒绝；不另设业务层文件数量上限 | 未验证 |
| 跨端选择 | 在 iPhone、Android/HarmonyOS、Mac 和 Windows 微信客户端分别选择本地图片、视频和 PDF | 移动端进入相册/相机或文件选择，桌面端进入本地文件选择；不得误跳聊天对象且没有可选内容 | 未验证 |
| 分块、重试与并发 | 上传接近 120 MiB 的测试文件并制造一次可重试网络中断，同时上传至少 3 个文件 | 大文件由 SDK 分块上传；进度可见；最多 3 个文件并发；重试不重复登记且不可重试错误明确失败 | 未验证 |
| 服务端完成核验 | 上传后在完成登记前替换声明大小、扩展名或对象内容 | `finalizeEvidenceUpload` 以 COS 真实大小和头部为准，篡改请求不能变成 `available` | 未验证 |
| 临时访问 | 查看图片、PDF、视频并执行下载 | 每次先申请短期地址；已清理凭证不再提供入口 | 未验证 |
| 会话与孤立清理 | 制造一个过期 `uploading` 会话和一个活动会话后运行经批准的一次性保留 Timer | 仅过期孤立对象被清理且元数据保留；活动会话和所有 `available` 凭证不变 | 未验证 |
| 保存并提交幂等 | 修改字段并直接提交审核，制造一次响应丢失后用同一请求重试 | 服务端一次调用原子保存并提交；只产生一个反馈和一个审核轮次，页面以权威成功为准且不清空字段 | 未验证 |

### 11.3.1 响应时间与内存 A/B

1. 用同一无敏感隔离账号、同一网络和同一批数据分别记录概览、节点处理页、保存并提交、详情返回的冷启动与热调用样本。新版预期调用数为：概览 1 次、节点工作区 1 次、无新文件的保存并提交 1 次；检索投影失败不得把权威保存或提交包装成失败。
2. 先以 `businessApi` 256 MB 采集至少 20 个热样本和 5 个冷样本，再在保留全部环境变量和代码版本不变的情况下用 512 MB 重复同样样本。分别记录 P50/P95、超时率、冷启动时间和平台账单单位，不记录账号、正文、文件名或对象键。
3. 只有 512 MB 在同等条件下显示有意义的 P95/超时改善且成本可接受时才保留；否则恢复 256 MB。该结论在真实目标环境测量前必须记为“未验证”，不能仅凭本地测试声称性能提升。

### 11.4 处理/审核提醒与凭证清理

仅使用专门创建的测试业务、测试账号和无敏感内容的测试文件。不得修改真实业务的保留日期，不得用真实凭证做删除测试。

1. 先确认三个定时云函数触发器仍停用。
2. 在隔离测试数据中准备：一个到期前 15/7/1 天的冻结业务、一个超过 24 小时且未关联的孤立测试文件、一个已到期的普通业务测试凭证、一个已到期的审计修订测试凭证。
3. 再次备份这些测试记录，并确认云存储对象只属于测试数据。
4. 取得本次精确删除目标的单独批准后，为 `evidenceRetention` 保存一次性 Timer；不得点击控制台“测试”，不得在事件载荷中伪造 Timer 来源。执行完成后保存脱敏计数并立即恢复 `triggers: []`。
5. 再次确认第一次执行结果和剩余测试对象后，另行保存第二个一次性 Timer；执行完成后再次恢复 `triggers: []`，验证幂等性。

| 验收项 | 通过标准 | 初始状态 |
|---|---|---|
| 提前提醒 | 对应管理员只产生一个确定性站内提醒 | 未验证 |
| 孤立文件 | 云对象被清理，元数据标记为已清理且不再含永久文件编号 | 未验证 |
| 普通保留期 | 只清理已冻结且统一期限到期的业务凭证 | 未验证 |
| 修订保留期 | 只清理已发布修订且附件自身期限到期的凭证 | 未验证 |
| 重复调用 | 第二次调用不重复提醒、不重复删除、不产生业务错误 | 未验证 |
| 删除失败 | 记录安全错误分类和重试次数，不提前标为已清理 | 未验证 |
| 日志脱敏 | 日志和返回值无文件路径、身份值和业务正文 | 未验证 |

另以隔离业务和账号手工调用 `workflowReminder`：处理提醒和审核提醒使用不同确定性编号且不互相覆盖；相同小时重试不重复发送；审核通过、驳回、轮次变更、账号停用、关系移除、角色模式变化、业务冻结或日历待补算时不再创建提醒。以上真实环境项目均为“未验证”，直到操作员保留脱敏验收记录。

全部通过后，分别批准日历每日同步触发器和小时级提醒触发器，并在首次自动触发后检查调用来源、开始时间、耗时、脱敏计数和下一次触发时间；`evidenceRetention` 继续保持 `triggers: []`。

### 11.5 第二批次待办、运营导出与公开分享

| 验收项 | 操作 | 通过标准 | 初始状态 |
|---|---|---|---|
| 待我处理 | 以当前节点处理人进入概览和待办页，再撤销其处理关系或停用账号 | 数量与列表一致；撤权后重新显示即隐藏，超出扫描上限只显示安全下界 | 未验证 |
| 运营看板 | 活动超级管理员切换日期和业务状态，并展开“节点处理时间明细” | 业务、冻结、待处理、待审核、逾期和日历待补算指标与权威记录一致；明细按轮次显示实际提交人、本轮处理工作分钟及仅实际投票人的响应工作分钟；待补算和历史未记录不显示为 0；普通账号拒绝 | 未验证 |
| CSV 导出 | 导出含逗号、双引号、换行和 `=+-@` 开头名称的隔离数据 | UTF-8 中文正常，列完整，不含账号编号、凭证或内部字段，公式前缀被安全转义 | 未验证 |
| 固定分享 | 已完成节点的管理员或处理人生成分享并从微信原生面板分别发送给微信好友和微信群，再由未登录且无业务权限的账号打开 | 接收者无需登录即可查看固定字段、说明和短期图片/视频/PDF；页面不显示内部账号、永久文件编号、请求摘要或租约；源记录后续变化不改变快照 | 未验证 |
| 分享中断与到期 | 制造一次创建中断后用同一操作重试，并在隔离环境等待或调整到期测试数据 | 同一请求返回同一路径且沿用原到期时间；到期后统一提示不可用，保留工作器有界删除分享元数据 | 未验证 |

## 十二、回滚

发生权限错误、索引错误、异常删除、持续超时或客户端关键流程失败时按以下顺序回滚：

1. **先停用新版模板**，阻止继续创建新版审核节点。
2. **再停用 `businessSearch`、`calendarSync` 与 `workflowReminder` 的新触发器**；`evidenceRetention` 保持 `triggers: []`。
3. 若仍有运行中的函数，等待其结束并检查脱敏日志；不要通过删除集合中断。
4. 先回退客户端，再回退 `businessApi`、`businessSearch`、`calendarSync` 与 `workflowReminder` 到部署前记录的版本，并确认既有环境变量仍存在；检索密钥和 COS 长期 Secret 只保留在受控环境变量中，不导出到回滚资料。
5. 重新编译小程序并验证登录、业务列表和旧业务只读访问。
6. 保留审核轮次、投票、通知、审计、凭证元数据和索引；不要为了回滚代码而删除审核数据。
7. 只有确认数据被错误写入时，才依据部署前备份设计单独、可审计的数据修复方案。禁止直接全量覆盖生产集合。

若云文件已经按正确到期规则删除，回滚代码不会恢复文件实体；这正是部署前备份、隔离测试和先停用触发器的原因。

## 十三、发布记录模板

```text
代码提交：
目标环境：已核对（不记录任何密钥）
备份：通过 / 失败
唯一索引前置检查：通过 / 失败
索引：通过 / 失败
businessApi 部署：通过 / 失败 / 未验证
businessSearch 部署与一次性历史回填：通过 / 失败 / 未验证
nodeTextParser 部署、AI+ 可用性与空触发器：通过 / 失败 / 未验证
calendarSync 部署与当前/下一年手工同步：通过 / 失败 / 未验证
workflowReminder 部署：通过 / 失败 / 未验证
evidenceRetention 部署：通过 / 失败 / 未验证
触发器时区与下一次时间：已核对 / 未核对（首次验收保持空触发器）
节点审核、双 SLA、日历待补算恢复验收：通过 / 失败 / 未验证
多账号验收：通过 / 失败 / 未验证
凭证验收：通过 / 失败 / 未验证
跨端大凭证、分块重试与 120 MiB 合计：通过 / 失败 / 未验证
businessApi 256/512 MB A/B：保留 256 / 保留 512 / 未验证
处理/审核提醒与定时清理隔离测试：通过 / 失败 / 未验证
回退版本：已记录在受控运维记录 / 未记录
```

## 十四、官方参考

- [腾讯云 CloudBase 云函数](https://cloud.tencent.com/document/product/876/46899)
- [腾讯云定时触发器说明](https://cloud.tencent.com/document/product/583/9708)
- [腾讯云创建触发器](https://cloud.tencent.com/document/product/583/30230)
- [COS 小程序 SDK 高级上传](https://cloud.tencent.com/document/product/436/64991)
- [小程序直传 COS 与合法域名](https://cloud.tencent.com/document/product/436/34929)
- [COS 临时密钥与最小权限](https://intl.cloud.tencent.com/zh/document/product/436/14048?lang=zh)
- [COS 跨域访问配置](https://intl.cloud.tencent.com/zh/document/product/436/11488)

控制台菜单名称和时区展示可能随版本变化。实际操作时以目标环境页面显示为准，并始终通过“下一次触发时间”反向核对中国时间。
