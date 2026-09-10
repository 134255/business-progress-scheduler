# Configurable Business Card Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 售后卡片显示一次编号及模板选择的最多4个字段，配置变更对新旧售后在下一次成功刷新生效。

**Architecture:** 独立模板展示版本不进入流程定义摘要；服务端摘要只读取当前有效反馈/审核字段，版本化缓存于售后头。保存后派生刷新、当前页按需重建及统一客户端卡片共同保持各入口一致，不依赖检索索引。

**Tech Stack:** 既有 Node.js/CommonJS、CloudBase 固定文档事务、原生小程序 JS/WXML/WXSS、node:test；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-10-configurable-business-card-summary-design.md`，用户已确认。

## Global Constraints

- 第一行固定显示售后编号，右侧保留状态；不再把自动生成的售后名称与编号重复展示。
- 编号下按模板设定顺序显示最多 4 项“字段名：内容”，默认不选择任何字段，不自动猜测业务重点。
- 服务端每项最多返回 80 个 Unicode 码点的摘要，完整内容仍在详情中。
- 仅活动超级管理员可修改；可在模板启用期间修改展示配置，但流程定义仍只读。
- 修改配置不改变模板流程 `version`、`definitionDigest`、`definitionNodeIds`。
- 摘要更新只写派生字段，不改变业务状态、业务版本、业务 `updatedAt`、排序、检索版本、反馈和审核记录。
- 发生竞争最多重新计算一次；并发最多4路；不遍历反馈历史或附件；单事务不超过100操作。
- 权限错误不能通过缓存绕过；摘要错误不能反转已成功的业务写入。
- 用户明确授权直接在当前项目/main开发，保留所有既有改动。不得暂存/提交前置脏改动；本轮留可审查工作树，不自动提交、推送、部署或上传客户端。
- 仅合成数据进入测试/日志/报告；禁止真实客户值、永久文件标识、签名URL、秘密进入Git或记忆。

## Execution and review

任务顺序1→2→3→4，每项先RED、再实现、GREEN、自审、独立任务审查。每项报告包含确切命令、失败原因、通过数量与修改路径。控制器在任务执行时只做后续接口分析/文档和基线核对，不与工人同时编辑同一文件。

本工作树不能以HEAD作为本功能变更基线：它遗漏已部署的前置脏改动。使用当前源码的只读副本生成任务差异与最终差异；报告和审查包在本计划专属 `.superpowers/sdd/2026-09-10-configurable-business-card-summary/` 中。最终保留这些可恢复记录，不递归清理用户目录。

## Task 1: Independent template display configuration

**Files:** Create `cloudfunctions/businessApi/lib/business-card-display.js`, `test/business-card-display.test.js`, `test/template-card-display.test.js`; modify `lib/cloud-template-repository.js`, `lib/template-service.js` and their focused tests only when necessary. All test paths are under `cloudfunctions/businessApi`.

**Interfaces:**

- Export `readCardDisplay(template) -> {schemaVersion:1, revision:number, fields:[{nodeKey,fieldKey}]}`; completely absent own config means revision0/empty. Present malformed, inherited or accessor values fail with marked `CARD_DISPLAY_INVALID`.
- Export `normalizeCardDisplayFields(fields, nodes) -> ordered references`; strict own-data dense array0..4, unique exact pairs, valid stable IDs, each resolves once in current definitions. Export `assertCardDisplayReferences(display, nodes)` for definition mutation guard. No customer values accepted.
- Repository methods `getTemplateCardDisplay({actor,templateId})` and `updateTemplateCardDisplay({actor,templateId,expectedRevision,fields})`; service methods with same signatures. Return `{templateId, revision, fields}`. Existing `getTemplate` supplies choices from saved nodes, no new arbitrary path evaluator.

- [x] Write failing real-service/fake-database tests. Example consumer assertions:

```js
const before = structuredClone(fake.documents('templates')[0])
const result = await service.updateTemplateCardDisplay({actor: admin, templateId: 'template-1',
  expectedRevision: 0, fields: [{nodeKey:'node-a', fieldKey:'field-a'}]})
