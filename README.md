# 业务进度管理微信小程序

用于创建业务线、配置流程节点、绑定负责人、提交节点进度与凭证，并让关联成员查看整体业务进度。

## 当前实现

- 原生微信小程序工程骨架（WXML / WXSS / JavaScript）
- 首页概览、业务线检索、创建业务线、业务详情、节点反馈、模板入口
- 用户头像/显示名称维护、业务线编辑和分页加载
- 云函数统一处理业务写操作与权限校验
- 业务线版本号乐观锁，避免多人编辑时静默覆盖
- 图片/PDF 凭证上传、记录与预览接口
- 业务线管理员删除、节点负责人反馈、成员查看的权限模型

## 快速开始

1. 注册微信小程序并取得 AppID。
2. 用微信开发者工具导入本目录。
3. 将 `project.config.json` 中的 `appid` 替换为真实 AppID。
4. 在开发者工具中开通云开发环境。
5. 创建 `users`、`business_lines`、`business_nodes`、`node_feedback`、`evidences`、`templates`、`template_nodes`、`invitations`、`notifications`、`audit_logs` 集合。
6. 将这些集合的客户端写权限设置为“仅管理端可写”；业务读取也建议先通过云函数完成。
7. 右键 `cloudfunctions/businessApi`，选择“上传并部署：云端安装依赖”。
8. 编译并打开首页。

## 本地检查

无需安装云函数依赖即可运行纯领域测试：

```powershell
node --test cloudfunctions/businessApi/test/domain.test.js
```

> `project.config.json` 当前使用 `touristappid` 便于导入，但云开发必须使用真实 AppID。

## 目录

- `miniprogram/`：小程序客户端
- `cloudfunctions/businessApi/`：统一业务云函数
- `docs/`：技术方案与数据字典
- `deliverables/`：技术规划文档和开发排期

## 当前边界

这是第一个可开发基线。微信订阅消息模板 ID、正式 AppID、云环境 ID、隐私协议和内容安全策略需要在微信公众平台/云开发控制台配置后才能联调。
