# 工作时长完整分钟折算实施计划

> **供代理执行：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项执行本计划。所有步骤使用复选框跟踪。

**目标：** 修复真实秒/毫秒时间戳产生非整数工作分钟、导致提交审核或审核结算错误返回 `VERSION_CONFLICT` 的问题。

**架构：** 在 `businessApi` 的权威工作时间服务出口统一把累计工作时长向下折算为已经完整经过的分钟。审核服务和仓储继续保持严格整数校验，不在各入口分散取整；精确时间戳、日历缺失语义和提醒工作器保持不变。

**技术栈：** Node.js 16.13、CommonJS、`node:test`、腾讯 CloudBase 云函数与云数据库。

## 全局约束

- 59 分 59.999 秒记为 59 分钟，60 分 00 秒记为 60 分钟。
- 只在累计工作分钟出口向下取整，不修改精确开始、结束或决定时间戳。
- `pending_calendar` 继续返回 `minutes: null`，不得伪造分钟。
- 不修改客户端协议、数据库结构、日历工作时段、SLA 配置或 `workflowReminder` 秒级阈值。
- 不迁移或手工修改现有节点、反馈、审核轮次与凭证。
- 保留用户未提交的 `project.config.json`，任何暂存与提交都只能列出本计划明确路径。

---

### 任务 1：用失败测试锁定完整分钟语义并完成最小修复

**文件：**

- 修改：`cloudfunctions/businessApi/test/work-time-service.test.js`
- 修改：`cloudfunctions/businessApi/test/review-service.test.js`
- 修改：`cloudfunctions/businessApi/lib/work-time-service.js:124-147`

**接口：**

- 输入：`workingMinutesBetween(startAt: Date, endAt: Date)`。
- 输出：`{ status: 'calculated', minutes: number, calendarVersion: string | null }`，其中 `minutes` 必须是非负安全整数；日历缺失仍输出 `{ status: 'pending_calendar', minutes: null, missingDate: string }`。
- 审核服务继续消费现有接口，不新增参数或返回字段。

- [ ] **步骤 1：增加工作时间服务失败测试**

在 `cloudfunctions/businessApi/test/work-time-service.test.js` 增加精确边界：

```js
test('工作时长只累计已经完整经过的分钟', async () => {
  const service = createWorkTimeService({ calendarRepository: allWorkdays() })
  const start = new Date('2026-08-13T09:00:00.000+08:00')

  const beforeHour = await service.workingMinutesBetween(
    start,
    new Date('2026-08-13T09:59:59.999+08:00')
  )
  const exactHour = await service.workingMinutesBetween(
    start,
    new Date('2026-08-13T10:00:00.000+08:00')
  )

  assert.equal(beforeHour.minutes, 59)
  assert.equal(exactHour.minutes, 60)
  assert.equal(Number.isSafeInteger(beforeHour.minutes), true)
  assert.equal(Number.isSafeInteger(exactHour.minutes), true)
})
```

再增加跨两个工作窗口的用例，确认是对累计总量取整，而不是分别截断每一天：

```js
test('跨工作日先累计秒级交集再统一折算完整分钟', async () => {
  const service = createWorkTimeService({ calendarRepository: allWorkdays() })
  const result = await service.workingMinutesBetween(
    new Date('2026-08-13T19:59:29.500+08:00'),
    new Date('2026-08-14T09:00:30.500+08:00')
  )
  assert.equal(result.minutes, 1)
})
```

- [ ] **步骤 2：运行工作时间聚焦测试，确认 RED**

运行：

```powershell
node --test cloudfunctions/businessApi/test/work-time-service.test.js
```

预期：新增断言失败；当前实现分别返回约 `59.99998333333333` 与小数累计值，证明根因尚未修复。

- [ ] **步骤 3：增加审核服务真实组合失败测试**

在 `cloudfunctions/businessApi/test/review-service.test.js` 引入真实 `createWorkTimeService`，为 `harness` 增加可选 `workTimeService` 注入：

```js
const { createWorkTimeService } = require('../lib/work-time-service')

function realWorkTimeService() {
  return createWorkTimeService({
    calendarRepository: {
      async getDayRule(date) {
        return { date, isWorkday: true, calendarVersion: 'calendar-real-seconds' }
      }
    }
  })
}
```

创建服务时使用：

```js
workTimeService: overrides.workTimeService || workTimeService,
clock: overrides.clock || (() => new Date('2026-08-11T03:00:00.000Z'))
```

增加提交审核用例；处理开始为 09:00:00，服务时钟为 11:00:30，应创建 120 分钟的整数快照：

```js
test('真实秒级处理时长可以提交审核并冻结完整分钟快照', async () => {
  const { calls, service } = harness({
    workTimeService: realWorkTimeService(),
    clock: () => new Date('2026-08-11T11:00:30.000+08:00'),
    draft: draft({
      node: {
        ...draft().node,
        processingStartedAt: new Date('2026-08-11T09:00:00.000+08:00')
      }
    })
  })

  await service.submitNodeForReview({ actor: ACTOR, input: input() })
  const timing = calls.find(call => call[0] === 'create')[1].timing
  assert.equal(timing.processingElapsedWorkMinutes, 120)
  assert.equal(Number.isSafeInteger(timing.processingElapsedWorkMinutes), true)
})
```

同时增加审核投票结束用例，使 `reviewStartedAt` 到决定时刻包含 30 秒，并断言 `reviewElapsedWorkMinutes`、`reviewRemainingWorkMinutes`、`reviewOverdueWorkMinutes` 都是安全整数。

