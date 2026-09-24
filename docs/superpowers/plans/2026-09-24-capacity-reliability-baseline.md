# 容量与可靠性基线（A批次）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有前端功能和业务行为的前提下，建立50名员工、每天30条售后、每条平均100MB附件的可重复只读容量基线，明确后续优化对象。

**Architecture:** 真实仓储/域逻辑注入测试专用只读数据库；小样本竞争继续用现有fake DB，大历史采用惰性数据源，测量逻辑读请求而非模拟云端时延。产品改动只允许既有内存计时器增加8个动作白名单；不改页面、公共请求工具或云函数实现。工具全部放在产品根目录之外，数据只用合成值。

**Tech Stack:** 现有CommonJS、Node.js内置node:test/assert/crypto/child_process、PowerShell；编写计划时本机Node v24.14.0；不添加依赖或修改锁文件。

**Spec:** `docs/superpowers/specs/2026-09-24-capacity-reliability-baseline-design.md`。执行者先完整阅读规格、AGENTS、PROJECT/STATUS及ADR-0006/0014/0019/0022。用户已确认计划，当前实施及验证进度见 `docs/deployment/capacity-reliability-acceptance.md`；不是发布或云端容量验收记录。

**完成记录（2026-09-24）：** 六项任务的本地实施、一次独立复核及修正回归完成，具体证据和未验证范围见验收记录。所有分任务Git提交步骤按执行裁定改为文件/账本检查点，勾选不代表已提交或推送；保留用户批准的原脏目录，不发布、不上传。五端原生、真实云端容量及恢复仍未验证，B/C/D不在本批内。

## Global Constraints

- 用户明确约束：优化过程中目前所有的前端功能不受影响，如产生实际影响，必须经过用户批准。
- 继续保持安卓、鸿蒙、iOS、macOS、Windows的功能边界；各端真实微信的性能和媒体操作要分别验证。
- 当前每处理轮120MiB有效附件合计、3路文件传输、同页串行登记、有限重试、真实文件校验和终态后60天保留规则全部不变。
- 100MB是每条售后的容量规划输入，不是新增上传限制；平均3GB/天、90GB/30天，已完成60天保留部分约180GB，未完成/修订/分享保留另计。
- 当前账号和售后成员权限必须在返回前重新核验；不跨账号或跨请求复用授权，不用全局字段汇总代替普通账号的授权统计。
- 现有CSV列、日期口径、公式保护和“生成→发送”两阶段操作保留。
- 默认运行小样本；半年/全年档显式选择，并设置运行时长、内存和请求预算。
- 不修改查询结果或提升保护上限；不预建队列、集合、索引、Timer、服务器或公共任务框架。B/C/D不在本计划实施。
- 本轮不连接生产、不创建测试售后、不上传真实媒体、不读凭据、不改备案/企微配置，不发布或上传。以后部署单独确认。
- 仅允许产品增量 `miniprogram/utils/performance-timing.js` 的ACTIONS集合；保持默认关闭、最多100条内存样本、关闭后清理和异常隔离。其他产品变更先停止并说明影响。
- 保留现有脏工作区；不能把HEAD当作当前已发布功能基线。实施前保存当前工作区文件清单/摘要，逐项识别本次增量；禁止reset、覆盖或整树暂存。
- 潜在影响先报告，实际回退不得放行。报告影响端/功能、前后差异、原因、替代和回退方法，等用户批准才能保留行为变化；离线无影响任务可继续。

## Review Focus

1. 已有未提交功能被旧HEAD覆盖或测试工具被打包：任务1记录当前文件摘要，任务6按增量与产品路径复核。
2. 相同排序值、Date/ISO旧数据或测试事务模型使样本漏读：任务2双适配器契约和固定文档事务测试，实际SDK类型/索引另列未验证。
3. 多页报告/切换账号/撤权导致混合来源或泄露：任务3复用现有竞争用例并测试独立实例的并发隔离；不能用耗时收益放宽来源证明。
4. 半年/全年预算中止或业务上限被误写成通过：任务4将known_limit、incomplete、test_aborted和error分开；未遍历全部页不标完整。
5. 可选诊断失败改变原返回/提示/请求次数：任务5直接经真实服务调用比较关闭/开启/故障三种模式，并运行既有诊断隔离与客户端完整套件。

---

## 文件边界与交付物

