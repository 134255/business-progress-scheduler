# Current Status

- 2026-08-29 “可选追加节点与全节点可免审核”已完成书面设计和逐任务实施计划。设计提交为 `6979a9b`，规格位于 `docs/superpowers/specs/2026-08-29-optional-tail-node-design.md`；实施计划位于 `docs/superpowers/plans/2026-08-29-optional-tail-node.md`，按 11 个 TDD 任务覆盖模板约束、不可变实例快照、首个成功决定事务、无审核直接完成、统一完成转移、待办/工作小时提醒、小程序交互、检索/固定分享/统计/保留、CloudBase 索引与隔离验收。计划已补齐追加节点决定时长的日历缺失路径：决定时先计算并保存 `calculated` 或 `pending_calendar`，后者由 `calendarSync` 的独立固定游标候选有界补算，统计只消费已计算结果。当前尚未修改生产代码、集合、索引、云函数或小程序版本，功能状态为 `unverified`；下一步是在当前会话按计划从模板域 RED 测试开始实施。操作员自有 `project.config.json` 与 `outputs/deploy/` 保持未修改、未暂存、未提交。

- 2026-08-29 已针对“超过 90 MB 视频上传到一部分后失败”完成根因修复和本地极限回归。根因不是 90 MB 大小阈值，而是客户端在一次分块上传及其重试期间固定复用 15 分钟 STS；慢速网络跨过期限后 COS 拒绝后续分块，旧逻辑既不能刷新授权，也可能让重试进度回退。修复新增受保护的 `refreshEvidenceUploadAuthorization`：服务端事务重新核对活动账号、当前售后/节点、节点版本、处理轮次、处理角色、格式策略、原预约令牌和 24 小时孤立期限，只延长原 `evidenceId`、原对象键的短期会话并签发新 15 分钟单对象凭据；客户端到期前两分钟主动刷新，遇到明确凭据失效可刷新重试，并发授权单飞、单文件最多八次、网络重试预算独立、进度单调。TDD RED 精确得到 6 项缺失刷新行为失败；GREEN 后相关客户端/服务/仓储/路由 76/76，通过 120 MiB 精确边界、120 MiB+1 拒绝、93% 处凭据过期恢复、并发单飞以及 120 分块跨多个凭据窗口且始终使用同一对象键的模拟压力测试；最终 `businessApi` 658/658、小程序 196/196、WXML 4/4、`git diff --check` 与项目记忆校验均通过，微信开发者工具 F5 重新编译后问题数为 0。修复版 `businessApi` 已从当前根项目执行上传部署，但尚未在真机用 90–120 MiB 无敏感视频限速超过 15 分钟完成端到端复验；该项在真实成功并确认只有一条 `available` 凭证前保持 `unverified`。操作员自有 `project.config.json` 与 `outputs/deploy/` 未修改、未暂存。

- 2026-08-28 COS 直传“上传失败，请重试”的服务端链路已修复并在目标 CloudBase 完成开发者工具实传验证。连续定位到三个兼容问题：CloudBase `doc(id).set()` 数据中不得再次写不可变 `_id`；`qcloud-cos-sts` 当前版本使用回调契约，不能直接把返回值当 Promise 等待；从控制台粘贴的五项 COS 环境变量可能带首尾空白，旧代码会把空白原样交给腾讯云鉴权并产生 `AuthFailure.SecretIdNotFound`。修复删除显式 `_id` 数据字段、同时兼容 STS 回调/Promise 返回、集中修剪并校验上传配置；只向客户端返回白名单错误阶段/代码，日志和响应不包含长期或临时凭据。修复版 `businessApi` 已部署；脱敏预约诊断成功签发 15 分钟精确对象临时凭据，随后在微信开发者工具对同一隔离节点真实上传并登记 2 MiB 与 25 MiB 无敏感 PDF，两个 `onSaveProgress` 均返回成功、页面文件队列清空且反馈历史分别生成第 1、2 版，证明超过 20 MiB 已走 COS 直传而非旧云存储入口。测试用本地 PDF 已删除；测试产生的云端凭证属于隔离验收数据，可按既有保留策略处理。当前代码全量 `businessApi` 655/655、WXML 4/4 通过。iPhone、Android/HarmonyOS、Mac/Windows 微信客户端及接近 120 MiB 合计边界仍须使用当前体验版复验；若体验版不是本次源码构建，需重新上传小程序版本后再测。

- 2026-08-28 大于 20 MiB 凭证在修复版 `businessApi` 部署后仍提示“上传失败，请重试”的二次排查已确认不是新代码继续失败，而是部署来源检出错误：操作员从仓库根项目 `main` 部署时，该分支仍停在 `73c484d`，既不含 `beginEvidenceUpload` / `finalizeEvidenceUpload` 路由，也不含 `cos-nodejs-sdk-v5`；完整大凭证实现及 STS policy 修复仅存在于隔离分支 `codex/large-evidence-performance`。目标库 `evidences` 精确查询 `storageStatus = uploading` 为 0 条，符合请求在新版预约路由前即失败的现象；CloudBase 日志页同期整体无调用数据，不能据此判断新版入口已执行。现已按操作员选择将隔离分支从 `73c484d` 快进合并到本地 `main` 的 `bb93396`，并保留未提交的 `project.config.json` 与 `outputs/deploy/`。合并后新跑 `businessApi` 647/647、WXML 4/4、`git diff --check` 与项目记忆校验均通过。真实目标环境仍须从当前根项目重新部署 `businessApi`，再用同一无敏感大于 20 MiB 文件复验；部署与真机成功前状态保持 `unverified`。

- 2026-08-28 大于 20 MiB 的 COS 直传已在真机稳定复现“上传失败，请重试”，并定位到服务端临时凭证签发边界，而非 120 MiB 合计限制或文件选择器。根因是 `createScopedCosCredentialProvider` 传给腾讯云 `GetFederationToken` 的 policy 错误包含 `principal`；腾讯云接口契约明确禁止该元素，导致 `beginEvidenceUpload` 在返回 15 分钟单对象临时凭证前失败。已按 TDD 增加“临时策略不含 principal 且无资源/动作通配符”的回归：RED 精确得到 `true !== false`，最小修复只删除该非法元素；聚焦仓储测试 8/8、`businessApi` 全量 647/647 均通过。现有七项简单/分块上传动作、精确对象键、期限、CAM 最小权限、五项 COS 环境变量和微信合法域名均不变且不记录任何凭据。修复尚未重新部署到目标 CloudBase，真机大文件上传仍为 `unverified`；下一步仅重新部署 `businessApi`，随后用同一无敏感大于 20 MiB 文件复验，成功后再检查 `available` 元数据、COS 对象和提交审核链路。

- 2026-08-28 “节点大凭证可靠上传与交互性能优化”已从隔离分支 `codex/large-evidence-performance` 完成首轮真实上传。微信开发者工具明确显示 `businessApi` 上传成功（约 309.7 KB、100 个文件），`evidenceRetention` 上传成功（约 33.2 KB、14 个文件），两者均使用“云端安装依赖（不上传 node_modules）”；CloudBase 控制台进一步确认两者均为“已部署”，更新时间分别为 2026-08-28 15:43:33 和 15:47:27。本轮没有执行“上传触发器”，因此未改变既有触发器配置；本地 `evidenceRetention` 目录也没有静态触发器配置文件，只保留平台可信 `timer` 来源校验，CloudBase 控制台现已直接确认其定时触发器为空。小程序从同一隔离工作树以版本 `1.0.2`、备注“120MB凭证直传与响应优化”上传，开发者工具显示“代码上传成功”；无依赖测试文件按工具规则未打包，代码质量扫描显示未发现问题。上传前回归证据仍为 `businessApi` 647/647、小程序 193/193、WXML 4/4，首次导入配置修复提交为 `eefe451`。CloudBase 控制台已直接核对 `businessApi` 当前运行时为 Node.js 16.13、超时 60 秒、内存 256 MB，既有三项环境变量保持未修改；同时确认 `EVIDENCE_COS_BUCKET`、`EVIDENCE_COS_REGION`、`EVIDENCE_COS_SECRET_ID`、`EVIDENCE_COS_SECRET_KEY`、`EVIDENCE_CLOUD_FILE_PREFIX` 五项必需 COS 环境变量全部缺失，因此大凭证直传当前必然不可用。现有 CloudBase 私有存储桶可复用，地域为上海 `ap-shanghai`，无需另建存储桶；存储桶完整名称属于部署配置，不写入项目记忆。受限 CAM 子账号密钥、包含 `ListMultipartUploads` 的最小 STS 权限、COS 合法上传/下载域名及按需 CORS 仍未配置或核对，跨 iPhone/Android/HarmonyOS/Mac/Windows 选择、分块续传、120 MiB 边界和公开分享兼容也仍为 `unverified`；在补齐配置并完成无敏感体验版验收前，不得宣称大凭证功能已正式上线。功能工作树保持干净，主检出中的操作员自有 `project.config.json` 与 `outputs/deploy/` 未修改、未暂存、未提交。

- 2026-08-28 大凭证功能分支首次导入微信开发者工具时暴露小程序配置错误：`miniprogram/app.json` 把 `chooseMedia` 写入 `requiredPrivateInfos`，当前开发者工具拒绝该声明并中止编译。已按 TDD 新增应用配置回归并移除该非法声明；隐私场景继续由微信公众平台既有隐私保护指引管理，不改变媒体选择功能或服务端安全边界。RED 精确失败为 `requiredPrivateInfos` 仍包含 `chooseMedia`，GREEN 后聚焦测试 1/1、`businessApi` 647/647、小程序 193/193、WXML 4/4、`git diff --check` 均通过；功能分支已在微信开发者工具重新编译，界面错误数为 0。真实 CloudBase/COS 配置、两个云函数部署、合法域名及跨端 120 MiB 上传仍为 `unverified`，下一步从该修正提交部署 `businessApi` 与 `evidenceRetention`，并保持后者触发器为空。

- 2026-08-28 “节点大凭证可靠上传与交互性能优化”已在隔离分支 `codex/large-evidence-performance` 完成本地实现和书面部署收尾。凭证口径已扩展为同一处理轮当前有效文件合计不超过 120 MiB，支持 JPG/JPEG/PNG/WebP/HEIC/HEIF、PDF、MP4/MOV/M4V；客户端跨端选择后通过服务端生成的精确对象键和 15 分钟单对象 STS 直传 COS，高级 SDK 自动简单/分块上传、最多 3 文件并发和有限网络重试，服务端以 COS 真实大小和有界头部签名/容器核验后才把 `uploading` 预约变为 `available`。`evidenceRetention` 已覆盖过期上传会话清理。概览和节点页分别收敛为一个账号隔离工作区调用，脏草稿可由一个幂等入口完成保存并提交审核，检索投影失败不再反转权威成功；详情页保留同账号已渲染内容后台刷新，账号变化立即清空并失效在途响应。部署手册已加入五项 COS 环境变量、包含 `ListMultipartUploads` 的精确最小 STS 动作、微信合法域名、按需 CORS、回滚、跨端/120 MiB/篡改/孤立清理验收及 `businessApi` 256/512 MB A/B，稳定决策记录在 `ADR-0014`。本轮提交链为 `8ce8768`、`a1aa9a6`、`6338104`、`d27bf5a`、`2295cd6`、`69244d2`、`5d979c5`、`62bbce5`、`9f14c2f`、`778f672`、`3a3005a` 及本记录所在收尾提交。缺失 `ListMultipartUploads` 的聚焦回归先按预期失败，补齐后 8/8 通过；最终全量回归：`businessApi` 647/647、`businessSearch` 35/35、`calendarSync` 55/55、`evidenceRetention` 43/43、`nodeTextParser` 19/19、`operationsAnalytics` 27/27、`workflowReminder` 31/31、小程序 192/192、WXML 4/4，均 0 失败；113 个生产 JavaScript 文件语法通过。`npm audit --omit=dev` 对 `businessApi` 与 `evidenceRetention` 均报告相同的 1 个 moderate、5 个 high、0 critical，来自 `wx-server-sdk@4.0.2` 的 Axios/Lodash/CloudBase 数据库传递依赖；自动完整修复会把 SDK 破坏性降级到 `2.5.3`，因此未执行。真实 COS/IAM/STS/按需 CORS/合法域名、CloudBase 环境变量和函数部署、跨 iPhone/Android/HarmonyOS/Mac/Windows 选择与分块恢复、120 MiB 边界、公开分享兼容以及 256/512 MB 成本/延迟 A/B 全部仍为 `unverified`，不能据本地测试宣称上线完成。下一步按部署手册先配置 COS/STS/域名和五项环境变量，再部署 `businessApi`、`evidenceRetention` 和小程序体验版并执行无敏感隔离验收。操作员原检出中的 `project.config.json` 与本地 `outputs/deploy/` 未读取业务内容、未修改、未暂存、未提交。

- 2026-08-28 已确认“节点大凭证可靠上传与交互性能优化”书面规格，并生成两份可执行实施计划：`docs/superpowers/plans/2026-08-28-large-evidence-upload.md` 与 `docs/superpowers/plans/2026-08-28-response-performance-and-submit-consistency.md`。计划按 TDD 分别覆盖 120 MiB 处理轮合计上限、扩展媒体签名、精确对象键 STS、服务端对象核验、跨端文件选择、分块上传和孤立预约回收，以及概览/节点工作区聚合、检索同步非权威化、保存并提交单调用和页面陈旧数据后台刷新。依赖版本已固定为 `cos-nodejs-sdk-v5@3.0.0`、`qcloud-cos-sts@3.1.3`、`cos-wx-sdk-v5@1.8.0`，未写入任何凭据。生产代码和部署配置尚未修改；下一步在仓库已忽略的 `.worktrees` 下创建隔离分支并从证据策略 RED 测试开始实施。操作员自己的 `project.config.json` 与本地 `outputs/deploy/` 继续保持未读取业务内容、未修改、未暂存、未提交。

- 2026-08-28 已完成“节点大凭证可靠上传与交互性能优化”的书面设计，规格为 `docs/superpowers/specs/2026-08-28-large-evidence-upload-and-response-performance-design.md`。已批准口径为同一处理轮当前有效凭证合计不超过 120 MiB、不另设业务层单文件或文件数量上限；系统支持扩展为 JPG/JPEG/PNG/WebP/HEIC/HEIF、MP4/MOV/M4V（含 H.264 与 H.265/HEVC）及 PDF，客户端选择放宽但服务端继续按真实对象大小、签名和容器品牌失败关闭。设计采用路径级短期 STS、COS 小程序 SDK 自动简单/分块上传、不可见 `uploading` 凭证预约、服务端有界头部核验和幂等完成登记，并保留孤立清理、60 天保留、审核冻结与公开分享边界。性能静态诊断确认概览一次刷新当前发出 3 次云函数调用，节点处理页串行发出 2 次，脏草稿提交审核至少发出 2 次业务调用；设计将其分别收敛为单一工作区接口和单一幂等提交入口，并规定权威写入成功不再被派生检索失败包装为失败。当前只新增设计文档，生产代码、COS/STS、集合字段、依赖、云函数配置和部署均未修改且为 `unverified`；下一步是书面规格复核后生成实施计划并按 TDD 开发。操作员自己的 `project.config.json` 与本地 `outputs/deploy/` 保持未修改、未暂存、未提交。

