# Analytics Field Change-Priority Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将字段统计恢复改成售后级变更队列优先、有界完整巡检兜底，并以包含所有新增读写的本地完整 handler 对照验证净操作收益。

**Architecture:** 复用现有业务成功后字段即时刷新，另行登记仅服务端的合并队列；统计 worker 保留旧模式，新增共享 40 候选/5 秒预算的优先恢复模式。队列使用随机代际、CAS 和持久待确认编号防漏项；完整巡检沿用原来源算法与游标，通过独立状态安排一小时完成后间隔。

**Tech Stack:** 现有 Node.js CommonJS 云函数、wx-server-sdk 4.0.2 既有数据库接口、node:test、项目原生小程序测试；不新增依赖或云服务。

**Spec:** `docs/superpowers/specs/2026-11-09-analytics-field-change-priority-recovery-design.md`（2026-11-09 用户已确认）。

**Execution status:** 用户确认原生执行后，任务1–5已完成本地TDD、30组净操作对照、独立整体复核及其单次修正回归。证据和执行取舍见同plan ledger、STATUS与 `docs/deployment/analytics-field-change-priority-recovery-acceptance.md`；默认关闭/legacy，不提交、不推送、不部署。云端与现金、五端真机边界仍unverified。

**Subsequent release authorization:** 用户后来明确要求提交、推送并部署，已在功能分支推送本事项，并完成两个函数的关闭态增量发布与完整SHA读回。此后续授权只覆盖代码发布，不把下方本地阶段约束解释为禁止已授权发布，也不自动开启新队列/模式。新开关仍不存在；真实新模式、计价和私有集合/索引/客户端拒绝规则门禁仍按STATUS另验。

## Global Constraints

- 仅本地实现和净成本测试；不提交/推送、部署、建云集合、改云变量/权限/Timer/规格、调用真实业务/发送器、发消息或购买。每任务完成保留显式路径与本地证据，不执行技能示例中的自动 commit。
- 保留原五类即时刷新、原工时阶段、售后/站内/企微、现有查询与导出协议；不改原业务事务或其 100 操作预算。
- 字段阶段总计最多 40 个原始节点候选、5000ms 协作预算；巡检应运行时先分配最多 8 个，队列严格为空可将未用配额返给同轮巡检。队列每次最多访问 8 个工作项、每项最多准备 8 个节点；每售后上限 100，审核票上限 50。
- 完整巡检完成后间隔 3600000ms 再启动；激活后逐调用续跑。不是一小时修复 SLA，不改实际 Timer。
- 私有队列默认关闭、worker 默认 legacy；不新增公开接口，不缓存权限/完整来源，未知结果不在原请求重放。
- 工作区原有 50 项 tracked dirty 和其他 untracked 均属于前置状态；冻结精确原始字节，编辑重叠文件只能叠加本事项。实施前执行 using-git-worktrees 技能的环境检查；不能通过干净 HEAD 丢掉必要的现有工作区功能。
- 仅在确认整个设计的净收益后建议后续部署；现金、真实 SDK/索引、五端真机、云超时均单列 unverified，不能从本地次数承诺元/月。

## Review Focus

- 业务已提交但登记/即时刷新任一失败或账号随后撤权：原业务响应不变，另一恢复机会保留；任务2逐项验证。
- 删除重建队列出现相同 revision，旧 ack 与新 enqueue 交错：不能吞新代际；任务1验证 ABA、冲突重试和未知提交。
- 页已领取而进程崩溃、坏 pending 节点反复失败：未尝试编号不能丢，健康后继/其他售后可达；任务1、4验证。
- 旧巡检尾部结果在另一 worker 已前进之后返回、时钟回退或伪造未来状态：不能关闭新巡检或永久暂停；任务3、4验证。
- 生产 Timer 周期未知、2000 历史节点使巡检长期 active：不能把“一小时间隔”误报完成期限或只挑空闲轮报节省；任务5覆盖完整虚拟时间与真实所有开销。

## 文件职责和稳定接口

