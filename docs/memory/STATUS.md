# Current Status

Status captured: 2026-08-11 (Asia/Shanghai)

## Verified state

- 2026-08-11 节点独立审核流程 Task 4 正式复审修复轮次 1 已完成本地实现与回归。`calendarSync` 不再接受客户端自报 `mode`/`now`：有 OpenID 的直调一律拒绝，计划路径只接受无客户端身份的 Timer 事件并使用服务端时钟，人工路径由 `businessApi.syncWorkCalendar` 在复核活动超级管理员后签发 5 分钟一次性票据并从服务端调用。日历改为每次同步独立的不可变 `generationId`；旧 worker 在租约被接管后恢复只能写旧代际，不可污染新活动代际。同来源版本仅在活动代际全年完整且每日记录严格合法时跳过；缺日或坏记录安全重建。两个部署包都对代际年份、非空来源版本和记录归属 fail-closed。边界将数据库/索引故障转为安全中文错误且日志不记原始细节。模板处理/审核 SLA 仅接受可精确换算为正整数分钟的小时值，客户端同步拦截；待补算版本达 `MAX_SAFE_INTEGER` 时不写回。本地全量结果：`businessApi` 391/391、`calendarSync` 24/24、小程序 109/109、WXML 3/3；真实 AILCC 网络、CloudBase 部署/权限/索引/事务接管与触发器仍未验证，触发器保持未启用。

- 2026-08-11 节点独立审核流程 Task 4 已完成中国工作时间、日历同步和双 SLA 待补算基础设施：`businessApi` 新增固定上海时区 09:00—20:00、无午休的分钟级服务，支持跨日、法定休息日、下一工作时刻和区间工作分钟；任何所需日期缺失或文档编号、日期、严格布尔工作日标记损坏时均返回 `pending_calendar`，不猜测周末。独立 `calendarSync` 只用 Node 内置 HTTPS 请求 AILCC，执行超时、状态码、响应大小、JSON、年份、计数、日期唯一性、全年自然日覆盖和严格 `is_holiday` 校验。完整年份以主/影子日期代际分批暂存，全部成功后用年份指针原子发布；10 分钟同步租约阻止手工与计划任务交叉写入，失败保留旧活动缓存。每次最多读取 40 个处理/审核待补算候选，并逐条事务复核活动业务、节点/审核轮次、版本和当前状态后写回截止时间、日历版本及管理员日历通知处理状态。新函数入口已实现但未配置真实触发器；真实 AILCC 网络、CloudBase 部署/权限/索引/并发和目标环境依赖安装仍未验证。

- 2026-08-11 节点独立审核流程 Task 3 已完成超级管理员模板节点编辑页升级：节点页以明确 `workflowMode: 'review'` 输出处理人、审核人、或签/会签和处理/审核双 SLA（默认 22/8），保存对象不再携带旧 `assigneeUserIds` 或单一 `slaWorkHours`。纯旧节点仅在缺少 `workflowMode` 时将旧负责人映射为处理人初值；任何已声明的模式均不读取旧负责人。重新保存和模板定义清理均写入显式新版字段。处理人与审核人用同一受控账号选项分别勾选，保存前拒绝交集和空角色；启用模板的节点页继续只读。节点摘要显示两类人数、或签/会签及双时限；异步保存返回处理人/审核人失效码时保留页面并显示安全提示。导航仅携带节点索引，账号选择的 WXML dataset 仅携带内部账号编号，新增 WXML 门禁防止整条账号对象进入 dataset。真实微信开发者工具交互验收仍未执行。

- 2026-08-11 节点独立审核流程 Task 2 已完成模板审核配置持久化：模板服务以一个排序去重的参与账号集合统一覆盖处理人与审核人；创建、更新、启用均先验证角色规则并将该集合交给仓储事务复核，启用模板的可用性投影也读取全量参与账号。CloudBase 模板仓储参数已从 `assigneeUserIds` 迁移为 `participantUserIds`，并在同一事务中逐个固定读取活跃账号；创建预算为节点数加不同参与账号数加 2，更新/状态变更预算在既有固定操作数上同样计入所有参与账号，超过 100 次操作失败关闭。为衔接后续业务快照迁移，模板服务按相同参与账号集合预演快照预算，48 节点、47 个不同参与账号的 101 次预算模板不会向普通用户显示为可用；旧版纯 `assigneeUserIds` 模板兼容边界与空节点草稿仍保持。2026-08-11 本地验证：聚焦 RED 命令 `node --test cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js` 如预期 6 项失败（旧仓储忽略新参数且旧快照预算未计审核人）；独立复审补强更新/启用传参和精确 100 次操作边界后，同命令为 35/35 通过；`node --test cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js` 为 39/39 通过；最终 `npm.cmd test --prefix cloudfunctions/businessApi` 为 376/376 通过（仅有两项既存 malformed npm user-config 警告），`node tools/test-wxml-structure.mjs` 为 2/2 通过。

- 2026-08-11 节点独立审核流程 Task 1 已完成本地领域实现及修复轮次 1、2：新增 `review-domain` 固定审核工作流、或签/会签和处理动作的封闭枚举、投票输入校验及轮次/审核人确定性投票编号；新版模板节点固定快照处理人、审核人、审核模式、处理与审核双 SLA，处理默认 22 工时、审核默认 8 工时。模板服务按处理人与审核人的去重参与账号校验并安全映射处理人失效、审核人失效和角色交集；业务服务验证新版定义。仅当所有节点均未声明 `workflowMode` 时，旧 `assigneeUserIds` 节点才走显式兼容边界；声明 `workflowMode: review` 的节点绝不回退到旧字段。草稿模板可创建或更新为显式/隐式空节点集合，但启用仍必须有节点并继续执行新版角色、角色交集和旧模板兼容校验。完整 `businessApi` 回归为 371/371 通过；CloudBase 仓储持久化、事务预算和业务快照的新版字段迁移仍由后续 Task 2 负责。

- 2026-08-11 节点独立审核流程的五部分设计及书面版本均已由项目所有者确认。新版模板节点将分别配置处理人和审核人，支持或签、会签、独立处理/审核 SLA、不可变审核轮次和确定性唯一投票；处理人不再直接完成节点，只有审核通过才自动激活下一节点或完成业务线。完整中文设计为 `docs/superpowers/specs/2026-08-11-node-review-workflow-design.md`，架构决策为 `docs/memory/decisions/ADR-0005-node-review-rounds-and-votes.md`，实施计划为 `docs/superpowers/plans/2026-08-11-node-review-workflow.md`。Task 1 已建立领域契约；后续任务仍须完成仓储、业务快照、审核流转、集合/索引、部署和真实小程序验收。

