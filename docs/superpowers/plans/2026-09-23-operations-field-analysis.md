# Operations Field Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user selected native continuous implementation followed by one independent whole-change review. Steps use checkbox (`- [ ]`) syntax for tracking. Do not substitute per-task subagent implementation or a new worktree for the user's selected workflow.

**Goal:** 在运营看板只展示有记录的选项，支持商品逐层分析、同节点双字段共现，以及同源完整 CSV；验证后发布 businessApi、上传新版小程序。

**Architecture:** 保留最终字段快照和现有工时统计协议，以同一授权数据读取链路生成仅在请求内存在的字段关系描述。独立纯分析模块同时供新查询和新版报告使用；小程序使用独立组件管理展示和请求代际，页面继续管理原统计筛选与生成/发送 CSV。

**Tech Stack:** CommonJS JavaScript、Node.js 内置测试、微信原生 Component/WXML/WXSS、现有 wx-server-sdk、CloudBase 云数据库；不增加依赖。

**Spec:** `docs/superpowers/specs/2026-09-23-operations-field-analysis-design.md`，用户已于 2026-09-23 确认规格和本实施计划并要求执行。下方步骤保留原计划文本，实际执行证据及部署状态以 `docs/memory/STATUS.md` 和当前执行台账为准。

## Global Constraints

- 不包含跨节点拼接、销量或故障率计算、提醒功能、模板目录修改、业务数据重写、权限扩大、新集合或定时任务。原运营工时图表和基础 CSV 的日期口径保持不变。
- 同一节点去重一次；草稿、旧驳回修订、跳过节点不计入。日期按上海节点完成日期解释。
- 隐藏或不适用的字段不进入其填写分母；可见而未填写的字段另计，不把来源损坏或读取失败算成未填写。
- 保持 `operations_field_snapshots` 的 schemaVersion、字段结构及 sourceDigest 语义不变。查询时生成关联描述，不新增持久化关联缓存，不要求发布 operationsAnalytics。
- 最多 2000 个字段节点，沿用既有售后与原始扫描边界；关联条件最多八个，双字段维度恰好两个。累计组合贡献上限 50000，超限明确报范围过大；不先生成无界笛卡尔积再截断。
- 分页返回最多 50 个分析条目，采用绑定账号、规范化筛选、维度、来源摘要与顺序的防篡改短期游标；切换条件不能继续旧分页。展示前十项使用同一排序序列，不影响总量。
- 延续公式保护、原文 JSON、全页校验后生成、50000 行/12MiB 硬边界和 20 分钟游标有效期。
- Android、iOS、HarmonyOS、Mac、Windows 共用原生小程序组件，不新增浏览器专属依赖。窄屏采用单列组合卡片，长标签换行，操作入口不能被挤出。
- 不创建生产测试售后或发送通知来验收。未完成真实设备验收的项目写为 unverified；登录、扫码、体验版选择等需要人工时再请求对应操作。
- 使用当前目录并保留所有既存脏文件；授权发布和上传不等于授权提交正式审核、正式发布或推送 GitHub。

## Review Focus

1. RF1：日期扩大后新增样本、分页期间从不匹配变成匹配的记录，必须使旧来源游标失效；不能只绑定旧匹配子集。由任务 2、3 的来源清单竞态测试固定。
2. RF2：同名型号不同品牌、属性中间空列、同名字段但不同语义版本，必须按稳定身份和完整联动语义隔离。由任务 1 的目录与分母用例固定。
3. RF3：取消请求后迟到的同会话 FORBIDDEN/ACCOUNT_DISABLED 仍须清除旧敏感内容；另一账号的迟到拒绝不得清除新账号。由任务 4 的会话代际测试固定。
4. RF4：原生发送文件面板会触发页面隐藏；不能因组件生命周期重置导出条件使合法发送回调失效，也不能让真正换账号/换筛选继续发送旧文件。由任务 5 的发送生命周期测试固定。
5. RF5：云端运行着旧 operationsAnalytics，新 businessApi 读取其快照；业务更新与计时补算不能改变统计协议。由任务 1、2、6 的旧形状快照、原摘要及 bundle 回归固定。

## 预检证据与实施约定

- 计划基线是当前工作区，不是干净的 HEAD。已存在上传、卡片、前序节点等修改，`index.js`、`services/business.js` 等重叠文件尤其不能整文件回滚或覆盖。
- 2026-09-23 已只读运行以下基线：113 tests / 113 pass / 0 fail / 0 skip。该结果不代表新功能通过。

```powershell
node --test cloudfunctions/businessApi/test/operations-field-domain.test.js cloudfunctions/businessApi/test/operations-field-service.test.js cloudfunctions/businessApi/test/cloud-operations-field-repository.test.js cloudfunctions/businessApi/test/operations-report-cursor.test.js miniprogram/test/operations-field-flow.test.js
```

- 每个任务按“新增失败测试 → 观察指定失败 → 最小实现 → 目标回归”执行，最终统一独立复核。不在中途替用户重开设计范围。
- 实施开始时用 `New-Item` 创建名称独立的系统临时目录，保存本轮涉及文件的前置副本和 SHA256 清单用于增量复核，不复制凭据、业务记录或附件。只通过 `apply_patch` 修改产品及文档文件；同步既有镜像脚本属于机械改写。
- 每任务结束检查显式文件差异。已有脏文件不得通过 `git add .` 或整文件提交混入旧改动；用户未要求 GitHub 推送，本计划没有推送步骤。最终保留可审阅增量与发布清单。

## 文件职责与固定接口

### 后端职责

