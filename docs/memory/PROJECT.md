# Project Memory

Last stable-fact review: 2026-08-19 (Asia/Shanghai)

## Product

This is an internal business-progress management WeChat Mini Program. Super administrators control accounts, templates, node ownership, and system rules. Authorized users create business lines from enabled templates, responsible users submit node progress and evidence, and associated users inspect progress and evidence history.

Approved V1 rules include:

- Account/password login with first-login password change, one-to-one WeChat identity binding, lockout, administrator reset, and at least one active super administrator.
- Template snapshots, sequential nodes, multiple responsible accounts with first-completion-wins (`OR` signing), logical deletion, audit history, and optimistic/concurrent flow protection.
- Templates contain stable node and dynamic-field identifiers. Enabled templates are read-only and must be disabled before editing. New business lines receive server-generated globally unique codes, and instance nodes receive immutable codes derived from the business code.
- Node feedback is revisioned and immutable. New review-workflow nodes separate non-overlapping processors and reviewers: processors save progress or submit for review, while independent reviewers use OR/ALL votes to approve or reject; new nodes cannot use the legacy direct-complete or legacy-reject path. Old business nodes retain controlled feedback-read compatibility and never receive fabricated review history.
- 新审核轮次会把当前处理轮最新已发布反馈的处理说明保存为不可变 `processingComment` 快照，并把该快照纳入审核草稿摘要和幂等校验；审核详情只读取轮次快照，不回查可变化的反馈。修复前的旧轮次缺少该字段时仅显示固定占位“暂无处理说明”，损坏、访问器或继承值均失败关闭。
- Completed, cancelled, and closed business lines freeze their structured data. Only a super administrator may append a reasoned correction with before/after values; ordinary update paths remain blocked.
- China workday calculations from a locally cached holiday adapter; default working hours are 09:00–20:00 without lunch break. Default node SLA is two workdays (22 work hours), and template nodes may override it.
- In-app notifications as the fallback channel and a future Enterprise WeChat self-built application as the strong-reminder channel. Unfinished nodes are reminded every accumulated work hour during working time.
- 需要持久化的处理与审核累计工作时长采用“已经完整经过的工作分钟”：权威工作区间的秒级结果向下取整，保留精确时间戳但不通过四舍五入提前累计分钟或判定逾期；提醒工作器继续使用精确秒级阈值。
- Evidence supports JPG/JPEG/PNG up to 5 MB each, PDF up to 20 MB each, and MP4/MOV/M4V up to 20 MB each. A feedback may contain multiple files but no more than 20 MB in total.
- For optional evidence, a strictly valid empty format allowlist means evidence is optional and every one of the seven system-supported formats is allowed. Required evidence still requires a non-empty allowlist; a non-empty allowlist always remains a strict format restriction. Malformed, inherited, accessor, duplicate, or unsupported policy values fail closed.
- Evidence objects remain available for 60 calendar days after a business line is completed, cancelled, or closed. A scheduled idempotent cleanup then removes only the cloud file object while preserving metadata, hashes, feedback revisions, and audit history.
- 第二批次采用短期能力令牌分享已完成节点的固定结果快照：发送者通过微信原生分享面板选择好友或群，接收者无需登录或业务成员权限，快照最长有效七个二十四小时；公开投影只含固化字段、处理说明和短期凭证地址，不暴露永久文件编号、身份值或内部预约数据。详细决策见 `docs/memory/decisions/ADR-0008-public-node-share-capabilities.md`。
- 概览页的“待我处理”由服务端权威查询提供；新版审核节点按当前处理账号关系查询，纯旧节点只在没有任何新账号关系标记时兼容 OpenID。结果返回前重新校验活动账号、业务、当前节点和处理关系；超过 2,000 条安全扫描边界时只返回诚实下界。
- 活动超级管理员可使用受保护运营看板和安全 CSV 导出。统计按上海自然日和权威状态计算；导出只含业务/节点编号、名称、固化参与人显示名、工作流、轮次、截止时间和累计/逾期分钟，并阻断电子表格公式注入。
- 每个新版模板节点可分别选择固定候选账号或“业务发起人作为本节点唯一处理人/唯一审核人”。发起人模式不保存占位账号，业务创建事务把当前活动发起人和安全显示名固化为该节点唯一角色快照；同一节点解析后的处理人与审核人不得重叠，固定处理人恰为实际发起人时也拒绝创建，不自动改写模板。模板头以 SHA-256 `definitionDigest` 绑定规范化节点定义；发起人审核模板读取和业务创建事务都必须验证该摘要，创建预约事务还逐个固定读取源模板节点并重新计算摘要，因此模板节点在服务预读后的任何变化都会失败关闭。业务创建预算按“源节点读取 + 业务节点写入 + 去重参与账号读取 + 固定操作”计算并保持不超过 100 次。创建预约、发布和已发布幂等返回均重新校验当前活动创建人及严格业务关系。业务节点的参与人显示名是创建时不可变快照，审核轮次与历史详情不得回查当前账号姓名覆盖历史；旧业务缺快照只使用固定安全占位。旧模板缺审核人来源时按固定账号兼容，旧业务不迁移；跨节点参与不受影响。每个处理轮只把工时归属实际提交审核账号，每张审核票只把响应工时归属实际投票账号；未提交者和未投票者不产生个人工时。日历缺失时保存不可变区间并由独立游标补算，旧记录缺字段只显示“历史未记录”。活动超级管理员可在运营看板查看这些逐轮安全快照；不提供人员排名，CSV 结构保持不变。详细决策见 `docs/memory/decisions/ADR-0009-initiator-processor-and-personal-worktime-snapshots.md` 与 `docs/memory/decisions/ADR-0011-initiator-reviewer-assignment.md`。
- 运营历史统计按模板及稳定节点比较处理/审核工作分钟，并提供日、周、月趋势、模板版本、业务状态、业务、稳定节点和匿名参与人筛选。所有活动账号可查看不含业务明细的全局汇总；普通账号下钻时逐条复核当前业务关系，超级管理员可查看全部明细并保留原当前指标和安全 CSV。节点处理累计全部处理轮，节点审核累计全部终态审核轮，个人投票响应只进入轮次明细；待日历补算和历史未记录不会伪装成零值。派生事实与每日汇总由只信任平台 Timer 的 `operationsAnalytics` 幂等生成，详见 `docs/memory/decisions/ADR-0010-operations-analytics-materialized-facts.md`。