- 2026-08-27 节点处理页切换输入框后其他未保存字段偶发丢失的问题已按 TDD 完成本地修复。根因有两条：每次输入先标记草稿再写字段，连续执行两次 `setData` 会让真机原生输入层在输入法提交或失焦时用旧快照重绘；页面重新显示又会无条件读取服务端草稿，覆盖尚未保存的本地字段。现在文本、数字、日期、布尔、单选、多选、处理说明、识别结果应用及本地凭证增删均把草稿失效状态和实际值合并为一次原子视图更新；存在本地脏草稿、正在提交或审核草稿锁定时，`onShow` 不再覆盖本地表单，干净状态仍按原契约刷新服务端并继续依赖版本冲突保护。RED：节点反馈聚焦 24 项中 22 通过、2 项分别证明单次输入发生 2 次视图更新及脏草稿重新显示触发服务端覆盖；GREEN：节点反馈 24/24、小程序全量 183/183、`businessApi` 618/618、WXML 4/4，生产 JavaScript 语法与 `git diff --check` 通过。误用不存在的 `miniprogram/package.json` 执行 npm 前缀命令返回 `ENOENT`，随后使用权威命令 `node --test miniprogram/test/*.test.js` 完整通过；该失败不涉及产品代码。微信开发者工具重新编译及安卓/苹果真机连续填写多个字段、切换输入框和短暂离页返回仍为 `unverified`。操作员自己的 `project.config.json` 与本地 `outputs/deploy/` 保持未读取业务内容、未修改、未暂存、未提交。

- 2026-08-27 文本智能识别连续失败的第二个真实根因已定位：目标 CloudBase `nodeTextParser` 两次调用均进入函数并在平台允许的 60 秒上限处终止，说明票据与嵌套身份边界已通过，失败来自同步托管模型延迟而非测试文本或字段匹配。本轮按 TDD 增加安全结构化快路径：票据消费后先解析具有明确冒号边界的字段行，有限别名必须唯一对应当前字段，日期和选择项必须严格规范化并复用现有候选校验；命中任一安全候选即返回部分结果，不调用 AI，完全没有安全候选时原 `hy3` 路径保持不变。RED 聚焦 19 项中 18 通过、1 项因仍调用 AI 而失败；GREEN 后 `nodeTextParser` 19/19、`businessApi` 618/618、小程序 181/181、WXML 4/4，三个变更 JavaScript 文件语法检查通过。误用不存在的 `miniprogram/package.json` 执行 npm 前缀命令返回 `ENOENT`，随后按项目权威命令 `node --test miniprogram/test/*.test.js` 完整通过；该失败不涉及产品代码。修复提交后已通过微信开发者工具对 `nodeTextParser` 执行“上传并部署：云端安装依赖”，界面显示上传成功（15 个文件、约 27.5 KB）；无需重传 `businessApi` 或重新编译小程序。真实无敏感结构化文本的快速返回、预览确认与未识别字段手工补齐仍须复验；模型自由文本兜底、资源点消耗和真实延迟仍为 `unverified`。操作员自己的 `project.config.json` 与本地 `outputs/deploy/` 保持未读取业务内容、未修改、未暂存、未提交。

- 2026-08-27 文本智能识别默认模型已从目标环境未启用且需额外购买标准版的 `deepseek-v4-flash` 调整为当前已启用的 CloudBase AI+ `hy3`；`NODE_TEXT_PARSE_MODEL` 服务端覆盖能力、五分钟单次票据、每日 300 次默认额度、双重字段校验和用户预览确认均未改变。TDD RED 以默认解析请求实际仍发送 `deepseek-v4-flash` 精确失败 2/2；最小 GREEN 只替换受测试保护的默认模型，聚焦 2/2、`nodeTextParser` 全量 18/18、`businessApi` 618/618、WXML 4/4、生产 JavaScript 语法、`git diff --check` 与项目记忆校验均通过。目标环境控制台已实时核对：资源点计费已生效，模型列表中的 `hy3` 开关为开启；套餐用量页同时显示“按量付费”开关为开启，自动化过程未单独点击该开关，也未购买标准版或修改其他模型、云函数和环境变量。操作员已通过微信开发者工具执行“上传并部署：云端安装依赖”，界面显示 `nodeTextParser` 上传成功（15 个文件、约 25.7 KB）；真实 `hy3` 无敏感文本识别效果、响应质量与资源点消耗仍为 `unverified`。操作员自己的 `project.config.json` 与本地 `outputs/deploy/` 未读取业务内容、未修改、未暂存、未提交。

- 2026-08-27 文本智能识别真实 CloudBase 验收首次失败已定位为独立解析函数的嵌套身份边界：`businessApi` 服务端调用 `nodeTextParser` 时，CloudBase 可能继续注入原始微信账号 `OPENID`，旧入口在一次性内部票据校验之前直接拒绝该调用，导致结构清晰的测试文本也统一返回“文本识别失败”。本轮 TDD RED 以“继承非空 `OPENID` 且携带合法形状内部票据”的调用精确复现 `FORBIDDEN`；最小 GREEN 仅允许这类调用进入既有票据消费服务，没有票据的客户端调用仍在入口拒绝，票据仍由事务严格绑定账号摘要、售后、节点、节点版本、字段摘要、原文摘要和请求摘要并单次消费。聚焦入口 3/3、`nodeTextParser` 全量 18/18、`businessApi` 全量 618/618 均通过；两个既有 npm 用户配置警告未变化。真实目标环境仍须重新部署 `nodeTextParser` 后用无敏感文本复验；CloudBase AI+ 模型是否已实际启用、模型响应质量和费用仍为 `unverified`。操作员自己的 `project.config.json` 与本地 `outputs/deploy/` 保持未读取业务内容、未修改、未暂存、未提交。

- 2026-08-27 “当前节点文本智能识别与字段预填”已完成首轮真实 CloudBase 部署准备。功能提交 `415d23a` 已推送至 GitHub `origin/main`，未包含操作员自己的 `project.config.json` 修改。目标环境已创建 `node_text_parse_requests` 与 `node_text_parse_usage`，均设为仅云函数读写；`node_text_parse_requests(expiresAt ASC, _id ASC)` 非唯一组合索引已创建。CloudBase AI+ 控制台可见设计指定的托管模型；独立 `nodeTextParser` 已部署，内存 256 MB、超时 60 秒、触发器为空，服务端每日额度未另行配置时使用代码默认值 300。操作员已确认当前版本 `businessApi` 部署成功。真实粘贴文本识别、`businessApi` 到 `nodeTextParser` 的嵌套调用身份上下文、模型返回质量、Token 消耗/费用告警、字段预览与确认、开发者工具及真机仍为 `unverified`；下一步使用无敏感测试文本完成一次端到端识别，确认不会自动覆盖已有值且确认应用后仍需显式保存或提交。部署包位于本地忽略外的 `outputs/deploy/`，未提交 Git；操作员自己的 `project.config.json` 继续保持未读取、未修改、未暂存、未提交。

- 2026-08-26 “当前节点文本智能识别与字段预填”已完成本地实现。活动处理人可在当前可编辑节点主动粘贴最多 8,000 字符文本，`businessApi` 事务内按既有保存进度同等级账号关系重新校验活动账号、售后、当前节点、处理角色、角色分离、版本和字段定义后，签发五分钟单次消费且绑定账号/售后/节点/版本/字段摘要/原文摘要/请求摘要的一次性票据；独立 `nodeTextParser` 只接受该票据，只把原文和规范化字段定义交给 CloudBase AI+ 托管模型。识别结果在解析函数与 `businessApi` 返回边界双重校验字段类型、长度、数值精度、真实日期、正则安全子集及选择项；单选/多选精确匹配优先，模糊语义阈值为 0.5，单选前两名差距小于 0.1 时保持人工确认。页面把候选分为直接填入、替换已有值和人工确认，默认不覆盖已有值；应用前再次按当前字段定义校验，取消、离页、账号或节点变化都会废弃迟到响应；确认后只写本地表单，仍须经过既有保存或提交。原文、模型候选、票据和账号标识不持久化、不记日志。账号级限制为单飞、每分钟最多 10 次、每个上海自然日默认 300 次；`NODE_TEXT_PARSE_DAILY_LIMIT` 只接受 `1..1000` 十进制安全整数，缺失使用 300，损坏配置、未来计数、基础设施读取异常或不完整锁结构均失败关闭。TDD 覆盖票据伪造/重放、提示注入、访问器/继承/稀疏结构、危险正则、模型输出、选择项阈值、页面预览、取消/离页、旧响应和部署契约；最终本地回归为 `businessApi` 618/618、`nodeTextParser` 16/16、`businessSearch` 35/35、`calendarSync` 55/55、`workflowReminder` 31/31、`evidenceRetention` 42/42、`operationsAnalytics` 27/27、小程序 181/181、WXML 4/4，均为 0 失败；13 个变更生产 JavaScript 文件语法、`git diff --check` 与项目记忆校验通过。`npm audit --omit=dev` 对 `nodeTextParser` 锁文件报告 1 个 moderate、5 个 high、0 critical，来源是 `@cloudbase/node-sdk`/`wx-server-sdk` 的 CloudBase 数据库、Axios 与 Lodash 传递依赖；建议修复会降级 SDK，尚未在 Node.js 16 与 AI+ 能力上验证，因此未自动修改并列为部署前风险复核。真实 CloudBase AI+ 模型开通、Token/费用告警、两个新集合和索引、`businessApi`/`nodeTextParser` 部署、嵌套云函数身份上下文、空触发器、开发者工具及真机均为 `unverified`；下一步是按部署手册做无敏感隔离验收。操作员自己的 `project.config.json` 修改继续保持未读取、未修改、未暂存、未提交。

- 2026-08-26 “售后线自动命名并取消计划日期”已完成实现并将功能提交 `cbdee83` 推送到 GitHub `origin/main`。普通用户从模板创建售后时不再填写名称、计划开始日期或计划完成日期；服务端在同一编号分配事务中使用可信模板名称和新生成的售后线编号固化名称，格式为“模板名称-售后线编号”，客户端传入的旧名称/计划日期字段只作旧版本兼容接收并被忽略。普通元数据编辑只允许修改说明，已有名称和历史计划日期不会被覆盖；编辑页对历史值只读展示。售后列表与授权全文检索的日期筛选已改为上海时区的创建日期，页面标签同步明确为“创建开始日期/创建结束日期”。TDD 初始 RED 为聚焦 129 项中 124 通过、5 项准确暴露旧名称/日期契约；日期语义补强 RED 为 3 项全部失败；GREEN 后聚焦 129/129、`businessSearch` 35/35。最终本地回归：`businessApi` 603/603、`businessSearch` 35/35、小程序 174/174、WXML 4/4，均为 0 失败。真实 CloudBase 重新部署 `businessApi` 与 `businessSearch`、微信开发者工具重新编译、创建页真机显示、自动名称及创建日期筛选仍为 `unverified`。操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-26 “授权范围内的售后全流程内容检索”已完成首次真实 CloudBase 部署准备与函数上线。`main` 已推送至 GitHub `origin/main` 的 `e13b595`；操作员自己的 `project.config.json` 修改未进入提交或推送。目标环境已创建 `business_search_documents`、`business_search_requests`，两集合均为仅云函数读写；已核对 `business_search_documents` 的令牌候选、代际条目和旧代清理索引，以及 `business_lines` 的恢复队列和历史回填游标索引，共 5 条。`businessSearch` 已创建并部署，内存 256 MB、超时 60 秒、共享检索密钥已配置且触发器保持空；`businessApi` 已保留原有两个环境变量并新增同值检索密钥，随后于 14:10 重新部署，运行时 Node.js 16.13、超时 60 秒。控制台实际把新建的 `businessSearch` 配置为 Node.js 20.19，而部署手册预期 Node.js 16.13；当前函数状态正常且本地 `businessSearch` 34/34、`businessApi` 600/600，但真实云端 Node.js 20 兼容调用仍为 `unverified`，不得把该偏差写成已验收。历史回填 Timer 未创建，三个回填/恢复/清理游标未触碰；后续必须先做普通成员/超级管理员权限隔离和新写入同步检索验收，再单独批准一次性历史回填。部署过程中未记录或输出任何密钥值。

- 2026-08-25 “授权范围内的售后全流程内容检索”已完成本地实现。售后列表可按当前有效的售后/节点名称与编号、说明、动态字段名称和值、处理说明、当前审核意见及凭证文件名检索；最多 5 个关键词采用 AND 语义并允许跨节点命中，每条结果最多展示 3 条安全摘要。活动超级管理员可检索全部非创建中、非已删除售后；普通活动账号只检索现有关系可见售后，候选读取前后均重新授权，账号停用、撤权、降权、损坏数据和过期游标按无结果或固定安全错误处理。独立 `businessSearch` 使用版本化完整代际、HMAC 倒排令牌、五分钟一次性内部票据和绑定账号/筛选/权限模式的短期分页游标；当前内容写入口同步推进来源版本，提交后索引失败不会重复业务副作用。历史回填、失败恢复与旧代清理使用三个独立 keyset 游标，整轮共享最多 40 条原始扫描预算，不使用 `skip`，全失效页仍推进。TDD 最后一次 RED 精确证明旧编排可在回填/恢复之外再额外清理 40 条，修复后检索工作器 34/34。完整本地门禁：`businessApi` 600/600、`businessSearch` 34/34、`calendarSync` 55/55、`workflowReminder` 31/31、`evidenceRetention` 42/42、`operationsAnalytics` 27/27、小程序 173/173、WXML 4/4，均为 0 失败；16 个变更生产 JavaScript 语法、提交差异和项目记忆校验通过。真实 CloudBase 两个新集合、五个组合索引、两函数同值高熵密钥、`businessSearch`/`businessApi` 部署、一次性可信 Timer 历史回填、多账号权限隔离、开发者工具和真机仍为 `unverified`，首次部署及验收后均必须保持 `businessSearch` 的 `triggers: []`。操作员自己的 `project.config.json` 修改继续保持未读取、未修改、未暂存、未提交。

- 2026-08-25 已确认“授权范围内的售后全流程内容检索”完整设计，书面规格为 `docs/superpowers/specs/2026-08-25-authorized-after-sales-content-search-design.md`，架构决策为 `docs/memory/decisions/ADR-0012-authorized-after-sales-content-search.md`。检索只使用当前有效最新快照，覆盖售后名称/编号/说明、节点名称/编号、动态字段名称和值、处理说明、当前审核意见及凭证文件名；最多 5 个空格分隔关键词采用 AND 语义，允许单字符，结果每条最多显示 3 个节点与内容类型摘要。活动超级管理员可以查看和检索全部非创建中、非已删除售后；普通活动账号仍只限现有关系可见售后，返回前必须重新授权且无权对象不产生存在性信号。设计采用独立 `businessSearch`、版本化 `business_search_documents` 倒排索引、一次性内部票据、同步生成和可信 Timer 历史回填；生产代码、集合、索引、环境变量及部署均尚未修改，全部为 `unverified`。下一步是项目所有者复核书面规格，确认后生成实施计划。本轮继续保留操作员自己的 `project.config.json` 未提交修改，不读取其业务含义、不修改、不暂存、不提交。

