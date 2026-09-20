# Project Memory

Last stable-fact update: 2026-09-18 (Asia/Shanghai; strict product option linkage)

## Product

This is an internal business-progress management WeChat Mini Program. Super administrators control accounts, templates, node ownership, and system rules. Authorized users create business lines from enabled templates, responsible users submit node progress and evidence, and associated users inspect progress and evidence history.

Approved V1 rules include:

- 用户界面统一使用“售后”作为产品术语，包括页面标题、按钮、状态提示、通知、公开分享和运营看板；内部英文标识、集合名、字段名、接口名、路由及既有数据结构继续保持 `business*` 不变，避免无收益的数据迁移和兼容风险。
- Account/password login with first-login password change, one-to-one WeChat identity binding, lockout, administrator reset, and at least one active super administrator.
- Template snapshots, sequential nodes, multiple responsible accounts with first-completion-wins (`OR` signing), logical deletion, audit history, and optimistic/concurrent flow protection.
- Templates contain stable node and dynamic-field identifiers. Enabled workflow definitions are read-only and must be disabled before editing; the independent card display configuration remains editable by an active super administrator without disabling the workflow. New business lines receive server-generated globally unique codes, and instance nodes receive immutable codes derived from the business code.
- 活动超级管理员可复制已保存模板为独立草稿，启用中的源模板无需停用。副本生成全新文档/节点/字段标识并同步重建联动、流程和卡片展示引用，不复制历史售后、凭证或统计；同一事务校验当前源定义、展示配置、账号和参与人，超出现有100次操作预算时明确拒绝。未保存编辑不纳入复制；详见 ADR-0020 与发布验收文档 `docs/deployment/template-copy-acceptance.md`，实际部署状态以 STATUS 为准。
- 普通用户从模板创建售后时，售后线名称由服务端在编号分配事务中固定生成为“模板名称-售后线编号”，客户端名称与计划日期输入均不参与创建；普通元数据编辑只允许修改说明。历史售后已有名称和计划日期保持原值并只读展示，不做迁移或清空；售后列表的日期筛选统一按售后创建日期解释。
- Node feedback is revisioned and immutable. New review-workflow nodes separate non-overlapping processors and reviewers: processors save progress or submit for review, while independent reviewers use OR/ALL votes to approve or reject; new nodes cannot use the legacy direct-complete or legacy-reject path. Old business nodes retain controlled feedback-read compatibility and never receive fabricated review history.
- 新版模板的任意节点都可明确配置为空审核人；空审核节点仍属于 `review` 工作流，但由当前处理人在完成字段与凭证校验后直接完成，不创建审核轮次或投票。至少包含两个节点的模板最多有一个位于末尾的 `optional_tail` 节点；它在售后创建时完整固化为 `awaiting_decision`，但售后头保持 `optionalTailState: none`，最后必经节点完成后才由候选处理人以首个成功事务进入待决定并选择开启或跳过。待决定阶段以短生命周期 `decisionReminderStatus: pending` 与休眠追加节点隔离，决定成功即移除；待决定耗时与节点处理耗时分离，只有开启时才启动处理计时，只有真正跳过或完成追加节点时才冻结售后并开始 60 天凭证保留。决定统计使用独立 `decisionAnalytics*` 来源，不等待追加节点处理终态；待办、通知、工作小时提醒、日历补算、检索和固定分享均复用同一完成分类，详细决策见 `docs/memory/decisions/ADR-0015-optional-tail-and-reviewerless-node-transitions.md`。
- 已接受下一代流程模式版本 2 设计：模板改用唯一入口的单线有向无环路由，任意节点可选择结束、默认后续、单选分支或人工决定；分支可继续嵌套并在互斥路线后重新汇合，但同一售后始终只有一个活动节点。单选字段支持单一父字段、多层级联的显示条件与候选项切换；发起人通过独立标记加入固定处理人而不再强制唯一，解析后的处理人与审核人仍不得重叠。隔离验收后将受控重置旧模板与全部业务数据，同时保留账号、安全配置、编号连续性和脱敏审计；任何不可恢复删除仍须单独核对并确认。完整设计见 `docs/superpowers/specs/2026-09-03-branching-workflow-and-conditional-fields-design.md` 与 `docs/memory/decisions/ADR-0016-general-branch-routing-and-conditional-fields.md`。
- 新审核轮次会把当前处理轮最新已发布反馈的处理说明保存为不可变 `processingComment` 快照，并把该快照纳入审核草稿摘要和幂等校验；审核详情只读取轮次快照，不回查可变化的反馈。修复前的旧轮次缺少该字段时仅显示固定占位“暂无处理说明”，损坏、访问器或继承值均失败关闭。
- Completed, cancelled, and closed business lines freeze their structured data. Only a super administrator may append a reasoned correction with before/after values; ordinary update paths remain blocked.
- China workday calculations from a locally cached holiday adapter; default working hours are 09:00–20:00 without lunch break. Default node SLA is two workdays (22 work hours), and template nodes may override it.
- In-app notifications as the fallback channel and a future Enterprise WeChat self-built application as the strong-reminder channel. Unfinished nodes are reminded every accumulated work hour during working time.
- 需要持久化的处理与审核累计工作时长采用“已经完整经过的工作分钟”：权威工作区间的秒级结果向下取整，保留精确时间戳但不通过四舍五入提前累计分钟或判定逾期；提醒工作器继续使用精确秒级阈值。
- 同一处理轮的当前有效凭证合计上限为 120 MiB，不另设业务层文件数量上限；单个文件仍受该合计上限的物理约束。系统支持 JPG/JPEG/PNG/WebP/HEIC/HEIF、PDF、MP4/MOV/M4V，并按真实对象大小、文件签名和 ISO-BMFF 容器品牌失败关闭，不信任客户端 MIME、扩展名或声明大小。可选凭证的严格空白名单表示允许全部十种系统格式；必填凭证仍要求非空白名单，任何损坏、继承、访问器、重复或不支持的策略值失败关闭。
- 节点凭证在 iOS/Android/HarmonyOS 继续使用 `chooseMedia` 相册/相机媒体选择；Mac/Windows 图片入口保留 `chooseImage` 原图 album 来源。Mac 本机视频在运行时支持 `chooseMedia` 且基础库不低于 2.25.0 时，使用该接口的 video、album、original 选项；Windows 及未满足能力条件的旧 Mac 保留不压缩的 `chooseVideo`。不得新增或自动回退到聊天媒体来源，不能把 `chooseMessageFile` 当作本机媒体选择器。PDF 仍使用原会话文件入口，不能宣称已支持所有端本机 PDF。媒体 API 平台支持与实际系统目录窗口是两个验证层级，Mac/Windows 真机选择及上传须独立验收；各端选中后进入同一 120 MiB 合计、签名、容器和节点白名单校验。客户端通过服务端生成的精确对象键和 15 分钟单对象 STS 临时凭证直传 COS，高级 SDK 自动选择简单或分块上传，页面最多并发 3 个文件并仅重试可恢复网络错误。慢速上传接近凭据到期或收到凭据过期错误时，只能在重新校验当前账号、节点、版本、角色和原预约令牌后刷新原 `evidenceId` 与原对象键的短期授权；并发刷新单飞，进度不倒退，不另建凭证。服务端 `headObject` 与有界头部核验成功后才把隐藏的 `uploading` 预约转换为 `available`。长期 COS Secret 只存在于云函数环境变量，客户端、日志、Git 和项目记忆均不得出现。
- JPG/JPEG 上传预约前只读最多 64 字节；仅确认完整 PNG 签名时把上传名称规范化为同名 `.png`，不修改本机文件、文件路径或内容，也不重编码。真正 JPEG 保持名称，其他签名不做格式伪装；最终仍由服务端按真实格式、节点白名单与原权限核验。登记后页面使用服务端权威文件名。不能允许仅准入 JPG 的节点通过这条路径接收 PNG。
- Evidence objects remain available for 60 calendar days after a business line is completed, cancelled, or closed. A scheduled idempotent cleanup then removes only the cloud file object while preserving metadata, hashes, feedback revisions, and audit history.
- 第二批次采用短期能力令牌分享已完成节点的固定结果快照：发送者通过微信原生分享面板选择好友或群，接收者无需登录或业务成员权限，快照最长有效七个二十四小时；公开投影只含固化字段、处理说明和短期凭证地址，不暴露永久文件编号、身份值或内部预约数据。详细决策见 `docs/memory/decisions/ADR-0008-public-node-share-capabilities.md`。
- 概览页的“待我处理”由服务端权威查询提供；新版审核节点按当前处理账号关系查询，纯旧节点只在没有任何新账号关系标记时兼容 OpenID。结果返回前重新校验活动账号、业务、当前节点和处理关系；超过 2,000 条安全扫描边界时只返回诚实下界。
- 原运营基础 CSV 继续由活动超级管理员导出，保留业务/节点编号、名称、参与人显示名、工作流、轮次、截止时间和累计/逾期分钟等23列；按售后创建日期与状态筛选，电子表格公式前缀（包括前导空白之后）作为文本保护。
- 新增独立最终节点字段统计：活动超级管理员看全部匹配售后，普通活动账号只聚合当前有权售后；完成节点最终有效结果按上海完成日期统计，单选/多选分别计选项次数，0与false不是空值。仅选项结果进入 operations_field_snapshots，看板不加载其他字段内容；管理员完整报告读取权威来源，单一 CSV 追加字段明细与选项统计，保留旧运营基础行及其日期口径。已完成结果必须有精确反馈/审核轮次和实际路线证明，缺口不能当0或导出完整文件。operationsAnalytics 独立40候选/5秒协作预算恢复，原工时阶段和Timer不变；流程成功后的派生失败不能反转业务成功。详见 ADR-0019；发布及真机结果以 STATUS 为准。
- CSV 客户端使用同一个按钮完成两阶段操作：先“导出 CSV”生成本地文件，再“发送 CSV”在新的点击栈内调用微信文件分享；生成进度、失败、取消及结果等待超时分别反馈，完整筛选或登录会话失效后不复用旧文件引用。新增字段列采用独立完整报告接口，旧基础导出接口保持兼容。
- 每个新版模板节点可分别选择固定候选账号或“业务发起人作为本节点唯一处理人/唯一审核人”。发起人模式不保存占位账号，业务创建事务把当前活动发起人和安全显示名固化为该节点唯一角色快照；同一节点解析后的处理人与审核人不得重叠，固定处理人恰为实际发起人时也拒绝创建，不自动改写模板。模板头以 SHA-256 `definitionDigest` 和按节点顺序排列的 `definitionNodeIds` 共同绑定已发布定义；发起人审核模板读取和业务创建必须验证两者。CloudBase 事务只支持固定文档读取，因此创建预约事务严格比较服务预读与当前模板头的权威节点编号清单，再逐个固定读取清单节点并重算摘要；模板服务的增删、改写会原子更新模板头并使在途创建失败关闭，未进入头清单的旁路额外文档只视为未发布孤立记录且不会进入业务快照，普通定义读取仍会报告集合损坏。业务创建预算按“源节点读取 + 业务节点写入 + 去重参与账号读取 + 固定操作”计算并保持不超过 100 次。创建预约、发布和已发布幂等返回均重新校验当前活动创建人及严格业务关系。业务节点的参与人显示名是创建时不可变快照，审核轮次与历史详情不得回查当前账号姓名覆盖历史；旧业务缺快照只使用固定安全占位。旧模板缺审核人来源时按固定账号兼容，旧业务不迁移；跨节点参与不受影响。每个处理轮只把工时归属实际提交审核账号，每张审核票只把响应工时归属实际投票账号；未提交者和未投票者不产生个人工时。日历缺失时保存不可变区间并由独立游标补算，旧记录缺字段只显示“历史未记录”。活动超级管理员可在运营看板查看这些逐轮安全快照；不提供人员排名，CSV 结构保持不变。详细决策见 `docs/memory/decisions/ADR-0009-initiator-processor-and-personal-worktime-snapshots.md` 与 `docs/memory/decisions/ADR-0011-initiator-reviewer-assignment.md`。
- 运营历史统计按模板及稳定节点比较处理/审核工作分钟，并提供日、周、月趋势、模板版本、业务状态、业务、稳定节点和匿名参与人筛选。所有活动账号可查看不含业务明细的全局汇总；普通账号下钻时逐条复核当前业务关系，超级管理员可查看全部明细并保留原当前指标和安全 CSV。节点处理累计全部处理轮，节点审核累计全部终态审核轮，个人投票响应只进入轮次明细；待日历补算和历史未记录不会伪装成零值。派生事实与每日汇总由只信任平台 Timer 的 `operationsAnalytics` 幂等生成，详见 `docs/memory/decisions/ADR-0010-operations-analytics-materialized-facts.md`。
- 售后列表支持对当前有效最新快照执行授权全文检索：覆盖售后和节点元数据、动态字段名称与值、处理说明、当前审核意见及凭证文件名，不索引旧驳回轮、被替换修订、永久云路径或内部身份/预约数据。检索使用独立 `businessSearch`、完整版本代际和 HMAC 倒排令牌；活动超级管理员可检索全部非创建中、非已删除售后，普通活动账号只限原有关系范围，每条候选返回前再次授权。历史回填、失败恢复和旧代清理共享单轮最多 40 条原始扫描预算并使用独立持久 keyset 游标；默认触发器保持空。详细决策见 `docs/memory/decisions/ADR-0012-authorized-after-sales-content-search.md`。
- 当前可编辑节点将提供用户主动触发的文本智能识别：处理人粘贴最多 8,000 字符的文本后，`businessApi` 重新授权并使用五分钟、单次消费、绑定账号/节点版本/字段定义摘要/原文摘要的一次性内部票据调用独立 `nodeTextParser`。解析工作器优先在内存中识别具有明确冒号边界的“字段名：字段值”结构；字段名必须唯一对应当前定义，日期与精确选项必须可严格规范化，命中任一安全候选即立即返回部分结果，不等待模型。仅当没有安全结构化候选时，工作器才调用目标 CloudBase AI+ 已启用的 `hy3` 托管模型，并允许部署方通过仅服务端可见的 `NODE_TEXT_PARSE_MODEL` 覆盖。两条路径都只接收原文和当前节点字段定义，原文和结果不持久化、不记录日志，候选必须经用户预览确认且已有值默认不覆盖；单选/多选只能匹配既有选项，AI 路径精确匹配优先、模糊语义匹配阈值为 0.5。同账号限流为单飞、每分钟最多 10 次、每个上海自然日默认 300 次；每日额度只允许服务端在 `1..1000` 范围内配置，损坏配置失败关闭。详细决策见 `docs/memory/decisions/ADR-0013-ai-assisted-current-node-text-fill.md`。