- `lib/operations-field-domain.js`：只增加 `describeFieldAnalysisSource(source, result)` 导出，复用文件内已存在的严格复制、定义校验、`compatibilityFor` 和摘要实现；不改变旧输出。同步到 `operationsAnalytics/lib` 以通过既有 bundle 检查，但线上旧 worker 不调用新 helper，无需发布 worker。
- 新建 `lib/operations-field-analysis.js`：纯聚合，消费 `{ result, schema }[]`，不访问数据库，不执行网络或写入，不修改输入。
- 新建 `lib/operations-field-query.js`：从现有 service 原样提取 `normalizeFieldQuery`、`fieldError`，service 保持同名 re-export，避免新查询模块反向依赖 service 形成循环。
- 新建 `lib/operations-field-analysis-query.js`：独立查询和报告 v2 白名单、嵌套参数规范化，避免把 `analysis` 传进旧 `normalizeAnalyticsQuery`。
- 新建 `lib/operations-field-analysis-cursor.js`：新用途 AES-GCM 分析游标；旧报告 codec 保持原协议。
- 现有 `lib/cloud-operations-field-repository.js`：在既有授权/来源读取链路上按需携带已核实的关系描述，并组装新查询和报告。新纯逻辑不放在仓储内。
- 现有 `lib/operations-field-service.js`、`index.js`：接入一个新受保护 action 和显式 v2 报告，旧两条读取 action 的白名单不放宽。

### 客户端职责

- 新建 `utils/operations-field-analysis.js`：严格允许列表投影、选项/组合展示格式、分析状态 reducer；不得实现服务端组合计数。
- 新建 `components/operations-field-analysis/index.{js,json,wxml,wxss}`：节点折叠、商品路径、字段对、分页和请求隔离。
- 现有 `pages/admin-operations/index.{js,json,wxml,wxss}`：替换旧字段图表区域，提供已提交统计条件、生命周期令牌及导出分析条件；不把字段条件传给工时接口。
- 现有 `utils/operations-field-report.js`：v2 关联记录验证与追加列。现有 `services/business.js`：添加新 action 的薄封装，保留所有既有服务。

### 请求、响应和内部类型

以下为实施时使用的确定名称，不是新增数据库 schema。全部标识摘要使用 64 位小写十六进制。

```js
// normalizeAnalysisQuery(input, now) -> { ...legacyRange, analysis }
// legacyRange 仍含原日期/模板/节点/参与人/分页字段。
const analysis = {
  view: 'catalog', // catalog | node | field | product | combinations | pair
  nodeGroupId: '', // catalog 外必需；绑定模板 + 稳定节点
  linkageId: '',   // product/combinations 必需
  dimensionIds: [], // field 恰好 1；pair 恰好 2；其他为空
  filters: [] // 最多 8 个 { dimensionId, value }，值精确匹配
}
// 新版报告：{ ...legacyQuery, reportVersion: 2, analysis }
// 未传 reportVersion 时走旧协议；传非 2 或只有 analysis 均拒绝。

// describeFieldAnalysisSource(source, result) -> AnalysisSchema
// result 必须是已验证最终结果或服务器可信选择快照，header 仅为失效键。
// schema 不携带字典、矩阵、非选择字段或身份值。
// AnalysisSchema = {
//   nodeId, sourceHeader, sourceDigest, nodeGroupId,
//   dimensions: [{ id, fieldGroupId, fieldKey, name, type, sequence, applicable }],
//   linkages: [{ id, dimensionIds }]
// }

// buildFieldAnalysis(records, analysis) -> AnalysisResult（仅服务端内部）
// AnalysisResult = {
//   view, matchedNodeIds, items, sampleCount, filledSampleCount,
//   emptySampleCount, notApplicableSampleCount, dimensionMetadata,
//   linkages, productStage, context
// }
// matchedNodeIds 不可进入 API 响应；它供同源 CSV 选取完整字段结果。
// catalog items: 节点组安全名称/版本、sampleCount、正计数 fieldCount。
// node items: 字段安全元数据、正计数前十项、totalOptionCount、填写/空白数。
// field items: { values: [label], count }。
// product: next 段为下一层正计数选项；三层已选后为适用属性前十项卡片。
// combinations/pair items: { values: [label1, label2], count }；组合维度顺序固定。
// 属性组合 values 只对应当前型号的适用属性，但每项保留稳定维度 id。
// linkages: 当前节点组有样本的 [{ id, dimensionIds, templateVersions }]，
//          仅返回安全引用，客户端据此选择 linkageId，不下发目录矩阵。
// productStage: next | attributes | none；非 product 视图固定 none。

// projectFieldAnalysisPage(result, {scope, incomplete, pageSize, cursorBinding})
// -> { schemaVersion:1, view, scope, incomplete, items, totalCount,
//      sampleCount, filledSampleCount, emptySampleCount,
//      notApplicableSampleCount, dimensionMetadata, linkages, productStage, context,
//      hasMore, nextCursor }
// items 每页 <= 50；node 的每个字段 bundle 内预览最多十项。
// context 仅含确认过的分析条件；无 sourceDigest/nodeId/raw schema。
```

新增请求对象按 own data properties 检查，拒绝 getter、符号、原型污染、重复维度/条件和未知键；整体 analysis 序列化不超过 64KiB。值保留精确原文，不通过 trim 改变选项身份。单页安全投影不超过 512KiB，超限使用 `RANGE_TOO_LARGE`，不静默删项。

维度 `fieldGroupId` 复用原兼容摘要；新 `id` 在此基础上纳入条件父链的语义摘要，防止祖先含义变化时错误合并。严格联动沿用 `optionLinkageSemanticProjection` 的等价行/字典重排规则。节点组不按名称或模板版本号硬拆；同一组内不兼容字段有不同维度 id，不能跨版本凑字段对。

---

### Task 1: 可信关系描述与纯关联统计

**Files:**
- Modify: `cloudfunctions/businessApi/lib/operations-field-domain.js`，仅新增辅助导出。
- Sync: `cloudfunctions/operationsAnalytics/lib/operations-field-domain.js`。
- Create: `cloudfunctions/businessApi/lib/operations-field-analysis.js`。
- Create: `cloudfunctions/businessApi/test/operations-field-analysis.test.js`。
- Create: `cloudfunctions/businessApi/test/helpers/field-analysis-fixtures.js`。
- Modify: `cloudfunctions/operationsAnalytics/test/field-domain-bundle.test.js`，新增兼容断言。

