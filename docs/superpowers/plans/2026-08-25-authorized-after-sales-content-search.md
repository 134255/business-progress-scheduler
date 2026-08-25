# 授权范围内的售后全流程内容检索实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为售后列表增加按当前有效节点字段、处理说明、审核意见和凭证文件名检索的能力，并保证活动超级管理员可检索全部合法售后、普通账号只能检索原有权限范围。

**Architecture:** 新增独立 `businessSearch` 云函数，将每条售后当前有效快照生成版本化安全条目和 HMAC 倒排令牌。现有 `businessApi` 写事务推进独立检索版本，事务提交后通过一次性内部票据同步调用工作器；查询同样通过一次性票据进入工作器并在候选读取后、返回前两次复核当前账号和售后关系。历史回填和失败恢复只接受可信 Timer，并用每批最多 40 条的持久 keyset 游标运行。

**Tech Stack:** Node.js 16、CommonJS、`wx-server-sdk@4.0.2`、CloudBase 文档数据库与事务、微信小程序 WXML/WXSS、Node 内置测试运行器。

**Spec:** `docs/superpowers/specs/2026-08-25-authorized-after-sales-content-search-design.md`

## Global Constraints

- 用户界面使用“售后”，内部集合、字段、路由和模块继续使用 `business*`。
- 关键词最多 5 个，规范化后总长最多 100 个 Unicode 码点；允许单字符，多关键词为 AND。
- 只索引当前有效最新快照；旧驳回轮、旧处理修订和被替换内容不得命中。
- 活动 `super_admin` 可检索全部非 `creating`、非 `deleted` 售后；普通活动账号只限原有关系可见售后。
- 所有候选返回前重新授权；无权、撤权、停用、损坏和过期候选不产生存在性信号。
- CloudBase 单事务最多 100 次文档操作；所有数组索引按真实 BSON 结构保持在保守 768 字节预算内。
- 工作器单次历史扫描最多 40 条原始候选，不使用 `skip`。
- `businessSearch` 初次部署及验收后均保持 `triggers: []`，正式恢复 Timer 另行批准。
- `BUSINESS_SEARCH_HMAC_SECRET` 不得进入 Git、日志、测试快照或项目记忆。
- 不读取、不修改、不暂存、不提交操作员自己的 `project.config.json` 变更。

---

## 文件结构

### 新增云函数

- `cloudfunctions/businessSearch/index.js`：可信 Timer 与一次性票据入口、默认 CloudBase 装配和安全汇总。
- `cloudfunctions/businessSearch/package.json`：独立云函数依赖和测试命令。
- `cloudfunctions/businessSearch/package-lock.json`：锁定 `wx-server-sdk@4.0.2`。
- `cloudfunctions/businessSearch/lib/search-domain.js`：关键词规范化、字段格式化、文本分段、HMAC 令牌和摘要。
- `cloudfunctions/businessSearch/lib/search-service.js`：索引生成、查询、历史回填、失败恢复编排。
- `cloudfunctions/businessSearch/lib/cloud-search-repository.js`：一次性票据、权威快照、代际索引、授权查询和持久游标。
- `cloudfunctions/businessSearch/test/*.test.js`：域、服务、仓储、入口和部署契约测试。

### `businessApi` 变更

- `cloudfunctions/businessApi/lib/business-search-client.js`：创建一次性内部票据、调用工作器、投影稳定索引状态。
- `cloudfunctions/businessApi/lib/search-version.js`：固定文档检索版本推进和仓储返回内部信封的共享纯函数。
- `cloudfunctions/businessApi/lib/business-service.js`：创建、元数据更新和列表检索编排。
- `cloudfunctions/businessApi/lib/feedback-service.js`：保存进度及兼容旧反馈后的同步索引。
- `cloudfunctions/businessApi/lib/review-service.js`：提交审核和投票后的同步索引。
- `cloudfunctions/businessApi/lib/business-lifecycle-service.js`：冻结售后修订后的同步索引。
- `cloudfunctions/businessApi/lib/cloud-business-repository.js`：创建、元数据、修订事务和列表基础授权推进检索版本。
- `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`：反馈发布事务推进售后与节点检索版本。
- `cloudfunctions/businessApi/lib/cloud-review-repository.js`：审核提交和投票事务推进售后与节点检索版本。
- `cloudfunctions/businessApi/index.js`：装配检索客户端并保留现有受保护路由。
- 对应 `cloudfunctions/businessApi/test/*.test.js`：每层 TDD、权限和事务预算回归。

