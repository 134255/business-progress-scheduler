# ADR-0007：定时云函数只信任服务端触发来源

## Status（状态）

已接受，2026-08-14；2026-08-17 扩展到 `evidenceRetention`。

## Context（背景）

真实 CloudBase Timer 已触发 `workflowReminder`，但合法调用被错误拒绝。平台通过服务端环境变量 `TRIGGER_SRC=timer` 标识定时来源，锁定版本的 `wx-server-sdk` 不会把该变量自动映射为 `getWXContext().TRIGGER_SRC`。原实现读取微信调用上下文，导致真实 Timer 无法授权。

`calendarSync` 的计划入口使用了相同读取方式，因此其未来每日定时同步也存在同类不可用风险。客户端事件内容不能作为替代授权依据，因为调用者可以伪造 `Type`、`mode` 和时间等字段。

破坏性保留工作器 `evidenceRetention` 原先没有入口授权，任何直接云函数调用都会进入预约恢复、提醒与云文件清理。它不能依赖“函数名不公开”或操作员只从控制台调用；在准备真实清理验收前必须使用同一可信 Timer 边界，并拒绝带小程序身份的调用。

## Decision（决策）

1. `workflowReminder`、`calendarSync` 与 `evidenceRetention` 的默认部署装配只从 `process.env.TRIGGER_SRC` 读取可信触发来源。
2. 计划路径只接受严格小写字符串 `timer`，并同时拒绝任何带非空 `OPENID` 的调用。
3. 事件载荷和 `getWXContext().TRIGGER_SRC` 不参与授权；来源缺失、类型或大小写不匹配时失败关闭。
4. `calendarSync` 的人工路径继续使用活动超级管理员签发并由服务端一次性消费的短期票据；可信 Timer 不能绕过非空票据的消费分支。
5. 三个处理器保留可注入的可信来源读取器，仅用于自动化测试；生产默认装配固定读取服务端环境变量。
6. `evidenceRetention` 不提供客户端或普通控制台测试的人工授权分支；破坏性隔离验收只能在再次备份、确认无敏感测试对象并取得单独批准后使用一次性 Timer，执行后立即恢复 `triggers: []`。

## Consequences（后果）

- 真实 Timer 可以在重新部署后进入原有工作器逻辑，伪造事件和客户端直调仍不能获得权限。
- 不需要修改数据库、索引、业务记录、提醒/日历/保留算法或现有触发器配置。
- 平台未提供合法来源时任务会继续拒绝，优先保证安全而不是猜测调用来源。
- 每次变更后仍须在目标环境先使用一次性 Timer 验证真实来源形状，再单独批准正式触发器；`evidenceRetention` 的正式周期触发器继续保持未批准。