**Interfaces:** 消费原 `buildFinalFieldResult`、`selectionSnapshot`、`fieldSource`；产出 `describeFieldAnalysisSource`、`buildFieldAnalysis`、`fieldAnalysisExportRows`。导出函数在任务 3 填入报告行映射，纯计数先在本任务固定。

- [ ] **1. 建立合成 records 并写失败测试。** 新 helper 定义如下，后续任务统一使用，不能引入真实商品目录。

```js
const domain = require('../../lib/operations-field-domain')
const { fieldSource } = require('./field-fixtures')
function analysisRecords() {
  return [
    ['A', ['X', 'Y']], ['A', ['Y']], ['B', []]
  ].map(([choice, tags], index) => {
    const source = fieldSource({ nodeId: `analysis-node-${index}`,
      values: [{ fieldKey: 'choice', value: choice }, { fieldKey: 'tags', value: tags }] })
    const result = domain.buildFinalFieldResult(source)
    return { source, result, schema: domain.describeFieldAnalysisSource(source, result) }
  })
}
module.exports = { analysisRecords }
```

```js
test('pair counts actual co-occurrence, not the product of marginal totals', () => {
  const records = analysisRecords()
  const dimensions = records[0].schema.dimensions
  const input = { view: 'pair', nodeGroupId: records[0].schema.nodeGroupId,
    linkageId: '', dimensionIds: ['choice','tags'].map(key =>
      dimensions.find(item => item.fieldKey === key).id), filters: [] }
  const output = buildFieldAnalysis(records, input)
  assert.deepEqual(output.items, [
    { values: ['A','Y'], count: 2 }, { values: ['A','X'], count: 1 }
  ])
  assert.equal(output.filledSampleCount, 2)
  assert.equal(output.emptySampleCount, 1)
  assert.equal(output.notApplicableSampleCount, 0)
})
```

同文件明确新增以下断言：正计数才出现；空组不在目录；重复相同 nodeId 只计一次、冲突副本拒绝；多选重复值拒绝而非增加次数；字段名相同但模板/节点不同隔离；兼容版本合并；类型/条件祖先/联动规则变化拆分；只返回单选多选。

- [ ] **2. 跑 RED 并核对失败原因。**

```powershell
node --test cloudfunctions/businessApi/test/operations-field-analysis.test.js
```

期望新 helper/聚合函数缺失导致明确失败；语法或测试装载错误先修正，不能当作行为 RED。

- [ ] **3. 增加描述 helper 和实际计数循环。** helper 在 `operations-field-domain.js` 内复用 `sourceHead`、`definitionsFor`、`headerFor`、`compatibilityFor` 和 `digest`，以 `selectionSnapshot(result)` 校验结果。比较业务/节点身份及 sourceHeader，输出全体选择字段（包括不可见者的 applicable=false），但不输出其字典。严格联动组按已有语义投影求摘要；旧结果字段与对应描述逐个比对 fieldGroupId。

纯聚合先验证 records 的 result/schema 身份和摘要一致，去重节点；按现有确定顺序选择同兼容组显示名。每个条件必须对应当前已核实节点组的维度；对节点值作精确 contains/equals 匹配。字段对只在同一节点同时声明两个兼容维度的样本中计算：优先归类不适用，其次未填写，其余为填写，三个数量互斥。

```js
// 内部 accumulatePair(map, left, right, budget)：输入已校验、已去重的选中值数组。
function accumulatePair(map, left, right, budget) {
  const contribution = left.length * right.length
  if (!Number.isSafeInteger(contribution) || budget.used + contribution > 50000) {
    const error = new Error('RANGE_TOO_LARGE'); error.code = 'RANGE_TOO_LARGE'; throw error
  }
  budget.used += contribution
  for (const a of left) for (const b of right) {
    const key = JSON.stringify([a,b])
    const previous = map.get(key)
    map.set(key, { values: [a,b], count: (previous ? previous.count : 0) + 1 })
  }
}
function compareItems(a,b) {
  const left = JSON.stringify(a.values), right = JSON.stringify(b.values)
  return b.count - a.count || (left < right ? -1 : left > right ? 1 : 0)
}
```

商品分析只使用同一 linkageId 的实际记录，前三层选项来自匹配结果；选完型号后读取适用属性集合，存在中间空列时按 dimension id 保留身份。无适用属性显示明确空态，不输出一个虚构的“空组合”。完整属性组合取该节点的实际值元组，单次计数，不调用多选笛卡尔积。

- [ ] **4. 用明确合成目录固定 RF2 与边界。** 两个分类“椅类/桌类”、两个品牌“品牌甲/品牌乙”、同名型号“型号一”；合法行分别为椅类/甲/一/黑/null/带头枕和桌类/乙/一/白/null/null。验证选择椅类不出现乙；黑和头枕列不会跨越空列；两个节点黑/带头枕只产生一个组合 count=2。重排字典并同步行编码后的结果兼容，改变真实行后不同组。加入两多选字段各 225 个实际值，首次累计贡献 50625 应在枚举前拒绝；50000 边界成功。

- [ ] **5. 同步镜像并跑 GREEN/旧协议回归。**

```powershell
node tools/sync-operations-field-domain.mjs
node tools/sync-operations-field-domain.mjs --check
node --test cloudfunctions/businessApi/test/operations-field-analysis.test.js cloudfunctions/businessApi/test/operations-field-domain.test.js cloudfunctions/operationsAnalytics/test/field-domain-bundle.test.js cloudfunctions/operationsAnalytics/test/field-snapshot-recovery.test.js
```

