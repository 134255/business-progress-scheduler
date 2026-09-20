# Strict Product Option Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for bounded sidecar tasks and test-driven-development for implementation.

**Goal:** Configure the 45minup collection node with source-backed category, brand, model and applicable attribute single selects.
**Architecture:** Store one eight-column indexed combination matrix on the category field; reuse a pure resolver in server and client. Preserve original field identifiers and unrelated configuration.
**Tech Stack:** CommonJS Node.js, native WeChat Mini Program, openpyxl local importer.
**Spec:** `docs/superpowers/specs/2026-09-18-strict-product-option-linkage-design.md` (approved; user instructed direct implementation).

## Global Constraints

- Work in the current checkout; preserve all existing dirty changes. No commits, staging, pushes or unrelated cloud changes.
- Exactly eight ordered single-select members: category, brand, model, attributes E through I. Attribute null cells mean inapplicable, not selectable blank values.
- `optionLinkage = { schemaVersion: 1, fieldKeys: string[8], rows: (number|null)[8][] }`, stored only on first member. Dictionaries are each member's `constraints.options`.
- At most 5000 rows; matrix plus dictionaries at most 256 KiB; normalized linked node at most 512 KiB. Reject damaged, duplicate, sparse, accessor or prototype-bearing rule input.
- Source sheet uses cached values, not recalculated formulas. Restrict category to 灯具、人体工学椅、升降桌、儿童系列; exclude source rows 2185, 2859, 2860. Never commit real workbook rows/import artifacts.
- No existing permissions, schedules, accounts or unrelated fields change. No production test business records created.

## Task 1: Rule engine and server integration

Files: new `cloudfunctions/businessApi/lib/option-linkage-domain.js`, new `test/option-linkage-domain.test.js`, existing `field-domain.js`, `conditional-field-domain.js`.

- [ ] RED: Synthetic non-Cartesian fixtures must reject crossed attribute combinations, hidden injections, malformed matrices and over-budget groups.
- [ ] Implement pure `normalizeOptionLinkageInput(value)`, `buildOptionLinkageContext(fields)` returning `{ members: Map, project(field, valuesByKey) }`; project returns effective field or null, strips the matrix from projections. `optionLinkageSemanticProjection(fields, fieldKey)` describes all group members and rows or returns null. `jsonByteLength(value)` counts UTF-8 JSON size without runtime-specific dependencies.
- [ ] Normalize rule once per resolution, preserve absent-property legacy digests; group member fields cannot also have condition.
- [ ] GREEN: `node --test cloudfunctions/businessApi/test/option-linkage-domain.test.js cloudfunctions/businessApi/test/conditional-field-domain.test.js cloudfunctions/businessApi/test/field-domain.test.js`.

## Task 2: Source importer (independent sidecar)

Files: `tools/build-product-option-linkage.py`, `tools/test_product_option_linkage.py`.

- [ ] RED: unittest in-memory workbook fixture preserves commas/newlines in text, absent attr gaps and sparse legal combinations; invalid/conflicting rows excluded explicitly, no guessed values.
- [ ] CLI reads workbook Sheet1 cached values, columns B/D/E-I/L. Emits a structured import `{schemaVersion:1, fields:[{name,type,required,constraints}], optionLinkage:{schemaVersion:1,fieldKeys:[logical names],rows}}`, plus safe counts/digest. Actual file output only to explicit ignored qa path. Logical keys are category, brand, model, attribute1..attribute5.
- [ ] All eight dictionaries nonempty; unused attribute dictionaries use a reserved display string `不适用` but all row indices for that column stay null. Attributes only required when visible. Dedupe exact normalized tuple, not Cartesian-product expansion.
- [ ] `python -m unittest discover -s tools -p test_product_option_linkage.py`; actual workbook output count must equal 2495 and row digest match spec. Original workbook is read-only.

## Task 3: Template lifecycle

Files: `template-service.js`, `template-domain.js`, `template-copy-domain.js`, `workflow-routing-domain.js`, associated tests.

- [ ] RED create/update/copy tests with new field references and retained stable IDs; stale client rule-loss save rejected; members disallowed as routing controls.
- [ ] Remap explicit client field references into newly assigned stable keys. Preserve rule in normalization and copies. Require supported linkage save intent for replacing/removing a current group; compare prior linkage fingerprint in ordinary optimistic version flow.
- [ ] Enforce normalized linked-node byte budget; no new limit on unrelated legacy nodes.
- [ ] GREEN focused lifecycle tests and full businessApi suite.

## Task 4: Client structured import and feedback

Files: new `miniprogram/utils/option-linkage-domain.js` synchronized copy, `conditional-form.js`, new `option-linkage-import.js`, admin template/node editors and feedback JS/WXML/WXSS, focused tests.

- [ ] RED: imported comma-containing options round-trip; existing unrelated fields preserved; SKU exact removal validates inbound references; hidden/invalid descendants clear, valid descendants survive; matrix absent from setData payloads.
- [ ] Structured JSON import previews counts and replaces only configured draft fields, retaining category/brand/model IDs. Generated member edit/remove/reorder individually blocked. Ordinary save commits; no background template mutations.
- [ ] Store complete definitions privately; derive only effective fields for rendering. Include rules in schema fingerprint and preserve them in parent draft transfers/save payload.
- [ ] GREEN: template and node feedback tests; `node tools/test-wxml-structure.mjs`.

## Task 5: Consumers and bundle parity

Files: operations-field-domain, text-recognition-service, tools/sync-operations-field-domain.mjs, new tools/sync-option-linkage-domain.mjs; corresponding tests.

- [ ] RED whole-group semantic compatibility changes for every member; final stats use effective options; parser gets only currently selectable definitions.
- [ ] Include group semantic projection in compatibility and parser fingerprints. Sync independent worker/client pure module copies; verify exact parity. Verify chosen values reach search/cards/share/CSV without matrix leakage.
- [ ] GREEN: businessApi, operationsAnalytics, client tests plus sync --check and WXML.

## Task 6: Review, configuration and handoff

- [ ] Review task diffs against pre-existing dirty baseline, including independent review; fix findings with focused tests.
- [ ] Verify source import safe counts and full paths. Preserve UI draft before hot reload. Deploy only affected runtime functions/client through authorized workflow; confirm permissions and Timer unchanged.
- [ ] Open exact 45minup template/node, inspect SKU inbound references, import reviewed artifact through normal draft/save. Verify real persisted definition/digest and UI linkage; no test business data created.
- [ ] Update project memory and run validator. Distinguish local completion, deployment and production configuration evidence.
