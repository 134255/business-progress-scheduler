# 可选凭证格式规则一致性修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 必须使用 `superpowers:test-driven-development` 按任务逐项实施；若采用子代理模式，使用 `superpowers:subagent-driven-development`，若在当前会话内实施，使用 `superpowers:executing-plans`。每一步均使用复选框跟踪。

**目标：** 让“非必传凭证 + 空格式白名单”在模板、小程序和服务端统一表示“凭证可选，允许全部已支持格式”，并安全兼容现有业务快照。

**架构：** 服务端在授权事务读取节点快照后，通过单一纯函数推导有效凭证类型；只有严格合法的非必传空数组可扩展为全部七种类型，损坏结构继续失败关闭。模板页面始终展示格式选项并解释空数组语义，处理页沿用服务端安全投影执行本地预检；服务封装将稳定错误码转换为固定中文消息。

**技术栈：** 微信小程序原生 JavaScript/WXML、Node.js 16、`node:test`、腾讯云 CloudBase。

## 全局约束

- `requiresEvidence: true` 时 `allowedEvidenceTypes` 必须为非空合法白名单。
- `requiresEvidence: false` 且白名单非空时，只允许白名单格式。
- `requiresEvidence: false` 且白名单为空数组时，允许 `jpg`、`jpeg`、`png`、`pdf`、`mp4`、`mov`、`m4v`。
- 图片单文件不超过 5 MB；PDF/视频单文件不超过 20 MB；单次反馈文件总量不超过 20 MB；文件数量不另设上限。
- 服务端继续校验当前活动账号、业务状态、当前节点、处理人、节点版本、真实文件字节、文件签名、扩展名和大小。
- `requiresEvidence` 缺失时沿用现有兼容规则按非必传处理；字段存在时必须是自有布尔数据属性。非数组、访问器、继承属性、重复类型和未知类型不得触发“允许全部”，必须失败关闭。
- 现有业务节点不迁移、不重建、不改编号；凭证 60 天保留规则不变。
- 所有用户可见错误以固定中文表达，不返回云文件编号、路径或底层错误。
- 保留操作员现有 `project.config.json` 修改，不得暂存或提交。

---

## 文件结构

- 修改 `cloudfunctions/businessApi/lib/cloud-evidence-repository.js`：从节点快照严格推导登记凭证的有效格式集合。
- 修改 `cloudfunctions/businessApi/test/cloud-evidence-repository.test.js`：覆盖三态规则、七种格式、损坏结构和事务二次复核。
- 修改 `miniprogram/pages/admin-template-node-edit/index.wxml`：始终显示格式选择，并呈现必传/可选与空白名单说明。
- 修改 `miniprogram/test/template-flow.test.js`：验证模板保存和页面文案契约。
- 修改 `miniprogram/pages/node-feedback/index.js`：使用统一的客户端支持格式集合并保持本地预检。
- 修改 `miniprogram/services/business.js`：将凭证登记错误转换为固定中文安全消息。
- 修改 `miniprogram/test/node-feedback-v2.test.js`：验证空白名单可选择七种格式、有限白名单仍拦截以及登记失败提示。
- 修改 `miniprogram/test/admin-business-amend-flow.test.js`：使用真实业务服务验证登记错误码到中文消息的映射和静默调用。
- 修改 `docs/memory/PROJECT.md`：记录可选凭证空白名单的稳定业务语义。
- 修改 `docs/memory/STATUS.md`：记录 RED/GREEN、完整验证、部署与真机边界。

### 任务 1：服务端有效格式推导

**文件：**

- 修改：`cloudfunctions/businessApi/lib/cloud-evidence-repository.js`
- 测试：`cloudfunctions/businessApi/test/cloud-evidence-repository.test.js`

**接口：**

- 输入：事务内读取的节点文档与 `accountSchema`。
- 产出：`effectiveAllowedEvidenceTypes(node, accountSchema): string[]`；返回新数组，不修改节点文档。
- 后续依赖：`authorizeRegistration()` 在首次授权和登记事务二次授权时均返回该有效集合。

- [ ] **步骤 1：写非必传空白名单的失败测试**

在 `cloud-evidence-repository.test.js` 增加表驱动用例，使用真实最小签名字节分别登记七种文件：