RF5：用新增 helper 前原测试 fixture 的结果逐属性验证 schemaVersion、sourceHeader/sourceDigest、selectionSnapshot 仍完全相同；旧 worker 形状不需要新属性。四个 bundle 文件除新增 helper 所在文件外必须未改。

### Task 2: 新受保护查询、来源绑定与分页

**Files:**
- Create: `cloudfunctions/businessApi/lib/operations-field-query.js`。
- Create: `cloudfunctions/businessApi/lib/operations-field-analysis-query.js`。
- Create: `cloudfunctions/businessApi/lib/operations-field-analysis-cursor.js`。
- Modify: `cloudfunctions/businessApi/lib/cloud-operations-field-repository.js`、`lib/operations-field-service.js`、`index.js`。
- Create: `cloudfunctions/businessApi/test/operations-field-analysis-query.test.js`、`operations-field-analysis-cursor.test.js`、`cloud-operations-field-analysis.test.js`。
- Modify: `cloudfunctions/businessApi/test/operations-field-service.test.js`、`account-routes.test.js`。

**Interfaces:** `normalizeAnalysisQuery(input, now)`、`normalizeFieldReportQuery(input, now)`；仓储 `getAnalysis({actor,range})`；服务 `getAnalysis`；action `getOperationsFieldAnalysis`。分页 codec `createOperationsFieldAnalysisCursor({secret,clock})` 的 encode/decode body 仍为 `{actorId,queryDigest,reportDigest,offset,expiresAt}`，但用途为 `operations-field-analysis-v1`、前缀 `ofa1.`，与旧报告互不通用。

- [ ] **1. 写边界及真实入口 RED。**

```js
test('analysis query rejects duplicate filters before any repository call', () => {
  const dimensionId = 'a'.repeat(64)
  assert.throws(() => normalizeAnalysisQuery({ analysis: {
    view:'pair',nodeGroupId:'b'.repeat(64),linkageId:'',
    dimensionIds:[dimensionId,'c'.repeat(64)],
    filters:[{dimensionId,value:'A'},{dimensionId,value:'A'}]
  } }, new Date('2026-09-23T00:00:00Z')), { code:'VALIDATION_ERROR' })
})
```

新增普通账号仅聚合有权售后、显式无权售后拒绝、停用和角色变化拒绝；真实 `createRouteHarness` 把合法分析参数传到新服务、未知键/客户端身份字段拒绝，旧路由仍拒绝 analysis。codec 测试相同 token 在报告/分析之间互用、跨账号/筛选/维度、篡改、到期都失败。

- [ ] **2. 运行 RED。**

```powershell
node --test cloudfunctions/businessApi/test/operations-field-analysis-query.test.js cloudfunctions/businessApi/test/operations-field-analysis-cursor.test.js cloudfunctions/businessApi/test/cloud-operations-field-analysis.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

- [ ] **3. 实现独立白名单和安全读取。** 先把现有 normalizeFieldQuery、fieldError 原样移入 operations-field-query.js，service 从该文件导入并保持原 module.exports 键，旧消费者不改调用路径；analysis-query 直接依赖这个叶子模块，不反向导入 service。规范化器先检查顶层 own descriptors，把 analysis/reportVersion 从输入分离，剩余部分交给原 normalizeFieldQuery；旧 normalizeFieldQuery 不新增键。由 normalized analysis 决定维度数和允许字段，catalog 不允许偷带节点/筛选，product/combinations 必须是真实联动合法前缀。未知目录 id 返回稳定校验错误，不泄露任何目录外信息。

```js
// createOperationsFieldRoutes 内分开白名单，不放宽旧读取 action。
const legacyKeys = new Set(['startDate','endDate','grain','templateId','templateVersion',
  'status','businessLineId','stableNodeId','processorToken','reviewerToken','cursor','pageSize'])
