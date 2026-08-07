# Template, Node, Dynamic Field, and Evidence Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo template and manually-authored business flow with server-controlled templates, generated business/node codes, immutable field feedback, rejection/rework, frozen completed data, video evidence, and 60-calendar-day cloud-file retention.

**Architecture:** Keep `businessApi` as the authenticated request entry while injecting focused template, business, evidence, feedback, and lifecycle services backed by CloudBase repositories. Preserve legacy business records through read-only adapters, add a separate scheduled `evidenceRetention` function, and keep all client pages thin by routing operations through service modules.

**Tech Stack:** Native WeChat Mini Program JavaScript/WXML/WXSS, Tencent CloudBase document database/cloud storage/cloud functions, Node.js built-in test runner, `wx-server-sdk@4.0.2`.

## Global Constraints

- Use TDD for every executable change: focused failing test, observed failure, minimal implementation, focused pass, then regression suite.
- Keep `wx-server-sdk` pinned to `4.0.2`; add no new runtime dependency unless the project owner approves it.
- Preserve the operator-owned `project.config.json` base-library change and never stage it with feature commits.
- Store account document IDs in new template/business relationships; never persist or log OpenID values in new domain documents.
- Enabled templates are read-only and must be disabled before any definition change.
- Business codes use `BL-YYYYMMDD-NNNN` in Asia/Shanghai; the numeric suffix expands beyond four digits rather than wrapping.
- Instance node codes use `<businessCode>-N<sequence>` with at least three sequence digits and are immutable.
- Default node SLA is 22 work hours; rejection never resets an existing deadline.
- Evidence limits remain: image 5 MB each, PDF 20 MB each, video 20 MB each, and all files in one feedback total at most 20 MB.
- Evidence cloud objects are purged 60 calendar days after completion, cancellation, closure, or logical deletion; metadata, hashes, feedback, and audit records remain.
- Frozen business data can only be corrected through a reasoned super-administrator amendment that preserves before/after values.
- Keep old business records readable without manufacturing codes, field versions, or historical values that did not exist.
- At the end of every task, update `docs/memory/STATUS.md` with evidence and report implemented scope, verification, operator steps, remaining work, risks, and Git state.
- Stage explicit paths only. Do not use broad staging commands.

---

## Planned File Structure

### Backend domain and services

- `cloudfunctions/businessApi/lib/field-domain.js`: field-definition normalization and submitted-value validation.
- `cloudfunctions/businessApi/lib/template-domain.js`: template/node normalization and lifecycle invariants.
- `cloudfunctions/businessApi/lib/template-service.js`: super-administrator template use cases and enabled-template queries.
- `cloudfunctions/businessApi/lib/cloud-template-repository.js`: CloudBase persistence and optimistic template mutations.
- `cloudfunctions/businessApi/lib/business-numbering.js`: deterministic business and node code formatting.
- `cloudfunctions/businessApi/lib/business-service.js`: template snapshot creation and editable business metadata.
- `cloudfunctions/businessApi/lib/cloud-business-repository.js`: transactional counters, business lines, nodes, and freeze state.
- `cloudfunctions/businessApi/lib/evidence-policy.js`: file extension, signature, size, aggregate-size, and hash policy.
- `cloudfunctions/businessApi/lib/evidence-service.js`: upload registration and authorized access grants.
- `cloudfunctions/businessApi/lib/cloud-evidence-repository.js`: evidence metadata and cloud-file inspection/access persistence.
- `cloudfunctions/businessApi/lib/feedback-service.js`: immutable feedback revisions and OR-sign completion.
- `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`: atomic node/feedback/evidence transitions.
- `cloudfunctions/businessApi/lib/business-lifecycle-service.js`: rejection, close/cancel, freeze, and amendments.
- `cloudfunctions/businessApi/index.js`: authentication, route wiring, safe error mapping, and legacy read adapters only.

### Scheduled retention function

- `cloudfunctions/evidenceRetention/index.js`: CloudBase initialization and scheduled entry.
- `cloudfunctions/evidenceRetention/lib/retention-service.js`: reminder, orphan cleanup, and due-object purge orchestration.
- `cloudfunctions/evidenceRetention/package.json` and `package-lock.json`: pinned deployment dependency.
- `cloudfunctions/evidenceRetention/test/retention-service.test.js`: deterministic clock and idempotency tests.

### Mini Program

- `miniprogram/services/templates.js`: template actions.
- `miniprogram/services/business.js`: generated-code creation, feedback, evidence, lifecycle, and amendment actions.
- `miniprogram/pages/admin-templates/*`: protected template list.
- `miniprogram/pages/admin-template-edit/*`: template metadata and ordered node list.
- `miniprogram/pages/admin-template-node-edit/*`: node, assignee, SLA, evidence types, and fields.
- `miniprogram/pages/template-list/*`: ordinary enabled-template selection.
- `miniprogram/pages/business-edit/*`: template-backed creation and metadata-only active edit.
- `miniprogram/pages/node-feedback/*`: dynamic fields, evidence, history, and rejection.
- `miniprogram/pages/admin-business-amend/*`: reasoned frozen-business correction.
- `miniprogram/pages/business-detail/*`: codes, timing, freeze, rejection, retention, and amendment display.

### Tests and operations

- Backend tests mirror each new domain/service/repository file under `cloudfunctions/businessApi/test/`.
- Client flow tests: `template-flow.test.js`, `business-template-flow.test.js`, `node-feedback-v2.test.js`, and `admin-business-amend-flow.test.js`.
- `docs/deployment/template-node-fields-setup.md`: collections, indexes, deployments, scheduled trigger, rollback, and acceptance.

---

### Task 1: Add an authenticated protected-domain route seam

**Files:**
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- Consumes: existing `createBusinessApi(...)`, account route map, actor resolution, and `legacyRoutes`.
- Produces: `protectedRoutes[action]({ actor, payload })`, where the actor is always the trusted resolved account and payload is never used as identity authority.

