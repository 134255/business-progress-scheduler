# 节点独立审核流程实施计划

> **供代理执行者使用：** REQUIRED SUB-SKILL：按任务逐项实施时，使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。所有跟踪步骤使用复选框语法。

**目标：** 将新版模板和业务节点升级为处理人提交、独立审核人确认、通过后自动流转的可审计工作流，同时保留旧业务兼容、不可变反馈、凭证生命周期和并发安全边界。

**架构：** 保留 `businessApi` 作为受保护业务入口，复用现有反馈预约和凭证分块认领机制；新增聚焦的审核领域、审核服务、审核仓储和工作时间服务。模板把处理人、审核人、模式和双 SLA 快照到新版业务节点，`node_review_rounds` 与 `node_review_votes` 分别保存审核轮次和不可变投票；旧业务节点通过缺少 `workflowMode: review` 的明确适配边界继续使用旧流程。

**技术栈：** 原生微信小程序 JavaScript/WXML/WXSS、腾讯 CloudBase 文档数据库与云函数、Node.js 内置测试运行器、`wx-server-sdk@4.0.2`。

## 全局约束

- 每项可执行变更严格执行测试驱动：先写聚焦失败测试并观察预期失败，再做最小实现，最后运行聚焦和回归测试。
- `wx-server-sdk` 固定为 `4.0.2`，未经项目所有者批准不新增运行时依赖。
- 新版模板节点必须保存 `workflowMode: review`、`processorUserIds`、`reviewerUserIds`、`reviewMode`、`processingSlaWorkHours` 和 `reviewSlaWorkHours`。
- 处理人和审核人均使用内部账号文档编号；同一节点两组账号不得重叠，不得使用 OpenID 回退授权。
- 默认处理时限为 22 个工作小时，默认审核时限为 8 个工作小时；工作时间为 09:00—20:00，无午休。
- `work_calendar` 是中国工作日规则的权威缓存；日期缺失或格式损坏时不得猜测周末或法定节假日。节点仍进入处理或审核状态，截止时间保存为待补算；同步恢复后由补算任务写回。
- 图片单文件不超过 5 MB，PDF/视频单文件不超过 20 MB；同一处理轮次参与审核的有效凭证合计不超过 20 MB，文件数量不设业务上限。
- 普通凭证继续按业务终态后的 60 个自然日统一清理；审核轮次只引用凭证，不复制云文件。
- 新版流程只有审核通过才能完成节点；处理人只能保存进度、标记受阻和提交审核。
- 或签首个通过即结束；会签全部通过才结束；任一模式下任一驳回立即结束并进入返工。
- 所有写操作在事务中重新读取当前账号、业务线、节点、版本和审核轮次；失效账号、旧页面和过期绑定必须失败关闭。
- 旧业务不补造审核历史；旧写入口不能操作 `workflowMode: review` 节点。
- `evidenceRetention` 的真实触发器保持 `triggers: []`，本计划不得顺带启用云端定时清理。
- `calendarSync` 和 `workflowReminder` 初次部署也保持空触发器；只有手工验收通过并获得项目所有者单独批准后，才配置每日同步和小时提醒。
- 每项任务结束时更新 `docs/memory/STATUS.md`，记录实现范围、精确验证、人工操作、剩余风险和 Git 状态。
- 只暂存任务明确列出的路径，不使用宽泛暂存命令。

---

## 计划文件结构

### 后端领域与仓储

- `cloudfunctions/businessApi/lib/review-domain.js`：审核模式、处理动作、投票输入和确定性编号规则。
- `cloudfunctions/businessApi/lib/work-time-service.js`：按缓存日历计算工作分钟、截止时间和累计耗时。
- `cloudfunctions/businessApi/lib/cloud-work-calendar-repository.js`：只读 `work_calendar` 日期规则，明确区分可计算、缺失和损坏。
- `cloudfunctions/businessApi/lib/review-service.js`：提交审核、投票、待办和审核详情用例。
- `cloudfunctions/businessApi/lib/cloud-review-repository.js`：审核轮次、投票、自动流转、返工、通知和审计事务。
- `cloudfunctions/businessApi/lib/template-domain.js`：新版节点角色、模式和双 SLA 规范化。
- `cloudfunctions/businessApi/lib/template-service.js`：新版模板启用校验和参与账号汇总。
- `cloudfunctions/businessApi/lib/cloud-template-repository.js`：处理人、审核人状态复核和事务预算。
- `cloudfunctions/businessApi/lib/cloud-business-repository.js`：新版节点快照、成员范围、首节点处理截止时间和旧业务适配。
- `cloudfunctions/businessApi/lib/feedback-service.js`：新版处理动作校验及审核提交前的最新草稿构建。
- `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`：保存进度/受阻版本、当前处理轮次聚合和待审核写锁。
- `cloudfunctions/businessApi/index.js`：审核服务装配、受保护路由和安全错误码。

### 小程序

- `miniprogram/pages/admin-template-node-edit/*`：处理人、审核人、审核模式和双 SLA 编辑。
- `miniprogram/pages/admin-template-edit/*`：节点审核配置摘要和只读展示。
- `miniprogram/pages/node-feedback/*`：保存进度、标记受阻、提交审核和待审核只读。
- `miniprogram/pages/review-list/*`：当前账号待审核列表。
- `miniprogram/pages/review-detail/*`：审核字段、凭证、投票进度、通过和驳回。
- `miniprogram/pages/notification-list/*`：当前账号站内通知、未读状态和安全业务入口。
- `miniprogram/pages/dashboard/*`：待我处理和待我审核计数与入口。
- `miniprogram/pages/business-detail/*`：审核状态、双 SLA、轮次和自动流转展示。
- `miniprogram/services/business.js`：审核与通知受保护接口封装。
- `miniprogram/app.json`：注册审核页面。

### 提醒与运维

- `cloudfunctions/calendarSync/index.js`：当前年与下一年法定节假日同步、待计算截止时间补算入口。
- `cloudfunctions/calendarSync/lib/holiday-api-client.js`：解析 AILCC 全年接口的 `code/year/count/data` 与每日 `date/is_holiday`。
- `cloudfunctions/calendarSync/lib/calendar-sync-service.js`：先校验全年数据，再幂等保存日历并分批补算待计算节点和审核轮次。
- `cloudfunctions/calendarSync/lib/cloud-calendar-repository.js`：日历版本、日期记录、待补算候选和事务写回。
- `cloudfunctions/workflowReminder/index.js`：独立小时级提醒云函数入口。
- `cloudfunctions/workflowReminder/lib/reminder-service.js`：处理提醒和审核提醒编排。
- `cloudfunctions/workflowReminder/lib/cloud-reminder-repository.js`：到期候选、确定性通知和下一提醒时间更新。
- `cloudfunctions/workflowReminder/lib/work-time-service.js`：提醒函数内可部署的工作时间计算实现，与业务函数使用同一测试向量。
- `docs/deployment/template-node-fields-setup.md`：新集合、索引、函数、回退与人工验收。

