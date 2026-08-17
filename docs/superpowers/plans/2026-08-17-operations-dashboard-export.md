# 管理看板与 CSV 导出实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为活动超级管理员提供可解释的业务/节点统计和安全 CSV 导出。

**Architecture:** 独立 operations domain/service/repository 只做超级管理员查询；统计严格基于权威状态字段，导出按稳定游标分页。客户端本地生成 UTF-8 BOM CSV，并阻断电子表格公式注入。

**Tech Stack:** CloudBase Node.js 16、原生微信小程序、RFC 4180 CSV、Node.js `node:test`。

## Global Constraints

- 日期为上海自然日闭区间，最大 366 天。
- 每次查询重新校验活动超级管理员；普通用户统一 `FORBIDDEN`。
- 导出单页最多 50 条且稳定排序；不得返回凭证、身份绑定或内部状态。
- CSV 对 `= + - @` 前缀加单引号，所有字段按 RFC 4180 转义。

---

### Task 1: 后端管理统计与导出投影

**Files:**
- Create: `cloudfunctions/businessApi/lib/operations-domain.js`
- Create: `cloudfunctions/businessApi/lib/operations-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-operations-repository.js`
- Create: `cloudfunctions/businessApi/test/operations-domain.test.js`
- Create: `cloudfunctions/businessApi/test/operations-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-operations-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- Produces: `getOperationsDashboard({ actor, query })`。
- Produces: `exportOperationsRows({ actor, query }) -> { items,nextCursor,hasMore }`。

- [ ] **Step 1: 写角色、日期、统计、投影脱敏和稳定分页 RED**
- [ ] **Step 2: 运行聚焦 RED，确认新动作缺失**
- [ ] **Step 3: 实现最小统计和节点行投影**
- [ ] **Step 4: 运行聚焦 GREEN 与完整 businessApi**
- [ ] **Step 5: 明确暂存并提交 `feat: 增加管理统计与安全导出查询`**

---

### Task 2: 小程序管理看板与 CSV 文件

**Files:**
- Create: `miniprogram/utils/csv.js`
- Create: `miniprogram/pages/admin-operations/index.js`
- Create: `miniprogram/pages/admin-operations/index.json`
- Create: `miniprogram/pages/admin-operations/index.wxml`
- Create: `miniprogram/pages/admin-operations/index.wxss`
- Create: `miniprogram/test/admin-operations-flow.test.js`
- Create: `miniprogram/test/csv.test.js`
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/dashboard/index.js`
- Modify: `miniprogram/pages/dashboard/index.wxml`
- Modify: `miniprogram/app.json`
- Modify: `tools/test-wxml-structure.mjs`

- [ ] **Step 1: 写 CSV 注入、引号/换行、权限、分页和异步守卫 RED**
- [ ] **Step 2: 运行 RED**
- [ ] **Step 3: 实现统计卡片、筛选与临时 CSV 生成**
- [ ] **Step 4: 运行全部小程序与 WXML GREEN**
- [ ] **Step 5: 明确暂存并提交 `feat: 增加管理看板与CSV导出`**

---

### Task 3: 部署、记忆与总验证

**Files:**
- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`

- [ ] **Step 1: 补充查询索引与脱敏验收矩阵**
- [ ] **Step 2: 运行六套项目测试、WXML、diff 和项目记忆校验**
- [ ] **Step 3: 明确暂存并提交 `docs: 记录管理看板与导出验收`**