| 文件 | 职责 |
| --- | --- |
| `tools/capacity/fixtures.cjs` | 固定时钟/合成账号、月/半年/年惰性字段数据，独立小样本变体 |
| `tools/capacity/readonly-db.cjs` | 测试专用只读查询子集、事务快照、读指标、测量预算 |
| `tools/capacity/workspace-fixtures.cjs` | 首页/列表/前序节点的小样本持久记录，复用已验证形状、不修改原测试 |
| `tools/capacity/scenarios.cjs` | 显式白名单场景接线真实仓储，包含逐页报告计数和完整性检查 |
| `tools/capacity/run.cjs` | CLI父进程/子进程、逐场景隔离、时间/内存预算、安全输出与退出码 |
| `tools/capacity/test/fixtures.test.cjs` | 数据规模/确定性/最终来源/严格联动测试 |
| `tools/capacity/test/readonly-db.test.cjs` | fake DB差分契约、禁止写入和事务限制 |
| `tools/capacity/test/scenarios.test.cjs` | 真实仓储结果、小样本指标、报告完整性、账号隔离 |
| `tools/capacity/test/runner.test.cjs` | 参数、超预算/挂起、未知错误/安全输出、无SDK/外联依赖 |
| `tools/capacity/test/diagnostics.test.cjs` | 8个新增白名单及前端行为不变契约 |
| `miniprogram/utils/performance-timing.js` | 唯一产品改动：ACTIONS追加8个字符串 |
| `docs/deployment/capacity-reliability-acceptance.md` | 重跑方法、基线数值、已知边界、五端与真实容量/恢复验收表 |
| `docs/memory/STATUS.md` | 当轮真实证据、未验证项与下一步；不混入真实业务数据 |

不修改现有fake DB、现有仓储、页面/组件、app配置、service/cloud调用、依赖、worker或生产发布脚本。新工具不能被产品模块require。

## Task 1: 锁定当前工作区基线并建立确定性合成数据

**Files:** Create `tools/capacity/fixtures.cjs`, `tools/capacity/test/fixtures.test.cjs`。

**Interfaces:**
- Consumes: `fieldSource(options)`（`cloudfunctions/businessApi/test/helpers/field-fixtures.js`）、`buildFinalFieldResult(source)`/`selectionSnapshot(result)`（真实field domain）；只读导入，不修改原helper。
- Produces: `NOW`固定为`2026-09-24T04:00:00.000Z`；`createCapacityFixture({days=1, linesPerDay=30, nodesPerLine=5, snapshotMode='missing'})`，返回 `{metadata, actors, collections, get(collection,id), entries(collection)}`。`entries`返回生成器，`get`不存在返回undefined，每次返回独立对象；metadata含days/lineCount/completedNodeCount/mediaBytesPerLine=100000000。snapshotMode仅`missing/valid/stale`。
- Produces: `createProductSource({rowCount=2495})`，返回可由真实domain验证的单节点8列严格联动source；仅用于小样本，不给全年每节点塞2495行。

- [x] **1.1 只读检查与记录当前基线。** 用 `git status --short --branch`、`git diff --stat`、`git diff --cached --name-only` 确认已有改动；暂存区若非空先识别所有者，不清空。采集当前所有产品文件（包括未跟踪文件）的路径/SHA256，输出保存于当前任务的临时工作记录，不提交真实附件/outputs。示例采集命令：

```powershell
$capacityRoots = 'miniprogram','cloudfunctions'
$capacityFiles = Get-ChildItem -LiteralPath $capacityRoots -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/](node_modules|test)[\\/]' }
$capacityFiles | Sort-Object FullName | ForEach-Object { [PSCustomObject]@{ Path=$_.FullName; Hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } } | ConvertTo-Json -Compress
Get-FileHash -LiteralPath project.config.json -Algorithm SHA256
```

首次只运行已有相关回归，失败则先区分既有问题，不顺手修产品：

```powershell
node --test cloudfunctions/businessApi/test/dashboard-performance.test.js cloudfunctions/businessApi/test/business-read-performance.test.js cloudfunctions/businessApi/test/cloud-operations-field-repository.test.js miniprogram/test/performance-diagnostics.test.js miniprogram/test/diagnostic-isolation.test.js
```

- [x] **1.2 写失败用例并运行。** 新文件先引用不存在的fixtures模块，第一次因缺失而失败；创建模块后需再看断言是否确实约束行为。

```javascript
const test = require('node:test')
const assert = require('node:assert/strict')
const {createCapacityFixture, createProductSource} = require('../fixtures.cjs')
const domain = require('../../../cloudfunctions/businessApi/lib/operations-field-domain')
test('monthly and yearly totals are deterministic, with no real media allocation', () => {
  for (const [days, lines, nodes] of [[30,900,4500],[180,5400,27000],[365,10950,54750]]) {
    const f = createCapacityFixture({days})
    assert.equal(f.metadata.lineCount, lines)
    assert.equal(f.metadata.completedNodeCount, nodes)
    assert.equal(f.metadata.mediaBytesPerLine, 100000000)
    assert.equal(f.actors.length, 50)
    const a = f.entries('business_nodes').next().value
    const b = f.get('business_nodes', a._id)
    assert.deepEqual(a,b); b.name = 'modified copy'
    assert.notEqual(f.get('business_nodes',a._id).name,b.name)
  }
})
test('2495-row product matrix remains a valid authoritative source', () => {
  const s = createProductSource({rowCount:2495})
  assert.equal(s.node.fieldDefinitions[0].optionLinkage.rows.length,2495)
  assert.ok(domain.buildFinalFieldResult(s))
})
```