- 新增 canonical `cloudfunctions/businessApi/lib/operations-field-recovery-contract.js`：常量、严格自身数据属性/日期/编号/队列与控制状态校验，固定安全错误。
- 新增 canonical `cloudfunctions/businessApi/lib/cloud-field-refresh-queue.js`：队列登记、轮转查询、页领取与完成确认。两模块由现有 `tools/sync-operations-field-domain.mjs` 加入同步清单，生成 Analytics 同名副本；现有4模块加新2模块共6项，保持独立部署闭包字节相同。
- 新增 `cloudfunctions/businessApi/lib/operations-field-change-signal.js`，最小修改 `cloudfunctions/businessApi/index.js`：十类业务成功后的内部登记，不改原字段 repository 的既有实现。
- 新增 `cloudfunctions/operationsAnalytics/lib/field-recovery-budget.js`：一个调用的单调时钟/共同截止；不把时间预算重置成每条通路各5秒。
- 修改 `cloudfunctions/operationsAnalytics/lib/field-snapshot-recovery.js`：保留 `runCycle` 旧结果形状，提取同一权威恢复管线供私有定向恢复和可证明尾部的巡检使用。
- 新增 `cloudfunctions/operationsAnalytics/lib/field-change-priority-recovery.js`，最小修改 worker `index.js`：控制状态、巡检优先份额、队列轮转与保守错误收尾；原 handler 公开安全计数不扩展为包含内部编号。
- 新增对应测试、容量计量工具及验收文档；不修改依赖清单、客户端运行文件或其他 worker。

### Task 1: 私有合并队列与严格契约

**Files:** 新增上述两 canonical 模块及 Analytics 同名副本；修改 `tools/sync-operations-field-domain.mjs`；新增 `cloudfunctions/businessApi/test/field-refresh-queue.test.js`、`cloudfunctions/operationsAnalytics/test/field-refresh-queue-bundle.test.js`，必要时同步既有工具清单测试的准确项数。

**Interfaces:**

- `createCloudFieldRefreshQueue({db, clock, tokenFactory})` 返回 `enqueue({businessLineId})`、`listJobs({afterId,limit})`、`claimVisit({observed,limit})`、`ackVisit({claim,completedIds})`。
- `enqueue` 返回 `{id,enqueueToken,revision}`；同售后一个确定性 SHA-256 编号，每次登记使用新32位十六进制随机 token。
- `listJobs` 返回 `{jobs,tail}`，最多8条，排序/续页严格验证；未知查询不补发单条。
- `claimVisit` 返回 `null`（CAS输给并发）或 `{claim,candidates,jobFinished}`；claim 含 id/token/revision/实际领取编号，candidates 是非授权提示。`ackVisit` 只移除 claim 中已完成的编号，CAS不符返回 null，完成尾部且 pending 空才条件删除。
- 队列严格 schema：`schemaVersion:1,businessLineId,enqueueToken,revision,afterNodeId,discoveryDone,seenCount,pendingNodeIds,retryAfterId,visitNext,updatedAt`，另容许精确 `_id`。seenCount 为0..100，pending唯一/最多100，visitNext为new/retry。token/字段值生成在逻辑操作内、事务重试外；校验与缓存在每次 callback 重建。

- [x] 在任何产品编辑前完成隔离/记忆预检，冻结当前API与Analytics完整运行闭包、测试夹具和相关工具的精确原始字节到 `outputs/qa/analytics-field-change-priority-20261109/baseline/`；保留根目录布局及SHA清单，排除凭据、媒体、node_modules和原始业务数据。验证备份SHA与当前一一相同并记录原dirty路径；任务5使用这份原像，不从编辑后的目录重造“基线”。
- [x] 写 RED：同售后两次登记只有一项且 token 不同；旧 ack 不能删除重建项；claim 后新增编号已在 pending 且崩溃不丢；不接受 getter/额外字段/坏原型/重复编号/版本溢出/未知节点归属。
- [x] 执行 `node --test cloudfunctions/businessApi/test/field-refresh-queue.test.js`，确认因新能力缺失而失败，保留准确原始运行 SHA 和失败数。
- [x] 实现最小队列。pending 与新发现均存在且limit>=2时先轮转取1个pending，其余新发现；limit=1时按visitNext交替。new发现严格按businessLineId/_id续页，达到100后须有下一次有界空页证明，发现第101条报错，不能当尾部。页领取事务在推进after前把编号存入pending，ack不重放未知提交。
- [x] 覆盖冲突重试、enqueue与claim/ack竞争、ack写后未知、claim写后未知、低/高编号插入、连续坏项；运行队列测试、`node tools/sync-operations-field-domain.mjs`、`node tools/sync-operations-field-domain.mjs --check`，再运行副本测试，预期0失败、最多100事务操作。
- [x] 检查本任务diff/精确新增路径，仅保留未提交变更。共享纯域4个旧文件字节不变。

