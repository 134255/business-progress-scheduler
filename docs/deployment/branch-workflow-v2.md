# 分支售后流程 v2 部署与受控重置手册

## 1. 范围与硬门禁

本手册对应分支 `codex/branch-workflow-v2`，基线提交 `f651fbe`，功能提交依次为：

1. `7da107c` 条件字段领域规则；
2. `fe15c91` 通用有向无环流程校验；
3. `0d405d1` 版本化模板定义；
4. `d52b62b` 售后实例流程快照；
5. `e61b654` 原子流程转移；
6. `d0479b7` 审核通过后的路由；
7. `6a04108` 人工路由决定；
8. `5391fb7` 下游只投影实际路径；
9. `c7cd43d` 模板编辑与流程预览；
10. `5585196` 节点级联字段；
11. `e7d36c0` 售后实际路径与决定界面。

以下任一条件不满足时停止部署，不得用降低权限、关闭校验或清空真实数据绕过：

- 数据库、云存储和当前云函数配置已有可恢复备份，并实际核对备份时间、范围和恢复入口；
- 本地全量测试、WXML、语法、差异和项目记忆门禁通过；
- 目标环境、AppID、CloudBase 环境 ID 与预期环境一致；
- 控制台没有要求购买、升级套餐、扩大 CAM/数据库权限或提交真实敏感数据；出现这些情况必须重新取得项目所有者明确批准；
- 破坏性重置尚未获“精确对象、精确集合、精确数量”二次批准时，只允许执行本手册的部署、隔离验收和只读清单阶段。

本版本不提供任何自动删除程序。`tools/branch-workflow-reset-dry-run.mjs` 只有查询能力，不含数据库写入或 COS 删除 API。

## 2. 部署前记录

### 小程序上传来源核对

2026-09-07 新版实现与模板编辑修复已快进合并到本地 `main`（代码提交 `c7e75fc`）。后续体验版统一从仓库根目录打开项目，不能依据窗口中文名称或版本号推断源码版本；上传前核对实际项目目录、分支、提交和待发布修改。若临时使用功能工作树，必须明确记录该目录及提交，不得混用仍停留在旧代码的根目录。

上传说明附上源码提交短号。开发者工具“代码上传成功”只证明小程序包上传完成；只有事先明确提示将覆盖现有体验版或在公众平台核对体验版指向后，才记为体验版更新成功。手机退出重进后的验收单独记录，不等同于自动化测试通过。节点名称及条件选项输入修复仅涉及前端，无需因此重复部署云函数。

记录但不要写入 Git：环境 ID、AppID、各云函数当前版本/运行时/内存/超时/触发器、数据库索引状态、集合权限、COS 地域与桶、体验版版本号。密钥、Token、OpenID、客户正文和原始日志不得进入命令参数、截图、项目记忆或 Git。

确认工作树不包含操作员本地文件：

```powershell
git status --short
git log --oneline f651fbe..HEAD
git diff --check f651fbe..HEAD
```

## 3. 数据库索引

先保留所有现有索引，只新增或核对以下非唯一组合索引；不得改变集合读写权限：

| 集合 | 字段顺序 | 用途 |
|---|---|---|
| `business_nodes` | `manualDecisionProcessorUserIds ASC`, `status ASC`, `updatedAt DESC` | 活动账号“待我处理”中的人工路由决定 |
| `business_nodes` | `status ASC`, `routeState ASC`, `decisionReminderStatus ASC`, `_id ASC` | 通用人工路由待决定提醒有界扫描 |

索引必须显示已生效后再继续。若 CloudBase 对数组字段的索引类型或排序方向给出不同要求，停止并保存无敏感错误信息，不得改成全表无界扫描。

## 4. 代码部署顺序

保持原环境变量、内存、超时、密钥、集合权限和触发器不变；不要点击“上传并覆盖触发器”。按以下顺序从同一已验证提交部署：

1. `businessApi`；
2. `businessSearch`；
3. `workflowReminder`；
4. `calendarSync`；
5. `operationsAnalytics`；
6. `evidenceRetention`；
7. 上传小程序体验版。

`nodeTextParser` 本功能没有代码变更，不需要重复部署。所有定时函数沿用部署前触发器；本手册不授权新增、删除或修改 Timer。部署后逐个核对版本时间、入口、运行时及触发器，没有对应代码变化的配置不得改变。

### ZIP 打包及启动门禁