Run: `node --test tools/capacity/test/fixtures.test.cjs`；预期先失败，完成后全绿。补充0条、非法负数/小数/未知模式拒绝，输出不能包含Buffer/真实URL；不要生成100MB字节数组。

- [x] **1.3 实现惰性来源和稳定编号。** 每个源从现有fieldSource构造，不自造结果快照。日期按NOW之前完整天序列，第i条创建日期为对应上海自然日，5个节点同日逐分钟完成；IDs固定数字补零，不使用Date.now/Math.random。50个合成账号含root、processor-1/2、reviewer-1/2及45个普通成员，每条售后只配置实际少量参与者。成员分散到45个普通账号，角色数组不接近索引预算。

```javascript
const NOW = new Date('2026-09-24T04:00:00.000Z')
const serial = n => String(n).padStart(6,'0')
const lineId = i => `cap-line-${serial(i)}`
const nodeId = (i,j) => `cap-node-${serial(i)}-${j}`
const memberId = i => `cap-member-${String(i%45).padStart(2,'0')}`
function completedLine(i, nodesPerLine, createdAt, completedAt) {
  const ids = Array.from({length:nodesPerLine},(_,j)=>nodeId(i,j))
  return {_id:lineId(i),code:`CAP-${serial(i)}`,name:'合成售后',
    sourceTemplateId:'template-1',sourceTemplateVersion:1,status:'completed',
    version:10,nodeCount:nodesPerLine,progress:nodesPerLine,
    flowSchemaVersion:2,entryNodeId:ids[0],traversedNodeIds:ids,
    currentNodeId:ids.at(-1),currentNodeIndex:nodesPerLine-1,
    managerUserIds:['root'],memberUserIds:['processor-1','processor-2','reviewer-1','reviewer-2',memberId(i)],
    createdBy:'processor-1',createdAt,updatedAt:completedAt,completedAt,
    purgeDueAt:new Date(completedAt.getTime()+60*86400000)}
}
```

完成源时同步node/feedback/round/votes的businessLineId、nodeCode和完成日期，稳定节点键为`stable-node-0..4`。审核小样本分any/all/无审核，all必须生成全部审核者票；不拿无效样本凑规模。每条首/末源都通过buildFinalFieldResult。快照valid由selectionSnapshot生成；stale仅改派生sourceHeader，权威数据不变，回源应恢复相同结果。

8列矩阵用4类×5品牌×125型号=2500组合去最后5行，后5属性列只让第4列有2个交替值、其余null；定义中保留各属性列身份，选中第一行有效值。映射采用索引，字典均合成。额外小样本覆盖同名字段不同字典、隐藏与未填、条件分支、被跳过的节点和返工旧轮；使用真实域函数校验有效数据，故意损坏数据在测试名中明确标注。

- [x] **1.4 运行数据测试并审查范围。** 对每个合法小变体验证最终来源，跳过节点结果null，过往驳回轮不得计入最终值。不得导出真实字段。明确只是在构造测试模型，不把5节点写成真实模板事实。
- [x] **1.5 保存独立检查点。** 若采用本地分任务提交，仅显式暂存上述两个新文件，检查staged diff后提交 `test: add synthetic capacity fixtures`；不能夹带既有文件或推送GitHub。Git写权限不足时保留工作区，按正常审批流程处理。

## Task 2: 只读数据库适配器与测量契约

**Files:** Create `tools/capacity/readonly-db.cjs`, `tools/capacity/test/readonly-db.test.cjs`。

**Interfaces:**
- Consumes: task1 fixture的get/entries；`createFakeCloudDatabase`仅在契约测试使用。
- Produces: `createReadonlyDatabase({source, maxReads=20000, maxMs=30000, maxHeapBytes=268435456, beforeRead, afterTransaction})` -> `{db,metrics,replaceForTest}`。
- db仅实现实际仓储需要的command.eq/gt/gte/lt/lte/in/and、collection、doc/get、where/orderBy/skip/limit/get/count、runTransaction；所有add/set/update/remove/serverDate拒绝。
- `metrics()`只返回 `{reads,queryReads,documentReads,returnedRows,transactions,maxTransactionOperations,peakActiveReads,writeAttempts}` 数字。
- `replaceForTest(collection,id,document)`仅测试控制面使用，产生新overlay代际；事务开始固定该代际，返回后新请求看见变化，不暴露为db写API。beforeRead/afterTransaction用于人为调度，不代表CloudBase事务竞争证明。

- [x] **2.1 写失败用例。** 按下例对两个adapter进行相同查询，比较结果；新adapter先因模块缺失失败。

