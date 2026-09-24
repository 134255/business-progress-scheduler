# B1 完整导出读取去重 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 减少同样报告的重复读取，保持既有前端功能、CSV内容、排序、分页、权限与来源完整性检查。

**Architecture:** 在单次完整导出中记录已通过首次事务核验的来源文档ID，尾部直接重新读取权威文档，省去事务外重复预读；审核票仍重新发现。完整报告基础读取明确排除未使用的待审核列表，其余调用维持默认行为。无新产品模块、持久缓存或外部资源。

**Tech Stack:** 现有CommonJS Node.js、CloudBase仓储、node:test、原生小程序及A批次离线只读测量工具；不添加依赖。

**Spec:** `docs/superpowers/specs/2026-09-24-export-read-deduplication-design.md`（2026-09-24用户确认推进，强调全部功能不受影响）。

## Global Constraints

- 安卓、鸿蒙、iOS、macOS、Windows现有前端功能均受保护：CSV列、内容、顺序、分页和“生成文件→发送文件”操作不变。
- 任何其他实际功能、权限或错误语义影响，须先获用户批准，不能以性能收益抵消。
- 保留2000候选节点、5000候选售后、10000扫描节点、50000报告行和12MiB报告预算。
- 沿用现有最多3份、合计12MiB的进程报告缓存；游标有效期20分钟；最终核验并发最多4，事务最多100操作，审核票扫描上限50。
- 保留首轮与尾部事务核验及最后账号/售后检查；不跨页、跨账号或跨请求复用来源引用，不将其写入摘要、游标、响应或缓存。
- 完整报告不再受无关待审核列表查询故障阻断是规格明确披露的调整；仍需读取的反馈/审核/基础来源错误不能吞掉。待审核页面及旧导出保留原默认行为。
- 50名员工、30条售后/天、100MB/条仅为规划输入；120MiB每处理轮和60天保留不变，不宣称本批解决月度4500节点超限。
- 保留原目录中全部既存改动，以本次启动文件摘要和增量为界；不重置、切换、覆盖脏目录，不自动提交或推送。
- 采用已指定的“连续开发、最后统一复核”：主代理逐项实现，最后一次独立整体复核；不为每个任务另建任务或派一个复核者。
- 开发与发布分开；本计划不授权云端读写、索引/Timer/权限变更、发布函数、上传小程序或真实业务测试。

## Review Focus

1. 反馈ID/审核轮次换了但可见值没变，旧报告仍须拒绝；不能只比较导出文字。任务2测试精确来源身份变化。
2. 暖缓存续页在基础验证期间增加、删除或替换审核票，必须继续发现并拒绝；不能只重读旧票ID。任务2同时测试冷首请求和暖续页。
3. 新增候选与未匹配分析候选变化、基础历史显示名变化，续页不能漏查；有效旧游标不能因内部引用污染摘要而失效。任务1固化基线，任务4验证兼容。
4. 创建日期与完成日期不同、空结果、0/false、隐藏字段和2495组合规则不能因去重而丢失或改序。任务1保留原内容断言，任务4比对完整行序列。
5. 小数据变快不代表整份报告完成；读预算中止、写入尝试、原始错误不可泄露或冒充成功。任务4保留A工具故障注入及明确未完成状态。

## 文件边界及顺序

| 路径 | 操作及职责 |
| --- | --- |
| `cloudfunctions/businessApi/lib/cloud-operations-field-repository.js` | 修改：请求内来源ID引用与尾部核验编排；不改公开返回契约 |
| `cloudfunctions/businessApi/lib/cloud-operations-repository.js` | 修改：完整报告基础读取选项；默认路径不变 |
| `tools/capacity/report-probe.cjs` | 新增：仅离线测试用的真实仓储探针，复用A只读数据库和既有合成来源 |
| `tools/capacity/test/export-read-deduplication.test.cjs` | 新增：精确读取轨迹、来源竞争、旧游标和内容兼容回归 |
| `tools/capacity/test/fixtures/export-report-before-b1.json` | 新增：改产品前生成的纯合成报告摘要/分页摘要基线；无真实记录、令牌或凭据 |
| `cloudfunctions/businessApi/test/cloud-operations-repository.test.js` | 修改：完整基础报告与旧仪表/导出读取分离的测试 |
| `tools/capacity/test/scenarios.test.cjs` | 修改：必要时修正因真实省读而失效的测试预算假定，不能删除未完成检查 |
| `docs/deployment/export-read-deduplication-acceptance.md` | 新增：前后测量、功能保护及未验证范围 |
| `docs/memory/STATUS.md`、本计划 | 修改：事实、检查点和下一步；PROJECT仅稳定事实有变时更新 |