### Task 2: 业务成功后的内部信号接入

**Files:** 新增 `operations-field-change-signal.js`；修改 API `index.js`；新增 `cloudfunctions/businessApi/test/field-change-signal.test.js`、`field-change-signal-routes.test.js`。

**Interfaces:** `createOperationsFieldChangeSignal({db,queue,enabled})` 返回 `enqueueAfterMutation({actor,action,payload,result}) -> Promise<'disabled'|'ignored'|'queued'>`（不返回客户端）。`createBusinessApi` 新增可选注入 `fieldChangeSignal`，旧注入者缺省不变。

- [x] 写 RED：逐一覆盖设计十类动作的成功、业务失败、幂等返回；五类旧即时刷新仍执行；登记失败不阻止即时刷新，反之不丢队列；业务结果/卡片/搜索收尾和受保护集合相同。
- [x] 运行 `node --test cloudfunctions/businessApi/test/field-change-signal*.test.js`，确认旧入口尚无信号调用而失败。
- [x] 实现精确目标解析：优先采用实际动作结果中的业务编号；投票从当前审核轮次解析；节点动作从当前节点解析并核对输入归属；metadata结果id只在该动作解释为售后。当前账号/售后关系不符则信号失败关闭，不对原业务补发操作。忽略纯创建、非十类动作、失败路由及未注册旧函数，不增加客户端action。
- [x] 在业务成功后、原即时刷新之前独立调用信号，两段分别catch；配置 `OPERATIONS_FIELD_CHANGE_QUEUE_ENABLED` 仅明确true才启用，缺省/false不初始化队列。非法配置禁止启用新通路且不阻断原业务，发布预检须报告固定安全分类。
- [x] 运行两新套件和原API路由/字段统计相关测试；验证伪造无关payload字段不能将信号定位到另一售后、账号提交后撤权不逆转成功、没有真实SDK初始化/云调用。检查diff，保留未提交变更。

### Task 3: 共同预算、原权威恢复管线与一小时巡检调度

**Files:** 新增 `field-recovery-budget.js`、`field-change-priority-recovery.js`；修改 worker `field-snapshot-recovery.js`、`index.js`；新增 `cloudfunctions/operationsAnalytics/test/field-priority-recovery.test.js`、`field-recovery-budget.test.js`。

**Interfaces:**

- `createFieldRecoveryBudget({clock,timeBudgetMs}) -> {check,time,remainingMs}`，clock返回Date，timeBudgetMs为0..5000，单个调用一份截止；时间高水位不回退。
- `createFieldSnapshotRecovery` 保留 `runCycle({batchSize,timeBudgetMs})` 精确旧形状；新增内部 `runRepairSlice({batchSize,budget}) -> {counts,cursorProof}` 和 `recoverCandidates({candidates,budget}) -> {counts,outcomes,stopped}`。outcomes仅含编号与completed/failed，未尝试项没有完成结果；completed包括权威确认不再适用，不代表生成快照。
- `cursorProof` 仅真实尾部/有效已提交游标版本产生：`{cursorId:null,version,missing,tail:true}`。预算/竞争/错误提前停止没有尾部证明；不得让新的内部证明改变原公开handler返回或旧测试结果。
- `createFieldChangePriorityRecovery({db,queue,sourceRecovery,clock,tokenFactory})` 返回原 `runCycle` 形状，并持有严格 `operations-field-recovery-state-v1` 控制。mode由 worker 服务端 `OPERATIONS_FIELD_RECOVERY_MODE` 选择，缺省/legacy保持旧实现，priority-repair启用新实现；非法值只使字段阶段安全失败，不阻断先行工时阶段。
- 控制 schema：schemaVersion1/revision/queueAfterId/repairEpoch/repairActive/repairStartedAt/repairCompletedAt/nextRepairAt/updatedAt。active时nextRepairAt为null；inactive时nextRepairAt严格等于repairCompletedAt+3600000。日期必须为有效Date或严格既有SDK日期形状，now早于updatedAt失败，不写更早时间；不能用任意未来nextRepairAt永久停修复。

