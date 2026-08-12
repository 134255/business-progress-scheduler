# Project Memory

Last stable-fact review: 2026-08-12 (Asia/Shanghai)

## Product

This is an internal business-progress management WeChat Mini Program. Super administrators control accounts, templates, node ownership, and system rules. Authorized users create business lines from enabled templates, responsible users submit node progress and evidence, and associated users inspect progress and evidence history.

Approved V1 rules include:

- Account/password login with first-login password change, one-to-one WeChat identity binding, lockout, administrator reset, and at least one active super administrator.
- Template snapshots, sequential nodes, multiple responsible accounts with first-completion-wins (`OR` signing), logical deletion, audit history, and optimistic/concurrent flow protection.
- Templates contain stable node and dynamic-field identifiers. Enabled templates are read-only and must be disabled before editing. New business lines receive server-generated globally unique codes, and instance nodes receive immutable codes derived from the business code.
- Node feedback is revisioned and immutable. New review-workflow nodes separate non-overlapping processors and reviewers: processors save progress or submit for review, while independent reviewers use OR/ALL votes to approve or reject; new nodes cannot use the legacy direct-complete or legacy-reject path. Old business nodes retain controlled feedback-read compatibility and never receive fabricated review history.
- Completed, cancelled, and closed business lines freeze their structured data. Only a super administrator may append a reasoned correction with before/after values; ordinary update paths remain blocked.
- China workday calculations from a locally cached holiday adapter; default working hours are 09:00–20:00 without lunch break. Default node SLA is two workdays (22 work hours), and template nodes may override it.
- In-app notifications as the fallback channel and a future Enterprise WeChat self-built application as the strong-reminder channel. Unfinished nodes are reminded every accumulated work hour during working time.
- Evidence supports JPG/JPEG/PNG up to 5 MB each, PDF up to 20 MB each, and MP4/MOV/M4V up to 20 MB each. A feedback may contain multiple files but no more than 20 MB in total.
- Evidence objects remain available for 60 calendar days after a business line is completed, cancelled, or closed. A scheduled idempotent cleanup then removes only the cloud file object while preserving metadata, hashes, feedback revisions, and audit history.

The complete baseline requirements are in `docs/superpowers/specs/2026-08-05-business-progress-v1-design.md`. The approved template, node, field, rejection, freeze, numbering, and evidence-retention refinement is in `docs/superpowers/specs/2026-08-07-template-node-fields-design.md`. Account-administration execution steps are in `docs/superpowers/plans/2026-08-05-account-admin.md`.

## Architecture

- Client: native WeChat Mini Program using JavaScript, WXML, and WXSS under `miniprogram/`.
- Client authentication starts at `pages/login/index`; an uninitialized system navigates to the guarded `pages/admin-initialize/index` page, which calls the cloud function from the Mini Program runtime and automatically hands successful initialization to forced password change. `miniprogram/app.js` owns the in-memory current-user state and the reset helper. First-login challenges remain memory-only until password change completes. Explicit logout persists only a non-sensitive boolean manual-login preference; it suppresses binding-based automatic restoration until successful password authentication clears it.
- Backend: Tencent CloudBase Node.js cloud functions, cloud database, and cloud storage.
- Current entry point: `cloudfunctions/businessApi/index.js`, with pure domain helpers under `cloudfunctions/businessApi/lib/`.
- Target modular shape: retain a unified API entry for ordinary domain calls, extract account/template/business/evidence/notification modules, and use separate scheduled functions for calendar synchronization, hourly reminders, and orphan-file cleanup.
- External holiday source is isolated behind an adapter. The approved endpoint is `https://holiday.ailcc.com/api/holiday/allyear/{year}`; production use requires renewed terms and availability verification.
- `calendarSync` uses Node's built-in HTTPS client and publishes each fully validated AILCC year as a uniquely identified immutable generation in `work_calendar_entries`. `work_calendar_years` atomically selects the active generation only after every natural day is staged; an expired worker can keep writing only its own unselected generation and cannot overwrite a successor. Same-version skips compare every stored date/workday value with the validated source year through at most four 100-row pages per year; this query requires the `work_calendar_entries(sourceYear ASC, generationId ASC, date ASC)` composite index. Scheduled authorization relies only on the platform-injected `getWXContext().TRIGGER_SRC === 'timer'` value and uses the server clock; event payload fields do not authorize. Manual synchronization is available only through the authenticated super-administrator API, which issues a short-lived one-time server-side ticket.
- Enterprise WeChat sending must remain behind an adapter and disabled until approved secure configuration is supplied.