- 2026-08-25 概览页产品标语已按确认文案从“让每条售后都有清晰的下一步”调整为“让每条售后都有清晰的记录”，不涉及页面行为、接口或数据结构。TDD RED：概览页精确文案回归 14 项中 13 项通过、1 项因仍显示旧标语而失败；GREEN：聚焦 14/14。完整验证：小程序 169/169、`businessApi` 581/581、WXML 4/4。微信开发者工具重新编译及真机显示仍为 `unverified`；操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 用户可见产品术语已从“业务”统一调整为“售后”。本轮只替换小程序页面标题、按钮、占位、Toast/错误提示、通知、公开分享、运营看板及服务端可返回中文文案，不修改 `business*` 英文标识、集合/字段/API/路由或历史数据。TDD RED：新增跨小程序与云函数生产文件的术语门禁，先准确识别 37 个小程序文件及 2 个云端文件仍包含旧文案；GREEN：生产范围扫描不再出现“业务”，39 个生产文件经机械替换一致性审计全部通过。最终验证：`businessApi` 581/581、小程序 168/168、WXML 4/4、16 个变更生产 JavaScript 语法检查通过。微信开发者工具重新编译、真机显示及重新上传小程序/部署 `businessApi` 仍为 `unverified`；操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 真实 CloudBase 在分享头第一笔事务写入时返回通用内部错误，且 `public_node_shares`、`public_node_share_chunks` 均保持 0 条。根因是分享仓储已通过 `.doc(shareId)` 指定确定性文档编号，却又把只读保留字段 `_id` 放入 `set({ data })`；CloudBase 拒绝更新 `_id`，原假数据库默认未模拟该约束。TDD RED：启用现有 `rejectExplicitIdOnSet` 真实约束后，分享仓储 12 项中 11 项通过、1 项准确失败于分享头写入；最小修复只从写入体移除 `_id`，文档编号、幂等令牌、七日有效期、凭证保留锁和公开读取协议均未改变。GREEN：分享仓储 12/12，完整 `businessApi` 581/581。重新部署 `businessApi` 后，操作员已在真实 CloudBase 对原节点成功生成固定分享快照；微信转发、接收者未登录公开查看、七日后失效仍为 `unverified`。无需修改原业务或凭证数据，也无需重新上传小程序。操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 已确认真实凭证的 `businessLineId` 正确指向业务文档，分享仍返回 `FORBIDDEN` 的实际根因是审核轮次把字段结果持久化为 `fieldValues` 数组，而分享仓储测试夹具使用了对象并按对象解析；无动态字段的真实 `fieldValues: []` 因而在权限校验完成后被错误映射为无权限。TDD RED：真实空数组回归使分享仓储 10 项中 9 项通过、1 项准确失败；非空字段快照回归使 11 项中 10 项通过、1 项准确失败。最小修复把真实数组严格转换为公开页所需键值对象，同时逐项验证数组稠密、字段编号唯一、字段名称和类型与节点定义一致、值类型安全且不执行访问器；活动账号、业务成员、处理人/审核人、最终通过轮次、凭证归属及永久文件元数据校验均未放宽。GREEN：分享仓储 11/11、公开只读页 1/1；最终新跑 `businessApi` 580/580、WXML 4/4，生产 JavaScript 语法与 `git diff --check` 通过。真实 CloudBase 重新部署并对原节点生成、转发和未登录查看仍为 `unverified`；无需修改业务、轮次或凭证数据，也无需重新上传小程序。操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 真实 CloudBase 审核轮次缺少 `processorUserIds` 导致已完成节点分享错误返回 `FORBIDDEN` 的问题已按 TDD 修复。根因是审核轮次创建契约从不持久化该字段，权威处理账号快照位于业务节点，轮次只保存实际提交账号、处理人显示名快照和审核账号快照；分享仓储测试夹具却虚构了该字段，并在创建事务中错误强制读取。RED：把分享夹具改为真实轮次结构后，分享仓储 9 项中 4 项通过、5 项准确失败于处理人、进行中业务、审核人、分块恢复和公开读取准备路径；最小修复仅删除不存在字段的必填校验，处理人继续由节点 `processorUserIds` 授权，审核人仍必须同时存在于节点和最终通过轮次的 `reviewerUserIds`，当前活动账号、业务成员、节点完成、审核通过、显示快照、字段快照及凭证元数据校验均保持不变。GREEN：分享仓储 9/9；最终新跑 `businessApi` 578/578、WXML 4/4，生产 JavaScript 语法、`git diff --check` 与项目记忆校验均通过。真实 CloudBase 重新部署及原业务生成、转发、公开查看仍为 `unverified`；无需修改现有数据库记录或重新上传小程序。操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 已完成审核节点的当前审核人现可生成并转发固定公开分享快照。业务详情安全投影仅在节点已完成且当前活动业务成员为业务管理员、该节点处理人或该节点审核人时显示分享入口；服务端创建事务仍重读活动账号、业务、节点和最终通过轮次，审核人必须同时存在于节点审核人快照与该最终轮次审核人快照。其他节点审核人、无关业务成员和停用账号仍失败关闭；七天有效期、公开接收者免登录、永久文件编号隐藏及凭证保留锁均未改变。TDD RED：业务详情与分享仓储聚焦 99 项中 97 项通过、2 项分别准确失败于审核人入口隐藏和创建返回 `FORBIDDEN`；GREEN：聚焦 99/99，无关业务成员拒绝回归通过。最终新跑 `businessApi` 578/578、WXML 4/4，两个生产 JavaScript 语法、`git diff --check` 与项目记忆校验均通过。真实 CloudBase 重新部署及审核人真机生成、转发和公开查看仍为 `unverified`。本修复不改小程序页面、集合、索引或环境变量，只需重新部署 `businessApi`；操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 进行中业务的已完成审核节点现可立即生成固定公开分享快照，无需等待整条业务完成。根因是客户端已按“节点已完成”正确显示分享入口，但服务端分享仓储只允许业务状态 `active/completed/closed/cancelled`，遗漏当前真实运行态 `in_progress`，因此点击后返回 `FORBIDDEN`。TDD RED：分享仓储聚焦 7 项中 6 项通过、1 项准确失败于进行中业务；最小修复仅将 `in_progress` 纳入可创建分享快照的业务状态，节点必须已完成、审核终态必须通过、账号必须活动且仍具业务成员及管理人或该节点处理人关系等原安全边界保持不变。GREEN：分享仓储 7/7；最终新跑 `businessApi` 575/575、WXML 4/4，生产 JavaScript 语法、`git diff --check` 与项目记忆校验均通过。真实 CloudBase 重新部署及对未结束业务中的已完成节点执行“生成固定分享快照→发送给微信好友或群聊→未登录公开只读查看”仍为 `unverified`。本修复不改小程序页面、集合、索引或环境变量，只需重新部署 `businessApi`；操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 Mac 微信客户端节点凭证图片/视频灰色不可选问题已按 TDD 完成本地修复。真实截图证明失败发生在文件选择阶段：页面调用手机端 `wx.chooseMedia` 后，Mac 系统选择器只允许进入目录，JPG/PNG 文件均置灰，尚未进入云存储上传或服务端登记。RED：节点反馈聚焦 19 项中 18 项通过、1 项准确失败于 Mac 仍调用手机相册接口；GREEN：Mac/Windows 改用 `wx.chooseMessageFile` 并限定 JPG/JPEG/PNG/MP4/MOV/M4V，iOS/Android 继续使用原相册/相机接口，选中文件继续复用既有格式、签名、大小、总量与上传登记边界，聚焦 19/19。最终新跑：小程序 167/167、`businessApi` 574/574、WXML 4/4，生产 JavaScript 语法通过；微信开发者工具重新编译、上传新体验版及原 Mac 微信客户端选择 PNG/JPG 并保存处理进度仍为 `unverified`。本修复不改云函数、集合、索引或环境变量，操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-25 安卓真机全部输入框的在输文字异常缩小问题已按 TDD 完成本地修复。根因是全局 `.input`、`.textarea` 只定义盒模型，没有为微信原生输入层显式提供字号、行高、文字颜色和输入框内容高度；占位文字由独立层绘制而保持正常，获得焦点后的真实输入内容则在部分安卓环境被压缩。RED：新增全局表单样式回归后 1 项中 0 项通过，准确失败于缺少显式输入字号；GREEN：普通输入框、密码框、数字框及多行文本框统一使用 30rpx 可见文字、匹配行高和稳定输入高度，专用回归 1/1、小程序全量 166/166、WXML 4/4，`git diff --check` 通过。微信开发者工具重新编译及原安卓真机“业务线名称”输入复验仍为 `unverified`；本修复不改业务逻辑、云函数、集合、索引或部署配置，操作员自己的 `project.config.json` 修改保持未读取、未修改、未暂存、未提交。

- 2026-08-24 “业务发起人作为节点唯一审核人”已完成正式复审加固与全量门禁。每个模板节点新增严格的 `reviewerAssignmentMode: fixed_accounts | business_creator`；管理端在发起人模式隐藏固定审核账号选择器，模板保存/启用拒绝同节点角色重叠并提供稳定中文提示。模板头保存规范化定义的 SHA-256 `definitionDigest` 及按节点顺序排列的权威 `definitionNodeIds`；发起人审核模式不接受缺少任一绑定字段的模板。创建预约事务同时比较服务预读与当前模板头清单，再逐个固定读取清单节点并重算摘要；模板服务内的增删、改写会原子更新模板头并使在途创建失败关闭，查询后旁路插入但未列入头清单的额外文档只作为未发布孤立记录，不会进入业务快照，后续普通定义读取会报告集合损坏。创建写事务预算同时计入源节点读取和业务节点写入，24 节点加 46 个去重参与账号的真实边界恰好为 100 次操作。业务创建预约、发布和已发布幂等返回均重新读取当前活动创建人及严格业务关系后再解释状态。业务节点在创建时固化处理人和审核人显示名，后续审核轮次与历史详情只复用该不可变快照；参与人改名、停用或账号缺失都不会改写已完成历史，旧业务缺快照时只显示固定安全占位。关系对象、数组和字段只接受自有数据属性，访问器、继承值、稀疏数组和新旧结构混用失败关闭。最终新跑：`businessApi` 574/574、`calendarSync` 55/55、`workflowReminder` 31/31、`evidenceRetention` 42/42、`operationsAnalytics` 27/27、小程序 165/165、WXML 4/4，全部 0 失败；变更生产 JavaScript 语法、`git diff --check` 与项目记忆校验通过。真实 CloudBase 重新部署、开发者工具编译、第二节点自动固化、同节点角色冲突中文提示、真实好友/群转发和未登录接收者查看图片/视频/PDF 仍为 `unverified`。本功能不新增集合、索引、环境变量或 Timer；只需部署 `businessApi` 并上传小程序 `1.0.1`。操作员自己的 `project.config.json` 修改继续保持未读取、未修改、未暂存、未提交。

Status captured: 2026-08-26 (Asia/Shanghai)

- 2026-08-24 运营统计真实 CloudBase 修复验收已完成：修复版 `operationsAnalytics` 部署后，以一次性可信 Timer 领取 2 个节点和 1 条业务来源，三者全部生成且 `failed: 0`；对应来源均从 `pending` 转为 `generated`，来源版本与生成版本一致并保存生成时间。隔离业务产生 13 条不可变事实，事实摘要、汇总编号和应用版本抽查符合；每日汇总由 0 变为非 0，计数、分钟、版本和更新时间结构符合。小程序按隔离模板生成两个节点的处理/审核并列柱状图与历史趋势，有效样本非 0。参与业务的活动普通账号可查看全局汇总并下钻有权业务，无关活动普通账号仍可查看匿名全局图表但看不到该业务明细，两者均无 CSV 导出入口。一次性 Timer 执行后已恢复 `operationsAnalytics` 的 `triggers: []`。正式周期 Timer、长期运行监控和生产发布仍为 `unverified`；操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。

- 2026-08-20 真实 CloudBase 首次运行 `operationsAnalytics` 时在领取首批候选前安全失败：来源业务和两个节点均保持 `analyticsSnapshotStatus: pending`，统计游标、事实和每日汇总均未生成。根因是运营统计仓储在通过 `doc(id).set()` 写游标、事实和每日汇总时，又把只读系统字段 `_id` 放入 `data`；CloudBase 拒绝更新 `_id`，而原内存数据库未模拟该限制。TDD 已为测试数据库增加可选的真实约束，RED 为运营统计仓储 6 项中 2 项通过、4 项因 `_id` 写入失败；最小修复只从三类 `set` 数据中移除显式 `_id`，文档编号继续由 `doc(id)` 确定，GREEN 为 6/6。最终新跑：`operationsAnalytics` 26/26、`businessApi` 558/558、`calendarSync` 55/55、`workflowReminder` 30/30、`evidenceRetention` 42/42、小程序 162/162、WXML 4/4，全部 0 失败。真实目标环境重新部署、一次性 Timer 恢复 pending 来源、生成事实/每日汇总并恢复空触发器仍为 `unverified`；操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。

- 2026-08-19 本地 `main` 的运营统计功能合并后门禁保持全绿，并已通过 Git HTTP/1.1 成功推送到既有 `origin/main`；未提交的 `project.config.json` 未进入任何提交或推送。CloudBase 部署包和手册已核对：下一步先备份或记录两个尚不存在的统计集合，再创建 `operations_analytics_facts`、`operations_analytics_daily` 及手册列明的来源扫描/事实/每日汇总索引，随后部署 `businessApi`、`operationsAnalytics` 和小程序；`operationsAnalytics` 首次部署必须保持 `triggers: []`，一次性 Timer、多账号下钻及正式 15 分钟周期仍为 `unverified`。

- 2026-08-19 “运营统计看板与历史工时分析”已从 `codex/operations-analytics-dashboard` 快进合并到本地 `main`。所有活动账号可读取不含业务身份的全局汇总，普通账号的业务筛选项和样本下钻在返回前逐项重验当前活动账号及业务关系，超级管理员可查看全部样本并保留原当前指标与 CSV。看板按模板和 `sourceTemplateNodeKey` 稳定节点展示处理/审核并列柱状图、日/周/月双趋势、模板级业务完成/每业务节点处理/审核指标，并支持模板版本、业务状态、可访问业务、稳定节点、实际处理人及实际审核人筛选；明细提供有效样本、精确中位数、平均/最短/最长、待日历补算、历史未记录、分页业务、全部处理/终态审核轮次和实际投票响应，合法零分钟与缺失历史字段使用不同中文标签。独立可信 Timer `operationsAnalytics` 使用每批 40 条的持久游标，将业务/节点不可变来源物化为确定性事实及每日汇总；日历缺失事实由第三个独立游标单向补算，不阻断业务流转。TDD 先后精确复现客户端图表缺失、事实刷新缺失、部署索引遗漏、分钟累计溢出、筛选项撤权竞态和空工时展示，均已转为 GREEN。合并后最终新跑：`businessApi` 558/558、`operationsAnalytics` 26/26、`calendarSync` 55/55、`workflowReminder` 30/30、`evidenceRetention` 42/42、小程序 162/162、WXML 4/4，全部 0 失败；30 个变更 JavaScript 文件语法、`git diff --check` 与项目记忆校验均通过。真实 CloudBase 新集合、复合索引、统计工作器部署/事务竞争、一次性 Timer、历史首次物化、微信开发者工具视觉及多账号真机仍为 `unverified`，正式 Timer 不得自动启用。操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。

- 2026-08-19 真实模板验收发现：节点编辑页正确保存 `processorAssignmentMode`，但模板总页最终清洗请求时漏掉该字段，使“业务发起人作为本节点唯一处理人”被服务端按固定负责人解析，并因空 `processorUserIds` 返回 `TEMPLATE_INVALID`。TDD RED：模板聚焦 27 项中 26 通过、1 项按预期失败，最终请求中的发起人/固定负责人两种模式均为 `undefined`；最小修复后模式随每个节点独立透传，旧节点仍稳定归一为 `fixed_accounts`。GREEN：模板聚焦 27/27、小程序全量 157/157、`businessApi` 551/551、WXML 4/4，生产 JavaScript 语法通过。微信开发者工具重新编译和真实模板保存复验仍为 `unverified`；操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。