The complete baseline requirements are in `docs/superpowers/specs/2026-08-05-business-progress-v1-design.md`. The approved template, node, field, rejection, freeze, numbering, and evidence-retention refinement is in `docs/superpowers/specs/2026-08-07-template-node-fields-design.md`. Account-administration execution steps are in `docs/superpowers/plans/2026-08-05-account-admin.md`.

## Architecture

- Client: native WeChat Mini Program using JavaScript, WXML, and WXSS under `miniprogram/`.
- Client authentication starts at `pages/login/index`; an uninitialized system navigates to the guarded `pages/admin-initialize/index` page, which calls the cloud function from the Mini Program runtime and automatically hands successful initialization to forced password change. `miniprogram/app.js` owns the in-memory current-user state and the reset helper. First-login challenges remain memory-only until password change completes. Explicit logout persists only a non-sensitive boolean manual-login preference; it suppresses binding-based automatic restoration until successful password authentication clears it.
- Backend: Tencent CloudBase Node.js cloud functions, cloud database, and cloud storage.
- Current entry point: `cloudfunctions/businessApi/index.js`, with pure domain helpers under `cloudfunctions/businessApi/lib/`.
- Target modular shape: retain a unified API entry for ordinary domain calls, extract account/template/business/evidence/notification modules, and use separate scheduled functions for calendar synchronization, hourly reminders, and orphan-file cleanup.
- External holiday source is isolated behind an adapter. The approved endpoint is `https://holiday.ailcc.com/api/holiday/allyear/{year}`; production use requires renewed terms and availability verification.
- `calendarSync` 使用 Node.js 内置 HTTPS 客户端，把每个完整验证的 AILCC 年份作为具有唯一编号的不可变代际写入 `work_calendar_entries`；只有全年每个自然日均写入成功后，`work_calendar_years` 才原子切换活动代际。过期工作器只能继续写自己的未选中代际，不能覆盖后继工作器。同版本跳过前会以每页最多 100 条、每年最多四页的方式核对所有日期和工作日标记；该查询依赖 `work_calendar_entries(sourceYear ASC, generationId ASC, date ASC)` 组合索引。`calendarSync`、`workflowReminder` 与 `evidenceRetention` 的计划入口只信任平台注入的服务端环境变量 `process.env.TRIGGER_SRC === 'timer'`，拒绝非空客户端 `OPENID`，并只使用服务端状态与时钟；事件载荷和 `getWXContext().TRIGGER_SRC` 均不能授权。人工日历同步只能通过已认证超级管理员接口签发并由服务端一次性消费短期票据；`evidenceRetention` 不提供人工 API，破坏性验收必须使用单独批准的一次性 Timer。持久边界见 `docs/memory/decisions/ADR-0007-trusted-timer-source.md`。
- Enterprise WeChat sending must remain behind an adapter and disabled until approved secure configuration is supplied.

