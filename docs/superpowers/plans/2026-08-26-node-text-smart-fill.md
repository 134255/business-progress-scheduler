# 当前节点文本智能识别与字段预填 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让当前节点处理人粘贴一段文本，经过受保护的 CloudBase AI 解析后预览字段候选，并由用户选择性填入当前表单；原文和候选不持久化，既有保存、审核和版本控制保持不变。

**Architecture:** 小程序只调用 `businessApi.recognizeNodeText`；`businessApi` 在模型调用前后都重验账号、售后、当前节点、版本和字段摘要，通过五分钟单次票据调用独立 `nodeTextParser`。解析工作器原子消费票据、调用 CloudBase AI+、严格验证输出，只返回当前字段的安全候选。客户端把候选分为直接填入、可能替换、人工确认三组，应用时只更新本地表单。

**Tech Stack:** Node.js 16、CommonJS、`wx-server-sdk`、CloudBase AI+、微信小程序 WXML/WXSS、Node `node:test`、CloudBase 文档数据库事务。

**Spec:** `docs/superpowers/specs/2026-08-26-node-text-smart-fill-design.md`

## Global Constraints

- 保留用户未提交的 `project.config.json` 修改；不得读取、修改、暂存或提交该文件。
- 原始粘贴文本、模型原始响应、候选值、身份原值不得写入数据库、日志、审计、通知、搜索、运营统计、项目记忆或 Git。
- 客户端不可提交账号、角色、字段定义、模型、提示词、票据、阈值或每日额度。
- 每分钟最多 10 次、上海自然日默认最多 300 次、单账号单飞；`NODE_TEXT_PARSE_DAILY_LIMIT` 只接受 `1..1000` 的十进制安全整数，缺失默认 300，损坏配置失败关闭。
- 一次性票据至少 192 位随机、五分钟有效、原子单次消费，绑定账号摘要、售后、节点、版本、字段摘要、文本摘要和请求键摘要。
- 所有数据库数组和对象都按 own data property、稠密数组、已知字段白名单验证；访问器、继承属性、稀疏数组和未知字段失败关闭。
- 所有底层 AI、数据库和云函数错误对客户端统一为固定中文消息，不泄漏错误码、模型输出、请求编号、云路径或堆栈。
- 每个实现任务先 RED、再最小 GREEN、再重构；每个任务单独提交明确路径。

---

## Task 1: 建立解析领域协议与 CloudBase AI 适配器

**Files:**

- Create: `cloudfunctions/nodeTextParser/lib/parser-domain.js`
- Create: `cloudfunctions/nodeTextParser/lib/cloudbase-ai-client.js`
- Create: `cloudfunctions/nodeTextParser/test/parser-domain.test.js`
- Create: `cloudfunctions/nodeTextParser/test/cloudbase-ai-client.test.js`

- [ ] **Step 1: 为严格输入、输出和模糊选项规则写失败测试**

覆盖字段定义白名单、未知/重复字段、稀疏数组、访问器/继承属性、非有限置信度、超长摘录、非法类型、提示注入仅作正文、精确选项优先、0.5 阈值、单选前两名差值小于 0.1 转人工、多选按置信度降序且不能创造选项。