- 2026-08-18 “业务发起人节点负责人及个人工时明细”已完成全部本地实现与最终全量门禁。阶段提交依次为 `af4c897`（模板节点负责人来源）、`c29bbe2`（业务发起人快照）、`f75ad6c`（处理轮个人工时）、`0799611`（审核人响应工时）、`a30384f`（个人响应待补算）、`7e4d0f8`（受保护运营明细接口）、`dc13de4`（运营看板明细页面）；设计与计划提交为 `bf3ebbf`、`6c3b583`。最终新跑：`businessApi` 551/551、`calendarSync` 55/55、`workflowReminder` 30/30、`evidenceRetention` 42/42、小程序 156/156、WXML 4/4，全部 0 失败。实现生产 JavaScript 语法、全范围 `git diff --check` 和项目记忆校验通过。部署必须先创建 `node_review_votes(reviewResponseTimingStatus ASC, _id ASC)` 与 `node_review_rounds(reviewStartedAt DESC, _id ASC)` 两个非唯一组合索引，再部署 `businessApi`、`calendarSync` 和小程序；`workflowReminder` 与 `evidenceRetention` 无本功能代码变更，所有定时函数继续保持空触发器。真实 CloudBase 索引、日历补算、撤权并发、微信开发者工具渲染和多账号真机验收仍为 `unverified`。操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。

- 2026-08-18 “业务发起人节点负责人及个人工时明细”Task 7 已按 TDD 完成运营看板页面。RED：`admin-operations-flow` 4 项全部按预期失败，证明客户端服务动作、明细加载、分页单飞和旧响应失效尚不存在；GREEN：页面聚焦 4/4、小程序全量 156/156、WXML 结构 4/4。原指标和 CSV 不变；页面新增独立“节点处理时间明细”，显示每轮实际提交人、节点负责人来源、本轮处理工作分钟/逾期、审核提交时间，以及仅实际投票人的决定和个人响应工作分钟。`calculated`、`pending_calendar`、历史未记录分别显示准确中文，不把未知值变成 0；加载失败保留已有结果并显示固定中文错误。翻页按轮次去重且防重复点击，日期/状态变化、账号切换和页面隐藏都会使旧响应失效。两份生产 JavaScript 语法与 `git diff --check` 通过；真实微信开发者工具渲染、CloudBase 接口/索引和多账号数据仍为 `unverified`。

- 2026-08-18 “业务发起人节点负责人及个人工时明细”Task 6 已按 TDD 完成受保护运营明细接口。RED：运营域、服务、仓储与路由聚焦 52 项中 46 通过、6 项按预期失败；GREEN：同一聚焦 52/52，`businessApi` 全量 551/551。新增 `listOperationsTimingDetails`，仅活动超级管理员可调用；按 `reviewStartedAt DESC, _id ASC` 每次最多扫描 100 条原始审核轮次、返回最多 20 条，严格游标绑定日期范围和业务状态。安全投影只返回业务/节点展示信息、实际提交人显示快照、负责人来源、处理轮工时与实际投票人的个人响应工时；不返回内部账号 ID、OpenID、请求摘要、永久文件 ID 或租约。历史缺失个人工时字段明确投影为 `recorded: false`，不伪造为 0；查询前、候选固定文档事务内和返回前均重验当前超级管理员，业务/节点/轮次/投票关联或聚合损坏、业务状态变化时不返回旧结果。部署手册新增非唯一索引 `node_review_rounds(reviewStartedAt DESC, _id ASC)`；四份生产 JavaScript 语法、`git diff --check` 和项目记忆校验通过。客户端运营明细、真实 CloudBase 索引选择和撤权并发仍为 `unverified`；下一步按既定计划直接实现 Task 7 页面。

- 2026-08-18 “业务发起人节点负责人及个人工时明细”Task 5 已按 TDD 完成：`calendarSync` 新增独立固定游标 `system_settings/calendar-review-vote-response-cursor`，每次最多扫描 40 条原始待补算投票；40 条损坏票据不会永久遮挡第 41 条合法票据，空页安全回绕，并发只签发一次，领取后崩溃可在有限轮次后重取，损坏游标或版本溢出失败关闭。候选和写回均验证票据自有数据字段、决定、创建时间、审核开始/投票结束边界、防篡改摘要及业务—节点—轮次—票据关联；写回事务固定重读四份文档，只修改个人响应状态、分钟、日历版本、摘要和系统补算时间，不修改决定、评论、显示名、请求摘要或投票时刻。日历仍缺失时沿用脱敏超级管理员告警；已计算票、完全缺少新字段的旧票和未投票审核人不会进入扫描。TDD RED 为日历服务与仓储聚焦 40 项中 37 通过、3 项按预期失败；补强游标/版本/告警后聚焦 42/42，`calendarSync` 全量 55/55、`businessApi` 回归 547/547。部署手册已新增非唯一索引 `node_review_votes(reviewResponseTimingStatus ASC, _id ASC)`；真实 CloudBase 索引选择、游标并发、待补算票据恢复与 Timer 运行仍为 `unverified`，所有定时函数配置保持不变。
- 2026-08-18 “业务发起人节点负责人及个人工时明细”Task 4 已按 TDD 完成：每张新审核票据在写入事务内固化实际投票人的安全显示名、审核开始/投票结束边界、个人响应工作分钟、日历版本及防篡改摘要；会签未投票人不生成票据，也不产生个人工时。相同投票重试保持原快照，改票或删除、篡改状态、分钟、日历版本、边界及摘要均失败关闭。投票时日历缺失不会阻断业务流转，票据保存 `pending_calendar`、空分钟和不可变边界，后续由独立补算任务恢复。初始 RED 为审核服务与仓储聚焦 69 项中 65 通过、4 项按预期失败；修复旧待补算夹具后聚焦 69/69，`businessApi` 全量 547/547。真实 CloudBase 投票写入、会签多账号个人归属、待补算恢复和并发幂等仍为 `unverified`；操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。
- 2026-08-18 “业务发起人节点负责人及个人工时明细”Task 3 已按 TDD 完成：每次提交审核都会在不可变 `node_review_rounds` 中固化实际提交账号的安全显示名、节点负责人来源、当前处理段起止边界、当前段工作分钟及日历版本；多候选节点只归属实际提交人，驳回后的新处理轮可归属另一位实际提交人且旧轮快照不变。当前段分钟与节点累计分钟分开保存；日历缺失时以 `pending_calendar`、空分钟和完整边界安全提交，`calendarSync` 在现有每批不超过 40 条的处理时长补算路径中同步更新当前段、累计值、轮次锁和防篡改摘要。响应丢失后的幂等重试会验证完整个人归属快照；显示名、负责人来源、状态、分钟、日历版本或边界被删改均返回版本冲突。完全缺少新字段的旧轮次继续作为“历史未记录”，不会被自动补造或加入补算。初始 RED 为四份聚焦测试 103 项中 99 通过、4 项按预期失败；补强后聚焦 105/105，仓储与日历聚焦 87/87，`businessApi` 全量 547/547、`calendarSync` 全量 50/50，三份生产 JavaScript 语法与 `git diff --check` 通过。真实 CloudBase 新轮次写入、跨轮次归属、待补算恢复与并发幂等仍为 `unverified`；操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。
- 2026-08-18 “业务发起人节点负责人及个人工时明细”Task 2 已按 TDD 完成：业务创建时先将每个审核节点的负责人来源解析为不可变快照；`business_creator` 节点只把当前活动业务发起人写为唯一 `processorUserIds` 和显示名，其他排序节点仍按各自 `fixed_accounts` 配置保存。若发起人同时位于同一节点审核人数组，创建事务以 `CREATOR_REVIEWER_CONFLICT` 整笔拒绝并返回明确中文提示，不分配业务编号、不写业务、节点或半成品计数器。事务预算对已由固定读覆盖的发起人去重计数，原有恰好 100 次边界继续通过；旧模板缺少负责人来源时继续稳定兼容为固定账号。RED：业务仓储与小程序业务聚焦 95 项中 91 通过、4 项按预期失败；GREEN：同一聚焦 95/95，`businessApi` 全量 544/544，三份变更生产 JavaScript 语法通过。真实 CloudBase 快照创建、发起人/审核人冲突、多节点独立来源及索引写入仍为 `unverified`；操作员自己的 `project.config.json` 修改未读取、未修改、未暂存、未提交。
- 2026-08-18 “业务发起人节点负责人及个人工时明细”Task 1 已按 TDD 完成：新版审核模板节点新增 `processorAssignmentMode: fixed_accounts | business_creator`；旧节点缺字段时稳定兼容为固定账号，发起人模式不允许保存占位处理人，未知值、访问器和继承值失败关闭。节点编辑页新增逐节点开关，开启时暂存并清空固定处理人、禁用手工选择，关闭时恢复本次编辑会话内的原选择；审核人、节点排序和其他节点不受影响；只读页展示相同来源且不能修改。RED：模板域、模板服务与小程序模板聚焦共 55 项中 49 通过、6 项按预期失败；GREEN：55/55，WXML 4/4，两个变更生产 JavaScript 语法通过。业务创建时解析实际发起人、处理/投票工时快照、日历补算、运营明细、CloudBase 索引和真实部署仍为 `unverified`；`project.config.json` 未触碰。
- 2026-08-18 已确认“业务发起人节点负责人及个人工时明细”架构设计：每个新版模板节点独立选择固定候选处理人或业务发起人唯一处理；创建事务解析发起人并阻断同节点处理/审核角色冲突。新审核轮次将固化实际提交人、本轮处理工作分钟和负责人来源；新投票将固化实际投票人的个人响应工作分钟，未参与者不生成记录。日历缺失不阻断写入，处理轮与投票分别保存待补算边界并由 `calendarSync` 每批不超过 40 条有界恢复；旧记录显示“历史数据未记录”，不推断回填。运营看板将新增超级管理员专用的稳定分页轮次明细，保留现有指标和 CSV 语义。设计见 `docs/superpowers/specs/2026-08-18-initiator-processor-worktime-analytics-design.md`，持久决策见 `ADR-0009`，逐项 TDD 实施计划见 `docs/superpowers/plans/2026-08-18-initiator-processor-worktime-analytics.md`；实现、索引、CloudBase 部署和多账号验收当前均为 `unverified`。操作员自己的 `project.config.json` 修改继续保持未触碰。

- 2026-08-18 微信开发者工具首次编译第二批次公开分享页时，精确复现 `pages/public-node-share/index.wxml` 第 22、28 行 `wx:else` 无法与同时带 `wx:if`/`wx:for` 的前置循环元素配对。TDD RED：增强 WXML 结构门禁后 4 项中 1 项失败，并准确报告上述两行；GREEN：字段和凭证列表改为外层条件 `block`、内层循环 `view`，WXML 门禁 4/4、公开分享页聚焦测试 1/1。下一步是在微信开发者工具重新编译，确认公开分享页不再出现 WXML 编译错误后继续第二批次 CloudBase 部署验收。

- 2026-08-17 第二批次三项能力已在隔离分支 `codex/second-batch` 完成实现并通过本地全量门禁：真实“待我处理”与概览、活动超级管理员运营看板和安全 CSV、最长七日的小程序公开只读节点快照。公开令牌由 `PUBLIC_NODE_SHARE_HMAC_SECRET` 对活动账号、业务、节点和幂等请求键执行 HMAC-SHA256 派生；中断重试恢复原预约和原过期时间，凭证按 40 条分块且有效期内由 `publicShareHoldUntil` 阻止清理。快照公开读取无需登录，只返回固化正文和五分钟 HTTPS 凭证地址；发送者通过微信原生面板手动选择好友或群。待我处理的新版账号路径在固定文档事务中重验活动账号、业务、当前节点和账号关系；纯旧 OpenID 兼容路径还会重读 `wechat_bindings`，查询后并发撤绑不会返回旧待办。最新实测：`businessApi` 540/540、`calendarSync` 50/50、`workflowReminder` 30/30、`evidenceRetention` 42/42、小程序 150/150、WXML 4/4，均 0 失败；运营聚焦 49/49、分享聚焦 29/29。当前 `main` 上操作员自己的 `project.config.json` 修改保持未触碰。真实 CloudBase 新集合、组合索引、分享密钥配置、云函数部署、真机图片/视频/PDF 预览、好友/群分享、七日到期和清理仍为 `unverified`；`evidenceRetention` 周期触发器未启用，GitHub 未推送。

- 2026-08-17 凭证保留提醒通知编号兼容已完成真实 CloudBase 验收。操作员部署最新 `businessApi` 后，原先由 `evidenceRetention` 创建且无需迁移或重建的 15 天提醒已在目标活动收件账号的通知中心直接可见；点击后能进入对应业务安全页面，没有 `FORBIDDEN`、`VALIDATION_ERROR`，也未显示永久文件编号、`cloud://` 路径、凭证哈希、OpenID、请求键或内部租约。返回并刷新通知中心后已读状态保持；数据库中只新增一条与原提醒编号和当前内部账号对应的确定性 `notification_read_marker`，`createdAt` 存在，同一提醒与账号组合无重复，原 `evidence_retention` 通知仍保留且未被覆盖。该结果关闭通知编号兼容的真实部署边界；三个定时工作器继续保持空触发器，下一次 `evidenceRetention` 幂等运行仍须单独批准。

- 2026-08-17 凭证保留提醒通知编号兼容已按确认设计完成本地 TDD 修复。真实 `evidenceRetention` Timer 已成功创建一条合法 15 天 `evidence_retention` 通知，收件账号、状态和脱敏内容均正确，但旧 `businessApi` 把确定性编号 `evidence-retention:<businessLineId>:15` 套用到不允许冒号的通用文档编号规则，导致通知列表二次授权投影时隐藏该记录，已读入口也会提前返回 `VALIDATION_ERROR`。修复新增共享纯函数，只接受既有普通通知编号或严格的 `evidence-retention:[A-Za-z0-9_-]{1,128}:(1|7|15)`；服务入口和仓储投影共用该规则，业务、节点、轮次、凭证和其他文档编号规则不变。RED：服务测试 13 项中 12 通过、1 失败，仓储测试 53 项中 52 通过、1 失败；GREEN：服务与仓储组合聚焦 66/66。完整门禁：`businessApi` 519/519、`evidenceRetention` 40/40、小程序通知 5/5、WXML 4/4，三份生产 JavaScript 语法、`git diff --check` 与项目记忆校验均通过。下一步只需重新部署 `businessApi`，无需迁移或重建现有通知，也不得再次运行清理 Timer；部署后使用当前活动收件账号核对原 15 天提醒直接可见、可安全跳转并能生成该账号的独立已读回执。真实通知中心显示、跳转与已读仍为 `unverified`，`calendarSync`、`workflowReminder`、`evidenceRetention` 继续保持 `triggers: []`；用户自己的 `project.config.json` 修改未暂存、未提交。

- 2026-08-17 `evidenceRetention` 调用授权缺口已按批准范围完成本地 TDD 修复。根因是计划工作器入口只校验 `service.runOnce` 后无条件执行，既未读取平台可信来源，也未拒绝小程序 `OPENID`，因此直接调用可进入真实预约恢复、提醒和云文件删除。RED：入口聚焦 5 项中 4 项通过、1 项失败，客户端、匿名调用及伪造事件均错误执行服务；GREEN：入口只接受严格 `process.env.TRIGGER_SRC === 'timer'` 且无非空 `OPENID`，事件载荷和微信上下文同名字段不能授权，可信 Timer 继续返回原脱敏汇总，清理算法与批次未改。随后新增生产默认装配回归，并通过临时移除 `getWXContext` 装配观察到该测试准确失败，恢复装配后聚焦 6/6、`evidenceRetention` 完整套件 40/40 通过。目标 CloudBase 重新部署、一次性 Timer 来源及破坏性隔离矩阵仍为 `unverified`；函数继续保持 `triggers: []`，在再次备份和逐项批准前不得点击控制台“测试”或创建清理触发器。