The complete baseline requirements are in `docs/superpowers/specs/2026-08-05-business-progress-v1-design.md`. The approved template, node, field, rejection, freeze, numbering, and evidence-retention refinement is in `docs/superpowers/specs/2026-08-07-template-node-fields-design.md`. Account-administration execution steps are in `docs/superpowers/plans/2026-08-05-account-admin.md`.

## Architecture

- 商品严格联动采用模板首字段内置八列索引组合表及共享纯解析器，保留原单父条件兼容；新规则按整组保存、复制和校验，旧客户端不得无声移除。规则只保存于模板和历史实例自己的定义，当前有效值继续供统计/CSV/检索/卡片/分享消费；矩阵不进入公开投影或重复 setData。预算、语义摘要和发布顺序见 ADR-0021，实际完成状态以 STATUS 为准。

- 首页和售后列表共用 `miniprogram/utils/business-card.js` 与 `miniprogram/templates/business-card.wxml/.wxss`，保留编号、状态、进度/路径和检索命中交互。模板编辑页的展示配置使用独立已保存定义快照、修订及请求状态，不隐式提交流程草稿；新定义须保存后再配置。字段缓存仅在内存保留，账号/角色变更与权限失效清除旧字段；返回列表刷新已提交条件，不自动提交未确认检索输入。

