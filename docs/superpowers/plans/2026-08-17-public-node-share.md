# 七日公开节点快照分享实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让授权操作人把已完成节点的固定结果通过微信原生面板分享给无需登录的好友或群，并在七天后自动失效。

**Architecture:** 账号内创建接口生成随机能力令牌和不可变分享预约，凭证按 40 条分块发布；公开读取入口只认能力令牌并返回安全投影/短期媒体地址。凭证保留锁防止分享有效期内清理，evidenceRetention 有界删除过期分享元数据。

**Tech Stack:** CloudBase Node.js 16、`crypto.randomBytes`、原生微信小程序分享能力、Node.js `node:test`。

## Global Constraints

- 分享编号为服务端 HMAC-SHA256 派生的 32 字节 base64url；同一幂等请求稳定恢复，禁止日志、审计正文和其他列表返回全文。
- 固定有效期 `7 * 24 * 60 * 60 * 1000` 毫秒，只使用服务端时钟。
- 只分享已完成节点最终结果；快照创建后源业务修改不得改变分享正文。
- 凭证块最多 40 条；任何事务不超过 100 次文档操作。
- 公开投影不包含账号编号、OpenID、永久 fileID、哈希、请求键、租约和版本。
- `evidenceRetention` 在 `publicShareHoldUntil > now` 时不得删除云对象。

---

### Task 1: 分享领域、预约与创建服务

**Files:**
- Create: `cloudfunctions/businessApi/lib/share-domain.js`
- Create: `cloudfunctions/businessApi/lib/share-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-share-repository.js`
- Create: `cloudfunctions/businessApi/test/share-domain.test.js`
- Create: `cloudfunctions/businessApi/test/share-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-share-repository.test.js`

**Interfaces:**
- Produces: `createNodeShareSnapshot({ actor,input }) -> { token,path,expiresAt }`。
- Produces repository steps: `prepareShare`、`claimShareEvidenceChunk`、`publishShare`、`abortShare`。

- [ ] **Step 1: 写资格、最终轮快照、随机令牌、幂等、105凭证和事务预算 RED**
- [ ] **Step 2: 运行 RED，确认模块缺失**
- [ ] **Step 3: 实现最多40条的预约/认领/发布流程**
- [ ] **Step 4: 运行 GREEN 与反馈/审核/凭证回归**
- [ ] **Step 5: 明确暂存并提交 `feat: 创建七日节点分享快照`**

---

### Task 2: 公开读取与短期媒体地址

**Files:**
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `cloudfunctions/businessApi/lib/share-service.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-share-repository.js`
- Modify: `cloudfunctions/businessApi/test/share-service.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-share-repository.test.js`

**Interfaces:**
- Produces: 无登录动作 `getPublicNodeShare({ token,cursor,pageSize })`。

- [x] **Step 1: 写无登录成功、过期/未发布/损坏统一拒绝、字段脱敏和短期 URL RED**
- [ ] **Step 2: 运行 RED**
- [ ] **Step 3: 实现独立 public route；不得经过账号 bootstrap 或自动建号**
- [ ] **Step 4: 运行路由、分享和完整 businessApi GREEN**
- [ ] **Step 5: 明确暂存并提交 `feat: 开放七日只读分享入口`**

---

### Task 3: 分享页与微信原生分享

**Files:**
- Create: `miniprogram/pages/public-node-share/index.js`
- Create: `miniprogram/pages/public-node-share/index.json`
- Create: `miniprogram/pages/public-node-share/index.wxml`
- Create: `miniprogram/pages/public-node-share/index.wxss`
- Create: `miniprogram/test/public-node-share-flow.test.js`
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/business-detail/index.js`
- Modify: `miniprogram/pages/business-detail/index.wxml`
- Modify: `miniprogram/app.json`
- Modify: `tools/test-wxml-structure.mjs`

- [ ] **Step 1: 写已完成节点入口、无登录读取、图片/视频/PDF、过期文案和 `onShareAppMessage` RED**
- [ ] **Step 2: 运行 RED**
- [ ] **Step 3: 实现公开只读页和 `open-type=share` 按钮**
- [ ] **Step 4: 运行全部小程序和 WXML GREEN**
- [ ] **Step 5: 明确暂存并提交 `feat: 接入节点结果微信分享页`**

---

### Task 4: 分享保留锁与到期元数据清理

**Files:**
- Modify: `cloudfunctions/evidenceRetention/lib/cloud-retention-repository.js`
- Modify: `cloudfunctions/evidenceRetention/lib/retention-service.js`
- Modify: `cloudfunctions/evidenceRetention/test/cloud-retention-repository.test.js`
- Modify: `cloudfunctions/evidenceRetention/test/retention-service.test.js`
- Modify: `cloudfunctions/evidenceRetention/test/scheduled-entry.test.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-evidence-repository.js`
- Modify: `cloudfunctions/businessApi/test/cloud-evidence-repository.test.js`

- [ ] **Step 1: 写有效分享禁止删除、到期恢复删除、过期分享块/头有界清理 RED**
- [ ] **Step 2: 运行 RED**
- [ ] **Step 3: 实现严格 `publicShareHoldUntil` 和新清理阶段**
- [ ] **Step 4: 运行 evidenceRetention、businessApi 全量 GREEN**
- [ ] **Step 5: 明确暂存并提交 `feat: 管理分享快照保留与到期清理`**

---

### Task 5: 部署文档、最终安全矩阵与总验证

**Files:**
- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `README.md`
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `cloudfunctions/businessApi/test/cloud-share-repository.test.js`
- Modify: `cloudfunctions/evidenceRetention/test/cloud-retention-repository.test.js`
- Modify: `cloudfunctions/evidenceRetention/test/scheduled-entry.test.js`
- Modify: `miniprogram/test/public-node-share-flow.test.js`

- [ ] **Step 1: 写集合、索引、权限、令牌泄漏扫描和真机验收契约 RED**
- [ ] **Step 2: 补充 `public_node_shares`、`public_node_share_chunks` 的仅云函数权限与索引**
- [ ] **Step 3: 运行 businessApi、calendarSync、workflowReminder、evidenceRetention、小程序、WXML、语法、diff 和项目记忆验证**
- [ ] **Step 4: 明确暂存并提交 `docs: 完成七日公开分享部署资料`**