### 小程序和部署资料

- `miniprogram/services/business.js`：检索状态的固定中文错误映射。
- `miniprogram/pages/business-list/index.js`：关键词游标、摘要展开和旧响应失效保护。
- `miniprogram/pages/business-list/index.wxml`：检索范围提示和最多三条命中摘要。
- `miniprogram/pages/business-list/index.wxss`：摘要标签和展开布局。
- `miniprogram/test/business-search-flow.test.js`：客户端检索、分页、摘要和账号切换。
- `docs/deployment/template-node-fields-setup.md`：集合、索引、密钥、云函数、空触发器、回填、验收和回滚。
- `docs/memory/PROJECT.md`、`docs/memory/STATUS.md`：仅记录实现后稳定规则与精确证据。

---

### Task 1: 检索域与安全令牌

**Files:**
- Create: `cloudfunctions/businessSearch/lib/search-domain.js`
- Create: `cloudfunctions/businessSearch/test/search-domain.test.js`
- Create: `cloudfunctions/businessSearch/package.json`
- Create: `cloudfunctions/businessSearch/package-lock.json`

**Interfaces:**
- Produces: `normalizeSearchQuery(input) -> { keywords, normalizedKeywords, digestInput }`
- Produces: `buildSearchEntries(snapshot) -> SearchEntry[]`
- Produces: `tokenizeEntry(entry, secret) -> TokenChunk[]`
- Produces: `entryMatchesKeywords(entry, normalizedKeywords) -> boolean`
- Produces: `safeSearchExcerpt(entry, normalizedKeywords) -> string`

- [ ] **Step 1: 写关键词规范化失败测试**

```js
test('检索支持单字符并对多个关键词执行 NFKC 和 AND 规范化', () => {
  assert.deepEqual(normalizeSearchQuery({ keyword: ' Ａ  清 闲 ' }).normalizedKeywords, ['a', '清', '闲'])
})

test('检索拒绝超过五词或规范化后总长超过一百码点', () => {
  assert.throws(() => normalizeSearchQuery({ keyword: '一 二 三 四 五 六' }), { code: 'INVALID_SEARCH_QUERY' })
  assert.throws(() => normalizeSearchQuery({ keyword: '测'.repeat(101) }), { code: 'INVALID_SEARCH_QUERY' })
})
```

- [ ] **Step 2: 运行域测试确认 RED**

Run: `node --test cloudfunctions/businessSearch/test/search-domain.test.js`

Expected: FAIL with `MODULE_NOT_FOUND` for `../lib/search-domain`.

- [ ] **Step 3: 实现查询规范化、字段格式化和严格结构读取**

```js
function normalizeText(value) {
  if (typeof value !== 'string') throw createError('SEARCH_SOURCE_INVALID')
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

function normalizeSearchQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw createError('INVALID_SEARCH_QUERY')
  const keyword = input.keyword === undefined ? '' : input.keyword
  if (typeof keyword !== 'string') throw createError('INVALID_SEARCH_QUERY')
  const normalizedKeywords = normalizeText(keyword).split(' ').filter(Boolean)
  const total = normalizedKeywords.reduce((sum, item) => sum + Array.from(item).length, 0)
  if (normalizedKeywords.length > 5 || total > 100) throw createError('INVALID_SEARCH_QUERY')
  return { keywords: normalizedKeywords.slice(), normalizedKeywords, digestInput: normalizedKeywords.join('\u0000') }
}
```

- [ ] **Step 4: 写所有内容类型与当前快照条目失败测试**

覆盖售后名称/编号/说明、节点名称/编号、七类动态字段、处理说明、审核意见、凭证文件名；断言未知类型、访问器、继承值、稀疏数组、重复字段编号和技术字段均失败关闭。

- [ ] **Step 5: 实现条目构建、2048 码点分段和 99 码点重叠**

```js
function segmentText(text, size = 2048, overlap = 99) {
  const points = Array.from(text)
  const result = []
  for (let start = 0; start < points.length; start += size - overlap) {
    result.push(points.slice(start, start + size).join(''))
    if (start + size >= points.length) break
  }
  return result
}
```

- [ ] **Step 6: 写 HMAC 令牌与精确命中失败测试**

断言单字生成一元片段、双字生成二元片段、长词生成三元片段；令牌固定长度、无原文、每块真实 BSON 估算不超过 768 字节；伪造相同锚点但正文不含关键词时 `entryMatchesKeywords` 返回 `false`。