- 售后卡片后端使用独立的模板 `cardDisplay` 修订与售后头 `cardSummary` 派生缓存：按稳定节点/字段标识选择最多4项当前有效字段，已有实例沿用自身字段类型/标签，输出每项最多80个Unicode码点；展示修订不改变流程定义版本，摘要不改变业务版本、更新时间、排序或检索状态。三个首页/列表读入口在筛选、授权、分页后统一装配；十一种现有业务写入口成功后有界刷新，派生失败不反转权威成功。每次请求独立会话去重、最多4路并发，缓存命中仍重验当前账号和业务关系；超级管理员全局列表非成员保持固定信息可见但不获得详情字段权限。决策与发布边界见 `docs/memory/decisions/ADR-0018-template-configurable-card-summary.md`，当前部署/客户端状态见 `docs/memory/STATUS.md`。

- 检索漏索引恢复同时支持正常关键词请求驱动：每次最多扫描40条售后头、重建2条当前用户有权且符合筛选的售后；加密认证游标绑定账号、角色、条件和有效期，客户端每批最多20次请求后只允许显式继续。`searchSchemaVersion: 2` 区分完整当前格式与需重新生成的旧代；恢复不改变业务版本/完成状态，不执行清理或开启Timer，失败结果明确标为不完整。规则见 `docs/memory/decisions/ADR-0017-request-driven-search-recovery.md`。