---

### Task 1：建立审核领域规则与新版模板节点契约

**文件：**
- 新建：`cloudfunctions/businessApi/lib/review-domain.js`
- 新建：`cloudfunctions/businessApi/test/review-domain.test.js`
- 修改：`cloudfunctions/businessApi/lib/template-domain.js`
- 修改：`cloudfunctions/businessApi/test/template-domain.test.js`

**接口：**
- 产出：`WORKFLOW_MODE`、`REVIEW_MODES`、`WORK_ACTIONS`、`normalizeReviewMode(value)`、`normalizeWorkAction(value)`、`normalizeVoteInput(input)`、`deterministicVoteId(roundId, reviewerUserId)`。
- 产出：`normalizeTemplateNode(input)` 返回新版处理人、审核人、模式和双 SLA；`validateTemplateForEnable(...)` 校验账号启用与角色分离。
- 错误：模板定义错误为 `TEMPLATE_INVALID`；角色交集为 `ROLE_OVERLAP`；处理人或审核人失效分别为 `PROCESSOR_INACTIVE`、`REVIEWER_INACTIVE`。

- [ ] **Step 1：写入审核规则和模板契约失败测试**

在 `review-domain.test.js` 写入：

```js
test('审核模式、动作和投票输入采用封闭枚举', () => {
  assert.equal(normalizeReviewMode('any'), 'any')
  assert.equal(normalizeWorkAction('submit_review'), 'submit_review')
  assert.deepEqual(normalizeVoteInput({ decision: 'rejected', comment: '资料不完整' }), {
    decision: 'rejected', comment: '资料不完整'
  })
  assert.throws(() => normalizeVoteInput({ decision: 'rejected', comment: '' }),
    error => error.code === 'REVIEW_COMMENT_REQUIRED')
})

test('投票编号由轮次和审核人确定性生成', () => {
  assert.equal(deterministicVoteId('round-a', 'user-a'), deterministicVoteId('round-a', 'user-a'))
  assert.notEqual(deterministicVoteId('round-a', 'user-a'), deterministicVoteId('round-a', 'user-b'))
})
```

在 `template-domain.test.js` 增加包含 `processorUserIds`、`reviewerUserIds`、`reviewMode` 和双 SLA 的规范化测试，并明确覆盖空负责人、停用账号、角色重叠和末节点缺审核人。

- [ ] **Step 2：运行聚焦测试并观察预期失败**

运行：

```powershell
node --test cloudfunctions/businessApi/test/review-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js
```

预期：失败，原因是 `review-domain.js` 尚不存在，旧模板领域也不认识新版字段。

- [ ] **Step 3：实现最小领域规则**

`review-domain.js` 的公共边界采用：

```js
const crypto = require('node:crypto')
const WORKFLOW_MODE = 'review'
const REVIEW_MODES = new Set(['any', 'all'])
const WORK_ACTIONS = new Set(['save_progress', 'mark_blocked', 'submit_review'])

function deterministicVoteId(roundId, reviewerUserId) {
  const digest = crypto.createHash('sha256').update(`${roundId}\0${reviewerUserId}`).digest('hex')
  return `review-vote-${digest}`
}
```

`normalizeTemplateNode` 对新版输入固定写入：

```js
{
  workflowMode: WORKFLOW_MODE,
  processorUserIds,
  reviewerUserIds,
  reviewMode,
  processingSlaWorkHours,
  reviewSlaWorkHours,
  // 保留名称、字段与凭证规则
}
```

启用校验使用两个集合分别验证启用账号，并在交集非空时抛出 `ROLE_OVERLAP`。

- [ ] **Step 4：运行领域测试和既有模板回归**

运行：

```powershell
node --test cloudfunctions/businessApi/test/review-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/field-domain.test.js
```

预期：全部通过，0 失败。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- cloudfunctions/businessApi/lib/review-domain.js cloudfunctions/businessApi/lib/template-domain.js cloudfunctions/businessApi/test/review-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js docs/memory/STATUS.md
git commit -m "feat: 建立节点审核领域规则"
```

---

### Task 2：持久化模板审核配置并重算事务预算

**文件：**
- 修改：`cloudfunctions/businessApi/lib/template-service.js`
- 修改：`cloudfunctions/businessApi/lib/cloud-template-repository.js`
- 修改：`cloudfunctions/businessApi/test/template-service.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-template-repository.test.js`
- 修改：`cloudfunctions/businessApi/test/helpers/template-harness.js`

**接口：**
- 消费：Task 1 的规范化模板节点。
- 产出：`allParticipantUserIds(nodes)`，合并处理人和审核人并去重排序。
- 约束：模板创建、更新、启用和可用性查询均读取全部参与账号；`节点文档数 + 不同参与账号数 + 固定事务操作数` 不得超过 100。

- [ ] **Step 1：写入模板仓储失败测试**

新增测试证明：

```js
test('模板保存和启用同时复核处理人及审核人', async () => {
  const definition = createDefinition({
    nodes: [createNode({ processorUserIds: ['processor-a'], reviewerUserIds: ['reviewer-a'] })]
  })
  await repository.createTemplateDefinition({
    actor: superAdmin, participantUserIds: ['processor-a', 'reviewer-a'], definition, audit: { action: 'create' }
  })
  assert.equal(fake.readCount('users', 'processor-a') > 0, true)
  assert.equal(fake.readCount('users', 'reviewer-a') > 0, true)
})
```

再加入一个达到事务边界的模板，证明模板不会被显示为可用后又在业务创建时因参与账号预算失败。

- [ ] **Step 2：运行聚焦测试并观察预期失败**

运行：

```powershell
node --test cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js
```

预期：失败，旧服务只汇总 `assigneeUserIds`，仓储未读取审核人。

- [ ] **Step 3：实现参与账号汇总和预算校验**

服务层统一使用：

```js
function allParticipantUserIds(nodes) {
  return [...new Set(nodes.flatMap(node => [
    ...node.processorUserIds,
    ...node.reviewerUserIds
  ]))].sort()
}
```

把仓储参数从 `assigneeUserIds` 改为 `participantUserIds`；在同一模板事务中逐个读取启用账号，任何缺失或停用都失败关闭。可用性投影对处理人失效返回 `PROCESSOR_INACTIVE`，审核人失效返回 `REVIEWER_INACTIVE`，角色交集返回 `ROLE_OVERLAP`。

- [ ] **Step 4：运行模板全组回归**

```powershell
node --test cloudfunctions/businessApi/test/template-domain.test.js cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js
```

预期：全部通过，0 失败，并保留 48 节点与 100 次文档操作门禁。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- cloudfunctions/businessApi/lib/template-service.js cloudfunctions/businessApi/lib/cloud-template-repository.js cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js cloudfunctions/businessApi/test/helpers/template-harness.js docs/memory/STATUS.md
git commit -m "feat: 持久化模板审核配置"
```