const analysisKeys = new Set([...legacyKeys,'analysis'])
const reportKeys = new Set([...legacyKeys,'analysis','reportVersion'])
// 服务中 getSummary/getFilters 使用 normalizeFieldQuery；getAnalysis 使用
// normalizeAnalysisQuery；exportReportRows 使用 normalizeFieldReportQuery。
```

给现有 collect 增加仅内部 `analysis` 标记，旧调用默认 false。缓存命中路径的同一固定文档事务使用 freshLine/freshNode 生成 schema；回源路径在 finalResult 的来源复核事务中生成 schema。返回 `{result,schema}`，不可对事务前候选 node 直接贴 metadata。只读分析不得写快照或其他集合。

全授权结果清单（含未匹配关联条件的记录）绑定身份、sourceHeader/sourceDigest、关系摘要、标签和 incomplete 状态；聚合后复核当前账号/角色、售后关系和对应节点 header。先验证完整清单再发页，新增/移除候选或条件变化产生 `REPORT_CHANGED`。分页排序稳定；不通过每页缓存绕过授权。

新 codec 独立文件使用现有 report codec 的 AES-256-GCM 结构，但固定新用途/前缀；不创建通用加密框架，不改变旧 codec。无合格服务器密钥返回配置错误，不用常量或账号派生代替。`projectFieldAnalysisPage` 只允许固定响应键，最多 50 条、512KiB；cursor body 不含选项原文。

- [ ] **4. 加入 RF1/RF5 的仓储竞态测试。** 复用 fake DB 的 `transformRead`、`beforeNextTransaction` 和 `replace`：预读之后替换 fieldDefinitions → 不返回旧 schema；分页之间新增匹配节点或改变原不匹配节点值 → `REPORT_CHANGED`；缓存命中仍不用读取文本字段，但必须复核 freshNode 定义；旧 worker 快照无需新属性即可命中新分析。对 getAnalysis 断言 `fake.writeCalls.length === 0`，并检查序列化响应不含原文长说明、矩阵、账号 id、sourceHeader/sourceDigest。

- [ ] **5. 运行 GREEN 和旧查询回归。**

```powershell
node --test cloudfunctions/businessApi/test/operations-field-analysis-query.test.js cloudfunctions/businessApi/test/operations-field-analysis-cursor.test.js cloudfunctions/businessApi/test/cloud-operations-field-analysis.test.js cloudfunctions/businessApi/test/operations-field-service.test.js cloudfunctions/businessApi/test/account-routes.test.js cloudfunctions/businessApi/test/cloud-operations-field-repository.test.js cloudfunctions/businessApi/test/operations-report-cursor.test.js
```

### Task 3: 同源报告 v2 与旧客户端兼容

**Files:**
- Modify: `cloudfunctions/businessApi/lib/operations-field-analysis.js`、`operations-field-analysis-query.js`、`cloud-operations-field-repository.js`。
- Create: `cloudfunctions/businessApi/test/operations-field-analysis-report.test.js`。
- Modify: `cloudfunctions/businessApi/test/cloud-operations-field-repository.test.js`。

**Interfaces:** `fieldAnalysisExportRows(records, analysis)` 返回 `{matchedNodeIds, rows, context}`；v2 报告继续使用 `exportOperationsReportRows`，参数增加 `reportVersion:2` 和 analysis。未指定版本只调用原 domain.fieldExportRows，不出现新类型。

- [ ] **1. 写报告兼容和一致性 RED。**

```js
test('v2 associations match analysis while legacy rows retain their shape', () => {
  const records = analysisRecords()
  const dims = records[0].schema.dimensions
  const selection = {view:'pair',nodeGroupId:records[0].schema.nodeGroupId,linkageId:'',
    dimensionIds:['choice','tags'].map(key=>dims.find(d=>d.fieldKey===key).id),filters:[]}
  const report = fieldAnalysisExportRows(records, selection)
  const stats = report.rows.filter(row=>row.recordType==='关联统计')
  assert.deepEqual(stats.map(row=>[JSON.parse(row.dimensionValuesJson),row.occurrenceCount]),
    [[['A','Y'],2],[['A','X'],1]])
  assert.ok(stats.every(row=>row.filledSampleCount===2 && row.emptySampleCount===1))
  assert.ok(domain.fieldExportRows(records.map(r=>r.result))
    .every(row=>row.recordType!=='关联统计'))
})
```

- [ ] **2. 运行 RED。**

```powershell
node --test cloudfunctions/businessApi/test/operations-field-analysis-report.test.js
```

- [ ] **3. 实现报告映射及查询隔离。** v2 全部回读最终权威结果并在同一来源复核中携带 schema。对匹配节点使用原 `domain.fieldExportRows` 生成全类型明细和选项统计，仅过滤 count=0 的统计行，不过滤空值明细；追加纯分析模块的关联行。无需兼容键复制或重新解析页面条形图。

```js
// 关联行固定新增结构；dimensionMetadata 来自服务端已核实维度。
const row = {
  recordType:'关联统计',dateBasis:'节点完成日期',
  templateName,templateVersions,nodeName,
  analysisGroupId,
  dimensionIdsJson:JSON.stringify(dimensionMetadata.map(d=>d.id)),
  dimensionNamesJson:JSON.stringify(dimensionMetadata.map(d=>d.name)),
  dimensionValuesJson:JSON.stringify(item.values),
  occurrenceCount:item.count,filledSampleCount,emptySampleCount,
  notApplicableSampleCount,analysisContextJson:JSON.stringify(context),
  dataStatus:'有效'
}
```

这里各局部变量来自 `buildFieldAnalysis` 的元数据及计数；`analysisGroupId` 由模板/节点/维度语义和规范化条件求摘要，所有空分析时仍有文件口径说明。catalog/node/field/product 的普通分布沿用“选项统计”；只有 combinations/pair 新增“关联统计”，不得为每对字段自动造行。

给 v2 字段行追加 analysisContextJson；基础行标明其原日期口径及关联条件不适用。传给 `operationsRepository.collectReportBase/validateReportBase` 的 range 显式去除 analysis/reportVersion，避免污染工时或基础导出。报告 queryDigest 和 sourceManifest 纳入版本、分析参数、全部已核实来源与关系摘要，缓存 key 同步隔离；完整来源复核仍针对全部候选，不只匹配结果。

- [ ] **4. 测试完整性而非仅行存在。** 从 v2 明细重新计算所有正计数与组合，逐项等于报告；选择 A 后明细只来自 A 的节点，长文本、0、false 仍保留；旧基础行和全部旧列不变；十一项以上和多页报告不丢剩余项；空白/逗号/引号/CRLF/公式样式标签以 JSON 原文无损。未填写和不适用分开，不完整来源拒绝全部报告。RF1：续页间改变原未匹配记录使其匹配，或修改关系但维持显示名称，必须拒绝；改 reportVersion 或分析条件也不能使用旧游标。

- [ ] **5. 运行 GREEN。**

```powershell
node --test cloudfunctions/businessApi/test/operations-field-analysis-report.test.js cloudfunctions/businessApi/test/cloud-operations-field-analysis.test.js cloudfunctions/businessApi/test/cloud-operations-field-repository.test.js cloudfunctions/businessApi/test/operations-report-cursor.test.js
```

### Task 4: 独立字段分析组件与请求隔离

**Files:**
- Create: `miniprogram/utils/operations-field-analysis.js`。
- Create: `miniprogram/components/operations-field-analysis/index.js`、`index.json`、`index.wxml`、`index.wxss`。
- Modify: `miniprogram/services/business.js`，仅添加新 service。
- Create: `miniprogram/test/operations-field-analysis.test.js`、`operations-field-analysis-component.test.js`。

**Interfaces:** 工具 `formatAnalysisPage(response)`、`reduceAnalysisSelection(selection, event)`；组件 properties 为 `{enabled:Boolean, query:Object, sessionEpoch:Number}`，触发 `analysischange`（detail.selection）、`accessinvalid`，methods 为 `resetAnalysis`、`toggleNode`、`loadMoreNodes`、`showAllOptions`、`selectProductValue`、`backProduct`、`resetProduct`、`selectPairDimension`、`loadMoreAnalysis`、`retryAnalysis`。服务方法 `getOperationsFieldAnalysis(query)`。

- [ ] **1. 先写状态和投影 RED。**

```js
test('changing an upstream product value removes only downstream selection', () => {
  const prior = {view:'product',nodeGroupId:'n',linkageId:'l',dimensionIds:[],
    filters:[{dimensionId:'category',value:'椅类'},
      {dimensionId:'brand',value:'品牌甲'},{dimensionId:'model',value:'型号一'}]}
  const next = reduceAnalysisSelection(prior,
    {type:'productValue',index:0,dimensionId:'category',value:'桌类'})
  assert.deepEqual(next.filters,[{dimensionId:'category',value:'桌类'}])
  assert.equal(prior.filters.length,3)
})
```

状态 reducer 操作的是已验证响应产生的 UI 选择，不能把这里的短合成 id 当成 API 允许非摘要 id。formatAnalysisPage 必须拒绝不认识的 view、非整数/负数计数、count 大于填写样本、空/重复组合、错误分母或未绑定维度；只能把允许列投影到 setData。

- [ ] **2. 跑 RED。**

```powershell
node --test miniprogram/test/operations-field-analysis.test.js miniprogram/test/operations-field-analysis-component.test.js
```

- [ ] **3. 实现组件与有界渲染。** 初始只请求 catalog，节点折叠不预取字段；展开一个节点只请求该节点的字段预览和元数据，不逐卡读取业务详情。node 响应的 linkages 提供当前真实存在的联动组引用；只有一组自动选中，多组按兼容版本说明让用户选择，不猜目录 id。productStage 决定下一层选项或属性区域，维度标签只来自已验证 dimensionMetadata。node 视图每个字段最多十项，展开全部时请求 field 第一页替换预览（不追加成重复项），后续按游标追加。其他节点继续折叠；不同 nodeGroupId 的选择互相隔离。

使用真实 Component 测试装载器捕获组件 methods、lifetimes、observers，并通过业务 service 的云边界桩延迟响应。每个异步请求捕获账号对象、角色、sessionEpoch、queryKey、selectionKey、请求代际。状态变更先触发 analysischange 使导出失效，再请求数据。

```js
// 每个异步任务先捕获上下文；查询键包含 view、全部筛选及维度。
const owner = getApp().globalData.currentUser
const generation = ++this._requestGeneration
const current = () => this.properties.enabled &&
  getApp().globalData.currentUser === owner &&
  this._requestGeneration === generation && this._queryKey === queryKey
