# 保存处理进度路由修复实施计划

> **面向执行代理：** 必须逐项执行本计划，并使用 `superpowers:test-driven-development` 先观察失败、再做最小修复。

**目标：** 让新版审核节点的“保存处理进度”和“标记受阻”请求进入 `saveNodeProgress`，同时保持旧节点继续使用原 `submitFeedback`。

**架构：** 小程序继续调用现有受保护动作 `submitFeedback`。云函数路由只根据是否存在自有数据属性 `action` 选择新版或旧版服务方法；服务与仓储继续负责节点类型、当前账号、节点版本和业务状态的权威复核。

**技术栈：** Node.js 16、`node:test`、腾讯 CloudBase 云函数。

## 全局约束

- 不新增公共 API、集合、索引或客户端协议。
- 不读取或执行 `action` 访问器；损坏输入继续失败关闭。
- 旧节点无 `action` 请求继续进入 `submitFeedback`。
- 新版请求只有通过 `saveNodeProgress` 的服务端校验后才能写入。
- 不暂存或提交用户已有的 `project.config.json` 修改。

---

### 任务 1：修复受保护反馈路由分派

**文件：**

- 修改：`cloudfunctions/businessApi/test/account-routes.test.js`
- 修改：`cloudfunctions/businessApi/index.js`
- 修改：`docs/memory/STATUS.md`

**接口：**

- 输入：现有 `submitFeedback` 动作的 `{ actor, payload }`。
- 输出：含自有数据属性 `action` 时调用 `feedbackService.saveNodeProgress({ actor, input: payload })`；否则调用 `feedbackService.submitFeedback({ actor, input: payload })`。

- [x] **步骤 1：编写失败回归**

  在路由测试中同时提交旧节点完成载荷和新版 `action: 'save_progress'` 载荷，断言前者进入 `submitFeedback`、后者进入 `saveNodeProgress`；用真实反馈服务补一条新版保存成功回归。

- [x] **步骤 2：运行 RED**

  运行：`node --test cloudfunctions/businessApi/test/account-routes.test.js`

  预期：新版保存载荷仍被错误交给旧服务方法，测试失败并复现云端 `VALIDATION_ERROR`。

- [x] **步骤 3：最小实现**

  在 `createFeedbackRoutes` 内通过 `Object.getOwnPropertyDescriptor(payload, 'action')` 判断自有数据属性，不读取访问器；有动作时调用 `saveNodeProgress`，无动作时保留原调用。

- [x] **步骤 4：运行 GREEN 与全量门禁**

  运行聚焦路由测试、完整 `businessApi` 测试、WXML 结构检查、JavaScript 语法检查、`git diff --check` 和项目记忆校验。

- [x] **步骤 5：更新状态并显式提交**

  在 `STATUS.md` 记录真机根因、RED/GREEN 和“修复版云端部署/真机复验仍未验证”；仅暂存本计划列出的文件并创建本地提交。