先完成任务1的改动前基线，再做任务2和3，最后任务4统一验收。产品文件不超出前两项；测试/工具不能被产品反向引用。若需扩大范围，停止相关部分说明原因并请用户批准。

### Task 1：建立导出兼容基线和可观测探针

**Files:** Create `tools/capacity/report-probe.cjs`、`tools/capacity/test/export-read-deduplication.test.cjs`、`tools/capacity/test/fixtures/export-report-before-b1.json`。读取现有 `tools/capacity/readonly-db.cjs`、`fixtures.cjs`、`scenarios.cjs` 和 `cloudfunctions/businessApi/test/helpers/field-fixtures.js`，不修改共享fake或A只读适配器。

**Interfaces:**

- Consumes：`fieldSource({nodeId,reviewed,line,node,round,votes})`、`createReadonlyDatabase({source,beforeRead,afterTransaction,...budgets})`、`arraySource(seed)` 和两个现有仓储工厂。
- Produces：`reportSources(count=1, mode='none') -> Array<Source>`，mode仅none/any/all；`createReportProbe({sources,realBase=false,baseRows=[],hook=()=>{},beforeRead=()=>{}}={}) -> probe`。baseRows仅是stub模式的合成预算测试输入。
- `probe`提供 `actor`、`sources`、`trace`、`metrics()`、`replace(collection,id,document)`、`range(version=1,pageSize=2)`、`repository`、`operationsRepository`、`freshRepository()`、`advanceClock(ms)`、`codec`。
- Produces：`captureContract(probe,version=1) -> {rowsDigest,rowCount,firstCursorBody,firstPageReads,warmPageReads,coldPageReads}`；仅合成源，摘要保留数组顺序。

- [x] **1.1 建立本批文件检查点，运行现有基线。** 用Node的`fs.readdirSync/readFileSync`与`crypto.createHash('sha256')`列出miniprogram、cloudfunctions（排除node_modules）及project.config.json，保留相对路径和摘要；检查点通过apply_patch保存在已忽略的 `.superpowers/sdd/2026-09-24-export-read-deduplication/`。另保存两个将改产品文件的本次起始副本或精确差异作为局部回退依据，不用Git HEAD替代脏目录起点。记录git status及空暂存区；不记录账号/环境变量/业务数据。

```powershell
node --test cloudfunctions/businessApi/test/cloud-operations-field-repository.test.js cloudfunctions/businessApi/test/operations-field-analysis-report.test.js cloudfunctions/businessApi/test/cloud-operations-field-analysis.test.js
node --test tools/capacity/test/*.test.cjs
node tools/capacity/run.cjs --profile smoke --scenario report-v1
node tools/capacity/run.cjs --profile smoke --scenario report-v2
```

两个报告测量目前预期退出1并标记test_aborted，记录完整输出的安全计数；不视为通过或自动提高预算。只读测试命令应退出0，实际数量现场记录。

- [x] **1.2 先写探针测试并运行，确认缺少新模块而失败。** 新测试文件引入新探针模块，固定如下首个契约测试；不编辑产品来迁就探针。

```javascript
const test = require('node:test')
const assert = require('node:assert/strict')
const {createReportProbe, reportSources, captureContract} = require('../report-probe.cjs')

test('probe preserves real source contracts with zero writes', async () => {
  for (const mode of ['none','any','all']) {
    const p = createReportProbe({sources:reportSources(1,mode),realBase:true})
    const result = await captureContract(p,2)
    assert.ok(result.rowCount > 2)
    assert.match(result.rowsDigest,/^[a-f0-9]{64}$/)
    assert.equal(p.metrics().writeAttempts,0)
    assert.ok(p.metrics().maxTransactionOperations <= 100)
  }
})
```

Run: `node --test tools/capacity/test/export-read-deduplication.test.cjs`。Expected：仅新模块缺失的预期失败；若加载现有模块失败先解决测试路径，不改产品。

- [x] **1.3 实现小型离线探针。** `reportSources`为各节点生成独立售后、反馈、轮次与票，审核模式按现有权威结构生成；先调用`buildFinalFieldResult`证明每个来源合法。核心代码：

