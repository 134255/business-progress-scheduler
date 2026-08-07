# CloudBase 固定文档不存在处理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让真实 CloudBase 中尚不存在的固定绑定文档被仓库层解释为 `null`，使未初始化系统正常显示首位管理员初始化入口，同时继续暴露所有非缺失类数据库故障。

**Architecture:** 保持所有固定文档读取继续通过 `cloud-account-repository.js` 的 `readDocument` 边界。测试数据库先改为模拟真实 CloudBase 的缺失文档异常，再在该边界只识别明确的 `document.get:fail ... does not exist`，不改变事务、查询或客户端接口。

**Tech Stack:** Node.js、`node:test`、腾讯 CloudBase `wx-server-sdk@4.0.2`、原生微信小程序、Git 项目记忆。

## Global Constraints

- 采用 TDD，必须先观察聚焦测试因真实风格缺失文档异常而失败，再修改生产代码。
- 只把明确的固定文档不存在错误转换为 `null`；权限、网络、超时、集合不存在和未知错误继续抛出。
- 不记录或持久化 OpenID、摘要、密码、恢复码或挑战令牌。
- 不改成查询，不创建占位绑定文档，不改变账户事务和初始化守卫。
- 保留工作树中预先存在的 `docs/deployment/account-admin-setup.md` 未暂存改动，不得暂存或覆盖。

---

### Task 1: 用真实 CloudBase 缺失文档语义完成回归修复

**Files:**
- Modify: `cloudfunctions/businessApi/test/helpers/fake-cloud-database.js:56-60`
- Modify: `cloudfunctions/businessApi/test/cloud-account-repository.test.js:22-43`
- Modify: `cloudfunctions/businessApi/lib/cloud-account-repository.js:96-102`

**Interfaces:**
- Consumes: `database.collection(collectionName).doc(id).get(): Promise<{ data: object }>`.
- Produces: `readDocument(database, collectionName, id): Promise<object|null>`，仅在明确缺失文档时返回 `null`。

- [ ] **Step 1: 让测试数据库模拟真实缺失文档异常**

将假数据库的固定文档 `get()` 改为：

```js
async get() {
  const document = documents(name).get(id)
  if (!document) {
    throw new Error(`document.get:fail document with _id ${id} does not exist`)
  }
  return { data: clone(document) }
},
```

- [ ] **Step 2: 增加仓库回归测试和非缺失错误保护测试**

在 `cloud-account-repository.test.js` 的守卫测试后增加：

```js
test('fixed-document reads normalize only CloudBase missing-document failures', async () => {
  const { repository } = createRepository()

  assert.equal(await repository.findUserByOpenid('wx-unbound'), null)

  const permissionFailure = new Error('document.get:fail permission denied')
  const failingRepository = createCloudAccountRepository({
    db: {
      collection() {
        return {
          doc() {
            return { get: async () => { throw permissionFailure } }
          }
        }
      }
    }
  })

  await assert.rejects(
    failingRepository.findUserById('unreadable-user'),
    error => error === permissionFailure
  )
})
```

- [ ] **Step 3: 运行聚焦测试并确认 RED**

Run:

```powershell
node --test --test-name-pattern="fixed-document reads normalize only CloudBase missing-document failures" cloudfunctions/businessApi/test/cloud-account-repository.test.js
```

Expected: FAIL，错误文本包含 `document.get:fail document with _id` 和 `does not exist`；失败点是缺失绑定文档尚未被 `readDocument` 转换，而不是语法或测试装载错误。

- [ ] **Step 4: 实现窄范围缺失文档判定**

在 `createCloudAccountRepository` 之前增加：

```js
function isMissingDocumentError(error) {
  const text = `${error && error.message || ''} ${error && error.errMsg || ''}`.toLowerCase()
  return text.includes('document.get:fail') && text.includes('does not exist')
}
```

把 `readDocument` 改为：

```js
async function readDocument(database, collectionName, id) {
  try {
    const result = await database.collection(collectionName).doc(id).get()
    return result && result.data ? result.data : null
  } catch (error) {
    if (isMissingDocumentError(error)) return null
    throw error
  }
}
```