assert.deepEqual(result.fields, [{nodeKey:'node-a', fieldKey:'field-a'}])
assert.equal(result.revision, 1)
const stored = fake.documents('templates')[0]
assert.equal(stored.version, before.version)
assert.equal(stored.definitionDigest, before.definitionDigest)
assert.deepEqual(fake.documents('business_lines'), originalLines)
```

- [x] Run `node --test cloudfunctions/businessApi/test/business-card-display.test.js cloudfunctions/businessApi/test/template-card-display.test.js`; record missing feature failures before production edits.
- [x] Implement domain normalization using existing own-data schema helpers and application error marker. Shape is exactly `{schemaVersion:1,revision:next,fields:normalized}`. Reject fifth/duplicate/unknown/cross-node fields, unsafe version, sparse/extra/inherited/accessor structures; no new field data types.
- [x] Implement repository operations using existing digest/node-list validator. Recheck current active administrator, template and expected config revision in transaction; compare pre-read template definition version/digest/node IDs and fixed-read referenced node docs before save. Update only `cardDisplay` and independent display audit metadata; write value-free audit. Deleted/missing template cannot edit. Transaction stays bounded even at48nodes.
- [x] Guard existing `mutateTemplateDefinition` transaction using current display config, not stale pre-read config: planned nodes must retain selected node/field IDs. Concurrent selected-field deletion cannot race a display save. Status-only deletion may retain config for historical readers.
- [x] Verify enabled configuration edits work but normal enabled definition edits stay rejected; role demotion/config race/ref deletion cause no partial mutation. Run focused suites then API suite once. Self-review and report; no commit/stage.

## Task 2: Authorized current-field summary and versioned cache

**Files:** Create `cloudfunctions/businessApi/lib/business-card-summary.js`, `lib/cloud-business-card-repository.js`, `lib/business-card-service.js`, `test/business-card-summary.test.js`, `test/cloud-business-card-repository.test.js`, `test/business-card-service.test.js`; modify `lib/cloud-business-repository.js` only to expose a narrow existing-permission read for the summary repository.

**Interfaces:**

- Consume `readCardDisplay(template)` from Task1.
- Add `businessRepository.getAuthorizedCardLine({actor,lineId,database}) -> {actor:currentActor,line,canReadFields}` reusing existing current-reader and membership rules; database defaults to existing db and supports a fixed-doc transaction. This is internal/raw, never a public route. Unknown/deleted/creating/inaccessible lines fail. Current super-admin nonmembers retain the existing global-list right but receive `canReadFields:false` and an unavailable summary with no values; do not break the whole global list or silently widen detail-field rights. Do not introduce a second weaker legacy authorization implementation.
- Export `createCloudBusinessCardRepository({db,businessRepository})` with `getSummary({actor,businessLineId}) -> {state:'ready'|'unavailable',fields:[{id,label,value}],configRevision}`. Throw authorization failures rather than returning a card the user may no longer see. Internal source/cache errors may return unavailable with no values.
- Export `createBusinessCardService({repository})` with `decorateItems({actor,items}) -> enrichedItems` (each item gains `cardSummary`), `refreshBusinessLine({actor,businessLineId}) -> void`, and `refreshAfterMutation({actor,action,payload,result}) -> void`. Final method resolves only a known mutation's line from validated IDs/current server docs and never propagates derived failures. No cloud calls to Search.
- Persist cache shape `cardSummary:{schemaVersion:1,templateId,configRevision,lineVersion,fields}`; validate own shape and source/config versions before use. Public fields do not expose internal source IDs except safe per-card row key.

- [x] Write RED cases using realistic line/node/feedback/round fixtures: progress current published feedback; pending current round; completed approved round; reviewerless completed feedback; legacy published feedback; same-name fields map by exact keys. Example:

```js
const before = fake.documents('business_lines')[0]
const summary = await repository.getSummary({actor, businessLineId:'line-1'})
assert.deepEqual(summary.fields.map(x=>[x.label,x.value]), [['数量','0'],['确认','否']])
const after = fake.documents('business_lines')[0]
assert.equal(after.version,before.version)
assert.deepEqual(after.updatedAt,before.updatedAt)
```

- [x] Run the three new test files and confirm missing feature failures.
- [x] Implement pure formatting independently from database reads: all7existing types, `0`/false not empty, 80codepoint clipping with ellipsis within limit, strict date/select values, empty/missing-field states; never stringify arbitrary objects/accessors. Use existing conditional-field resolution with complete current snapshot to suppress hidden values, and instance definitions for historical type/label.
- [x] Implement source selection matching current workflow semantics without copying Search's all-history/attachment traversal. Read max48instance nodes once to map stable keys, then at most4unique selected node sources; validate ownership, active processing round, publish/approval state and final pointer. Exclude dormant/skipped/old rejected rounds. Missing source only means empty for legitimate never-started nodes; malformed or mismatched published source is unavailable.
- [x] Implement per-request de-duplicated template reads and at most4concurrent source requests. Warm cache reads no node/feedback/round history. Revalidate current actor/line/config and source versions before returning or conditional cache write; retry version conflict once only. Do not change business ordering/version/authoritative contents. Completely absent config returns ready empty, deleted template's retained valid config still works, physically missing template/legacy unmappable line gives safe unavailable.
- [x] Test both cache-hit and cache-miss revocation/demotion, new config invalidating completed-case cache, concurrent feedback during build, old job unable to overwrite new cache, cache write failure still able to return freshly validated values, corrupted cache requiring rebuild, no stale values on failed build, source reads bounded/deduplicated and all in-flight tasks drained.
- [x] Define mutation mapping for actual existing write actions and return shapes by reading index routes: use result businessLineId where available, otherwise validated payload businessLineId or fixed-node/round lookup. Reauthorize before rebuild; include save/review/complete/reject/optional/manual/metadata/lifecycle. Derived failure never changes result or logs values. Verify mapping in service tests.
- [x] Run focused suites and full API once. Self-review/report exact interfaces and path changes, no stage/commit.

## Task 3: API integration across reads and writes

**Files:** Modify `cloudfunctions/businessApi/index.js`; create `test/business-card-routes.test.js`, `test/business-card-integration.test.js`; change focused existing route fixtures only if their actual response contract changed.

**Interfaces:**

- Add protected `getTemplateCardDisplay`/`updateTemplateCardDisplay` routes with strict payload allowlists. Forward only trusted actor plus template ID/config expected revision/reference array. Add safe error code/message for config invalid/ref deletion conflict without error details.
- Add optional `businessCardService` dependency to `createBusinessApi`, wired in default production factory using Task2 repository and current businessRepository.
- Read decoration runs only after successful `getMyDashboardSummary` / `getDashboardWorkspace` on `.recent` and `listBusinessLines` on `.items`; preserve all counts/cursors/filter/matches/indexStatus metadata. Do not decorate pending-processing or unrelated records accidentally.
- After known successful business write actions, await bounded `refreshAfterMutation`; do not repeat the underlying business mutation or swallow original failures.

- [x] Write RED entry-to-real-service integration tests with external wx SDK/fake DB boundary only. Example independent contract:

```js
const response = await main({action:'listBusinessLines',payload:{status:'completed',scope:'mine'}})
assert.equal(response.ok,true)
assert.equal(response.data.items[0].code,'BL-TEST-0001')
assert.equal(response.data.items[0].cardSummary.fields[0].value,'示例型号')
assert.deepEqual(response.data.items[0].matches, originalMatches)
```

- [x] Run new test files and confirm failures because entry wiring/routes are absent.
- [x] Implement exact read decoration and mutation hook via a small helper if it prevents repeating same branching code. Keep current route allowlists and error marking. No raw payload/field-value diagnostic logs.
- [x] Test authenticated ordinary readers versus admin config editor; forbidden actor/unknown input cannot delegate; dashboard/status/keyword same-fields integration; successful save followed by summary failure still returns success and next read recovers; original save failure does not run refresh. Real default factory gets all dependencies.
- [x] Run API and Search suites; self-review/report without stage/commit.

## Task 4: Template settings and unified client cards

**Files:** Modify `miniprogram/services/templates.js`, `miniprogram/pages/admin-template-edit/index.js/.wxml/.wxss`, `miniprogram/pages/dashboard/index.js/.wxml/.wxss`, `miniprogram/pages/business-list/index.js/.wxml/.wxss`, `miniprogram/utils/safe-error.js` if needed; create shared `miniprogram/utils/business-card.js`, a shared WXML template under `miniprogram/templates/business-card.wxml` (or equivalent component if it preserves parent search-match interactions), and `miniprogram/test/business-card-flow.test.js`, `miniprogram/test/template-card-display.test.js`.

**Interfaces:**

- Template service methods `getTemplateCardDisplay(templateId)`, `updateTemplateCardDisplay(templateId,expectedRevision,fields)` map to Task3 actions.
- Shared presenter `presentBusinessCard(item)` returns safe card title/rows/state while preserving original item, matches, IDs, progress/route metadata; code primary and name fallback only when truly no code. Missing summary from old server is no-summary, not a crash.
- Template saved-definition choices derive exact `nodeKey,fieldKey`, not unsaved edits. Selected config has its own loading/submitting/error/version and role/request-sequence guards independent of normal template form.

- [x] Write RED page-harness tests before editing: enable read-only template's separate display editor; choose/reorder/remove/max4; requests carry exact references and revision; preserve unsaved template draft; stale response after demotion/account change discarded.
- [x] Run new client tests and verify intended failures.
- [x] Implement checkbox/picker choices with stable row IDs, synthetic preview, explanatory label that all existing cases change at refresh. New template/new fields require saving definition first. Saving config does not call updateTemplate or disable template; conflict reloads current config and preserves useful error.
- [x] Replace duplicated header/body card presentation using shared template/presenter while keeping click-to-detail, status pill, existing current-node/progress logic and search matches/expand handlers. Add safe unavailable message and explicit retry of existing list/dashboard load, no hidden infinite loops.
- [x] Ensure onShow/manual refresh revalidates config through existing server refresh; do not introduce long-lived customer data storage. Test all4entry types, empty/missing/failed summary, 0/false/long Unicode, old backend, click navigation, keyword result metadata, account switch and layout structure.
- [x] Run full client suite, WXML checks, API compatibility. Self-review/report. No publish/upload/commit.

## Final verification and handoff (controller)

- [x] Review each task against its brief/report/scoped snapshot diff; fix Critical/Important findings through original worker and scoped re-review before proceeding.
- [x] Generate whole-feature diff against the pre-feature source snapshot, run one broad independent final review, then resolve concrete findings with a single integrated fix pass and scoped re-review.
- [x] Run `npm.cmd test --prefix cloudfunctions/businessApi`, `npm.cmd test --prefix cloudfunctions/businessSearch`, `node --test --test-reporter=spec miniprogram/test/*.test.js`, `node tools/test-wxml-structure.mjs`, `git -c core.safecrlf=false diff --check`.
- [x] Run independent `node tools/test-business-card-lifecycle.mjs` and official-WCC `node tools/test-business-card-rendering.mjs` (set `WECHAT_WCC_PATH` to installed trusted compiler); they supplement module tests without claiming native-device acceptance.
- [x] Update STATUS with exact scope/tests/limitations and PROJECT only with stable new facts. Add ADR only for accepted independent display-version/cache decision. Run project-memory validator. Never copy real records into evidence.
- [x] Report local implementation and verification distinctly from cloud deployment, client upload and real-device acceptance, which remain unverified until separately authorized/performed. Do not mark feature deployed merely because older fixes are live.