```javascript
const test = require('node:test')
const assert = require('node:assert/strict')
const {createReadonlyDatabase} = require('../readonly-db.cjs')
const {createFakeCloudDatabase} = require('../../../cloudfunctions/businessApi/test/helpers/fake-cloud-database')
function arraySource(seed) {
  return {get:(name,id)=>structuredClone((seed[name]||[]).find(x=>x._id===id)),
    entries:function*(name){for(const item of seed[name]||[]) yield structuredClone(item)}}
}
test('stable ties and array membership match existing local oracle', async () => {
  const seed={rows:[{_id:'a',day:'2026-09-01',members:['one']},
    {_id:'b',day:'2026-09-01',members:['one']},{_id:'c',day:'2026-09-02',members:['two']}]}
  const fake=createFakeCloudDatabase(seed).db
  const probe=createReadonlyDatabase({source:arraySource(seed)})
  const query=db=>db.collection('rows').where({members:'one',_id:db.command.gt('a')})
    .orderBy('day','asc').orderBy('_id','asc').limit(1).get()
  assert.deepEqual(await query(probe.db),await query(fake))
  assert.equal(probe.metrics().returnedRows,1)
})
test('writes and transactional collection queries fail closed', async () => {
  const h=createReadonlyDatabase({source:arraySource({})})
  await assert.rejects(async()=>h.db.collection('rows').doc('a').set({data:{}}),{code:'READONLY_VIOLATION'})
  await assert.rejects(h.db.runTransaction(tx=>tx.collection('rows').where({}).get()),{code:'TRANSACTION_QUERY_FORBIDDEN'})
  assert.equal(h.metrics().writeAttempts,1)
})
```

Run: `node --test tools/capacity/test/readonly-db.test.cjs`。增加分页offset=0/20/末页、无匹配、同值排序、in/and、缺失文档、Date和ISO字符串各自相等/范围的差分表；混合日期类型仍标为本地语义，不能声称与线上SDK完全一致。

- [x] **2.2 实现最小只读子集。** 遵循现有fake的比较规则（包含gt的字符串比较与Date eq特例），不得为基线“纠正”现有fake。query构造必须不可变，多orderBy保留优先级，未支持操作抛`UNSUPPORTED_QUERY`，不得悄悄忽略。文档缺失抛与真实仓储missing识别兼容的固定文档错误，最终输出不留message。

```javascript
function coded(code) {return Object.assign(new Error(code),{code})}
function forbidWrite(state) {
  state.writeAttempts += 1
  throw coded('READONLY_VIOLATION')
}
async function measuredRead(state, limits, operation, run) {
  if(state.reads>=limits.maxReads) throw coded('MEASUREMENT_BUDGET')
  if(Date.now()-state.startedAt>limits.maxMs || process.memoryUsage().heapUsed>limits.maxHeapBytes)
    throw coded('MEASUREMENT_BUDGET')
  state.reads += 1; state.active += 1
  state.peakActiveReads=Math.max(state.peakActiveReads,state.active)
  try {
    if(limits.beforeRead) await limits.beforeRead(operation)
    await new Promise(resolve=>setImmediate(resolve))
    const result=run()
    state.returnedRows += Array.isArray(result.data)?result.data.length:(result.data?1:0)
    return result
  } finally {state.active -= 1}
}
```

上面是内部函数，limits在构造器校验为有限正整数并保存startedAt；operation只在内存含collection/id/transaction用于测试调度，不输出。queryReads/documentReads在调用measuredRead时按操作计数。count算一次queryReads但不把total当返回文档数。

事务用只读源+版本化overlay，捕获开始时overlay引用，测试控制面替换采用新Map/新对象，不能原地突变。只复制返回文档，不复制全库；禁止事务内collection查询。每次固定get计事务操作数，超过100抛`TRANSACTION_BUDGET`；事务结束更新max并运行afterTransaction，异常路径也计数。默认不注入变更的大规模运行只需空overlay，不能实现通用MVCC数据库。

- [x] **2.3 补齐预算、事务与隔离断言并跑绿。** 两次固定get之间修改控制面，同事务仍见原值、下个事务见新值；不同并发事务不共享临时状态。maxReads=1第二次读抛MEASUREMENT_BUDGET；调用set/update/remove/add/serverDate每种都拒绝。读得到的对象被修改不能污染下一读。输入unsupported operator、NaN/负数offset/limit都明确拒绝。
- [x] **2.4 保存检查点。** 仅两新文件，`test: add bounded read-only capacity adapter`。不能修改fake以使差分测试通过，若现有fake与当前仓储所需语义矛盾，记录边界并停止相应场景，不扩大到产品修复。

## Task 3: 接入真实只读场景和完整性判断

**Files:** Create `tools/capacity/workspace-fixtures.cjs`, `tools/capacity/scenarios.cjs`, `tools/capacity/test/scenarios.test.cjs`。

**Interfaces:**
- Consumes: tasks1/2；真实createCloudOperationsFieldRepository/createCloudOperationsRepository/createCloudBusinessRepository/createCloudReviewRepository/createDashboardWorkspaceService/createPreviousNodeResultRepository。
- Produces: `listScenarios(profile)` -> 固定场景描述数组；`runScenario({name,profile,budgets})` -> Promise安全聚合结果。
- 小样本工厂 `createWorkspaceFixture({kind,count,readPercent=50})` 的kind只允许`dashboard/list/previous`，返回 `{seed,actor,input}`；seed使用原fake DB集合形状，actor为合成当前账号，input为真实仓储调用的业务/节点/锚点参数。返回数据交给只读adapter测量，竞争测试另交给原fake DB。
- 固定profile为`smoke/month/half-year/year`；result只含schemaVersion=1、scenario、profile、measurement=`local-synthetic`、outcome、complete、counts、metrics。counts含sampledNodes/responseBytes/pages/rows，缺失值用null，不能猜0。outcome仅`ok/known_limit/incomplete/expected_denial/test_aborted/error`。