```js
test('single select keeps close semantic candidates manual', () => {
  const result = validateModelCandidates(definitions, [{
    fieldKey: 'warehouse',
    optionScores: [
      { option: '上海一仓', confidence: 0.78 },
      { option: '上海二仓', confidence: 0.72 }
    ],
    sourceExcerpt: '上海仓'
  }])
  assert.equal(result[0].requiresConfirmation, true)
})
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run: `npm.cmd test --prefix cloudfunctions/nodeTextParser -- --test-name-pattern="parser domain|CloudBase AI client"`

Expected: FAIL，因为解析领域和 AI 适配器尚不存在。

- [ ] **Step 3: 实现严格领域协议**

导出以下接口：

```js
module.exports = {
  MAX_TEXT_LENGTH,
  normalizeParserSchema,
  buildModelRequest,
  validateModelCandidates
}
```

`normalizeParserSchema(fieldDefinitions)` 只保留模型需要的稳定字段；`buildModelRequest({ text, schema })` 使用固定系统指令和严格 JSON Schema；`validateModelCandidates(schema, raw)` 复用等价于 `field-domain` 的类型约束，并实现选项匹配规则。

- [ ] **Step 4: 实现可注入的 CloudBase AI 适配器**

```js
function createCloudbaseAiClient({ createModel, modelName }) {
  return {
    async parse(request) {
      const model = createModel(modelName)
      return readStrictJson(await model.generateContent(request))
    }
  }
}
```

默认装配只从服务端环境读取模型名；空白、访问器、非法模型名失败关闭。测试注入假模型，不访问网络。

- [ ] **Step 5: 复跑聚焦测试并提交**

Run: `npm.cmd test --prefix cloudfunctions/nodeTextParser`

Expected: PASS。

Commit: `feat: 建立节点文本解析协议`

---

## Task 2: 实现一次性票据解析工作器

**Files:**

- Create: `cloudfunctions/nodeTextParser/index.js`
- Create: `cloudfunctions/nodeTextParser/package.json`
- Create: `cloudfunctions/nodeTextParser/package-lock.json`
- Create: `cloudfunctions/nodeTextParser/lib/parser-service.js`
- Create: `cloudfunctions/nodeTextParser/lib/cloud-parse-repository.js`
- Create: `cloudfunctions/nodeTextParser/test/fake-db.js`
- Create: `cloudfunctions/nodeTextParser/test/cloud-parse-repository.test.js`
- Create: `cloudfunctions/nodeTextParser/test/parser-service.test.js`
- Create: `cloudfunctions/nodeTextParser/test/index.test.js`

- [ ] **Step 1: 写票据消费和入口授权 RED**

测试合法票据单次消费；过期、重放、账号/节点/版本/schema/text/requestKey 摘要变化、损坏状态、revision 溢出均拒绝。入口拒绝缺票据和客户端伪造 Timer/身份，只返回安全分类。

```js
await assert.rejects(
  repository.consumeParseTicket({ ticketId, text, schema, expectedNodeVersion: 2 }),
  error => error.code === 'NODE_TEXT_TICKET_INVALID'
)
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npm.cmd test --prefix cloudfunctions/nodeTextParser`

Expected: FAIL，缺少仓储、服务和入口。

- [ ] **Step 3: 实现事务内原子消费**

仓储接口：

```js
createCloudParseRepository({ db, clock }).consumeParseTicket({
  ticketId,
  actorHash,
  businessLineId,
  nodeId,
  expectedNodeVersion,
  schemaDigest,
  textDigest,
  requestKeyHash
})
```

事务固定读取票据文档，精确校验 own data fields 后从 `pending` 更新为 `consumed`；文档不得含原文或候选。

- [ ] **Step 4: 实现解析服务与安全入口**

```js
createParserService({ repository, aiClient }).parseAuthorizedText(input)
```

顺序必须是规范化输入摘要、消费票据、调用 AI、严格验证候选。日志仅输出安全分类、耗时桶和候选数量。

- [ ] **Step 5: 添加机会式过期清理**

每次合法调用后按 `expiresAt ASC, _id ASC` 最多删除 20 条已过期票据；清理失败不改变本次解析结果，但只记安全分类。

- [ ] **Step 6: GREEN、语法检查与提交**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/nodeTextParser
node --check cloudfunctions/nodeTextParser/index.js
git diff --check
```

Expected: 全部 PASS。

Commit: `feat: 增加受票据保护的文本解析工作器`

---

## Task 3: 在 businessApi 中加入重授权、限流与票据签发

**Files:**