- 2026-08-10 真实 CloudBase 部署验收已推进到小程序编译门禁。操作员已脱敏确认相关集合备份、隔离旧测试业务清理、新版集合、客户端不可直读写权限、两个唯一索引及全部必需组合索引已完成；保留审计记录，未记录任何业务编号、身份值或凭证内容。操作期间曾从 `main` 根目录上传旧版 `businessApi`，在发现正确隔离工作区前未继续验收，随后已由 `codex/template-node-fields` 待发布工作区重新覆盖部署并确认原环境变量仍有效。`evidenceRetention` 已上传，入口为 `index.main`、内存 256 MB；目标免费开发环境实际只允许 1—60 秒超时，已按 60 秒保存。当前控制台以内联 JSON 管理触发器且无独立停用开关，已保持 `triggers` 空数组，因此定时清理尚未启用。
- 正确隔离工作区首次微信开发者工具编译暴露了模板列表的 WXML 组合指令缺陷：循环卡片在同一元素上同时使用 `wx:else` 和 `wx:for`，微信编译器报“`wx:if not found`”。新回归检查先在原页面上精确失败，最小修复改为外层 `<block wx:else>` 与内层卡片 `wx:for`；专项 WXML 检查 2/2 和模板业务客户端测试 12/12 通过。微信开发者工具重新编译仍待操作员验收，不得标记为通过。
- Task 12 的本地发布资料已完成。新增中文 `docs/deployment/template-node-fields-setup.md`，以备份可读性为起点，固定集合、唯一值核对、索引、`businessApi`、`evidenceRetention`、停用状态每日触发器、分阶段脱敏验收和先停触发器再回滚的安全顺序；README 已提供统一入口。手册同时覆盖新账号与旧业务兼容查询索引、七段 Cron 与时区反向核对、图片/PDF/多视频、或签、驳回返工、冻结修订和隔离清理测试。真实 CloudBase 备份、索引、函数上传、触发器、真实云文件删除、多账号并发和微信开发者工具验收仍未执行，不能标记为发布完成。
- Task 11 已完成本地实现与自审。独立 `evidenceRetention` 定时云函数按固定顺序回收过期反馈预约、回收过期审计修订预约、清理 24 小时孤立凭证、创建提前 15/7/1 天站内提醒并处理 60 天到期凭证。反馈与修订附件均按最多 40 个文件分块恢复，41 个修订附件测试证明事务不超过 100 次文档操作；缺失反馈预约只会清除到期且仍指向该编号的节点锁。文件删除前必须取得带随机令牌的 10 分钟事务租约，只有持有同一令牌的工作器可以确认成功或写入安全失败分类；中断后仅过期租约可重新认领。云对象已不存在视为幂等成功，元数据保留但永久文件编号被移除。提醒使用确定性编号并可跨批次跳过已存在记录。`wx-server-sdk` 已通过独立锁文件固定为 `4.0.2`。Task 11 定向测试 19 个全部通过；真实 CloudBase 定时触发器、目标环境索引、真实云文件删除和独立代码审查仍未验证。
- Task 10 已完成本地实现与自审。节点反馈页只接收业务线和节点标识，并重新读取服务端业务、节点版本、字段快照、提交权限和不可变历史；客户端支持短文本、长文本、数字、布尔、日期、单选、多选 7 类字段及字段级快速校验，服务端仍是最终可信校验边界。图片、PDF、视频支持分批选择和多个视频，客户端执行图片 5 MB、PDF/视频 20 MB、单次合计 20 MB 的上传前校验；文件按顺序上传并立即登记，失败重试保留已登记凭证且最终只提交 `evidenceId`。图片、PDF、视频和批量下载均先获取 5 分钟临时访问地址，已清理凭证不再提供查看入口。业务详情新增相邻节点驳回、进行中业务关闭/取消/逻辑删除和冻结提示；超级管理员新增独立的冻结业务全局检索、脱敏详情、修订前后值、专用附件和审计式修订页面，普通成员读取规则未放宽。所有异步加载和写入在结果写回前复核当前账号。真实 CloudBase 部署、微信开发者工具交互和独立代码审查仍未验证。
- Task 9 已完成本地实现与自审。当前活动节点负责人可原子驳回紧邻的上一已完成节点，业务指针与进度同步回退，但原反馈、凭证、到期时间、激活时间和完成时间均不重置；同一请求键幂等重试只产生一次状态变化和审计记录。业务线管理员或超级管理员可将进行中业务关闭、取消或逻辑删除，并在业务线上设置统一的 60 个自然日普通凭证清理期限；旧版业务更新、删除和反馈写入入口已从部署路由移除。冻结业务只允许超级管理员通过专用审计修订接口修改白名单字段，并保存原因、版本及精确前后值。修订附件通过确定性 `audit_logs` 预约按每块最多 40 个文件认领，单次总量不超过 20 MB、文件数量不设业务上限；每个附件从自身上传时间起独立保留 60 个自然日，只有预约发布后才允许访问。41 个附件的真实并发重试测试证明两个相同请求返回同一结果且只发布一次，105 个附件测试证明所有事务均不超过 100 次文档操作。中断预约回收义务已记录在 `ADR-0004`，由 Task 11 实现；独立代码审查、真实 CloudBase 部署和微信开发者工具验收仍未验证。
- Task 8-R is implemented, fully verified locally, and formally review-accepted after one fix round as the explicitly approved follow-up to Task 8's exhausted review ledger. Every actor-facing `reserved -> aborting` transition now commits in a transaction that reloads and authorizes the current actor, line, node, and exact reservation. Same-request expiry, OR-winner expiry, and submission-failure compensation cannot carry an authorization result into a later actorless recovery-start transaction. Before any reservation status or lease decision, same-request and OR paths verify the stored reservation ID, business-line ID, and node ID against the trusted request/node claim; a mismatched external reservation returns `VERSION_CONFLICT` without changing user, line, node, reservation, evidence, or audit state. OR recovery also rechecks that the node still claims the exact winner before mutation. Shared actorless rollback restores evidence and finalizes only an already-`aborting` reservation, while the repository-only Task 11 maintenance entry may independently start genuinely expired recovery, clears a claim only when the loaded node also belongs to the reservation line, and remains absent from public services and routes.
- Task 8 of the template/node/field plan is implemented on its isolated worktree; formal-review round five fixes are locally verified but remain pending reviewer acceptance. Every actor-facing feedback reservation path transactionally revalidates the current active actor and account relationships before deciding reservation absence/status or comparing stored request fingerprints and input hashes. This includes every OR-contention poll: each iteration uses only the trusted actor/account ID plus line/node IDs, atomically rereads current user/line/node state, fails `FORBIDDEN` on account or relationship changes before reading the winner, and only then reads and interprets the missing/reserved/published/aborted winner state; an authorized aborted cleanup clears the stale claim in that same transaction. Public lookup, begin, claim, finalization, and history retain the same fail-closed ordering, while expired-reservation recovery remains an actorless internal maintenance hook outside the feedback service and routes. Active account-ID assignees append immutable typed revisions, while history binds new evidence to the exact safe feedback revision and admits new records only for the exact `business_line/node_feedback` or `evidence/audit_amendment` scope/source pair; missing scope is confined to the explicit legacy `evidenceIds` adapter. Evidence attachment has no business count cap: 40-document claims stay below 100 operations and a digest binds cursor count, bytes, and ordered IDs. OR contention distinguishes completed winners, non-completion conflicts, live retryable leases, and recoverable expired/aborted claims. Only final-node completion starts retention. A shared strict classifier governs access and history: ordinary evidence on `completed`, `cancelled`, `closed`, or `deleted` lines requires a valid non-null line `purgeDueAt`; amendment evidence requires its own valid deadline; unknown, mismatched, missing, or malformed new-record metadata fails closed before temporary-URL issuance or history projection; and unattached uploads retain their 24-hour orphan lease. Task 11 must recover expired reservations, clear node claims whose reservation is missing, then scan due terminal lines and process all evidence by `businessLineId` in bounded chunks. Physical CloudBase request/document byte limits remain platform constraints. The durable protocol is recorded in `ADR-0003`.
- Task 7 of the template/node/field plan is implemented on its isolated worktree: authenticated `registerEvidenceUpload` and `getEvidenceAccess` routes now delegate only trusted account actors through a focused evidence service and CloudBase repository. Registration accepts only CloudBase file IDs, rejects a declared size above the universal 20 MB ceiling before authorization or cloud egress, authorizes an active business member who is the current active-node assignee or business owner before any download, and rechecks the same fixed documents before persistence. Relationship-schema precedence is evidence-wide: any own line or node relationship key following the `UserId`/`UserIds` convention selects account-ID authorization for registration and access; inherited or prototype keys are ignored, malformed or unrecognized account fields grant nothing, singular fields only trigger schema selection, and only wholly legacy line/node relationships may use the current transactional OpenID binding. Downloaded bytes, not client MIME, determine JPEG, PNG, PDF, or ISO-BMFF video category; extension, exact declared/actual size, per-file limits, node snapshot allowlist, and SHA-256 are enforced. Successful uploads persist secret-free unattached metadata with `available` storage state and a 24-hour orphan expiry while responses omit file IDs, hashes, bytes, and storage details. Evidence access revalidates the active account, business, and evidence node; only `null` or `undefined` timestamps are absent, while every present orphan, purge-due, or purged timestamp must be a finite Date or strict ISO string. Malformed timestamps, non-available storage, any purged marker, and deadlines at or before the current time return `EVIDENCE_EXPIRED` without issuing a temporary URL. Authorized access returns only a five-minute HTTPS temporary URL projection. The exported aggregate helper enforces a 20 MB feedback total without imposing a file-count limit; attachment and feedback completion remain Task 8, while Tasks 10 and 11 still own client upload behavior and orphan/retention cleanup.
- Task 6 of the template/node/field plan is implemented on its isolated worktree: the ordinary template list is fully server-backed with loading, failure, empty, available, and safely mapped unavailable states; unavailable-reason lookup accepts only own string keys, so prototype property names and malformed values always become a safe Chinese fallback string across cards, selection toasts, and create previews. Navigation carries only the selected template ID and no demo definition remains. Create mode previews the enabled-template availability projection, accepts only name, description, and planned dates, validates real calendar dates and ordering, synchronously prevents duplicate submission, and reuses one request key across a failed request retry before redirecting to the protected detail read. Edit mode renders generated codes and snapshot nodes as immutable, submits only metadata plus `expectedVersion`, and surfaces completed/closed/frozen state. A new protected metadata action authorizes account-ID managers (with legacy manager compatibility), revalidates both the active actor and the current legacy binding in a fixed-document transaction, rejects stale versions and creating/frozen/deleted records, updates only the four metadata fields, and writes one secret-free audit record without changing codes, nodes, members, or template snapshots. The dashboard adapter now derives recent lines from the protected account-aware list route, so newly created account-ID snapshots are not omitted; because the protected list does not yet expose an assignment aggregate, `pendingMine` is explicitly unavailable (`null` plus an availability flag) and the UI shows an em dash with a temporary-unavailability label instead of a fabricated zero.
- Task 5 of the template/node/field plan is implemented on its isolated worktree: `createBusinessFromTemplate` accepts only authenticated, validated template-backed metadata, and the deployed legacy manual-create route is disabled while legacy reads remain available. Business codes use the Asia/Shanghai day and expand beyond four digits; immutable node codes expand beyond three digits; and a deterministic actor/request reservation makes retries idempotent without storing the raw request key. The CloudBase repository revalidates the enabled template version, the active creator, and every active assignee in a bounded fixed-document transaction that atomically reserves the daily sequence and writes an invisible `creating` line plus all snapshot nodes. A second bounded transaction verifies every deterministic node, publishes the line as `active`, and writes one secret-free audit record. Snapshots preserve the source template/version, copied field definitions, creator manager/member membership, all assignees, and ready/waiting node state. Actor-aware list/detail reads use account IDs whenever either new membership field is present and OpenID only when both are absent; malformed new membership values grant no rights and never fall back to legacy arrays. Manager-only and member-only records remain visible under their selected schema, and `creating` reservations remain hidden, so a create response ID can open its published detail. A shared creator-aware operation predicate prevents over-budget templates from being enabled or advertised as available while preserving the maximum-48 node contract. Optimistic transaction tests now prove overlapping counter reservations conflict and retry to unique codes or one idempotent result.
- Task 4 of the template/node/field plan is implemented on its isolated worktree: the Mini Program now has a super-administrator-only template list, template editor, and node/field editor; all seven protected Task 3 actions have exact client wrappers; active assignee choices use account document IDs; stable node and field keys survive edit and reorder; enabled definitions render read-only until disabled; optimistic conflicts reload the latest definition; and server-owned `TEMPLATE_LIMIT_EXCEEDED` messages remain visible. Load and mutation boundaries recheck the current active-super-administrator role, including after lifecycle confirmations and every awaited load, save, lifecycle mutation, or refresh, so demotion makes stale continuations fail closed before page-state changes, success UI, refresh, or navigation. Node submission uses a synchronous single-flight guard before mutating the owner page. Template definitions and assignee identities stay out of navigation URLs because the node editor exchanges data only through the previous page instance.
- Task 3 of the template/node/field plan is implemented on its isolated worktree: protected template routes now expose administrator lifecycle operations and an ordinary-user enabled-template projection; the template service enforces super-administrator writes, disabled-before-edit, active account-document assignees, stable keys, optimistic versions, logical deletion, and a formally supported maximum of 48 nodes. The CloudBase repository paginates beyond the SDK's 100-document query window and atomically writes template metadata, fixed-ID node replacements, and one secret-free audit record using server dates after fixed-document template and active-assignee revalidation. Distinct assignee reads count against the 100-operation transaction budget; definitions that exceed the node or operation boundary return the safe `TEMPLATE_LIMIT_EXCEEDED` code and maximum-bearing message. Only template application errors carrying the shared private server-side `Symbol` may retain an allowlisted response; unmarked infrastructure failures return generic `INTERNAL_ERROR`.
- Task 2 of the template/node/field plan is implemented on its isolated worktree: pure CommonJS `field-domain` and `template-domain` modules normalize the seven supported field types, validate denormalized submitted-value snapshots, enforce stable node/field keys and contiguous sequences, apply the 22-work-hour SLA default, restrict evidence types, require active assignee account document IDs for enablement, and reject definition edits while a template is enabled. Text regular-expression definitions use a conservative non-grouped grammar so stored patterns cannot trigger catastrophic backtracking during feedback validation.
- Task 1 of the template/node/field plan is implemented on its isolated worktree: `createBusinessApi` accepts injected `protectedRoutes`; recognized protected actions receive the trusted resolved actor and payload separately, are rejected before handler invocation when authentication fails, and retain the existing account and legacy-route behavior.
- 项目所有者已批准完整的模板、节点、字段、驳回、冻结修订、视频凭证和 60 个自然日清理方案。确认后的设计为 `docs/superpowers/specs/2026-08-07-template-node-fields-design.md`，执行计划为 `docs/superpowers/plans/2026-08-07-template-node-fields.md`。Task 1 至 Task 11 已完成本地实现，Task 12 本地部署资料已就绪；下一步是操作员按手册完成真实 CloudBase 和微信开发者工具验收。
- WeChat DevTools account-administration smoke acceptance now covers automatic dashboard restoration, the authoritative super-administrator list state, creation of two ordinary test accounts and a second super administrator, case-insensitive duplicate-username rejection, safe disable/re-enable of the second administrator, rejection of disabling or demoting the final active super administrator, five-failure account lockout, administrator unlock, and read-only compatibility navigation through dashboard, business list, business detail, node feedback/history, and profile pages. No credential or identity value was recorded.
- The obsolete `account-admin` linked worktree is fully cleaned up: its accidental deployment-manual edit was explicitly discarded, Git worktree registration and contents were removed, the merged local `codex/account-admin` branch was deleted through the non-force path, and the final empty `.worktrees/account-admin` directory was removed after WeChat DevTools released it.
- Local `main` was fast-forwarded from `22a78f3` to the accepted account-administration head `f39c89e`. The merged result passed the full backend, client, WXML, syntax, diff, and project-memory checks. `origin/main` was then fast-forwarded through the integrated milestone and cleanup record at `b314785`.
- The safe Mini Program super-administrator recovery entry is implemented at `8e62b98` and `f38f26d` and manually accepted in WeChat DevTools. The operator rotated the one-time recovery state through the approved offline workflow, completed recovery and forced permanent-password change, entered the dashboard, and confirmed redacted guard, credential, binding, recovery-consumption, and audit outcomes. No secret or identity value was recorded.
- Persistent-logout manual acceptance is complete for the corrected flow: explicit logout remained on the password form, recompilation preserved the logged-out state, successful forced password completion cleared the manual-login preference, and the next recompilation restored the bound session automatically.
- Persistent explicit logout is implemented at `c4c5fea` and `b0e9cbf`. A focused utility persists only a boolean manual-login requirement, `app.js` exposes it through the authentication owner, profile logout sets it before clearing memory, the login page still checks initialization but suppresses binding-based restoration while it is active, and successful password authentication clears it. No backend or database interface changed.
- Manual CloudBase acceptance completed the guarded first-super-administrator initialization, forced first-login password change, dashboard entry, and redacted post-initialization checks. The singleton guard reports one active super administrator with consumed recovery state; the user, credential, binding, and initialization/password-change audit outcomes were confirmed without recording sensitive values.
- Manual acceptance originally exposed a persistent-logout defect in which profile logout cleared only in-memory state and `getSession` immediately restored the permanently bound account. The corrected boolean-preference flow and its restart behavior have now passed manual re-acceptance.
- Feature branch `codex/account-admin` implements the locally verifiable account-administration milestone through Task 7, including reviewed UI fixes at `cdf2977` and the reviewed deployment/runbook closeout at `7feac41`.
- The guarded first-super-administrator Mini Program flow is implemented through `a1db212`, `62b8cdf`, and `9b8b034`: the account service exposes initialization, the login page gates the entry, and the dedicated page rechecks server state, submits credentials from the trusted Mini Program runtime, clears sensitive fields, and hands successful initialization to forced password change.
- CloudBase fixed-document reads now normalize only explicit missing-document failures to `null` through `0f16140` and the reviewed boundary correction at `5fc1957`; collection, permission, network, timeout, and other database failures still propagate. The test database now reproduces the real SDK behavior instead of returning a synthetic null record.
- Implemented: password hashing, account/password authentication, first-login password change, lockout, emergency initialization/recovery, super-administrator user lifecycle, last-active-admin protection, CloudBase repositories, protected routes, deterministic WeChat identity reservations, and audit-safe logging.
- Mini Program account flow now includes silent account service calls with preserved backend error codes, session restoration, initialization gating, memory-only first-login challenge handoff, forced and normal password change, app-owned auth reset, and a dashboard guard without legacy profile bootstrapping.
- The Mini Program now includes protected super-administrator user listing, creation, editing, status changes, password reset, unlock, WeChat unbind, last-active-administrator messaging, gated dashboard entry, and profile password/logout controls. Password values stay out of global state, storage, datasets, and navigation parameters.
- CloudBase account state uses a singleton `system_settings/account_admin_state` guard so all active-super-admin transitions contend on one document.
- WeChat identity uniqueness uses `wechat_bindings/<sha256(openid)>`; it does not rely on an unsupported sparse unique `users.openid` index.
- Credential mutations use monotonic `credentialVersion`; challenge invalidation uses strict monotonic `challengeEpoch`. Both fail closed on corrupt or overflowing state.
- `wx-server-sdk` is pinned and locked at `4.0.2`.
- Task 7 adds `docs/deployment/account-admin-setup.md` and README guidance for collection/index setup, guarded migration order, initial administrator setup, recovery rotation, and local verification. It documents the implemented `INVALID_RECOVERY_CODE` result for consumed or mismatched recovery state rather than the stale-plan `RECOVERY_CODE_USED` value. Formal-review round one adds an explicit post-index-removal rollback sequence and a password-manager-only recovery-hash workflow.