- [x] 写 RED：第一次激活保留旧游标，未到期空队列不读历史/不写时钟，完成后3599999ms不启动、3600000ms启动；已有巡检跨过一小时仍续原代际。
- [x] 运行 `node --test cloudfunctions/operationsAnalytics/test/field-priority-recovery.test.js cloudfunctions/operationsAnalytics/test/field-recovery-budget.test.js`，保存新能力缺失的RED。
- [x] 先提取共同预算和恢复函数，保持来源加载、50票覆盖、发布事务完整重读/digest比较、相同投影不写及旧cursor严格schema；原64项来源恢复测试必须不改语义全过。
- [x] 实现调度：新鲜读控制和队列，CAS开启到期巡检；先巡检<=8候选，随后队列按剩余额度/时间处理；严格空队列才用余量继续巡检。第二段巡检不能重置期限或把第一次尾部当新开始。每调用任务访问<=8、原始节点总返回/重访<=40。默认不做跨通路去重，全部实际读写计量。
- [x] 仅在尾部证明与当前控制epoch/revision及旧游标版本均匹配时，事务确认结束并设置下一时间。state坏/冲突/未知提交停止字段阶段，无无条件覆盖、拆单重放或权限降级。
- [x] 运行全部 Analytics：`npm.cmd test --prefix cloudfunctions/operationsAnalytics`；原handler安全计数与信任Timer测试、原工时结果不变；检查副本及diff，保留未提交变更。

### Task 4: 失效、公平性与跨入口恢复证明

**Files:** 新增 `cloudfunctions/operationsAnalytics/test/field-priority-recovery-races.test.js`、`field-priority-recovery-integration.test.js`，仅按RED缺口修正前述模块，不添加新业务范围。

**Interfaces:** 仅使用任务1队列、任务2信号、任务3核心/调度接口；利用既有fake的beforeNextTransaction/failNextWrite/afterTransaction能力，不更改原fake的生产意义。

- [x] 写失败测试：登记失败+即时刷新失败后，不经任何消息/业务补写，下一完整巡检可修复；队列claim持久化后崩溃，重建实例仍处理未尝试节点；新登记与旧ack ABA不丢新任务。
- [x] 写失败测试：持续坏pending节点不阻塞同售后健康新节点/其他售后；不断变更的热点售后不压掉低/高编号冷项及完整巡检。覆盖40/41/150/2000总节点、每售后100/101、50/51票、旧游标中段、源删除和资格失效。
- [x] 写失败测试：旧尾部证明不能关闭新巡检；字段慢读取跨5000ms后不再发新SDK请求；提交前后源/票/路线变化仍拒绝旧快照；运行中重入/事务重试不复用授权缓存；非法状态/时钟回退安全失败，不伪报完整。
- [x] 对每个缺口先运行对应文件证明RED，再最小修正并重跑。健康数据相同流程最终快照/公开查询/权限拒绝及原受保护集合一致；统计后台等待差异按设计单列，不声称逐时点相同。保留未知已提交/未提交双分支证据。
- [x] 运行任务1–4定向套件与完整Analytics；逐事务操作<=100、共同候选<=40和无真实云/消息证明通过后，再进入成本阶段。发现需扩大业务事务/新权限则停并报告。

