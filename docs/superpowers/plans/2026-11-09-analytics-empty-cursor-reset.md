# 运营统计空队列游标复位实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 队列耗尽后安全复位旧统计游标，减少后续重复空查询。

**Architecture:** 保留现有四类队列及全部候选发现条件。双空时仅通过现有版本和位置的事务比较将旧游标复位为 null；不引入空结果缓存或额外状态字段。

**Tech Stack:** CommonJS、Node 内建 node:test、现有内存 CloudBase SDK 夹具；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-09-analytics-empty-cursor-reset-design.md`

## Global Constraints

- 当前工作区原生顺序执行，保留全部既有 dirty；不新建分支、提交、推送或部署。
- 仅一个运行文件及对应新测试；40 条批量、筛选、排序、事务权限、Timer 和非空领取语义不变。
- 不读真实业务数据、不运行云函数、不发消息、不新增依赖或权限。
- 缺失或已经为 null 的游标零写；并发版本改变不得覆盖；未知错误不重放。
- 净成本包括一次性事务读取、写入和控制请求；SDK 计数不当现金节省。

## Review Focus

- 空查询完成之后插入的低 ID 和高 ID 均能在下轮正常领取。
- 另一工作器更新游标后，复位不能倒退或覆盖它的进度。
- 两个并发复位者及事务 callback 重试不能重复推进版本。
- 已空游标、损坏游标及版本边界不能进入重复写入或溢出。
- 查询、写入和未知提交失败不能被解释为空成功或触发自动重试。

### Task 1 安全复位及匹配成本验证

**Files:**

- Modify: `cloudfunctions/operationsAnalytics/lib/cloud-analytics-repository.js` 的私有 `claim(kind, limit)`。
- Create: `cloudfunctions/operationsAnalytics/test/empty-cursor-reset.test.js`。
- Evidence: 忽略 Git 的 `outputs/qa/analytics-empty-cursor-20261109/`。
- Update: 本设计、计划完成状态及 `docs/memory/STATUS.md`。

**Interfaces:**

- 消费现有 `claimNodeCandidates`、`claimDecisionCandidates`、`claimBusinessCandidates`、`claimPendingFactCandidates`，入参和候选返回形状不变。
- 仅使用原 system_settings 游标形状 `{kind, cursorId, version, updatedAt}`，不导出新运行接口。

- [x] 冻结准确目标前像和 SHA；确认目标运行文件没有与本任务重叠的历史修改。
- [x] 写失败测试：四类旧游标双空后仅复位一次，下一轮仅查询首页；缺失/null 游标零写；非空回绕保持。
- [x] 写并发和失败测试，逐项覆盖 Review Focus；用原实现运行，确认因缺少复位而 RED，非夹具或依赖错误。
- [x] 最小修改 claim，复用相同 kind/位置/version 的比较语义。损坏、溢出及数据库未知错误保持可见。
- [x] 新测试 GREEN，再跑运营统计完整套件；原非空、发布及字段恢复回归保持。
- [x] 以准确前像和候选运行同一空闲合成夹具，报告首轮、10/100 轮 get/query/write/transaction/返回字节，不遗漏复位开销。
- [x] 对照正常/插入/并发结果和保护集合；运行 businessApi、WXML、默认 diff 与项目记忆 validator。
- [x] 检查仅计划路径变化并记录证据。仅本地交付，无 Git 提交或云部署；真实费用仍待上线后核验。

## 验证命令

`node --test cloudfunctions/operationsAnalytics/test/empty-cursor-reset.test.js`

`node --test cloudfunctions/operationsAnalytics/test/*.test.js`

`npm.cmd test --prefix cloudfunctions/businessApi`

`node tools/test-wxml-structure.mjs`

`git diff --check`

`python C:/Users/87579/.codex/skills/maintaining-project-memory/scripts/validate_memory.py .`

## 执行方式

建议主代理在当前工作区原生执行这一个任务；不拆多任务实现。末尾独立复核并发和失败语义，仅在计划确认后开始产品修改。

## 本地执行证据（2026-11-09）

用户已确认当前工作区原生执行，不提交、不推送、不部署。准确前像 SHA256 为 `526783a11c4c90e926062559736695a45fcdec083962274560742a495ddc8999`；原实现运行新测试 30 项有 19 项预期失败，候选定向 30/30、完整 Analytics 137/137、官方 businessApi（含 pretest）1932/1932、WXML 4/4 通过。完整输出及准确前像保留在忽略 Git 的 `outputs/qa/analytics-empty-cursor-20261109/`。

同一完整 handler 合成空闲夹具：四旧游标首轮 get/query/write/transaction 从 5/9/0/0 变为 9/9/4/4；10 轮累计从 50/90/0/0 变为 54/54/4/4；100 轮从 500/900/0/0 变为 504/504/4/4。原已 null 的对照完全不变。所有返回结果和保护集合一致，无真实云请求。候选 100 轮的查询返回 JSON 字节 9900→5544，但文档返回字节 55000→60698，另有 427 字节游标写入载荷，不能声称全部流量下降。数字是内存夹具 SDK 尝试和序列化载荷，不是平台账单单位或现金收益；真实费用仍未验证。

一次独立只读复核无 Critical/Important/Minor，独立定向 30/30。末次官方 Analytics 137/137；冻结 726 项既有源码/测试/配置中仅目标运行文件变化，其余 725 项 SHA 一致，新增仅目标测试。HEAD 未变、暂存区为空、默认 diff 检查及记忆 validator 通过；准确回执为 QA 的 scope-verification.json。当前只保留本地结果和证据，未部署。