## Verification

2026-08-11 节点独立审核流程 Task 4：

| 命令或边界 | 结果 |
|---|---|
| `node --test cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/cloud-work-calendar-repository.test.js`（初始 RED） | 按预期失败：2 个测试文件均因目标模块不存在而失败。 |
| `npm.cmd test --prefix cloudfunctions/calendarSync`（初始 RED） | 按预期失败：`calendarSync/package.json` 不存在。 |
| `node --test cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js`（审核补算 RED） | 按预期 6 项中 5 通过、1 失败：审核轮次待补算尚未写回。 |
| `node --test cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js`（并发同步 RED） | 按预期 7 项中 6 通过、1 失败：同年并发发布可使元数据版本与日期记录版本不一致。 |
| `node --test cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js`（提交后自审 RED） | 按预期 9 项中 7 通过、2 失败：零剩余分钟的空日历版本被错误拒绝，且审核补算未复核业务当前节点指针。 |
| 工作时间与日历读取聚焦 GREEN | 通过：12 个测试，0 失败。 |
| `npm.cmd test --prefix cloudfunctions/calendarSync` | 通过：19 个测试，0 失败；仅有两条既有 malformed npm user-config 警告。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：388 个测试，0 失败；仅有两条既有 malformed npm user-config 警告。 |
| `node tools/test-wxml-structure.mjs` | 通过：3 个测试，0 失败。 |
| 新增 JavaScript 语法检查 | 通过：7 个文件，0 语法错误。 |
| `npm.cmd ci --ignore-scripts --prefer-offline`（额外依赖安装检查） | 未通过：本机 npm cache 文件发生 `EPERM`，并伴随部分 `node_modules` 清理警告；不作为代码或锁文件通过证据，目标环境安装仍未验证。 |
| 真实 AILCC、CloudBase 与触发器 | 未验证：单元测试未访问网络；未部署新集合、权限、索引或函数，触发器保持未启用。 |

2026-08-11 节点独立审核流程 Task 3：

