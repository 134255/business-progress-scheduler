# 账户管理部署、首位管理员与恢复运行手册

> 本手册是账户管理的操作前提，不是已执行记录。云函数部署、数据库迁移和微信开发者工具验证均须由获授权操作员在目标环境完成；在完成脱敏验收记录前，均为**未验证**。

## 安全边界

- 不要把密码、恢复码、OpenID、哈希、挑战令牌或客户数据写入仓库、命令历史、终端输出、剪贴板同步工具或工单附件。
- 下文 JSON 的值仅是明显的非生产示例，**严禁在任何环境复用**。实际值只在获授权的本地操作流程中输入。
- `wechat_bindings/<sha256(openid)>` 是 OpenID 唯一性权威；`users.openid` 只是与绑定记录同时更新的反规范化字段。不得创建或保留 `users.openid` 唯一索引。
- `system_settings/account_admin_state` 是活动超级管理员计数的唯一守卫。不要绕过云函数直接修改用户角色、状态、凭据、OpenID 或守卫计数。

## 部署前集合和索引

在 CloudBase 目标环境中创建或确认以下集合，并限制客户端直接写入；账户变更通过 `businessApi` 云函数完成：

```text
users
user_credentials
auth_challenges
wechat_bindings
system_settings
audit_logs
```

创建或核对与当前代码相符的索引：

```text
users.usernameNormalized          UNIQUE
user_credentials.userId          UNIQUE
auth_challenges.tokenHash        UNIQUE
auth_challenges.userId+expiresAt COMPOUND
audit_logs.createdAt             DESCENDING
```

在创建 `users.usernameNormalized` 唯一索引前，先导出受影响的旧 `users` 文档。没有受控用户名的文档必须升级为受控用户名，或隔离并经业务所有者确认后再继续；不要删除既有测试用户，除非已导出或确认它可以处置。还要检查规范化后的用户名不存在重复项。

## 迁移顺序和回退（维护窗口）

1. 导出 `users`、`user_credentials`、`wechat_bindings` 和 `system_settings` 的必要回滚副本，并暂停账户登录、绑定、解绑定和管理员生命周期操作。
2. 盘点 `users` 中 `role: "super_admin"` 且 `status: "active"` 的文档数。创建或回填 `system_settings/account_admin_state`，使 `activeSuperAdminCount` 恰等于该数量，并将 `revision` 设为非负安全整数（首次回填可为 `0`）。缺失、负数、小数或超出 JavaScript 安全整数范围的值会使账户操作以 `ACCOUNT_STATE_INVALID` 失败关闭。
3. 对每个已有非空 `users.openid`，由经批准的一次性迁移工具在本地内存中计算该 OpenID 的小写十六进制 SHA-256，并写入 `wechat_bindings` 中以该摘要为文档 ID 的记录。绑定记录只保存对应 `userId` 和时间戳；文档 ID、日志和本手册都不得包含原始 OpenID。迁移前必须拒绝同一 OpenID 指向多个用户、同一用户存在不匹配绑定或无法计算的身份值。
4. 使用同一受控工具进行脱敏核对：每个非空 `users.openid` 恰有一个对应绑定、每个绑定的 `userId` 指向该用户、摘要 ID 与该用户 OpenID 匹配；空 OpenID 不应有绑定。不要在核对输出中打印身份值或摘要。
5. 仅在第 2–4 步通过后，移除旧的 `users.openid` 唯一索引。该索引不提供本功能需要的稀疏唯一语义；新代码只通过确定性绑定记录查找身份。
6. 配置恢复状态，然后上传并部署 `businessApi`，选择云端安装依赖。部署后再解除维护窗口并执行首位管理员或受控恢复流程。

若第 2–4 步任一步失败，停止迁移、保持旧索引和旧部署，并从已导出的副本恢复到迁移前的**一致**状态。移除旧索引后需要回退时，严格保持维护窗口关闭并按以下顺序执行：

1. 从同一迁移前快照一起恢复 `users`、`user_credentials`、`wechat_bindings` 和 `system_settings`，使用户 OpenID、绑定记录和守卫文档一致。
2. 在重新创建旧索引前，以脱敏检查证明所有非空 `users.openid` 值没有重复；若存在重复、空值处理不符合旧索引约束，或检查无法完成，保持关闭并升级处理。
3. 重新创建旧版 `users.openid` 唯一索引，并在控制台确认该索引已激活且没有构建错误。
4. 恢复迁移前的 `businessApi` 版本、其云端依赖和与该版本相符的配置；不要将旧函数与新集合状态或新函数配置混合运行。
5. 在仍关闭的维护窗口内完成脱敏一致性与会话检查，确认旧函数可使用恢复后的用户数据、旧唯一索引生效，且没有暴露身份值、摘要或秘密。
6. 只有第 1–5 步全部成功后才解除维护窗口并恢复流量。任一步失败都必须保持关闭并升级处理；不得在混合状态下重新开放。

不得通过删除最后一个活动超级管理员来“修复”计数。

## 恢复码哈希和守卫配置

使用组织批准的**离线密码管理器**完成以下流程；该管理器必须同时提供掩码恢复码字段、SHA-256 派生或自定义字段，以及向受控控制台安全自动输入的能力：

1. 在管理器的掩码字段生成一次性恢复码，并仅保存在该条目中。
2. 由管理器在同一条目生成 SHA-256 派生/自定义字段，确认其输出为小写十六进制摘要；不要在 shell、终端或其他手工工具中计算。
3. 使用管理器的安全自动输入，直接将该摘要填入 Cloud Function 环境配置和守卫数据库字段；不要经由同步剪贴板、中间文本框、命令参数或文件传递。
4. 使用管理器的字段相等确认，或只比较组织批准的短验证指纹，确认两处都收到同一摘要；不要显示、打印或记录完整摘要。