```js
for (const fixture of [
  { extension: 'jpg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]) },
  { extension: 'jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]) },
  { extension: 'png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { extension: 'pdf', bytes: Buffer.from('%PDF-safe-fixture') },
  { extension: 'mp4', bytes: Buffer.from('0000ftyp0000') },
  { extension: 'mov', bytes: Buffer.from('0000ftyp0000') },
  { extension: 'm4v', bytes: Buffer.from('0000ftyp0000') }
]) {
  // seed node: requiresEvidence:false, allowedEvidenceTypes:[]
  // download returns fixture.bytes; registration fileName uses fixture.extension
  // assert evidence metadata is created with the same extension
}
```

- [ ] **步骤 2：运行测试并确认 RED**

运行：

```powershell
node --test cloudfunctions/businessApi/test/cloud-evidence-repository.test.js
```

预期：七种登记均以 `UNSUPPORTED_FILE_TYPE` 失败，证明当前空数组被解释为“禁止全部”。

- [ ] **步骤 3：补有限白名单与损坏结构失败测试**

增加以下断言：

```js
// requiresEvidence:false + ['pdf']：PDF 成功，JPG 返回 UNSUPPORTED_FILE_TYPE。
// requiresEvidence:true + []：返回 UNSUPPORTED_FILE_TYPE，不得下载或写 evidences。
// allowedEvidenceTypes 为非数组、含重复项、含 exe、访问器或仅原型继承：失败关闭。
// 事务第一次授权后把空白名单改成 ['pdf']，登记 JPG 的第二次授权返回 UNSUPPORTED_FILE_TYPE。
```

- [ ] **步骤 4：实现严格纯函数**

在 `cloud-evidence-repository.js` 中复用现有 `ALL_EVIDENCE_TYPES`，新增严格读取：

```js
function ownDataValue(record, key) {
  if (!record || typeof record !== 'object') return { present: false, value: undefined }
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { present: true, value: descriptor.value }
    : { present: Boolean(descriptor), value: undefined }
}

function effectiveAllowedEvidenceTypes(node, accountSchema) {
  const key = accountSchema ? 'allowedEvidenceTypes' : 'evidenceTypes'
  const field = ownDataValue(node, key)
  const required = ownDataValue(node, 'requiresEvidence')
  if (!field.present || !Array.isArray(field.value) ||
      required.present && typeof required.value !== 'boolean' ||
      new Set(field.value).size !== field.value.length ||
      field.value.some(value => !ALL_EVIDENCE_TYPES.includes(value))) {
    throw createError('UNSUPPORTED_FILE_TYPE')
  }
  if (field.value.length) return field.value.slice()
  if (required.present && required.value === true) throw createError('UNSUPPORTED_FILE_TYPE')
  return ALL_EVIDENCE_TYPES.slice()
}
```

旧节点继续只读自有 `evidenceTypes`；新版账号节点只读自有 `allowedEvidenceTypes`，不允许混合回退。两者缺少 `requiresEvidence` 时都沿用既有快照兼容规则按非必传，字段存在但不是自有布尔数据属性时失败关闭。`authorizeRegistration()` 的两次调用均使用该函数。

- [ ] **步骤 5：运行服务端聚焦测试并确认 GREEN**

运行：

```powershell
node --test cloudfunctions/businessApi/test/evidence-policy.test.js cloudfunctions/businessApi/test/cloud-evidence-repository.test.js
```

预期：全部通过；真实签名错配、5/20 MB 限制、权限撤销和二次授权旧回归仍通过。