- [ ] **Step 1: Write the failing route-seam tests**

Add tests proving an injected protected route is recognized, receives the trusted actor, ignores a forged payload identity, and remains unavailable without authentication:

```js
test('protected domain routes receive the resolved actor and payload separately', async () => {
  const calls = []
  const activeUser = { _id: 'actor-1', username: 'admin', role: 'super_admin', status: 'active' }
  const harness = createRouteHarness({
    user: activeUser,
    protectedRoutes: {
      listTemplates: async ({ actor, payload }) => {
        calls.push({ actorId: actor._id, forged: payload.actorId })
        return { items: [] }
      }
    }
  })
  const result = await harness.api.main({ action: 'listTemplates', payload: { actorId: 'forged' } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{ actorId: activeUser._id, forged: 'forged' }])
})
```

Extend the existing local `createRouteHarness` parameter object to accept `protectedRoutes` and forward it into `createBusinessApi`; do not add a second harness abstraction.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `node --test cloudfunctions/businessApi/test/account-routes.test.js`

Expected: FAIL because `createBusinessApi` does not accept or recognize `protectedRoutes`.

- [ ] **Step 3: Implement the minimal protected-route seam**

Change the factory shape and route selection without weakening existing account behavior:

```js
function createBusinessApi({
  repository,
  authService,
  adminUserService,
  protectedRoutes = Object.create(null),
  legacyRoutes = Object.create(null),
  getContext,
  clock = Date.now,
  logger = console
}) { /* existing setup */ }

const knownProtectedAction = hasOwn(protectedRoutes, action) && typeof protectedRoutes[action] === 'function'
assert(knownAccountAction || knownProtectedAction || knownLegacyAction, 'Unsupported action', 'UNKNOWN_ACTION')
const actor = isPublicAction(action) ? null : await resolveActor(openid)
const data = route
  ? await route()
  : knownProtectedAction
    ? await protectedRoutes[action]({ actor, payload })
    : await legacyRoutes[action](actor.openid, payload)
```

Keep error logs restricted to allowlisted codes and safe target IDs; do not log payloads.

- [ ] **Step 4: Run focused and full backend tests**

Run:

```powershell
node --test cloudfunctions/businessApi/test/account-routes.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

Expected: both commands PASS with zero failures.

- [ ] **Step 5: Record progress and commit explicit paths**

Update `docs/memory/STATUS.md`, then run:

```powershell
git add -- cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js docs/memory/STATUS.md
git commit -m "refactor: add protected domain route seam"
```

---

### Task 2: Implement template and field domain policies

**Files:**
- Create: `cloudfunctions/businessApi/lib/field-domain.js`
- Create: `cloudfunctions/businessApi/lib/template-domain.js`
- Create: `cloudfunctions/businessApi/test/field-domain.test.js`
- Create: `cloudfunctions/businessApi/test/template-domain.test.js`

**Interfaces:**
- Produces: `normalizeFieldDefinition(input)`, `validateFieldValues(definitions, submitted)`, `normalizeTemplateNode(input)`, `validateTemplateForEnable(template, nodes, activeUserIds)`, and `assertTemplateEditable(template)`.
- Error contract: throws typed errors with `INVALID_FIELD_VALUE`, `TEMPLATE_INVALID`, or `TEMPLATE_NOT_EDITABLE`.

- [ ] **Step 1: Write failing field-policy tests**

Cover all seven types, required values, text length/regex, numeric range/decimals, strict booleans, `YYYY-MM-DD`, fixed select options, duplicate multi-select values, unknown keys, and duplicate submitted keys:

```js
test('validates and snapshots typed field values in definition order', () => {
  const definitions = [
    { fieldKey: 'f-text', sequence: 0, name: '说明', type: 'short_text', required: true, constraints: { minLength: 2, maxLength: 20 } },
    { fieldKey: 'f-count', sequence: 1, name: '数量', type: 'number', required: true, constraints: { min: 0, max: 10, decimalPlaces: 0 } }
  ]
  assert.deepEqual(validateFieldValues(definitions, [
    { fieldKey: 'f-count', value: 3 },
    { fieldKey: 'f-text', value: '完成' }
  ]), [
    { fieldKey: 'f-text', name: '说明', type: 'short_text', value: '完成' },
    { fieldKey: 'f-count', name: '数量', type: 'number', value: 3 }
  ])
})
```

- [ ] **Step 2: Run field tests and observe missing-module failure**

Run: `node --test cloudfunctions/businessApi/test/field-domain.test.js`

Expected: FAIL because `field-domain.js` does not exist.

- [ ] **Step 3: Implement strict field normalization and value validation**

Export a frozen field-type set and return denormalized value snapshots:

```js
const FIELD_TYPES = Object.freeze([
  'short_text', 'long_text', 'number', 'boolean',
  'date', 'single_select', 'multi_select'
])

function validateFieldValues(definitions, submitted) {
  const valuesByKey = indexSubmittedValues(submitted)
  rejectUnknownKeys(definitions, valuesByKey)
  return definitions.slice().sort(bySequence).map(definition => ({
    fieldKey: definition.fieldKey,
    name: definition.name,
    type: definition.type,
    value: validateOneValue(definition, valuesByKey.get(definition.fieldKey))
  }))
}
```

Validate regular-expression syntax during definition normalization and cap expression length with an exported constant so runtime evaluation remains bounded.

- [ ] **Step 4: Write failing template-policy tests**

Test stable unique node/field keys, contiguous sequence normalization, at least one node, positive SLA defaulting to 22, supported evidence types, active assignees, and enabled-template edit rejection.

- [ ] **Step 5: Run template tests and observe failure**

Run: `node --test cloudfunctions/businessApi/test/template-domain.test.js`

Expected: FAIL because `template-domain.js` does not exist.

- [ ] **Step 6: Implement template/node lifecycle policies**

```js
function assertTemplateEditable(template) {
  if (template.status === 'enabled') throw createError('TEMPLATE_NOT_EDITABLE')
  if (template.status === 'deleted') throw createError('NOT_FOUND')
}

