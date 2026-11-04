# 详情及待办页在途读取合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只合并三个目标页面同代的相同在途读取，不复用已完成响应、不减少权威刷新。

**Architecture:** 页面实例各自持有请求记录，绑定账号对象、编号、角色、目标和请求序号；记录在调用服务前安装，完成时仅按记录身份释放。每次显示及详情写操作后的刷新强制新代际，原服务接口和分页保持不变。

**Tech Stack:** 原生小程序JavaScript，Node.js内置test/assert/vm，无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-04-task-page-request-coalescing-design.md`

## Global Constraints

- 仅改三个指定页面和相关测试/文档，不改云函数、权限、业务写入、站内通知或企微180工作分钟规则。
- 每次onShow新请求；隐藏、卸载、账号失效、清空状态使旧请求失效；不跨页面/账号/角色/会话/目标合并。
- 写操作成功或VERSION_CONFLICT后的详情刷新必须新读；第一页与分页不混合，不增加自动重试、TTL或持久缓存。
- 用户已批准当前main工作区顺序实现、保留并提交部署；全部既有dirty保留，提交只包含准确任务路径/记忆增量，GitHub先只读核对。
- 发布候选必须与上次上传包对照，仅三个运行文件变化；未确认上传结果不重试，不能把上传当正式发布。

## Review Focus

- 写操作完成时旧详情请求未结束：写后刷新仍发新请求，旧结果不得覆盖。
- 连续onShow没有onHide：每次均有新的权威读取，迟到拒绝不得清空新状态。
- 旧finally晚于新请求启动：不能释放新记录或关掉新加载状态。
- 注销后恢复同一个账号对象及同步服务抛错：旧记录不能复活或永久占位。
- 加载更多与第一页刷新交错：分页游标/顺序/去重不变，旧分页不能追加到新首屏。

## Task 1: 三页合并与竞争回归

**Files:** Modify `miniprogram/pages/business-detail/index.js`, `miniprogram/pages/pending-processing/index.js`, `miniprogram/pages/review-list/index.js`; Create `miniprogram/test/task-page-request-coalescing.test.js`.

**Interfaces:** 保留loadDetail()/refresh()/loadMore()/retryCards()；详情新增reloadDetail()作为强制新读的内部入口；请求执行从入口分离为页面私有fetch方法，不增加对外服务参数。

- [x] 保存三个准确前像及当前Git状态，完整客户端基线必须757/757通过。
- [x] 先写真实页面模块测试：每页三个同代读取只发一笔；成功/失败后再次读取各新增一笔；覆盖Review Focus五种竞争及不同目标/页面/身份、隐藏和同步抛错。
- [x] 运行新增测试观察RED：原版重叠读取仍发多笔，缺少生命周期失效时迟到响应仍能进入；不是测试夹具错误。
- [x] 按原首页模式安装页面私有请求记录；onShow清记录后新读，hide/unload/clear递增序号；详情所有原写后/冲突刷新调用reloadDetail()。
- [x] 运行新增及原页面/首页回归GREEN，再跑完整客户端、API全套、WXML、语法、diff和记忆校验；失败逐项记录，不以定向通过代替全套。
- [x] 在冻结前像上执行同一新增测试作对照，按页记录3→1服务调用；不以此计算实际整月账单降幅。

## Task 2: 独立复核、准确提交与客户端上传

**Files:** Create `docs/deployment/task-page-request-coalescing-acceptance.md`; Update本设计/计划、`docs/memory/STATUS.md`及稳定架构必要增量；忽略的QA/部署证据位于`outputs/qa/task-page-coalescing-20261104/`、`outputs/deploy/task-page-client-20261104/`。

**Interfaces:** 消费Task 1的三页代码、完整测试及前像；输出单次任务提交、准确客户端manifest和独立上传回执；正式平台状态单独标明。

- [x] 一次新上下文只读审查三个页面、测试及设计，重点检查五种竞争；重要问题TDD修复，不夹带旁支优化。
- [x] 与上次已上传客户端逐文件比较，预期150个运行文件且仅三页变化；冻结候选并重验所有字节，不包括测试、云函数或其他dirty。
- [x] 核对staged准确路径及敏感内容，只提交任务变化；预有记忆文件采用仅当前增量的index补丁，不提交历史dirty。
- [x] 只读检查GitHub分支最新提交及本地差异；未授权推送不擅自push，不将本地提交称远端更新。
- [ ] 官方开发者工具上传新版本2026.11.04并保存回执；CLI单次尝试在初始化失败，无上传回执。GUI已接到准确项目，停在覆盖体验版确认前，须用户确认，不擅自覆盖或重试不明结果。
- [x] 更新本轮验收、状态与计划，复验diff/记忆；报告尚未上传/正式发布、GitHub真实同步状态及未做的真机/实际费用验收。Task 2整体仍待覆盖确认及上传回执，不标记已完成。

## 执行说明

用户已明确要求按已确认设计在当前工作区实施并提交部署，沿用本会话原生顺序执行与末尾一次独立复核，不追加实施方式问答。Windows下若Bash记账脚本会写错路径或夹带脏文件，使用apply_patch记录同一任务账本并写明适配，不借此省略TDD/复核/精确提交。