---

### Task 3：升级超级管理员模板节点编辑页面

**文件：**
- 修改：`miniprogram/pages/admin-template-node-edit/index.js`
- 修改：`miniprogram/pages/admin-template-node-edit/index.wxml`
- 修改：`miniprogram/pages/admin-template-node-edit/index.wxss`
- 修改：`miniprogram/pages/admin-template-edit/index.js`
- 修改：`miniprogram/pages/admin-template-edit/index.wxml`
- 修改：`miniprogram/test/template-flow.test.js`
- 修改：`tools/test-wxml-structure.mjs`

**接口：**
- 消费：模板服务返回的新版节点字段。
- 产出：页面保存对象只包含内部账号编号，不通过 URL、dataset 或日志传递完整账号对象。
- 兼容：打开旧模板节点时，把旧 `assigneeUserIds` 只作为处理人初始值；重新保存后写入新版明确字段。

- [ ] **Step 1：写入客户端失败测试**

在 `template-flow.test.js` 增加：

```js
test('节点编辑分别保存处理人审核人模式和双时限', async () => {
  const page = createNodeEditor({ users: [processor, reviewer] })
  page.onProcessorToggle({ currentTarget: { dataset: { id: processor._id } } })
  page.onReviewerToggle({ currentTarget: { dataset: { id: reviewer._id } } })
  page.onReviewModeChange({ detail: { value: 'all' } })
  page.onProcessingSlaInput({ detail: { value: '22' } })
  page.onReviewSlaInput({ detail: { value: '8' } })
  const node = page.buildNodeForSave()
  assert.deepEqual(node.processorUserIds, [processor._id])
  assert.deepEqual(node.reviewerUserIds, [reviewer._id])
  assert.equal(node.reviewMode, 'all')
})
```

另加角色重叠、空审核人、只读模板和异步账号失效后的失败关闭测试。

- [ ] **Step 2：运行客户端测试并观察预期失败**

```powershell
node --test miniprogram/test/template-flow.test.js
```

预期：失败，因为页面仍只有负责人和单一 SLA。

- [ ] **Step 3：实现双角色表单和只读摘要**

页面状态采用：

```js
{
  processorUserIds: [],
  reviewerUserIds: [],
  reviewMode: 'any',
  processingSlaWorkHours: 22,
  reviewSlaWorkHours: 8
}
```

保存前同步拒绝角色交集，提示“处理人与审核人不能为同一账号”。模板节点摘要显示“处理人 N 人 · 审核人 M 人 · 或签/会签 · 处理 22 小时 · 审核 8 小时”。

- [ ] **Step 4：运行客户端与 WXML 门禁**

```powershell
node --test miniprogram/test/template-flow.test.js
node tools/test-wxml-structure.mjs
```

预期：全部通过，0 失败。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- miniprogram/pages/admin-template-node-edit/index.js miniprogram/pages/admin-template-node-edit/index.wxml miniprogram/pages/admin-template-node-edit/index.wxss miniprogram/pages/admin-template-edit/index.js miniprogram/pages/admin-template-edit/index.wxml miniprogram/test/template-flow.test.js tools/test-wxml-structure.mjs docs/memory/STATUS.md
git commit -m "feat: 增加模板节点审核配置界面"
```

---

### Task 4：实现中国工作时间计算、日历同步和待计算补算

**文件：**
- 新建：`cloudfunctions/businessApi/lib/work-time-service.js`
- 新建：`cloudfunctions/businessApi/lib/cloud-work-calendar-repository.js`
- 新建：`cloudfunctions/businessApi/test/work-time-service.test.js`
- 新建：`cloudfunctions/businessApi/test/cloud-work-calendar-repository.test.js`
- 新建：`cloudfunctions/calendarSync/package.json`
- 新建：`cloudfunctions/calendarSync/package-lock.json`
- 新建：`cloudfunctions/calendarSync/index.js`
- 新建：`cloudfunctions/calendarSync/lib/holiday-api-client.js`
- 新建：`cloudfunctions/calendarSync/lib/calendar-sync-service.js`
- 新建：`cloudfunctions/calendarSync/lib/cloud-calendar-repository.js`
- 新建：`cloudfunctions/calendarSync/test/holiday-api-client.test.js`
- 新建：`cloudfunctions/calendarSync/test/calendar-sync-service.test.js`
- 新建：`cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js`
- 新建：`cloudfunctions/calendarSync/test/scheduled-entry.test.js`

**接口：**
- 产出：`createWorkTimeService({ calendarRepository })`。
- 方法：`tryAddWorkMinutes(startAt, minutes)`、`workingMinutesBetween(startAt, endAt)`、`nextWorkInstant(at)`。
- 日历接口：`calendarRepository.getDayRule('YYYY-MM-DD') -> { date, isWorkday }`。
- 计算结果：覆盖完整时返回 `{ status: 'calculated', dueAt, calendarVersion }`；所需日期缺失或损坏时返回 `{ status: 'pending_calendar', dueAt: null, missingDate }`，不得推断周末。
- 同步入口：`calendarSync.main({ mode: 'scheduled' | 'manual', now })`，默认同步上海时区当前年和下一年，然后分批补算 `processingDueStatus` 或 `reviewDueStatus` 为 `pending_calendar` 的记录。
- AILCC 契约：`GET https://holiday.ailcc.com/api/holiday/allyear/{year}`；仅接受 `code === 0`、年份一致、`count` 与数组长度一致、覆盖该年每个自然日且日期唯一、`is_holiday` 严格为 `0` 或 `1` 的全年数据。

- [ ] **Step 1：写入跨日和节假日失败测试**

