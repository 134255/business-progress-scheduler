# Node Field Frequency and CSV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 展示获授权已完成节点的单选/多选次数，在单个 CSV 中保留基础运营、全字段明细与可核对的选项汇总。

**Architecture:** 新增独立最终字段来源域、节点级选项快照、读时授权查询及一致性分页导出。统计工作器有界恢复历史节点；客户端保留已验收的生成/发送状态机。当前工时 API 与权限不变。

**Tech Stack:** CommonJS Node.js、CloudBase 数据库/云函数、原生小程序 JS/WXML/WXSS、node:test，无新运行库。

**Spec:** docs/superpowers/specs/2026-09-11-node-field-frequency-and-csv-design.md

## Global Constraints

- 只统计已完成节点的最终有效结果；售后整体不必已完成。同一售后的同一节点字段只贡献一份结果，多选的每个选中项各计一次，不累计重复保存和已被驳回的旧轮次。
- 活动超级管理员查看全部符合条件的售后字段统计；普通活动账号仅统计当前有权访问的售后。CSV 继续只允许活动超级管理员导出，包括本次新增的完整字段明细。
- 不修改业务流转、历史反馈、审核、客户记录、账号关系、凭证访问或工时公式；不新增第三方分析服务。
- 单次统计最多 2,000 个获授权节点样本；字段后台每轮原始候选最多 40 条，保留原 Timer 和工时阶段预算。
- 用户选择当前 main 目录继续，保留全部脏改动；不新建 worktree、不自动提交、推送或发布。任务报告和独立审查按明确文件范围，不混入旧改动。
- 采用 TDD，真实域/服务/CSV 编码器参与测试，数据库和微信平台仅在外部边界用现有 fake；不保存真实客户数据或凭据。
- 一个文件、一个生成/发送按钮；保留现有基础 CSV 列顺序，增加记录类型和字段统计列。基础按创建日期，字段按完成日期，显式标注。

## Shared Interfaces

Task 1 产生 `operations-field-domain.js`：

```js
// source = { line, node, feedback, round, votes: [] }
buildFinalFieldResult(source) // null (ineligible), or result below; invalid -> code FIELD_SOURCE_INVALID
// result = { schemaVersion:1, businessLineId,nodeId,templateId,templateName,templateVersion,
//   stableNodeId,nodeName,nodeSequence,businessCode,businessName,businessStatus,nodeCode,
//   day,completedAt,sourceDigest,processorToken,reviewerTokens:[],
//   fields:[{fieldKey,name,type,compatibilityKey,options:[],value}] }
selectionSnapshot(result) // same metadata, fields restricted to single_select/multi_select
aggregateFieldResults(results) // groups below, deduplicate nodeId/sourceDigest, conflict -> FIELD_SOURCE_INVALID
// group = { id,templateId,templateName,templateVersions:[],stableNodeId,nodeName,nodeSequence,
//   fieldKey,fieldName,fieldType,filledSampleCount,emptySampleCount,options:[{label,count}] }
fieldExportRows(results) // rows for 字段明细 then 选项统计 using keys below; stable deterministic order
// appended CSV keys: recordType,dateBasis,templateName,templateVersions,fieldKey,fieldName,
// fieldType,fieldValue,optionValue,occurrenceCount,filledSampleCount,emptySampleCount,dataStatus,fieldGroupId
// detail metadata: businessCode,businessName,businessStatus,nodeCode,nodeName,nodeCompletedAt
```

Task 2/main 产生独立 `operations-field-service.js`、`cloud-operations-field-repository.js`：

```js
createOperationsFieldService({repository,clock})
// .getSummary({actor,query}) -> {scope:'all'|'authorized',groups:[],sampledNodeCount,incomplete:false}
// .getFilters({actor,query}) -> {templates:[],templateVersions:[],stableNodes:[]}
// .exportReportRows({actor,query}) -> {items:[],nextCursor:'',hasMore:false}
// API/client service names: getOperationsFieldSummary, getOperationsFieldFilters, exportOperationsReportRows
// query uses existing analytics keys except metric, pageSize <=50; same dates and selectors.
createCloudOperationsFieldRepository({db,operationsRepository,secret,clock})
// .getSummary, .getFilters, .exportReportRows consume normalized range (same service signatures except range)
```