- 2026-08-14 停用参与人历史业务详情读取修复已完成真实 CloudBase 多账号验收。操作员重新部署提交 `160383d` 对应的 `businessApi` 后停用专用普通测试账号，并确认：活动且原本有权的超级管理员仍可打开包含该账号的已完成业务；节点参与人名称显示固定“（已停用）”标记；原反馈和凭证历史仍可查看；停用账号自身访问受保护页面被拒绝。业务终态、进度和只读边界保持不变，审核轮次姓名继续使用提交时固化的历史快照。该结果证明修复只恢复授权访问者的历史只读投影，没有恢复停用账号的登录、写入或审核权限。
- 2026-08-14 停用参与人历史业务详情读取缺陷已按确认方案 A 完成本地 TDD 修复。RED：新增真实仓储回归后，停用处理人所在的已完成业务详情 0/1 通过，调用栈准确落在显示名称缓存的活动状态硬限制；并列失败关闭矩阵中状态缺失、未知状态、账号缺失和名称访问器 5/5 通过。提交前安全自审又以 RED 证明状态访问器会被执行且错误放行，改为仅接受自有数据属性后该矩阵 6/6 通过。GREEN：业务详情显示缓存仅对严格 `active` 或 `disabled` 的参与账号生成安全名称，后者追加“（已停用）”；当前访问者仍必须活动且具备原业务关系，缺失账号、未知状态、不安全名称、访问器和继承值继续 `FORBIDDEN`，写入、审核、模板与提醒规则未改。聚焦仓储 77/77、`businessApi` 517/517、WXML 4/4 通过；两份变更 JavaScript 语法检查、`git diff --check` 与项目记忆校验通过。重新部署与多账号历史读取已由上一条真实验收关闭；提醒停止行为仍由既有独立验收记录覆盖。
- 2026-08-14 提醒停止条件真实验收发现独立历史读取缺陷：一名普通节点参与人被超级管理员停用后，活动且原本有权的超级管理员查看包含该参与人的已完成业务会收到 `FORBIDDEN`；重新启用普通账号后同一业务立即恢复读取。代码核对确认业务详情显示名称缓存错误地要求所有节点参与账号仍为 `active`，把历史显示条件混入了当前访问授权。项目所有者已确认方案 A：当前访问者仍须活动且满足原业务关系；参与账号严格为 `disabled` 时显示“安全名称（已停用）”，缺失、未知状态或非法名称继续失败关闭；写入、审核、登录和提醒仍要求活动账号，不迁移既有业务数据。设计见 `docs/superpowers/specs/2026-08-14-inactive-participant-business-detail-design.md`；本条发现及设计阶段状态现已由顶部的本地 TDD 与真实多账号验收证据关闭。
- 2026-08-14 `workflowReminder` 已完成真实非零候选与同小时去重验收。操作员使用两条专用隔离业务分别保留一个活动处理候选和一个待审核候选；一次性可信 Timer 正常返回 `processingCreated=1`、`reviewCreated=1`，目标数据库各新增且仅新增一条 `processing_reminder` 与 `review_reminder`。操作员脱敏核对确认：两条提醒分别只投递给当前处理人和当前未投票审核人，业务、节点及审核轮次关联正确，累计工作小时均为 1、状态为待处理、创建时间与执行窗口一致，且未包含处理说明、字段值、凭证地址、OpenID 或请求键；节点的 `nextProcessingReminderWorkHour` 与轮次的 `nextReviewReminderWorkHour` 均推进为 2。随后在同一提醒小时再次运行一次性 Timer，服务正常返回 `processingCreated=0`、`reviewCreated=0`；两类提醒仍各 1 条、编号未变化且没有重复记录，两处下一提醒小时游标也保持为 2。操作员已恢复并刷新确认 `workflowReminder` 的 `triggers: []`。该结果验证真实 CloudBase 上的非零提醒创建、当前关系路由、内容最小化、确定性同小时幂等和小时游标推进；业务完成、审核通过/驳回、账号停用、关系移除、工作流模式变化及 `pending_calendar` 等停止条件矩阵与正式小时触发器仍为 `unverified`。
- 2026-08-14 修复版 `calendarSync` 已由操作员上传目标 CloudBase，并完成真实一次性 Timer 验收。部署后先确认 `triggers: []`，再通过单次定时器运行；日志返回 `mode=scheduled`，2026 与 2027 两个完整年份均同步成功且各 365 天，待补算汇总的检查、更新、跳过、待处理与失败计数均为 0，约 4.6 秒正常结束，没有未经授权、失败重试或底层数据库/外部接口错误泄漏。操作员随后恢复并刷新确认 `triggers: []`。该结果验证修复后的服务端可信来源、当前/下一年计划同步和安全汇总在真实 CloudBase 生效；正式每日触发器仍未启用。
- 2026-08-14 修复版 `workflowReminder` 已由操作员上传目标 CloudBase，并完成真实一次性 Timer 验收。部署后先确认 `triggers: []`，再使用仅运行一次的定时器触发；日志不再出现“提醒任务调用未经授权”，服务正常返回脱敏汇总 `processingCreated=0`、`reviewCreated=0`，约 3.4 秒结束且没有失败重试。零创建表示当轮没有符合累计工作小时提醒条件的活动处理或审核候选，不是执行失败；本次没有写入提醒记录。操作员随后恢复 `triggers: []` 并确认配置为空。该结果验证 `process.env.TRIGGER_SRC=timer` 在目标环境可用、Timer 能进入真实提醒编排且响应最小化；提醒候选为非零时的真实通知创建和正式小时触发器启用仍为 `unverified`。
- 2026-08-14 真实 `workflowReminder` 一次性 Timer 验收曾暴露可信来源读取错误：控制台定时器按分钟触发并由平台重试，但每次都在服务运行前返回“提醒任务调用未经授权”，`processing_reminder` 与 `review_reminder` 均未写入；操作员立即恢复 `triggers: []`。根因是平台把可信来源提供为服务端 `process.env.TRIGGER_SRC=timer`，锁定版 `wx-server-sdk` 不会自动映射到原代码读取的 `getWXContext().TRIGGER_SRC`。项目所有者批准方案 A 后，`workflowReminder` 与同类 `calendarSync` 已改为只信任严格服务端来源并继续拒绝非空 `OPENID`；事件载荷和微信上下文同名字段均不能授权，人工日历同步票据路径不变。TDD RED：`workflowReminder` 4 项中 1 通过、3 失败，`calendarSync` 5 项中 3 通过、2 失败；GREEN：聚焦分别 4/4、5/5。完整本地回归：`businessApi` 510/510、`calendarSync` 50/50、`workflowReminder` 30/30、`evidenceRetention` 37/37、小程序 145/145、WXML 4/4，生产与测试 JavaScript 语法检查通过。设计和决策分别见 `docs/superpowers/specs/2026-08-14-trusted-timer-source-design.md` 与 `docs/memory/decisions/ADR-0007-trusted-timer-source.md`。修复提交为 `44bffcf`；`workflowReminder` 修复版部署和空候选真实 Timer 已在同日后续验证通过，`calendarSync` 修复版部署和计划入口仍为 `unverified`，用户自己的 `project.config.json` 修改继续排除在本任务之外。

- 2026-08-13 隔离业务的审核轮次—反馈—凭证引用一致性已由操作员完成脱敏核对：三条审核轮次的 `feedbackId` 均能定位到同业务、同节点、对应处理轮次且 `publishState=published` 的 `node_feedback`，轮次保存的反馈修订号与反馈记录一致；第一节点返工前后两轮引用各自独立的处理反馈，第二节点审核轮次聚合了处理期间形成的两份凭证。所有被引用凭证均为 `storageStatus=available`、`attachmentState=attached`，其反馈编号和修订号与所属反馈一致，且不存在轮次或反馈引用不到凭证记录的悬空编号。该结果关闭了本次隔离业务主链路最后一项核心数据一致性核对，证明返工、多次保存、跨轮聚合和末节点完成没有覆盖旧反馈、丢失凭证或错误归属；`workflowReminder` 与 `evidenceRetention` 的独立工作器矩阵、首次自动触发和真实清理仍未验证，三个定时函数继续保持空触发器。
- 2026-08-13 隔离业务三条审核轮次的双 SLA 终态已由操作员脱敏核对通过：处理与审核计时状态均为 `calculated`，处理/审核的已用、剩余、逾期六类工作分钟均为非负整数，处理与审核日历版本均存在，且没有残留 `pending_calendar`。该结果验证目标环境工作日历、完整分钟折算及三轮处理/审核终态计时在真实 CloudBase 一致生效；轮次对原反馈与凭证的引用一致性已在同日后续核对通过。
- 2026-08-13 隔离业务的审核与流转通知已由操作员脱敏核对通过：排除每账号已读回执后，共三条 `review_started`、一条 `node_review_rejected`、一条 `node_processing_started` 和一条 `business_completed`，数量与三轮审核、一次返工、一次下节点激活及末节点完成严格对应。六条通知均含状态、创建时间、节点、审核轮次和非空内部账号收件人数组，且不包含处理说明、字段内容、凭证信息、OpenID 或请求键原文。该结果验证真实 CloudBase 通知确定性去重、受众关联和内容最小化符合设计；双 SLA 终态数据仍待继续核对。
- 2026-08-13 隔离业务的审核审计记录已由操作员脱敏核对通过：`SUBMIT_NODE_FOR_REVIEW` 三条、`SUBMIT_REVIEW_VOTE` 三条，投票审计决策分布为一次 `rejected` 与两次 `approved`；六条记录均以 `node_review_round` 为目标类型并含非空目标编号和创建时间。审计中未出现密码、OpenID、云文件路径或文件编号、请求键原文、凭证哈希，验证真实 CloudBase 审计数量、轮次关联和敏感数据最小化符合设计；结果通知仍待继续核对。
- 2026-08-13 隔离业务的独立审核投票记录已由操作员脱敏核对通过：`node_review_votes` 共三条并分别唯一对应三个审核轮次，没有同轮重复票；第一节点第 1 轮为 `decision=rejected` 且评论存在，另外两轮为 `decision=approved` 且允许空评论；三条投票均保存 `reviewerDisplayName` 不可变显示名快照和 `createdAt`。该结果验证确定性一轮一审核人一票、持久决策枚举和显示名快照在真实 CloudBase 生效；审核提交/投票审计与结果通知仍待继续核对。
- 2026-08-13 隔离业务的审核轮次数据库记录已由操作员脱敏核对通过：共三条不可变轮次；第一节点第 1 轮为 `rejected/rejected` 且驳回原因仍存在，返工后的第 2 轮为 `approved/approved`，第二节点第 1 轮为 `approved/approved`；三条记录的 `voteCount` 均为 1 且 `decidedAt` 均存在。该结果验证返工不会覆盖旧轮次、每轮或签单票终结计数正确、末节点终态轮次完整；独立 `node_review_votes`、审计与通知记录仍待继续核对。
- 2026-08-13 末节点完成后的业务线数据库终态已由操作员脱敏核对：`status=completed`、`progress=100`、`completedAt` 与 `retentionStartedAt` 均存在，`purgeDueAt` 比保留起点晚约 60 个自然日。`currentNodeId` 仍指向最终已完成节点符合当前实现契约：末节点通过事务保留最终节点只读指针以支持终态详情、审计与凭证历史定位，不代表仍有活动节点；业务终态和节点终态继续阻断普通写入。此前把“当前节点编号为空”作为唯一预期过窄，部署手册实际允许清空或呈现服务端终态，本项无需代码修复。由于用户一次只反馈了五组结果，`purgeDueAt` 是否单独明确存在已可由“比 retentionStartedAt 晚约 60 天”推出；其余投票、审计、通知和双 SLA 终态仍待核对。
- 2026-08-13 目标真机已完成隔离业务的末节点审核主链路验收。第二节点提交后进入第 1 轮待审核且处理操作只读；审核人看到与提交一致的处理说明和凭证聚合，包括处理期间新增的一份凭证；通过意见留空仍可审核通过。末节点通过后，第二节点变为已完成，业务总进度为 100%，业务状态为已完成，两个节点均不能再由普通用户修改，两份原凭证仍可从历史记录查看。该结果证明或签末节点无意见通过、自动完成业务、终态普通写保护和处理轮凭证聚合的真机主路径通过；数据库中的唯一投票、轮次终态、审核/节点推进审计、结果通知、双 SLA 终态分钟及业务线统一 60 天保留起止字段仍需下一步逐项脱敏核对，不能仅由页面结果推断。
- 2026-08-13 操作员已在目标真机复验处理页加载态修复：保存处理进度成功后，保存、标记受阻、提交审核三个按钮均立即停止转圈并恢复可用，无需退出业务页面后重新进入。本项真实客户端验收通过；对应实现提交为 `5b3f85c`。用户自己的 `project.config.json` 修改继续未暂存、未提交。
- 2026-08-13 真机验收发现审核处理页“保存处理进度”成功并刷新反馈历史后，保存、受阻、提交审核三个按钮会持续显示加载态，退出页面再进入才恢复。根因是保存成功刷新会把节点版本从本次操作的旧版本提升到服务端新版本，而 `finally` 仍使用包含旧节点版本的严格异步写回守卫清理 `submitting`，因此合法版本变化被误判为过期操作。修复保留原 `writeStillCurrent` 作为网络结果、文件状态和业务写回的严格账号/页面/操作序号/节点/版本边界；新增不比较节点版本的页面操作所有权判断，并且只在保存进度动作的 `finally` 中用于释放加载态。RED：审核流程 18 项中 17 通过、1 项失败，页面已刷新到节点版本 5 但 `submitting` 仍为 `true`；GREEN：审核流程 18/18、处理/审核客户端聚焦 48/48、WXML 4/4。完整门禁：`businessApi` 510/510、`calendarSync` 49/49、`workflowReminder` 29/29、`evidenceRetention` 37/37、小程序 145/145，均为 0 失败；生产 JavaScript 语法与 `git diff --check` 通过。微信开发者工具重新编译及真机再次保存后，三个按钮立即恢复可用的真实验收现已通过；用户自己的 `project.config.json` 修改继续未暂存、未提交。
- 2026-08-13 审核详情“处理说明”快照修复已完成本地实现与回归。根因是审核轮次创建只聚合了字段与凭证，未把当前处理轮最新已发布反馈的 `comment` 固化进轮次，审核详情因此只能显示“本轮没有字段内容”。修复后，反馈聚合严格读取最新反馈的自有字符串 `comment`，作为 `processingComment` 纳入审核草稿摘要；创建和幂等重试均复核原反馈与草稿说明一致，轮次持久化不可变快照，详情只返回该快照。修复前旧轮次缺失字段时安全兼容为空并由客户端显示“暂无处理说明”；字段存在但非法、过长、访问器或继承值时失败关闭且不执行访问器。TDD RED：反馈/审核服务聚焦 69 项中 66 通过、3 失败；审核仓储 52 项中 46 通过、6 失败；客户端审核流程 18 项中 16 通过、2 失败。GREEN：后端组合聚焦 121/121，客户端审核流程 18/18。完整门禁：`businessApi` 510/510、`calendarSync` 49/49、`workflowReminder` 29/29、`evidenceRetention` 37/37、小程序 145/145、WXML 4/4，均为 0 失败；四个生产 JavaScript 文件语法、`git diff --check` 与项目记忆校验通过。后端实现提交为 `15b4b3c`、`1cc25fd`；当前轮次是修复前创建的旧数据，因此部署后只会显示占位，不会伪造原说明。重新部署 `businessApi`、重新编译小程序，并通过一次新处理轮保存无敏感说明、提交审核、审核详情核对原文仍为 `unverified`。用户自己的 `project.config.json` 修改继续未暂存、未提交。
- 2026-08-13 目标真机已复用原先保存的处理草稿再次提交审核，操作员确认“提交审核成功”，原先由秒级工作分钟触发的 `VERSION_CONFLICT` 已不再出现。该结果验证了完整分钟折算修复在真实提交入口生效；页面待审核状态、`node_review_rounds` 唯一轮次、处理/审核双 SLA 快照以及原反馈和凭证引用尚待下一步逐项核对，当前不据成功提示推断这些数据库结果。

