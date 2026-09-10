# Dashboard Status Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复概览页“进行中”“已完成”点击无响应，并让目标列表按卡片状态和关系范围筛选。

**Architecture:** 复用已有列表和授权检索，不新增页面或集合。路由携带可选 status 与 scope；服务端在分页前过滤并复核当前权限。无参“查看全部”的行为保持不变。

**Tech Stack:** WeChat Mini Program JavaScript/WXML/WXSS, CloudBase Node.js, node:test.

**Spec:** 用户本轮“我现在点击进行中和已完成不跳转”；权限与检索不变量见 `docs/memory/decisions/ADR-0012-authorized-after-sales-content-search.md`。

## Global Constraints

- 保留当前 dirty tree 的 iOS 上传、Mac 本机媒体选择、文档及配置改动。
- status 只接受 `active` 或 `completed`；scope 只接受可选 `mine`，不扩大查看权限。
- 首页统计保持“我关联”的范围；超管无参查看全部保持全局可见。
- 不做前端已加载页过滤。筛选参与服务端总数、分页和关键词游标摘要。
- 搜索票据原 status 为 pending/consumed；内部筛选用 businessStatus，不能覆盖生命周期。
- 不新增索引、依赖、费用、权限或客户数据；不把本地测试当作部署/真机验收。

## Task 1: 客户端导航与筛选请求

**Files:** `miniprogram/pages/dashboard/index.js`, `index.wxml`; `miniprogram/pages/business-list/index.js`, `index.wxml`, `index.wxss`; new `miniprogram/test/dashboard-status-flow.test.js`.

**Interfaces:** `listBusinessLines({ status?: 'active'|'completed', scope?: 'mine', ...existingFilters })`。

- [x] 新增实际页面测试：从卡片 WXML 读取 bindtap/data-status 调用处理器，断言路由 `'/pages/business-list/index?status=active&scope=mine'` 和 completed 对应值；无参查看全部不变。
- [x] 运行 `node --test miniprogram/test/dashboard-status-flow.test.js`，确认缺失事件和查询参数导致失败。
- [x] 绑定卡片点击，严格解析 onLoad 路由；通过 `...(status ? {status} : {})` 与 scope 透传到两种查询分支；请求签名包含筛选；显示固定安全范围文案。
- [x] 覆盖页码、关键词游标、日期、清空关键词、非法参数、账号切换与空候选页继续加载，运行上述测试和现有 business-search-flow 测试。

## Task 2: 授权列表和搜索的状态/范围合同

**Files:** `cloudfunctions/businessApi/lib/business-service.js`, `cloud-business-repository.js`, `business-search-client.js`; `cloudfunctions/businessSearch/lib/cloud-search-repository.js`, `search-service.js`; corresponding Node test files.

**Interfaces:** 对外仅上述 status/scope；内部票据 `businessStatus`/scope 为可选字段。旧无参查询和票据仍可读取。

- [x] 新增测试并运行，复现 `status: 'active'` 目前抛 `VALIDATION_ERROR`；混合状态跨页与超管 mine 测试失败。
- [x] 白名单校验与透传；列表初筛及重读后同时检查状态/成员，再计算 total/slice。
- [x] 票据序列化/消费/服务透传筛选；摘要绑定状态和 scope，两次授权候选均按权威当前记录过滤。
- [x] 验证不同筛选不能复用游标、筛选不能越权、查询中状态变化和撤权不返回旧记录；运行 `npm.cmd test --prefix cloudfunctions/businessApi` 与 `npm.cmd test --prefix cloudfunctions/businessSearch`。

## Task 3: 集成与交付

- [x] 独立只读审查合同、安全边界与回归测试；修正发现后重跑。
- [x] 运行完整客户端、两个后端、WXML 与 diff 检查。只同步本轮显式文件到根目录并再次验证。
- [x] 更新 STATUS 的实际证据及待部署边界，运行 project-memory validator。未经当前授权不提交/推送 Git。
- [x] 部署顺序：先 businessSearch，再 businessApi，再客户端；本轮如果没有实际执行，全部如实记录 `unverified`。实际体验验收需点击两张卡，并验证翻页、检索、返回及查看全部。

## Execution evidence

2026-09-09：本地开发、两阶段独立复审、两处同步和验证已完成。最终根目录客户端275、businessApi755、businessSearch47、官方渲染5、结构4项全部通过。真实云部署与设备验收未执行（unverified）；上述最后一步仅完成部署顺序及未部署边界的记录，不表示已发布。没有提交、合并或推送Git。