- [x] **3.1 先写真实结果断言。** 月度全节点已知超过2000，不允许测试通过后报告为可支持4500；缺失快照可回源，缺权威来源才是不完整。

```javascript
const test=require('node:test')
const assert=require('node:assert/strict')
const {runScenario}=require('../scenarios.cjs')
test('smoke reads real final sources without writes',async()=>{
  const r=await runScenario({name:'field-summary',profile:'smoke'})
  assert.equal(r.outcome,'ok');assert.equal(r.complete,true)
  assert.equal(r.counts.sampledNodes,150)
  assert.equal(r.metrics.writeAttempts,0)
  assert.ok(r.metrics.maxTransactionOperations<=100)
})
test('monthly all-node request records existing limit, not capacity success',async()=>{
  const r=await runScenario({name:'field-summary',profile:'month'})
  assert.equal(r.outcome,'known_limit');assert.equal(r.complete,false)
  assert.equal(r.counts.sampledNodes,null)
})
```

Run: `node --test tools/capacity/test/scenarios.test.cjs`；先RED，完成后GREEN。测试用例本身可以成功验证“当前不支持”，用户报告不能把该场景写成容量通过。

- [x] **3.2 实现接线，不复制产品逻辑。** 固定synthetic secret只供本地游标；不读取env。构造真实operationsRepository，禁止用固定空数组stub替代完整报告基础来源。

```javascript
const {createCloudOperationsRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-repository')
const {createCloudOperationsFieldRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-field-repository')
const {normalizeFieldQuery}=require('../../cloudfunctions/businessApi/lib/operations-field-service')
const {normalizeAnalysisQuery,normalizeFieldReportQuery}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis-query')
function fieldRepositories(db,now) {
  return createCloudOperationsFieldRepository({db,
    operationsRepository:createCloudOperationsRepository({db}),
    secret:'capacity-local-only-'.repeat(4),clock:()=>new Date(now)})
}
```

场景函数中创建独立repository实例；报告相邻页使用同一实例，冷实例续页另测。日期窗口为最新30个完整上海自然日；smoke仅1天30条，但仍按相同30天窗口读取。`field-summary`全部5稳定节点，`field-single-node`限定stable-node-0；`field-analysis`调用getAnalysis且analysis.view='catalog'；`field-filters`调用getFilters；`report-v1/report-v2`以pageSize=50遍历至hasMore=false，v2用catalog上下文，v1不携带analysis/reportVersion。

报告每页累加响应字节/行数但不输出行值，不保留全部页；同时核对hasMore和nextCursor一致性、游标不得循环、页数受maxReads/time预算约束。完整最后一页前complete始终false。report first-page另有场景，只输出该页完整性，不能叫整份报告完成；每页读增量与整份累计分别存不同计数槽，不把两者相加。

场景矩阵分开运行，禁止历史×全部特征×50并发笛卡尔展开：

| 场景族 | 合成输入与具体比较 |
| --- | --- |
| fields | smoke1天、month30天、half-year180天、year365天；最新30天窗口固定，记录全5节点与单节点；半年/全年可能先触发5000售后边界 |
| history-growth | 使用1/30/180/365天历史，但仅最新1天命中30条/150节点，旧数据完成时间在窗口外；仍同模板，不能通过切换templateId隐藏旧历史扫描 |
| snapshot-state | 仅smoke，missing/valid/stale三个独立实例比较计数一致与读取差异；损坏最终来源单独输出incomplete |
| dashboard | 0/10/50/100待处理节点、待审核轮和已读比例0/50/100%，复用现有dashboard-performance及business-read-performance持久形状；同时测business summary与review/notification聚合，不把stub业务summary称为完整首页 |
| list | 100条合成活动售后，第1/2/5页各20条，排序相同值稳定，不变授权/complete语义 |
| previous | 0/6/40/94附件元数据，94用不同已发布反馈归属且版本一致，沿用previous-node-result.test.js现有setup与附加证据构造；真实getPreviousNodeResult，不调用签名URL/下载 |
| isolation | 10/20/50不同合成账号交错，只使用小数据；每请求独立仓储上下文，输出授权计数差异而非账号ID；不是用户并发容量证明 |
| linkage | 1个2495组合矩阵的源、多选、同名异义、空值与隐藏值，真实summary/analysis/report-v2三路结果对照；不扩大到整年矩阵 |