- 2026-08-13 工作时长完整分钟折算已完成本地实现与自动化验证。真实秒/毫秒时间戳会使原工作时间服务输出小数分钟，审核服务因只接受安全整数而在创建审核轮次前返回 `VERSION_CONFLICT`；修复在权威 `workingMinutesBetween` 完成所有工作日秒级交集累计后统一向下折算一次，保留精确时间戳、日历缺失语义及 `workflowReminder` 秒级提醒阈值。TDD RED：工作时间测试 11 项中 9 通过、2 失败，实际得到 `59.999983…` 与 `1.016666…`；审核服务测试 11 项中 9 通过、2 项以 `VERSION_CONFLICT` 失败。GREEN：两文件聚焦 22/22。完整门禁：`businessApi` 506/506、`calendarSync` 49/49、`workflowReminder` 29/29、`evidenceRetention` 37/37、小程序 144/144、WXML 4/4，均为 0 失败；生产文件语法和实现差异检查通过。实现提交为 `de3f680`，只包含工作时间服务及两份测试；用户自己的 `project.config.json` 修改未暂存、未提交。真实 CloudBase 尚未部署本提交，真机复用现有已保存草稿再次提交审核、生成审核轮次并确认原凭证引用保持不变仍为 `unverified`。

- 2026-08-13 工作时长完整分钟折算设计已由项目所有者确认，实施计划已写入 `docs/superpowers/plans/2026-08-13-work-minute-rounding.md`。计划把修复限制在 `businessApi` 权威工作时间服务的累计输出边界，并以真实工作时间服务组合测试覆盖提交审核与审核投票的秒级时间；生产代码尚未修改，RED/GREEN、全量回归、重新部署和真机复验仍为 `unverified`。执行时必须保留用户未提交的 `project.config.json` 修改。
- 2026-08-13 真实 CloudBase 隔离验收中，处理进度、最新反馈指针、反馈修订、凭证关联与节点版本均核对正常，但提交审核稳定返回 `VERSION_CONFLICT`，且 `node_review_rounds` 保持空。根因已定位为 `businessApi` 工作时间服务会从真实秒/毫秒时间戳计算出非整数工作分钟，而审核服务与审核事务只接受安全整数的已用、剩余和逾期分钟，导致合法时长在审核轮次落库前被误判为快照冲突。项目所有者已批准方案 A：需要持久化的工作时长统一按已经完整经过的分钟向下取整，精确时间戳保留，`workflowReminder` 的秒级阈值语义不变；设计见 `docs/superpowers/specs/2026-08-13-work-minute-rounding-design.md`。生产实现、自动化回归、`businessApi` 重新部署及复用现有草稿提交审核仍为 `unverified`；不得手工修改现有节点、反馈或凭证记录。用户已有 `project.config.json` 修改继续保持未暂存、未提交。

- 2026-08-13 真机隔离验收在 JPG 云存储上传及 `evidences` 元数据登记成功后，“保存处理进度”曾返回 `VALIDATION_ERROR`。根因定位为受保护动作 `submitFeedback` 的默认路由无条件调用旧版 `feedbackService.submitFeedback`，导致带 `action: save_progress` 的新版审核节点载荷在旧输入白名单处被拒绝；上传、凭证登记和可选凭证格式策略本身均已通过该次验收。修复保持客户端协议不变：含自有数据属性 `action` 的载荷进入 `saveNodeProgress`，无 `action` 的旧节点载荷仍进入旧 `submitFeedback`，节点类型、当前账号、节点版本与业务状态继续由服务端权威校验。RED 为路由聚焦 40 项中 38 通过、2 项失败，准确复现错误分派和真实服务 `VALIDATION_ERROR`；GREEN 为路由聚焦 40/40，完整 `businessApi` 502/502、WXML 4/4、生产入口语法与 `git diff --check` 通过。修复版 `businessApi` 已重新部署，目标真机再次保存处理进度成功：页面生成“处理中・第 1 版”反馈历史，处理说明持久化，已登记 JPG 出现在该版本且提供查看入口；保存后待上传区清空为 0 B，符合“本地待提交文件已消费、历史引用保留”的设计。下一步为不重新选择文件，直接提交审核并验证服务端聚合本处理轮已保存凭证；用户已有 `project.config.json` 修改未暂存、未提交。

- 2026-08-13 可选凭证规则方案 A 已完成最终复审修复与本地完整回归。先前四项 Important 的服务端白名单索引、新旧 Schema 混存、客户端索引访问器和上传/下载安全状态均已修复；但最终复审进一步发现，上传失败虽写入固定文件状态，原始异常仍会越过上传层并被保存进度或提交审核的外层 Toast 展示。提交 `a2c871f` 将该异常转换为固定 `EVIDENCE_UPLOAD_FAILED` 安全错误，RED 为节点反馈聚焦 17/18，GREEN 为 18/18，Task 3 聚焦最终 47/47。此前服务端提交 `481d374` 的 RED 为仓储聚焦 45 个通过、4 个失败，GREEN 为凭证聚焦 55/55；客户端提交 `ade8596` 的 RED 为节点反馈聚焦 14 个通过、3 个失败，GREEN 为 17/17。最终完整门禁：`businessApi` 502/502、`calendarSync` 49/49、`workflowReminder` 29/29、`evidenceRetention` 37/37、小程序 144/144、WXML 4/4；三份生产 JavaScript 的 `node --check`、`git diff --check` 与项目记忆校验均通过。稳定规则不变：只有严格合法的“非必传 + 空白名单”扩展为 JPG/JPEG/PNG/PDF/MP4/MOV/M4V，必传空白名单、非空限制之外的格式和损坏结构均失败关闭；既有业务无需迁移，60 天保留协议不变。`businessApi` 重新上传、微信开发者工具重新编译、目标真机以非敏感 JPG 复验凭证登记与“保存处理进度”、真实 CloudBase 数据/并发及遗留无元数据测试云文件的人工清理仍为 `unverified`；`project.config.json` 未改动、未暂存也未提交。

- 2026-08-13 真机隔离验收确认可选凭证规则不一致：`requiresEvidence: false` 且 `allowedEvidenceTypes: []` 的节点在小程序可选择文件，但服务端登记返回 `UNSUPPORTED_FILE_TYPE`；云存储已有测试文件而 `evidences` 无新记录，因此根因确认为“非必传的空白名单在前后端语义不一致”，不是手机图片编码或云存储故障。用户已批准方案 A：非必传 + 空白名单表示凭证可选且允许全部已支持格式；非必传 + 非空白名单仍只允许指定格式；必传凭证仍要求非空白名单。设计见 `docs/superpowers/specs/2026-08-13-optional-evidence-policy-design.md`；生产实现、自动化回归、云函数部署和真机复验仍未验证，诊断产生的无元数据测试云文件待手动清理。

- 2026-08-12 隔离验收发现新版业务初始截止状态显示不准确：业务创建时首节点处理已经按创建时刻启动并正确计算截止时间，但快照未显式保存 `reviewRoundNumber: 0`、审核 `not_started` 状态及后续节点处理 `not_started` 状态，页面因而显示“待计算”。本轮按 RED→GREEN 修复：新快照明确保存初始处理/审核状态，首节点原 `processingStartedAt` 与已计算或待补算处理截止保持不变；对修复前已创建的记录，仅当后续节点仍为 `waiting` 且未开始处理，或审核轮次为 0 且未开始审核时，安全投影兼容为 `not_started`，活动阶段缺失状态继续失败关闭。RED 为业务仓储 70 项中 2 项预期失败；GREEN 为业务仓储 70/70，完整回归 `businessApi` 491/491、`calendarSync` 49/49、`workflowReminder` 29/29、`evidenceRetention` 37/37、小程序 134/134、WXML 4/4。真实 CloudBase 修复版 `businessApi` 重新部署及开发者工具页面刷新仍未验证；本地 `project.config.json` 操作员修改继续排除在本次提交之外。

- 2026-08-12 真实 CloudBase 人工工作日历同步发现 AILCC `allyear` 响应年份契约兼容问题：官方接口文档使用四位数字字符串（如 `"2026"`），原解析器只接受数字，导致合法响应被按年份安全归类为 `SYNC_FAILED`。本轮按 RED→GREEN 将解析边界收紧为“严格相等的安全整数或其精确十进制字符串”，继续拒绝空白、前导零、小数、符号、错年及其他类型；内部年份和持久化结构仍为数字，全年日期、计数、唯一性与 `is_holiday` 0/1 校验不变。RED 为聚焦 7 项中 1 项预期失败；GREEN 为聚焦 7/7、`calendarSync` 49/49、`businessApi` 490/490、`workflowReminder` 29/29、`evidenceRetention` 37/37、小程序 134/134、WXML 4/4。目标环境已人工确认四个云函数上传、`businessApi` 与 `calendarSync` 超时 60 秒，以及三个定时函数空触发器；修复后的 `calendarSync` 重新部署和真实 2026/2027 数据同步仍未验证，第三方接口不可用或下一年度数据未发布时应继续逐年安全失败。

- 2026-08-12 节点独立审核流程 Task 11-R2 修复轮次 1 已解决旧版保留游标升级阻塞。新版游标明确区分 `schemaVersion: 2` 与独立乐观 `revision`；读取严格合法的旧 `{phase, afterId}` 时，在小事务内 CAS 自动迁移到同 phase 起点，不用旧编号推断到期排序值，只保存 SHA-256 摘要和安全迁移标志。并发迁移恰一写；CAS 竞争可安全重复交付已读页面但不额外扫描，确定性提醒/预约/租约保持幂等；损坏旧游标、新版游标损坏和修订溢出继续失败关闭。完整本地回归：`businessApi` 490/490、`calendarSync` 47/47、`workflowReminder` 29/29、`evidenceRetention` 37/37、小程序 134/134、WXML 4/4；真实 CloudBase 事务冲突行为、游标迁移、复合索引选择、云函数部署和触发器仍未验证，`evidenceRetention` 继续保持 `triggers: []`。完整证据记录在 `.superpowers/sdd/2026-08-11-node-review-workflow/task-11-r2-report.md`。

- 2026-08-12 节点独立审核流程 Task 11-R2 已修复最终复审遗留的两项保留工作器 Important。生产入口、服务默认值与合法批次统一为 1—40，生产默认装配空扫描回归不再以 50 触发仓库拒绝；所有范围阶段按其权威到期/租约字段升序再按 `_id` 升序，持久游标保存严格可序列化的 `afterSortValue + afterId`，CloudBase 无元组 OR 时以两段有界查询实现严格后继且合计原始扫描不超过 40。回归覆盖相同到期值跨页不丢不重、排序值与编号混排、损坏游标失败关闭、40 条坏记录后第 41 条可达、页尾轮转/回绕、崩溃重交付及查询排序/手册索引一致。完整本地回归：`businessApi` 490/490、`calendarSync` 47/47、`workflowReminder` 29/29、`evidenceRetention` 32/32、小程序 134/134、WXML 4/4；真实 CloudBase 两段范围查询的复合索引选择、云函数部署和触发器仍未验证，`evidenceRetention` 继续保持 `triggers: []`。RED/GREEN 与最终证据记录在 `.superpowers/sdd/2026-08-11-node-review-workflow/task-11-r2-report.md`。

- 2026-08-12 最终集中修复波次已完成生产实现：新版审核节点凭证登记按 `workflowMode` 严格使用处理人账号关系，混合/损坏关系即使业务负责人也不能绕过；模板、启用、普通可用性、业务快照和三类通知写入统一执行最多 50 项/768 字节保守 BSON 索引预算，并保留创建者位与 100 次事务预算；审核轮次固化处理人/审核人显示名，旧轮次仅用固定安全占位；保留工作器改为状态/到期精确查询、单次最多 40 条原始记录和持久 keyset 阶段游标，覆盖反馈、节点锁、审计修订、提醒、两类保留及孤立凭证，游标损坏失败关闭且崩溃后安全回绕；纯旧 OpenID 业务提醒降级为超级管理员角色受众，并在事务中修复已有同编号空受众记录。最终本地回归为 `businessApi` 490/490、`calendarSync` 47/47、`workflowReminder` 29/29、`evidenceRetention` 26/26、小程序 134/134、WXML 4/4；20 个变更/新增 JavaScript 文件语法、`git diff --check` 和项目记忆校验均通过。聚焦 RED/GREEN 证据记录在 `.superpowers/sdd/2026-08-11-node-review-workflow/final-fix-report.md`。真实 CloudBase 768 字节保守模型、复合索引选择、云函数部署和触发器仍未验证；`evidenceRetention` 继续保持 `triggers: []`。

- 2026-08-12 节点独立审核流程 Task 11 正式修复轮次 1 已完成。RED 稳定复现：部署手册曾在隔离验收后要求写入非空 `evidenceRetention` 触发器；新版审核当前节点仍可显示并调用旧“驳回上一节点”路径。GREEN 已删除本次所有非空 `evidenceRetention` 操作，仅允许核验或恢复 `triggers: []`，并将 `calendarSync` 每日同步、`workflowReminder` 小时提醒改为隔离验收后独立批准；备份允许尚未创建的审核/日历新集合并完整覆盖 `work_calendar_entries`、`work_calendar_years`、`calendar_sync_requests`，不再把 `work_calendar` 作为当前主存储；索引表按真实 `.where().orderBy()` 增补审核待办、投票、双提醒扫描、待补算扫描和通知分页复合索引，并由文档契约测试防漂移。真实反馈服务证明旧节点仍可完成，新审核节点的旧完成与旧驳回均在服务端失败关闭，业务详情也不再展示旧驳回；跨包测试使用真实处理/审核提醒编号及实际 `evidence-retention:` 前缀验证不碰撞。隔离验收矩阵新增末节点审核完成及轮次、投票、审计、结果通知、双 SLA、待补算恢复和原凭证引用的集中核对；发布记录为 `businessApi` 与 `evidenceRetention` 增加“未验证”。本地完整回归：`businessApi` 479/479、`calendarSync` 47/47、`workflowReminder` 28/28、`evidenceRetention` 19/19、小程序 134/134、WXML 4/4，7 个变更 JavaScript 语法检查、`git diff --check` 和项目记忆校验均通过（npm 仅输出既有 malformed user-config 警告）。真实 CloudBase 集合/索引/云函数/触发器、微信开发者工具、多账号并发和工作日历数据覆盖均未验证，必须由目标环境操作员按手册逐项验收。

## Verified state

- 2026-08-12 节点独立审核流程 Task 11 完成最终兼容、安全回归与部署验收资料。本地兼容矩阵覆盖旧节点经受保护反馈流程读取且不补造审核轮次、新审核节点不出现旧直接完成/驳回入口且不能通过未知旧路由伪造轮次；提交、投票与幂等重试对账号停用、关系移除、角色/模式变化、业务冻结和版本变化均以既有安全错误失败关闭且不写入；审核详情投影不返回凭据、OpenID、云文件编号、哈希、租约或请求摘要；处理/审核提醒以不同确定性编号保留；日历缺失不阻断业务创建、审核提交、驳回返工或节点推进，只保留待补算边界。中文部署手册已补充 `node_review_rounds`、`node_review_votes`、`work_calendar`，`node_review_votes(reviewRoundId ASC, reviewerUserId ASC)` 唯一索引，审核轮次节点时间线/业务状态/审核人待办与投票业务节点时间线索引，以及 `businessApi`、`calendarSync`、`workflowReminder` 的上传、空触发器、隔离验收和回退顺序；`evidenceRetention` 继续保持 `triggers: []`。本地完整回归：`businessApi` 477/477、`calendarSync` 47/47、`workflowReminder` 28/28、`evidenceRetention` 19/19、小程序 133/133、WXML 4/4；5 个 JavaScript 语法检查、`git diff --check` 和项目记忆校验均通过（npm 仅输出既有 malformed user-config 警告）。真实 CloudBase 集合、索引、云函数、触发器、微信开发者工具、多账号并发和工作日历数据覆盖均未验证，必须由目标环境操作员按手册逐项验收。