```js
test('15点开始的8个工作小时在次日12点到期', async () => {
  const service = createWorkTimeService({ calendarRepository: allWorkdays() })
  const result = await service.tryAddWorkMinutes(new Date('2026-08-11T15:00:00+08:00'), 8 * 60)
  assert.equal(result.status, 'calculated')
  assert.equal(result.dueAt.toISOString(), '2026-08-12T04:00:00.000Z')
})

test('法定休息日不累计工作分钟', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({
    '2026-10-01': false, '2026-10-02': false, '2026-10-03': true
  }) })
  const result = await service.tryAddWorkMinutes(new Date('2026-09-30T19:00:00+08:00'), 2 * 60)
  assert.equal(result.dueAt.toISOString(), '2026-10-03T02:00:00.000Z')
})

test('日历缺失时返回待补算而不猜测周末', async () => {
  const service = createWorkTimeService({ calendarRepository: rules({}) })
  const result = await service.tryAddWorkMinutes(new Date('2026-08-11T15:00:00+08:00'), 8 * 60)
  assert.deepEqual(result, {
    status: 'pending_calendar',
    dueAt: null,
    missingDate: '2026-08-11'
  })
})
```

增加 09:00 前、20:00 后、零分钟、反向区间、缺失日期、损坏日期记录、接口非零状态码、年份不一致、重复日期、非法 `is_holiday`、网络失败保留旧缓存、当前年加下一年同步，以及补算时节点版本已变化不覆盖的测试。

- [ ] **Step 2：运行聚焦测试并观察预期失败**

```powershell
node --test cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/cloud-work-calendar-repository.test.js
npm.cmd test --prefix cloudfunctions/calendarSync
```

预期：失败，因为工作时间服务、日历同步函数和仓储尚不存在。

- [ ] **Step 3：实现分钟级计算器、原子同步和安全补算**

服务固定：

```js
const WORK_START_MINUTE = 9 * 60
const WORK_END_MINUTE = 20 * 60
const MINUTES_PER_WORKDAY = 11 * 60
```

所有日期键按 `Asia/Shanghai` 生成；服务逐日读取权威规则，只在 `isWorkday === true` 且位于 09:00—20:00 时累计。仓储只接受文档编号等于日期键且 `isWorkday` 为严格布尔值的记录；缺失或损坏返回待补算结果，不抛出可被调用方误当作节点创建失败的异常。

同步器先在内存中完整校验某一年的返回数据，再按日期幂等写入 `{ date, isWorkday, source: 'ailcc', sourceYear, sourceVersion, syncedAt }`。任何网络、结构或覆盖错误都不得删除或部分覆盖现有有效缓存；当前年和下一年分别记录同步结果。待补算任务每批最多读取 40 个候选，并在逐条事务中重新读取业务、节点或审核轮次及其版本；仅当仍处于相同活动状态且截止时间仍待补算时写回截止时间、日历版本和管理员通知处理状态。

- [ ] **Step 4：运行工作时间测试和语法检查**

```powershell
node --test cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/cloud-work-calendar-repository.test.js
npm.cmd test --prefix cloudfunctions/calendarSync
node --check cloudfunctions/businessApi/lib/work-time-service.js
node --check cloudfunctions/businessApi/lib/cloud-work-calendar-repository.js
node --check cloudfunctions/calendarSync/index.js
```

预期：全部通过，0 失败。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- cloudfunctions/businessApi/lib/work-time-service.js cloudfunctions/businessApi/lib/cloud-work-calendar-repository.js cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/cloud-work-calendar-repository.test.js cloudfunctions/calendarSync/package.json cloudfunctions/calendarSync/package-lock.json cloudfunctions/calendarSync/index.js cloudfunctions/calendarSync/lib/holiday-api-client.js cloudfunctions/calendarSync/lib/calendar-sync-service.js cloudfunctions/calendarSync/lib/cloud-calendar-repository.js cloudfunctions/calendarSync/test/holiday-api-client.test.js cloudfunctions/calendarSync/test/calendar-sync-service.test.js cloudfunctions/calendarSync/test/cloud-calendar-repository.test.js cloudfunctions/calendarSync/test/scheduled-entry.test.js docs/memory/STATUS.md
git commit -m "feat: 增加工作日历同步与截止时间补算"
```

---

### Task 5：创建新版业务节点快照和首节点处理时限

**文件：**
- 修改：`cloudfunctions/businessApi/lib/cloud-business-repository.js`
- 修改：`cloudfunctions/businessApi/lib/business-service.js`
- 修改：`cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- 修改：`cloudfunctions/businessApi/test/business-service.test.js`
- 修改：`cloudfunctions/businessApi/test/helpers/business-harness.js`

**接口：**
- 消费：模板节点新版契约和 Task 4 工作时间服务。
- 产出：新 `business_nodes` 保存处理人、审核人、审核模式、双 SLA、`processingRoundNumber: 1` 和 `workflowMode: review`。
- 成员：`memberUserIds` 包含创建人、全部处理人和全部审核人。
- 兼容：旧业务节点继续读取 `assigneeUserIds`；新节点不写旧 OpenID 关系字段。

- [ ] **Step 1：写入快照和预算失败测试**

```js
test('业务快照包含审核策略且模板后改不影响实例', async () => {
  const result = await repository.createBusinessSnapshot({ actor, input, definition })
  const first = fake.document('business_nodes', `${result.id}-node-001`)
  assert.equal(first.workflowMode, 'review')
  assert.deepEqual(first.processorUserIds, ['processor-a'])
  assert.deepEqual(first.reviewerUserIds, ['reviewer-a'])
  assert.equal(first.processingRoundNumber, 1)
  assert.equal(first.reviewSlaWorkHours, 8)
})
```

增加参与账号停用、成员范围、首节点 `processingDueAt/processingDueStatus`、日历缺失时业务仍创建且截止时间待补算、其余节点无活动截止时间、事务预算和旧业务读取测试。

- [ ] **Step 2：运行业务仓储测试并观察预期失败**

```powershell
node --test cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js
```

预期：失败，旧快照只复制 `assigneeUserIds` 和单一 SLA。

- [ ] **Step 3：实现新版快照和首节点时限**

构造节点快照时保存：

```js
{
  workflowMode: 'review',
  processorUserIds: clone(source.processorUserIds),
  reviewerUserIds: clone(source.reviewerUserIds),
  reviewMode: source.reviewMode,
  processingSlaWorkHours: source.processingSlaWorkHours,
  reviewSlaWorkHours: source.reviewSlaWorkHours,
  processingRoundNumber: 1,
  status: index === 0 ? 'ready' : 'waiting'
}
```

