# 模板、动态字段、凭证与定时清理部署手册

本手册用于把已经通过本地自动化验证的模板、业务快照、动态字段反馈、节点独立审核、驳回与冻结修订、图片/PDF/视频凭证、工作日历、处理/审核提醒以及 60 天清理能力部署到目标 CloudBase 环境。

目标环境标识为 `cloud1-d5gxt99rh492670d9`，小程序 AppID 标识为 `wx6dcce945f944e52f`。这些标识不是凭据。密码、恢复码、哈希、OpenID、真实客户数据和文件内容不得写入本手册、Git、截图说明或验收记录。

## 一、部署原则

- 必须按“备份、集合、唯一性检查、索引、业务云函数、定时云函数、触发器、验收”的顺序执行。
- `businessApi`、`calendarSync`、`workflowReminder` 和 `evidenceRetention` 均选择“上传并部署：云端安装依赖”。不要上传本地 `node_modules`。
- 首次验收时 `calendarSync`、`workflowReminder` 与 `evidenceRetention` 均保持 `triggers: []`；仅在隔离验收通过后分阶段启用日历每日同步和小时级提醒。
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

对每份导出执行以下检查：

1. 下载完成且文件大小不是异常的 0 字节。
2. 在本地离线打开，确认格式可解析，并抽查首尾记录结构。
3. 对比控制台记录数与导出记录数；若导出工具采用分片，核对所有分片总数。
4. 把备份保存到受控位置，不提交 Git，不通过普通聊天发送。

`node_review_rounds`、`node_review_votes`、`work_calendar_entries`、`work_calendar_years` 与 `calendar_sync_requests` 可能在首次部署前尚不存在：控制台明确显示集合不存在时，记录“未创建、无历史数据”，继续后续集合创建；一旦集合存在，其导出失败、无法读取或数量不一致时停止部署。其余已存在集合任一导出失败、无法读取或数量不一致时同样停止部署。

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
| `business_lines` | `code` 升序 | 是 | 业务编号最终防重 |
| `business_lines` | `status` 升序、`updatedAt` 降序 | 否 | 状态筛选与后台检索 |
| `business_lines` | `memberUserIds` 升序、`updatedAt` 降序 | 否 | 新账号成员业务列表 |
| `business_lines` | `managerUserIds` 升序、`updatedAt` 降序 | 否 | 新账号管理员业务列表 |
| `template_nodes` | `templateId` 升序、`sequence` 升序 | 否 | 模板节点有序读取 |
| `business_nodes` | `nodeCode` 升序 | 是 | 节点编号最终防重 |
| `business_nodes` | `businessLineId` 升序、`sequence` 升序 | 否 | 业务节点时间线 |
| `business_nodes` | `workflowMode` 升序、`processingDueStatus` 升序、`_id` 升序 | 否 | 审核节点处理提醒有界扫描 |
| `business_nodes` | `processingTimingStatus` 升序、`_id` 升序 | 否 | 待审核节点的处理工作分钟待补算扫描 |
| `business_nodes` | `processingDueStatus` 升序、`_id` 升序 | 否 | 日历恢复后的处理截止时间补算扫描 |
| `node_review_rounds` | `nodeId` 升序、`reviewRoundNumber` 升序 | 否 | 节点审核轮次时间线 |
| `node_review_rounds` | `businessLineId` 升序、`status` 升序、`updatedAt` 降序 | 否 | 业务状态下的审核轮次查询 |
| `node_review_rounds` | `reviewerUserIds` 升序、`status` 升序、`createdAt` 降序、`_id` 升序 | 否 | 审核人待办列表 |
| `node_review_rounds` | `status` 升序、`reviewDueStatus` 升序、`_id` 升序 | 否 | 审核提醒有界扫描 |
| `node_review_rounds` | `reviewDueStatus` 升序、`_id` 升序 | 否 | 日历恢复后的审核截止时间补算扫描 |
| `node_review_rounds` | `processingCarryoverStatus` 升序、`_id` 升序 | 否 | 审核结束后的处理时长补算扫描 |
| `node_review_rounds` | `reviewTimingCarryoverStatus` 升序、`_id` 升序 | 否 | 审核结束后的审核时长补算扫描 |
| `node_review_votes` | `businessLineId` 升序、`nodeId` 升序、`createdAt` 升序 | 否 | 业务节点投票时间线 |
| `node_review_votes` | `reviewRoundId` 升序、`reviewerUserId` 升序 | 是 | 每名审核人每轮唯一投票 |
| `node_review_votes` | `reviewRoundId` 升序、`createdAt` 升序、`_id` 升序 | 否 | 审核详情投票时间线 |
| `node_feedback` | `nodeId` 升序、`revision` 降序 | 否 | 节点反馈历史 |
| `evidences` | `businessLineId` 升序、`nodeId` 升序、`uploadedAt` 降序 | 否 | 业务节点凭证历史 |
| `evidences` | `storageStatus` 升序、`purgeDueAt` 升序 | 否 | 到期凭证治理 |
| `evidences` | `feedbackId` 升序、`uploadedAt` 升序 | 否 | 反馈补偿与附件恢复 |
| `evidences` | `feedbackId` 升序、`_id` 升序 | 否 | 定时工作器分块恢复反馈预约 |
| `evidences` | `amendmentId` 升序、`_id` 升序 | 否 | 定时工作器分块恢复修订预约 |
| `audit_logs` | `targetType` 升序、`targetId` 升序、`createdAt` 降序 | 否 | 对象审计历史 |
| `audit_logs` | `targetId` 升序、`createdAt` 降序 | 否 | 冻结业务修订详情 |
| `notifications` | `recipientUserIds` 升序、`createdAt` 降序、`_id` 升序 | 否 | 当前账号通知分页 |
| `notifications` | `audienceRole` 升序、`createdAt` 降序、`_id` 升序 | 否 | 超级管理员广播通知分页 |
| `work_calendar_entries` | `sourceYear` 升序、`generationId` 升序、`date` 升序 | 否 | 同版本全年完整性的有界分页校验 |