dashboard/list/previous小场景统一由workspace-fixtures中的显式kind分支构造；参考现有测试的已验证形状，不修改/导出现有test文件，不与大历史数据工厂混合。dashboard需要真实businessService和reviewService接线；workTime只允许无副作用的既有读取依赖，任何触发写入的入口明确拒绝，不能改产品行为让工具运行。

- [x] **3.3 加入兼容性和权限竞争验证。** 在既有fake DB的小样本中用beforeNextTransaction/transformRead控制停用、撤权、来源变化；不要用只读adapter简化事务替代既有安全回归。固定执行这些真实套件：

```powershell
node --test cloudfunctions/businessApi/test/dashboard-performance.test.js cloudfunctions/businessApi/test/business-read-performance.test.js cloudfunctions/businessApi/test/cloud-operations-field-repository.test.js cloudfunctions/businessApi/test/cloud-operations-field-analysis.test.js cloudfunctions/businessApi/test/operations-field-analysis-report.test.js cloudfunctions/businessApi/test/previous-node-result.test.js
```

新增小样本对report-v1/v2遍历计数与真实domain导出结果对照；同一有效范围统计与报告选项次数一致。中途调换两账号续页仍拒绝、同实例来源变化REPORT_CHANGED、禁用FORBIDDEN、缺最终源INCOMPLETE_FIELD_DATA；受这些错误影响的报告complete=false，不导出可发送文件。any/all/无需审核、返工历史和实际路由的真值由fixtures返回的权威source确定。

- [x] **3.4 跑绿并保存检查点。** 只提交本任务新工具/测试，`test: measure real read-only workflow scenarios`。实际精确读数第一次运行记录，不从旧文档硬抄；期望功能计数是先验，测得读数是结果。任何新失败涉及原产品时先报告，不为让基线跑完而改上限。

## Task 4: 有界离线CLI和安全结果输出

**Files:** Create `tools/capacity/run.cjs`, `tools/capacity/test/runner.test.cjs`。

**Interfaces:** Consumes listScenarios/runScenario；Produces CLI `node tools/capacity/run.cjs --profile smoke`，可显式`--scenario field-summary`；大档支持`--max-ms/--max-reads/--max-heap-mb`正整数。不接受env、URL、账号、凭据或客户数据路径参数。

- [x] **4.1 写CLI失败用例。** 使用node:child_process的execFile（非shell），空参数=smoke；未知profile/参数返回2。原始异常带payload/path时输出不得含这些值。父进程超时中止不能输出ok。

```javascript
const test=require('node:test')
const assert=require('node:assert/strict')
const {execFile}=require('node:child_process')
const {promisify}=require('node:util')
const path=require('node:path')
const execute=promisify(execFile)
const entry=path.resolve(__dirname,'../run.cjs')
test('production environment switches are not supported',async()=>{
  await assert.rejects(execute(process.execPath,[entry,'--env','production']),e=>e.code===2)
})
test('bounded result is JSON without raw records',async()=>{
  const {stdout}=await execute(process.execPath,[entry,'--profile','smoke','--scenario','field-summary'])
  const r=JSON.parse(stdout.trim())
  assert.equal(r.measurement,'local-synthetic')
  assert.equal(r.complete,true)
  assert.doesNotMatch(stdout,/cloud:\/\/|openid|fieldValues|memberUserIds|nodeCode/)
})
```

Run: `node --test tools/capacity/test/runner.test.cjs`；先RED。预算强制测试使用内部可注入worker工厂/时钟，不新增命令行任意模块执行入口。专用挂起fixture位于test目录，仅测试父进程终止路径。

- [x] **4.2 实现父子隔离和严格参数。** 每场景单独子进程，只有上一子进程退出后启动下一场景；默认子进程heap上限256MiB、时间30秒、逻辑读20000次。大档必须显式profile，可在命令中给60秒/100000读/512MiB；这些是本机测试保护预算，不是生产服务指标。子进程环境用最小白名单（Windows必须项SystemRoot/TEMP/TMP，及必要PATH）；不传凭据、NODE_OPTIONS、CloudBase环境值，不读取环境中配置的生产信息。

父进程按maxMs定时终止单个子进程，不因stderr可能含栈/路径而原样回显；退出信号/内存失败固定映射test_aborted。IPC只传固定场景名和数字预算，worker只回安全聚合result；未知错误映射error且非零退出，不把所有错误当RANGE_TOO_LARGE。输出一行一个场景JSON。

```javascript
function classify(error) {
  const code=error && error.code
  if(code==='RANGE_TOO_LARGE') return 'known_limit'
  if(code==='INCOMPLETE_FIELD_DATA') return 'incomplete'
  if(code==='MEASUREMENT_BUDGET') return 'test_aborted'
  return 'error'
}
```

只对专门声明预期拒绝的安全场景把FORBIDDEN/REPORT_CHANGED分类expected_denial；普通场景遇到同样错误为error。所有外部输出对象重新白名单投影，不展开异常/仓储响应。known_limit不输出原始错误，complete=false且CLI退出码1；unknownerror/abort同为1，非法参数2，全部场景满足明确期望且完整才为0。报告已完成页数但中断，行数可为已读下界，complete=false。