function validateTemplateForEnable(template, nodes, activeUserIds) {
  if (!nodes.length) throw createError('TEMPLATE_INVALID')
  const active = new Set(activeUserIds)
  for (const node of nodes) {
    if (!node.assigneeUserIds.length || node.assigneeUserIds.some(id => !active.has(id))) {
      throw createError('ASSIGNEE_INACTIVE')
    }
  }
  return true
}
```

- [ ] **Step 7: Run both focused suites and the backend regression suite**

Run:

```powershell
node --test cloudfunctions/businessApi/test/field-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

Expected: PASS with zero failures.

- [ ] **Step 8: Record progress and commit**

```powershell
git add -- cloudfunctions/businessApi/lib/field-domain.js cloudfunctions/businessApi/lib/template-domain.js cloudfunctions/businessApi/test/field-domain.test.js cloudfunctions/businessApi/test/template-domain.test.js docs/memory/STATUS.md
git commit -m "feat: add template and field domain policies"
```

---

### Task 3: Add template persistence, service, and API routes

**Files:**
- Create: `cloudfunctions/businessApi/lib/template-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-template-repository.js`
- Create: `cloudfunctions/businessApi/test/template-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-template-repository.test.js`
- Create: `cloudfunctions/businessApi/test/helpers/template-harness.js`
- Modify: `cloudfunctions/businessApi/test/helpers/fake-cloud-database.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- Service: `listTemplates({ actor, query })`, `getTemplate({ actor, templateId })`, `createTemplate({ actor, input })`, `updateTemplate({ actor, templateId, expectedVersion, input })`, `changeTemplateStatus({ actor, templateId, expectedVersion, status })`, `deleteTemplate({ actor, templateId, expectedVersion })`, `listEnabledTemplates({ actor })`.
- Repository: fixed-ID reads, filtered lists, `createTemplateDefinition(...)`, and `mutateTemplateDefinition(...)` with version revalidation and one audit record.

- [ ] **Step 1: Write failing service authorization and lifecycle tests**

```js
test('enabled templates must be disabled before definition updates', async () => {
  const harness = createTemplateHarness({ templates: [{ _id: 't1', status: 'enabled', version: 4 }] })
  await assert.rejects(
    harness.service.updateTemplate({ actor: harness.admin, templateId: 't1', expectedVersion: 4, input: validDefinition }),
    error => error.code === 'TEMPLATE_NOT_EDITABLE'
  )
})
```

Also test ordinary-user write denial, draft creation, enable validation, disable/edit/re-enable, logical deletion, inactive-assignee creation blocking, public projections, and version conflict.

- [ ] **Step 2: Run service tests and observe failure**

Run: `node --test cloudfunctions/businessApi/test/template-service.test.js`

Expected: FAIL because service and harness do not exist.

- [ ] **Step 3: Implement the service with injected key factory**

Generate stable keys on create only; preserve supplied keys on update and reject reuse within the same definition:

```js
function createTemplateService({ repository, clock, keyFactory }) {
  async function updateTemplate({ actor, templateId, expectedVersion, input }) {
    requireSuperAdmin(actor)
    const current = await repository.getTemplateDefinition(templateId)
    assertTemplateEditable(current.template)
    const definition = assignStableKeys(current, input, keyFactory)
    return repository.saveTemplateDefinition({ actor, current, expectedVersion, definition, clock: clock() })
  }
  return { listTemplates, getTemplate, createTemplate, updateTemplate, changeTemplateStatus, deleteTemplate, listEnabledTemplates }
}
```

- [ ] **Step 4: Write failing repository transaction tests**

Cover atomic metadata/nodes/audit writes, version revalidation, rollback, server dates, deterministic sorting, and failure if the template disappears during mutation.

- [ ] **Step 5: Extend the fake database only for observed missing behavior**

Add the minimum query/transaction operation required by the failing repository tests; preserve all account transaction tests.

- [ ] **Step 6: Implement the CloudBase template repository**

Use `templates`, `template_nodes`, `users`, and `audit_logs`. Replace node definitions inside the same transaction only after fixed-document version and status revalidation.

- [ ] **Step 7: Wire protected template routes and safe error codes**

Default route map:

```js
const protectedRoutes = {
  listTemplates: ({ actor, payload }) => templateService.listTemplates({ actor, query: payload }),
  getTemplate: ({ actor, payload }) => templateService.getTemplate({ actor, templateId: payload.templateId }),
  createTemplate: ({ actor, payload }) => templateService.createTemplate({ actor, input: payload }),
  updateTemplate: ({ actor, payload }) => templateService.updateTemplate({ actor, templateId: payload.templateId, expectedVersion: payload.expectedVersion, input: payload.definition }),
  changeTemplateStatus: ({ actor, payload }) => templateService.changeTemplateStatus({ actor, templateId: payload.templateId, expectedVersion: payload.expectedVersion, status: payload.status }),
  deleteTemplate: ({ actor, payload }) => templateService.deleteTemplate({ actor, templateId: payload.templateId, expectedVersion: payload.expectedVersion }),
  listEnabledTemplates: ({ actor }) => templateService.listEnabledTemplates({ actor })
}
```

Add every new application error code to `LOGGABLE_ERROR_CODES` without adding payload logging.

- [ ] **Step 8: Run template, route, and full backend suites**

Run:

```powershell
node --test cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

Expected: PASS with zero failures.

- [ ] **Step 9: Record progress and commit**

Stage the exact files listed in this task plus `docs/memory/STATUS.md`, then commit:

```powershell
git add -- cloudfunctions/businessApi/lib/template-service.js cloudfunctions/businessApi/lib/cloud-template-repository.js cloudfunctions/businessApi/test/template-service.test.js cloudfunctions/businessApi/test/cloud-template-repository.test.js cloudfunctions/businessApi/test/helpers/template-harness.js cloudfunctions/businessApi/test/helpers/fake-cloud-database.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js docs/memory/STATUS.md
git commit -m "feat: add protected template management API"
```

---

### Task 4: Build super-administrator template pages

**Files:**
- Create: `miniprogram/services/templates.js`
- Create: `miniprogram/pages/admin-templates/index.js`
- Create: `miniprogram/pages/admin-templates/index.json`
- Create: `miniprogram/pages/admin-templates/index.wxml`
- Create: `miniprogram/pages/admin-templates/index.wxss`
- Create: `miniprogram/pages/admin-template-edit/index.js`
- Create: `miniprogram/pages/admin-template-edit/index.json`
- Create: `miniprogram/pages/admin-template-edit/index.wxml`
- Create: `miniprogram/pages/admin-template-edit/index.wxss`
- Create: `miniprogram/pages/admin-template-node-edit/index.js`
- Create: `miniprogram/pages/admin-template-node-edit/index.json`
- Create: `miniprogram/pages/admin-template-node-edit/index.wxml`
- Create: `miniprogram/pages/admin-template-node-edit/index.wxss`
- Create: `miniprogram/test/template-flow.test.js`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/pages/dashboard/index.js`
- Modify: `miniprogram/pages/dashboard/index.wxml`

**Interfaces:**
- Client service mirrors the seven template actions from Task 3.
- Node editor returns a normalized node object to the template editor through the previous page instance; secrets and account identity values never enter navigation URLs.

- [ ] **Step 1: Write failing client service and route-registration tests**

```js
test('template service forwards protected actions with exact payloads', async () => {
  await templates.updateTemplate('t1', 3, definition)
  assert.deepEqual(calls.at(-1), ['updateTemplate', { templateId: 't1', expectedVersion: 3, definition }])
})
```

Assert `app.json` registers all three pages and dashboard navigation is visible only for `super_admin`.

- [ ] **Step 2: Run the client test and observe failure**

Run: `node --test miniprogram/test/template-flow.test.js`

Expected: FAIL because the service and pages do not exist.

- [ ] **Step 3: Implement the service and protected template list**

The page must re-check `getApp().globalData.currentUser.role`, redirect non-super-administrators, filter by status/name, and confirm state changes.

- [ ] **Step 4: Add failing editor tests**

Test stable-key preservation, node add/edit/delete/reorder, at least one node, enable error rendering, stale-version refresh, and read-only rendering when status is `enabled`.

- [ ] **Step 5: Implement template and node/field editors**

Use explicit field-type options:

```js
const FIELD_TYPE_OPTIONS = [
  ['short_text', '短文本'], ['long_text', '长文本'], ['number', '数字'],
  ['boolean', '布尔'], ['date', '日期'], ['single_select', '单选'],
  ['multi_select', '多选']
]
```

Load active account options through the existing administrator user service. Store user document IDs in `assigneeUserIds`. Disable every definition control while the template is enabled.

- [ ] **Step 6: Run client, WXML, and backend regression checks**

Run:

```powershell
node --test miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
npm.cmd test --prefix cloudfunctions/businessApi
```

Expected: all commands PASS.

- [ ] **Step 7: Record progress and commit**

Stage only the Task 4 files and `docs/memory/STATUS.md`, then commit:

```powershell
git add -- miniprogram/services/templates.js miniprogram/pages/admin-templates miniprogram/pages/admin-template-edit miniprogram/pages/admin-template-node-edit miniprogram/test/template-flow.test.js miniprogram/app.json miniprogram/pages/dashboard/index.js miniprogram/pages/dashboard/index.wxml docs/memory/STATUS.md
git commit -m "feat: add administrator template editor"
```

---

### Task 5: Implement generated numbering and atomic template snapshots

**Files:**
- Create: `cloudfunctions/businessApi/lib/business-numbering.js`
- Create: `cloudfunctions/businessApi/lib/business-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Create: `cloudfunctions/businessApi/test/business-numbering.test.js`
- Create: `cloudfunctions/businessApi/test/business-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Create: `cloudfunctions/businessApi/test/helpers/business-harness.js`
- Modify: `cloudfunctions/businessApi/test/helpers/fake-cloud-database.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- `formatBusinessCode(now, sequence, timeZone = 'Asia/Shanghai') -> string`.
- `formatNodeCode(businessCode, oneBasedSequence) -> string`.
- `businessService.createFromTemplate({ actor, input: { templateId, name, description, plannedStartDate, plannedEndDate, requestKey } }) -> { id, code }`.
- Repository atomically allocates the daily sequence, revalidates the enabled template and assignees, writes the invisible `creating` instance plus nodes, then publishes it as `active`.

- [ ] **Step 1: Write failing code-format tests**

```js
test('business and node codes expand without wrapping', () => {
  const date = new Date('2026-08-07T00:30:00+08:00')
  assert.equal(formatBusinessCode(date, 7), 'BL-20260807-0007')
  assert.equal(formatBusinessCode(date, 10000), 'BL-20260807-10000')
  assert.equal(formatNodeCode('BL-20260807-0007', 1), 'BL-20260807-0007-N001')
})
```

- [ ] **Step 2: Run and observe missing-module failure**

Run: `node --test cloudfunctions/businessApi/test/business-numbering.test.js`

- [ ] **Step 3: Implement pure numbering functions**

Use `Intl.DateTimeFormat(..., { timeZone: 'Asia/Shanghai' })` parts; reject non-safe or non-positive sequence values.

- [ ] **Step 4: Write failing snapshot and concurrency tests**

Cover generated code, immutable node codes, copied field definitions, source template/version, creator manager membership, all assignees in members, first-node activation, inactive-assignee fail-closed behavior, duplicate `requestKey` idempotency, and concurrent sequence uniqueness.