Cursor 使用独立用途 AES-GCM 认证封装，密钥由现有服务端 BUSINESS_SEARCH_HMAC_SECRET 经用途隔离派生；测试注入合成 secret，不读取真实环境值。载荷绑定 actorId、queryDigest、reportDigest、offset、expiresAt；20 分钟过期。缺失/弱密钥使新报告导出明确失败，不能回退明文或无认证游标，旧基础导出不受影响。客户端不应通过游标读到账号编号。

所有新接口仍走现有账户登录校验，服务/仓储在读取前后复核活动账号。方法参数或无关字段不通过客户端直传到查询。

### Task 1: Final result source, option counts and export projection

**Files:** Create `cloudfunctions/businessApi/lib/operations-field-domain.js`, `cloudfunctions/businessApi/test/operations-field-domain.test.js`, `cloudfunctions/businessApi/test/helpers/field-fixtures.js`.

**Interfaces:** Consumes真实 field-domain/conditional-field-domain，来源对应 cloud-business-card-repository 的最终完成规则；produces Shared Interfaces 的四个域方法和 fixture helper `fieldSource({nodeId,values,reviewed,...overrides}={})`（仅测试）。域只依赖 node:crypto 和 field-domain，便于独立云函数打包，不依赖数据库/SDK。

- [x] 写行为测试并运行 RED，来源合法时完整值应保留，非完成或非实际路线应排除：
```js
const source = fieldSource({values:[{fieldKey:'choice',value:'A'},{fieldKey:'tags',value:['X','Y']},{fieldKey:'amount',value:0}]})
const result = domain.buildFinalFieldResult(source)
assert.equal(result.fields.find(f=>f.fieldKey==='amount').value,0)
assert.equal(domain.aggregateFieldResults([result,result]).find(g=>g.fieldKey==='choice').options[0].count,1)
assert.equal(domain.selectionSnapshot(result).fields.some(f=>f.type==='number'),false)
```
- [x] 覆盖最终通过轮次/无审核完成、关联不符、错误反馈修订、隐藏字段、字段键带连字符、选项不兼容、空值、0/false、多选分隔符、幂等与冲突、未来日历补算不改变来源摘要。
- [x] 最小实现：严格复制自有数据属性，拒绝访问器/继承替代关键数据；校验来源指针、字段定义和最终值；按完成上海日期构建结果。字段兼容 key 哈希基于模板/节点/字段/类型/候选项/条件定义；贡献人 token 使用当前 analytics 的 `sha256(['operations-filter-v1',role,userId].join('\0'))`。
```js
const values = validateFieldValues(node.fieldDefinitions, finalValues)
const visible = values.map(value => ({...value, compatibilityKey: keyFor(value), options: resolvedOptions(value)}))
// keyFor/resolvedOptions are private domain helpers defined by this task, not external dependencies.
```
- [x] 对多选明细使用 JSON.stringify(value)，汇总 row 使用真实计数；字段明细不填工时列。节点重复且来源一致跳过，来源冲突拒绝。
- [x] Run `node --test cloudfunctions/businessApi/test/operations-field-domain.test.js` GREEN；自审、报告 RED/GREEN 和文件清单，独立任务审查后继续，不提交。

### Task 2: Authorized field API and consistent report export (controller critical path)

**Files:** Create `cloudfunctions/businessApi/lib/operations-field-service.js`, `cloudfunctions/businessApi/lib/cloud-operations-field-repository.js`, `cloudfunctions/businessApi/lib/operations-report-cursor.js` and corresponding `test/*.test.js`; modify `cloudfunctions/businessApi/index.js` route/default wiring only. Preserve旧 operations-service/repository behavior。