Primary collections include `users`, `user_credentials`, `auth_challenges`, `wechat_bindings`, `system_settings`, `templates`, `template_nodes`, `sequence_counters`, `business_lines`, `business_nodes`, `node_feedback`, `node_review_rounds`, `node_review_votes`, `evidences`, `work_calendar_entries`, `work_calendar_years`, `calendar_sync_requests`, `notifications`, notification-delivery records, `audit_logs`, `public_node_shares`, `public_node_share_chunks`, `operations_analytics_facts`, and `operations_analytics_daily`. 当前日历运行时只使用三个按代际拆分的日历集合；`work_calendar` 不是当前主存储，也不应作为本次部署创建或备份的必备集合。

Account transaction invariants are recorded in `docs/memory/decisions/ADR-0002-account-transaction-invariants.md`.
Unbounded-count feedback evidence attachment uses hidden, deterministic, chunked reservations under the existing `node_feedback` and `evidences` collections; the invariant and Task 11 recovery obligation are recorded in `docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md`.
For ordinary feedback evidence, a strict non-null completed-line `purgeDueAt` is authoritative for the whole business line; every terminal line state (`completed`, `cancelled`, `closed`, or `deleted`) must carry that valid deadline or evidence access/history fails closed. Attached evidence records declare `retentionScope: business_line` with `retentionSource: node_feedback`; future Task 9 amendment evidence may explicitly use `retentionScope: evidence` with `retentionSource: audit_amendment` and its own required strict deadline. One shared classifier enforces these exact scope/source pairs for access and history, while missing scope is accepted only by the explicit legacy `evidenceIds` adapter. Unknown or inconsistent scope/source metadata fails closed. Task 11 must scan due terminal lines and purge every associated evidence object by `businessLineId` in bounded chunks; earlier revisions therefore inherit the same deadline as the final revision.
Task 9 已落地业务驳回、关闭冻结和超级管理员审计修订。普通凭证继续继承业务线统一清理期限；审计修订附件从各自上传时间起独立保留 60 个自然日，并通过确定性、分块、可重试的 `audit_logs` 预约完成认领与发布。中断预约的 Task 11 回收义务记录在 `docs/memory/decisions/ADR-0004-business-lifecycle-amendment-reservations.md`。
Task 10 已落地原生小程序动态反馈和凭证交互。节点页从受保护接口重新读取字段快照、版本、提交权限与历史；凭证只能通过云存储上传后登记为 `evidenceId`，所有查看和下载先申请短期地址。超级管理员使用独立受保护接口全局检索冻结业务和查看脱敏修订历史，普通业务成员读取边界保持不变。
Task 11 已落地独立 `evidenceRetention` 定时云函数。它先分块回收反馈和审计修订的过期预约，再处理 24 小时孤立凭证、提前 15/7/1 天提醒和两种 60 天保留来源；文件清理使用带随机令牌的短期事务租约，云端删除成功或对象已不存在后才写入 `purged`，失败只保存安全分类与重试计数。真实定时触发器和目标环境索引由部署任务配置。完整的安全部署、索引、回滚和脱敏验收顺序记录在 `docs/deployment/template-node-fields-setup.md`。