- [ ] **Step 5: 运行聚焦测试并确认 GREEN**

Run:

```powershell
node --test --test-name-pattern="fixed-document reads normalize only CloudBase missing-document failures" cloudfunctions/businessApi/test/cloud-account-repository.test.js
```

Expected: 1 项匹配测试通过；缺失文档返回 `null`，权限错误按对象原样抛出。

- [ ] **Step 6: 运行仓库与路由相关测试**

Run:

```powershell
node --test cloudfunctions/businessApi/test/cloud-account-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
```

Expected: 0 failures。特别确认“守卫缺失时失败关闭”和“未绑定身份返回未认证会话”仍通过。

- [ ] **Step 7: 提交回归修复**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-account-repository.js cloudfunctions/businessApi/test/helpers/fake-cloud-database.js cloudfunctions/businessApi/test/cloud-account-repository.test.js
git diff --cached --check
git commit -m "fix: handle missing CloudBase documents"
```

---

### Task 2: 完整验证并更新长期记忆

**Files:**
- Modify: `docs/memory/STATUS.md`

**Interfaces:**
- Consumes: Task 1 的修复提交与测试证据。
- Produces: 可恢复的当前状态、精确验证结果和下一步手工部署动作。

- [ ] **Step 1: 运行完整自动化验证**

Run:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
node --check cloudfunctions/businessApi/lib/cloud-account-repository.js
node --check cloudfunctions/businessApi/test/helpers/fake-cloud-database.js
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: 后端测试在新增回归测试后全部通过；客户端 43 项、WXML 1 项、语法检查、差异检查和记忆校验全部通过。

- [ ] **Step 2: 更新 `STATUS.md`**

记录以下事实，不记录任何身份值或错误中的文档 ID：

- 真实 CloudBase 缺失固定文档语义已由仓库读取层处理。
- 聚焦 RED/GREEN 证据及最终测试数量。
- 微信开发者工具重新上传和真实初始化入口复测仍为 `unverified`。
- 下一步是重新上传 `businessApi`，重新编译并确认初始化入口出现。

- [ ] **Step 3: 重新运行记忆与敏感数据校验**

Run:

```powershell
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
rg -n -S "wx-unbound|unreadable-user|document with _id" docs/memory docs/deployment
git diff --check
```

Expected: 记忆校验通过；运行文档和记忆中无测试身份或原始错误文档 ID；差异检查通过。

- [ ] **Step 4: 精确暂存并提交记忆**

```powershell
git add -- docs/memory/STATUS.md
git diff --cached --name-only
git diff --cached --check
git commit -m "docs: record CloudBase document fix verification"
```

Expected: 暂存列表只有 `docs/memory/STATUS.md`，不包含部署手册的用户本地改动。

---

### Task 3: 审查、推送与操作员交接

**Files:**
- Review only: commits after `c8de571`

**Interfaces:**
- Consumes: Tasks 1-2 的已提交、已验证分支。
- Produces: 推送到 `origin/codex/account-admin` 的修复和一步一确认的重新部署说明。

- [ ] **Step 1: 做最终范围和代码审查**

检查：

```powershell
git diff c8de571..HEAD --stat
git diff c8de571..HEAD
git status --short --branch
```

确认只有仓库读取层、真实语义测试替身、回归测试和状态记忆发生变化；无 Critical/Important 问题；部署手册本地补丁仍未暂存。

- [ ] **Step 2: 推送修复分支**

```powershell
git push origin codex/account-admin
```

- [ ] **Step 3: 操作员重新部署和复测**

逐步指导操作员：

1. 右键 `cloudfunctions/businessApi`，选择“上传并部署：云端安装依赖（不上传 node_modules）”。
2. 上传完成后点击“编译”。
3. 确认登录页显示“初始化首位管理员”，且不再显示缺失绑定文档错误。
4. 在未确认入口正确前，不输入管理员密码或恢复码。

只有操作员完成以上检查后，真实 CloudBase 验收状态才可从 `unverified` 更新。
