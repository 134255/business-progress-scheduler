# 停用参与人历史业务详情读取修复实施计划

> **供代理执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施。本计划使用复选框跟踪步骤。

**目标：** 修复任一历史节点参与账号被停用后整条业务详情返回 `FORBIDDEN` 的缺陷，同时保持当前访问者授权和所有写入权限不变。

**架构：** 保留 `getBusinessLine` 对当前访问者、业务成员关系、业务状态和节点版本的现有校验。只在请求内参与人显示名称缓存中把严格合法的 `disabled` 账号映射为“安全名称（已停用）”；缺失账号、未知状态和不安全名称继续失败关闭。

**技术栈：** Node.js 16、CommonJS、`node:test`、CloudBase 仓储适配器、项目内内存数据库测试夹具。

## 全局约束

- 当前访问者必须存在、状态为 `active`，并满足原有业务成员或旧版 OpenID 兼容关系。
- 停用账号只获得历史只读显示能力，不获得登录、处理、审核、写入或提醒资格。
- 仅严格的 `active` 和 `disabled` 状态可用于参与人显示；其他状态失败关闭。
- 显示名称仍只接受账号自身数据属性中的合法 `displayName` 或 `username`。
- 不迁移或修改任何业务数据，不新增集合、字段、索引或客户端接口。
- 保留用户已有的 `project.config.json` 修改，不读取其业务含义，不暂存、不提交。

---

### 任务 1：修复参与人显示名称解析并完成回归

**文件：**
- 修改：`cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- 修改：`cloudfunctions/businessApi/lib/cloud-business-repository.js`
- 修改：`docs/memory/STATUS.md`

**接口：**
- 使用：`createCloudBusinessRepository(...).getBusinessLine({ actor, lineId })`
- 新增私有函数：`safeParticipantDisplayName(account) -> string`
- 返回契约：活动参与人返回现有安全名称；停用参与人返回 `<安全名称>（已停用）`

- [ ] **步骤 1：新增停用参与人可读的失败测试**

在 `cloudfunctions/businessApi/test/cloud-business-repository.test.js` 的业务详情投影测试附近新增：

```js
test('停用节点参与人不阻断已完成业务详情并显示停用标记', async () => {
  const seed = seedDefinition({
    users: [
      { _id: 'manager-1', status: 'active', displayName: '业务管理员' },
      { _id: 'processor-1', status: 'disabled', displayName: '历史处理人' },
      { _id: 'reviewer-1', status: 'active', displayName: '历史审核人' }
    ],
    extra: {
      business_lines: [{
        _id: 'line-completed', code: 'BL-HISTORY-001', name: '已完成业务',
        status: 'completed', version: 4, progress: 100,
        managerUserIds: ['manager-1'],
        memberUserIds: ['manager-1', 'processor-1', 'reviewer-1'],
        currentNodeId: 'node-completed', currentNodeIndex: 0, nodeCount: 1
      }],
      business_nodes: [{
        _id: 'node-completed', businessLineId: 'line-completed',
        nodeCode: 'BL-HISTORY-001-N001', sequence: 0, name: '历史节点',
        status: 'completed', version: 3, workflowMode: 'review',
        processorUserIds: ['processor-1'], reviewerUserIds: ['reviewer-1'],
        reviewMode: 'any', processingRoundNumber: 1, reviewRoundNumber: 1,
        processingDueStatus: 'calculated', reviewDueStatus: 'calculated',
        requiresEvidence: false, allowedEvidenceTypes: [], fieldDefinitions: []
      }]
    }
  })
  const { repository } = createRepositoryHarness(seed)

  const result = await repository.getBusinessLine({
    actor: { _id: 'manager-1' }, lineId: 'line-completed'
  })

  assert.deepEqual(result.nodes[0].processorDisplayNames, ['历史处理人（已停用）'])
  assert.deepEqual(result.nodes[0].reviewerDisplayNames, ['历史审核人'])
})
```

- [ ] **步骤 2：运行测试并确认 RED**

运行：

```powershell
node --test --test-name-pattern="停用节点参与人不阻断" cloudfunctions/businessApi/test/cloud-business-repository.test.js
```

预期：测试失败，仓储抛出 `FORBIDDEN`；失败原因必须是 `createDisplayNameCache` 仍要求参与账号为 `active`，而不是夹具错误或语法错误。

- [ ] **步骤 3：补充失败关闭回归**

在同一测试文件新增表驱动测试，分别把参与人账号构造为：状态字段缺失、状态为 `locked`、账号文档缺失、`displayName` 为访问器且 `username` 缺失。每个用例都通过真实 `getBusinessLine` 调用并断言错误码严格为 `FORBIDDEN`；访问器用例同时断言 getter 调用次数为 0。

测试夹具沿用步骤 1 的业务与节点结构，只替换 `processor-1` 文档。缺失文档用例不把 `processor-1` 放入 `users`；访问器用例通过现有 `transformRead` 在读取 `processor-1` 时定义 getter：

```js
Object.defineProperty(data, 'displayName', {
  enumerable: true,
  get() {
    getterReads.count += 1
    return '不应读取'
  }
})
```

- [ ] **步骤 4：实现最小生产修复**

在 `cloudfunctions/businessApi/lib/cloud-business-repository.js` 的 `safeDisplayName` 后新增：

```js
function safeParticipantDisplayName(account) {
  if (!account || !['active', 'disabled'].includes(account.status)) {
    throw createError('FORBIDDEN')
  }
  const name = safeDisplayName(account)
  return account.status === 'disabled' ? `${name}（已停用）` : name
}
```

把 `createDisplayNameCache` 中的活动状态硬拒绝改为只校验账号存在和编号一致，再调用该函数：

```js
if (!account || account._id !== id) throw createError('FORBIDDEN')
return [id, safeParticipantDisplayName(account)]
```

不得修改 `requireCurrentReader`、写入仓储、审核仓储、账号服务或提醒工作器。

- [ ] **步骤 5：运行聚焦测试并确认 GREEN**

运行：

```powershell
node --test cloudfunctions/businessApi/test/cloud-business-repository.test.js
```

预期：该文件全部测试通过；新增停用参与人测试返回带后缀名称，四类损坏输入均返回 `FORBIDDEN`，访问器没有被执行。

- [ ] **步骤 6：运行完整验证**

依次运行：

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --check cloudfunctions/businessApi/lib/cloud-business-repository.js
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

预期：全部命令退出码为 0；记录精确测试数量。若任何既有测试失败，停止提交并定位原因。

- [ ] **步骤 7：更新状态记录并提交**

在 `docs/memory/STATUS.md` 顶部记录：RED 的精确失败、GREEN 与全量测试数量、只读显示边界、仍未验证的 `businessApi` 重新部署和多账号 CloudBase 复验。仅显式暂存以下文件：

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/test/cloud-business-repository.test.js docs/memory/STATUS.md
git diff --cached --check
git commit -m "fix: 允许读取停用参与人的历史业务"
```

提交后确认工作树除用户原有 `project.config.json` 外没有其他修改。