控制台“部署成功”只代表上传/部署完成，不代表函数能启动。Windows 本地解压后的目录也不能证明原 ZIP 的路径可在 Linux 运行时解析。

- ZIP 根目录必须直接包含 `index.js`、`package.json`、`package-lock.json`，不得再套一层函数目录；完整保留 `lib/`，尤其是 `lib/domain.js`，并按大小写检查所有相对依赖。
- ZIP 条目使用 `/` 路径，拒绝 `\`、绝对路径和 `..` 路径段；不得包含密钥、`.env` 或操作员本地配置。
- 对已验证且已提交的版本，可在功能工作树执行下列命令生成可重复的标准包；`git archive` **不包含未提交修改**，必须先核对 HEAD 与待部署版本一致。输出保留在本地，不加入 Git。

```powershell
New-Item -ItemType Directory -Force outputs/diagnostics
git archive --format=zip --output=outputs/diagnostics/businessApi-verified.zip HEAD:cloudfunctions/businessApi
```

- 上传前检查 ZIP 条目清单及与该提交的文件一致性；未打包 `node_modules` 时选择云端安装依赖，不选择“部署且不安装依赖”。
- 部署后确认新部署时间、在线文件树的 `lib/` 与入口，再以 `{"action":"getSession"}` 做只读启动检查。控制台无可信微信上下文时，应用返回 `INVALID_WECHAT_IDENTITY` 是预期的安全拒绝，只能证明启动和身份边界，不能标记账号登录验收通过；`Cannot find module`、超时或其他初始化异常均阻断交付。
- 最后使用正确工作树的小程序验证真实微信会话和页面加载，不输入伪造身份、不降低校验、不重置账号来绕过问题。此步骤与真机验收分别记录。

## 5. 隔离验收矩阵

模板节点编辑页变更后，在安装微信开发者工具的受信任机器上运行实际 WXML 渲染回归；`WECHAT_WCC_PATH` 指向该安装目录内的官方 `wcc.exe`（或对应系统可执行文件），不要从非官方来源下载编译器。此脚本还需要支持 `import.meta.dirname` 的 Node.js 版本（20.11+）。

```powershell
$env:WECHAT_WCC_PATH = '<微信开发者工具安装目录>/resources/app.asar.unpacked/node_modules/wcc-exec/wcc.exe'
node tools/test-template-node-rendering.mjs
```

必须通过新版/旧版 × 可编辑/只读的名称实际渲染与绑定检查、各版本路由控件隔离检查，以及条件选项逐字输入后实际渲染值与字段/父选项绑定检查；未安装编译器时记录该项为 `unverified`，不能用 WXML 文本包含输入框替代实际渲染验证。前端修复还需重新上传体验包；仅重新部署云函数不会更新手机页面。

只使用无敏感隔离模板、隔离账号和测试凭证。不要先重置旧数据。

| 场景 | 开发者工具 | iPhone | Android/HarmonyOS | Mac 微信 |
|---|---:|---:|---:|---:|
| 新版/旧版节点名称均显示；可编辑草稿可输入并保存，已启用模板保持只读 | 必测 | 必测 | 必测 | 抽测 |
| 条件候选项可逐字输入中文/英文、输入逗号、删除和粘贴；未知/未完成选项保存时提示且原文保留 | 必测 | 必测 | 必测 | 抽测 |
| 多级单选联动：父选项改变子选项/字段，取消清空则原值保留，确认后只清空后代 | 必测 | 必测 | 必测 | 必测 |
| 单选路由嵌套：分支后仍可再次分支，命中唯一目标或结束 | 必测 | 必测 | 必测 | 抽测 |
| 人工路由：授权目标处理人可开启/跳过，重复点击幂等，无关账号拒绝 | 必测 | 必测 | 必测 | 抽测 |
| 汇合：不同上游到同一后继时只激活一次 | 必测 | 抽测 | 必测 | 抽测 |
| 售后发起人作为节点处理人，可与其他候选共存 | 必测 | 必测 | 抽测 | 抽测 |
| 审核人留空：节点直接完成并按同一路由规则推进 | 必测 | 必测 | 必测 | 抽测 |
| 同节点处理人/审核人重叠：创建或保存失败关闭且无半成品 | 必测 | 抽测 | 抽测 | 抽测 |
| 详情只显示实际路径；活动 v2 不显示百分比，终态显示 100% | 必测 | 必测 | 必测 | 必测 |
| 休眠/跳过节点不进入待办、提醒、检索、公开分享、日历补算和运营统计 | 必测 | 抽测 | 抽测 | 抽测 |
| 120 MiB 合计边界：合法媒体/文档、慢速跨凭据续传、失败后草稿不丢 | 必测 | 必测 | 必测 | 必测 |

每项记录“通过/失败/未测”、客户端版本和无敏感复现步骤。任何路径错误、重复激活、旧版本被接受、越权决定、隐藏字段注入、休眠节点泄漏或凭证误删均阻断发布。

## 6. 只读重置清单

隔离验收通过后，在可信的只读运维环境设置以下环境变量；不要把值写入 PowerShell 历史、Git 或截图：

- `BRANCH_RESET_ENV_ID`：目标 CloudBase 环境 ID；
- `EVIDENCE_CLOUD_FILE_PREFIX`：精确的 `cloud://<environment>` 前缀，不带末尾斜杠；
- `BRANCH_RESET_WX_SERVER_SDK_PATH`：可选，仅在默认 `businessApi/node_modules/wx-server-sdk` 不可用时指向可信 SDK。
- `BRANCH_RESET_OBJECT_LIMIT`：可选，输出对象键上限，默认 100、最大 100000；若 `truncated=true`，按实际数量调高后重新运行，仍截断则停止。