- [ ] **Step 5: Implement business service and CloudBase repository**

Create snapshot node data explicitly:

```js
const snapshotNode = {
  businessLineId,
  nodeCode: formatNodeCode(code, index + 1),
  sourceTemplateNodeKey: source.nodeKey,
  sequence: index,
  name: source.name,
  description: source.description,
  assigneeUserIds: [...source.assigneeUserIds],
  slaWorkHours: source.slaWorkHours,
  requiresEvidence: source.requiresEvidence,
  allowedEvidenceTypes: [...source.allowedEvidenceTypes],
  fieldDefinitions: JSON.parse(JSON.stringify(source.fields)),
  status: index === 0 ? 'ready' : 'waiting',
  version: 1
}
```

Use a deterministic request reservation keyed by actor ID plus validated `requestKey` so retries return the same created line.

- [ ] **Step 6: Wire `createBusinessFromTemplate` and replace the new-create legacy route**

Keep legacy reads. Stop accepting client-provided `code` and `nodes` on the new action.

- [ ] **Step 7: Run focused, route, and full backend suites**

Run:

```powershell
node --test cloudfunctions/businessApi/test/business-numbering.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

- [ ] **Step 8: Record progress and commit**

Stage exact Task 5 paths and `docs/memory/STATUS.md`, then commit:

```powershell
git add -- cloudfunctions/businessApi/lib/business-numbering.js cloudfunctions/businessApi/lib/business-service.js cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/test/business-numbering.test.js cloudfunctions/businessApi/test/business-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/helpers/business-harness.js cloudfunctions/businessApi/test/helpers/fake-cloud-database.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js docs/memory/STATUS.md
git commit -m "feat: create business snapshots with generated codes"
```

---

### Task 6: Replace the ordinary template selection and business-create UI

**Files:**
- Modify: `miniprogram/pages/template-list/index.js`
- Modify: `miniprogram/pages/template-list/index.wxml`
- Modify: `miniprogram/pages/template-list/index.wxss`
- Modify: `miniprogram/pages/business-edit/index.js`
- Modify: `miniprogram/pages/business-edit/index.wxml`
- Modify: `miniprogram/pages/business-edit/index.wxss`
- Modify: `miniprogram/services/business.js`
- Create: `miniprogram/test/business-template-flow.test.js`

**Interfaces:**
- `templates.listEnabledTemplates()` returns `{ items: [{ _id, name, description, nodeCount, available, unavailableReason }] }`.
- `business.createBusinessFromTemplate(input)` forwards `templateId`, metadata, and a per-attempt `requestKey`; no code or node definitions.

- [ ] **Step 1: Write failing template-selection tests**

Test loading state, enabled-template display, unavailable-assignee messaging, selection navigation with only template ID, and no demo hardcoded item.

- [ ] **Step 2: Run and observe failure**

Run: `node --test miniprogram/test/business-template-flow.test.js`

- [ ] **Step 3: Implement the ordinary template list**

```js
selectTemplate(event) {
  const { id, available } = event.currentTarget.dataset
  if (!available) return wx.showToast({ title: '模板负责人不可用，请联系管理员', icon: 'none' })
  wx.navigateTo({ url: `/pages/business-edit/index?templateId=${encodeURIComponent(id)}` })
}
```

- [ ] **Step 4: Add failing create-form tests**

Assert the form displays a server preview, contains no editable business-code/node controls, validates dates, generates one request key per create attempt, and redirects to the returned business ID.

- [ ] **Step 5: Implement template-backed create and metadata-only active edit**

For edit mode, show immutable code and nodes and submit only name, description, planned dates, and expected business version. Reject edits when the server reports frozen state.

- [ ] **Step 6: Run client and WXML regressions**

```powershell
node --test miniprogram/test/business-template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
```

- [ ] **Step 7: Record progress and commit**

```powershell
git add -- miniprogram/pages/template-list miniprogram/pages/business-edit miniprogram/services/business.js miniprogram/test/business-template-flow.test.js docs/memory/STATUS.md
git commit -m "feat: create business lines from enabled templates"
```

---

### Task 7: Register and authorize image, PDF, and video evidence

**Files:**
- Create: `cloudfunctions/businessApi/lib/evidence-policy.js`
- Create: `cloudfunctions/businessApi/lib/evidence-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-evidence-repository.js`
- Create: `cloudfunctions/businessApi/test/evidence-policy.test.js`
- Create: `cloudfunctions/businessApi/test/evidence-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-evidence-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- `classifyAndValidateFile({ fileName, declaredSize, bytes, allowedTypes }) -> { category, extension, size, sha256 }`.
- `registerUpload({ actor, input: { businessLineId, nodeId, fileId, fileName, declaredSize } }) -> { evidenceId, metadata }`.
- `getAccessGrant({ actor, evidenceId }) -> { url, fileName, category, expiresAt }` only while `storageStatus === 'available'`.

- [ ] **Step 1: Write failing signature and limit tests**

Use small byte fixtures for JPEG, PNG, PDF, and ISO base media `ftyp`; test spoofed extensions, unsupported types, each single-file boundary, and the exported 20 MB feedback-total helper.

- [ ] **Step 2: Run policy tests and observe failure**

Run: `node --test cloudfunctions/businessApi/test/evidence-policy.test.js`

- [ ] **Step 3: Implement file policy without trusting client MIME**

```js
function detectSignature(bytes) {
  if (bytes.subarray(0, 4).toString() === '%PDF') return 'pdf'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video'
  throw createError('UNSUPPORTED_FILE_TYPE')
}
```

- [ ] **Step 4: Write failing registration/access tests**

Cover membership, active-node ownership, cloud download inspection, allowed template type, secret-free metadata, orphan expiry, purged-file denial, and short-lived authorized access.