若所选密码管理器不能安全派生 SHA-256 并自动输入，停止操作并取得获批准工具；不要临时改用 shell 命令、终端输出、脚本、明文文件或在线哈希服务。严禁把恢复码或完整摘要放进 shell 历史、终端输出、日志、跟踪或未跟踪文件、截图、云端笔记或同步剪贴板。原始恢复码只在初始化或恢复调用时由操作员本地输入，成功后立即弃用；不要把它放进环境变量、脚本参数或 JSON 文件。

云函数环境只使用下列变量名：

```text
ADMIN_RECOVERY_CODE_SHA256
```

将小写十六进制 SHA-256 值安全配置到该环境变量，并在 `system_settings/account_admin_state` 的 `recoveryCodeHash` 写入**同一个值**；将 `recoveryConsumedAt` 初始化为 `null`。实际哈希是敏感校验材料，不得复制到仓库、日志、报告或示例中。守卫文档至少包含：

```text
_id: "account_admin_state"
activeSuperAdminCount: <已核对的非负安全整数>
revision: <非负安全整数>
recoveryCodeHash: <仅通过受控控制台输入，勿记录>
recoveryConsumedAt: null
```

`credentialVersion` 在每次凭据变更时递增；`challengeEpoch` 用于一次递增作废旧挑战。两者缺失的旧值按 `0` 处理，但格式错误、负数、小数或溢出会失败关闭。迁移和人工修复不得回退、伪造或以非整数写入这些字段。

成功初始化或恢复会消费守卫中的恢复状态。为后续恢复轮换恢复码时，在维护窗口内先安全更新云函数环境变量，再将守卫的 `recoveryCodeHash` 更新为同一新值并清空 `recoveryConsumedAt`；两个值不一致时恢复会安全失败。旧码和已消费的码均不得重新启用。

## 初始化首位超级管理员

在微信开发者工具的云函数测试面板调用公开路由 `initializeSuperAdmin`。云函数从可信微信上下文取得当前 OpenID；不要在 payload 中提供 OpenID。

```json
{
  "action": "initializeSuperAdmin",
  "payload": {
    "username": "example_admin_01_DO_NOT_USE",
    "displayName": "示例管理员（仅示例，禁止复用）",
    "temporaryPassword": "ExampleOnlyPass8-DoNotUse",
    "recoveryCode": "ExampleOnlyRecovery9-DoNotUse"
  }
}
```

以上全部值是非生产示例，**严禁复用**。实际操作时输入由本地获授权流程产生的用户名、显示名、临时密码和一次性恢复码，不要保存测试面板的原始请求或响应。

预期的脱敏状态是：恰有一个活动 `super_admin`，其凭据 `mustChangePassword: true`；当前可信 OpenID 有一条绑定保留记录；守卫计数为 `1` 且恢复状态已消费；并写入 `INITIALIZE_SUPER_ADMIN` 审计记录。操作员随后用临时密码登录，并在十分钟挑战有效期内完成强制密码修改；完成后才会绑定普通登录会话。

若返回 `ALREADY_INITIALIZED`，不要删除任何管理员或守卫记录；先核对守卫计数、用户状态和绑定一致性。若返回 `INVALID_RECOVERY_CODE`，核对环境变量、守卫哈希和 `recoveryConsumedAt`，但不得把这些值写入日志或工单。

## 紧急恢复与轮换

紧急恢复使用公开路由 `recoverSuperAdmin`；它不接受也不相信 payload 中的 OpenID。

```json
{
  "action": "recoverSuperAdmin",
  "payload": {
    "username": "example_admin_01_DO_NOT_USE",
    "temporaryPassword": "ExampleOnlyRecoveryPass8-DoNotUse",
    "recoveryCode": "ExampleOnlyRotatedRecovery9-DoNotUse"
  }
}
```

以上全部值是非生产示例，**严禁复用**。在调用前确认目标用户名已存在；恢复不会创建不存在的账户。实际值只能在获授权的本地操作流程输入。

成功恢复会原子地将目标账户启用并提升为 `super_admin`，更新守卫计数和修订号，移除该账户旧 OpenID 的绑定保留，重置临时密码并清除锁定状态，要求改密，推进凭据版本并推进挑战 epoch，使既有挑战逻辑失效；同时写入高优先级 `RECOVER_SUPER_ADMIN` 审计记录并消费恢复状态。随后以临时密码完成强制改密，再确认会话、绑定和活动管理员计数一致。

当前实现对已消费、缺失或不匹配的恢复状态返回 `INVALID_RECOVERY_CODE`；它不返回旧计划中提及的 `RECOVERY_CODE_USED`。若恢复失败，停止重试，先进行脱敏一致性核对；不要手工重置密码哈希、挑战字段、OpenID 或管理员计数。需要再次恢复时，按本手册轮换新的恢复码哈希和守卫状态后再调用。

## 依赖风险和本地验证

`cloudfunctions/businessApi` 将 `wx-server-sdk` 精确固定为 `4.0.2`，并使用锁文件。当前 `npm audit` 的已知结果为六项传递依赖告警（1 项 moderate、5 项 high）。npm 建议的修复需要 SemVer 主版本降级到 `2.5.3`，会改变已审查的事务行为，因此未自动应用。跟踪上游经过审查的发布版本后再评估升级；不要在部署窗口临时降级。

在仓库根目录执行以下本地检查；它们不部署云函数，也不验证目标 CloudBase 数据：

```powershell
npm.cmd ci --ignore-scripts --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

部署、迁移、索引创建、控制台调用、真实事务冲突和微信开发者工具验收必须在目标环境另行执行并记录为未验证，直到操作员完成脱敏验收。