**Interfaces:** Consume Task 1 results and original `operationsRepository.exportRows({actor,range})`; expose the exact service/API names in Shared Interfaces. Source reader loads current line/node/final feedback/final round and only final round votes, revalidates on final read.

- [x] 使用现有 createFakeCloudDatabase 和 fieldSource 构建两个不同权限售后；RED：普通账号仅自己一条，管理员两条，停用/撤权不能返回字段内容。
```js
const result = await repository.getSummary({actor:user,range})
assert.equal(result.sampledNodeCount,1)
assert.equal(JSON.stringify(result).includes('PRIVATE-OPTION'),false)
await assert.rejects(repository.exportReportRows({actor:user,range}), {code:'FORBIDDEN'})
```
- [x] 查询先取得当前有权的售后（管理员全部，普通账号 member/manager 关系），分组读取完成节点候选，限制获授权节点 2,000；不能从快照集合单独推断覆盖完整。初始/最终授权检查防读时撤权；显式无权 businessLineId 拒绝。
- [x] 有匹配来源的选项快照则统计可用；缺失/不匹配用有界权威读取恢复。未完成、逻辑删除、未走路线排除；可授权来源异常时返回 incomplete 标识，导出拒绝不完整结果。缺集合错误明确，不吞掉数据权限错误。
- [x] Report 在同一个选择集合上生成字段明细/汇总，并保留全部原基础列和基础日期筛选；原基础 row 加 recordType=运营基础/dateBasis=售后创建日期。封装游标绑定筛选、账号、完整报告摘要和有效期；分页间来源改变拒绝。
```js
const first = await repository.exportReportRows({actor:admin,range:{...range,pageSize:1}})
// mutate a source or membership in the fake database
await assert.rejects(repository.exportReportRows({actor:admin,range:{...range,pageSize:1,cursor:first.nextCursor}}))
```
- [x] API 路由允许名单与真实 createHandler 登录边界测试；过滤器包含历史有效节点/模板而不依赖工时 fact；数据大小超限报 RANGE_TOO_LARGE，不静默截断。
- [x] Run focused service/repository/cursor/API tests GREEN，记录新索引和配置依赖。做主路径真实组件集成；独立审查，不提交。

### Task 3: Bounded selection snapshot recovery and standalone bundle

**Files:** Create `cloudfunctions/operationsAnalytics/lib/field-snapshot-recovery.js`, `cloudfunctions/operationsAnalytics/test/field-snapshot-recovery.test.js`, bundled copies of Task 1 `operations-field-domain.js`, `field-domain.js`, `conditional-field-domain.js`; modify `cloudfunctions/operationsAnalytics/index.js` for optional post-timing recovery and safe counts. Create `tools/sync-operations-field-domain.mjs` plus bundle consistency test. Do not modify existing timing algorithms or original service constructor contract.

**Interfaces:** `createFieldSnapshotRecovery({db,clock,buildFinalFieldResult,selectionSnapshot})` -> `.runCycle({batchSize:40,timeBudgetMs:5000})` returns `{examined,generated,failed,hasMore}`. Deterministic snapshot doc ID=node._id; writes only `operations_field_snapshots` and own `system_settings/operations-field-snapshot-cursor`.

- [x] RED 测试 41+ 节点的公平推进、异常节点不阻挡、重复回绕不增加次数、旧 worker 来源改变不覆盖新源：
```js
await recovery.runCycle({batchSize:40,timeBudgetMs:5000})
await recovery.runCycle({batchSize:40,timeBudgetMs:5000})
assert.equal(fake.documents('operations_field_snapshots').filter(x=>x.nodeId==='node-41').length,1)
```
- [x] source scan 按 `_id` keyset，原始候选预算 40，先读候选后权威来源复核；游标 CAS 使用自己的版本，尾页回绕。每条原子事务复核当前来源指针/最终状态及固定文档，snapshot set 原子发布，不依赖工时 generated。
- [x] 自有保留状态不得保存客户字段或原始异常，仅 cursor/revision/time。缺集合或阶段失败返回 safe counts，不能影响已完成工时阶段结果；保持可信 Timer 入口和时间预算。
- [x] 同步脚本复制明确3个来源文件到 worker lib（机械复制，无变更域逻辑），一致性测试执行真实模块在 synthetic source 下得到同一结果并比较源字节；不得从部署包 require ../businessApi。
- [x] Run `node --test cloudfunctions/operationsAnalytics/test/field-snapshot-recovery.test.js` and worker full suite GREEN，报告路径/证据；独立审查，不部署或修改 Timer。

