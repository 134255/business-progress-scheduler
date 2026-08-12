# AILCC 全年接口年份兼容实施计划

> **执行要求：** 使用测试驱动开发，严格按 RED→GREEN 顺序执行。

**目标：** 兼容 AILCC 全年接口返回的严格四位数字字符串年份，同时保持全部现有安全校验。

**架构：** 只修改 `holiday-api-client` 的响应规范化边界；内部年份与数据库结构保持数字类型。测试覆盖合法字符串和容易被宽松强制转换误接纳的非法形式。

**技术栈：** Node.js 16、`node:test`、原生 HTTPS。

## 全局约束

- 不改 CloudBase 集合、索引、权限或触发器。
- 不记录第三方响应正文、账号信息或任何敏感数据。
- 保留 `project.config.json` 的现有本地修改，不纳入提交。

### 任务 1：收紧并兼容年份解析

**文件：**
- 修改：`cloudfunctions/calendarSync/test/holiday-api-client.test.js`
- 修改：`cloudfunctions/calendarSync/lib/holiday-api-client.js`
- 修改：`docs/memory/STATUS.md`

- [ ] 增加合法字符串年份与非法近似字符串测试。
- [ ] 运行聚焦测试，确认合法字符串用例按预期失败。
- [ ] 实现严格年份匹配函数并接入响应校验。
- [ ] 运行聚焦和全量测试。
- [ ] 更新中文项目状态，执行差异与记忆校验。
- [ ] 显式暂存相关文件，提交并推送 `main`。
