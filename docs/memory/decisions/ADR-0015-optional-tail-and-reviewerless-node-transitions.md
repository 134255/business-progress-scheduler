# ADR-0015：可选追加节点与无审核直接完成

## Status（状态）

已于 2026-08-29 接受并完成本地实现；CloudBase 部署和真实隔离验收尚未完成。

## Context（背景）

售后最后一个必经节点通过后原本会立即完成并冻结，无法让预先指定的处理人根据现场情况决定是否继续填写一个模板化追加节点。与此同时，强制每个节点配置审核人使轻量节点也必须产生审核轮次，增加了不必要的操作和统计噪声。

追加节点仍必须属于同一售后，继承现有字段、凭证、权限、检索、分享、统计和保留边界。它不能被实现为临时自由节点，否则会绕过启用模板只读、实例快照、角色隔离、版本并发和审计约束。无审核直接完成也不能退回旧版写入口，否则新版节点会重新暴露历史兼容接口并分裂完成流转语义。

## Decision（决策）

- 模板任意节点都可显式配置空 `reviewerUserIds`。这类节点仍使用新版 `review` 工作流和当前处理轮版本，只允许处理人通过 `complete_node` 完成；字段、必填凭证、活动账号、当前节点、处理角色和乐观版本继续由服务端严格校验，且不创建 `node_review_rounds` 或 `node_review_votes`。
- 模板最多允许一个 `activationMode: optional_tail`，且必须是至少包含两个节点的模板末节点并保留至少一名可解析的处理人。售后创建事务与必经节点一起预生成该节点的稳定编号、字段、处理人、审核人和显示名快照；节点初始状态为 `awaiting_decision`，售后头的 `optionalTailState` 初始为 `none`，直到最后必经节点完成才原子进入 `pending`，因此不能提前决定、填写或上传。
- 最后必经节点无论经审核通过还是无审核直接完成，都调用共享的“已完成节点后继分类”：普通下一节点自动激活；可选尾节点进入 `pending` 决定；没有后继才真正完成售后。这样两条完成入口不会产生不同冻结、保留或统计结果。
- 待决定阶段只允许快照中的活动候选处理人操作。开启与跳过使用节点版本和事务内 CAS，首个成功决定生效；开启后不能再跳过。跳过直接完成并冻结售后，开启则从决定成功时写入 `processingStartedAt` 并计算普通处理截止。
- `decisionStartedAt` 到 `decisionAt` 是独立决定区间，不计入节点处理时长。日历缺失时保存 `pending_calendar` 和不可变边界，由 `calendarSync` 使用独立固定游标有界补算；决定提交同时开启独立的 `decisionAnalytics*` 来源，运营统计不等待节点终态，立即保存开启/跳过事件，并仅在 `calculated` 时生成决定分钟事实，避免把零分钟与缺失混淆。
- 待决定节点进入候选处理人的待办、通知和逐工作小时提醒；真正进入待决定时写入短生命周期 `decisionReminderStatus: pending`，决定成功后原子移除，使有界扫描不会被预生成但休眠的追加节点挤占。开启后转入普通处理提醒。休眠或跳过的空追加节点不进入检索或分享，已开启且完成的节点沿用当前有效快照检索和固定分享。
- 旧模板、旧售后和缺失 `activationMode` 的节点不迁移，按必经节点兼容。只有新模板版本明确留空审核人时才启用直接完成。

## Consequences（后果）

- 新版完成逻辑集中在共享分类器和受保护事务中，减少审核完成与直接完成分支漂移，但需要所有后续兼容消费者识别 `awaiting_decision`、`optionalTailState` 和直接完成反馈。
- 待决定时间、处理时间和审核时间保持独立，可正确计算追加节点启用率与平均决定工作时长，不会把跳过节点伪装成零处理分钟。
- 需要三条 `business_nodes` 组合索引：`decisionTimingStatus ASC, _id ASC`、`status ASC, activationMode ASC, decisionReminderStatus ASC, _id ASC` 和 `decisionAnalyticsSnapshotStatus ASC, _id ASC`，分别服务日历补算、待决定提醒和决定统计来源。索引创建、函数部署和隔离数据验收属于部署状态，不能由本地测试替代。
- 回滚必须先回退小程序再回退云函数；已经生成的决定、反馈、审核、凭证、通知、审计和统计事实不得删除或改写。

完整交互与状态机见 `docs/superpowers/specs/2026-08-29-optional-tail-node-design.md`，执行和验收顺序见 `docs/superpowers/plans/2026-08-29-optional-tail-node.md` 与 `qa/optional-tail-node-acceptance.md`。