### Task 4: Client option statistics and combined CSV

**Files:** Modify `miniprogram/services/business.js`, `miniprogram/pages/admin-operations/index.js`, `.wxml`, `.wxss`; create `miniprogram/utils/operations-field-report.js`, `miniprogram/test/operations-field-flow.test.js`; update old export-flow tests only for new real API boundary, preserve all existing user code.

**Interfaces:** `business.getOperationsFieldSummary(query)`, `getOperationsFieldFilters(query)`, `exportOperationsReportRows(query)` call corresponding protected routes. Summary and groups exactly Shared Interfaces. New utility exports `FIELD_CSV_COLUMNS` append-only and presentation helpers; original 23 columns remain original order. Export uses one report endpoint containing all three record types rather than concatenating old page statistics.

- [x] RED：applyFilters 请求新 summary，显示 A=2/B=1，普通用户 scope 文案，其他 field values 不在数据中。新统计 failure 不移除旧 timing 图表。
```js
await page.applyFilters()
assert.equal(page.data.fieldGroups[0].options[0].count,2)
assert.equal(page.data.exportReady,false)
```
- [x] 三条新服务包装保留安全错误与静默协议；fields 与旧工时加载分离，并守卫用户对象、完整筛选请求序列、onHide/onUnload。候选来自新 filters 与原 filters 安全合并；不使用其他账号缓存。
- [x] CSV export 用 report endpoint，全量分页成功才写文件；绑定完整筛选作为 queryKey，保留原直接 tap 发送、取消、失败、超时和角色失效行为。源变更/不完整/返回损坏均禁止发送残缺文件，加载反馈不静默。循环/文件大小上限明确提示。
- [x] WXML 新区按节点/字段显示名称、样本、options 次数和进度条；记录 scope/完成日期口径和 CSV 三类记录说明；文本/数字/日期/布尔值不出现在看板。
- [x] Run all client tests + WXML GREEN；真实 server-domain/service -> CSV encoder synthetic integration核对次数与明细；独立审查，不上传。

### Task 5: Integrated verification, deployment guide and durable memory

**Files:** New `docs/deployment/node-field-frequency-acceptance.md`, deployment document field section, `docs/memory/PROJECT.md`, `STATUS.md`, new ADR after code verification. Only explicit current feature paths staged if user later asks for commit.

- [x] 覆盖域、仓储、后台、API、客户端的共同 synthetic fixture 端到端；真实角色撤销、来源变化分页、计数明细一致、旧 CSV 原列保留。
- [x] Run `npm.cmd test --prefix cloudfunctions/businessApi`, `npm.cmd test --prefix cloudfunctions/operationsAnalytics`, `node --test miniprogram/test/*.test.js`, `node tools/test-wxml-structure.mjs`, syntax and `git diff --check`。
- [x] 新集合仅云函数读写；文档列实际 businessLineId/status/_id、businessLineId/_id 及关系查询索引，部署前 read-back/backup 后分别更新函数，保留现有 Timer；发布需当次许可，不在本计划自动执行。
- [x] 独立整体审查代码/安全/规范；重要项修复后复审。项目记忆记录本地证据和未部署/未真机验收边界，执行 validate_memory.py。
- [x] 交付可部署补丁、精确验证结果与发布下一步，不把本地通过说成线上已可用。