- [ ] **Step 5: Implement evidence service and repository**

Default cloud inspection uses `cloud.downloadFile({ fileID })`, hashes the returned buffer, and stores an unattached evidence record with `orphanExpiresAt` 24 hours later. Access uses a temporary URL adapter and never returns a permanent public URL.

- [ ] **Step 6: Wire `registerEvidenceUpload` and `getEvidenceAccess`**

Add safe errors: `UNSUPPORTED_FILE_TYPE`, `FILE_TOO_LARGE`, `EVIDENCE_EXPIRED`, and `EVIDENCE_NOT_ATTACHABLE`.

- [ ] **Step 7: Run focused and full backend suites**

```powershell
node --test cloudfunctions/businessApi/test/evidence-policy.test.js cloudfunctions/businessApi/test/evidence-service.test.js cloudfunctions/businessApi/test/cloud-evidence-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

- [ ] **Step 8: Record progress and commit**

Stage exact Task 7 paths and `docs/memory/STATUS.md`, then commit:

```powershell
git add -- cloudfunctions/businessApi/lib/evidence-policy.js cloudfunctions/businessApi/lib/evidence-service.js cloudfunctions/businessApi/lib/cloud-evidence-repository.js cloudfunctions/businessApi/test/evidence-policy.test.js cloudfunctions/businessApi/test/evidence-service.test.js cloudfunctions/businessApi/test/cloud-evidence-repository.test.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js docs/memory/STATUS.md
git commit -m "feat: validate and authorize evidence uploads"
```

---

### Task 8: Add immutable dynamic feedback and OR-sign completion

**Files:**
- Create: `cloudfunctions/businessApi/lib/feedback-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-feedback-repository.js`
- Create: `cloudfunctions/businessApi/test/feedback-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-feedback-repository.test.js`
- Create: `cloudfunctions/businessApi/test/helpers/feedback-harness.js`
- Modify: `cloudfunctions/businessApi/test/helpers/fake-cloud-database.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`

**Interfaces:**
- `submitFeedback({ actor, input: { businessLineId, nodeId, expectedNodeVersion, status, fieldValues, comment, evidenceIds, requestKey } }) -> { feedbackId, revision, nodeStatus, lineStatus }`.
- `getNodeHistory({ actor, businessLineId, nodeId })` returns immutable revisions and evidence metadata projections.

- [ ] **Step 1: Write failing service tests**

Cover dynamic field snapshots, required fields, aggregate evidence bytes, evidence ownership/attachment, first revision, blocked/in-progress updates, required evidence on completion, non-assignee denial, and frozen-line denial.

- [ ] **Step 2: Run and observe failure**

Run: `node --test cloudfunctions/businessApi/test/feedback-service.test.js`

- [ ] **Step 3: Implement feedback validation orchestration**

```js
const fieldSnapshots = validateFieldValues(node.fieldDefinitions, input.fieldValues)
validateFeedbackEvidenceTotal(evidences)
return repository.commitFeedback({
  actorId: actor._id,
  line,
  node,
  expectedNodeVersion: input.expectedNodeVersion,
  status: input.status,
  fieldSnapshots,
  evidenceIds: input.evidenceIds,
  requestKey: input.requestKey
})
```

- [ ] **Step 4: Write failing repository concurrency tests**

Run two completion promises against the same node version. Assert one revision advances the line and next node, the other returns `NODE_ALREADY_COMPLETED`, and no evidence is attached twice.

- [ ] **Step 5: Implement atomic commit and revision allocation**

Within one transaction, re-read line/node/evidences, validate versions and statuses, allocate `revision = latestRevision + 1`, attach evidence, write feedback, update node, activate the next node or freeze the completed line, and write one audit record.

- [ ] **Step 6: Replace legacy feedback/history routes with protected service routes**

Keep a projection adapter so pre-version legacy feedback remains readable. New writes must use account IDs and the new service.

- [ ] **Step 7: Run focused and full suites**

```powershell
node --test cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

- [ ] **Step 8: Record progress and commit**

```powershell
git add -- cloudfunctions/businessApi/lib/feedback-service.js cloudfunctions/businessApi/lib/cloud-feedback-repository.js cloudfunctions/businessApi/test/feedback-service.test.js cloudfunctions/businessApi/test/cloud-feedback-repository.test.js cloudfunctions/businessApi/test/helpers/feedback-harness.js cloudfunctions/businessApi/test/helpers/fake-cloud-database.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js docs/memory/STATUS.md
git commit -m "feat: add immutable typed node feedback"
```

---

### Task 9: Add rejection, frozen-state enforcement, and audited amendments

