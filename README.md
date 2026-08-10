# 业务进度管理微信小程序

用于创建业务线、配置流程节点、绑定负责人、提交节点进度与凭证，并让关联成员查看整体业务进度。

## 当前实现

- 原生微信小程序工程骨架（WXML / WXSS / JavaScript）
- 首页概览、业务线检索、创建业务线、业务详情、节点反馈、模板入口
- 用户头像/显示名称维护、业务线编辑和分页加载
- 云函数统一处理业务写操作与权限校验
- 业务线版本号乐观锁，避免多人编辑时静默覆盖
- 超级管理员模板、节点、七类动态字段、负责人和 SLA 管理
- 自动业务编号、模板快照、多负责人或签、驳回返工和冻结修订
- 图片/PDF/视频凭证上传、短期访问和 60 天到期清理
- 业务线管理员关闭、节点负责人反馈、关联成员查看的权限模型

## 快速开始

1. 注册微信小程序并取得 AppID。
2. 用微信开发者工具导入本目录。
3. 将 `project.config.json` 中的 `appid` 替换为真实 AppID。
4. 在开发者工具中开通云开发环境。
5. 按 [账户管理部署、首位管理员与恢复运行手册](docs/deployment/account-admin-setup.md) 创建或核对账户集合、索引、`account_admin_state` 守卫和 OpenID 绑定回填；不要创建 `users.openid` 唯一索引。
6. 为云函数安全配置 `ADMIN_RECOVERY_CODE_SHA256`，并使守卫文档的恢复哈希与之匹配；不在仓库、终端记录或测试请求中保存恢复码或哈希。
7. 右键 `cloudfunctions/businessApi`，选择“上传并部署：云端安装依赖”。部署后调用 `initializeSuperAdmin`，用临时密码完成强制改密，再创建普通用户。
8. 按 [模板、动态字段、凭证与定时清理部署手册](docs/deployment/template-node-fields-setup.md) 备份业务集合、核对唯一值、建立索引并上传 `businessApi` 与 `evidenceRetention`。
9. 配置并先停用每日清理触发器，完成隔离数据验收后再启用。
10. 重新编译并执行手册中的脱敏验收矩阵。部署、迁移和真实 CloudBase 验收均须由目标环境操作员完成。

## 本地检查

从仓库根目录运行账户管理的本地检查：

```powershell
npm.cmd ci --ignore-scripts --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js miniprogram/test/template-flow.test.js miniprogram/test/business-template-flow.test.js miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

> `project.config.json` 当前使用已注册的小程序 AppID 标识；导入或切换项目后仍需核对目标 CloudBase 环境，AppID 和环境 ID 均不属于密码，但不得据此放宽云端权限。

## 目录

- `miniprogram/`：小程序客户端
- `cloudfunctions/businessApi/`：统一业务云函数
- `cloudfunctions/evidenceRetention/`：凭证提醒、预约恢复和幂等清理定时云函数
- `docs/`：技术方案与数据字典
- `deliverables/`：技术规划文档和开发排期

## 当前边界

当前代码已经覆盖模板化业务、动态反馈、凭证和保留期的本地自动化边界。真实 CloudBase 索引、云函数版本、每日触发器、云文件删除、多账号并发、隐私协议和内容安全策略仍需按部署手册逐项验收；企业微信强提醒在安全配置可用后另行接入。