- Client: native WeChat Mini Program using JavaScript, WXML, and WXSS under `miniprogram/`.
- Client authentication starts at `pages/login/index`; an uninitialized system navigates to the guarded `pages/admin-initialize/index` page, which calls the cloud function from the Mini Program runtime and automatically hands successful initialization to forced password change. `miniprogram/app.js` owns the in-memory current-user state and the reset helper. First-login challenges remain memory-only until password change completes. Explicit logout persists only a non-sensitive boolean manual-login preference; it suppresses binding-based automatic restoration until successful password authentication clears it.
- Backend: Tencent CloudBase Node.js cloud functions, cloud database, and cloud storage.
- Current entry point: `cloudfunctions/businessApi/index.js`, with pure domain helpers under `cloudfunctions/businessApi/lib/`.
- Target modular shape: retain a unified API entry for ordinary domain calls, extract account/template/business/evidence/notification modules, and use separate scheduled functions for calendar synchronization, hourly reminders, and orphan-file cleanup.
- External holiday source is isolated behind an adapter. The approved endpoint is `https://holiday.ailcc.com/api/holiday/allyear/{year}`; production use requires renewed terms and availability verification.
- `calendarSync` 使用 Node.js 内置 HTTPS 客户端，把每个完整验证的 AILCC 年份作为具有唯一编号的不可变代际写入 `work_calendar_entries`；只有全年每个自然日均写入成功后，`work_calendar_years` 才原子切换活动代际。过期工作器只能继续写自己的未选中代际，不能覆盖后继工作器。同版本跳过前会以每页最多 100 条、每年最多四页的方式核对所有日期和工作日标记；该查询依赖 `work_calendar_entries(sourceYear ASC, generationId ASC, date ASC)` 组合索引。`calendarSync`、`workflowReminder` 与 `evidenceRetention` 的计划入口只信任平台注入的服务端环境变量 `process.env.TRIGGER_SRC === 'timer'`，拒绝非空客户端 `OPENID`，并只使用服务端状态与时钟；事件载荷和 `getWXContext().TRIGGER_SRC` 均不能授权。人工日历同步只能通过已认证超级管理员接口签发并由服务端一次性消费短期票据；`evidenceRetention` 不提供人工 API，破坏性验收必须使用单独批准的一次性 Timer。持久边界见 `docs/memory/decisions/ADR-0007-trusted-timer-source.md`。
- Enterprise WeChat sending must remain behind an adapter and disabled until approved secure configuration is supplied.