- [x] **4.3 验证不意外接触外部系统。** 工具只导入真实纯域/仓储模块和测试helper，不require云函数index、wx-server-sdk、COS、网络客户端；运行器不实现HTTP调用。测试拦截Node网络入口及global.fetch为抛错，检查场景仍运行；检查工具依赖闭包无SDK/凭据读取。不能声称这是操作系统级网络沙箱，执行时仍在受限环境。工具放在tools/capacity，产品不能反向导入，发布目录清单不得带这些文件。
- [x] **4.4 跑绿与实际基线。** 默认smoke全跑；month/half-year/year先各执行field-summary/history-growth，明确测量预算，逐条记录结果，不自动循环重试超时或加预算。大报告预算中断是有效发现但不是功能验收通过。验证CLI超时/限读/内存故障分类后提交两文件：`test: add bounded offline capacity runner`。

## Task 5: 既有诊断白名单扩充，前端功能保持不变

**Files:** Modify `miniprogram/utils/performance-timing.js`（只改ACTIONS）；Create `tools/capacity/test/diagnostics.test.cjs`。

**Interfaces:** Consumes真实services/business的8个现有方法及callBusinessApi；Produces相同返回、异常、提示与调用次数，只在显式开启时多记录既有安全计时格式。没有新页面/按钮/存储/API或整份报告计时器。

- [x] **5.1 写先失败的白名单测试。** 下例每方法一个子测试，避免全局wx/getApp并发污染；t.after恢复globals。传入和返回不同合成敏感标记，确认未进入timings。

```javascript
const test=require('node:test')
const assert=require('node:assert/strict')
const business=require('../../../miniprogram/services/business')
const actions=['getOperationsDashboard','exportOperationsRows','getOperationsAnalyticsFilters',
  'getOperationsAnalyticsSummary','getOperationsFieldSummary','getOperationsFieldFilters',
  'getOperationsFieldAnalysis','exportOperationsReportRows']
for(const action of actions) test(`opt-in ${action} does not change the business call`,async t=>{
  const previousWx=global.wx,previousApp=global.getApp
  t.after(()=>{global.wx=previousWx;global.getApp=previousApp})
  const app={globalData:{performanceDiagnostics:true}}, requests=[]
  const data={private:'synthetic-response'}
  global.getApp=()=>app
  global.wx={showToast(){assert.fail('success must not toast')},cloud:{async callFunction(request){
    requests.push(request);return {result:{ok:true,data}}
  }}}
  assert.deepEqual(await business[action]({private:'synthetic-input'}),data)
  assert.equal(requests.length,1)
  assert.equal(requests[0].data.action,action)
  assert.equal(app.globalData.performanceTimings.length,1)
  assert.equal(app.globalData.performanceTimings[0].action,action)
  assert.deepEqual(Object.keys(app.globalData.performanceTimings[0]).sort(),['action','durationMs','outcomeCode'])
  assert.doesNotMatch(JSON.stringify(app.globalData.performanceTimings),/private|synthetic/)
})
```

Run: `node --test tools/capacity/test/diagnostics.test.cjs`；未追加前每项因缺timings失败。不能改service以绕过测试。

- [x] **5.2 最小实现。** 只在原ACTIONS追加以下字符串，不改其他语句、默认状态或格式：

```javascript
'getOperationsDashboard', 'exportOperationsRows',
'getOperationsAnalyticsFilters', 'getOperationsAnalyticsSummary',
'getOperationsFieldSummary', 'getOperationsFieldFilters',
'getOperationsFieldAnalysis', 'exportOperationsReportRows'
```

- [x] **5.3 验证关闭/开启/故障行为等价。** 扩展每方法场景，记录原返回/安全异常code/message、toast数组与请求参数/次数，对比diagnostics undefined/false/true、getApp抛错及globalData访问失败；诊断故障不得产生额外请求或改变Promise结果。105次调用仍最多100条，关闭后下一记录清空；用户未开启时不创建样本。未知action、NaN/Infinity、非法stage不得进入样本，既有上传三阶段仍原样通过。

```powershell
node --test tools/capacity/test/diagnostics.test.cjs miniprogram/test/performance-diagnostics.test.js miniprogram/test/cloud-performance.test.js miniprogram/test/diagnostic-isolation.test.js
node --test miniprogram/test/*.test.js
```

报告分页一个request一个样本，整份CSV耗时留给手工起止观测，100条内存环形缓冲不足时明确截断，不自动增大缓存/上传日志，也不以分页和整份耗时相加。
- [x] **5.4 检查产品diff后保存检查点。** 唯一白名单增加+测试新文件；提交 `perf: extend opt-in operations timing coverage`。若需要公共请求、页面、上传或错误文案改动，停止本任务并向用户说明，不自行扩围。

## Task 6: 全量回归、验收清单与统一复核

