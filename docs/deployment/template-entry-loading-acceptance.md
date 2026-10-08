# 新建售后入口加载优化：本地验收

## 2026-10-08 发布与上传验收

用户授权上传和 GitHub 交付，并确认上一版本仍为 1.2.8、本次使用 1.2.9。本节覆盖下方发布前的“未发布/未上传”状态。

- 官方开发者工具登录重新扫码恢复后，下载发布前 `businessApi`；6498 文件的清单摘要与上次核验版本完全一致：`9b23b2ca785dc9bbe71ffbd3164be35b62a76e7e02a7ed91dfd844d566ffbcb7`。
- 独立后端载荷保留线上全部依赖及包配置，只替换下方 4 个后端文件；6498 文件、9.0 MB。官方 `cloud functions inc-deploy --file .` 明确成功，未更改环境变量、权限、资源、Timer、模板或业务数据。
- 发布后重新下载，6498/6498 SHA256 一致、0 差异，清单摘要 `5032d0cff885c8d60dfea4e584038d0b5d9b489fac60e19c90eb762bdf832ff1`。未把工作区待发布的导出范围隔离仓储混入。
- 独立小程序上传目录为 HEAD 的小程序及项目配置加 3 个客户端产品改动，共178文件，清单摘要 `f6ff0151169c1ce6e6c71cc9b5fa8cba3707954e51b3ffdf485f5700fdd57adf`；测试源码保留上传基线内容，更新后的测试在单独 QA 树执行，不进入上传包。官方 CLI 上传 **1.2.9** 返回 `√ upload`、exit0，包大小1397411字节。未设为体验版、提交微信审核或发布正式版。
- 精确载荷 QA 新鲜回归：businessApi1445、客户端652、businessSearch119、nodeTextParser38、calendarSync61、workflowReminder39、evidenceRetention43、operationsAnalytics66、基线容量工具136、WXML结构4及官方渲染10/6/8，合计2627项通过、0失败/取消/跳过。容量136而非前次192，是有意排除其他未发布导出规则的56项测试。

补充回归首次 operationsAnalytics 为65/66：QA混用Git导出的工作器及云端API文件，四个共享域文件行尾不同。先逐一验证规范化文本完全相同，再仅在QA目录用现有同步工具统一字节，重跑66/66；未修改工作区、发布载荷或线上工作器，也未弱化测试。官方WXML编译检查通过，但不等同五端原生体验验收。

发布备份、验证包及上传回执保留在本机 `outputs/deploy/template-entry-20261008/` 与 `outputs/deploy/miniprogram-1.2.9-20261008-template-entry-info.json`，不进入Git。旧临时发布目录仅残留空目录，未把其当作新鲜基线；本轮使用重新下载且哈希匹配的线上代码。Git提交只纳入本批产品、测试、文档和共享记忆中的本批增量，排除先前未提交的导出内容。生产业务耗时和五端真机验收仍为unverified；下一步将1.2.9设为体验版后验证模板选择、回退、最新可用性、联动及真实打开耗时。

## 发布前实现记录

日期：2026-10-08。对照基线：`e3a7e94338961f03ce1f9784b08ac0dbad70904b`。

## 批准范围与边界

用户确认慢点是点击“新建售后线”之后的模板列表/填写页打开，并批准在保留现有功能的前提下局部优化。当前只完成本地实现、测试与复核，未发布云函数、上传小程序或提交/推送 Git。

- 首页直接打开原模板列表，省去无模板编号的填写页中转；旧的填写页无编号入口仍保留重定向。
- 填写页通过原 `listEnabledTemplates` action 传入可选 `templateId`，只重新读取所选启用模板。列表页仍获取全部启用模板。
- 参与账号读取复用现有 `boundedMap`，上限为 4；去重、排序、活动状态过滤和读取失败时拒绝返回的规则保留。事务内参与账号校验不改。
- 同一次请求内准备并复用模板规范化结果；不建立跨请求/跨账号缓存，不省略 V2 流程、定义摘要、严格联动、角色及创建快照预算检查。

不改创建提交事务、幂等键、表单字段、模板配置、权限、审批、凭证、导出、定时器、依赖或云资源。目录中原有的导出范围隔离改动继续保留，但不属于本批发布载荷。

## 精确产品载荷

后端 4 个文件：

- `cloudfunctions/businessApi/index.js`
- `cloudfunctions/businessApi/lib/cloud-template-repository.js`
- `cloudfunctions/businessApi/lib/template-domain.js`
- `cloudfunctions/businessApi/lib/template-service.js`