Primary collections include `users`, `user_credentials`, `auth_challenges`, `wechat_bindings`, `system_settings`, `templates`, `template_nodes`, `sequence_counters`, `business_lines`, `business_nodes`, `node_feedback`, `node_review_rounds`, `node_review_votes`, `evidences`, `work_calendar_entries`, `work_calendar_years`, `calendar_sync_requests`, `notifications`, notification-delivery records, `audit_logs`, `public_node_shares`, `public_node_share_chunks`, `operations_analytics_facts`, `operations_analytics_daily`, `business_search_documents`, `business_search_requests`, `node_text_parse_requests`, and `node_text_parse_usage`. 当前日历运行时只使用三个按代际拆分的日历集合；`work_calendar` 不是当前主存储，也不应作为本次部署创建或备份的必备集合。两个文本解析集合已在目标 CloudBase 创建并设置为仅云函数读写，解析函数保持空触发器；真实模型调用仍需单独验收。

Account transaction invariants are recorded in `docs/memory/decisions/ADR-0002-account-transaction-invariants.md`.
Unbounded-count feedback evidence attachment uses hidden, deterministic, chunked reservations under the existing `node_feedback` and `evidences` collections; the invariant and Task 11 recovery obligation are recorded in `docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md`.
For ordinary feedback evidence, a strict non-null completed-line `purgeDueAt` is authoritative for the whole business line; every terminal line state (`completed`, `cancelled`, `closed`, or `deleted`) must carry that valid deadline or evidence access/history fails closed. Attached evidence records declare `retentionScope: business_line` with `retentionSource: node_feedback`; future Task 9 amendment evidence may explicitly use `retentionScope: evidence` with `retentionSource: audit_amendment` and its own required strict deadline. One shared classifier enforces these exact scope/source pairs for access and history, while missing scope is accepted only by the explicit legacy `evidenceIds` adapter. Unknown or inconsistent scope/source metadata fails closed. Task 11 must scan due terminal lines and purge every associated evidence object by `businessLineId` in bounded chunks; earlier revisions therefore inherit the same deadline as the final revision.
Task 9 已落地业务驳回、关闭冻结和超级管理员审计修订。普通凭证继续继承业务线统一清理期限；审计修订附件从各自上传时间起独立保留 60 个自然日，并通过确定性、分块、可重试的 `audit_logs` 预约完成认领与发布。中断预约的 Task 11 回收义务记录在 `docs/memory/decisions/ADR-0004-business-lifecycle-amendment-reservations.md`。
Task 10 已落地原生小程序动态反馈和凭证交互。节点页通过单一受保护工作区读取字段快照、版本、提交权限与历史；大凭证先领取单对象短期授权并直传 COS，完成服务端核验后只以 `evidenceId` 参与保存或提交。所有查看和下载仍先申请短期地址。超级管理员使用独立受保护接口全局检索冻结售后和查看脱敏修订历史，普通成员读取边界保持不变。
COS 直传凭证的新引用必须使用服务端可信运行环境与配置桶名组合的 `cloud://<环境标识>.<桶名>/<对象键>`。仅当前桶名的历史错误引用可在凭证查看及现有分享读取中，经既有权限/保留期校验及自有元数据与结构化对象键精确核对后只读规范化；不改记录或重传文件。其他规范及旧 SDK 引用保留原行为；此读取兼容不代表独立清理函数已兼容历史错误引用。
Task 11 已落地独立 `evidenceRetention` 定时云函数。它先分块回收反馈和审计修订的过期预约，再处理过期 `uploading` 会话、24 小时孤立凭证、提前 15/7/1 天提醒和两种 60 天保留来源；文件清理使用带随机令牌的短期事务租约，云端删除成功或对象已不存在后才写入 `purged`，失败只保存安全分类与重试计数。真实定时触发器和目标环境索引由部署任务配置。完整的安全部署、索引、回滚和脱敏验收顺序记录在 `docs/deployment/template-node-fields-setup.md`。

