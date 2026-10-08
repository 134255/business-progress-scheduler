# ADR-0023: Optional barcode entry and compact read-only records

## Status

Accepted for local implementation; release and native acceptance tracked in STATUS.md.
- Date: 2026-10-08

## Context

Read-only node pages repeated large disabled controls and historical revisions. Users approved compact saved-content presentation and collapsible history while retaining all original records and operations. They also approved barcode-assisted entry for designated product-code fields, preserving manual input and existing validation.

## Decision

1. Keep native Mini Program WXML/WXSS and the existing green visual style. Figma is not a runtime dependency. Editing, submission, review decisions, storage and authorization contracts are unchanged.
2. Read-only node pages show label/value rows from the existing saved-record projection, explicitly labelled **最近保存内容**, not an inferred final approved result. The separately implemented previous-node result API remains the only preceding-node final-result proof. No new final-result API or history rewriting is introduced.
3. Feedback history defaults closed, with independent per-revision expansion; audit history is collapsible. Full values, comments, vote decisions/times and attachment access remain available. Zero/false are not treated as missing. Folding is presentation state only, independent of unsaved form data and review paging.
4. Add optional `scanEnabled: true` only to `short_text` definitions. Absent/false normalizes to the historical shape so old definition digests stay stable. Invalid types and accessor/inherited configuration are rejected. Field values stay ordinary text; no new field type, product lookup, barcode uniqueness rule or automatic submission.
5. Administrators explicitly enable the flag using the existing template editor. Stable node/field keys preserve an enabled flag when an older editor omits it; explicit false disables it. Intentional field deletion is not undone. New editors clear it on a type change. Old editors must not silently change an enabled field into a non-text type.
6. Use `wx.scanCode` as an optional input source and require preview confirmation, explicitly warning before replacing existing content. Preserve literal text, leading zeros and case; reject empty/non-text/control-containing/over-4096-character results and existing constraint violations without truncation. Do not interpret GS1, URLs or barcode semantics, or claim a scanned code is unit-unique.
7. Cancel, unsupported APIs, permission/device failures and stale responses leave the draft unchanged. Manual entry/paste remain available. Recheck account, node, version, request/form revision, field visibility/configuration and values through all asynchronous confirmations. Native scanner hide/show must not reload the form or erase the pending result.

## Consequences

- Existing business snapshots/templates are not migrated or toggled. Only newly created snapshots using an explicitly enabled definition get a scan button.
- Mobile/desktop clients may differ in camera/album support. Capability checks and safe manual fallback are implemented, but Android/HarmonyOS/iOS/macOS/Windows and actual product labels require native acceptance.
- Rolling back a scan-enabled environment to an old backend that strips unknown metadata is unsafe. Deploy compatible backend/client/shared-domain copies before enabling the flag. No unrelated export changes may be included in the release payload.
- This change does not introduce database collections, indexes, timers, dependencies, network image-recognition services or production writes.

## Evidence

- `miniprogram/utils/barcode-entry.js` and `miniprogram/test/barcode-entry.test.js` / `barcode-page.test.js`.
- `cloudfunctions/businessApi/test/barcode-field-config.test.js` and shared-domain synchronization check.
- `miniprogram/test/compact-node-presentation.test.js`, existing review-history regression tests and `tools/test-compact-node-rendering.mjs` using the official WeChat WXML compiler.
- Exact suite results and remaining acceptance gates are in STATUS.md; automated rendering is not five-platform device acceptance.