首节点在预约业务前通过工作时间服务计算截止结果：可计算时保存 `processingDueStatus: 'calculated'`、`processingDueAt` 和日历版本；日历缺失时保存 `processingDueStatus: 'pending_calendar'`、`processingDueAt: null` 和安全告警标志。事务中重新验证模板版本、创建人和全部参与账号，共享预算函数以不同参与账号总数计费；业务发布后再用确定性编号在独立小事务中创建不含业务字段内容的管理员站内通知，通知失败不得回滚已发布业务，`calendarSync` 也会补建缺失告警。

- [ ] **Step 4：运行业务、模板和编号回归**

```powershell
node --test cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/business-numbering.test.js
```

预期：全部通过，0 失败，编号与创建幂等保持不变。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/lib/business-service.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/helpers/business-harness.js docs/memory/STATUS.md
git commit -m "feat: 快照化节点审核策略"
```

---

### Task 6：保存处理版本并原子创建审核轮次

**文件：**
- 修改：`cloudfunctions/businessApi/lib/feedback-service.js`
- 修改：`cloudfunctions/businessApi/lib/cloud-feedback-repository.js`
- 新建：`cloudfunctions/businessApi/lib/review-service.js`
- 新建：`cloudfunctions/businessApi/lib/cloud-review-repository.js`
- 修改：`cloudfunctions/businessApi/test/feedback-service.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- 新建：`cloudfunctions/businessApi/test/review-service.test.js`
- 新建：`cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- 修改：`cloudfunctions/businessApi/test/helpers/feedback-harness.js`

**接口：**
- 产出：`feedbackService.saveNodeProgress({ actor, input })`，动作仅为 `save_progress` 或 `mark_blocked`。
- 产出：`reviewService.submitNodeForReview({ actor, input })`。
- 仓储：`getCurrentProcessingRoundDraft(...)` 分页聚合当前轮最新字段快照和全部有效凭证；`createReviewRound(...)` 原子写入审核轮次并锁定节点。
- 幂等：审核轮次编号固定为 `review-${feedbackId}`；请求键只保存摘要。

- [ ] **Step 1：写入处理动作和提交审核失败测试**

```js
test('处理人不能直接完成新版节点', async () => {
  await assert.rejects(
    service.saveNodeProgress({ actor: processor, input: { ...baseInput, action: 'completed' } }),
    error => error.code === 'VALIDATION_ERROR'
  )
})

test('提交审核采用当前轮最新字段和全部有效凭证', async () => {
  const result = await reviewService.submitNodeForReview({
    actor: processor,
    input: { businessLineId: 'line-a', nodeId: 'node-a', expectedNodeVersion: 4, requestKey: 'review-1' }
  })
  assert.equal(result.nodeStatus, 'pending_review')
  assert.deepEqual(result.evidenceIds, ['evidence-a', 'evidence-b'])
})
```

仓储测试覆盖保存进度、受阻原因必填、待审核锁定、相同请求幂等、不同输入冲突、账号停用、角色移除、节点版本变化、分页聚合、20 MB 总量，以及日历缺失时审核轮次仍创建但 `reviewDueStatus` 为待补算。

- [ ] **Step 2：运行聚焦测试并观察预期失败**

```powershell
node --test cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

预期：失败，因为旧反馈仍允许 `completed`，审核服务和审核仓储尚不存在。

- [ ] **Step 3：复用反馈预约并实现审核提交事务**

保存进度继续复用现有分块认领，发布反馈时写入：

```js
{
  action,
  status: action === 'mark_blocked' ? 'blocked' : 'in_progress',
  processingRoundNumber: node.processingRoundNumber,
  blockedReason: action === 'mark_blocked' ? comment : ''
}
```

提交审核先读取当前处理轮次不可变版本，取最后字段快照并按首次出现顺序去重有效凭证；随后事务重新读取当前账号、业务线、节点和版本，创建 `node_review_rounds`，把节点切换为 `pending_review`，保存剩余处理工作分钟、审核截止结果和 `activeReviewRoundId`，并写入一条确定性审核开始通知及审计记录。若日历缺失，轮次使用 `reviewDueStatus: 'pending_calendar'` 和 `reviewDueAt: null`，不得阻断提交审核。

旧 `submitFeedback` 仅允许缺少 `workflowMode: review` 的旧节点；新版节点调用旧完成入口返回 `NODE_PENDING_REVIEW`。

- [ ] **Step 4：运行反馈与审核提交回归**

```powershell
node --test cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

预期：全部通过，0 失败；现有 105 个凭证分块与不超过 100 次事务操作测试继续通过。

- [ ] **Step 5：更新 ADR-0003、状态并提交明确路径**

在 `ADR-0003` 增加审核提交只引用已认领凭证、不重复改写附件归属的后果说明，然后运行：

```powershell
git add -- cloudfunctions/businessApi/lib/feedback-service.js cloudfunctions/businessApi/lib/cloud-feedback-repository.js cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/helpers/feedback-harness.js docs/memory/decisions/ADR-0003-feedback-evidence-reservations.md docs/memory/STATUS.md
git commit -m "feat: 提交节点处理结果进入审核"
```

---

### Task 7：实现或签、会签、驳回返工和自动流转

**文件：**
- 修改：`cloudfunctions/businessApi/lib/review-service.js`
- 修改：`cloudfunctions/businessApi/lib/cloud-review-repository.js`
- 修改：`cloudfunctions/businessApi/test/review-service.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- 修改：`cloudfunctions/businessApi/test/helpers/fake-cloud-database.js`

**接口：**
- 产出：`submitReviewVote({ actor, input })`。
- 输入：`reviewRoundId`、`expectedRoundVersion`、`decision`、`comment`、`requestKey`。
- 结果：`{ reviewRoundId, status, nodeStatus, lineStatus, nextNodeId }`。
- 事务规则：先重新校验当前账号、关系、业务、节点、轮次和版本，再解释已有投票或最终状态。

- [ ] **Step 1：写入投票矩阵和并发失败测试**

至少包含：

```js
test('或签首个通过只流转一次', async () => {
  const results = await Promise.allSettled([
    service.submitReviewVote({ actor: reviewerA, input: approveInput }),
    service.submitReviewVote({ actor: reviewerB, input: approveInputB })
  ])
  assert.equal(results.filter(item => item.status === 'fulfilled').length >= 1, true)
  assert.equal(fake.documents('business_nodes').filter(node => node.status === 'ready').length, 1)
})

test('会签任一驳回立即进入返工且原因必填', async () => {
  const result = await service.submitReviewVote({ actor: reviewerA, input: rejectInput('字段不完整') })
  assert.equal(result.status, 'rejected')
  assert.equal(fake.document('business_nodes', 'node-a').processingRoundNumber, 2)
})
```