- [ ] **Step 7: 实现令牌、摘要和安全预算**

```js
function hashToken(secret, gram) {
  return crypto.createHmac('sha256', secret).update(gram, 'utf8').digest('base64url').slice(0, 22)
}
```

令牌数组按编码预算动态分块，不使用固定数量替代字节核算。

- [ ] **Step 8: 运行域 GREEN 和语法检查**

Run: `node --test cloudfunctions/businessSearch/test/search-domain.test.js`

Expected: PASS, including 100-character chunk-boundary and collision cases.

Run: `node --check cloudfunctions/businessSearch/lib/search-domain.js`

- [ ] **Step 9: 提交 Task 1**

```powershell
git add -- cloudfunctions/businessSearch/package.json cloudfunctions/businessSearch/package-lock.json cloudfunctions/businessSearch/lib/search-domain.js cloudfunctions/businessSearch/test/search-domain.test.js
git commit -m "feat: 建立售后检索安全域"
```

---

### Task 2: 一次性票据、权威快照与代际仓储

**Files:**
- Create: `cloudfunctions/businessSearch/lib/cloud-search-repository.js`
- Create: `cloudfunctions/businessSearch/test/cloud-search-repository.test.js`
- Reuse: `cloudfunctions/businessApi/test/helpers/fake-db.js` only as behavior reference; keep the worker test harness local to its cloud function.

**Interfaces:**
- Consumes: Task 1 `buildSearchEntries`, `tokenizeEntry`, `entryMatchesKeywords`.
- Produces: `createCloudSearchRepository({ db, clock, secret })`.
- Produces repository methods `consumeRequest`, `loadAuthoritativeSnapshot`, `publishGeneration`, `queryAuthorized`, `claimBackfillPage`, `claimRecoveryPage`, `cleanupOldGeneration`.

- [ ] **Step 1: 写票据消费 RED**

```js
test('一次性票据只能消费一次且绑定操作、账号、售后和版本', async () => {
  const first = await repository.consumeRequest({ token, operation: 'index' })
  assert.equal(first.businessLineId, 'line-1')
  await assert.rejects(repository.consumeRequest({ token, operation: 'index' }), { code: 'FORBIDDEN' })
})
```

同时覆盖过期、跨操作、跨版本、损坏结构、原始票据未落库和事务冲突重试。

- [ ] **Step 2: 运行仓储测试确认 RED**

Run: `node --test cloudfunctions/businessSearch/test/cloud-search-repository.test.js`

Expected: FAIL because repository does not exist.

- [ ] **Step 3: 实现票据摘要和事务消费**

数据库文档编号使用 `HMAC(secret, token)`；文档只保存摘要、安全参数、`pending|consumed`、过期时间和版本。消费事务先校验全部自有数据属性，再写 `consumed`。

- [ ] **Step 4: 写当前快照矩阵 RED**

构造处理中、待审核、已完成、返工、等待五类节点，断言仓储只选择：

```js
{
  in_progress: 'current published feedback',
  pending_review: 'active review round and current votes',
  completed: 'approved final review round',
  ready: 'node metadata only'
}
```

旧驳回轮、旧修订、损坏票、跨业务凭证和技术字段必须缺席或失败关闭。

- [ ] **Step 5: 实现严格权威快照读取**

所有集合查询均有明确 `where/orderBy/limit`，查询结果再按固定文档编号和归属复核。凭证只读取安全文件名，不把 `fileId`、哈希或内部编号传给域层。

- [ ] **Step 6: 写不可变代际 RED**

覆盖：完整新代发布、部分写入不发布、N/N+1 并发、来源版本单边变化、节点集合变化、旧代清理不影响当前代、显式 `_id` 不能写入 `doc(id).set()`。

- [ ] **Step 7: 实现代际写入和固定文档发布事务**

每批最多写 20 个检索文档。最终事务读取售后及最多 24 个节点，核对来源版本和生成摘要后更新售后/节点的生成字段；静态和动态测试实际统计文档操作不超过 100。

- [ ] **Step 8: 写授权查询 RED**

覆盖活动超级管理员全局结果、普通成员/管理员关系、无关账号、账号停用、超级管理员降权、查询中途撤权、创建中/删除售后、游标跨账号和摘要最多三条。

- [ ] **Step 9: 实现候选交集、精确正文复核和两次授权**

查询返回：