第二批次公开分享把头记录写入 `public_node_shares`，凭证顺序按每块最多 40 条写入 `public_node_share_chunks`。创建令牌由仅存在于 `businessApi` 环境变量的高熵密钥执行 HMAC-SHA256 派生；同一账号、业务、节点和幂等请求键恢复同一预约。有效分享通过 `publicShareHoldUntil` 暂缓凭证清理；到期后由 `evidenceRetention` 有界删除分享块和头记录。首版不提供手动提前撤销。

所有必需多键索引中的账号数组采用最多 50 项且可见 BSON 编码不超过 768 字节的保守预算；业务成员数组另为最长 128 字节创建者预留一项，并与 100 次事务操作预算同时生效。新审核轮次固化处理人/审核人显示名，旧轮次缺失快照时只显示安全固定占位。`evidenceRetention` 的生产与服务批次上限统一为 40；精确状态/到期组合查询按权威排序字段与 `_id` 使用带明确 schema 和独立乐观修订的持久复合 keyset 游标，每条路径单次最多扫描 40 条原始记录；严格合法的旧 `{phase, afterId}` 游标由函数自动审计迁移到同阶段起点。详细决策见 `docs/memory/decisions/ADR-0006-index-budget-history-snapshots-and-retention-cursors.md`。

Account deployment requires the `system_settings/account_admin_state` guard, deterministic `wechat_bindings/<sha256(openid)>` backfill, and removal of the legacy `users.openid` unique index only after a verified migration. The security-redacted operator procedure is `docs/deployment/account-admin-setup.md`.

Task 9 已接入小程序端审核工作台：受保护的业务服务提供提交审核、提交投票、审核待办、审核详情、消息通知和标记已读六个方法；节点处理采用“幂等保存草稿后提交审核”的两步流程，服务端反馈结果返回并持久化最新节点版本，保证第二步按真实版本提交且失败可使用原请求键重试。审核、通知、概览和业务详情页面只使用服务端安全投影与编号导航，页面重新显示时刷新服务端状态，并在账号、页面请求或版本变化时丢弃旧异步响应。

## Environment

- WeChat Mini Program AppID identifier: `wx6dcce945f944e52f`.
- CloudBase environment identifier: `cloud1-d5gxt99rh492670d9`.
- Mini Program root: `miniprogram/`.
- Cloud-function root: `cloudfunctions/`.
- Cloud function names: ordinary authenticated API `businessApi`; calendar synchronization and pending-deadline worker `calendarSync`; hourly processing/review reminder worker `workflowReminder`; scheduled retention worker `evidenceRetention`; materialized operations analytics worker `operationsAnalytics`.
- Default Git integration branch: `main`; remote tracking branch: `origin/main`.

These identifiers are not credentials. Secret values, administrator passwords, recovery codes, account identity values, and customer records must be supplied through approved secure channels and never stored here.

## Verification commands

Run from the repository root:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
npm.cmd test --prefix cloudfunctions/operationsAnalytics
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
git diff --check
git status --short --branch
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

CloudBase collection and index changes, cloud-function upload, trigger configuration, WeChat DevTools interaction, multi-account concurrency, and calendar data coverage are manual acceptance boundaries and must be recorded as `unverified` until rerun for the exact current code. Initial node-review acceptance keeps `calendarSync`, `workflowReminder`, and `evidenceRetention` at `triggers: []`; after isolation acceptance, only calendar daily synchronization and hourly reminders may be approved separately.
