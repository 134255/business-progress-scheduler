# 上传进度局部刷新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次上传回调只刷新当前附件行及变化的总进度，保持原完整可观察状态。

**Architecture:** 在原`updateLocalFile(index, changes)`里同步比较当前行，并始终使用原字节权重核算总进度；两者都未变化才直接返回，其他情况只发出变化行/变化总进度的数据路径补丁。无定时器、跨文件缓存、SDK或服务端改动。

**Tech Stack:** 原生微信小程序JavaScript、Node.js内置test/VM，沿用现有依赖。

**Spec:** `docs/superpowers/specs/2026-11-04-upload-progress-partial-updates-design.md`

## Global Constraints

- 保留最多3路传输、原文件顺序、同一预约核验登记及原重试预算。
- 原总进度算法、整数显示、registered视为100%、失败/等待/重试文字和服务端规范化文件名不变。
- 不改文件字节、选择器、格式/120MiB限制、原当前账号/节点/页面有效性判断，不新增计时节流。
- 不上传、提交审核、发布、改云配置或购买资源；本次只本地实现与验证，不自动commit/push。
- 用户已要求在当前工作区推进；所有预有dirty保留，独立证据限定本次1个运行文件和新测试。

## Review Focus

1. 同百分比的重试次数/状态标签变化不能被误去重。
2. 三路交错回调必须同步影响后续总进度，不丢状态、不换文件顺序。
3. 100%传输不等于已登记，失败后重试与服务端文件名更新不得遗漏。
4. 账号/节点版本/操作序号或卸载后的迟到回调仍按现有规则隔离；隐藏不能新增取消行为。
5. 不以单文件场景的载荷变化推断多文件、真机帧率或云费用收益。

## Task 1: 单行刷新与完整回归

**Files:**
- Modify: `miniprogram/pages/node-feedback/index.js`，仅`updateLocalFile(index, changes)`。
- Create/Test: `miniprogram/test/node-feedback-upload-rendering.test.js`，真实页面VM及数据路径setData边界，外部上传仅合成回调。
- Evidence: `outputs/qa/upload-progress-20261104/`，原运行前像、基线、RED/GREEN/原版对照及合成载荷指标。

**Interfaces:** 消费原worker调用`updateLocalFile(index:number, changes:object):void`；保持`data.files`和`data.uploadProgressPercent`同步可读，UI补丁只含变化行`files[index]`和变化总进度。服务端接口不变。

- [x] 冻结原页及预有dirty摘要，运行完整客户端基线812/812、退出0；不安装依赖或创建遗漏dirty依赖的副本。
- [x] 写测试并实跑RED：25项14pass/11fail，失败为载荷及重复刷新契约，不是夹具报错。
- [x] 同时覆盖手算字节权重、registered、零字节、0/false/空文字、3路交错、失败后仅重试失败文件、阶段同百分比文字变化、服务端规范化文件名及失效回调。
- [x] 只在原方法中做同步浅比较及行路径补丁，总进度仍按原公式；新测试GREEN25/25，未修改既定期望。
- [x] 冻结原版对照仍14pass/11fail；1/3/30/100附件共1850个完整状态逐步等价，合成载荷减少33.05/75.83/97.26/99.17%，不引入产品测试开关。
- [x] 完整客户端837/837、businessApi1916/1916、WXML4/4、语法与diff均通过；38个其他dirty摘要未变。两条预有npm配置警告保留，不改全局配置。
- [x] 一次新上下文只读复核无Critical/Important/Minor；独立25/25、五文件相关回归及语法/diff/记忆通过。主会话更新验收/计划/STATUS/稳定事实并最终校验，保留本地结果，不擅自提交或部署。

## 执行取舍

用户已批准具体短设计并指示开始，沿用本会话原生执行与末尾一次独立复核，不再追加执行方式选择。Windows下以apply_patch和任务专属Node证据脚本记录同等任务账本；不调用可能改变当前工作区或夹带历史dirty的Bash/Git流程。若发现功能兼容影响或安全/外部发布范围扩大则停止说明。

## 后续已授权交付

用户已在本地验收后要求提交/推送/部署，并明确同意覆盖体验版；按此新增授权继续，不视为原本地阶段自动发布。

- [x] 冻结2026.11.04.1客户端150文件，仅node-feedback与上次2026.11.04不同，当前配置保持；部署前完整client837/API1916/WXML4再次通过。
- [x] 选择性暂存7路径及记忆最新增量，准确index快照client778/778、记忆通过，其他38个dirty未变；提交67e70ad正常推送成功、独立远端main读回相同SHA。
- [x] 官方GUI正常重开原项目处理内部缓存/模拟器超时提示后，只提交一次2026.11.04.1上传并观察“代码上传成功”；不清缓存、不改配置，未知不重试，未提交审核/正式发布或改权限/云配置/其他功能。
- [x] 已回填验收与STATUS准确结果，交付文档限定三个路径及STATUS最新段；提交/同步的最终SHA以随后Git回执为准，保留完整证据。