`work_calendar_entries` 索引未在真实 CloudBase 验证前，不得将日历同步标记为可部署通过；索引错误应保留旧活动代际并返回安全失败。

`calendarSync` 会自动创建或更新固定文档 `system_settings/calendar-review-processing-cursor`，其中只保存 `kind`、`cursorId`、`version` 和更新时间，不含业务正文或账号信息。部署前不要手工伪造该文档；若已有同编号但结构不符的文档，函数会失败关闭，应先停止触发器并按审计流程核查，不能直接删除或覆盖。该游标沿用上表的 `business_nodes(processingTimingStatus ASC, _id ASC)` 索引，不需要新增游标集合索引。

`calendarSync` 还会自动创建或更新 `system_settings/calendar-review-carryover-cursor`，用于有界、可回绕地扫描审核轮次的处理时长补算。该文档仅保存 `kind`、`cursorId`、`version` 和更新时间，同样不得手工伪造、删除或覆盖。该扫描依赖上表的 `node_review_rounds(processingCarryoverStatus ASC, _id ASC)` 组合索引；索引未在目标环境创建且生效前，不得启用 `calendarSync` 定时触发器。

审核终态还可能保存独立的审核时长待补算边界。`calendarSync` 会自动创建或更新 `system_settings/calendar-review-timing-carryover-cursor`，只保存 `kind`、`cursorId`、`version` 和更新时间；不得手工伪造、删除或覆盖。该扫描依赖 `node_review_rounds(reviewTimingCarryoverStatus ASC, _id ASC)` 组合索引。索引创建并确认生效前，不得启用 `calendarSync` 定时触发器。

### 5.2 旧业务兼容索引

若目标环境仍有依赖旧 OpenID 成员数组的只读业务，保留：

- `business_lines.memberIds` 升序、`updatedAt` 降序。
- `business_lines.managerIds` 升序、`updatedAt` 降序。

这些索引只服务旧记录读取，不能作为新业务写入依据。不要重新建立 `users.openid` 唯一索引；账号绑定规则继续遵循账户管理手册。

## 六、上传 `businessApi`

1. 在微信开发者工具中右键 `cloudfunctions/businessApi`。
2. 选择“上传并部署：云端安装依赖（不上传 `node_modules`）”。
3. 等待部署完成，不要在上传进度未结束时重复点击。
4. 在 CloudBase 控制台确认函数更新时间、Node.js 运行时和环境变量。
5. 查看一次函数日志，确认没有依赖安装错误、权限错误或集合/索引错误。
6. 暂不删除旧云函数版本，保留部署前记录的可回退版本。

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
6. 初次部署后不要立即对生产数据手动调用；先完成下面的候选数据检查。

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

## 十、配置触发器

首次隔离验收前及本次节点审核部署验收期间，依次打开 `calendarSync`、`workflowReminder` 和 `evidenceRetention` 的“触发管理/触发器”，核对并保存为 `{"triggers": []}`。若发现遗留非空配置，仅恢复空数组并记录脱敏变更；本次不得为 `evidenceRetention` 创建、预创建或保存任何非空触发器配置。