### Task 5: 完整净成本对照、独立复核与本地交付

**Files:** 新增 `tools/capacity/analytics-field-recovery-cost.cjs`、`tools/capacity/lib/analytics-field-recovery-meter.cjs`、`tools/capacity/test/analytics-field-recovery-cost.test.cjs`、`docs/deployment/analytics-field-change-priority-recovery-acceptance.md`；更新本plan、STATUS和ADR0019本事项增量。QA原始源前像/回执放 `outputs/qa/analytics-field-change-priority-20261109/`，不入Git。

**Interfaces:** 容量工具导出 `runComparison({baselineRoot,candidateRoot,scenario,intervalMinutes,cycles,clock}) -> Promise<RedactedReport>`；仅通过显式本地冻结源码构建旧/新真实handler及API收尾，使用合成SDK，禁止cloud.init/网络。meter覆盖get/query返回、缺失get尝试、set/update/remove字节、事务callback重试/失败，并能按阶段和集合分拆。

- [x] 写RED并运行 `node --test tools/capacity/test/analytics-field-recovery-cost.test.cjs`：不存在文档get仍计一次，回滚写尝试单列不冒充已提交写，所有新enqueue/claim/ack/控制/即时刷新开销计入，fixture保护业务/通知不变。
- [x] 实现有界测量器。基线冻结在任何产品改动之前，使用准确当前dirty源码闭包而非只拿HEAD；候选使用同一个合成初态、业务变化序列、虚拟时钟和真实服务逻辑。大夹具可用已核验的写集合copy-on-write合成SDK提速，但先用既有fake交叉比对小夹具的完整结果和每项计数，不能把更快fake说成线上提速。
- [x] 原/新依次运行0、30完成、30审核完成、150、2000历史及全未完成；每组至少1/10/100调用，以及完整24小时的1/5/15分钟虚拟间隔。增加单次/集中/持续变化、登记失败和恢复场景；准备成本、首次巡检、暖机、稳定段及未用预读均单列。
- [x] 报告每场景净get/query/返回文档/字节/写入/事务及首次额外开销的摊销轮数、健康前提下真实虚拟修复等待；不相加重叠收益。不变历史应明显少做来源恢复；空闲/高频变化若更贵必须展示。整体净收益不成立时不推荐上线，保留结果并报告，不删除失败样本。
- [x] 新鲜运行 `npm.cmd test --prefix cloudfunctions/operationsAnalytics`、`npm.cmd test --prefix cloudfunctions/businessApi`（含pretest）、`node tools/test-wxml-structure.mjs`、`node tools/sync-operations-field-domain.mjs --check`、成本工具测试及上述完整比较；保存退出码/总数/源码SHA，不把定向结果重复累加为全套数。
- [x] 一位新鲜独立复核者检查设计、全部运行diff、竞态/权限/预算/成本证据；明确只读，无云操作。问题按TDD复现修正再复验。原有dirty与允许范围做逐文件SHA对照；非本事项变化须为0。
- [x] 更新验收/记忆：精确本地通过/失败、未知现金/云端边界及下一步；`git diff --check`、项目记忆validator通过。最终只交付本地实现和净成本结果，云部署/新集合/实际费用另行列单待授权；不自动提交、推送或部署。

## 实施前自检与交接

- [x] 覆盖检查：设计各章节均对应任务1–5；不把API内部信号单独变成公开能力；十类动作、60分钟、40/5000ms、8/8、100/50及原始失败窗口均有测试。
- [x] 名称检查：canonical/worker副本、signal注入、预算对象、队列claim/ack、内部cursorProof与成本工具签名在各任务一致。
- [x] 保留原实现/数据/dirty；读完整设计、执行/测试技能及工作区隔离规则后才开始任务1。

计划推荐当前会话原生顺序执行，末尾一次独立复核，避免每个小任务启动新代理的上下文开销。用户确认本计划与执行方式前不写产品代码；确认后使用 executing-plans，再TDD逐任务执行。