矩阵还要覆盖：会签逐票通过、同票重试、改票冲突、停用审核人、移除审核人、业务冻结、节点版本变化、通过与驳回并发、末节点完成及 60 天保留期，以及返工或下一节点激活时日历缺失仍完成状态流转并标记处理截止时间待补算。

- [ ] **Step 2：运行审核仓储测试并观察预期失败**

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js
```

预期：失败，因为 Task 6 只建立审核轮次，尚未实现最终投票流转。

- [ ] **Step 3：实现确定性投票和单点状态推进**

投票事务顺序固定为：

```js
const actor = await readDocument(transaction, 'users', actorId)
const line = await readDocument(transaction, 'business_lines', lineId)
const node = await readDocument(transaction, 'business_nodes', nodeId)
const round = await readDocument(transaction, 'node_review_rounds', roundId)
assertCurrentReviewAuthorization(actor, line, node, round, input)
const vote = await readDocument(transaction, 'node_review_votes', deterministicVoteId(roundId, actorId))
```

完成授权后才能判断幂等结果或冲突。驳回时增加 `processingRoundNumber`，恢复累计处理剩余分钟并计算新的处理截止结果；通过时完成当前节点并为下一节点计算处理截止结果。日历缺失时仍完成返工或节点推进，只把相应 `processingDueStatus` 设为 `pending_calendar` 并通知管理员；末节点沿用 ADR-0003 的统一 60 天保留期。所有最终状态只允许一个事务写入。

- [ ] **Step 4：运行真实重叠事务和全反馈回归**

```powershell
node --test cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/fake-cloud-database.test.js
```

预期：全部通过，乐观事务测试观测到回调重叠、至少一次冲突重试和唯一最终流转。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/helpers/fake-cloud-database.js docs/memory/STATUS.md
git commit -m "feat: 完成节点审核投票与自动流转"
```

---

### Task 8：接入受保护审核路由和安全查询投影

**文件：**
- 修改：`cloudfunctions/businessApi/index.js`
- 修改：`cloudfunctions/businessApi/lib/review-service.js`
- 修改：`cloudfunctions/businessApi/lib/cloud-review-repository.js`
- 修改：`cloudfunctions/businessApi/lib/cloud-business-repository.js`
- 修改：`cloudfunctions/businessApi/test/account-routes.test.js`
- 修改：`cloudfunctions/businessApi/test/review-service.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-business-repository.test.js`

**接口：**
- 路由：`submitNodeForReview`、`submitReviewVote`、`listMyPendingReviews`、`getReviewDetail`。
- 通知路由：`listMyNotifications`、`markNotificationRead`；只允许读取或更新当前账号自己的通知。
- 详情投影：字段快照、可访问凭证编号、审核模式、已投票账号安全显示名、截止时间和当前账号可执行动作。
- 业务详情投影：节点处理/审核负责人安全显示名、轮次、双截止时间、双逾期时长和审核状态。

- [ ] **Step 1：写入路由、脱敏和权限失败测试**

```js
test('审核路由只使用解析后的当前账号', async () => {
  const result = await harness.api.main({
    action: 'submitReviewVote',
    payload: { reviewRoundId: 'round-a', actorId: 'forged', decision: 'approved', comment: '', requestKey: 'vote-a' }
  })
  assert.equal(result.ok, true)
  assert.equal(calls[0].actorId, activeReviewer._id)
})
```

增加未登录、普通成员读取他人审核、待审核人列表、通知仅返回当前账号且不可越权标记已读、凭证内部字段泄漏、未知错误安全映射、`creating` 业务隐藏和旧业务读取测试。

- [ ] **Step 2：运行路由和查询测试并观察预期失败**

```powershell
node --test cloudfunctions/businessApi/test/account-routes.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js
```

预期：失败，因为审核服务尚未装配到默认 `businessApi`，查询投影也未暴露。

- [ ] **Step 3：装配服务、错误码和查询投影**

在 `createDefaultBusinessApi` 注入工作时间、审核仓储和审核服务，并把审核及通知方法加入 `protectedRoutes`。`LOGGABLE_ERROR_CODES` 只加入设计中明确的审核业务错误；没有应用标记的异常继续映射为 `INTERNAL_ERROR`。

审核详情不得返回账号凭据、OpenID、原始文件编号、哈希、预约摘要或内部租约。凭证查看继续调用现有 `getEvidenceAccess` 获取五分钟临时地址。

- [ ] **Step 4：运行聚焦和完整后端回归**

```powershell
node --test cloudfunctions/businessApi/test/account-routes.test.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

预期：全部通过，0 失败。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- cloudfunctions/businessApi/index.js cloudfunctions/businessApi/lib/review-service.js cloudfunctions/businessApi/lib/cloud-review-repository.js cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/test/account-routes.test.js cloudfunctions/businessApi/test/review-service.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js docs/memory/STATUS.md
git commit -m "feat: 开放受保护节点审核接口"
```

---

### Task 9：构建处理、审核、概览与业务详情界面

**文件：**
- 修改：`miniprogram/services/business.js`
- 修改：`miniprogram/pages/node-feedback/index.js`
- 修改：`miniprogram/pages/node-feedback/index.wxml`
- 修改：`miniprogram/pages/node-feedback/index.wxss`
- 新建：`miniprogram/pages/review-list/index.js`
- 新建：`miniprogram/pages/review-list/index.json`
- 新建：`miniprogram/pages/review-list/index.wxml`
- 新建：`miniprogram/pages/review-list/index.wxss`
- 新建：`miniprogram/pages/review-detail/index.js`
- 新建：`miniprogram/pages/review-detail/index.json`
- 新建：`miniprogram/pages/review-detail/index.wxml`
- 新建：`miniprogram/pages/review-detail/index.wxss`
- 新建：`miniprogram/pages/notification-list/index.js`
- 新建：`miniprogram/pages/notification-list/index.json`
- 新建：`miniprogram/pages/notification-list/index.wxml`
- 新建：`miniprogram/pages/notification-list/index.wxss`
- 修改：`miniprogram/pages/dashboard/index.js`
- 修改：`miniprogram/pages/dashboard/index.wxml`
- 修改：`miniprogram/pages/business-detail/index.js`
- 修改：`miniprogram/pages/business-detail/index.wxml`
- 修改：`miniprogram/app.json`
- 修改：`miniprogram/test/node-feedback-v2.test.js`
- 修改：`miniprogram/test/business-template-flow.test.js`
- 新建：`miniprogram/test/review-flow.test.js`
- 新建：`miniprogram/test/notification-flow.test.js`
- 修改：`tools/test-wxml-structure.mjs`