- 2026-08-12 节点独立审核流程 Task 10 已完成本地实现、正式复审修复轮次一与回归。新增可独立部署的 `workflowReminder` 云函数；计划入口只信任平台 `getWXContext().TRIGGER_SRC === 'timer'` 并使用服务端时钟，忽略事件载荷中的类型、时间和批量。工作时间固定为上海 09:00—20:00、无午休，日历缺失或损坏时失败关闭；处理与审核候选每周期合计不超过 40，并分别用安全扫描游标推进。复审修复使工作分钟支持秒/毫秒形成的非负有限小数，59:59.999 不提前提醒而 60:00 后可提醒；审核列表返回原始页末游标，因此整页 40 条坏记录不会阻塞第 41 条合法记录，损坏游标仍失败关闭。通知编号分别由节点编号与累计工作小时，以及审核轮次、审核账号与累计工作小时确定性生成；通知和下一小时游标在固定文档事务中原子写入。审核候选读取会用权威票总数、通过票数和完整确定性票据相互校验；创建事务重新读取活动业务、当前节点、轮次、目标内部账号、目标确定性投票和既有通知，并核对候选聚合快照，服务编排仅在本小时最后一个未投票审核人事务中推进小时游标，近 100 人最坏夹具的单事务固定文档操作不超过 100；若前序审核人事务失败关闭，最后一人事务不会推进该小时游标。会签只提醒未投票审核人，或签任一通过、所有模式任一驳回、坏票、停用账号、终态业务、换轮次和 `pending_calendar` 均停止小时提醒，既有管理员日历告警保持不变；通知正文仅含允许字段，不保存业务字段、凭证、OpenID、请求摘要或预约信息。复审修复 RED 聚焦命令为 12 通过、8 失败，另以最坏态稳定复现事务操作数超过 100；GREEN 为 `workflowReminder` 28/28、`businessApi` 473/473、`calendarSync` 47/47、`evidenceRetention` 19/19、小程序 131/131、WXML 4/4。真实 CloudBase 部署、Timer 来源形状、复合索引、权限、线上事务并发与触发器仍未验证；触发器和 Task 11 部署资料均未修改。

- 2026-08-12 节点独立审核流程 Task 9 正式复审修复轮次 3 已完成本地实现与回归。冻结业务审计修订页的凭证预览错误现在固定显示“凭证暂时无法打开”，不再通过通用中文消息判断透传微信下载或打开文档错误；即使原错误以中文开头并携带 `errCode`、`cloud://` 路径或其他底层详情，也不会泄漏。共享 `getEvidenceAccess` 的静默调用策略和其他页面保持不变。TDD RED 为审计修订聚焦 11 项中 9 项通过、下载与打开失败 2 项按预期失败；GREEN 为 11/11，反馈/审核聚焦 25/25、WXML 4/4。最终本地回归为小程序 131/131、`businessApi` 473/473、`calendarSync` 47/47，变更 JavaScript 语法、`git diff --check` 与项目记忆校验通过。真实微信下载/打开错误、开发者工具视觉交互、真机凭证预览和真实 CloudBase 仍未验证。

- 2026-08-12 节点独立审核流程 Task 9 正式复审修复轮次 2 已完成本地实现与回归。保存处理进度、标记受阻和提交审核现在都在创建不可变操作快照、占用写序号、生成请求键或进入提交态之前捕获动态字段校验错误，以既有中文字段提示返回且不污染任何写操作状态。冻结业务审计修订页为静默凭证临时授权补充页面级中文安全兜底，权限、过期、网络和预览异常不再向用户暴露原始错误码或存储详情。TDD RED 为小程序聚焦 24 项中 22 项通过、2 项按预期失败；GREEN 为 24/24，旧节点反馈 10/10、WXML 4/4。最终本地回归为小程序 129/129、`businessApi` 473/473、`calendarSync` 47/47，变更 JavaScript 语法、`git diff --check` 与项目记忆校验通过。真实 CloudBase、微信开发者工具视觉/禁用态、真机凭证上传预览和真实网络故障仍未验证。

- 2026-08-12 节点独立审核流程 Task 9 正式复审修复轮次 1 已完成本地实现与回归。节点处理页从提交开始冻结状态、动态字段、说明、选项及文件操作，并用不可变操作快照固定账号、写序号、业务/节点编号、节点版本、两类请求键和草稿载荷；每次异步返回及上传异常路径都复核该快照，旧账号、已卸载页面、旧序号或旧节点版本不再写回文件或提交状态。审核详情的安全投影现在直接提供处理人与审核人显示名，非业务成员超级管理员不再追加调用成员专用业务详情；审核详情与凭证临时授权统一使用静默调用和中文安全错误。旧节点反馈的凭证上传也沿用相同操作守卫且保持原流程兼容。TDD RED：小程序聚焦 11 项中 7 项通过、4 项按预期失败，云端审核仓储 45 项中 44 项通过、1 项按预期失败；补充凭证授权静默错误 RED 为 14 项中 13 项通过、1 项按预期失败；旧流程兼容 RED 为 10 项中 9 项通过、1 项按预期失败。最终本地回归为小程序 127/127、`businessApi` 473/473、`calendarSync` 47/47、WXML 4/4，变更 JavaScript 语法、`git diff --check` 与项目记忆校验通过。真实 CloudBase 部署、微信开发者工具视觉/禁用态、账号切换、多账号并发、网络中断及真机凭证上传预览仍未验证。

- 2026-08-11 节点独立审核流程 Task 9 已完成本地实现与回归。小程序新增审核待办、审核详情和消息通知页面；概览页显示真实待审核数与未读数；业务详情和节点处理页显示处理人、审核人、轮次、处理/审核截止与逾期状态，并通过 `onShow` 采用服务端最新节点。新版处理页仅允许保存进度、标记受阻和提交审核，待审核及终态内容只读；旧业务流程保持兼容。提交审核采用“两步幂等”流程：处理草稿保存结果持久化并返回新的 `nodeVersion`，后续审核提交使用该服务端版本；第二步失败时分别固定复用草稿请求键、原节点版本、审核请求键和新节点版本，已保存草稿与本地文件保持锁定，可直接重试。单独保存进度后清除已登记本地文件，并从服务端最新反馈恢复字段草稿；未修改时可直接提交当前服务端草稿，重新进入后若修改字段或说明则先用新请求键保存修改，再使用返回的节点版本提交审核，当前处理轮已有凭证由服务端统一聚合。审核投票携带轮次版本和稳定请求键，驳回原因必填，请求键同时绑定决策、轮次版本和规范化意见；结果以重新读取服务端为准。页面写回均检查当前账号、页面存活状态、请求序号及对应业务/节点/轮次，同页账号切换允许新请求抢占旧加载状态；通知导航只使用服务端编号，错误信息采用中文安全兜底。TDD 初始 RED 为 30 项中 22 通过、8 项按预期失败；版本衔接补强 RED 为 60 项中 58 通过、2 项按预期失败；草稿锁定补强 RED 为 5 项中 4 通过、1 项按预期失败；进度保存恢复补强 RED 为 6 项中 5 通过、1 项按预期失败；独立审查补强 RED 为 11 项中 8 通过、3 项按预期失败；重进草稿修改补强 RED 为 8 项中 7 通过、1 项按预期失败。最终独立复核为 Critical 0、Important 0；最终本地回归为小程序 121/121、`businessApi` 473/473、`calendarSync` 47/47、WXML 4/4，JavaScript 语法与 `git diff --check` 通过。概览页审核与通知计数当前受服务端分页窗口限制，单类超过 100 条时不能给出严格总数，后续应由服务端提供汇总计数或明确“100+”语义。真实 CloudBase 部署、微信开发者工具视觉交互、多账号真机并发和凭证预览仍未验证。

- 2026-08-11 节点独立审核流程 Task 8 正式复审修复轮次 2 已完成本地实现与回归。业务详情安全投影现在兼容真实历史节点：当节点没有 `workflowMode: review`、`requiresEvidence` 为真且仅保存旧字段 `evidenceTypes` 时，会使用既有图片、PDF、视频类型白名单严格校验，并只以响应字段 `allowedEvidenceTypes` 返回，旧字段本身和其他内部属性不会泄漏。新版审核节点仍只接受自有数据属性 `allowedEvidenceTypes`，不会回退旧 `evidenceTypes`；新旧字段混用、非法或重复类型、非数组、字段/数组访问器、原型链继承值均失败关闭且不执行访问器。旧节点 `requiresEvidence: false` 的默认兼容行为保持不变。TDD RED 为业务仓储聚焦测试 66 项中 64 通过、2 项按预期失败；GREEN 为 66/66。最终本地回归为 `businessApi` 473/473、`calendarSync` 47/47、小程序 109/109、WXML 3/3。真实 CloudBase 部署和历史节点端到端读取仍未验证。
- 2026-08-11 节点独立审核流程 Task 8 正式复审修复轮次 1 已完成本地实现与回归。业务详情的旧、新节点安全投影均恢复 `fieldDefinitions`、`requiresEvidence` 与 `allowedEvidenceTypes`，字段定义按现有字段域重新规范化并只返回稳定字段标识、顺序、名称、说明、类型、必填标记和类型约束，未知内部属性被剥离，损坏结构失败关闭；因此现有动态反馈表单与图片、PDF、视频凭证策略不再因脱敏投影丢失。单次业务详情先汇总全部审核处理人、审核人及账号制旧负责人，在请求内按账号编号去重读取并缓存安全显示名；48 节点、46 名不同负责人只解析读取 46 次且重复显示一致，不缓存账号对象或跨请求复用。待办和通知在原有候选初验后增加返回前最后一轮固定文档事务复核：待办重新读取活动账号、业务、节点、审核轮次和确定性投票，通知重新读取活动账号、通知和当前账号已读回执；查询期间撤销成员、审核人、定向受众或超级管理员角色后不再返回旧结果。通知白名单新增后续合法的 `processing_reminder` 与 `review_reminder`，未知类型和普通账号无权角色提醒仍隐藏。TDD RED 聚焦 110 项中 104 通过、6 项按预期失败；GREEN 为 110/110。最终本地回归为 `businessApi` 472/472、`calendarSync` 47/47、小程序 109/109、WXML 3/3，四个改动 JavaScript 文件语法检查通过。真实 CloudBase 索引、并发撤权时序、部署和微信开发者工具端到端交互仍未验证。

- 2026-08-11 节点独立审核流程 Task 8 已完成本地实现：默认 `businessApi` 已装配审核服务与工作时间服务，并开放 `submitNodeForReview`、`submitReviewVote`、`listMyPendingReviews`、`getReviewDetail`、`listMyNotifications`、`markNotificationRead` 六个受保护动作。路由只使用会话解析出的当前账号，客户端伪造身份字段会被剥离，其他未知字段和越界分页会在服务调用前拒绝。待办、审核详情和通知查询都先读取当前活动账号，再在固定文档事务中复核业务、节点、审核轮次和账号关系；`creating` 业务不会出现在任何读取边界，缺失与无权审核详情统一返回 `FORBIDDEN`。审核详情只返回字段快照、凭证编号、安全显示名、审核模式、截止与逾期状态及当前账号动作权限；业务详情只返回负责人显示名、双轮次、双截止、双逾期和安全状态，不返回内部账号编号、OpenID、凭据、请求摘要、租约或预约字段。通知支持定向账号和既有 `super_admin` 角色告警，已读状态使用同一集合内由“通知编号 + 当前账号编号”确定性生成的每账号 `notification_read_marker` 回执，避免共享数组无界增长或第 51 个管理员无法标记；旧 `readByUserIds` 只作严格兼容读取，结构损坏时失败关闭。初始 RED 为 147 项中 140 通过、7 项预期失败；聚焦 GREEN 在补强回归前达到 147/147。最终本地回归为 `businessApi` 467/467、`calendarSync` 47/47、小程序 109/109、WXML 3/3。真实 CloudBase 部署、索引适配、角色通知回执写入和微信开发者工具端到端交互仍未验证；Task 9 才实现客户端审核与通知页面。

- 2026-08-11 节点独立审核流程 Task 7 正式复审修复轮次 1 已完成本地实现与回归。客户端投票语义仍为 `approve/reject`，投票、轮次结论和审计持久化统一为 `approved/rejected`；投票显示名来自事务内活动账号的自有数据属性，合法显示名缺失时只回退到合法用户名，访问器、继承值或损坏字段失败关闭且不会执行。每个最终审核投票按工作日历结算审核开始至决定时刻的已用、剩余和逾期工作分钟；日历缺失仍允许通过或驳回，并在不可变终态轮次保存独立审核时长补算边界与确定性脱敏告警。`calendarSync` 使用 `calendar-review-timing-carryover-cursor` 和每批不超过 40 条的独立公平扫描，在返工、多轮审核、下游推进或业务完成后仍只修正时序元数据；处理时长长期满批时仍为审核时长保留进度，并发只签发一批，游标签发后工作器崩溃也会回绕重取。候选、事务写回和告警均重新绑定终态轮次的审核开始、决定时间、审核 SLA 与 pending 算术快照。同一轮处理与审核两类补算可分别解决，终态重试仅接受零、一或两次合法系统补算对应的精确双版本链。新增真实重叠的或签通过/驳回竞争回归，断言回调重叠、事务冲突和重试均发生且仅有一个终态、投票、审计和结果通知。正式复审初始聚焦 RED 为 72 项中 59 通过、13 项按预期失败；补强的末节点缺日历告警、不可变边界篡改、显示名访问器、跨类型饥饿与损坏终态快照测试也先失败再转绿。最终审核聚焦 42/42、日历聚焦 37/37、`businessApi` 455/455、`calendarSync` 47/47。真实 CloudBase 仍未验证；部署前新增并验证 `node_review_rounds(reviewTimingCarryoverStatus ASC, _id ASC)` 组合索引，且现有两个历史补算索引也必须保持有效。

- 2026-08-11 节点独立审核流程 Task 7 已完成本地实现与回归。新增 `submitReviewVote` 服务与 CloudBase 仓储，投票输入固定为审核轮次、期望轮次版本、`approve/reject`、意见和请求键；请求键只保存 SHA-256 摘要，投票编号由轮次与审核人确定性生成。最终投票事务按账号、业务线、当前节点、审核轮次顺序重读并在读取既有投票前重新校验活动状态、当前关系、审核人快照、双向轮次锁和版本；或签首个有效通过只推进一次，会签全部快照审核人通过才推进，任一驳回立即结束本轮并恢复剩余处理分钟进入新处理轮。通过会完成并冻结当前节点，激活下一节点并计算处理截止，或在末节点完成业务线并建立统一 60 天凭证保留期。两轮独立复审发现的重要边界均已用补强 RED 修复：最终投票响应丢失后的重试仍先完成当前授权再读取确定性投票，终态固化锁版本、节点版本、轮次版本、审核模式和双轮次语义，只接受原终态或该轮待补算处理段明确解决后各提升一次的唯一版本链；处理时间仍为 `pending_calendar` 就立即通过或驳回时，补算边界绑定不可变审核轮次而非节点即时状态，`calendarSync` 使用独立持久游标有界扫描，因此再次提交审核或下游继续推进后仍可补算。补算事务直接返工为 3 次读取和 2 次写入，再次待审核时最多 4 次读取和 3 次写入并同步活动轮次累计值及双向锁；通过后只修正历史与累计值，不回滚流转。日历仍缺失时保留待补算状态并写安全管理员告警。测试用 CloudBase 数据库改为真实重叠的乐观事务模型，可观测冲突与回调重试，确定性投票、审计和通知保证唯一提交；事务操作数门禁保持不超过 100。初始 TDD RED 为 30 项中 19 通过、11 项按预期失败；两轮复审补强 RED 均精确失败后转绿，第三轮独立终审未发现核心流转的 Critical/Important，其发现的新游标索引手册漏项已补入正式部署手册。最终审核/反馈/fake 聚焦 90/90、`businessApi` 446/446、`calendarSync` 40/40、小程序 109/109、WXML 3/3。真实 CloudBase 并发重试、部署、索引与微信开发者工具交互仍未验证；部署前需按手册新增并验证 `node_review_rounds(processingCarryoverStatus ASC, _id ASC)` 组合索引；Task 8 负责路由和客户端接入。