```js
{
  items: [{ _id, code, name, status, currentNodeName, matches: [{ nodeName, label, excerpt }] }],
  cursor: 'opaque-or-empty',
  hasMore: false
}
```

无权或损坏候选静默丢弃；不返回精确总数。

- [ ] **Step 10: 运行仓储 GREEN**

Run: `node --test cloudfunctions/businessSearch/test/cloud-search-repository.test.js`

Expected: PASS with operation-budget, permission and generation matrices.

- [ ] **Step 11: 提交 Task 2**

```powershell
git add -- cloudfunctions/businessSearch/lib/cloud-search-repository.js cloudfunctions/businessSearch/test/cloud-search-repository.test.js
git commit -m "feat: 实现售后检索代际仓储"
```

---

### Task 3: 检索工作器服务与可信入口

**Files:**
- Create: `cloudfunctions/businessSearch/lib/search-service.js`
- Create: `cloudfunctions/businessSearch/index.js`
- Create: `cloudfunctions/businessSearch/test/search-service.test.js`
- Create: `cloudfunctions/businessSearch/test/index.test.js`

**Interfaces:**
- Produces: `createSearchService({ repository, secret })` with `indexRequest`, `queryRequest`, `runCycle`.
- Produces: `createBusinessSearchHandler({ service, getContext, getTriggerSource, clock, logger })`.

- [ ] **Step 1: 写服务 RED**

测试一次性索引、一次性查询、索引恢复、历史回填、旧代清理各自只调用对应仓储接口；单条失败增加安全计数但不泄漏内容。

- [ ] **Step 2: 运行服务测试确认 RED**

Run: `node --test cloudfunctions/businessSearch/test/search-service.test.js`

Expected: FAIL because service module is missing.

- [ ] **Step 3: 实现服务编排**

```js
async function indexRequest({ token }) {
  const request = await repository.consumeRequest({ token, operation: 'index' })
  if (await repository.isGenerationCurrent(request)) return request.publicResult
  const snapshot = await repository.loadAuthoritativeSnapshot(request)
  const entries = buildSearchEntries(snapshot)
  await repository.publishGeneration({ request, entries })
  return request.publicResult
}
```

`queryRequest` 消费票据、重新读取账号并调用 `queryAuthorized`；`runCycle` 固定 `batchSize: 40`，依次处理待回填、失败恢复和废代清理。

- [ ] **Step 4: 写入口授权 RED**

覆盖：客户端 OPENID 无票据拒绝、伪造 `event.Type=Timer` 拒绝、内部一次性票据允许且忽略事件时间、严格 `process.env.TRIGGER_SRC=timer` 允许恢复、大小写错误拒绝、错误日志只含稳定码。

- [ ] **Step 5: 实现入口和默认装配**

```js
if (event && typeof event.ticket === 'string' && event.ticket) {
  return event.operation === 'query'
    ? service.queryRequest({ token: event.ticket })
    : service.indexRequest({ token: event.ticket })
}
if (hasClientIdentity || getTriggerSource() !== 'timer') throw safeError('FORBIDDEN')
return service.runCycle({ now: clock(), batchSize: 40 })
```

票据本身授权内部调用，但工作器仍在仓储中重验票据目标和当前账号；事件正文不授予 Timer 权限。

- [ ] **Step 6: 运行入口 GREEN**

Run: `npm.cmd test --prefix cloudfunctions/businessSearch`

Expected: all domain, repository, service and handler tests pass.

- [ ] **Step 7: 提交 Task 3**

```powershell
git add -- cloudfunctions/businessSearch/index.js cloudfunctions/businessSearch/lib/search-service.js cloudfunctions/businessSearch/test/search-service.test.js cloudfunctions/businessSearch/test/index.test.js
git commit -m "feat: 增加售后检索工作器"
```

---

### Task 4: `businessApi` 内部检索客户端

**Files:**
- Create: `cloudfunctions/businessApi/lib/business-search-client.js`
- Create: `cloudfunctions/businessApi/lib/search-version.js`
- Create: `cloudfunctions/businessApi/test/business-search-client.test.js`
- Create: `cloudfunctions/businessApi/test/search-version.test.js`
- Modify: `cloudfunctions/businessApi/index.js`

**Interfaces:**
- Produces: `createBusinessSearchClient({ db, callFunction, secret, clock, randomBytes })`.
- Produces client methods `ensureIndexed(envelope)` and `query({ actorId, query })`.
- Produces: `advanceSearchVersion(current) -> { searchSourceVersion, searchIndexStatus, searchGeneratedVersion }`.
- Produces: `stripSearchEnvelope(result) -> publicResult`.

