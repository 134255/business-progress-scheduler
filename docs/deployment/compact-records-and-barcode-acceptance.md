# Compact records and optional barcode entry — acceptance boundary

## Scope and delivery status

On 2026-10-08 the user authorized cloud deployment, Mini Program upload as **1.2.10**, and commit/push to GitHub. This does not authorize switching the experience version, submitting WeChat review, publishing the formal version, or editing live templates/business data. Delivery evidence is tracked in STATUS.md; authorization is not proof of completion. Keep the pre-existing report-range/export changes separate.

Exact runtime scope: `businessApi/lib/{cloud-business-repository,field-domain,template-service}.js`; `operationsAnalytics/lib/field-domain.js`; and the 11 Mini Program files listed in the local release receipt. A fresh production comparison found that `operationsAnalytics/lib/operations-field-domain.js` lacks the already-committed, request-local `describeFieldAnalysisSource` helper. The user explicitly approved synchronizing this additional file after full verification; its existing source/header/projection implementation is unchanged. Preserve all cloud dependencies/configuration and use code-only deployment; never replace the worker wholesale from the dirty workspace.

Design: `docs/memory/decisions/ADR-0023-optional-barcode-entry-and-compact-records.md`.

## 2026-10-08 delivery verification

- The official CLI returned successful code-only deployment for `operationsAnalytics` (5833 files, 6.7 MB) and `businessApi` (6498 files, 9.0 MB). Both fresh pre-release downloads matched their second downloads before deployment. Post-release readback and GitHub delivery are recorded in STATUS.md.
- Mini Program **1.2.10** upload returned explicit success and exit 0, package size **1416033 bytes**. The independent upload tree contains 180 files. Its SHA256 manifest digest is `9043a1095599e24b05c37499a9a77b51b914bfd8c4541120d5ae20cdcc67226b`. No experience-version switch, WeChat review submission or formal publication was performed.
- Exact-payload QA: businessApi1451, client698, businessSearch119, nodeTextParser38, calendarSync61, workflowReminder39, evidenceRetention43, operationsAnalytics66, baseline capacity136, WXML structure4 and official WXML rendering46: **2701 passed, zero failures/cancellations/skips**. Three changed-page WXSS compiles and shared-domain checks passed. Six additional synthetic reviewed/reviewerless and absent/false/true scan-setting cases produced identical API/worker source headers and projections without cloud calls.
- Initial isolated client testing failed a byte-equality assertion because Git-exported LF differed from cloud CRLF. Normalized source text was verified identical before changing only the QA/upload copy's line endings for the existing `miniprogram/utils/option-linkage-domain.js`. No product logic or assertions were changed. QA worker entry tests were restored from current committed HEAD after cloud test support had replaced them; the deployment package's old test files remain unchanged.
- Independent scope/package review returned READY. Runtime/index comparison uses normalized line endings for Git, and exact bytes for deployed/uploaded runtime versus QA. Existing report-range/export changes, attachments, credentials, outputs, dependencies and local settings are excluded from Git changes. Native device and actual barcode acceptance remain unverified.

## Behavior to accept

1. Read-only/pending/completed node: compact saved label/value rows, selected options only, correct zero/false, long and multiline text fully visible, no disabled editing controls. The saved record is not labelled final approved.
2. Feedback history starts folded; open the section and each revision to access every original field/comment/file. Refolding does not change records, fields, paging or unsaved current drafts.
3. Audit history/detail: all reviewers, votes, times and comments are accessible after expansion. Errors/retry remain visible; approval/rejection eligibility and pending-review buttons remain unchanged.
4. Images/video/PDF and HEIC/HEIF fallback still go through existing access grants. Full file names remain visible and expired/purged data is not presented as downloadable. Current-node and previous-node attachments retain their own handlers.
5. Unconfigured short text and all other field types have no scan button. Existing templates/snapshots stay unchanged. Using a separate approved test template, enable “允许扫描条码填写” on a short-text field, save/reopen/copy and create a **nonproduction** instance to verify preservation.
6. Scan a synthetic code with leading zeros and mixed case. Check decoded content in the confirmation, then fill; never auto-save/submit. Existing content requires explicit replacement confirmation. Cancel scanner/confirmation and verify unchanged content. Test invalid/overlength/constraint mismatch and manual fallback.
7. Conditional field hidden mid-scan, account switch, node/version refresh, form edit, submission lock and unload must discard stale results. Returning from native scanner/album must not reload an unsaved form. A conditional dependent-field clearing confirmation retains the same freshness protection.
8. Disable flag explicitly; change type from short text in a new editor; remove field intentionally. Old editor omission must preserve enabled metadata, without resurrecting a removed field.

## Native acceptance (not yet performed)

- Android, HarmonyOS and iOS: camera/album decoding, cancel/permissions, long text and fold tap areas, attachment previews and pending-review actions.
- macOS and Windows: manual entry/paste always works; if native scan is unavailable, safe explanatory feedback with unchanged field. Do not advertise desktop camera scanning before device verification.
- Actual intended product barcode: confirm whether it encodes a unit serial rather than a shared SKU/EAN. The application does not infer uniqueness or parse embedded GS1/URL payloads.

## Automated commands

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node --test miniprogram/test/*.test.js
node tools/test-wxml-structure.mjs
node tools/sync-operations-field-domain.mjs --check
# Set WECHAT_WCC_PATH to the installed, trusted WeChat wcc.exe
node tools/test-compact-node-rendering.mjs
node tools/test-template-node-rendering.mjs
node tools/test-previous-node-records-rendering.mjs
git diff --check
python "C:/Users/87579/.codex/skills/maintaining-project-memory/scripts/validate_memory.py" .
```

Final verified counts and review findings are recorded in STATUS.md. Native layout and scanning are unverified until the above device checks are performed; do not use production customer records as fixtures.