- 2026-08-11 节点独立审核流程 Task 6 正式复审修复轮次 4 已完成本地实现与回归。审核仓储现在要求业务线 `managerUserIds` 与 `memberUserIds` 都是自有数据属性、严格合法且非空的内部账号数组；即使当前处理人在另一数组中，只要任一关系数组为空、缺失或非法，审核轮次创建、幂等预检和最终重试都会失败关闭。TDD RED 精确复现空管理人和空成员两项错误放行；GREEN 后反馈与审核聚焦 69/69、`businessApi` 430/430、`calendarSync` 34/34、小程序 109/109、WXML 3/3。真实 CloudBase 事务和部署联动仍未验证。

- 2026-08-11 节点独立审核流程 Task 6 正式复审修复轮次 3 已完成本地实现与回归。审核提交的原始节点版本固定保存在 `submittedNodeVersion`，当前锁一致性改由 `business_nodes.version === node_review_rounds.lockedNodeVersion` 与双向活动轮次关系验证；因此日历补算原子同步提升节点和轮次锁版本后，同请求仍可幂等返回，而任一侧版本、原提交版本或活动轮次被单独改变都会失败关闭。反馈与审核仓储共享账号关系结构检查：沿对象及原型链只读取属性描述符，不触发访问器；只要管理人、成员、处理人、审核人或旧流程负责人任一新结构标记存在，就禁止回退 OpenID，且实际授权数组仍必须是自有数据属性和严格内部账号数组。TDD RED 精确复现 3 项失败；GREEN 后反馈与审核聚焦 67/67、`businessApi` 428/428、`calendarSync` 34/34、小程序 109/109、WXML 3/3。真实 CloudBase 事务和部署联动仍未验证。

- 2026-08-11 节点独立审核流程 Task 6 正式复审修复轮次 2 已完成本地实现与回归。待审核同请求重试现在先重新授权并取得活动轮次编号，再从锁定的最新反馈和分页凭证重建完整草稿，最后在事务内再次复核账号、活动业务、当前节点、处理角色、锁定版本、活动轮次和最新反馈；审核轮次自身的草稿摘要、反馈关系、字段、凭证顺序或总量任一被篡改均返回受控冲突。业务线与节点账号关系字段逐项要求自有数据属性和严格内部账号数组，访问器或继承数组不能授权且不会回退 OpenID。`feedbackEvidenceOrder` 只有完全缺失时才走旧记录兼容；字段存在但非法、上溢、继承、访问器或重复时失败关闭。`calendarSync` 以 `system_settings/calendar-review-processing-cursor` 持久游标对 `processingTimingStatus` 候选执行每次不超过 40 条的有界公平扫描，40 条失效记录不会永久遮挡第 41 条有效记录，尾页后安全回绕，损坏游标失败关闭；已逾期处理快照会累加历史超时与本段工作分钟。聚焦反馈与审核测试 67/67、`businessApi` 全量 425/425、`calendarSync` 全量 34/34、小程序 109/109、WXML 3/3；真实 CloudBase 事务、游标文档、索引和部署仍未验证。
- 2026-08-11 节点独立审核流程 Task 6 正式复审修复轮次 1 已完成本地实现与回归。提交审核现在先执行服务端幂等预检，但仅在事务重新校验活动账号、活动业务、当前节点、处理人关系、锁定版本及审核轮关系后才返回既有轮次；同请求同输入幂等，变更请求或输入冲突。新版进度的已发布早返回、迟到认领、终结和竞争等待路径全部重验活动业务、当前节点、处理状态、期望版本、处理轮次及最新反馈关系，进入 `pending_review` 后旧处理请求必须拒绝；旧流程保持原语义。新账号关系数组现按自有属性选择模式，并对非空、内部账号编号、重复和角色交集严格失败关闭，不回退 OpenID。凭证认领持久化跨分块的 `feedbackEvidenceOrder`，105 条凭证也保留首次选择顺序，旧记录缺少顺序时确定性兼容。提交时处理时长因日历缺失保存为 `pending_calendar` 后，`calendarSync` 已有可达的补算路径：批次不超过 40，单条以 3 次读取和 2 次写入的事务同步更新节点与活动审核轮次。本轮 TDD RED 分别暴露幂等预检 2 项、进度重试 3 项、账号模式 1 项、日历补算 4 项和凭证顺序 2 项失败；GREEN 后反馈仓储 51/51、日历与审核聚焦 29/29。全量 `businessApi` 420/420、`calendarSync` 31/31、小程序 109/109、WXML 3/3。真实 CloudBase 仍未验证；部署前需新增并验证 `business_nodes(processingTimingStatus ASC, _id ASC)` 组合索引。
- 2026-08-11 节点独立审核流程 Task 6 已完成本地实现：新版审核节点的处理人只能保存进度或标记受阻，受阻原因必填，旧 `submitFeedback` 对新版节点安全返回 `NODE_PENDING_REVIEW`，包括已发布精确重试也不得绕过；旧节点兼容路径保持不变。提交审核会重新校验活动账号、业务、当前节点、处理人身份、节点版本和处理轮次，按 `_id` 稳定排序并每页 100 条合并当前处理轮不可变反馈，字段采用最新修订快照，凭证采用全部仍有效且归属一致的记录并按首次出现去重，精确执行单次 20 MB 上限。审核轮次编号固定为 `review-${feedbackId}`，事务原子写入待审核轮次、节点锁定状态、与节点 SLA 一致的处理剩余工作分钟、审核截止时间、确定性通知和安全审计；请求键仅保存摘要，同请求同输入幂等、不同输入冲突。日历缺失时仍创建 `pending_calendar` 轮次并保留空截止时间。初始 TDD RED 为 59 项中 8 项按预期失败，时限一致性加固 RED 为 7 项中 1 项按预期失败；聚焦 GREEN 68/68，全量 `businessApi` 413/413、`calendarSync` 28/28、小程序 109/109、WXML 3/3。真实 CloudBase 事务竞争、索引、部署与微信开发者工具交互仍未验证；Task 8 负责接入入口和客户端，Task 7 负责审核投票与流转。
- 2026-08-11 节点独立审核流程 Task 5 已完成新版业务节点快照和首节点处理时限接入。业务服务在幂等预约检查后、写事务前调用 Task 4 工作时间服务；新版节点只保存内部账号编号形式的处理人/审核人、审核模式、双 SLA、`workflowMode: review` 和 `processingRoundNumber: 1`，首节点保存处理开始时间及已计算或待补算截止状态，其余节点不提前设置活动截止时间。业务快照成员稳定包含创建人及所有处理/审核账号；预约事务重新读取模板状态/版本、创建人和去重后的全部参与账号，预算统一按“节点数 + 不同参与账号数 + 6”计费，48 节点加 46 个参与账号的 100 次边界通过，47 个参与账号的 101 次边界在事务前拒绝。日历缺失不阻断业务发布；发布后独立小事务以确定性编号创建不含业务字段、凭证或身份值的超级管理员站内告警，告警失败不回滚业务且同请求重试只补建一条；`calendarSync` 在日历仍缺失时也会复核活动业务、当前节点和版本后以相同编号补建缺失告警。TDD RED：业务仓储聚焦 75 项中 14 项失败，服务编排 14 项中 2 项失败，后台补告警聚焦 18 项中 2 项失败；GREEN：业务聚焦 76/76、任务四套回归 99/99、`businessApi` 全量 396/396、`calendarSync` 全量 28/28、小程序 109/109、WXML 3/3，相关 JavaScript 语法检查通过。真实 CloudBase 日历读取、事务预算、告警权限/索引、部署和微信开发者工具业务创建仍未验证。

- 2026-08-11 节点独立审核流程 Task 4 正式复审修复轮次 2 已完成本地实现与回归。已安装 `wx-server-sdk@4.0.2` 及其 `@cloudbase/node-sdk` 源码证明定时来源的精确服务端值为小写 `TRIGGER_SRC === 'timer'`；`calendarSync` 计划授权现仅使用 `getWXContext()` 注入的该值，匿名/服务端调用伪造 `event.Type` 不再获权，人工一次性票据路径保持可用且不可重放。同 `sourceVersion` 校验现对比实际全年输入的每个 `date/isWorkday`，布尔值被篡改会重建新代际并修复。校验不再执行 365/366 次串行 `doc.get`，而是按 `sourceYear + generationId`、`date` 升序每页 100 条读取，每年最多 4 次、两年最多 8 次查询；部署需新建并验证 `work_calendar_entries(sourceYear ASC, generationId ASC, date ASC)` 组合索引，本任务未擅自修改云端。TDD RED 聚焦命令为 18 项中 14 通过、4 失败，GREEN 为 18/18；全量为 `businessApi` 391/391、`calendarSync` 27/27、小程序 109/109、WXML 3/3。真实 CloudBase `TRIGGER_SRC` 形状、索引、权限、60 秒耗时和 AILCC 网络仍待部署验收，触发器保持未启用。

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

2026-08-11 节点独立审核流程 Task 8 正式复审修复轮次 2：

| 命令或边界 | 结果 |
|---|---|
| 业务仓储聚焦 RED | 按预期：66 项中 64 通过、2 项失败；分别复现真实旧节点 `evidenceTypes` 被误拒绝，以及新版审核节点未拒绝旧字段回退。 |
| `node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js` | 通过：66 项，0 失败；覆盖旧字段安全映射以及混合、非法、重复、非数组、访问器和原型链失败关闭。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：473 项，0 失败；仅有两条既有 npm 用户配置警告。 |
| `npm.cmd test --prefix cloudfunctions/calendarSync` | 通过：47 项，0 失败；仅有两条既有 npm 用户配置警告。 |
| `node --test miniprogram/test/*.test.js` | 通过：109 项，0 失败。 |
| `node tools/test-wxml-structure.mjs` | 通过：3 项，0 失败。 |
| 真实 CloudBase 与微信开发者工具 | 未验证：尚未部署本轮修复，也未用真实旧节点执行端到端反馈页读取。 |

2026-08-11 节点独立审核流程 Task 7 正式复审修复轮次 1：

| 命令或边界 | 结果 |
|---|---|
| 正式复审初始聚焦 RED | 按预期：72 项中 59 通过、13 失败，精确暴露持久化决策/显示名、审核计时、终态审核补算和独立游标缺口。 |
| 补强 RED | 末节点审核日历缺失告警、终态审核补算边界篡改、显示名访问器、跨类型饥饿与损坏终态快照均先按预期失败，最小修复后转绿。 |
| `node --test test/review-service.test.js test/cloud-review-repository.test.js`（在 `cloudfunctions/businessApi` 下） | 通过：42 个测试，0 失败。 |
| `node --test test/calendar-sync-service.test.js test/cloud-calendar-repository.test.js`（在 `cloudfunctions/calendarSync` 下） | 通过：37 个测试，0 失败。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：455 个测试，0 失败；仅有两条既有 npm 用户配置警告。 |
| `npm.cmd test --prefix cloudfunctions/calendarSync` | 通过：47 个测试，0 失败；仅有两条既有 npm 用户配置警告。 |
| 真实 CloudBase | 未验证：尚未部署本修复，也未验证新增审核时长补算组合索引和真实并发事务。 |

2026-08-11 节点独立审核流程 Task 7：

| 命令或边界 | 结果 |
|---|---|
| 审核投票与乐观并发初始 RED | 按预期：30 项中 19 通过、11 失败；10 项缺少投票服务/仓储实现，1 项证明旧 fake DB 事务回调被全局串行化。 |
| 两轮独立复审补强 RED | 第一轮按预期审核 3 项、日历 3 项精确失败；第二轮按预期审核 2 项、日历 3 项精确失败，暴露宽松终态版本链及绑定节点即时状态的历史补算在再次审核或下游推进后不可达。 |
| `node --test test/review-service.test.js test/cloud-review-repository.test.js test/cloud-feedback-repository.test.js test/fake-cloud-database.test.js`（在 `cloudfunctions/businessApi` 下） | 通过：90 个测试，0 失败；覆盖唯一合法终态版本链、历史补算后幂等重试、真实并发重叠、冲突重试与唯一流转。 |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 通过：446 个测试，0 失败；仅有两条既有 malformed npm user-config 警告。 |
| `npm.cmd test --prefix cloudfunctions/calendarSync` | 通过：40 个测试，0 失败；覆盖直接返工、再次待审核、通过后下游推进、历史游标失效页越过与损坏失败关闭。 |
| `node --test miniprogram/test/*.test.js` | 通过：109 个测试，0 失败。 |
| `node tools/test-wxml-structure.mjs` | 通过：3 个测试，0 失败。 |
| Task 7 JavaScript 语法检查 | 通过：审核服务、审核仓储、日历同步服务和日历仓储无语法错误。 |
| 真实 CloudBase 与微信开发者工具 | 未验证：本任务未部署函数、未接入 Task 8 路由或页面，也未在真实云事务中制造审核并发；部署前需新增并验证 `node_review_rounds(processingCarryoverStatus ASC, _id ASC)` 组合索引。 |

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
- 当前工作树存在操作员自己的 `project.config.json` 未提交修改；本任务不读取其业务含义、不修改、不暂存也不提交。真实发布前必须在微信开发者工具中明确选择目标基础库版本并单独记录，不把工具自动改写混入功能提交。
- `npm audit` reports six transitive findings (one moderate, five high) through the official `wx-server-sdk@4.0.2` dependency tree. npm proposes a major downgrade to 2.5.3; it was not applied because it would invalidate the reviewed transaction behavior. Track the upstream SDK and reassess on a reviewed release.
- Enterprise WeChat production identifiers and secret remain intentionally unavailable; strong-message delivery is deferred.

## Next actions

1. 完成第二批次分支的最终差异、安全和项目记忆门禁后，本地快进合并回 `main`；不得包含操作员自己的 `project.config.json` 修改，也不得在未获明确授权时推送 GitHub。随后按部署手册创建 `public_node_shares`、`public_node_share_chunks`、组合索引和仅云函数权限，安全设置 `PUBLIC_NODE_SHARE_HMAC_SECRET`，部署 `businessApi` 与 `evidenceRetention`，再做待办、运营导出和七日公开分享的真机验收。
2. 保持 `evidenceRetention` 的周期触发器为空。现有真实验收已覆盖到期孤立凭证清理、15 天提醒、通知显示/跳转/已读和非目标普通/修订凭证不误删；仍须对已备份隔离数据分别完成第二次幂等运行、普通业务凭证到期清理、审计修订凭证到期清理、失败重试和日志脱敏。任何真实删除都必须再次确认精确候选和备份。
3. `calendarSync` 与 `workflowReminder` 的可信一次性 Timer、非零提醒、同小时去重和停止条件矩阵已通过。只有凭证保留的剩余破坏性矩阵完成后，才依次启用日历每日同步和每小时提醒；每次只启用一个并核对时区、下次触发时间和首次自动执行。`evidenceRetention` 周期清理继续单独决策。
4. 将管理员重置密码的可编辑弹窗替换为掩码输入，再完成需要第二个微信身份的绑定/解绑验收。