- [ ] **Step 1: 写版本纯函数 RED**

断言缺失旧字段从 1 开始；合法值递增；负数、小数、字符串、访问器、继承值和 `MAX_SAFE_INTEGER` 失败关闭；生成版本不能大于来源版本。

- [ ] **Step 2: 实现检索版本纯函数**

```js
function advanceSearchVersion(record) {
  const source = readOptionalSafeVersion(record, 'searchSourceVersion', 0)
  if (source === Number.MAX_SAFE_INTEGER) throw createError('SEARCH_STATE_INVALID')
  return { searchSourceVersion: source + 1, searchIndexStatus: 'pending' }
}
```

- [ ] **Step 3: 写内部票据客户端 RED**

测试随机票据不少于 24 字节；数据库只存 HMAC 摘要；调用 `businessSearch`；网络超时后重试复用相同来源版本但签发新一次性票据；工作器返回结果后只返回安全业务结果；缺少密钥失败关闭。

- [ ] **Step 4: 实现检索客户端**

```js
async function ensureIndexed(envelope) {
  if (!envelope) return null
  const ticket = randomBytes(32).toString('base64url')
  await storeRequest({ ticket, operation: 'index', envelope })
  const response = await callFunction({ name: 'businessSearch', data: { operation: 'index', ticket } })
  return response && response.result
}
```

`query` 创建绑定账号、规范化查询和过期时间的查询票据；任何 `callFunction` 原始异常映射为稳定 `BUSINESS_SEARCH_UNAVAILABLE`。

- [ ] **Step 5: 接入默认装配但不改变路由契约**

`createBusinessApi` 增加可注入 `businessSearchClient`；默认装配读取 `BUSINESS_SEARCH_HMAC_SECRET` 并使用 `cloud.callFunction`。测试装配可传 stub，不访问真实云函数。

- [ ] **Step 6: 运行 Task 4 GREEN**

Run: `node --test cloudfunctions/businessApi/test/search-version.test.js cloudfunctions/businessApi/test/business-search-client.test.js cloudfunctions/businessApi/test/account-routes.test.js`

- [ ] **Step 7: 提交 Task 4**

```powershell
git add -- cloudfunctions/businessApi/lib/search-version.js cloudfunctions/businessApi/lib/business-search-client.js cloudfunctions/businessApi/test/search-version.test.js cloudfunctions/businessApi/test/business-search-client.test.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js
git commit -m "feat: 接入售后检索内部客户端"
```

---

### Task 5: 售后创建、元数据与修订同步索引

**Files:**
- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/lib/business-service.js`
- Modify: `cloudfunctions/businessApi/lib/business-lifecycle-service.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/business-service.test.js`
- Modify: `cloudfunctions/businessApi/test/business-lifecycle-service.test.js`

**Interfaces:**
- Consumes: Task 4 `advanceSearchVersion`, `businessSearchClient.ensureIndexed`.
- Repository write results add internal non-client field `_searchEnvelope`.
- Service returns the original public result after `ensureIndexed` succeeds.

- [ ] **Step 1: 写创建和元数据 RED**

断言创建事务在售后和全部节点写 `searchSourceVersion: 1`、`searchIndexStatus: 'pending'`；元数据事务只推进售后来源版本；已发布创建幂等返回携带同一内部信封；任何检索字段非法时失败关闭。

- [ ] **Step 2: 运行仓储 RED**

Run: `node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js`

Expected: new search-version assertions fail.

- [ ] **Step 3: 修改固定文档事务并保持预算**

创建事务继续使用原售后和节点写操作，仅在原写入对象增加检索字段，不增加文档数。元数据更新在原售后 update 中加入 `advanceSearchVersion(currentLine)`。

- [ ] **Step 4: 写服务同步 RED**

断言 `createFromTemplate`、`updateMetadata` 在仓储成功后调用 `ensureIndexed`；索引失败抛 `BUSINESS_SEARCH_PENDING`，权威仓储只调用一次；同请求幂等返回再次尝试索引但不再创建售后。

- [ ] **Step 5: 实现服务同步和公共结果剥离**

```js
const stored = await repository.createBusinessSnapshot(snapshotInput)
await businessSearchClient.ensureIndexed(stored._searchEnvelope)
return stripSearchEnvelope(stored)
```

- [ ] **Step 6: 写冻结售后修订 RED/GREEN**

成功发布的修订若改变售后说明、节点字段或凭证文件名，原发布事务推进售后及受影响节点的检索版本；修订幂等重试只恢复索引。取消、删除状态依靠查询时状态授权，不伪造内容代。

- [ ] **Step 7: 运行 Task 5 GREEN 和预算测试**

Run: `node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/business-lifecycle-service.test.js`

Expected: all pass; existing 24-node/46-account 100-operation boundary still passes.

- [ ] **Step 8: 提交 Task 5**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/lib/business-service.js cloudfunctions/businessApi/lib/business-lifecycle-service.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/business-lifecycle-service.test.js
git commit -m "feat: 同步售后基础内容检索索引"
```