**Files:**
- Create: `cloudfunctions/businessApi/lib/business-lifecycle-service.js`
- Create: `cloudfunctions/businessApi/test/business-lifecycle-service.test.js`
- Modify: `cloudfunctions/businessApi/lib/cloud-business-repository.js`
- Modify: `cloudfunctions/businessApi/test/cloud-business-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `cloudfunctions/businessApi/test/domain.test.js`

**Interfaces:**
- `rejectPreviousNode({ actor, input: { businessLineId, currentNodeId, expectedCurrentVersion, expectedPreviousVersion, reason, requestKey } })`.
- `closeBusinessLine({ actor, input: { businessLineId, expectedVersion, outcome, reason } })`, with `outcome` restricted to `cancelled | closed | deleted`.
- `amendFrozenBusiness({ actor, input: { businessLineId, expectedVersion, reason, changes, evidenceIds } })`.

- [ ] **Step 1: Write failing rejection tests**

Test current active assignee only, immediate predecessor only, reason required, current node incomplete, previous completed, both expected versions, no deadline reset, preserved feedback/evidence, current node back to waiting, and idempotent retry.

- [ ] **Step 2: Run and observe failure**

Run: `node --test cloudfunctions/businessApi/test/business-lifecycle-service.test.js`

- [ ] **Step 3: Implement rejection orchestration and atomic transition**

```js
await repository.rejectPreviousNode({
  actorId: actor._id,
  lineId: input.businessLineId,
  currentNodeId: input.currentNodeId,
  expectedCurrentVersion: input.expectedCurrentVersion,
  expectedPreviousVersion: input.expectedPreviousVersion,
  reason: requireReason(input.reason),
  requestKey: input.requestKey
})
```

Update status/rejection timestamps and counters only; do not replace `dueAt`, `completedAt`, prior feedback, or evidence records.

- [ ] **Step 4: Add failing freeze and amendment tests**

Assert ordinary metadata updates, feedback, member changes, and deletion fail with `BUSINESS_FROZEN`; super-administrator amendment requires a reason, allowlisted changes, exact before/after snapshot, version check, and one audit event.

- [ ] **Step 5: Implement close/freeze/amendment behavior**

On completion/cancellation/closure/deletion set `frozenAt`, retention start, and each available evidence `purgeDueAt = retentionStartedAt + 60 calendar days`. Logical deletion also records a closure time so files cannot remain indefinitely.

- [ ] **Step 6: Wire protected lifecycle routes and guard legacy updates**

Add `rejectPreviousNode`, `closeBusinessLine`, and `amendFrozenBusiness`. Make legacy `updateBusinessLine` reject frozen statuses and make business code immutable.

- [ ] **Step 7: Run lifecycle, repository, route, and regression tests**

```powershell
node --test cloudfunctions/businessApi/test/business-lifecycle-service.test.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/test/account-routes.test.js cloudfunctions/businessApi/test/domain.test.js
npm.cmd test --prefix cloudfunctions/businessApi
```

- [ ] **Step 8: Record progress and commit**

Stage exact Task 9 paths and `docs/memory/STATUS.md`, then commit:

```powershell
git add -- cloudfunctions/businessApi/lib/business-lifecycle-service.js cloudfunctions/businessApi/test/business-lifecycle-service.test.js cloudfunctions/businessApi/lib/cloud-business-repository.js cloudfunctions/businessApi/test/cloud-business-repository.test.js cloudfunctions/businessApi/index.js cloudfunctions/businessApi/test/account-routes.test.js cloudfunctions/businessApi/test/domain.test.js docs/memory/STATUS.md
git commit -m "feat: enforce rejection and frozen business rules"
```

---

### Task 10: Build dynamic feedback, evidence, rejection, and amendment UI

**Files:**
- Modify: `miniprogram/services/business.js`
- Modify: `miniprogram/pages/node-feedback/index.js`
- Modify: `miniprogram/pages/node-feedback/index.wxml`
- Modify: `miniprogram/pages/node-feedback/index.wxss`
- Modify: `miniprogram/pages/business-detail/index.js`
- Modify: `miniprogram/pages/business-detail/index.wxml`
- Modify: `miniprogram/pages/business-detail/index.wxss`
- Create: `miniprogram/pages/admin-business-amend/index.js`
- Create: `miniprogram/pages/admin-business-amend/index.json`
- Create: `miniprogram/pages/admin-business-amend/index.wxml`
- Create: `miniprogram/pages/admin-business-amend/index.wxss`
- Create: `miniprogram/test/node-feedback-v2.test.js`
- Create: `miniprogram/test/admin-business-amend-flow.test.js`
- Modify: `miniprogram/app.json`

**Interfaces:**
- Service adds `registerEvidenceUpload`, `getEvidenceAccess`, `submitFeedback`, `rejectPreviousNode`, `closeBusinessLine`, and `amendFrozenBusiness`.
- Feedback page builds `fieldValues` from `fieldKey` and uses server-provided node/line versions.

- [ ] **Step 1: Write failing dynamic-form tests**

Test every field component, strict boolean handling, select values, validation messages, history revisions, frozen state, and no business data in navigation parameters beyond IDs.

- [ ] **Step 2: Run and observe failure**

Run: `node --test miniprogram/test/node-feedback-v2.test.js`

- [ ] **Step 3: Implement dynamic fields and immutable history**

Use one event handler keyed by field key:

```js
onFieldInput(event) {
  const key = event.currentTarget.dataset.fieldkey
  this.setData({ [`fieldValues.${key}`]: event.detail.value })
}
```

Convert the object to an ordered array before submit and preserve typed booleans/numbers.

- [ ] **Step 4: Add failing image/PDF/video tests**

Assert `wx.chooseMedia` selects images/videos, `wx.chooseMessageFile` selects PDFs, per-file and aggregate limits are enforced before upload, registered evidence IDs are submitted, video uses `<video>`, PDF uses `wx.openDocument`, and purged evidence has no preview action.

- [ ] **Step 5: Implement upload, registration, access, preview, and sequential download**

Upload one file at a time, register it immediately, retain successful evidence IDs across retry, and show failed items. Do not use raw permanent file IDs for authorized preview; request a temporary access grant first.

- [ ] **Step 6: Add failing rejection and amendment page tests**

Test reject visibility only on the current active node, mandatory reason, version payloads, frozen badges, super-admin-only amendment navigation, before/after review, and reason clearing after submission.

- [ ] **Step 7: Implement rejection and amendment interactions**

Use a dedicated masked-free multiline reason form rather than an editable modal. On version conflict, reload business detail before allowing retry.

- [ ] **Step 8: Run all client, WXML, and backend suites**

```powershell
node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js miniprogram/test/business-template-flow.test.js miniprogram/test/template-flow.test.js miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js
node tools/test-wxml-structure.mjs
npm.cmd test --prefix cloudfunctions/businessApi
```

- [ ] **Step 9: Record progress and commit**

Stage exact Task 10 paths and `docs/memory/STATUS.md`, then commit:

```powershell
git add -- miniprogram/services/business.js miniprogram/pages/node-feedback miniprogram/pages/business-detail miniprogram/pages/admin-business-amend miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js miniprogram/app.json docs/memory/STATUS.md
git commit -m "feat: add dynamic feedback and business correction UI"
```

---

### Task 11: Add the scheduled retention and reminder worker

**Files:**
- Create: `cloudfunctions/evidenceRetention/lib/retention-service.js`
- Create: `cloudfunctions/evidenceRetention/test/retention-service.test.js`
- Create: `cloudfunctions/evidenceRetention/index.js`
- Create: `cloudfunctions/evidenceRetention/package.json`
- Create: `cloudfunctions/evidenceRetention/package-lock.json`

**Interfaces:**
- `createRetentionService({ repository, storage, clock, batchSize })`.
- `runOnce()` returns `{ remindersCreated, objectsPurged, orphansPurged, failures }` without identity or file-content data.
- Reminder idempotency key: `evidence-retention:<businessLineId>:<15|7|1>`.

- [ ] **Step 1: Write failing deterministic retention tests**

Use a fixed clock. Cover 15/7/1-day reminders, completed/cancelled/closed/deleted lines, exact 60-day boundary, not-yet-due files, already-purged files, missing cloud objects treated as successful purge, transient delete failure, retry counters, and 24-hour unattached orphan cleanup.

- [ ] **Step 2: Run and observe missing-module failure**

Run: `node --test cloudfunctions/evidenceRetention/test/retention-service.test.js`

- [ ] **Step 3: Implement pure orchestration**

```js
async function runOnce() {
  const now = clock()
  const remindersCreated = await createDueReminders(now)
  const objectsPurged = await purgeDueEvidence(now)
  const orphansPurged = await purgeExpiredOrphans(now)
  return { remindersCreated, objectsPurged, orphansPurged, failures }
}
```

Process bounded pages; update `purged` only after successful deletion or confirmed absence. Store a safe error category, not provider messages containing paths or identities.

- [ ] **Step 4: Implement CloudBase adapters and scheduled entry**

Initialize `cloud.DYNAMIC_CURRENT_ENV`, query by `storageStatus + purgeDueAt`, delete with `cloud.deleteFile({ fileList })`, and create notifications with deterministic IDs or unique keys.

- [ ] **Step 5: Install the pinned dependency and verify the lockfile**

Create `package.json` with `"scripts": { "test": "node --test test/*.test.js" }`, then run from `cloudfunctions/evidenceRetention`:

```powershell
npm.cmd install --save-exact wx-server-sdk@4.0.2
npm.cmd test
```

Expected: lockfile pins `4.0.2`; retention tests PASS.

- [ ] **Step 6: Run project regressions**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/evidenceRetention
node tools/test-wxml-structure.mjs
```