- Create: `cloudfunctions/businessApi/lib/node-text-recognition-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-node-text-recognition-repository.js`
- Create: `cloudfunctions/businessApi/lib/node-text-parser-client.js`
- Create: `cloudfunctions/businessApi/test/node-text-recognition-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-node-text-recognition-repository.test.js`
- Create: `cloudfunctions/businessApi/test/node-text-parser-client.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

- [ ] **Step 1: 写路由白名单、授权和双重重验 RED**

只允许 `businessLineId/nodeId/expectedNodeVersion/text/requestKey`。覆盖停用账号、非处理人、非当前节点、旧流程、pending_review/completed/cancelled、版本变化、schema 变化、处理人变化和伪造身份字段。

- [ ] **Step 2: 写单飞和额度 RED**

覆盖 10/11 分钟边界、默认 300/301 日边界、上海午夜重置、合法环境覆盖、空白/非整数/0/1001/访问器配置失败关闭、并发争抢、过期锁恢复、损坏计数和 revision 溢出。

```js
assert.equal(resolveDailyLimit(undefined), 300)
assert.equal(resolveDailyLimit('450'), 450)
assert.throws(() => resolveDailyLimit('1001'), error => error.code === 'NODE_TEXT_CONFIG_INVALID')
```

- [ ] **Step 3: 运行聚焦测试确认 RED**

Run:

```powershell
node --test cloudfunctions/businessApi/test/node-text-recognition-service.test.js cloudfunctions/businessApi/test/cloud-node-text-recognition-repository.test.js cloudfunctions/businessApi/test/node-text-parser-client.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

Expected: FAIL，新入口和模块不存在。

- [ ] **Step 4: 实现权威读取和额度事务**

仓储固定接口：

```js
authorizeRecognition({ actorOpenId, businessLineId, nodeId, expectedNodeVersion })
claimUsage({ actorHash, requestToken, now, dailyLimit })
issueTicket({ ticketId, requestKeyHash, actorHash, businessLineId, nodeId,
  expectedNodeVersion, schemaDigest, textDigest, now, expiresAt })
releaseUsage({ actorHash, requestToken })
```

授权结果只返回规范化字段定义和内部账号摘要；每日使用文档按 actor SHA-256 摘要确定 ID，不存 OpenID 原值。

- [ ] **Step 5: 实现解析客户端和服务编排**

`node-text-parser-client.js` 仅接受服务端生成的票据与规范化 schema，并使用 `cloud.callFunction({ name: 'nodeTextParser' })`。服务流程：预授权 → 认领额度/锁 → 签票 → 调用工作器 → 后授权 → 最终候选校验 → `finally` 释放锁。

- [ ] **Step 6: 注册受保护路由并安全映射错误**

`businessApi.recognizeNodeText` 返回：

```js
{
  nodeVersion,
  schemaDigest,
  candidates: [{ fieldKey, value, confidence, matchKind, sourceExcerpt,
    requiresConfirmation, warnings }]
}
```

限流使用稳定中文提示；其他失败统一“智能识别暂时不可用，请稍后重试”。原始文本不得进入错误对象或日志。

- [ ] **Step 7: GREEN、全量 businessApi 与提交**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --check cloudfunctions/businessApi/index.js
git diff --check
```

Expected: 全部 PASS。

Commit: `feat: 开放受保护节点文本识别入口`

---

## Task 4: 增加小程序粘贴识别、预览和选择应用

**Files:**

- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/node-feedback/index.js`
- Modify: `miniprogram/pages/node-feedback/index.wxml`
- Modify: `miniprogram/pages/node-feedback/index.wxss`
- Modify: `miniprogram/test/node-feedback-v2.test.js`
- Modify: `miniprogram/test/review-flow.test.js`
- Modify: `tools/test-wxml-structure.mjs`

- [ ] **Step 1: 写客户端服务与页面状态 RED**

覆盖最大 8,000 字、只读/非新版节点不显示、单飞、固定安全错误、三组预览、空字段默认选中、已有值默认不选、应用只改本地、不触发保存/提交。

- [ ] **Step 2: 写迟到响应和隐私 RED**

账号切换、页面离开、节点/版本/schema 变化、手工编辑、取消和清空文本后迟到结果丢弃；测试确保页面状态重置且不把原文写进既有保存 payload、日志或缓存。

- [ ] **Step 3: 运行聚焦测试确认 RED**

Run:

```powershell
node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/review-flow.test.js
node tools/test-wxml-structure.mjs
```

Expected: FAIL，识别 UI 与服务方法不存在。

- [ ] **Step 4: 实现服务封装和安全错误**

新增：

```js
function recognizeNodeText(input) {
  return callProtected('recognizeNodeText', input, '智能识别暂时不可用，请稍后重试')
}
```