// 成功仅 current() 写入；finally 同样受保护。
// catch 中同账号同会话的权限拒绝优先调用 resetAnalysis + accessinvalid，
// 即使 generation 已过期也不能留下旧敏感数据。
```

普通网络失败保留同上下文已加载页和旧游标，提供明确重试；REPORT_CHANGED/REPORT_EXPIRED 清空对应分析并从第一页刷新。隐藏/卸载清空敏感数据及请求代际，但不伪造用户选择变化事件。折叠区域不写服务器；没有目录规则时仅提供普通字段/字段对。

- [ ] **4. 落实 RF3 和交互测试。** 快速 A→B 响应倒序只展示 B；账号对象更换、角色变化、隐藏、卸载均拒绝迟到结果；旧账号拒绝不清空新账号，当前账号已取消请求的 FORBIDDEN/ACCOUNT_DISABLED 仍清空。下一页失败保留已加载行、不重复计数；catalog 游标失败可重试。多选共现显示固定解释，展示比例由服务端 count/filledSampleCount 计算，不能用已加载行计数总和作分母。长中文标签、重复可读标签但不同维度、空型号属性都保持正确入口。

- [ ] **5. 跑 GREEN。**

```powershell
node --test miniprogram/test/operations-field-analysis.test.js miniprogram/test/operations-field-analysis-component.test.js
```

### Task 5: 页面集成、CSV v2 校验与原生发送生命周期

**Files:**
- Modify: `miniprogram/pages/admin-operations/index.js`、`index.json`、`index.wxml`、`index.wxss`。
- Modify: `miniprogram/utils/operations-field-report.js`。
- Modify: `miniprogram/test/operations-field-flow.test.js`、`admin-operations-flow.test.js`。
- Create: `miniprogram/test/operations-field-analysis-flow.test.js`。

**Interfaces:** 页面新增 `onFieldAnalysisChange`、`onFieldAnalysisAccessInvalid`；`csvQuery()` 返回 `{...原查询,reportVersion:2,analysis:已提交分析选择}`。FIELD_CSV_COLUMNS 只在末尾追加新列，validReportPage/reportCsvRows 理解关联统计。原 protected call、toCsv 和 wx.shareFileMessage 调用链保留。

- [ ] **1. 编写页面 RED。** 使用现有 operations-field-flow harness 风格通过真实 services/business，而不是伪造页面内部已处理结果。测试 timing action 收到的 query 不含 analysis/reportVersion，分析 change 使 exportReady=false；v2 客户端拒绝残缺/伪造关联行而不写文件。将以下核心断言接入已有写文件和发送记录：

```js
assert.equal(h.calls.find(call=>call.action==='exportOperationsReportRows')
  .payload.reportVersion,2)
assert.equal(h.writes.length,1)
assert.equal(h.shares.length,0) // 首次只生成
await h.page.exportCsv()
assert.equal(h.shares.length,1) // 第二次点击同步调用原生发送
```

- [ ] **2. 运行 RED。**

```powershell
node --test miniprogram/test/operations-field-analysis-flow.test.js miniprogram/test/operations-field-flow.test.js miniprogram/test/admin-operations-flow.test.js
```

- [ ] **3. 替换字段区域并连接导出。** index.json 注册组件，WXML 只在原字段区域使用组件，不包围工时/指标区域：

```xml
<operations-field-analysis
  enabled="{{fieldAnalysisEnabled}}"
  query="{{fieldAnalysisQuery}}"
  session-epoch="{{fieldAnalysisSessionEpoch}}"
  bind:analysischange="onFieldAnalysisChange"
  bind:accessinvalid="onFieldAnalysisAccessInvalid" />