```javascript
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const {fieldSource}=require('../../cloudfunctions/businessApi/test/helpers/field-fixtures')
const domain=require('../../cloudfunctions/businessApi/lib/operations-field-domain')
const {createReadonlyDatabase,arraySource}=require('./readonly-db.cjs')
const {createCloudOperationsRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-repository')
const {createCloudOperationsFieldRepository}=require('../../cloudfunctions/businessApi/lib/cloud-operations-field-repository')
const {createOperationsReportCursor}=require('../../cloudfunctions/businessApi/lib/operations-report-cursor')
const {normalizeFieldReportQuery}=require('../../cloudfunctions/businessApi/lib/operations-field-analysis-query')
const PROBE_SECRET='synthetic-b1-only-'.repeat(4)
function reportSources(count=1,mode='none') {
  if (!Number.isSafeInteger(count) || count<1 || count>150 ||
      !['none','any','all'].includes(mode)) throw new Error('INVALID_PROBE_INPUT')
  return Array.from({length:count},(_,i)=>{
    const s=fieldSource({nodeId:`probe-node-${i}`,reviewed:mode!=='none',
      line:{_id:`probe-line-${i}`,code:`PROBE-${i}`}})
    if(mode==='all') {
      s.node.reviewMode='all';s.round.reviewMode='all'
      s.round.approvedVoteCount=2;s.round.voteCount=2
      s.votes.push({...s.votes[0],_id:`probe-second-vote-${i}`,
        reviewerUserId:'reviewer-2',reviewerDisplayName:'合成审核人二'})
    }
    if(!domain.buildFinalFieldResult(s)) throw new Error('INVALID_PROBE_SOURCE')
    return s
  })
}
```

探针使用固定2026-09-24时钟、固定纯合成测试密钥（如`'synthetic-b1-only-'.repeat(4)`，不得读取环境凭据）、超级管理员root。由sources合成users/business_lines/business_nodes/node_feedback/node_review_rounds/node_review_votes；去重售后ID，包含fixture里的合成人员账号以支持旧显示名回退。

```javascript
function createReportProbe({sources=reportSources(),realBase=false,baseRows=[],
  hook=()=>{},beforeRead=()=>{}}={}) {
  const actor={_id:'root',role:'super_admin',status:'active',displayName:'合成管理员'}
  const ids=new Set(sources.flatMap(s=>[...s.node.processorUserIds,...s.node.reviewerUserIds]))
  const people=[...ids].filter(id=>id!==actor._id).map(_id=>
    ({_id,role:'user',status:'active',displayName:'合成人员'}))
  const seed={users:[actor,...people],
    business_lines:[...new Map(sources.map(s=>[s.line._id,s.line])).values()],
    business_nodes:sources.map(s=>s.node),node_feedback:sources.map(s=>s.feedback),
    node_review_rounds:sources.map(s=>s.round).filter(Boolean),
    node_review_votes:sources.flatMap(s=>s.votes),operations_field_snapshots:[]}
  const trace=[]
  let probe,clockMs=Date.parse('2026-09-24T04:00:00.000Z')
  const clock=()=>new Date(clockMs)
  const h=createReadonlyDatabase({source:arraySource(seed),
    beforeRead:async op=>{trace.push({...op});await beforeRead(op,probe)}})
  const real=createCloudOperationsRepository({db:h.db})
  const base={
    async collectReportBase(input) {
      await hook({stage:'collect',probe})
      return realBase ? real.collectReportBase(input) : {items:structuredClone(baseRows),manifest:{lines:[],nodes:[]}}
    },
    async validateReportBase(input) {
      await hook({stage:'validate',probe})
      if(realBase) await real.validateReportBase(input)
    }
  }
  const freshRepository=()=>createCloudOperationsFieldRepository({db:h.db,
    operationsRepository:base,secret:PROBE_SECRET,clock})
  probe={actor,sources,trace,metrics:h.metrics,replace:h.replaceForTest,
    operationsRepository:real,freshRepository,repository:freshRepository(),
    advanceClock(ms){clockMs+=ms},codec:createOperationsReportCursor({secret:PROBE_SECRET,clock}),
    range(version=1,pageSize=2) {
      assert.ok([1,2].includes(version))
      return normalizeFieldReportQuery({startDate:'2026-09-01',endDate:'2026-09-23',pageSize,
        ...(version===2?{reportVersion:2,analysis:{view:'catalog'}}:{})},clock())
    }}
  return probe
}
```

probe.range以 `normalizeFieldReportQuery` 构造9月1日至23日筛选；version1省略reportVersion，version2传`reportVersion:2,analysis:{view:'catalog'}`。允许测试用`{...p.range(2),analysis:合法筛选}`覆盖查询。replace绑定`h.replaceForTest`，metrics绑定h.metrics，operationsRepository为real，advanceClock只增本地时钟，codec使用相同clock/密钥的`createOperationsReportCursor`。无新CLI、网络入口、写入或自动快照更新。

`captureContract`每次使用新probe：第一页pageSize2，记录读取增量；第二页暖实例及相同游标冷实例分别计增量，并断言items/hasMore一致；沿暖实例继续完整遍历，最多50000行，断言无空续页或重复游标。对完整有序rows计算SHA256，不排序或去重。实现如下，assert/crypto为Node内置模块，PROBE_SECRET只在createReportProbe内部使用，不由capture输出：