| 命令或边界 | 结果 |
|---|---|
| `node --test miniprogram/test/template-flow.test.js`（RED） | 按预期失败：20 个测试中 16 通过、4 失败；缺少处理人/审核人切换与新版保存构造，异步处理人失效码仍显示原始错误。 |
| `node tools/test-wxml-structure.mjs`（RED） | 按预期失败：3 个测试中 2 通过、1 失败；账号 dataset 安全门禁函数尚不存在。 |
| 复审兼容边界 RED：`node --test miniprogram/test/template-flow.test.js` | 按预期失败：22 个测试中 21 通过、1 失败；已声明未知 `workflowMode` 被错误映射为旧负责人。 |
| `node --test miniprogram/test/template-flow.test.js` | 通过：22 个测试，0 失败。 |
| `node tools/test-wxml-structure.mjs` | 通过：3 个测试，0 失败。 |
| `node --test miniprogram/test/*.test.js` | 通过：108 个测试，0 失败。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：376 个测试，0 失败；仅有两条既有 malformed npm user-config 警告。 |


2026-08-11 节点独立审核流程 Task 1：

| 命令或边界 | 结果 |
|---|---|
| `node --test cloudfunctions/businessApi/test/review-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js`（RED） | 按预期失败：`review-domain.js` 不存在；旧模板领域仍输出 `assigneeUserIds`/`slaWorkHours`，不识别新版节点字段。 |
| `node --test cloudfunctions/businessApi/test/review-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/field-domain.test.js` | 通过：12 个测试，0 失败。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 未全绿：361/366 通过、5 失败；根因已定位为旧业务/模板服务及其测试尚未迁移单角色节点契约，留给后续任务。npm 同时输出两条既有用户配置警告。 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 换行提示。 |

2026-08-11 节点独立审核流程 Task 1 修复轮次 1：

| 命令或边界 | 结果 |
|---|---|
| `node --test cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/account-routes.test.js`（RED） | 按预期失败：66 个测试中 54 通过、12 失败。失败暴露审核 SLA 错用 22 小时、服务仍读取旧 `assigneeUserIds`、业务服务不能验证新版节点、旧节点兼容边界缺失及新安全错误码未进入统一响应白名单。 |
| `node --test cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/template-service.test.js` | 通过：27 个测试，0 失败。 |
| `node --test cloudfunctions/businessApi/test/review-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/field-domain.test.js` | 通过：12 个测试，0 失败。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：368 个测试，0 失败；仅保留两条既有 npm 用户配置警告。 |
| `node tools/test-wxml-structure.mjs` | 通过：2 个测试，0 失败。 |
| `git diff --check` 与项目记忆校验 | 通过；仅保留既有 LF/CRLF 换行提示。 |

2026-08-11 节点独立审核流程 Task 1 修复轮次 2：

| 命令或边界 | 结果 |
|---|---|
| `node --test cloudfunctions/businessApi/test/template-service.test.js`（RED） | 按预期失败：17 个测试中 14 通过、3 失败；显式空节点创建、隐式空节点创建和草稿更新为空节点均错误返回 `TEMPLATE_INVALID`。 |
| `node --test cloudfunctions/businessApi/test/template-service.test.js`（GREEN） | 通过：17 个测试，0 失败。 |
| `node --test cloudfunctions/businessApi/test/review-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/field-domain.test.js` | 通过：12 个测试，0 失败。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：371 个测试，0 失败；仅保留两条既有 npm 用户配置警告。 |
| `node tools/test-wxml-structure.mjs` | 通过：2 个测试，0 失败。 |
| `git diff --check` 与项目记忆校验 | 通过；仅保留既有 LF/CRLF 换行提示。 |

下一步：Task 2 须将 CloudBase 仓储持久化、事务预算与业务快照从旧 `assigneeUserIds`/`slaWorkHours` 迁移到处理人、审核人、审核模式与双 SLA，再开展审核轮次流转。

2026-08-11 制定节点独立审核流程实施计划：

| 命令或边界 | 结果 |
|---|---|
| 计划结构自检 | 通过：11 个任务、55 个测试驱动步骤、106 个成对代码围栏；覆盖角色分离、或签/会签、处理与审核双时限、不可变轮次和投票、返工、自动流转、通知中心、旧业务兼容、60 天凭证保留、部署与回退。 |
| 法定节假日接口只读核对 | 通过：2026 全年接口响应顶层为 `code/year/count/data`，每日记录包含 `date` 和 `is_holiday`；计划据此定义完整校验、当前年与下一年同步、旧缓存保护和待计算截止时间补算。 |
| 未完成标记扫描 | 通过：计划不存在未决占位词或省略实现标记。 |
| `git diff --check` | 通过：已跟踪文档无空白错误；未跟踪计划以差异检查模式读取时仅返回“存在新增内容”的标准状态，未报告空白错误。 |
| 项目记忆校验 | 通过。 |
| 应用测试 | 未执行：本次只确认设计状态并新增实施计划，不修改可执行代码。 |

2026-08-11 执行节点独立审核流程设计记录：

| 命令或边界 | 结果 |
|---|---|
| 五部分设计逐段确认 | 通过：角色与状态机、数据结构与快照、事务与权限、页面与提醒、兼容与部署均得到项目所有者确认。 |
| 书面设计自检 | 通过：无未完成标记、冲突标记或未定规则；状态机、角色分离、双 SLA、凭证继承、兼容和回退边界一致。 |
| `git diff --check` | 首次检查发现设计日期行一处尾随空格；清理后复检通过，仅保留预期的 LF/CRLF 工作区换行提示。 |
| 项目记忆校验 | 通过。 |
| 应用测试 | 未执行：本次只修改设计和项目记忆文档，不修改可执行代码。 |

2026-08-10 执行真实部署验收暴露的模板列表 WXML 编译修复：

| 命令或边界 | 结果 |
|---|---|
| WXML 组合指令 TDD RED | 按预期失败：新检查精确报告 `template-list/index.wxml` 在同一元素上混用 `wx:else` 和 `wx:for`。 |
| `node tools/test-wxml-structure.mjs` | 通过：2 个测试，0 失败。 |
| `node --test miniprogram/test/business-template-flow.test.js` | 通过：12 个测试，0 失败。 |
| `node --test miniprogram/test/*.test.js` | 通过：102 个测试，0 失败。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：364 个测试，0 失败；仅保留两条既有 npm 用户配置警告。 |
| `npm.cmd test --prefix cloudfunctions/evidenceRetention` | 通过：19 个测试，0 失败；仅保留两条既有 npm 用户配置警告。 |
| 真实微信开发者工具复验 | 未验证：待修复提交后由操作员重新编译。 |

2026-08-10 执行 Task 12 中文部署手册与发布前全量验证：

| 命令或边界 | 结果 |
|---|---|
| 部署资料自检 | 通过：新增手册覆盖计划要求的 9 个集合、唯一索引前置检查、查询索引、两个云函数、七段 Cron、时区核对、停用后启用、回滚和脱敏验收矩阵；README 和稳定架构记忆已同步。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：364 个测试，0 个失败；仅出现两条既有 npm 用户配置警告。 |
| `npm.cmd test --prefix cloudfunctions/evidenceRetention` | 通过：19 个测试，0 个失败。 |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js miniprogram/test/template-flow.test.js miniprogram/test/business-template-flow.test.js miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js` | 通过：102 个测试，0 个失败。 |
| `node tools/test-wxml-structure.mjs` | 通过：1 个测试，0 个失败。 |

真实 CloudBase 备份可读性、唯一值、索引、函数上传、定时触发器、真实文件删除、多账号并发和微信开发者工具矩阵仍未验证。

2026-08-10 执行 Task 11 凭证预约回收、提醒与幂等清理验证：

| 命令或边界 | 结果 |
|---|---|
| `npm.cmd test --prefix cloudfunctions/evidenceRetention` | 通过：19 个测试，0 个失败；覆盖两类预约回收、41 个附件分块、缺失预约锁、上海日历 15/7/1 天提醒、精确到期、孤立保护、清理租约、对象不存在、失败重试和定时入口。仅出现两条既有 npm 用户配置警告。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：364 个测试，0 个失败。 |
| `node tools/test-wxml-structure.mjs` | 通过：1 个测试，0 个失败。 |
| JavaScript 语法、`git diff --check` 与项目记忆校验 | 通过；Git 仅提示预期的 LF/CRLF 工作区换行转换。 |
| 依赖锁 | `npm.cmd ls wx-server-sdk --depth=0` 确认为 `4.0.2`；npm 报告官方依赖树中的 1 个中危和 5 个高危传递依赖，未执行破坏兼容性的强制降级。 |

真实 CloudBase 定时触发器、目标环境索引、真实云文件删除、微信开发者工具和独立代码审查仍未验证。

2026-08-10 执行 Task 10 动态反馈、凭证和冻结修订客户端验证：

| 命令或边界 | 结果 |
|---|---|
| 动态字段 RED/GREEN | 预期失败先复现未读取服务端字段快照、缺少 7 类控件、类型丢失和历史版本缺失；实现后覆盖必填、长度、正则、数值范围与小数位、严格布尔、日期和选项约束。 |
| 凭证 RED/GREEN | 预期失败先复现缺少图片/视频选择、旧永久文件标识预览和直接提交原始文件信息；实现后覆盖多视频、单文件与合计大小、顺序上传、即时登记、失败续传、临时授权预览和顺序下载。 |
| 驳回、关闭与修订 RED/GREEN | 预期失败先复现 URL 携带可伪造业务数据、缺少原因表单和超级管理员页面；实现后覆盖双节点版本、冲突刷新、关闭终态、冻结提示、全局冻结业务检索、脱敏修订历史、专用附件和异步账号切换失败关闭。 |
| `node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js miniprogram/test/business-template-flow.test.js miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | 通过：102 个测试，0 个失败。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：364 个测试，0 个失败；仅出现两条既有 npm 用户配置警告。 |
| `node tools/test-wxml-structure.mjs` | 通过：1 个测试，0 个失败。 |
| JavaScript 语法、`git diff --check` 与项目记忆校验 | 通过；Git 仅提示预期的 LF/CRLF 工作区换行转换。 |