```

query 是点击生成图表后或原自动刷新已确认的条件快照。编辑日期但未生成时失效分析和旧 CSV，不能把新日期混入旧已展示数据。只修改字段 load 分支，原工时的成功、错误和请求序列保持。移除不用的旧 fieldGroups 平铺渲染及载入，不保留两条同时发请求的字段展示链路。

追加列键为 analysisGroupId、dimensionIdsJson、dimensionNamesJson、dimensionValuesJson、notApplicableSampleCount、analysisContextJson。关联行必须验证 JSON 数组长度一致、维度 id 唯一合法、值全为非空精确字符串、整数合法及 occurrenceCount<=filledSampleCount；不能因为“关联统计”而直接放过整行。JSON 编码保留原标签，已有可读列仍走公式防护。

- [ ] **4. RF4 与完整链路核对。** 用户点“发送 CSV”进入原生面板时 onHide 可以停用/清空组件，但不能触发 analysischange 或修改 sending task 的 queryKey；合法回调仍回到 ready。离开非发送状态、改筛选、换账号、同会话撤权必须使旧文件失效；发送面板期间真实账号变更也不能采纳旧回调。报告收集所有分页成功后才写文件，页失败/游标循环/超限没有可发送半文件。以真实新仓储→服务→客户端 formatter→CSV 输出的合成链路重算各组合，与服务端 count、分母和筛选 JSON 相同。

- [ ] **5. 跑 GREEN 和全部客户端。**

```powershell
node --test miniprogram/test/operations-field-analysis-flow.test.js miniprogram/test/operations-field-flow.test.js miniprogram/test/admin-operations-flow.test.js
node --test miniprogram/test/*.test.js
```

### Task 6: 官方渲染、整体回归、统一复核与项目记忆

**Files:**
- Create: `tools/test-operations-field-analysis-rendering.mjs`。
- Create: `docs/deployment/operations-field-analysis-acceptance.md`。
- Modify: `docs/memory/PROJECT.md`、`docs/memory/STATUS.md`。
- Add: 下一个尚未占用编号的 `docs/memory/decisions/ADR-NNNN-operations-field-analysis.md`；执行时先枚举文件再确定编号，不能覆盖已有 ADR。

**Interfaces:** 沿用 `WECHAT_WCC_PATH` 官方编译器；最终复核以本轮前置文件基线作增量比较，同时检查现有功能集成。只读审查使用 fresh reviewer，主代理复核其证据，所有 Critical/Important 修复后重测。

- [ ] **1. 用官方 WXML 输出写展示 RED。** 复用 test-previous-node-records-rendering 的 execFileSync + vm $gwx 方式，不用字符串正则冒充渲染。新脚本断言折叠无字段、零值选项无节点、默认十项、展开后余项、型号属性不同列、共现说明、错误和不完整提示独立存在。渲染合成数据，不读线上客户记录。

```js
const compiled = execFileSync(compiler, ['components/operations-field-analysis/index.wxml'],
  {cwd:miniRoot,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024})
const context = vm.createContext({window:{},console})
vm.runInContext(compiled,context,{timeout:5000})
const tree = context.$gwx('components/operations-field-analysis/index.wxml')(data)
```

脚本中 compiler 来自 WECHAT_WCC_PATH，miniRoot 为仓库 miniprogram，data 为各断言的合成组件 data；参考既有脚本的 all/text 递归工具定义，禁止未定义变量直接运行。

- [ ] **2. 运行编译与实际状态渲染，修复后全量回归。**

```powershell
$env:WECHAT_WCC_PATH='E:/微信小程序开发者工具/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec/wcc.exe'
node tools/test-operations-field-analysis-rendering.mjs
node tools/test-previous-node-records-rendering.mjs
node tools/test-business-card-rendering.mjs
node tools/test-wxml-structure.mjs
node tools/sync-operations-field-domain.mjs --check
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/operationsAnalytics
node --test miniprogram/test/*.test.js
git diff --check
```

每个命令单独检查退出状态和测试汇总，不能让最后一个命令的退出码掩盖前面的失败。展示模拟覆盖 320/375/430/768px 宽度、长标签与桌面矮窗口，临时输出不进入 Git；这不是五端真机通过。

- [ ] **3. 统一独立复核。** 提供已确认规格、当前计划、本轮精确文件清单和前置基线；请审查者重点检查 RF1–RF5、授权/摘要窗口、精确导出和旧客户端兼容，不要求审查者重读无关历史。确认新 metadata helper 是添加式、旧 worker 格式无变化，集成没有新业务写入。反馈先复现、补失败测试，再最小修复；不对审查者仅声称“已修复”。

- [ ] **4. 更新部署验收与记忆。** PROJECT 只添加稳定架构事实；ADR 记录关联统计、历史规则绑定、协议 v2 及未选择跨节点/迁移的理由；STATUS 记录实际命令、通过数量、审查发现/修复以及未完成的真机项。无底层日志、客户字段原文或身份值入文档。

```powershell
python 'C:/Users/87579/.codex/skills/maintaining-project-memory/scripts/validate_memory.py' .
git diff --check
```

验收文档逐条列出普通/管理账号、目录缺口、手机/桌面操作、CSV 两阶段、原上传/审批/前序节点无回归。以上不通过不得进入发布。

### Task 7: 执行已授权的 businessApi 发布与小程序上传

**Files:** 生产包仅包含核实后的 `cloudfunctions/businessApi` 应用文件；本机临时部署目录和 `outputs/deploy` 证据不提交 Git；更新 `docs/memory/STATUS.md` 与本功能验收记录。不得修改 project.config.json、线上依赖、环境变量、权限或 Timer 来完成此发布。

**Interfaces:** 本机官方 CLI 的 download/inc-deploy/upload --help 已于 2026-09-23 读取核对。当前 env 为 cloud1-d5gxt99rh492670d9、AppID 为 wx6dcce945f944e52f；实际登录与当前上传版本在发布当天重新验证。

- [ ] **1. 只读核对登录、云端基线与发布清单。**

```powershell
$analysisCli='E:/微信小程序开发者工具/微信web开发者工具/cli.bat'
$analysisProject='C:/Users/87579/Documents/业务事务推进进度排期应用开发'
$analysisReleaseRoot=Join-Path $env:TEMP ('operations-analysis-release-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $analysisReleaseRoot
$analysisBefore=Join-Path $analysisReleaseRoot 'before'
New-Item -ItemType Directory -Path $analysisBefore
& $analysisCli cloud functions download --env cloud1-d5gxt99rh492670d9 --name businessApi --path $analysisBefore --project $analysisProject
```

检查成功标识及实际下载目录结构，逐路径 SHA256 对比应用/包文件；云端有本地没有或不属于已批准工作区的修改时停止，不能覆盖。若扫码过期，只请求登录原小程序账号，不新建云环境。依赖以下载的生产版本为准，不执行 npm install 或“在线安装依赖”。

- [ ] **2. 组成精确完整代码目录并校验。** 先复制下载的 businessApi 到新的独立 stage/businessApi，再仅覆盖已经测试、核对过的本地 index.js/lib 文件及新增分析模块，保留生产 node_modules/package/lockfile。stage 不加入测试、附件、文档、输出、用户指南或配置；写入临时 SHA256 清单，核对已发布的上传/卡片/前序节点代码没有回退。实际待发布文件再次跑语法和隔离全量后端测试；测试仅复制到另一个临时验证目录，不能混入 stage。

```powershell
$analysisStage=Join-Path $analysisReleaseRoot 'stage/businessApi'
# analysisStage 必须是刚核对并完成隔离测试的完整目录。
& $analysisCli cloud functions inc-deploy --env cloud1-d5gxt99rh492670d9 --path $analysisStage --file . --project $analysisProject
```

只使用经过前一步核对的真实路径执行；不把注释视为已经完成复制或测试。目录构造使用 PowerShell Copy-Item -LiteralPath 的显式源/目标，不执行递归删除或跨 shell 移动。官方目录增量路径用于保持 Linux 路径分隔正确，不上传未确认的在线编辑器草稿。

- [ ] **3. 回下载验证，不写测试业务。**

```powershell
$analysisAfter=Join-Path $analysisReleaseRoot 'after'
New-Item -ItemType Directory -Path $analysisAfter
& $analysisCli cloud functions download --env cloud1-d5gxt99rh492670d9 --name businessApi --path $analysisAfter --project $analysisProject
```

递归列表及逐文件 SHA256 与 stage 比对；若平台改变依赖元数据，必须解释精确内容并确认实际依赖代码/版本未变，不忽略差异。只用无写入入口/现有账号只读界面确认启动与查询；没有用户可用的已授权会话时把业务端验证记录为 unverified，不获取或保存会话密钥。

- [ ] **4. 上传新版小程序。** 发布时核对开发者工具和公众平台最近上传版本。最新可核实基线目前是 1.2.6，因此候选为 1.2.7；若已存在更高版本，按实际最新 patch 加一，记录实际版本，不重用编号。

```powershell
$analysisVersion='1.2.7'
$analysisUploadInfo=Join-Path $analysisReleaseRoot ('miniprogram-'+$analysisVersion+'-upload-info.json')
& $analysisCli upload --project $analysisProject --version $analysisVersion --desc '运营字段有效数据与同节点关联分析；前序节点交互优化' --info-output $analysisUploadInfo
```

此命令只有在版本核对后执行；如果高于基线，先把 analysisVersion 设为核实后递增值。同时检查官方成功标识、退出码及 info 文件；发现 CLI 启动/认证报错，即使退出码为 0 也不能宣称成功。不自动切换体验版、提交审核或正式发布。

- [ ] **5. 交付事实与未验证项目。** STATUS 记录实际后端时间/包摘要/回读结果、客户端版本/包信息、文档校验和未完成五端项；说明业务记录未写、其他云函数未发布。给用户一个最短验收路径：运营看板 → 展开节点 → 分类/品牌/型号 → 属性组合 → 双字段 → CSV。若需要用户把开发版设为体验版或在手机验证，准确说明该一个下一步，而不把本地测试当成五端已适配证据。

## 计划自查清单

- [x] 规格范围对应任务 1–5；兼容、权限、资源限制对应任务 1–3、6；发布授权对应任务 7。
- [x] RF1–RF5 均有指定任务与可复现输入；没有只写“处理边界”而不说明预期。
- [x] 新函数、事件、记录类型和字段名在接口区或归属任务定义；不重命名原业务 API。
- [x] 未定义的 cloud 路由测试文件不作为既存资源引用；真实入口用已存在 account-routes harness。
- [x] 原有使用习惯、其他字段仅 CSV、零记录隐藏、同节点共现、未填写/不适用、全量导出和旧快照语义均有验收覆盖。
- [x] 没有产品代码改动、云端部署或上传被描述为已经完成；113 项仅为本轮只读基线。

## 审阅与执行交接

请用户审阅本实施计划是否准确覆盖已确认的规格。执行方式已经保留为当前目录连续开发、最终统一独立复核，不再次要求用户选择模式。用户确认计划后执行以上任务，并在验证通过后履行已授权的 businessApi 发布及小程序上传；遇到真正的范围变化或人工登录需要时再提出具体问题。