**Files:** Create `docs/deployment/capacity-reliability-acceptance.md`; Modify `docs/memory/STATUS.md`；PROJECT仅当稳定事实需更新。

**Interfaces:** Consumes各task测试及安全基线；Produces带准确状态的测量表、兼容验收表、B/C建议次序，不产出线上容量承诺。

- [x] **6.1 写真实验收表和运行说明。** 每项至少包含版本/条件/期望/结果/证据/是否用户批准；缺证据统一unverified。目录与字段固定如下，填写当轮真实数值，不复制旧套件数目：

```markdown
## 本地基线
场景 | 样本规模 | 读取/返回记录 | 事务/最大操作 | 应用并发峰值 | 响应字节/页数 | outcome/complete
## 原前端功能回归
功能 | 自动用例 | Android | HarmonyOS | iOS | macOS | Windows | 影响/批准
## 线上只读待核查
指标 | 当前证据 | 风险与后续动作 | 授权状态
## 后续优先级
证据 | B统计/导出或C首页 | 保留语义 | 另需设计/批准
```

前端逐项：登录/切账号；创建与模板编辑/复制/启用；分类→品牌→型号→多属性严格联动；保存草稿、智能预填确认；图片/视频多选、3路传输/串行登记/重试、MOV/JPG和PDF原入口；审批通过/驳回/返工及意见；前序结果/审核历史/返回草稿；统一卡片字段/节点数/摘要重试；检索/翻页；工时图表/字段关联/零记录隐藏；CSV生成/取消/发送与来源变化；分享与临时附件访问。验收不得新增真实售后或发通知，需写测试则先约定隔离对象。

线上清单：套餐与计费模式/已用资源、失败率和超时、读调用/索引与存储、对象增长和下载流量、派生积压、提醒待发/失败、purge到期/租约失败、备份覆盖范围及隔离恢复证据。未知不填0；数据与媒体分别核对。每项“仅检查”不等于允许变更，恢复不得覆盖生产，不能为了省容量缩短60天。

容量公式：`30*100MB=3GB/天`；完成保留约`3*60=180GB`；按每个在途预留100MB的保守估算追加`3*平均处理天数GB`；旧修订仅在100MB未包含时另计。下载流量和费用另测，不给未核实价格承诺。

- [x] **6.2 执行最终新鲜验证。** 每命令核对退出码与完整统计；失败定位为本次或既有，不降级标准。修改只涉及上述路径也必须完整客户端回归，后端全量确认工具未污染shared helper：

```powershell
node --test tools/capacity/test/*.test.cjs
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/operationsAnalytics
node --test miniprogram/test/*.test.js
node tools/test-business-card-rendering.mjs
node tools/test-previous-node-records-rendering.mjs
node tools/test-operations-field-analysis-rendering.mjs
node tools/test-wxml-structure.mjs
git diff --check
python "C:/Users/87579/.codex/skills/maintaining-project-memory/scripts/validate_memory.py" .
```

真实设备和云端压测均不因以上通过而完成。A只证明基线工具及诊断兼容；B/C未实施前不能称“已支持全年数据”。

- [x] **6.3 对比首步工作区摘要及请求/界面证据。** 除performance-timing白名单以外所有产品文件摘要应相同，project.config亦相同；生成工具在tools目录，不包含在miniprogramRoot或cloudfunctionRoot载荷。新增/删除文件同样比对，不能只比原有文件。用户并发编辑造成差异先说明归属，不覆盖。页面/组件自动渲染与原请求行为检查都通过，才可标记本地前端无已知回退。
- [x] **6.4 最后统一独立复核。** 沿用用户偏好的连续开发、最后统一复核；reviewer只看本次显式路径/增量和规格，重点检查五个Review Focus、测试模型真实性、只读/输出安全、未知失败分类及唯一白名单变更。缺陷先新增失败测试再修；如果修复要求改变前端既有行为或后端协议，暂停相关部分请用户批准。
- [x] **6.5 记忆与交付。** STATUS记录实际套件数量、基线结果与已知限制，明确未发布/未上传/五端和生产未验证；更新后重跑validator和diff check。文档提交仅明确本次新增清单；STATUS/PROJECT含其他未提交历史，按增量审阅，不整文件盲目夹带。最终给用户“当前瓶颈、下一批建议、任何可能影响及待批准项”，再决定B或C设计；本计划不自动推进生产或整体重构。

## 执行前自查与批准状态

- 规格1–3映射全局约束及A/B/C/D边界；规格4映射task1/3；5.1映射task2/3/4；5.2映射task5；5.3及6–8映射task6和全局批准门槛。
- 只读工具内部接口名称：createCapacityFixture、createProductSource、createReadonlyDatabase、listScenarios、runScenario；task之间名称一致。所有额外测试数据都为合成值。
- Review Focus五项分别有任务和具体断言/核验步骤，不把数据回退或缺少设备验收当成“无影响”。
- 本计划编写期间没有实施上述步骤；所有执行复选框保持未勾选。用户确认计划后再执行；建议保持“连续开发、最后统一复核”。