```javascript
const canonical=value=>value instanceof Date ? value.toISOString() :
  Array.isArray(value) ? value.map(canonical) : value && typeof value==='object' ?
    Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function captureContract(p,version=1) {
  const range=p.range(version,2)
  const measure=async(repository,query)=>{
    const start=p.metrics()
    const page=await repository.exportReportRows({actor:p.actor,range:query})
    const end=p.metrics()
    return {page,reads:end.reads-start.reads,transactions:end.transactions-start.transactions}
  }
  const first=await measure(p.repository,range)
  assert.equal(first.page.hasMore,true,'contract fixture must span pages')
  const query={...range};delete query.cursor;delete query.pageSize
  const firstCursorBody=p.codec.decode(first.page.nextCursor,
    {actorId:p.actor._id,queryDigest:hash(canonical(query))})
  const continuation={...range,cursor:first.page.nextCursor}
  const warm=await measure(p.repository,continuation)
  const cold=await measure(p.freshRepository(),continuation)
  assert.deepEqual(warm.page.items,cold.page.items)
  assert.equal(warm.page.hasMore,cold.page.hasMore)
  const rows=[...first.page.items,...warm.page.items]
  const seen=new Set([first.page.nextCursor])
  let page=warm.page
  for(;;) {
    assert.equal(page.hasMore,Boolean(page.nextCursor))
    assert.ok(rows.length<=50000)
    if(!page.hasMore) break
    assert.ok(page.items.length>0 && !seen.has(page.nextCursor))
    seen.add(page.nextCursor)
    page=await p.repository.exportReportRows({actor:p.actor,range:{...range,cursor:page.nextCursor}})
    rows.push(...page.items)
  }
  assert.equal(p.metrics().writeAttempts,0)
  return {rowsDigest:hash(rows),rowCount:rows.length,firstCursorBody,
    firstPageReads:first.reads,warmPageReads:warm.reads,coldPageReads:cold.reads,
    firstPageTransactions:first.transactions,warmPageTransactions:warm.transactions,
    coldPageTransactions:cold.transactions,maxTransactionOperations:p.metrics().maxTransactionOperations}
}
```

正常无结果测试直接调用repository，不用此要求多页的基线捕获函数。对非导出路径另在改产品前保存相同小fixture的getSummary/getFilters/getAnalysis响应摘要及读轨迹摘要，分别从新probe起步；不把权限身份原值或返回字段正文写入验收日志。

模块末尾仅导出 `module.exports={reportSources,createReportProbe,captureContract}`，require时不执行测试、测量或写文件。

- [x] **1.4 运行探针测试，产品仍不变时生成固定基线。** 对none/any/all各一个节点、realBase=true、v1/v2共6种情况调用captureContract，另对`createProductSource()`的2495组合来源记录v2契约。通过只读Node命令打印7项结果，审查仅合成摘要/计数后用apply_patch写入JSON；冻结该文件，后续不得为适配新实现更新其结果。基线附起始两产品文件SHA256，确认不是从已经修改后的代码生成。

```javascript
const baseline=[]
for(const mode of ['none','any','all']) for(const version of [1,2]) {
  const p=createReportProbe({sources:reportSources(1,mode),realBase:true})
  baseline.push({caseId:`${mode}-v${version}`,result:await captureContract(p,version)})
}
const product=createReportProbe({sources:[createProductSource()],realBase:true})
baseline.push({caseId:'product-2495-v2',result:await captureContract(product,2)})
console.log(JSON.stringify(baseline,null,2))
```

`createProductSource`来自既有`tools/capacity/fixtures.cjs`。基线JSON不含明文客户记录、真实账号、密钥或游标密文。captureContract输出包含的root是显式合成测试身份，不是线上账号。

- [x] **1.5 检查点。** 新探针测试和A工具测试通过、产品摘要全不变，才进入任务2；记录命令/数量/结果，不提交整个脏目录。

### Task 2：导出尾部只复用地址，不复用权威数据

**Files:** Modify `cloudfunctions/businessApi/lib/cloud-operations-field-repository.js`（collect与exportReportRows尾部）；Modify `tools/capacity/test/export-read-deduplication.test.cjs`。

**Interfaces:** Consumes任务1探针、现有`readSource/finalResult/reauthorize`。Produces私有`collect(actor,range,{full=false,filters=false,analysis=false,reportSourceRefs=null}={})`，原返回形状不变；`reportSourceRefs`是单请求Map，值为冻结的`{businessLineId,nodeId,feedbackId,reviewRoundId}`。公开工厂与方法签名不变。

- [x] **2.1 添加最小省读断言，先确认旧产品失败。** 对none/any/all和v1/v2分别使用stub base测试一页。事务外节点文档读取应为0，反馈为1，审核轮次按mode为0或1；反馈在两个权威事务各读1次，审核节点票集合仍扫2次。