**接口：**
- 服务方法：`submitNodeForReview(input)`、`submitReviewVote(input)`、`listMyPendingReviews(query)`、`getReviewDetail(reviewRoundId)`、`listMyNotifications(query)`、`markNotificationRead(notificationId)`。
- 页面导航只携带 `reviewRoundId`、`businessLineId` 或 `nodeId`；字段、权限和身份均重新从服务端读取。
- 提交审核按钮内部先幂等保存当前进度，再调用提交审核接口；第一步成功而第二步失败时保留草稿并允许使用同一请求键重试。

- [ ] **Step 1：写入小程序流程失败测试**

```js
test('提交审核后处理页锁定并跳回显示待审核', async () => {
  const page = createFeedbackPage({ node: reviewNode })
  await page.onSubmitReview()
  assert.equal(calls[0].action, 'save_progress')
  assert.equal(calls[1].method, 'submitNodeForReview')
  assert.equal(page.data.readOnly, true)
})

test('审核驳回要求原因并刷新为最终结果', async () => {
  const page = createReviewDetailPage({ round: pendingRound })
  await page.onReject()
  assert.equal(page.data.errorMessage, '请填写驳回原因')
})
```

测试还覆盖或签/会签文案、同步单飞锁、异步账号切换失败关闭、凭证临时地址、待我审核数量、未读通知数量、通知列表及已读状态、业务详情自动显示下一节点和旧业务页面。

- [ ] **Step 2：运行客户端测试并观察预期失败**

```powershell
node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/business-template-flow.test.js miniprogram/test/review-flow.test.js miniprogram/test/notification-flow.test.js
```

预期：失败，因为审核服务封装和审核页面尚不存在，处理页仍有状态选择。

- [ ] **Step 3：实现中文交互和异步失败关闭**

处理页只展示“保存处理进度”“标记受阻”“提交审核”。`pending_review` 时字段、选择文件、删除文件和三个写按钮全部禁用。审核页展示字段快照、凭证、轮次、模式、截止时间和投票进度；通过意见可空，驳回原因必填。概览页提供“消息通知”入口和未读数量，通知列表只展示安全摘要、时间和对应业务入口，进入或显式操作后调用服务端标记已读。

所有异步结果写回前执行：

```js
const currentUser = getApp().globalData.currentUser
if (!currentUser || currentUser._id !== requestedActorId) return
if (this.data.roundVersion !== requestedRoundVersion) return
```

页面重新显示时通过 `onShow` 从服务端刷新，不依赖返回页中的旧节点对象。

- [ ] **Step 4：运行全部客户端和 WXML 门禁**

```powershell
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

预期：全部通过，0 失败。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- miniprogram/services/business.js miniprogram/pages/node-feedback/index.js miniprogram/pages/node-feedback/index.wxml miniprogram/pages/node-feedback/index.wxss miniprogram/pages/review-list/index.js miniprogram/pages/review-list/index.json miniprogram/pages/review-list/index.wxml miniprogram/pages/review-list/index.wxss miniprogram/pages/review-detail/index.js miniprogram/pages/review-detail/index.json miniprogram/pages/review-detail/index.wxml miniprogram/pages/review-detail/index.wxss miniprogram/pages/notification-list/index.js miniprogram/pages/notification-list/index.json miniprogram/pages/notification-list/index.wxml miniprogram/pages/notification-list/index.wxss miniprogram/pages/dashboard/index.js miniprogram/pages/dashboard/index.wxml miniprogram/pages/business-detail/index.js miniprogram/pages/business-detail/index.wxml miniprogram/app.json miniprogram/test/node-feedback-v2.test.js miniprogram/test/business-template-flow.test.js miniprogram/test/review-flow.test.js miniprogram/test/notification-flow.test.js tools/test-wxml-structure.mjs docs/memory/STATUS.md
git commit -m "feat: 接入小程序节点审核流程"
```

---

### Task 10：实现每工作小时提醒和站内通知去重

**文件：**
- 新建：`cloudfunctions/workflowReminder/package.json`
- 新建：`cloudfunctions/workflowReminder/package-lock.json`
- 新建：`cloudfunctions/workflowReminder/index.js`
- 新建：`cloudfunctions/workflowReminder/lib/work-time-service.js`
- 新建：`cloudfunctions/workflowReminder/lib/reminder-service.js`
- 新建：`cloudfunctions/workflowReminder/lib/cloud-reminder-repository.js`
- 新建：`cloudfunctions/workflowReminder/test/work-time-service.test.js`
- 新建：`cloudfunctions/workflowReminder/test/reminder-service.test.js`
- 新建：`cloudfunctions/workflowReminder/test/cloud-reminder-repository.test.js`
- 新建：`cloudfunctions/workflowReminder/test/scheduled-entry.test.js`

**接口：**
- 定时入口：`main(event)`，只返回脱敏计数。
- 编排：`runReminderCycle({ now, batchSize })`。
- 仓储：`listDueProcessingReminders`、`listDueReviewReminders`、`createProcessingReminder`、`createReviewReminder`、`advanceReminderCursor`。
- 通知编号：处理提醒由节点编号和累计工作小时确定；审核提醒由审核轮次、审核人和累计工作小时确定。

- [ ] **Step 1：写入提醒规则失败测试**

```js
test('会签只提醒未投票审核人', async () => {
  const result = await service.runReminderCycle({ now, batchSize: 40 })
  assert.deepEqual(result, { processingCreated: 0, reviewCreated: 1 })
  assert.deepEqual(fake.documents('notifications')[0].recipientUserIds, ['reviewer-b'])
})

test('或签通过和任一驳回后不再创建提醒', async () => {
  await service.runReminderCycle({ now, batchSize: 40 })
  assert.equal(fake.documents('notifications').length, 0)
})
```

覆盖工作时间外不提醒、每累计一小时、逾期继续、重复执行幂等、账号停用、业务终态、节点换轮次，以及截止时间待补算时跳过小时提醒但保留管理员日历告警。

- [ ] **Step 2：运行提醒测试并观察预期失败**

```powershell
npm.cmd test --prefix cloudfunctions/workflowReminder
```

