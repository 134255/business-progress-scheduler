# 可选追加节点与无审核节点隔离验收

## 1. 安全前提

- 只使用测试账号、隔离模板、隔离售后和无敏感测试凭证；不得改动真实售后。
- 部署前导出并核对可恢复备份：`templates`、`template_nodes`、`business_lines`、`business_nodes`、`node_feedback`、`node_review_rounds`、`node_review_votes`、`notifications`、`audit_logs`、`operations_analytics_facts`、`operations_analytics_daily`。
- 不记录账号编号、OpenID、正文、评论、文件名、云路径、密钥或访问令牌；只记录脱敏计数、状态和时间。
- 保留所有现有环境变量。不得新增付费资源、调整套餐、扩大公网权限或改变数据权限。

## 2. 索引与部署顺序

1. 创建或核对以下非唯一组合索引并等待生效：
   - `business_nodes(status ASC, activationMode ASC, decisionReminderStatus ASC, _id ASC)`；
   - `business_nodes(decisionTimingStatus ASC, _id ASC)`；
   - `business_nodes(processingTimingStatus ASC, _id ASC)`；
   - `evidences(feedbackId ASC, _id ASC)`。
2. 记录当前云函数版本和触发器配置；不得清空或改写正式 Timer。
3. 依次部署 `businessApi`、`workflowReminder`、`businessSearch`、`calendarSync`、`operationsAnalytics`，每次部署后核对入口、运行时、超时、环境变量和原触发器保持不变。
4. 重新编译小程序，检查零 WXML 结构错误后上传开发版本。

## 3. 隔离模板

建立并启用三个模板：

1. 两个必经节点，第一节点不设审核人，第二节点保留正常审核；
2. 一个必经节点加一个“处理人决定是否开启”的可选末尾节点，可选节点不设审核人；
3. 同上，但可选节点配置审核人，用于驳回、返工、再审核。

共同核对：只有最后一个节点可以设为可选；模板至少保留一个必经节点；处理人必填；审核人可以为空；启用后配置只读；创建售后后保存的是不可变账号和字段快照。

## 4. 验收矩阵

| 场景 | 操作 | 通过标准 |
|---|---|---|
| 必经无审核节点 | 处理人完成第一节点 | 直接完成且只生成一条已发布反馈，不生成审核轮次/投票；下一必经节点立即开始 |
| 跳过追加节点 | 前一节点完成后由决定人选择“不需要开启” | 追加节点为 `skipped`，售后终态完成；不产生处理、审核、检索或分享内容 |
| 开启并直接完成 | 选择开启无审核追加节点，填写字段并完成 | 追加节点进入处理中后直接完成；售后此时才冻结；最终反馈和关联凭证完整 |
| 开启并审核 | 选择开启有审核人的追加节点，提交、驳回、返工、再提交并通过 | 所有轮次和投票保留，最后通过后售后冻结且追加节点完成 |
| 决定提醒去重 | 在同一工作小时重复运行可信 Reminder Timer | 首次仅创建一条 `optional_tail_decision_reminder`，重复执行 `decisionCreated=0` |
| 日历补算 | 在缺少日历时作决定或直接完成，随后恢复日历同步 | 对应节点保持 `pending_calendar`，补算只更新相同节点和版本并变为 `calculated` |
| 检索 | 以有权成员搜索追加节点最终字段，再以无关账号搜索 | 有权成员可命中已完成有效快照；跳过节点、旧修订和无权售后不命中 |
| 分享 | 对直接完成追加节点生成固定分享并打开 | 字段、说明和按 `feedbackEvidenceOrder` 排序的全部凭证均存在；永久路径与内部身份不泄漏 |
| 运营统计 | 运行既有统计 Timer 并打开看板 | 决定时长、启用次数、跳过次数、启用率和直接完成处理时长均有样本；跳过节点不计处理/审核时长 |
| 保留期 | 完成与跳过两种路径后核对期限 | 只有真正终态完成设置一次 `retentionStartedAt` 和约 60 自然日后的 `purgeDueAt` |
| 幂等与并发 | 同请求重试，并以两个决定人并发选择相反结果 | 同请求只生效一次；并发只有一个决定成功，另一方得到受控冲突；不产生半成品 |
| 撤权 | 停用账号或移除处理/审核关系后重开页面和重试 | 所有写入、分享和明细下钻在服务端重新鉴权并拒绝 |

## 5. 数据核对

- 跳过节点：`status=skipped`，有决定时间与决定工时状态，无 `latestFeedbackId`、活动审核轮次和凭证关联。
- 直接完成：`status=completed`、`reviewerUserIds=[]`、`lastReviewRoundId=null`；最新反馈为 `action=complete_node`、`publishState=published`，其 `evidenceCount` 等于 `evidences` 中同 `feedbackId` 且 `attachmentState=attached` 的数量，顺序从 0 连续。
- 有审核完成：最终轮次 `status=approved`、`finalDecision=approved`，一人一票唯一约束不变。
- 售后冻结：仅最终路径写入一次完成、保留和统计待生成字段；先前节点完成或等待决定时不得提前冻结。
- 日志与通知不得包含业务正文、评论、账号编号、文件名或云路径。

## 6. 回滚

1. 停用新模板，禁止继续创建新形态售后。
2. 先回退小程序开发版本，再依次回退 `businessApi`、`workflowReminder`、`businessSearch`、`calendarSync`、`operationsAnalytics`。
3. 保留新增记录、审核轮次、通知、审计和索引，不删除或全量覆盖集合。
4. 若仅客户端失败，先保留函数版本并回退客户端；若索引或函数持续失败，保持原正式 Timer 配置并按部署前版本逐项恢复。
