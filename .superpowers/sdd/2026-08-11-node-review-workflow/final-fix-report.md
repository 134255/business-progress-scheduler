# 最终集中修复报告

日期：2026-08-12（Asia/Shanghai）

基线：`43e8b40`

分支：`codex/template-node-fields`

## 结论

最终审查的 C1、I1、I2、I3、I4 均以真实仓储/服务边界先取得 RED，再完成最小生产修复并转 GREEN。没有启用或写入 `evidenceRetention` 触发器。

## C1 审核节点凭证授权

- RED：`node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js`，36 项中 34 通过、2 失败；真实新版快照只含 `processorUserIds` 时处理人登记被拒绝，混合关系未严格分流。
- GREEN：同命令最终 38/38。`review` 只接受自有数据的非空处理人/审核人数组、角色不重叠且无旧负责人字段；只有未声明 `workflowMode` 的纯旧记录才兼容 OpenID。混合/损坏关系对普通处理人及业务负责人均失败关闭，登记后的成员临时访问保持可用。

## I1 索引键预算

- RED：模板领域、模板服务和业务仓储聚焦测试证明 30 个真实长度账号形成约 1161—1201 字节数组，但原逻辑仍允许启用和创建。
- GREEN：三个聚焦文件 96/96；`businessApi` 最终全量通过。契约为单数组最多 50 项、可见 BSON 编码最多 768 字节，业务成员另预留一个最长 128 字节创建者位；与 100 次事务预算并列。模板验证、启用、普通可用性、业务创建、审核通知、小时提醒和保留提醒均在写前执行相同边界。`workflowReminder` 29/29 覆盖 30 人通知失败关闭与预算内事务不超过 100 次。

## I2 审核历史显示

- RED：审核仓储新增测试复现历史参与人停用导致详情 `FORBIDDEN`、改名改写历史，以及旧轮次缺快照时的兼容缺口。
- GREEN：审核仓储 50/50。新轮次事务内固化 `processorDisplayNames`、`reviewerDisplayNames`；查询只重授权当前调用账号。旧轮次仅返回“历史处理人/历史审核人”固定占位，JSON 投影不含账号编号或 OpenID。

## I3 保留扫描

- RED：40 条坏反馈预约后的第 41 条不可达，全表 `readAll + skip`、空候选扫描和损坏游标均暴露无界/不安全边界。
- GREEN：`evidenceRetention` 最终 26/26。六类路径使用权威状态/到期条件、`_id` keyset、`system_settings/evidence-retention:*` 阶段游标；每个入口单次原始扫描和处理上限 40。覆盖反馈预约、丢失反馈对应节点锁、审计修订预约、冻结业务提醒、统一/独立保留凭证和孤立凭证；第 41 条在下一轮可达，空候选有限查询，游标损坏失败关闭，事务操作不超过 100，返回候选后崩溃会安全回绕并幂等重交付。

## I4 旧 OpenID 保留提醒

- RED：`evidenceRetention` 聚焦测试新增后，纯旧业务未生成可见受众，已有确定性编号的空受众坏记录也无法修复。
- GREEN：纯旧业务只写 `audienceRole: super_admin` 且不写 OpenID/`recipientUserIds`；重复执行幂等；已有同编号空受众记录在事务中升级。账号制空值或超预算关系失败关闭，不借旧兼容降级。`businessApi` 通知查询证明超级管理员可见。

## 最终验证

- `npm.cmd test --prefix cloudfunctions/businessApi`：490/490。
- `npm.cmd test --prefix cloudfunctions/calendarSync`：47/47。
- `npm.cmd test --prefix cloudfunctions/workflowReminder`：29/29。
- `npm.cmd test --prefix cloudfunctions/evidenceRetention`：26/26。
- `node --test miniprogram/test/*.test.js`：134/134。
- `node tools/test-wxml-structure.mjs`：4/4。
- 20 个变更/新增 JavaScript 文件 `node --check`：全部通过。
- `git diff --check`：通过，仅有换行转换提示。
- 项目记忆校验：通过。

## 未验证边界

- CloudBase 未公开数组多键索引逐字节模型；768 字节为相对 1024 字节公开上限预留至少 25% 的保守估算，尚未在真实环境创建索引和执行隔离写入。
- 新增状态/到期/`_id` 复合索引的真实选择、范围条件行为、真实云事务并发和四个云函数部署未验证。
- 微信开发者工具、真机、多账号、真实日历数据和触发器来源未验证；`evidenceRetention` 必须继续保持 `triggers: []`。
