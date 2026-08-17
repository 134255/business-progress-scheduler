# 待我处理与概览看板实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用服务端权威查询替换“待我处理（暂不可用）”，并让概览统计在超出安全扫描边界时诚实显示下界。

**Architecture:** 新增独立 dashboard domain/service/repository，受保护路由只传可信账号。待办查询先按账号角色取有界候选，再逐项固定文档重新授权；概览聚合复用受保护业务、审核、通知和处理待办接口。客户端新增待处理列表并保持账号切换与旧响应失败关闭。

**Tech Stack:** CloudBase Node.js 16、原生微信小程序 JavaScript/WXML/WXSS、Node.js `node:test`。

## Global Constraints

- 所有账号关系字段必须使用自有数据属性和严格数组；任一新账号标记存在时禁止 OpenID 回退。
- 业务必须为 `active`，节点必须是该业务当前节点且状态为 `ready|in_progress|blocked`。
- 单页最多 50 条；概览最多扫描 2,000 条并用 `complete:false` 表示安全下界。
- 任何候选返回前都重新读取当前活动账号、业务和节点。
- `project.config.json` 不修改、不暂存、不提交。

---

### Task 1: 服务端待处理查询

**Files:**
- Create: `cloudfunctions/businessApi/lib/dashboard-domain.js`
- Create: `cloudfunctions/businessApi/lib/dashboard-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-dashboard-repository.js`
- Create: `cloudfunctions/businessApi/test/dashboard-domain.test.js`
- Create: `cloudfunctions/businessApi/test/dashboard-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-dashboard-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- Produces: `listMyPendingProcessing({ actor, query }) -> { items, nextCursor, hasMore }`。
- Produces: `getMyDashboardSummary({ actor }) -> { stats, recent }`。

- [ ] **Step 1: 写待办权限、排序、撤权和分页失败测试**

测试新版处理人、纯旧兼容、混合 schema 禁止回退、停用账号、非当前节点、冻结业务、三种允许状态、截止为空排最后、候选查询后撤权以及 `pageSize=50/51` 边界。

- [ ] **Step 2: 运行 RED**

Run: `node --test cloudfunctions/businessApi/test/dashboard-domain.test.js cloudfunctions/businessApi/test/dashboard-service.test.js cloudfunctions/businessApi/test/cloud-dashboard-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js`

Expected: 新模块不存在或新动作返回 `UNKNOWN_ACTION`。

- [ ] **Step 3: 实现最小 domain/service/repository 与受保护路由**

严格输入只接受 `{cursor,pageSize}`。返回项只含业务/节点编号、名称、状态、轮次、截止/逾期和内部导航编号；不得返回关系数组、OpenID、请求摘要或租约。

- [ ] **Step 4: 运行 GREEN 和完整后端回归**

Run: `node --test cloudfunctions/businessApi/test/dashboard-domain.test.js cloudfunctions/businessApi/test/dashboard-service.test.js cloudfunctions/businessApi/test/cloud-dashboard-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js`

Run: `npm.cmd test --prefix cloudfunctions/businessApi`

- [ ] **Step 5: 明确暂存并提交**

提交信息：`feat: 增加个人处理待办查询`

---

### Task 2: 客户端待处理页与真实概览

**Files:**
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/dashboard/index.js`
- Modify: `miniprogram/pages/dashboard/index.wxml`
- Create: `miniprogram/pages/processing-list/index.js`
- Create: `miniprogram/pages/processing-list/index.json`
- Create: `miniprogram/pages/processing-list/index.wxml`
- Create: `miniprogram/pages/processing-list/index.wxss`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/test/business-template-flow.test.js`
- Create: `miniprogram/test/processing-list-flow.test.js`
- Modify: `tools/test-wxml-structure.mjs`

**Interfaces:**
- Consumes: `listMyPendingProcessing`、`getMyDashboardSummary`。
- Produces: 概览待办卡片与 `/pages/processing-list/index`。

- [ ] **Step 1: 写 RED**

覆盖概览不再显示“暂不可用”、精确和“至少 N”文案、点击进入待办、稳定翻页去重、只用服务端标识导航、账号切换/卸载丢弃旧响应。

- [ ] **Step 2: 运行 RED**

Run: `node --test miniprogram/test/business-template-flow.test.js miniprogram/test/processing-list-flow.test.js`

Expected: 服务方法和页面不存在，旧概览仍显示暂不可用。

- [ ] **Step 3: 实现最小页面与服务封装**

使用当前账号、请求序号和 `onShow` 刷新守卫；错误统一中文提示。待办项进入现有节点处理页，仅传 `businessLineId` 与 `nodeId`。

- [ ] **Step 4: 运行客户端与 WXML GREEN**

Run: `node --test miniprogram/test/*.test.js`

Run: `node tools/test-wxml-structure.mjs`

- [ ] **Step 5: 明确暂存并提交**

提交信息：`feat: 接入待我处理与真实概览`

---

### Task 3: 部署契约与总验证

**Files:**
- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`

- [ ] **Step 1: 从真实 `.where().orderBy()` 生成索引清单测试并先观察失败**
- [ ] **Step 2: 补充处理待办组合索引、权限和人工验收步骤**
- [ ] **Step 3: 运行 businessApi、小程序、WXML、语法、diff 和项目记忆验证**
- [ ] **Step 4: 明确暂存并提交**

提交信息：`docs: 记录个人待办与概览部署契约`