---

### Task 6: 处理进度、兼容反馈与审核轮次同步索引

**Files:**
- Modify: `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`
- Modify: `cloudfunctions/businessApi/lib/feedback-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-review-repository.js`
- Modify: `cloudfunctions/businessApi/lib/review-service.js`
- Modify: `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/feedback-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/review-service.test.js`

**Interfaces:**
- Repository save/submit/vote results carry `_searchEnvelope` with `businessLineId`, line source version, affected node versions and original public result.
- Services call the same Task 4 `ensureIndexed` and strip internal fields.

- [ ] **Step 1: 写处理进度 RED**

覆盖 `save_progress`、`mark_blocked`、兼容旧节点反馈完成、已发布同请求重试、105 凭证分块、失败回滚。只有最终发布反馈的事务推进售后和节点检索版本；预约、认领、回滚和等待阶段不推进。

- [ ] **Step 2: 实现反馈发布版本推进**

在 `finalizeFeedback` 已有 line/node update 中加入检索字段，不增加固定文档操作。返回内部信封，`feedback-service` 在成功后调用工作器。

- [ ] **Step 3: 写提交审核 RED**

断言创建活动审核轮后，售后和节点检索版本推进，工作器可见轮次固化字段、处理说明和凭证；同请求重试不创建第二轮但恢复索引。

- [ ] **Step 4: 实现提交审核版本推进和同步**

在审核轮次创建事务已有 line/node 写入中加入检索字段，保持锁定版本和双 SLA 算术不变。

- [ ] **Step 5: 写投票 RED**

覆盖或签首票通过、会签未终结票、驳回、终态重试、两类日历 carryover。每个成功新投票都改变当前审核意见，因此无论本轮是否终结，都推进所属节点和售后检索版本；同票幂等不重复推进。

- [ ] **Step 6: 实现投票固定文档版本推进**

对会签未终结路径补同一节点和售后的固定 update；先用操作计数测试证明最坏合法审核人数仍不超过 100。终结路径复用已有 node/line update。

- [ ] **Step 7: 运行 Task 6 GREEN**

Run: `node --test cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/review-service.test.js`

Expected: current snapshot, idempotency, late authorization, 105 evidence and <=100 operation tests pass.

- [ ] **Step 8: 提交 Task 6**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-feedback-repository.js cloudfunctions/businessApi/lib/feedback-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/review-service.test.js
git commit -m "feat: 同步节点当前快照检索索引"
```

---

### Task 7: 受保护列表检索和超级管理员全局查看

**Files:**
- Modify: `cloudfunctions/businessApi/lib/business-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/business-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- `listBusinessLines({ actor, query })` accepts only `keyword`, `startDate`, `endDate`, `page`, `pageSize`, `cursor`.
- Empty keyword uses repository list; non-empty keyword uses `businessSearchClient.query`.
- Keyword response uses `{ items, cursor, hasMore, total: null }`.

- [ ] **Step 1: 写查询输入 RED**

拒绝未知键、非字符串 keyword、超过五词/100 码点、非法 cursor/pageSize/date；空关键词保留现有 page/pageSize 兼容。

- [ ] **Step 2: 写超级管理员列表 RED**

构造非成员活动超级管理员，断言可列出所有非 `creating/deleted` 售后；降权或停用后返回 `FORBIDDEN` 或普通关系结果。普通无关账号仍无结果。

- [ ] **Step 3: 实现基础列表权限扩展**

仓储从数据库重新读取当前 actor，而非信任路由 actor 的角色；活动超级管理员走全局候选，普通账号走现有成员/管理员查询，最终逐项事务或固定读取复核。

- [ ] **Step 4: 写关键词路由 RED**

断言非空关键词只调用 `businessSearchClient.query`；客户端伪造 `actorId`、角色或可见售后编号被剥离；工作器返回技术字段时服务白名单投影。