- [ ] **步骤 6：提交任务 1**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-evidence-repository.js cloudfunctions/businessApi/test/cloud-evidence-repository.test.js
git diff --cached --check
git commit -m "fix: 统一服务端可选凭证格式语义"
```

### 任务 2：模板配置界面明确三态语义

**文件：**

- 修改：`miniprogram/pages/admin-template-node-edit/index.wxml`
- 测试：`miniprogram/test/template-flow.test.js`

**接口：**

- 输入：现有页面数据 `requiresEvidence`、`allowedEvidenceTypes`、`evidenceTypeOptions`、`readOnly`。
- 产出：不改变模板 API 数据结构；只调整 WXML 展示和操作可达性。
- 后续依赖：任务 3 从业务安全投影读取同名字段，无新字段。

- [ ] **步骤 1：写模板页面失败测试**

在 `template-flow.test.js` 中读取 WXML 并断言：

```js
assert.match(wxml, /提交审核时必须上传凭证/)
assert.doesNotMatch(wxml, /checkbox-group[^>]*wx:if="{{requiresEvidence}}"/)
assert.match(wxml, /不限格式（仅限系统已支持格式）/)
```

再用页面对象验证：

```js
// requiresEvidence:false + []：buildNodeForSave() 原样保存空数组。
// requiresEvidence:false + ['pdf']：原样保存有限白名单。
// requiresEvidence:true + []：submit() 显示“要求凭证时至少选择一种凭证类型”，不提交。
```

- [ ] **步骤 2：运行模板聚焦测试并确认 RED**

运行：

```powershell
node --test miniprogram/test/template-flow.test.js
```

预期：WXML 仍只在必传时显示复选框，文案断言失败；现有数据保存测试继续通过。

- [ ] **步骤 3：最小修改 WXML**

把凭证区调整为：

```xml
<view class="field">
  <text class="field-label">凭证要求</text>
  <label><switch checked="{{requiresEvidence}}" disabled="{{readOnly}}" bindchange="onRequiresEvidenceChange" />提交审核时必须上传凭证</label>
  <text class="muted">未勾选时凭证可选；未选择格式表示不限格式（仅限系统已支持格式）。</text>
  <checkbox-group class="evidence-options" bindchange="onEvidenceTypesChange">
    <label wx:for="{{evidenceTypeOptions}}" wx:key="value">
      <checkbox value="{{item.value}}" checked="{{item.selected}}" disabled="{{readOnly}}" />{{item.label}}
    </label>
  </checkbox-group>
</view>
```

不修改 `buildNodeForSave()` 与服务端模板验证：必传空数组仍由页面和 `template-domain` 双重拦截。

- [ ] **步骤 4：运行模板和 WXML 测试并确认 GREEN**

运行：

```powershell
node --test miniprogram/test/template-flow.test.js
node tools/test-wxml-structure.mjs
```

预期：模板聚焦与 WXML 结构测试全部通过。

- [ ] **步骤 5：提交任务 2**

```powershell
git add -- miniprogram/pages/admin-template-node-edit/index.wxml miniprogram/test/template-flow.test.js
git diff --cached --check
git commit -m "fix: 明确模板可选凭证格式配置"
```

### 任务 3：处理页预检与中文安全错误

**文件：**

- 修改：`miniprogram/pages/node-feedback/index.js`
- 修改：`miniprogram/services/business.js`
- 测试：`miniprogram/test/node-feedback-v2.test.js`
- 测试：`miniprogram/test/admin-business-amend-flow.test.js`

**接口：**

- 输入：受保护业务详情中的 `requiresEvidence`、`allowedEvidenceTypes`，以及 `registerEvidenceUpload(input)` 的稳定服务端错误码。
- 产出：`effectiveClientEvidenceTypes(requiresEvidence, allowedEvidenceTypes): string[]`；`registerEvidenceUpload()` 失败只抛固定中文安全消息。

- [ ] **步骤 1：写客户端三态失败测试**

在 `node-feedback-v2.test.js` 增加：

```js
// 页面加载 requiresEvidence:false + allowedEvidenceTypes:[]。
// addSelectedFiles 依次加入 jpg/jpeg/png/pdf/mp4/mov/m4v，断言七个均进入待上传状态。
// 页面加载 requiresEvidence:false + ['pdf']，加入 JPG 时断言不进入列表并提示“当前节点不允许 JPG 格式”。
// 页面加载 requiresEvidence:true + []，断言页面失败关闭为只读，避免损坏快照变成允许全部。
```

- [ ] **步骤 2：写中文错误映射失败测试**

在 `admin-business-amend-flow.test.js` 中使用真实 `miniprogram/services/business.js` 的 `registerEvidenceUpload()`，让底层 `callBusinessApi` 抛出：

```js
Object.assign(new Error('UNSUPPORTED_FILE_TYPE: cloud://secret/path'), {
  code: 'UNSUPPORTED_FILE_TYPE'
})
```

断言业务服务抛出的安全错误消息仅为 `文件格式不受支持，请重新选择`，保留稳定 `code` 供程序判断，并确认调用使用 `{ silent: true }`；序列化结果不含 `cloud://` 或底层消息。页面聚焦测试另断言文件状态使用该固定中文消息。

- [ ] **步骤 3：运行客户端聚焦测试并确认 RED**

运行：

```powershell
node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js
```

预期：空数组虽可选择文件，但损坏的必传空数组没有失败关闭，且登记错误仍只得到通用或不一致提示。

- [ ] **步骤 4：实现客户端有效类型与错误映射**

在 `node-feedback/index.js` 增加并使用不可变支持集合：