第二批次公开分享把头记录写入 `public_node_shares`，凭证顺序按每块最多 40 条写入 `public_node_share_chunks`。创建令牌由仅存在于 `businessApi` 环境变量的高熵密钥执行 HMAC-SHA256 派生；同一账号、业务、节点和幂等请求键恢复同一预约。有效分享通过 `publicShareHoldUntil` 暂缓凭证清理；到期后由 `evidenceRetention` 有界删除分享块和头记录。首版不提供手动提前撤销。

所有必需多键索引中的账号数组采用最多 50 项且可见 BSON 编码不超过 768 字节的保守预算；业务成员数组另为最长 128 字节创建者预留一项，并与 100 次事务操作预算同时生效。新审核轮次固化处理人/审核人显示名，旧轮次缺失快照时只显示安全固定占位。`evidenceRetention` 的生产与服务批次上限统一为 40；精确状态/到期组合查询按权威排序字段与 `_id` 使用带明确 schema 和独立乐观修订的持久复合 keyset 游标，每条路径单次最多扫描 40 条原始记录；严格合法的旧 `{phase, afterId}` 游标由函数自动审计迁移到同阶段起点。详细决策见 `docs/memory/decisions/ADR-0006-index-budget-history-snapshots-and-retention-cursors.md`。

Account deployment requires the `system_settings/account_admin_state` guard, deterministic `wechat_bindings/<sha256(openid)>` backfill, and removal of the legacy `users.openid` unique index only after a verified migration. The security-redacted operator procedure is `docs/deployment/account-admin-setup.md`.