- [ ] **Step 5: 实现关键词查询编排**

```js
if (normalized.keyword) {
  return businessSearchClient.query({ actorId: actor._id, query: normalized })
}
return repository.listBusinessLines({ actor, query: normalized })
```

- [ ] **Step 6: 运行 Task 7 GREEN**

Run: `node --test cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js`

- [ ] **Step 7: 提交 Task 7**

```powershell
git add -- cloudfunctions/businessApi/lib/business-service.js cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
git commit -m "feat: 开放授权售后内容检索"
```

---

### Task 8: 小程序检索摘要、游标和异步安全

**Files:**
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/business-list/index.js`
- Modify: `miniprogram/pages/business-list/index.wxml`
- Modify: `miniprogram/pages/business-list/index.wxss`
- Create: `miniprogram/test/business-search-flow.test.js`

**Interfaces:**
- Service keeps `listBusinessLines(filters)` and maps `BUSINESS_SEARCH_PENDING`, `BUSINESS_SEARCH_UNAVAILABLE`, `INVALID_SEARCH_QUERY` to fixed Chinese messages.
- Page data adds `cursor`, `expandedMatchIds`, `requestSequence`, while preserving no-keyword page mode.

- [ ] **Step 1: 写客户端 RED**

```js
test('关键词检索显示节点和内容类型摘要且不显示内部字段', async () => {
  await page.search()
  assert.equal(page.data.items[0].matches.length, 3)
  assert.equal(page.data.items[0].matches[0].label, '客户名称')
  assert.equal(JSON.stringify(page.data).includes('cloud://'), false)
})
```

另覆盖单字符、多词、展开、上拉 cursor、清空关键词恢复 page 模式、账号切换、页面隐藏和旧响应晚到。

- [ ] **Step 2: 运行客户端测试确认 RED**

Run: `node --test miniprogram/test/business-search-flow.test.js`

Expected: FAIL because summary/cursor behavior does not exist.

- [ ] **Step 3: 实现服务错误映射和页面状态机**

每次搜索递增 `requestSequence`；响应写回前比较页面可见、当前账号、查询摘要和序号。关键词模式使用 `cursor`，空关键词使用现有 `page`。加载失败保留已显示结果并给固定中文提示。

- [ ] **Step 4: 实现 WXML 摘要**

```xml
<view class="search-matches" wx:if="{{item.matches.length}}">
  <view wx:for="{{item.matches}}" wx:for-item="match" wx:key="id" class="search-match">
    <text class="match-label">{{match.nodeName}} · {{match.label}}</text>
    <text class="match-excerpt">{{match.excerpt}}</text>
  </view>