```js
const ALL_EVIDENCE_TYPES = Object.freeze(['jpg', 'jpeg', 'png', 'pdf', 'mp4', 'mov', 'm4v'])

function effectiveClientEvidenceTypes(requiresEvidence, allowedTypes) {
  if (!Array.isArray(allowedTypes) || new Set(allowedTypes).size !== allowedTypes.length ||
      allowedTypes.some(value => !ALL_EVIDENCE_TYPES.includes(value))) return null
  if (allowedTypes.length) return allowedTypes.slice()
  return requiresEvidence ? null : ALL_EVIDENCE_TYPES.slice()
}
```

`loadData()` 只在该函数返回数组时启用页面，把结果保存到 `allowedEvidenceTypes`；返回 `null` 时抛固定中文错误并保持只读。`addSelectedFiles()` 始终检查有效集合，不再依赖“数组长度非零才检查”。

在 `miniprogram/services/business.js` 增加：

```js
UNSUPPORTED_FILE_TYPE: '文件格式不受支持，请重新选择',
FILE_TOO_LARGE: '文件大小超过限制，请重新选择',
EVIDENCE_NOT_ATTACHABLE: '当前凭证无法登记，请刷新后重试'
```

并将登记方法改为：

```js
function registerEvidenceUpload(input) {
  return callProtected('registerEvidenceUpload', input, '凭证上传失败，请重试')
}
```

- [ ] **步骤 5：运行客户端聚焦和结构测试并确认 GREEN**

运行：

```powershell
node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/review-flow.test.js miniprogram/test/admin-business-amend-flow.test.js
node tools/test-wxml-structure.mjs
```

预期：全部通过；上传失败异步失效、两步幂等提交、20 MB 总量和页面冻结回归保持通过。

- [ ] **步骤 6：提交任务 3**

```powershell
git add -- miniprogram/pages/node-feedback/index.js miniprogram/services/business.js miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js
git diff --cached --check
git commit -m "fix: 统一小程序可选凭证上传规则"
```

### 任务 4：完整回归、长期记忆与部署交接

**文件：**

- 修改：`docs/memory/PROJECT.md`
- 修改：`docs/memory/STATUS.md`

**接口：**

- 输入：任务 1—3 的冻结提交和真实测试输出。
- 产出：可恢复的项目状态、精确未验证边界以及 CloudBase 部署/真机复验步骤。

- [ ] **步骤 1：运行完整自动化门禁**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

预期：全部通过；任何失败都必须修复后从对应聚焦测试重新开始，不能写成“已知失败”。

- [ ] **步骤 2：检查语法、差异和敏感内容**

```powershell
node --check cloudfunctions/businessApi/lib/cloud-evidence-repository.js
node --check miniprogram/pages/node-feedback/index.js
node --check miniprogram/services/business.js
git diff --check
git status --short
```

确认差异只包含本计划文件，`project.config.json` 保持未暂存；测试或文档中不得出现真实 OpenID、云文件路径、密码或客户数据。

- [ ] **步骤 3：更新项目记忆**

在 `PROJECT.md` 的凭证规则中增加：

```markdown
非必传凭证的空格式白名单表示可选且允许全部七种系统支持格式；必传凭证仍要求非空白名单，非空白名单始终严格限制格式。
```

在 `STATUS.md` 记录：初始 RED 失败数、最终 GREEN 计数、完整回归计数、提交哈希，以及 `businessApi` 重新上传和真机复验仍为 `unverified`。

- [ ] **步骤 4：运行项目记忆校验**

```powershell
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

预期：`Project memory validation passed`。

- [ ] **步骤 5：提交文档与最终证据**

```powershell
git add -- docs/memory/PROJECT.md docs/memory/STATUS.md
git diff --cached --check
git commit -m "docs: 记录可选凭证规则验证结果"
```

- [ ] **步骤 6：独立复审后交付部署步骤**

复审必须重点核对：

```text
1. 只有严格合法的非必传空数组才能扩展为全部七种类型。
2. 服务端首次授权与下载后写入事务都重新推导白名单。
3. 模板必传空数组仍在前后端双重拒绝。
4. 中文错误不泄漏云路径或底层错误。
5. 既有业务无需迁移，60 天保留协议不变。
```

复审通过后，操作员仅需重新上传当前版本 `businessApi`；小程序重新编译/真机调试后，用无敏感内容的 JPG 复验 `evidences` 新增元数据和“保存处理进度”。失败验收遗留的无元数据云文件确认无用后再手动删除。