执行：

```powershell
node tools/branch-workflow-reset-dry-run.mjs
```

输出仅应包含集合计数、有限内部 ID 样本、严格由有效节点凭证记录推导的 `evidence-uploads/<businessLineId>/<nodeId>/<evidenceId>.<ext>` COS 对象键、严格由合法审计修订凭证推导的当前环境 `cloud://<environment>/amendment/<businessLineId>/...` 文件 ID，以及各自总声明字节数。若出现 `invalidEvidenceCount > 0`、任一清单截断、跨环境路径、其他旧路径或数量与备份不符，停止，不得删除。

计划整集合清理目标仅为：

```text
templates, template_nodes, business_lines, business_nodes, node_feedback,
node_review_rounds, node_review_votes, evidences, notifications,
public_node_shares, public_node_share_chunks, business_search_requests,
business_search_documents, operations_analytics_facts,
operations_analytics_daily, node_text_parse_requests
```

`system_settings` 不能整集合清空，只允许在二次批准后删除清单工具列出的、与派生任务对应的固定游标文档。

以下数据必须保留：`users`、`user_credentials`、`wechat_bindings`、`sequence_counters`、`audit_logs`、除精确派生游标外的 `system_settings`、`node_text_parse_usage`、`work_calendar_years`、`work_calendar_entries`、`calendar_sync_requests`。保留 `node_text_parse_usage` 是为了防止通过重置规避每日额度。

## 7. 破坏性重置的二次批准

只读清单完成后向项目所有者展示：备份时间和恢复验证、目标环境、每个集合精确数量、COS 精确对象数量与总字节、CloudBase 修订文件精确数量与总字节、无效/截断项、预计费用或免费额度影响。必须取得针对该清单的重新明确批准，才可另行编写或执行删除操作；此前不得以本手册或早先的概括性确认代替。

获批后仍需先进入维护窗口，暂停新建/处理/审核/分享入口，并暂停会产生新派生数据的 Timer。删除顺序建议为：先分别删除清单内精确 COS 对象和 CloudBase 修订文件并逐项确认，再清公开分享/通知/派生检索与统计，随后清审核票据/轮次/反馈/凭证元数据，最后清售后节点、售后线、模板节点和模板，再删除精确派生游标。任何失败都停止，不继续扩大范围。

## 8. 重置后核对与回滚

重置后必须验证：

- 原活动账号仍可登录，账号、凭据、微信绑定、审计、日历和系统安全配置均存在；
- 模板、售后和批准范围内的派生集合为 0；
- 清单内 COS 对象与 CloudBase 修订文件均不存在，清单外对象未受影响；
- 编号计数器、文本解析每日用量没有回退；
- 可创建一条全新 v2 隔离模板与售后并走完嵌套分支；
- 待办、检索、分享、统计只出现新实际路径数据。

代码异常但数据尚未重置时，回滚云函数和小程序到部署前版本。数据已经重置后，不允许只回滚代码；必须进入维护状态并按已验证备份执行完整数据恢复。任何恢复费用、权限变化或真实敏感数据处理仍需单独批准。