预期：失败，因为独立提醒云函数尚不存在。

- [ ] **Step 3：实现分块候选、确定性通知和游标推进**

提醒函数使用独立可部署的工作时间实现，常量固定为 09:00 和 20:00；与 Task 4 使用相同测试时间向量。仓储每批最多处理 40 个候选，创建通知前事务重新读取业务、节点/轮次、账号和现有通知编号。`processingDueStatus` 或 `reviewDueStatus` 不是 `calculated` 时不创建小时提醒，等待 `calendarSync` 补算后再进入正常提醒游标。

通知只保存：

```js
{
  type: 'processing_reminder' /* 或 review_reminder */,
  recipientUserIds,
  businessLineId,
  nodeId,
  reviewRoundId,
  accumulatedWorkHour,
  status: 'pending',
  createdAt: db.serverDate()
}
```

不得保存字段内容、凭证文件编号、OpenID 或内部预约摘要。

- [ ] **Step 4：运行提醒、后端和清理回归**

```powershell
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/evidenceRetention
```

预期：全部通过，0 失败；`evidenceRetention` 行为不变。

- [ ] **Step 5：更新状态并提交明确路径**

```powershell
git add -- cloudfunctions/workflowReminder/package.json cloudfunctions/workflowReminder/package-lock.json cloudfunctions/workflowReminder/index.js cloudfunctions/workflowReminder/lib/work-time-service.js cloudfunctions/workflowReminder/lib/reminder-service.js cloudfunctions/workflowReminder/lib/cloud-reminder-repository.js cloudfunctions/workflowReminder/test/work-time-service.test.js cloudfunctions/workflowReminder/test/reminder-service.test.js cloudfunctions/workflowReminder/test/cloud-reminder-repository.test.js cloudfunctions/workflowReminder/test/scheduled-entry.test.js docs/memory/STATUS.md
git commit -m "feat: 增加节点处理与审核提醒工作器"
```

---

### Task 11：完成兼容、安全回归和部署验收资料

**文件：**
- 修改：`cloudfunctions/businessApi/test/account-routes.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-review-repository.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- 修改：`cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- 修改：`miniprogram/test/review-flow.test.js`
- 修改：`miniprogram/test/notification-flow.test.js`
- 修改：`docs/deployment/template-node-fields-setup.md`
- 修改：`README.md`
- 修改：`docs/memory/PROJECT.md`
- 修改：`docs/memory/STATUS.md`

**接口：**
- 部署集合：`node_review_rounds`、`node_review_votes`、`work_calendar`。
- 唯一索引：`node_review_votes.reviewRoundId + reviewerUserId`。
- 查询索引：审核轮次的节点轮次、业务状态、审核人待办；投票的业务节点时间线。
- 云函数：更新 `businessApi`，新增 `calendarSync` 和 `workflowReminder`；`evidenceRetention` 继续保持空触发器。

- [ ] **Step 1：写入最终兼容和安全矩阵**

增加自动化矩阵证明：

- 旧节点仍可通过旧反馈流程运行，但不能创建伪审核轮次。
- 新节点不能调用旧完成或旧驳回入口。
- 停用、缺失、移除关系、角色模式变化、业务冻结和版本变化在提交、投票、幂等重试各阶段均先返回安全错误且不写数据。
- 审核查询不泄漏凭据、OpenID、云文件编号、哈希、租约和请求摘要。
- 处理/审核提醒与 60 天凭证提醒使用不同确定性编号且不会相互覆盖。
- 日历缺失不会阻断业务创建、审核提交、驳回返工或节点推进；同步恢复后只补算仍处于匹配版本和活动状态的截止时间。

- [ ] **Step 2：运行完整验证并处理所有失败**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

预期：全部通过，0 失败。任何失败都在当前任务内修复并重新运行完整命令。

- [ ] **Step 3：更新中文部署手册**

手册按顺序写明：

1. 备份并验证可读性。
2. 创建三个集合并设置客户端不可直接读写。
3. 创建唯一索引和查询索引，记录字段顺序与方向。
4. 上传新版 `businessApi`，确认现有环境变量仍有效。
5. 上传 `calendarSync`，先保持触发器空数组，手工同步当前年和下一年并核对日期数量、来源和版本。
6. 上传 `workflowReminder`，首次验收保持触发器空数组。
7. 保持 `evidenceRetention` 的 `triggers: []` 不变。
8. 使用隔离模板、隔离账号和无敏感测试文件完成或签、会签、驳回、返工和末节点完成。
9. 核对轮次、投票、通知、审计、双 SLA、待补算恢复和凭证引用。
10. 验收通过后，分别批准日历每日同步触发器和小时级提醒触发器。
11. 回退时先停用新版模板，再停用两个新触发器并回退客户端和云函数，保留审核数据。

- [ ] **Step 4：运行差异、语法和长期记忆门禁**

```powershell
node --check cloudfunctions/businessApi/lib/review-domain.js
node --check cloudfunctions/businessApi/lib/review-service.js
node --check cloudfunctions/businessApi/lib/cloud-review-repository.js
node --check cloudfunctions/calendarSync/index.js
node --check cloudfunctions/workflowReminder/index.js
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
git status --short --branch
```

预期：全部通过；工作区只包含本任务明确文件。

- [ ] **Step 5：提交发布资料并报告人工边界**

```powershell
git add -- cloudfunctions/businessApi/test/account-routes.test.js cloudfunctions/businessApi/test/cloud-review-repository.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js miniprogram/test/review-flow.test.js miniprogram/test/notification-flow.test.js docs/deployment/template-node-fields-setup.md README.md docs/memory/PROJECT.md docs/memory/STATUS.md
git commit -m "docs: 完成节点审核部署与验收资料"
```

报告必须区分：本地自动化已通过；真实 CloudBase 集合、索引、云函数、触发器、微信开发者工具、多账号并发和工作日历数据覆盖仍需操作员逐项验收。

---

## 任务级复核与进展报告

每个 Task 完成后必须执行一次独立规格符合性审查和一次代码质量审查。审查结论中存在严重或重要问题时，不得进入下一 Task；修复必须有新的失败测试和独立复核。

每步向项目所有者报告：

- 已落地功能。
- 数据结构和接口变化。
- 测试数量、失败数量与未执行项。
- 需要在 CloudBase 或微信开发者工具进行的操作。
- 当前提交编号、是否推送以及分支状态。
- 总体进度、下一任务和已知风险。

真实环境未执行的内容统一标记为“未验证”，不得描述为已完成。
