# 2026-09-18 测试数据清理清单

状态：用户再次完整明确授权包括PDF、无需备份后，本轮已执行删除。30个云存储附件和2903条数据库记录已删除，目标集合及保留数量已核验；原统计Timer已恢复，重新加载控制台后函数状态为正常。

环境：`cloud1-d5gxt99rh492670d9`。用户最新要求保留模板和账号，清除测试售后及关联数据；图片、视频及3个PDF均已确认不备份并永久删除。

## 数据库范围

只删除指定集合中的测试记录，保留集合本身、索引、权限；混合用途集合只按下述精确筛选处理。

| 集合 | 待清记录数 | 范围 |
| --- | ---: | --- |
| business_lines | 34 | 当前测试售后 |
| business_nodes | 115 | 测试售后节点 |
| node_feedback | 35 | 测试反馈及预约 |
| node_review_rounds | 28 | 测试审核轮次 |
| node_review_votes | 25 | 测试审核投票 |
| evidences | 38 | 测试凭证元数据及上传预约 |
| notifications | 72 | 测试通知 |
| public_node_shares | 11 | 测试固定分享 |
| public_node_share_chunks | 11 | 测试分享分块 |
| business_search_requests | 132 | 测试检索请求 |
| business_search_documents | 2021 | 测试检索投影 |
| operations_analytics_facts | 109 | 测试运营事实 |
| operations_analytics_daily | 93 | 测试运营日汇总 |
| operations_field_snapshots | 24 | 测试字段统计 |
| node_text_parse_requests | 1 | 测试文本解析请求 |
| audit_logs | 144 | 仅业务审计，见下述筛选 |
| system_settings | 10 | 仅派生游标白名单，见下述筛选 |
| 合计 | 2903 | 其中前15集合2749条 |

`audit_logs`当前总数290，待清理仅为`targetType`完全匹配`business_line`、`business_node`、`node_review_round`、`public_node_share`的144条；其他146条全部保留，不清空审计集合。

`system_settings`当前总数11，仅下述完整匹配正则白名单中的现存10条派生游标在拟清理范围；其余系统配置保留：

```text
^(business-search-(backfill|recovery|cleanup)-cursor|operations-(analytics-(node|decision|business|refresh)|field-snapshot)-cursor|workflow-reminder-(processing|review|optional-tail-decision)-cursor|calendar-(review-(processing|carryover|timing-carryover|vote-response)|optional-tail-decision|direct-processing-completion)-cursor|evidence-retention:(reminders|due-evidence|orphans|feedback-reservations|amendment-reservations))$
```

## 云存储范围

只读逐目录枚举已完成，30个唯一对象，枚举待办目录为0。仅限上述环境关联存储桶内以下三个前缀，不清空存储桶。

| 前缀 | 对象数 |
| --- | ---: |
| amendment/ | 1 |
| evidence-uploads/ | 11 |
| evidence/ | 18 |
| 合计 | 30 |

类型：JPG 12、PNG 3（图片合计15），MP4 12（视频合计12），PDF 3。前轮COS目录统计合计约99.83MB，本轮按可见目录逐项核对对象及类型，没有重新计算精确总字节。38条凭证元数据不能当作38个存储对象；对象枚举与元数据数量分别记录，不推断差额原因。

图片、视频及PDF遵照用户明确确认不再备份。未确认回收站/版本恢复能力，应按永久不可恢复处理。具体对象键仅保留在操作会话内，不将客户或账号标识写入Git。

## 必须保留

- `templates` 7条及`template_nodes` 27条，含字段、路由、品牌/型号/SKU映射、卡片配置。
- `users` 10条，以及全部`user_credentials`、`wechat_bindings`、`auth_challenges`等账号资料。
- 系统安全配置、编号计数器、日历及同步资料、文本解析每日额度。
- 账号、模板及其他非上述四类业务对象的审计记录。
- 云端`deployment-backup-20260904-pre-branch-v2/`旧部署备份目录。
- 本机Downloads中已保存的数据库备份与既有其他本机文件。
- 现有云函数代码、集合/索引/权限和原定时任务配置；如清理期间需暂停派生定时任务，仅在获准后记录原配置、短时暂停并按原样恢复，不长期更改。

## 执行门禁

1. 对上述范围取得当次永久删除确认，明确PDF的处理及附件不备份后不可恢复的风险。此前针对备份或发布的授权不能替代。
2. 清理期间停止新建/修改/审核/分享/上传；如需临时暂停相关Timer，先核对并记录原配置，在获准范围内执行，结束后恢复。
3. 执行前重新核对数量与目标；出现新增、范围不符或不明确对象时停止，不扩大删除范围。必要时更新已授权数据库备份。当前17份本地备份是不同时间点快照，不冒充一致性恢复演练。
4. 获准后先删除精确附件清单，再清分享/通知/检索/统计、审核/反馈/凭证、售后节点/售后及精确游标；模板与账号不在删除序列中。
5. 每批核对结果，失败时停止；最后复查待清集合/范围为空，保留对象数量及配置不变，记录剩余事项。不要为了验收擅自创建新的测试售后。

## 临时维护记录

2026-09-18：用户确认本清单范围，并允许必要时短时暂停相关Timer后恢复。下面记录的是现场读取的原始触发器配置，恢复时不得修改表达式或名称。

| 函数 | 原触发器名称 | 类型 | 原表达式 | 当前维护状态 |
| --- | --- | --- | --- | --- |
| operationsAnalytics | operations-analytics-every-15-min | timer | `0 */15 * * * * *` | 曾暂停；拦截后已原样恢复并在控制台核验 |

其余6函数详情页显示无定时触发器，未修改。本次删除前附件重扫与清单完全一致：30唯一对象、新增0、缺失0。最终批量删除被安全审核阻止，未执行；未进行数据库删除，也未尝试替代路径绕过。恢复配置JSON保存于同目录operations-analytics-timer-restore-2026-09-18.json，不包含凭据。控制台编辑器失败的中间内容未保存，最终经官方本地配置导入并校验JSON与原配置一致，保存后的页面显示原名称和表达式。

## 最终清理执行（追加授权后的本轮）

- 用户明确要求除模板和账号外清理业务产生的数据，包括PDF，且无需再备份；本轮未新增数据或附件备份。
- 云存储仅选中amendment/、evidence-uploads/、evidence/，未选择旧部署备份；永久删除确认成功后，根目录仅剩deployment-backup-20260904-pre-branch-v2/。对应已逐项核对的30个对象：15张图片、12个视频、3个PDF；无附件备份，按不可恢复处理。
- 数据库按本清单逐集合核对原计数并通过文档批量删除。2021条检索投影分为20批100条及末批21条；每批核对剩余数。只删除记录，未删除集合、索引或权限。
- 15个完整清理集合最终逐项核验均为0，共2749条；业务审计精确筛选144条已删除，未筛选总数剩146；派生游标精确白名单10条已删除，system_settings总数剩1。合计删除2903条。
- 保留数量现场复查：templates 7、template_nodes 27、users 10。账号凭据、绑定等集合未进入删除操作，系统安全/编号/日历/额度配置保持，未删除本地既有备份。
- 本轮在数据库删除前临时暂停operationsAnalytics，结束后导入原JSON并逐项比对，通过后保存。控制台一度显示函数更新中，重新加载后的最终状态为正常且可编辑，原触发器operations-analytics-every-15-min及表达式`0 */15 * * * * *`保持一致。未修改其他云函数、环境变量、权限或源码。
- 清理后未创建新的测试售后；运行新业务的端到端验收与完整恢复演练未执行。