</view>
```

输入框提示改为“可检索售后、节点、字段和凭证名称”，不展示“全文”“数据库”等技术词。

- [ ] **Step 5: 运行客户端 GREEN**

Run: `node --test miniprogram/test/business-search-flow.test.js`

Run: `node tools/test-wxml-structure.mjs`

- [ ] **Step 6: 提交 Task 8**

```powershell
git add -- miniprogram/services/business.js miniprogram/pages/business-list/index.js miniprogram/pages/business-list/index.wxml miniprogram/pages/business-list/index.wxss miniprogram/test/business-search-flow.test.js
git commit -m "feat: 展示售后检索命中摘要"
```

---

### Task 9: 历史回填、恢复游标和部署契约

**Files:**
- Modify: `cloudfunctions/businessSearch/lib/cloud-search-repository.js`
- Modify: `cloudfunctions/businessSearch/lib/search-service.js`
- Modify: `cloudfunctions/businessSearch/test/cloud-search-repository.test.js`
- Modify: `cloudfunctions/businessSearch/test/search-service.test.js`
- Create: `cloudfunctions/businessSearch/test/deployment-contract.test.js`
- Modify: `docs/deployment/template-node-fields-setup.md`

**Interfaces:**
- `runCycle({ now, batchSize: 40 }) -> { backfillExamined, generated, recovered, cleaned, failed }`.
- Cursor documents live under `system_settings/business-search:*` with `schemaVersion`, `revision`, phase, typed sort value and `_id`.

- [ ] **Step 1: 写公平游标 RED**

覆盖 40 条失效候选后第 41 条合法候选有限可达、全失效页推进、尾页回绕、并发 CAS 只领取一次、领取后崩溃可再次到达、损坏游标与版本溢出失败关闭。

- [ ] **Step 2: 实现类型化 keyset 游标**

按 `searchIndexStatus ASC, updatedAt ASC, _id ASC` 扫描 pending/recovery 来源；CloudBase 不依赖元组 OR，使用“同排序值且 `_id` 更大”和“排序值更大”两段查询，合计原始 limit 不超过剩余额度。

- [ ] **Step 3: 写部署文档契约 RED**

测试必须精确检查：

```text
business_search_documents
business_search_requests
BUSINESS_SEARCH_HMAC_SECRET
businessSearch
triggers: []
```

以及每个生产 `.where().orderBy()` 对应的字段顺序和方向。

- [ ] **Step 4: 更新部署手册**

加入备份、集合权限、组合索引、密钥双函数配置、60 秒运行时、空触发器、一次性 Timer、历史回填、超级管理员/普通用户权限矩阵、回滚和发布记录“未验证”选项。不得自动配置正式 Timer。

- [ ] **Step 5: 运行 Task 9 GREEN**

Run: `npm.cmd test --prefix cloudfunctions/businessSearch`

Expected: domain/repository/service/handler/deployment contract all pass.

- [ ] **Step 6: 提交 Task 9**

```powershell
git add -- cloudfunctions/businessSearch/lib/cloud-search-repository.js cloudfunctions/businessSearch/lib/search-service.js cloudfunctions/businessSearch/test/cloud-search-repository.test.js cloudfunctions/businessSearch/test/search-service.test.js cloudfunctions/businessSearch/test/deployment-contract.test.js docs/deployment/template-node-fields-setup.md
git commit -m "docs: 准备售后检索回填与部署"
```

---

### Task 10: 全量验证、项目记忆与交付

**Files:**
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`
- Modify: `docs/memory/decisions/ADR-0012-authorized-after-sales-content-search.md` only if implementation changes an accepted durable consequence.

**Interfaces:**
- No new runtime interface; freezes exact evidence and deployment boundary.

- [ ] **Step 1: 跑新增云函数全量**

Run: `npm.cmd test --prefix cloudfunctions/businessSearch`

Expected: all tests pass, 0 failures.

- [ ] **Step 2: 跑现有五个云函数全量**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
npm.cmd test --prefix cloudfunctions/operationsAnalytics
```

Expected: all pass, 0 failures.

- [ ] **Step 3: 跑小程序与 WXML 全量**

```powershell
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

Expected: all pass, 0 failures.

- [ ] **Step 4: 检查所有新增和变更生产 JavaScript 语法**

Run `node --check` for each changed production `.js` returned by:

```powershell
git diff --name-only 1ca699c..HEAD -- '*.js'
```

Expected: 0 syntax errors.

- [ ] **Step 5: 执行安全与预算专项门禁**

检查生产文件中不出现检索密钥值、原始关键词日志、`cloud://` 搜索摘要、原始请求键或 OpenID 投影；复跑事务 100 次、索引 768 字节、40 条游标和超级管理员降权矩阵。

- [ ] **Step 6: 更新项目记忆**

`PROJECT.md` 只加入已经实现并验证的稳定检索架构；`STATUS.md` 记录每条实际命令、精确通过数、真实部署 `unverified` 边界和下一步 CloudBase 操作。不得记录密钥、真实关键词或业务数据。

- [ ] **Step 7: 跑差异与项目记忆门禁**

```powershell
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: both pass.

- [ ] **Step 8: 检查范围并提交收尾**

```powershell
git status --short
git diff --stat 1ca699c..HEAD
git add -- docs/memory/PROJECT.md docs/memory/STATUS.md docs/memory/decisions/ADR-0012-authorized-after-sales-content-search.md
git commit -m "docs: 记录售后检索验证结果"
```

明确确认 `project.config.json` 未被暂存。

- [ ] **Step 9: 执行完成前复审**

按规格逐项核对：内容覆盖、当前快照、超级管理员全局权限、普通用户隔离、同步索引、恢复、游标、预算、错误脱敏、客户端摘要和部署资料。任何 Critical 或 Important 问题必须先补 RED、完成 GREEN 并重跑全量，不能以文档说明代替修复。

- [ ] **Step 10: 交付部署步骤**

向操作员提供从备份开始的逐步 CloudBase 指引；集合、索引、密钥和云函数部署完成前不上传正式小程序。`businessSearch` 首次只保存空触发器，历史回填必须使用无敏感隔离数据的一次性 Timer，执行后立即恢复 `[]`。
