# Task 11-R2 修复报告

日期：2026-08-12（Asia/Shanghai）

基线：`a740964`

分支：`codex/template-node-fields`

## 范围与根因

本轮只修复最终复审遗留的两项 Important。第一项根因是生产入口显式传入 `batchSize: 50`，服务默认 50 且允许到 100，但仓库硬上限为 40，真实默认入口第一阶段必然抛出 `limit must be between 1 and 40`。第二项根因是范围查询统一只按 `_id` 排序并只持久化 `afterId`，既不满足 `(到期字段, _id)` 的严格后继关系，也与部署手册的复合索引不一致。

## RED

聚焦命令：

```powershell
node --test cloudfunctions/evidenceRetention/test/index.test.js cloudfunctions/evidenceRetention/test/retention-service.test.js cloudfunctions/evidenceRetention/test/cloud-retention-repository.test.js
```

结果：26 项中 21 通过、5 失败。失败分别证明生产默认入口以 50 触发仓库拒绝、服务接受 41、排序值前后混排仍按 `_id`、损坏复合游标未失败关闭，以及真实查询调用只有 `_id ASC`。

## GREEN

- 入口、服务默认值和服务合法范围统一为 1—40，不再存在 50/100 的执行路径。
- 每个扫描阶段声明权威排序字段和类型，游标持久化 `phase + afterSortValue + afterId`；日期只接受可严格往返的 ISO 字符串，编号和阶段均严格校验，损坏时失败关闭。
- 查询严格 `orderBy(dueField, 'asc').orderBy('_id', 'asc')`。续页用“同排序值且 `_id` 更大”与“排序值更大”两段有界查询模拟元组后继，两段合计读取不超过剩余额度；没有 OR、`skip` 或全量读取。
- 页满持久推进，页尾轮转 phase 并最终回绕；相同到期值跨页不丢不重，坏记录后的第 41 条可达，候选返回后崩溃可安全重复投递。
- 部署手册逐项对应实际 where/orderBy；ADR-0006 改为真实复合 keyset 决策。真实 CloudBase 复合索引选择仍保留为未验证边界。

聚焦 GREEN：26/26，0 失败。

## 最终验证

- `npm.cmd test --prefix cloudfunctions/businessApi`：490/490。
- `npm.cmd test --prefix cloudfunctions/calendarSync`：47/47。
- `npm.cmd test --prefix cloudfunctions/workflowReminder`：29/29。
- `npm.cmd test --prefix cloudfunctions/evidenceRetention`：32/32。
- `node --test miniprogram/test/*.test.js`：134/134。
- `node tools/test-wxml-structure.mjs`：4/4。
- 7 个变更/新增 JavaScript 文件 `node --check`：全部通过。
- `git diff --check`：通过，仅输出既有行尾转换提示。
- 项目记忆校验：通过。

真实 CloudBase 两段范围查询的复合索引选择、云函数部署和触发器仍未验证；`evidenceRetention` 必须继续保持 `triggers: []`。