客户端 3 个文件：

- `miniprogram/pages/dashboard/index.js`
- `miniprogram/pages/business-edit/index.js`
- `miniprogram/services/templates.js`

基线差异共 46 行新增、17 行删除；未修改 WXML/WXSS 或页面配置。部署必须重新核对这 7 个文件的准确内容及云端基线，不能直接把当前脏目录作为已获批准的整包发布载荷。

## 回归证据

新增 `cloudfunctions/businessApi/test/template-entry-loading.test.js`，并扩展原账号路由、模板流程测试及测试仓储。实现前已观察定向读取、参数校验、并发上限、规范化复用、入口导航等预期失败；修复后通过。

核心覆盖：旧调用不传编号的结果/顺序保持；新旧客户端与后端兼容；无效编号先于数据库读取拒绝；停用、删除、缺失模板不进入填写；进入填写前重新验证参与账号；切换账号后丢弃旧响应；同一请求不因某个账号读取失败而返回部分可用结果；模板定义损坏仍拒绝。旧版及 V2 的 10 节点、2545 条严格联动合成模板都通过，账号变更和定义摘要损坏均有反例。

本轮完整执行，全部 exit 0、0 失败/取消/跳过，共 2659 项（不重复计入定向测试）：

| 命令 | 通过项数 |
| --- | ---: |
| `npm.cmd test --prefix cloudfunctions/businessApi` | 1445 |
| `node --test miniprogram/test/*.test.js` | 652 |
| `npm.cmd test --prefix cloudfunctions/businessSearch` | 119 |
| `npm.cmd test --prefix cloudfunctions/nodeTextParser` | 38 |
| `npm.cmd test --prefix cloudfunctions/calendarSync` | 61 |
| `npm.cmd test --prefix cloudfunctions/workflowReminder` | 39 |
| `npm.cmd test --prefix cloudfunctions/evidenceRetention` | 43 |
| `npm.cmd test --prefix cloudfunctions/operationsAnalytics` | 66 |
| `node --test tools/capacity/test/*.test.cjs` | 192 |
| `node tools/test-wxml-structure.mjs` | 4 |

最终 `git -c core.safecrlf=false diff --check` 和项目记忆 validator 通过；暂存区为空。

## 只读合成对照

以内存数据库构造 2 个启用模板（每个 10 节点、20 个不同参与账号）及 3 个停用模板，对比“列表读取 → 所选模板预览”。旧仓储/服务从上述 HEAD 读取并在内存加载；当前版本使用同一夹具。所选模板安全投影保持相同、列表仍有两个模板，两组写入均为 0。

| 指标 | 基线 | 本批 |
| --- | ---: | ---: |
| 查询次数 | 6 | 4 |
| 固定文档读取次数 | 80 | 61 |
| 合计逻辑读取 | 86 | 65 |
| 返回文档数 | 130 | 96 |
| 参与账号读取次数 | 80 | 60 |
| 最大并发参与账号读取 | 1 | 4 |

这些是合成逻辑操作数，不是生产延迟、计费量或容量承诺；仅一个启用模板时，定向读取不保证降低操作数。解析复用也不代表所有层级只解析一次：仓储摘要校验与 V2 流程校验仍保留。对照运行未创建文件或接触云端业务记录；最初 Node 子进程调用 Git 被沙箱拒绝，改由只读 PowerShell `git show` 输入内存后成功完成。

## 独立复核与未验证项

一次独立只读差异复核未发现 Critical/Important/Minor 问题，结论为批准本批范围。复核者另执行 110 项定向测试及 35 场景、700 次内存 HEAD 行为对照，未发现差异；不计入上述 2659 项。

保留现有预览的非事务语义：本批没有承诺整个预览读取期间的账号/模板原子快照；真正创建时的事务重验保持不变。复核不覆盖无关导出改动或未修改模块的全面安全审计。

真实 CloudBase 网络延迟、SDK 并发实际表现，以及 Android/HarmonyOS/iOS/macOS/Windows 原生导航和渲染均为 **unverified**。本轮仅执行 WXML 结构测试，未重新运行官方 WXML 编译器或真机测试。当前没有生产“打开快了多少”的结论。

下一步若获发布授权：核对云端与本地准确载荷，分别发布 `businessApi`、上传新版小程序；在体验版核对模板选择、返回/重进、最新停用状态、填写内容、联动、账号切换及真实打开耗时。发现实际功能影响须先停下并取得用户批准，不以自动回归代替五端验收。