隔离验收全部通过并取得单独批准后，才可按顺序单独处理 `calendarSync` 的每日同步触发器和 `workflowReminder` 的小时级提醒触发器：每次只启用一个函数，使用已批准的目标时刻，在控制台核对时区、下一次触发时间和脱敏日志后，再决定下一项。`evidenceRetention` 在本次仍保持 `triggers: []`；需要改变其调度策略属于后续独立变更，不包含在本手册的部署范围。

触发器会异步调用函数，平台可能重试，因此工作器以确定性提醒编号、短期清理租约和幂等状态转换防止重复处理。

## 十一、分阶段脱敏验收矩阵

所有项目初始状态均为“未验证”。操作员完成后只记录“通过/失败、时间、测试记录编号和脱敏现象”，不记录账号密码、OpenID、真实文件名、业务正文或云文件地址。

### 11.1 模板与业务创建

| 验收项 | 操作 | 通过标准 | 初始状态 |
|---|---|---|---|
| 模板生命周期 | 超级管理员创建草稿，添加、编辑、删除节点和字段；启用、停用、再编辑 | 启用模板只读，停用后可改，逻辑删除后不再提供新建 | 未验证 |
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
| 图片 | 上传 JPG/JPEG/PNG，分别验证 5 MB 边界 | 合法文件可登记；超限或伪造格式被拒绝 | 未验证 |
| PDF | 上传 PDF，验证 20 MB 边界 | 合法文件可登记、预览或下载；超限被拒绝 | 未验证 |
| 视频 | 上传多个 MP4/MOV/M4V | 单文件不超过 20 MB且单次总量不超过 20 MB时可提交 | 未验证 |
| 临时访问 | 查看图片、PDF、视频并执行下载 | 每次先申请短期地址；已清理凭证不再提供入口 | 未验证 |
| 中断续传 | 多文件上传中制造一次失败后重试 | 已登记文件不重复，最终反馈只提交凭证编号 | 未验证 |

### 11.4 处理/审核提醒与凭证清理

仅使用专门创建的测试业务、测试账号和无敏感内容的测试文件。不得修改真实业务的保留日期，不得用真实凭证做删除测试。

1. 先确认三个定时云函数触发器仍停用。
2. 在隔离测试数据中准备：一个到期前 15/7/1 天的冻结业务、一个超过 24 小时且未关联的孤立测试文件、一个已到期的普通业务测试凭证、一个已到期的审计修订测试凭证。
3. 再次备份这些测试记录，并确认云存储对象只属于测试数据。
4. 从控制台手动调用一次 `evidenceRetention`，保存脱敏计数。
5. 重复调用一次验证幂等性。

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

## 十二、回滚

发生权限错误、索引错误、异常删除、持续超时或客户端关键流程失败时按以下顺序回滚：

1. **先停用新版模板**，阻止继续创建新版审核节点。
2. **再停用 `calendarSync` 与 `workflowReminder` 的新触发器**；`evidenceRetention` 保持 `triggers: []`。
3. 若仍有运行中的函数，等待其结束并检查脱敏日志；不要通过删除集合中断。
4. 回退客户端、`businessApi`、`calendarSync` 与 `workflowReminder` 到部署前记录的版本，并确认既有环境变量仍存在。
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
calendarSync 部署与当前/下一年手工同步：通过 / 失败 / 未验证
workflowReminder 部署：通过 / 失败 / 未验证
evidenceRetention 部署：通过 / 失败 / 未验证
触发器时区与下一次时间：已核对 / 未核对（首次验收保持空触发器）
节点审核、双 SLA、日历待补算恢复验收：通过 / 失败 / 未验证
多账号验收：通过 / 失败 / 未验证
凭证验收：通过 / 失败 / 未验证
处理/审核提醒与定时清理隔离测试：通过 / 失败 / 未验证
回退版本：已记录在受控运维记录 / 未记录
```

## 十四、官方参考

- [腾讯云 CloudBase 云函数](https://cloud.tencent.com/document/product/876/46899)
- [腾讯云定时触发器说明](https://cloud.tencent.com/document/product/583/9708)
- [腾讯云创建触发器](https://cloud.tencent.com/document/product/583/30230)

控制台菜单名称和时区展示可能随版本变化。实际操作时以目标环境页面显示为准，并始终通过“下一次触发时间”反向核对中国时间。