Primary collections include `users`, `user_credentials`, `auth_challenges`, `wechat_bindings`, `system_settings`, `templates`, `template_nodes`, `sequence_counters`, `business_lines`, `business_nodes`, `node_feedback`, `node_review_rounds`, `node_review_votes`, `evidences`, `work_calendar_entries`, `work_calendar_years`, `calendar_sync_requests`, `notifications`, notification-delivery records, and `audit_logs`. 当前日历运行时只使用三个按代际拆分的日历集合；`work_calendar` 不是当前主存储，也不应作为本次部署创建或备份的必备集合。

Account transaction invariants are recorded in `docs/memory/decisions/ADR-0002-account-transaction-invariants.md`.
Unbounded-count feedback evidence attachment uses hidden, deterministic, chunked reservations under the existing `node_feedback` and `evidences` collections; the invariant and Task 11 recovery obligation are recorded in `docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md`.
For ordinary feedback evidence, a strict non-null completed-line `purgeDueAt` is authoritative for the whole business line; every terminal line state (`completed`, `cancelled`, `closed`, or `deleted`) must carry that valid deadline or evidence access/history fails closed. Attached evidence records declare `retentionScope: business_line` with `retentionSource: node_feedback`; future Task 9 amendment evidence may explicitly use `retentionScope: evidence` with `retentionSource: audit_amendment` and its own required strict deadline. One shared classifier enforces these exact scope/source pairs for access and history, while missing scope is accepted only by the explicit legacy `evidenceIds` adapter. Unknown or inconsistent scope/source metadata fails closed. Task 11 must scan due terminal lines and purge every associated evidence object by `businessLineId` in bounded chunks; earlier revisions therefore inherit the same deadline as the final revision.
Task 9 已落地业务驳回、关闭冻结和超级管理员审计修订。普通凭证继续继承业务线统一清理期限；审计修订附件从各自上传时间起独立保留 60 个自然日，并通过确定性、分块、可重试的 `audit_logs` 预约完成认领与发布。中断预约的 Task 11 回收义务记录在 `docs/memory/decisions/ADR-0004-business-lifecycle-amendment-reservations.md`。
Task 10 已落地原生小程序动态反馈和凭证交互。节点页从受保护接口重新读取字段快照、版本、提交权限与历史；凭证只能通过云存储上传后登记为 `evidenceId`，所有查看和下载先申请短期地址。超级管理员使用独立受保护接口全局检索冻结业务和查看脱敏修订历史，普通业务成员读取边界保持不变。
Task 11 已落地独立 `evidenceRetention` 定时云函数。它先分块回收反馈和审计修订的过期预约，再处理 24 小时孤立凭证、提前 15/7/1 天提醒和两种 60 天保留来源；文件清理使用带随机令牌的短期事务租约，云端删除成功或对象已不存在后才写入 `purged`，失败只保存安全分类与重试计数。真实定时触发器和目标环境索引由部署任务配置。完整的安全部署、索引、回滚和脱敏验收顺序记录在 `docs/deployment/template-node-fields-setup.md`。

Account deployment requires the `system_settings/account_admin_state` guard, deterministic `wechat_bindings/<sha256(openid)>` backfill, and removal of the legacy `users.openid` unique index only after a verified migration. The security-redacted operator procedure is `docs/deployment/account-admin-setup.md`.

Task 9 已接入小程序端审核工作台：受保护的业务服务提供提交审核、提交投票、审核待办、审核详情、消息通知和标记已读六个方法；节点处理采用“幂等保存草稿后提交审核”的两步流程，服务端反馈结果返回并持久化最新节点版本，保证第二步按真实版本提交且失败可使用原请求键重试。审核、通知、概览和业务详情页面只使用服务端安全投影与编号导航，页面重新显示时刷新服务端状态，并在账号、页面请求或版本变化时丢弃旧异步响应。

## Environment

- WeChat Mini Program AppID identifier: `wx6dcce945f944e52f`.
- CloudBase environment identifier: `cloud1-d5gxt99rh492670d9`.
- Mini Program root: `miniprogram/`.
- Cloud-function root: `cloudfunctions/`.
- Cloud function names: ordinary authenticated API `businessApi`; calendar synchronization and pending-deadline worker `calendarSync`; hourly processing/review reminder worker `workflowReminder`; scheduled retention worker `evidenceRetention`.
- Default Git integration branch: `main`; remote tracking branch: `origin/main`.

These identifiers are not credentials. Secret values, administrator passwords, recovery codes, account identity values, and customer records must be supplied through approved secure channels and never stored here.

## Verification commands

Run from the repository root:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
git diff --check
git status --short --branch
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

CloudBase collection and index changes, cloud-function upload, trigger configuration, WeChat DevTools interaction, multi-account concurrency, and calendar data coverage are manual acceptance boundaries and must be recorded as `unverified` until rerun for the exact current code. Initial node-review acceptance keeps `calendarSync`, `workflowReminder`, and `evidenceRetention` at `triggers: []`; after isolation acceptance, only calendar daily synchronization and hourly reminders may be approved separately.
