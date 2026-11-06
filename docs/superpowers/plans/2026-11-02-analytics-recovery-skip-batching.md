# Analytics Recovery Skip Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划本地任务和独立复核已完成；用户随后另行授权部署，单文件云更新及完整读回也已完成，准确证据见验收文档，不回溯扩大本计划原来的云操作权限。

**Goal:** 减少连续无须生成字段统计节点的游标操作，保持正常补算、来源完整性及公平推进。

**Architecture:** 原始页最多40条、预算5秒。每组首个节点保留原单条先检查点流程；其后最多7条连续排除候选在一个事务里重读当前节点状态，仅用一次游标CAS提交已确认前缀。正常生成与发布事务不改，不新增队列、状态格式或云配置。

**Tech Stack:** CommonJS、Node内置测试工具、现有wx-server-sdk 4.0.2、现有fake-cloud-database及field-fixtures；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-02-analytics-recovery-skip-batching-design.md`（用户已确认）。

## Global Constraints

- 每组最多8条，包括走原流程的首条；后缀至少2条才启动合批，最多7条。
- 原始查询最多40条、5秒协作预算、原全量回绕及SDK操作上限保持；不追加查询或扩大本轮覆盖。
- 只按旧loadSource的节点状态/路线排除条件合批；已完成且快照相同的节点仍完整重验，依赖售后头才能判断的排除条件不快进。
- 合批读取当前游标并重验每个后缀节点，CAS丢失即停止，只消费已提交连续前缀；不跨请求或SDK重试缓存判断。
- 超时回滚该小批，保留组首原检查点；数据库/写入/未知提交异常不单条降级重放，不在截止后另写检查点。
- 不改售后、旧通知/计数、企微180工作分钟规则、客户端、Timer/IAM/配置、集合/索引或快照格式；不发真实消息、不做云调用。
- 保留全部既有dirty，不stage/commit/push；先完成本地验证，后续部署及费用/权限仍是单独门禁。

## Review Focus

- 节点在页查询后变为completed或awaiting_manual_decision：事务发现变化，不能快进跳过生成。
- 小批中任意固定读取或提交超时/失败/结果未知：不消费未确认前缀，不立即重复事务；下一轮仍公平推进。
- 两个worker或SDK冲突重试：旧cursor不得覆盖新位置，每次回调重新建立前缀，不沿用前次判断。
- 数据含访问器、异常原型、坏编号或版本边界：提示分类不执行访问器、不修复脏数据为合法值，不能绕过原单条校验。
- 短页回绕、40条整页和混合正常生成：只在原页真正末尾回绕，来源/快照与旧算法一致，单节点和正常生成路径不增加操作。

---

## File Structure

- Modify `cloudfunctions/operationsAnalytics/lib/field-snapshot-recovery.js`：内部分类、后缀小批CAS及循环接线，保持导出接口。
- Create `cloudfunctions/operationsAnalytics/test/field-snapshot-recovery-skip-batching.test.js`：合成计量、异常/并发/预算与公平性回归；复用既有两个测试helper，不修改公共fake。
- Keep `cloudfunctions/operationsAnalytics/test/field-snapshot-recovery.test.js`：原23项必须原样通过，除必要的新回归外不弱化断言。
- Update 本计划、短设计、`docs/memory/STATUS.md`；若形成稳定实现事实，再更新PROJECT及ADR-0019的有界补充。不要顺带调整其他dirty。

### Task 1: Bounded excluded-node checkpoint batching

**Interfaces:**

- Existing export remains `createFieldSnapshotRecovery({db, clock, buildFinalFieldResult, selectionSnapshot}).runCycle({batchSize, timeBudgetMs})` and returns `{examined, generated, failed, hasMore}`.
- Internal `excludedHint(node) -> boolean`：只读取合法plain对象的自有data descriptor；异常一律false，使用与loadSource相同的节点排除规则。
- Internal `skipExcludedPrefix(observed, candidateIds, wrapTail) -> Promise<null | {consumed, cursor}>`：`observed/cursor`均为`{cursorId,version}`；null仅表示CAS丢失，consumed为已提交0..7前缀长度。`wrapTail`只有候选末尾确为原始短页末尾时可true。
- Test-local `skipHarness(count, options={}) -> {fake,recovery,input}`：通过fieldSource生成编号递增的合成节点，默认status=in_progress/routeState=active；允许注入现有fake选项和clock，不联云。`cycleMetrics(fake,recovery) -> Promise<{result,reads,queries,writes,transactions}>`记录单轮差额，reads仅计成功固定文档读取，writes仅计该恢复游标。

- [x] **Step 1: Freeze the current baseline and write RED tests**

  在执行台账保存两个原文件的摘要及前像，不覆盖其他计划产物。现产品SHA256为`5065b76d0076b6a0d7017ca31eef846167357e0a53bf6b7870517307d52e0b0b`；HEAD为`05f346f3974b4e2e08a64ccdcfb617273584c026`，它不代表全部dirty内容。建立新测试文件，核心断言为：

  ```js
  const {fake,recovery}=skipHarness(30)
  const sample=await cycleMetrics(fake,recovery)
  assert.deepEqual(sample.result,{examined:30,generated:0,failed:0,hasMore:false})
  assert.equal(sample.reads,39); assert.equal(sample.queries,1)
  assert.equal(sample.writes,8); assert.equal(sample.transactions,8)
  assert.equal(fake.transactionQueries.length,0)
  assert.ok(fake.transactionRuns.every(run=>run.operations<=100))
  ```

  加入明确命名用例：
  - `empty and single candidate keep original costs`：0节点0写/0事务，1排除节点1写/1事务；2排除节点不启动后缀探测。
  - `forty and forty-one excluded nodes preserve raw-page wrap`：第一轮examined40且cursor=node-040，下一轮0或1并正确回绕；所有页limit40、无offset或额外查询。
  - `completed unchanged nodes retain authoritative path`：30个已完成节点预热后仍241成功读/1查询/30游标写/60事务，generated0；字段和审核内容读取保留。
  - `suffix becomes completed`、`suffix becomes manual decision`：在批事务前修改合成权威节点，不能消费该节点；随后原单条路径正确生成且结果与旧规则一致。
  - `cursor CAS loss stops without rewind`、`retry rereads candidate state`：竞争版本/位置保持，不发布未领取节点；SDK重试必须看见变化后的节点。
  - `malformed hint never invokes getter or skips candidate`：访问器/异常原型/非单调编号不快进；缺失节点沿用不生成语义；原cursor版本上界检查保留。
  - `partial confirmed prefix precedes changed node`：只消费变化节点前已确认前缀，后面的可生成节点不得跳过。
  - `suffix read failure stops without replay`、`suffix write failure rolls back`、`unknown commit stops even if committed`：组首检查点保留；同轮无单条降级重试，cursor绝不声称消费未提交节点。
  - `repeated suffix timeouts still reach later nodes`：每轮批内固定读耗尽5秒，组首仍逐轮推进，有限轮内可到达最后一个正常候选；截止后没有新增写入。
  - `mixed candidates preserve snapshots and protected state`：穿插排除/正常/坏数据，最终快照与正常生成数量符合原算法，业务源及旧通知合成快照不变。

- [x] **Step 2: Run the new tests and retain expected failure evidence**

  Run `node --test cloudfunctions/operationsAnalytics/test/field-snapshot-recovery-skip-batching.test.js`。至少30节点成本断言应因旧代码30写/30事务而失败；缺helper或语法错误不算有效RED。原23项基线应仍全过。

- [x] **Step 3: Implement the internal helpers and bounded loop integration**

  在原模块实现上述两个内部签名；复用原read/budget/cursorState，事务内读取游标、逐个重验后缀，只写一次确认前缀。候选提示不作为权威数据。保留组首原CAS及loadSource/publish，只有成功无来源且提示可排除时尝试后缀；消费数只在事务提交后调整循环索引和previousId。不更改publish、统计来源校验、SDK或错误正文。

- [x] **Step 4: Run local comparison and regression gates**

  先运行两个恢复测试文件，再运行`npm.cmd test --prefix cloudfunctions/operationsAnalytics`、`npm.cmd test --prefix cloudfunctions/businessApi`、`node tools/test-wxml-structure.mjs`、`git diff --check`。零失败/跳过/取消是通过条件；遇到环境阻断记录unverified，不删除断言。记录30/40/41排除、零/单条、30已完成、混合/变化/慢读取场景；保护状态不变、无真实云调用。39/8/8只是本地稳定场景目标，不转换为现金比例。

- [x] **Step 5: One fresh independent review and proportionate repair**

  沿原生执行的末尾复核方式检查本任务限定diff、设计及测试证据，重点看上面五类Review Focus。重要反馈先复现为RED再做有界修复，重新跑受影响门禁；不得扩大成变化队列或私有progress改造。若无法守住原语义则停止受影响改法并报告。

- [x] **Step 6: Update evidence and finish local handoff without deployment**

  更新本计划勾选和STATUS，稳定事实才补PROJECT/ADR；运行`python C:/Users/87579/.codex/skills/maintaining-project-memory/scripts/validate_memory.py .`及diff检查。清楚报告本地实现/云端未部署/真实现金未核实，不stage/commit/push。后续云操作需重新核对目标原包、最小差异和费用权限边界，不能把本计划当云配置或真实消息授权。

## Plan Self-Review

已逐项对照短设计的目标、排除边界、8条分组/2条后缀门槛、组首检查点、确认前缀、CAS/重试/未知结果、预算公平性和验证交付门；均归Task 1。五项Review Focus均有对应测试名。计划不改变既有接口或共享纯规则，不拆出无独立价值的任务。用户确认后本地实现：新21项纠正夹具后7RED/14兼容通过，首次GREEN44/44，完整analytics87/API1836/原站内60/WXML4均通过；30排除场景实测39读/8写/8事务。独立复核无阻断；后续单独授权的单文件云更新及5833文件独立读回均完成，实际现金未验。准确记录、裁定及非阻断后续项见本计划台账和docs/deployment/analytics-recovery-skip-batching-acceptance.md。