- [ ] **Step 7: Record progress and commit**

```powershell
git add -- cloudfunctions/evidenceRetention docs/memory/STATUS.md
git commit -m "feat: purge expired evidence with reminders"
```

---

### Task 12: Document CloudBase setup and complete release verification

**Files:**
- Create: `docs/deployment/template-node-fields-setup.md`
- Modify: `README.md`
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`
- Modify if index bootstrap is implemented as code: `cloudfunctions/businessApi/test/cloud-template-repository.test.js`

**Interfaces:**
- Operator runbook covers `templates`, `template_nodes`, `sequence_counters`, new/changed indexes, `businessApi`, `evidenceRetention`, scheduled trigger, backup, rollback, and redacted acceptance.

- [ ] **Step 1: Write the deployment and rollback procedure**

Include this exact safe order:

1. Back up affected collections and confirm export readability.
2. Create `sequence_counters` and any missing collections.
3. Create unique `business_lines.code` and `business_nodes.nodeCode` indexes only after checking existing non-empty values for duplicates.
4. Create query indexes from the design.
5. Upload `businessApi` with cloud dependency installation.
6. Upload `evidenceRetention` with cloud dependency installation.
7. Configure one daily scheduled trigger and record its timezone behavior.
8. Recompile the Mini Program and execute the staged acceptance checklist.

Rollback must disable the scheduled trigger first, restore the previous `businessApi`, keep new collections intact, and never delete evidence or audit data merely to roll back code.

- [ ] **Step 2: Add a redacted manual acceptance matrix**

Cover template lifecycle, field types, inactive assignee block, generated numbering, snapshot isolation, OR-sign race, rejection/rework, freeze/amendment, image/PDF/video, download, and accelerated retention testing. Mark every real CloudBase check unverified until the operator executes it.

- [ ] **Step 3: Run all automated verification**

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
npm.cmd test --prefix cloudfunctions/evidenceRetention
node --test miniprogram/test/account-flow.test.js miniprogram/test/admin-users-flow.test.js miniprogram/test/template-flow.test.js miniprogram/test/business-template-flow.test.js miniprogram/test/node-feedback-v2.test.js miniprogram/test/admin-business-amend-flow.test.js
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Expected: all commands PASS; any manual CloudBase or multi-account result not executed remains explicitly unverified.

- [ ] **Step 4: Inspect scope and sensitive-data boundaries**

Run:

```powershell
git status --short --branch
git diff --stat
rg -n "password\s*[:=]|openid\s*[:=]|ADMIN_RECOVERY_CODE_SHA256\s*=" docs cloudfunctions miniprogram -g '!**/test/**' -g '!**/node_modules/**'
```

Inspect every match. No credential, identity value, recovery value, customer record, or file content may enter Git or project memory.

- [ ] **Step 5: Commit the deployment closeout**

```powershell
git add -- docs/deployment/template-node-fields-setup.md README.md docs/memory/PROJECT.md docs/memory/STATUS.md
git commit -m "docs: add template workflow deployment runbook"
```

- [ ] **Step 6: Report milestone progress and request manual acceptance**

Report exact commits, automated evidence, unchanged operator-owned files, CloudBase actions, and the first manual acceptance step. Do not claim cloud deployment complete before the operator confirms it.