不得把服务端 message 直接显示；对限流可使用明确但不含计数内部结构的中文白名单消息。

- [ ] **Step 5: 实现页面识别状态机**

新增独立 `recognitionSequence`、稳定请求键、请求时 actor/node/version/schema/formRevision 快照。`markDraftDirty()` 同时递增表单修订并使当前识别结果失效。页面卸载和账号变化使迟到结果无效。

- [ ] **Step 6: 实现预览 UI 和应用逻辑**

折叠区包含文本框、字数、识别/取消按钮；预览展示直接填入、可能替换、人工确认，单项选择和“应用所选结果”。应用前按当前字段定义再次校验，不创建选项，不自动保存。

- [ ] **Step 7: GREEN、小程序全量与提交**

Run:

```powershell
npm.cmd test --prefix miniprogram
node tools/test-wxml-structure.mjs
node --check miniprogram/pages/node-feedback/index.js
git diff --check
```

Expected: 全部 PASS。

Commit: `feat: 增加节点文本智能预填界面`

---

## Task 5: 部署契约、完整回归与验收材料

**Files:**

- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `docs/memory/STATUS.md`
- Modify: `docs/memory/PROJECT.md` only if a stable fact changed
- Create: `.superpowers/sdd/2026-08-26-node-text-smart-fill/task-5-report.md`

- [ ] **Step 1: 写部署契约检查 RED**

在自动测试中断言手册包含：两个新集合仅云函数读写、票据到期索引、`nodeTextParser` 与 `businessApi` 超时至少 60 秒、两函数上传顺序、`nodeTextParser` 触发器必须 `[]`、默认 300/环境变量边界、AI+ 模型与费用告警、不得记录真实文本。

- [ ] **Step 2: 补齐部署手册**

明确创建：

```text
node_text_parse_requests(expiresAt ASC, _id ASC)
node_text_parse_usage（固定摘要文档，无组合索引）
```

部署顺序：备份 → 集合/权限/索引 → AI+ 模型与配额 → 上传 `nodeTextParser` → 核对 `triggers: []` → 上传 `businessApi` 并保持既有环境变量 → 上传小程序 → 无敏感人工验收。

- [ ] **Step 3: 跑完整回归**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/nodeTextParser
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
npm.cmd test --prefix cloudfunctions/operationsAnalytics
npm.cmd test --prefix miniprogram
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: 所有已安装套件 PASS；真实 CloudBase AI、配额、嵌套调用、延迟、集合权限、索引和真机仍标记 `unverified`，直到人工完成。

- [ ] **Step 4: 做隐私静态检查**

Run:

```powershell
rg -n "rawText|pastedText|modelResponse|promptResponse" cloudfunctions miniprogram docs/memory
```

逐项确认命中只出现在内存变量/测试，不进入数据库写入、日志、通知、审计、搜索、运营事实或项目记忆。

- [ ] **Step 5: 更新记忆、报告并提交**

`STATUS.md` 写入精确测试计数、提交、未验证部署边界和下一步；`PROJECT.md` 只记录稳定协议。任务报告不得含真实用户文本、身份、密钥或模型输出。

Commit: `docs: 记录节点文本识别验证与部署步骤`

---

## Task 6: 最终审查与合并准备

**Files:**

- Review all files changed since `2356618`

- [ ] **Step 1: 对照规格逐项自审**

核对所有 13 节设计：授权、票据、限流、数据最小化、类型、模糊匹配、预览、并发、错误、日志、部署、测试、完成标准。

- [ ] **Step 2: 检查提交范围和工作树**

Run:

```powershell
git status --short
git log --oneline 2356618..HEAD
git diff --check 2356618..HEAD
```

Expected: 仅用户既有 `project.config.json` 修改可留在主工作区；功能工作树清洁，无秘密、原文样例或无关文件。

- [ ] **Step 3: 完成验证后合并或推送**

只有所有本地自动化通过且代码审查无 Critical/Important 时才合并到 `main`。CloudBase 上传、AI+ 配置、小程序体验版和真机验收必须单独标记，未经真实操作不能宣称完成。