```javascript
for(const mode of ['none','any','all']) for(const version of [1,2]) {
  test(`tail avoids outside pre-read but verifies authority: ${mode}/${version}`,async()=>{
    const p=createReportProbe({sources:reportSources(1,mode)})
    await p.repository.exportReportRows({actor:p.actor,range:p.range(version)})
    const count=(name,tx,document)=>p.trace.filter(op=>op.collection===name &&
      op.transaction===tx && (op.id!==undefined)===document).length
    assert.equal(count('business_nodes',false,true),0)
    assert.equal(count('node_feedback',false,true),1)
    assert.equal(count('node_feedback',true,true),2)
    assert.equal(count('node_review_rounds',false,true),mode==='none'?0:1)
    assert.equal(count('node_review_votes',false,false),mode==='none'?0:2)
    assert.equal(p.metrics().writeAttempts,0)
  })
}
```

Run: `node --test tools/capacity/test/export-read-deduplication.test.cjs`。Expected：省预读断言失败，不是权限或fixture失败；保存失败证据。

- [x] **2.2 实现请求内引用。** exportReportRows调用collect前创建Map并传入。collect只在full且首次finalResult成功后保存ID，不修改fresh/result/records；不缓存source整个对象，也不创建模块级Map。无需改动缓存、游标或域模块。

```javascript
// collect内部，existing fresh计算之后、analysis分支返回之前：
if(full && reportSourceRefs) {
  reportSourceRefs.set(node._id,Object.freeze({
    businessLineId:source.line._id,nodeId:source.node._id,
    feedbackId:source.feedback._id,
    reviewRoundId:source.round ? source.round._id : null
  }))
}
// exportReportRows内部：
const reportSourceRefs=new Map()
const data=await collect(actor,range,{full:true,analysis:version2,reportSourceRefs})
```

尾部删除原lineMap和节点/feedback/round事务外预读，只构造finalResult读取所需的ID载体。保留原try/catch映射范围，票集合读取不放入会吞掉未知异常的新catch。

```javascript
const ref=reportSourceRefs.get(result.nodeId)
if(!ref || ref.nodeId!==result.nodeId || ref.businessLineId!==result.businessLineId ||
   !idValid(ref.feedbackId) || ref.reviewRoundId!==null && !idValid(ref.reviewRoundId)) {
  throw fieldError('REPORT_CHANGED')
}
const votes=ref.reviewRoundId ? await scan('node_review_votes',{reviewRoundId:ref.reviewRoundId},50) : []
const source={line:{_id:ref.businessLineId},node:{_id:ref.nodeId},
  feedback:{_id:ref.feedbackId},round:ref.reviewRoundId ? {_id:ref.reviewRoundId} : null,votes}
try { await finalResult(actor,source,result,true) } catch(error) {
  if(error && error.code==='FIELD_SOURCE_INVALID') throw fieldError('REPORT_CHANGED')
  throw error
}
```

保持finalResult本体及返回前reauthorize不变；它们仍负责账号/售后/节点和全部最终内容的新鲜事务读取。若该小改无法通过现有错误/权限契约，不删除保护来过测，应停下复核设计。

- [x] **2.3 加入并发来源回归。** probe的collect/validate hook在首次已验证来源之后、尾部之前执行；分别测试首请求和先成功取第一页后的暖续页。各测试独立probe，hook只在指定阶段触发，避免首次请求被误改。

```javascript
const changes={
  feedbackValue(p,s) {
    const f=structuredClone(s.feedback)
    f.fieldValues.find(v=>v.fieldKey==='choice').value='B'
    p.replace('node_feedback',f._id,f)
  },
  feedbackIdentity(p,s) {
    const f={...s.feedback,_id:'replacement-feedback',revision:3}
    p.replace('node_feedback',f._id,f)
    p.replace('business_nodes',s.node._id,{...s.node,latestFeedbackId:f._id,latestFeedbackRevision:3})
  },
  roundIdentity(p,s) {
    const r={...s.round,_id:'replacement-round'}
    p.replace('node_review_rounds',r._id,r)
    p.replace('business_nodes',s.node._id,{...s.node,lastReviewRoundId:r._id})
  },
  voteAdded(p,s) {
    const v={...s.votes[0],_id:'extra-vote',reviewerUserId:'reviewer-2'}
    p.replace('node_review_votes',v._id,v)
  },
  voteRemoved(p,s) {p.replace('node_review_votes',s.votes[0]._id,undefined)},
  voteReplaced(p,s) {
    p.replace('node_review_votes',s.votes[0]._id,undefined)
    p.replace('node_review_votes','replacement-vote',{...s.votes[0],_id:'replacement-vote'})
  },
  voteRejected(p,s) {p.replace('node_review_votes',s.votes[0]._id,{...s.votes[0],decision:'rejected'})}
}
```