```js
test('真实秒级审核时长只结算完整分钟', async () => {
  const { calls, service } = harness({
    workTimeService: realWorkTimeService(),
    clock: () => new Date('2026-08-11T11:00:30.000+08:00'),
    voteContext: {
      transition: 'next_node',
      processingWorkMinutes: 1320,
      reviewStartedAt: new Date('2026-08-11T09:00:00.000+08:00'),
      reviewTotalWorkMinutes: 480,
      reviewBaseElapsedWorkMinutes: 0
    }
  })

  await service.submitReviewVote({
    actor: { _id: 'reviewer-1', status: 'active' },
    input: {
      reviewRoundId: 'review-feedback-current',
      expectedRoundVersion: 1,
      decision: 'approve',
      comment: '确认',
      requestKey: 'vote-seconds-1'
    }
  })
  const timing = calls.at(-1)[1].timing
  assert.equal(timing.reviewElapsedWorkMinutes, 120)
  assert.equal(timing.reviewRemainingWorkMinutes, 360)
  assert.equal(timing.reviewOverdueWorkMinutes, 0)
  assert.equal(Number.isSafeInteger(timing.reviewElapsedWorkMinutes), true)
})
```

- [ ] **步骤 4：运行审核服务聚焦测试，确认 RED**

运行：

```powershell
node --test cloudfunctions/businessApi/test/review-service.test.js
```

预期：真实秒级提交审核或投票结算返回 `VERSION_CONFLICT`；失败点位于整数时限快照校验，而不是授权、反馈或凭证。

- [ ] **步骤 5：实现唯一生产修复**

在 `cloudfunctions/businessApi/lib/work-time-service.js` 的 `workingMinutesBetween` 完成全部日期交集累计后，一次性向下取整并校验安全整数：

```js
const completeMinutes = Math.floor(minutes)
if (!Number.isSafeInteger(completeMinutes) || completeMinutes < 0) {
  throw new RangeError('working minutes exceed the safe integer range')
}
return {
  status: 'calculated',
  minutes: completeMinutes,
  calendarVersion: combinedVersion(versions)
}
```

不得在每日循环内取整，也不得修改 `pending_calendar` 的提前返回。

- [ ] **步骤 6：运行聚焦测试，确认 GREEN**

运行：

```powershell
node --test cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/review-service.test.js
```

预期：全部通过；新增秒级边界返回整数，既有日历缺失和审核幂等用例保持通过。

- [ ] **步骤 7：检查生产差异并创建实现提交**

运行：

```powershell
node --check cloudfunctions/businessApi/lib/work-time-service.js
git diff --check -- cloudfunctions/businessApi/lib/work-time-service.js cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/review-service.test.js
git diff -- cloudfunctions/businessApi/lib/work-time-service.js cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/review-service.test.js
git add -- cloudfunctions/businessApi/lib/work-time-service.js cloudfunctions/businessApi/test/work-time-service.test.js cloudfunctions/businessApi/test/review-service.test.js
git commit -m "fix: 统一审核工作分钟折算"
```

预期：提交只包含上述 3 个文件，`project.config.json` 继续未暂存。

---

### 任务 2：完成全量回归、项目记忆与人工复验交接

**文件：**

- 修改：`docs/memory/STATUS.md`
- 仅在稳定事实变化时修改：`docs/memory/PROJECT.md`
- 不修改：`project.config.json`

**接口：**

- 消费任务 1 的整数分钟输出。
- 产出可部署的 `businessApi` 修复提交、准确的验证证据和真实 CloudBase 复验步骤。

- [ ] **步骤 1：运行完整自动化门禁**

依次运行：

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/calendarSync
npm.cmd test --prefix cloudfunctions/workflowReminder
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
```

预期：全部测试通过。任何失败都必须记录实际命令、失败数和根因，不得写成完成。

- [ ] **步骤 2：更新中文项目状态**

在 `docs/memory/STATUS.md` 记录：

- 真实问题的脱敏根因，不记录业务正文、账号编号、凭证编号或云文件路径。
- RED 与 GREEN 的精确测试数量。
- 六套全量门禁的精确通过数量。
- 生产代码、真实 CloudBase 部署和真机再次提交审核各自的已验证或 `unverified` 状态。
- 下一步为重新部署 `businessApi`，不重新上传凭证，直接复用当前草稿再次提交审核。

`docs/memory/PROJECT.md` 已记录完整分钟稳定规则；除非实现改变该规则，否则不重复修改。

- [ ] **步骤 3：运行最终差异与记忆校验**

运行：

```powershell
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
git status --short
```

预期：差异和记忆校验通过；状态中只有计划内文档与用户自己的 `project.config.json` 修改。

- [ ] **步骤 4：显式提交项目状态**

运行：

```powershell
git add -- docs/memory/STATUS.md
git commit -m "docs: 记录审核分钟修复验证"
```

若 `PROJECT.md` 因稳定事实发生真实变化才显式加入；不得使用 `git add .`。

- [ ] **步骤 5：交付真实 CloudBase 复验顺序**

操作员按以下顺序执行：

1. 上传当前提交对应的 `businessApi`，核对运行时、环境变量和 60 秒超时保持有效。
2. 重新编译小程序，不重新选择或上传凭证。
3. 打开当前节点，直接点击“提交审核”。
4. 确认节点进入待审核、审核截止时间出现、`node_review_rounds` 新增一条轮次。
5. 确认轮次引用原 `feedbackId` 和原凭证编号，反馈历史不重复，`evidences` 不新增重复记录。
6. 若仍失败，只记录安全错误码和相关集合计数；不得手工修改节点、反馈、轮次或凭证。

预期：自动化通过只能证明本地实现；上述部署和真机步骤在操作员确认前保持 `unverified`。