真实 CloudBase 部署、临时地址与云存储真机行为、微信开发者工具交互及独立代码审查仍未验证。Task 11 下一步负责预约回收、孤立文件清理、到期提醒和定时清理。

2026-08-10 执行 Task 9 业务生命周期控制验证：

| 命令或边界 | 结果 |
|---|---|
| 驳回、关闭与审计修订 RED/GREEN | 失败测试先复现缺失能力，随后全部转绿；覆盖权限、相邻节点、双版本、幂等、冻结、前后值、事务中账号变化和附件归属。 |
| 审计修订并发与事务预算 | 通过：41 个附件的两个并发相同请求返回同一结果并只发布一次，乐观事务测试观察到真实冲突与自动重试；105 个附件分块处理且每个事务不超过 100 次文档操作。 |
| 凭证上传与访问 | 通过：未知上传用途在云下载前拒绝；修订附件只允许当前有效超级管理员在冻结业务上传；未发布修订不可访问；独立清理期限从各文件上传时间计算。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：361 个测试，0 个失败；仅出现两条既有 npm 用户配置警告。 |
| Mini Program 显式四文件测试 | 通过：84 个测试，0 个失败。直接传入测试目录的命令不受当前 Windows/Node 组合支持，已改用显式测试文件列表。 |
| `node tools/test-wxml-structure.mjs` | 通过：1 个测试，0 个失败。 |
| JavaScript 语法与 `git diff --check` | 通过；Git 仅提示预期的 LF/CRLF 工作区换行转换。 |

独立代码审查、真实 CloudBase 事务竞争、云函数部署和微信开发者工具验收仍未验证。上述 Task 9 能力已由 Task 10 接入客户端；下一步进入 Task 11 定时提醒与清理工作器。

Executed on 2026-08-10 for Task 8-R atomic actor-facing feedback recovery:

| Command or boundary | Result |
|---|---|
| Initial inter-transaction RED matrix | Failed as expected: 3 tests, 0 passed. Revocation after contention authorization, same-request expiry detection, and submission failure all returned safe errors but still cleared claims and changed reservations through the later actorless recovery transaction. |
| Changed-claim RED | Failed as expected: 1 test, 0 passed. An expired winner was changed to `aborted` after the node had switched to another winner. |
| Feedback repository GREEN | Passed: 36 tests, 0 failures, including five new deterministic recovery regressions, the complete six-variant account/relationship revocation matrix, and the existing 105-evidence transaction-budget case. |
| Feedback service and protected route suites | Passed: 39 tests, 0 failures; `recoverExpiredReservation` remains repository-only. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 298 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| Changed JavaScript syntax and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |
| Formal review round one | `NOT READY`: 0 Critical, 2 Important, 1 Minor. The reviewer reproduced external line/node reservation recovery and identified missing maintenance/revocation matrix assertions; the transaction observer could also roll back a committed callback when the observer itself threw. |
| Exact-reservation RED | Failed as expected: 2 tests, 0 passed. OR contention and same-request expiry both accepted a reservation whose stored line or node was foreign and then completed recovery instead of rejecting without writes. |
| Maintenance relation RED | Failed as expected: 1 test, 0 passed. Internal recovery cleared a node claim even when the node no longer belonged to the reservation line. |
| Post-commit observer RED | Failed as expected: 1 test, 0 passed. An observer exception restored the pre-transaction fake-database snapshot. |
| Review-fix focused GREEN | Passed: 42 tests, 0 failures across the feedback repository and fake transaction observer. Coverage includes exact line/node mismatches with full six-collection snapshots, live/malformed/idempotent maintenance recovery, replacement and foreign-line claims, and all six revocation variants. |
| Review-fix `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 304 tests, 0 failures; npm emitted only the two pre-existing malformed user-config warnings. |
| Review-fix Mini Program and WXML suites | Passed: 84 client tests and 1 WXML structure test, 0 failures. |
| Review-fix JavaScript syntax | Passed for the feedback repository, fake database helper, and new observer regression. |
| Fix-round independent re-review | `READY`: 0 open Critical, Important, or Minor findings. Reviewer reran 81 focused repository/fake/service/route tests, 304 backend tests, 84 client tests, 1 WXML test, syntax, diff, and memory checks; it also independently verified aborting continuation idempotency and the exact external-reservation rejection. |

Real CloudBase transaction contention and automatic retry behavior, deployment, Task 11 worker integration, and WeChat DevTools acceptance remain unverified. Task 8-R is ready for branch integration.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round five:

| Command or boundary | Result |
|---|---|
| Deterministic contention-barrier RED | Failed 1 of 1 as expected with 19 findings: published winners leaked `NODE_ALREADY_COMPLETED`, missing winners leaked `FEEDBACK_COMMIT_IN_PROGRESS`, aborted winners changed the node claim before denial, and one moved-node case surfaced `NOT_FOUND`. |
| Deterministic contention-barrier GREEN | Passed: 1 test, 0 failures. The matrix covers 18 account/relationship mutation by winner-state cases plus five active-contender outcomes. |
| Focused OR-contention and retry regressions | Passed: 5 tests, 0 failures. |
| Complete feedback repository suite | Passed: 31 tests, 0 failures; the 105-evidence claim-chunk boundary remains at or below 100 operations per transaction. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 293 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the repository, regression suite, and injected-wait harness | Passed: 3 files, 0 syntax errors. |

Formal-review round five acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round four:

| Command or boundary | Result |
|---|---|
| Disabled-actor reservation matrix RED | Failed 1 of 1 as expected and reported nine oracle rows: missing/reserved `findPublishedFeedback` calls returned, a missing published lookup returned, reserved changed `beginFeedback` returned `VERSION_CONFLICT`, and published missing-key begin returned `NODE_ALREADY_COMPLETED`. |
| Focused authorization-order GREEN | Passed: 3 tests, 0 failures, covering published lookup, the 39-row reservation existence/status/payload matrix across find/begin/claim/finalize/history, and late claim/finalization. |
| Complete feedback repository suite | Passed: 30 tests, 0 failures; the 105-evidence boundary still kept every measured transaction at or below 100 operations. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 292 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the changed repository and regression suite | Passed: 2 files, 0 syntax errors. |

Formal-review round four acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round three:

| Command or boundary | Result |
|---|---|
| Terminal retention, authorization-order, and history-scope RED | Failed 5 of 5 as expected: terminal ordinary evidence without a strict line deadline remained accessible, disabled changed retries returned `VERSION_CONFLICT`, and new history admitted missing or mismatched scope metadata. |
| Explicit legacy terminal-history RED | Failed 1 of 1 as expected because a terminal legacy row without any effective deadline remained visible. |
| Changed-request-key late-claim RED/GREEN | RED failed 1 of 1 because claim compared the derived feedback ID before actor revalidation; GREEN passed after authorization moved ahead of that conflict. |
| Focused round-three GREEN | Passed 5 of 5 for the terminal status/deadline matrix, public and late published-retry authorization order, exact revision binding, and strict history scope classification. |
| Combined evidence/feedback repository suites | Passed: 60 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 291 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the shared retention classifier and both changed repositories | Passed: 3 files, 0 syntax errors. |

Formal-review round three acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round two:

| Command or boundary | Result |
|---|---|
| Late-path idempotency RED | Failed 2 of 2 as expected with `VERSION_CONFLICT` when publication won before a duplicate reached claim/finalization; a follow-up RED caught published-identity shortcut returns that skipped inactive-actor revalidation. |
| Late-path idempotency GREEN | Passed 2 of 2 for concurrent identical public requests and direct claim/finalization publication races on both next-node and final-line completion; changed payload and inactive-actor checks remained closed. |
| History revision association RED/GREEN | RED exposed 4 included rows instead of one exact revision; GREEN passed the exact-revision case plus legacy/history regressions. |
| Retention-access RED/GREEN | RED exposed ignored line deadlines and malformed retention metadata; GREEN passed ordinary line, unattached orphan, explicit amendment, strict timestamp, and unknown-scope cases. |
| Combined evidence/feedback repository suites | Passed: 58 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 289 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |

Formal-review round two acceptance, real CloudBase deployment, and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-08 for template/node/field Task 8 formal-review fix round one:

| Command or boundary | Result |
|---|---|
| Service retry/input RED | Failed as expected: 5 focused failures proved published lookup happened too late and inherited/missing request properties were accepted. |
| Repository hardening RED | Failed as expected: 16 passed and 6 failed for missing deterministic published lookup, false completion contention, premature retention, stale expired leases, stale legacy binding, and weak cursor validation. |
| Focused service/repository/route suites | Passed: 64 tests, 0 failures. |
| Repository extended concurrency/history/counter suite | Passed: 25 tests, 0 failures; includes 105 evidences within the 100-operation ceiling and 106 history revisions across query pages. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 283 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |

Real CloudBase deployment and WeChat DevTools acceptance remain unverified. Task 11 must implement expired-reservation recovery plus due-line evidence scanning before orphan/retention deletion and verify the required indexes in the target environment.

Executed on 2026-08-07 for template/node/field Task 8 immutable feedback and OR-sign completion:

| Command or boundary | Result |
|---|---|
| Service TDD RED: `node --test cloudfunctions/businessApi/test/feedback-service.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/feedback-service` did not yet exist. |
| Repository TDD RED: `node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js` | Failed as expected with `MODULE_NOT_FOUND` because the repository did not yet exist; the first implementation run passed 6 of 10 tests and exposed deterministic next-node and completion-race gaps. |
| Recovery/cursor TDD RED | Passed 1 of 4 focused tests and failed 3 as expected because eager abort, expired-reservation recovery, and corrupt-cursor cleanup were absent. |
| Transaction-budget and attached-orphan RED checks | Failed as expected before per-transaction operation instrumentation and orphan-expiry clearing/restoration were implemented. |
| Focused Task 8 service/repository/route suites | Passed: 53 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 272 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment and WeChat DevTools acceptance remain unverified. Task 11 must implement scheduled expired-reservation recovery before orphan deletion and verify the `node_feedback`/evidence query indexes in the target environment.

Executed on 2026-08-07 for template/node/field Task 7 review fix round 2:

| Command or boundary | Result |
|---|---|
| Relationship-detector RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 25 tests passed and 2 failed because the shared own-property detector was absent and line-level `watcherUserIds`/`ownerUserId` still fell through to legacy OpenID authorization; registration reached the cloud/persistence path instead of returning `FORBIDDEN`. |
| Repository GREEN: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Passed: 27 tests, 0 failures. Own line and node relationship keys select the account schema, inherited fields are ignored, and unsupported singular or malformed fields grant nothing. |
| Final focused Task 7 suites | Passed: 65 tests, 0 failures. Registration and access deny mixed line schemas before download, persistence, or temporary-URL issuance while pure legacy and explicitly supported account manager/member relationships remain valid. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 247 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |

Task 7 has no open review finding from this fix round. Tasks 10 and 11 still own client upload acceptance and orphan/retention cleanup; real CloudBase and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-07 for template/node/field Task 7 review fix round 1:

| Command or boundary | Result |
|---|---|
| Schema, timestamp, and pre-download limit RED: `node --test cloudfunctions/businessApi/test/evidence-service.test.js cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 23 tests passed and 5 failed because mixed node account fields still allowed legacy OpenID authorization, a legacy manager survived mixed-schema selection, a declared size above 20 MB reached cloud download, malformed false/zero timestamps were treated as absent, and the service delegated the oversized declaration. |
| Access-schema RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 20 tests passed and 5 failed; the added access case proved an evidence node with a present account relationship still inherited legacy line membership. |
| Final focused Task 7 suites | Passed: 63 tests, 0 failures. Mixed registration/access fails before cloud egress or temporary-URL issuance, pure new and pure legacy authorization remains valid, timestamp type/deadline precedence is deterministic, and actual-buffer/mismatch enforcement remains covered. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 245 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |

Task 7 has no open review finding from this fix round. Tasks 10 and 11 still own client upload acceptance and orphan/retention cleanup; real CloudBase and WeChat DevTools acceptance remain unverified.

Executed on 2026-08-07 for template/node/field Task 7 evidence registration and access authorization:

| Command or boundary | Result |
|---|---|
| Policy, service, and repository initial TDD RED commands | Failed as expected with `MODULE_NOT_FOUND` before each planned production module existed. |
| Route TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 26 tests passed and 2 failed because the two evidence actions were not registered and safe evidence codes still returned `UNKNOWN_ACTION`. |
| Oversized-buffer regression RED: `node --test cloudfunctions/businessApi/test/evidence-policy.test.js` | Failed as expected: 5 tests passed and 1 failed because a downloaded buffer above the image limit returned declared-size mismatch instead of `FILE_TOO_LARGE`. |
| Immutable-ID regression RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 18 tests passed and 1 failed because a generated metadata ID collision could overwrite the existing record. |
| Malformed-expiry regression RED: `node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js` | Failed as expected: 18 tests passed and 1 failed because malformed orphan or purge timestamps were treated as unexpired instead of failing closed. |
| Malformed-actor regression RED: `node --test cloudfunctions/businessApi/test/evidence-service.test.js` | Failed as expected: 2 tests passed and 1 failed because numeric actor IDs were string-coerced before delegation. |
| Final focused Task 7 suites | Passed: 56 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 238 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the changed production files, `git diff --check`, and project-memory validation | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, temporary-URL issuance, and WeChat DevTools upload/preview acceptance remain unverified until the later deployment and client tasks run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 6 review fix round 2:

| Command or boundary | Result |
|---|---|
| Prototype-safe fallback RED: `node --test miniprogram/test/business-template-flow.test.js` | Failed as expected: 11 tests passed and 1 failed because `constructor` resolved through `Object.prototype` and produced a function instead of a safe message. The regression also covers `toString`, `__proto__`, an unknown string, and malformed non-string inputs. |
| Focused GREEN: same command | Passed: 12 tests, 0 failures; list cards, selection toasts, create previews, and create error state all receive the normalized fallback string. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 208 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` and `node --check miniprogram/services/templates.js` | Passed: 1 WXML test and the changed production JavaScript syntax check. |

Real CloudBase deployment and WeChat DevTools acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 6 review fix round 1:

| Command or boundary | Result |
|---|---|
| Review-regression RED: `node --test miniprogram/test/business-template-flow.test.js miniprogram/test/account-flow.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Failed as expected: 70 tests passed and 8 failed, reproducing missing component registration, stale legacy-binding authorization, stale dashboard continuation, fabricated pending count, leaked/unmapped availability codes, and inconsistent create-preview messaging. |
| Focused GREEN: same command | Passed: 78 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 84 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 208 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| JavaScript syntax checks for all changed JavaScript and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment and WeChat DevTools acceptance for template availability errors, idempotent create retry, generated-code detail navigation, account-ID and legacy metadata authorization, honest dashboard presentation, and frozen-state presentation remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 6 ordinary template-backed creation and account-aware metadata editing:

| Command or boundary | Result |
|---|---|
| Client TDD RED: `node --test miniprogram/test/business-template-flow.test.js` | Failed as expected: 9 tests failed because the client still exposed demo/manual creation and lacked the protected template-create wrapper, availability states, date validation, retry key, single-flight submission, immutable edit projection, frozen state, and post-await account rechecks. |
| Initial client GREEN: same command | Passed: 9 tests, 0 failures; an intermediate run passed 8 and failed 1 until duplicate authentication redirects after a stale read were suppressed. |
| Protected metadata TDD RED: `node --test cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js miniprogram/test/business-template-flow.test.js` | Failed as expected: 58 tests passed and 14 failed because the protected metadata action and account-ID repository transaction did not exist and the client still targeted the legacy update wrapper. |
| Protected metadata focused GREEN: same command | Passed: 72 tests, 0 failures. |
| `node --test miniprogram/test/*.test.js` | Passed: 80 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 207 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| JavaScript syntax checks for all changed JavaScript and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment and WeChat DevTools acceptance for template selection, idempotent create retry, generated-code detail navigation, account-ID metadata edit, and frozen-state presentation remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 5 review fix round 2:

| Command or boundary | Result |
|---|---|
| Malformed-membership TDD RED: `node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Failed as expected: 14 tests passed and 2 failed because a present `null` account-membership field inherited legacy OpenID access and manager-only account/legacy records were omitted from listing queries. |
| Repository GREEN: same command | Passed: 16 tests, 0 failures. Present malformed account membership values grant no rights, any new-field presence selects account schema, valid hybrid arrays use account IDs, and pure legacy records remain compatible. |
| Focused business service, repository, and route suites | Passed: 51 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 195 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the changed repository and regression test; `git diff --check`; project-memory validator | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, collection/index setup, and concurrent multi-account acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 5 review fix round 1:

| Command or boundary | Result |
|---|---|
| Legacy-create route RED/GREEN: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | RED: 23 passed and 1 failed because the deployed legacy-map factory/guard did not exist; GREEN: 24 tests passed after the manual creator was removed from the default route map. |
| Dual-schema read RED/GREEN: business service, repository, and route suites | RED: 43 passed and 4 failed because list/detail remained on the legacy OpenID path; a second RED passed 46 and failed 1 until the fake query reproduced CloudBase array membership. GREEN: 47 tests passed with account-ID snapshots, OpenID legacy compatibility, authorization, redirect-by-ID detail, and `creating` invisibility. |
| Creator-race RED/GREEN: business repository suite | RED reproduced a creator disabled after route resolution still writing a snapshot; GREEN revalidated fixed `users/<actorId>` before all reservation writes and left no counter, line, node, or audit data. |
| Snapshot-budget RED/GREEN: template service and business repository suites | RED: 24 passed and 3 failed because creation counted neither the creator read nor enable/availability parity. GREEN: 27 tests passed with one shared worst-case predicate and a budget-specific safe message that does not claim 48 nodes exceed the node maximum. |
| Optimistic concurrency RED/GREEN: business repository suite | RED: 13 passed and 1 failed because no overlapping conflict harness existed. GREEN: 14 tests passed; callbacks overlapped, at least one snapshot revision conflict retried, distinct requests received unique codes, and same-key requests converged on one result. |
| Mixed-schema precedence RED/GREEN: business repository suite | RED: 13 passed and 1 failed because a hybrid new record could fall back to legacy OpenID membership; GREEN: account-ID fields take precedence and the unauthorized record is absent. |
| Combined focused Task 5, template repository/service, and account-route suites | Passed: 78 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 193 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for all fix-round JavaScript; `git diff --check`; project-memory validator | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, collection/index setup, and concurrent multi-account acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 5 generated numbering and atomic snapshots:

| Command or boundary | Result |
|---|---|
| Numbering TDD RED: `node --test cloudfunctions/businessApi/test/business-numbering.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/business-numbering` did not yet exist. |
| Service TDD RED: `node --test cloudfunctions/businessApi/test/business-service.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../../lib/business-service` did not yet exist. |
| Repository TDD RED: `node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/cloud-business-repository` did not yet exist. |
| Unique-index fake boundary RED | Failed as expected: 9 passed and 1 failed because the fake CloudBase database did not yet reproduce the real unique business/node code indexes; after adding only those index checks, the repository suite passed 10 tests with 0 failures. |
| Route TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 22 passed and 1 failed because `createBusinessFromTemplate` was not wired and returned `UNKNOWN_ACTION`. |
| Focused GREEN: `node --test cloudfunctions/businessApi/test/business-numbering.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js` | Passed: 21 tests, 0 failures. |
| `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Passed: 23 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 184 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for all changed backend/test JavaScript; `git diff --check`; project-memory validator | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |

Real CloudBase deployment, collection/index setup, and concurrent multi-account acceptance remain unverified until the later deployment task and operator acceptance run against the exact integrated commit.

Executed on 2026-08-07 for template/node/field Task 4 fix round 2:

| Command or boundary | Result |
|---|---|
| Async-continuation TDD RED: `node --test miniprogram/test/template-flow.test.js` | Failed as expected: 11 passed and 5 failed. Pending list, active-account, and definition loads applied stale data after demotion; pending lifecycle/save actions still continued success UI, refresh, or navigation. |
| Focused GREEN: `node --test miniprogram/test/template-flow.test.js` | Passed: 16 tests, 0 failures; all stale continuations fail closed and the node-submit single-flight regression remains green. |
| `node --test miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 71 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --check` for the two changed page files, unchanged node editor, and focused test; `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |
| Project-memory validator | Passed for the Task 4 worktree. |


Executed on 2026-08-07 for template/node/field Task 4 fix round 1:

| Command or boundary | Result |
|---|---|
| Authorization and node-submit TDD RED: `node --test miniprogram/test/template-flow.test.js` | Failed as expected: 9 passed and 2 failed. A demoted user still started `listTemplates`, and two immediate node submissions invoked the owner callback twice. |
| Focused GREEN: `node --test miniprogram/test/template-flow.test.js` | Passed: 11 tests, 0 failures; load/mutation boundaries recheck authority and node commit is single-flight before the owner callback. |
| `node --test miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 66 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node --check` for the three changed page JavaScript files and `git diff --check` | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |
| Independent fix-round review | READY: boundary authorization, post-confirmation checks, synchronous node-submit commitment, disabled/loading UI state, and focused behavioral coverage were confirmed; no Critical or Important findings remain in scope. |


Executed on 2026-08-07 for template/node/field Task 4 administrator template pages:

| Command or boundary | Result |
|---|---|
| Service/registration/list TDD RED: `node --test miniprogram/test/template-flow.test.js` | Failed as expected: 3 tests failed because the template client service, three registered pages, dashboard gate, and protected list page did not exist. |
| Service/registration/list GREEN: same focused suite | Passed: 3 tests, 0 failures. |
| Editor TDD RED: same focused suite | Failed as expected: 3 passed and 4 failed because the template and node/field editor pages did not exist. |
| Editor GREEN | Passed: 7 tests, 0 failures, covering active-account pagination, stable keys and reorder, non-empty nodes, limit rendering, stale refresh, read-only behavior, and previous-page transfer. |
| WXML compatibility RED/GREEN | RED: 7 passed and 1 failed on unsupported array-method expressions; GREEN: 8 tests, 0 failures after precomputing view state. |
| Enabled-definition view RED/GREEN | RED: 7 passed and 1 failed because read-only nodes could not be opened for inspection; GREEN: 8 tests, 0 failures with navigation retained and mutations still blocked. |
| Review-fix RED/GREEN | RED: 8 passed and 1 failed because unsaved nodes had no unique client key; GREEN: 9 tests, 0 failures after unique UI keys were preserved through reorder and stripped from API definitions. |
| `node --test miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 64 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| Changed JavaScript syntax checks | Passed for the template service and all three administrator template pages. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| Independent review and focused re-review | Initial review found one Important unsaved-row WXML key defect; focused re-review confirmed unique client-only keys are preserved and stripped from API payloads. No Critical or Important findings remain. |


Executed on 2026-08-07 for template/node/field Task 3 fix round 1:

| Command or boundary | Result |
|---|---|
| Error-trust TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 21 passed and 1 failed because an unmarked infrastructure `NOT_FOUND` retained its raw message and code. |
| Error-trust GREEN: same route suite | Passed: 22 tests, 0 failures; protected authentication codes remained compatible. |
| Transactional-assignee TDD RED: `node --test cloudfunctions/businessApi/test/cloud-template-repository.test.js` | Failed as expected: 9 passed and 3 failed because creation, update, and enablement did not revalidate active assignee documents in their write transactions. |
| Transactional-assignee GREEN plus account regression: service, template repository, and cloud-account repository suites | Passed: 51 tests, 0 failures. |
| Limit-contract TDD RED: final Task 3 focused suites | Failed as expected: 42 passed and 4 failed because limit violations still used `TEMPLATE_INVALID` and the route did not allow the new dedicated code. |
| Enable-limit review RED: `node --test cloudfunctions/businessApi/test/template-service.test.js` | Failed as expected: 11 passed and 1 failed because a legacy 49-node disabled template could still be enabled. |
| Final Task 3 focused suites | Passed: 47 tests, 0 failures. |
| `node --test cloudfunctions/businessApi/test/cloud-account-repository.test.js` | Passed: 28 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 162 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax, `git diff --check`, and project-memory validation | Passed; Git emitted only expected LF-to-CRLF working-copy warnings. |
| Read-only fix review and re-review | Passed after the enable-path limit regression and private `Symbol` hardening; no Critical or Important code findings remain. |

Executed on 2026-08-07 for template/node/field Task 3 template persistence and protected routes:

| Command or boundary | Result |
|---|---|
| Service TDD RED: `node --test cloudfunctions/businessApi/test/template-service.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/template-service` did not yet exist. |
| Repository TDD RED: `node --test cloudfunctions/businessApi/test/cloud-template-repository.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/cloud-template-repository` did not yet exist. |
| Route TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 2 failures because default template routes were not wired and template errors returned `UNKNOWN_ACTION`. |
| Review-regression RED: focused Task 3 suites | Failed as expected: 3 failures exposed the 100-document query window, missing transaction-node cap, and unsanitized unknown error response. |
| Transaction-boundary RED: focused service/repository suites | Failed as expected: 2 failures exposed the 49-to-49 replacement's 101-operation cost. |
| Final focused Task 3 suites | Passed: 41 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 156 tests, 0 failures; npm emitted the two pre-existing malformed user-config warnings. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| Read-only formal review and fix re-review | Passed; no Critical or Important findings remain. |

Executed on 2026-08-07 for template/node/field Task 2 fix round 1 safe regular-expression policy:

| Command or boundary | Result |
|---|---|
| Regression TDD RED: `node --test cloudfunctions/businessApi/test/field-domain.test.js` | Failed as expected: nested quantified pattern `(a+)+$` was accepted, so the regression assertion reported a missing expected exception. |
| Focused field GREEN: `node --test cloudfunctions/businessApi/test/field-domain.test.js` | Passed: 6 tests, 0 failures. |
| Focused field and template suites: `node --test cloudfunctions/businessApi/test/field-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js` | Passed: 10 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 133 tests, 0 failures; npm emitted two pre-existing malformed user-config warnings. |

Executed on 2026-08-07 for template/node/field Task 2 domain policies:

| Command or boundary | Result |
|---|---|
| Field-policy TDD RED: `node --test cloudfunctions/businessApi/test/field-domain.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/field-domain` did not yet exist. |
| Template-policy TDD RED: `node --test cloudfunctions/businessApi/test/template-domain.test.js` | Failed as expected with `MODULE_NOT_FOUND` because `../lib/template-domain` did not yet exist. |
| Focused field and template suites: `node --test cloudfunctions/businessApi/test/field-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js` | Passed: 9 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 132 tests, 0 failures; npm emitted two pre-existing malformed user-config warnings. |

Executed on 2026-08-07 for template/node/field Task 1 protected-route seam:

| Command or boundary | Result |
|---|---|
| Focused route-seam TDD RED: `node --test cloudfunctions/businessApi/test/account-routes.test.js` | Failed as expected: 2 failures because `createBusinessApi` did not recognize injected protected routes; the authenticated route returned `UNKNOWN_ACTION`, and the unauthenticated route did not reach `UNAUTHORIZED`. |
| Focused route suite after implementation | Passed: 18 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 123 tests, 0 failures; npm emitted two pre-existing malformed user-config warnings. |

Executed on 2026-08-07 for the template/node/field implementation plan:

| Command or boundary | Result |
|---|---|
| Requirements-to-task review | Passed; the 12 tasks cover authenticated routing, template/field policy, persistence, administrator UI, generated numbering and snapshots, ordinary creation, evidence validation/access, immutable feedback, rejection/freeze/amendment, client flows, retention worker, and deployment acceptance. |
| Unfinished-marker and interface-consistency scan | Passed; no unfinished markers were found, all commit steps use explicit paths, and the snapshot-copy example uses a defined operation. |
| `git diff --check` | Passed; line-ending warning only. |
| Project-memory validation | Passed. |
| Application test suites | Not rerun because this planning step changes documentation only; no executable code changed. |

Executed on 2026-08-07 for the approved template/node/field design documentation:

| Command or boundary | Result |
|---|---|
| Unfinished-marker, conflict-marker, and rule-consistency review | Passed; no unfinished markers were found, and numbering overflow plus logical-delete retention boundaries were made explicit during self-review. |
| `git diff --check` | Passed; line-ending warnings only. |
| Project-memory validation | Passed. |
| Application test suites | Not rerun because this change contains design and memory documentation only; no executable code changed. |

Executed on 2026-08-07 before publishing the integrated `main` branch:

| Command or boundary | Result |
|---|---|
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures; the two pre-existing malformed npm user-config warnings remain. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 55 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `git diff --check` and project-memory validation | Passed on the clean `main` tree. |
| GitHub publication | `origin/main` was fetched, confirmed as an ancestor of local `main`, and fast-forwarded from `22a78f3` to `b314785` without force. |

Executed on 2026-08-07 after fast-forwarding local `main` to `f39c89e`:

| Command or boundary | Result |
|---|---|
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures; the two pre-existing malformed npm user-config warnings remain. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 55 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax, `git diff --check`, and project-memory validation | Passed on the merged `main` tree. |

Executed on 2026-08-07 for the super-administrator recovery page at `8e62b98` and `f38f26d`:

| Command or boundary | Result |
|---|---|
| Task 1 TDD RED | Two expected failures: the recovery service method and guarded login-page navigation did not exist. |
| Task 2 TDD RED | Seven expected failures: the recovery page and its security boundary did not exist; the pre-existing login-entry test remained green. |
| Focused recovery tests | Passed: 8 tests, 0 failures. |
| JavaScript syntax checks for the account service, login page, and recovery page | Passed: 3 files, 0 syntax errors. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures. npm also emitted two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 55 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| Recovery sensitive-boundary scan | Passed: exactly 3 masked inputs and 0 forbidden session, storage, log, or sensitive-dataset matches. |
| `git diff --check` and project-memory validation | Passed; line-ending warnings only. |
| Scope inspection | Recovery commits changed only the 10 planned Mini Program and test files; the pre-existing deployment-manual edit remains unstaged and untouched. |

Manual recovery acceptance on 2026-08-07:

| Check | Result |
|---|---|
| Offline recovery rotation | Operator-confirmed that a new recovery value was stored safely, both digest locations were updated in order, the consumed marker alone was reset, and the local helper/clipboard were cleared. No value was recorded. |
| Mini Program recovery and forced password change | Operator-confirmed that the guarded recovery form opened, handed off to forced password change, and entered the dashboard. |
| Redacted CloudBase state | Operator-confirmed active-super-admin count one, consumed recovery state, unlocked permanent credential, restored user/binding state, and both recovery and first-login audit outcomes. |
| Persistent-logout restart completion | Operator-confirmed that recompilation after successful password completion automatically restored the bound session and dashboard. |

Executed on 2026-08-07 for persistent logout at `c4c5fea` and `b0e9cbf`:

| Command or boundary | Result |
|---|---|
| Preference TDD RED | Failed as expected because the utility and application methods did not exist. |
| Account-page TDD RED | Four expected failures reproduced automatic restoration and the three missing page-side effects. |
| JavaScript syntax checks for the utility, app, profile, login, and password-change pages | Passed: 5 files, 0 syntax errors. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures. npm also emitted two pre-existing malformed user-config warnings. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 47 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `git diff --check` and project-memory validation | Passed; line-ending warnings only. |
| Storage-boundary scan | Production synchronous storage calls exist only in `miniprogram/utils/manual-login.js`; the sole written value is boolean `true`. |

WeChat DevTools restart acceptance for the exact persistent-logout commits remains unverified.

Manual operator acceptance on 2026-08-07:

| Check | Result |
|---|---|
| Updated `businessApi` deployment and environment configuration | Operator-confirmed successful; the required environment variable remained effective. |
| Guarded initialization, forced password change, and dashboard entry | Operator-confirmed successful in WeChat DevTools. |
| Redacted guard, user, credential, binding, and audit outcomes | Operator-confirmed correct without recording sensitive values. |
| Historical pre-fix explicit profile logout | Failed as expected before the correction: the login page immediately restored the bound account. Root cause is recorded in the persistent-logout design. |
| Corrected explicit logout and restart sequence | Operator-confirmed passed: logout and recompilation stayed on login; successful password completion then restored ordinary automatic login on the next recompilation. |

Executed on 2026-08-07 for the CloudBase missing-document fix at `0f16140` and reviewed boundary correction at `5fc1957`:

| Command | Result |
|---|---|
| Focused regression test before the production fix | RED as expected: 1 failure with the explicit CloudBase missing-document error. |
| Focused regression test after the production fix | GREEN: 1 test, 0 failures; a non-missing permission failure remained visible. |
| Collection-error boundary RED/GREEN | RED reproduced an incorrectly swallowed collection error; GREEN preserved collection, permission, network, and timeout failures while supporting structured and text-form document-not-found results. |
| Repository and account-route tests | Passed: 44 tests, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 121 tests, 0 failures. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 43 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax, `git diff --check`, and project-memory validation | Passed. |
| Independent review after boundary correction | Passed: no remaining Critical or Important findings. |

Uploading the updated `businessApi`, recompiling the Mini Program, and confirming the initialization entry in the real CloudBase environment remain unverified.

Executed on 2026-08-07 for the guarded initialization-page implementation at `9b8b034` plus the documentation closeout working tree:

| Command | Result |
|---|---|
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 43 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks for the account service, login page, and initialization page | Passed. |
| `git diff --check` | Passed (line-ending warnings only). |
| Sensitive-fixture scan outside tests and the implementation plan | Passed: no matches. |
| Project-memory validator | Passed. |
| Independent implementation and staged-candidate review | Passed after date correction: no remaining Critical or Important findings. |

CloudBase initialization, automatic-login handoff, forced password change, and redacted post-initialization database checks remain unverified manual acceptance items.

Executed on 2026-08-06 for commit `db8dbf3`:

| Command | Result |
|---|---|
| `npm.cmd ci --ignore-scripts` | Passed; installed the locked 4.0.2 SDK tree. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| JavaScript syntax checks | Passed. |
| `git diff --check` | Passed. |
| Independent formal review | READY; no remaining Critical, Important, or Minor code findings. |

Executed on 2026-08-06 for Task 7 completed at `7feac41`:

| Command | Result |
|---|---|
| `npm.cmd ci --ignore-scripts --prefix cloudfunctions/businessApi` | Unverified: local npm cache/filesystem returned `EPERM`; no dependency or source change was made. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 30 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `git diff --check` | Passed (line-ending warnings only). |

Cloud deployment, database migration, index creation, recovery configuration, and WeChat DevTools operator acceptance remain unverified until executed against the exact commit in the target environment.

Formal-review round one for Task 7 reran `git diff --check` and the project-memory validator after documentation-only corrections; both passed. Source and client test suites were not rerun because the review changed neither code nor verification commands.

Executed on 2026-08-06 in the Task 5 worktree based on `9ed0422`:

| Command | Result |
|---|---|
| `node --test miniprogram/test/account-flow.test.js` | Passed: 14 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| JavaScript syntax checks for changed client files | Passed. |

Executed on 2026-08-06 in the Task 6 worktree based on `d1482c8`:

| Command | Result |
|---|---|
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 26 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| JavaScript syntax checks for the Task 6 service, pages, and focused test | Passed. |
| `git diff --check` | Passed. |

Executed on 2026-08-06 for Task 6 formal-review fix round one based on `345a972`:

| Command | Result |
|---|---|
| `node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js` | Passed: 30 tests, 0 failures. |
| `node tools/test-wxml-structure.mjs` | Passed: 1 test, 0 failures. |
| `npm.cmd test --prefix cloudfunctions/businessApi` | Passed: 120 tests, 0 failures. |
| JavaScript syntax checks for the changed administrator pages and focused test | Passed. |
| `git diff --check` | Passed. |

## Blockers

- Administrator password reset manual acceptance is deferred because the current editable reset modal cannot mask the temporary password. The backend reset path remains automated-test covered; the client must move password entry to masked fields before manual use.
- First-login binding, unbinding, rebinding with another identity, and ordinary-user route denial remain unverified because they require a second WeChat identity. These do not block the next core feature phase.
- 当前工作树的 `project.config.json` 使用已提交的 `trial` 基础库设置，且没有未提交的操作员改动。真实发布前必须在微信开发者工具中明确选择目标基础库版本并单独记录，不把工具自动改写混入功能提交。
- `npm audit` reports six transitive findings (one moderate, five high) through the official `wx-server-sdk@4.0.2` dependency tree. npm proposes a major downgrade to 2.5.3; it was not applied because it would invalidate the reviewed transaction behavior. Track the upstream SDK and reassess on a reviewed release.
- Enterprise WeChat production identifiers and secret remain intentionally unavailable; strong-message delivery is deferred.

## Next actions

1. 由目标环境操作员按 `docs/deployment/template-node-fields-setup.md` 从备份可读性开始，依次完成唯一值检查、索引、`businessApi` 和 `evidenceRetention` 上传；每日触发器先保持停用。
2. 使用隔离测试业务、测试账号和无敏感测试文件完成手册验收矩阵，确认重复调用幂等后再启用每日触发器；逐项把未验证结果更新为通过或失败。
3. 继续节点独立审核流程 Task 5，把新版处理/审核快照和首节点处理截止状态接入业务创建；随后再实现审核轮次与提醒。
4. 将管理员重置密码的可编辑弹窗替换为掩码输入，再完成需要第二个微信身份的绑定/解绑验收。