feedbackValue/feedbackIdentity覆盖none/any/all；round/vote覆盖any/all。每项断言`assert.rejects(...,{code:'REPORT_CHANGED'})`且0写入。新增51张票另断言既有`RANGE_TOO_LARGE`，不把上限放大或伪装成0票。反馈/轮次文档被删除也须在尾部拒绝。

- [x] **2.4 加入权限与读取失败测试。** collect/validate hook将root改为disabled或user，断言FORBIDDEN。另在基础hook置阶段标记后，于尾部第一个非事务users固定读的beforeRead中停用账号，验证随后售后复核事务拒绝；复用h.replaceForTest而非写入API。不能在只读适配器已经捕获事务代际之后修改overlay，却假定该事务立即看见新值。为“最终”建立阶段布尔值而非依赖总读数。注入node_feedback的固定读错误时断言原错误对象原样拒绝，不归类为成功或重试；再跑原fake DB的权限竞争套件，不能用只读适配器代替真实事务模型。

```javascript
const fault=Object.assign(new Error('SYNTHETIC_READ_FAILURE'),{code:'SYNTHETIC_READ_FAILURE'})
const p=createReportProbe({beforeRead(op){
  if(op.collection==='node_feedback') throw fault
}})
await assert.rejects(p.repository.exportReportRows({actor:p.actor,range:p.range()}),e=>e===fault)
```

- [x] **2.5 运行定向回归并记录文件检查点。** 新测试、原31项字段/分析报告测试及`operations-field-domain.test.js`、`operations-report-cursor.test.js`全部通过。确认只有本任务允许的产品文件变化，返回形状和manifest代码未改；保留测试红→绿证据。

### Task 3：完整报告不再查询无关待审核列表

**Files:** Modify `cloudfunctions/businessApi/lib/cloud-operations-repository.js`、`cloudfunctions/businessApi/test/cloud-operations-repository.test.js`。

**Interfaces:** Consumes原dataset。Produces私有`dataset(actor,range,batchNodes=false,{includePendingRounds=true}={})`；仅reportBaseSnapshot传false，公开getDashboard/exportRows/collectReportBase/validateReportBase签名及返回结构不变。

- [x] **3.1 在现有仓储测试末尾添加失败测试。** 复用本文件harness，日期范围覆盖既有合成记录；同时验证collect与validate都不读待审核列表，而旧路径仍读且计数不变。

```javascript
test('complete-report projection omits unused pending rounds without changing legacy paths',async()=>{
  const {fake,repository}=harness()
  const actor={_id:'root',role:'super_admin',status:'active'}
  const range={startAt:new Date('2026-08-01T16:00:00Z'),endAt:new Date('2026-08-18T16:00:00Z'),cursor:'',pageSize:50}
  const base=await repository.collectReportBase({actor,range})
  await repository.validateReportBase({actor,range,manifest:base.manifest})
  assert.equal(fake.queryCalls.filter(q=>q.collection==='node_review_rounds').length,0)
  assert.equal((await repository.getDashboard({actor,range})).stats.pendingReview,1)
  const legacy=await repository.exportRows({actor,range})
  assert.deepEqual(base.items,legacy.items)
  assert.equal(fake.queryCalls.filter(q=>q.collection==='node_review_rounds').length,2)
  assert.deepEqual(fake.writeCalls,[])
})
```

Run: `node --test cloudfunctions/businessApi/test/cloud-operations-repository.test.js`。Expected：旧实现待审核查询次数2而非0；其他断言不放宽。

- [x] **3.2 最小实现私有读取选项。** dataset签名增加独立选项，仅包住原rounds查询，默认true；rounds.filter及后续代码不变。reportBaseSnapshot调用`dataset(actor,range,true,{includePendingRounds:false})`，保留所有候选扫描、节点批读、显示名和头尾管理员核验。

```javascript
const rounds = includePendingRounds
  ? await readAll(() => db.collection('node_review_rounds')
      .where({status:'pending'}).orderBy('createdAt','desc').orderBy('_id','asc'))
  : []
```

- [x] **3.3 增加查询故障隔离及基础来源变化测试。** 任务1probe使用realBase=true，beforeRead仅对`node_review_rounds`集合查询（id===undefined）抛SYNTHETIC_READ_FAILURE：完整报告none/any/all成功，最终轮次固定文档读取仍出现；同probe的operationsRepository.getDashboard和exportRows拒绝该错误。另将相关轮次固定读也注入错误，完整报告必须拒绝。这验证“不查询无关列表”而非“捕获全部审核错误”。