Task 9 已接入小程序端审核工作台：受保护的业务服务提供审核、投票、待办、详情、通知和标记已读能力；当前节点工作区一次返回节点、字段、草稿、历史与权限，脏草稿“保存并提交审核”由一个幂等服务端入口完成，避免保存成功但第二次请求失败时向用户误报失败。概览也由单一工作区接口聚合；检索投影是可恢复派生状态，不能把权威保存或提交包装成失败。业务详情保留已渲染内容并后台刷新，账号变化时立即清除旧账号数据并重新登录；所有页面继续在账号、页面请求或版本变化时丢弃旧异步响应。

## Environment

- WeChat Mini Program AppID identifier: `wx6dcce945f944e52f`.
- CloudBase environment identifier: `cloud1-d5gxt99rh492670d9`.
- Mini Program root: `miniprogram/`.
- Cloud-function root: `cloudfunctions/`.
- Cloud function names: ordinary authenticated API `businessApi`; authorized current-snapshot search worker `businessSearch`; ticket-protected current-node AI parser `nodeTextParser`; calendar synchronization and pending-deadline worker `calendarSync`; hourly processing/review reminder worker `workflowReminder`; scheduled retention worker `evidenceRetention`; materialized operations analytics worker `operationsAnalytics`.
- Default Git integration branch: `main`; remote tracking branch: `origin/main`.

These identifiers are not credentials. Secret values, administrator passwords, recovery codes, account identity values, and customer records must be supplied through approved secure channels and never stored here.

## Verification commands

Run from the repository root:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/businessSearch
npm.cmd test --prefix cloudfunctions/nodeTextParser
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