```javascript
const p=createReportProbe({sources:reportSources(1,'any'),realBase:true,
  beforeRead(op){if(op.collection==='node_review_rounds' && op.id===undefined) throw fault}})
await p.repository.exportReportRows({actor:p.actor,range:p.range()})
await assert.rejects(p.operationsRepository.getDashboard({actor:p.actor,range:p.range()}),e=>e===fault)
await assert.rejects(p.operationsRepository.exportRows({actor:p.actor,range:p.range()}),e=>e===fault)
```

故障对象用任务2的固定合成构造在本测试内定义。基础collect成功后，改节点工时、增加/移除日期匹配的售后或节点、修改缺快照时的人员显示名，分别调用validateReportBase断言REPORT_CHANGED。验证源中变更不可被只读查询缓存掩盖。

- [x] **3.4 回归并记录检查点。** 原仓储测试、新探针及既有报告测试全通过；diff仅本批两产品文件。getDashboard统计、旧CSV基础行及先前业务功能不改。

### Task 4：契约、测量、完整回归与最终统一复核

**Files:** Modify新探针测试、必要的 `tools/capacity/test/scenarios.test.cjs`；Create `docs/deployment/export-read-deduplication-acceptance.md`；Update本计划及STATUS。

**Interfaces:** Consumes任务1冻结基线、任务2/3实现、现有容量CLI及全部回归套件。Produces准确前后对照与本地兼容结论，不产出线上容量承诺或发布动作。

- [x] **4.1 用冻结基线核对完整内容和旧游标。** 对7个合成case重新captureContract，rowsDigest、rowCount和firstCursorBody全部相等；对同源多页逐页断言原顺序，不用集合排序掩盖改序。以冻结firstCursorBody经原codec.encode签发测试游标，交给新冷实例续页；与新实现第二页items/hasMore一致，20分钟到期仍REPORT_EXPIRED，换账号或查询仍VALIDATION_ERROR。

```javascript
assert.equal(after.rowsDigest,before.rowsDigest)
assert.equal(after.rowCount,before.rowCount)
assert.deepEqual(after.firstCursorBody,before.firstCursorBody)
const oldCursor=p.codec.encode(before.firstCursorBody)
const continued=await p.freshRepository().exportReportRows({actor:p.actor,
  range:{...p.range(version),cursor:oldCursor}})
assert.ok(continued.items.length>0)
```

再用同一repository生成4个不同endDate（9月20至23日）的有效筛选报告触发3份缓存淘汰，核对第一份仍可冷重建续页。现有测试未直接覆盖完整报告12MiB/50000行预算，补充如下测试，不改常量；无结果用sources为空且realBase=true，断言items空、hasMore false且无游标。

```javascript
for(const baseRows of [Array.from({length:50001},()=>({})),[{payload:'x'.repeat(13*1024*1024)}]]) {
  const oversized=createReportProbe({baseRows})
  await assert.rejects(oversized.repository.exportReportRows({actor:oversized.actor,
    range:oversized.range()}),{code:'RANGE_TOO_LARGE'})
  assert.equal(oversized.metrics().writeAttempts,0)
}
const sources=reportSources()
const fieldCount=domain.fieldExportRows(sources.map(domain.buildFinalFieldResult)).length
const atLimit=createReportProbe({sources,baseRows:Array.from({length:50000-fieldCount},()=>({}))})
const allowed=await atLimit.repository.exportReportRows({actor:atLimit.actor,range:atLimit.range(1,50)})
assert.equal(allowed.items.length,50)
assert.equal(allowed.hasMore,true)
```

上述大字符串只存在测试进程内，逐项构造/运行/释放，不写文件或输出；若测量进程预算不足，单独记录未完成，不增大产品上限。非法/损坏来源继续拒绝或按原统计incomplete返回。

- [x] **4.2 核对非导出和特殊内容。** 运行现有`cloud-operations-field-analysis.test.js`中未匹配候选/新候选测试，以及`operations-field-analysis-report.test.js`的全部字段类型、关联筛选、0/false/空值、同名条件、隐藏属性测试。为新probe补充跨月份创建但窗口内完成的来源、窗口内创建但窗口外完成的来源，断言基础行与字段行分别使用原日期口径。保留A `assertFieldViews`内容校验，另用冻结摘要保证顺序没有回退。

非导出getSummary/getFilters/getAnalysis在同一合成样本前后输出及读轨迹保持；refreshAfterMutation运行现有fake写快照测试而非只读probe。不得把这些方法改为共享导出引用。

- [x] **4.3 以相同预算比较读取量。** 无审核每节点至少少2次事务外预读，有审核至少少3次，另外基础报告减少待审核查询；首/暖/冷续页的事务数量、每事务操作数、权限与票集合检查不因优化减少。任务1的7项基线逐项保存前后指标；另对1/10/150个节点分别测三种审核模式的首/暖/冷页，150样本只测这些页，不将全报告乘所有模式。

```javascript
const minimumSaving=mode==='none'?2:3
for(const key of ['firstPageReads','warmPageReads','coldPageReads']) {
  assert.ok(before[key]-after[key]>=minimumSaving)
}
assert.equal(p.metrics().writeAttempts,0)
assert.ok(p.metrics().maxTransactionOperations<=100)
for(const key of ['firstPageTransactions','warmPageTransactions','coldPageTransactions','maxTransactionOperations']) {
  assert.equal(after[key],before[key])
}
```

上述断言针对冻结基线的单节点样本；多节点结构节省按节点数计算并单独记录，不假定所有模式与150节点A fixture完全相同。真实云端耗时/费用仍unverified。

```powershell
node tools/capacity/run.cjs --profile smoke --scenario report-v1
node tools/capacity/run.cjs --profile smoke --scenario report-v2
node tools/capacity/run.cjs --profile smoke
```

保持30秒/20000读/256MiB默认预算。报告仍中止应明确保留test_aborted/complete=false，不作完成承诺。A测试当前用3000读预算断言仅一页，省读后可能已完成两页：若确实失败，仅将该测试预算改为固定2000并再次验证仍完成一页、第二页中止，保留firstPageReads/lastPageReads和累计读的区别。这是测试预算调整，不能更改CLI默认预算或混用前后测量。

- [x] **4.4 写验收记录，运行完整新鲜回归。** 记录每条命令实际退出码、数量、失败、跳过和文件增量；逐项检查登录/切账号、模板/联动、上传/登记/预览、审批及历史、前序记录、卡片、检索、统计和CSV。不能只写“未改前端文件所以无影响”。

```powershell
node --test tools/capacity/test/*.test.cjs
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/operationsAnalytics
node --test miniprogram/test/*.test.js
node tools/test-business-card-rendering.mjs
node tools/test-previous-node-records-rendering.mjs
node tools/test-operations-field-analysis-rendering.mjs
node tools/test-wxml-structure.mjs
git -c core.safecrlf=false diff --check
python "C:/Users/87579/.codex/skills/maintaining-project-memory/scripts/validate_memory.py" .
```

三个官方渲染脚本依赖本机已安装编译器`WECHAT_WCC_PATH`，先检查该变量对应文件存在；若未设，按已安装微信开发者工具目录只读定位官方wcc.exe，再设置本次进程变量，不安装依赖或修改项目配置。找不到则该项unverified，不能跳过后标为通过。各命令独立检查退出码，不能靠最后一个命令成功覆盖前面的失败。

- [x] **4.5 核对文件和提交边界。** 任务1摘要同时包含cloudfunctions下的测试文件，必须区别运行时代码与测试：仅两个指定运行时模块及 `cloudfunctions/businessApi/test/cloud-operations-repository.test.js` 允许变化；tools中新测试/探针/合成基线另列清单。无新增/删除运行时产品文件；所有小程序代码、配置、依赖、worker及其他云模块摘要相同。既存用户并发改动单独辨认并保留，不强制恢复起点。审查新工具无产品反向依赖、无线上访问及原始数据日志；暂存区保持原样。

- [x] **4.6 一次最终独立复核。** 复核本批相对文件检查点的增量和规格，重点看固定ID是否仅为地址、首尾核验是否保留、新票是否可发现、manifest/游标是否被污染、默认dataset路径是否改变、对照基线是否在改产品前生成。发现问题先补失败测试再修正，同批重跑对应及完整回归；如涉及新增行为影响先征求用户批准。不得用全脏目录差异冒充本批范围。

- [x] **4.7 更新记忆并交付。** STATUS写明真实省读量、未解决的容量上限、测试证据和五端/云端未验证范围；验收表按“本地通过/已知限制/unverified”分别记录。重跑validator与diff check。交付中只可称“本地自动回归未发现功能回退”，不能保证未测设备完全无影响。发布或上传仍待准确载荷与授权确认；不自动Git提交/推送。

## 自查与实施状态

- 规格1/4/6映射全局约束、任务4和发布门槛；规格2/3.1/3.3映射任务1/2；规格3.2映射任务3；规格5映射全部测试与验收。
- 五个Review Focus分别有任务和具体故障/数据断言。所有工具名称与接口在任务1定义；沿用现有私有仓储职责，不暴露新API。
- 用户已批准本计划，4项任务及21步完成；勾选步骤有账本/验收证据。一次最终独立复核通过，无修正或遗留项；未发布或提交Git，保留原目录检查点。验收详见 `docs/deployment/export-read-deduplication-acceptance.md`。
