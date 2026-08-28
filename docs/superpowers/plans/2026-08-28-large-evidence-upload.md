# Large Evidence Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-shot CloudBase evidence uploads with path-scoped, resumable COS uploads while enforcing a server-authoritative 120 MiB processing-round total and expanded safe media compatibility.

**Architecture:** `businessApi` creates an invisible `evidences` upload reservation and issues short-lived STS credentials scoped to one generated COS object key. The mini program uploads with Tencent COS's advanced uploader, then `businessApi` verifies server object metadata and bounded header bytes before publishing the evidence as `available`; `evidenceRetention` removes abandoned `uploading` reservations. Existing feedback evidence claims, history, sharing, and retention continue to consume only `available` evidence IDs.

**Tech Stack:** Node.js 16.13, `wx-server-sdk@4.0.2`, `cos-nodejs-sdk-v5@3.0.0`, `cos-wx-sdk-v5@1.8.0`, `qcloud-cos-sts@3.1.3`, WeChat Mini Program JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-28-large-evidence-upload-and-response-performance-design.md`

## Global Constraints

- One processing round's server-authoritative available evidence total is at most `120 * 1024 * 1024` bytes.
- There is no independent product-level single-file limit and no product-level file-count limit.
- Supported extensions are JPG/JPEG/PNG/WebP/HEIC/HEIF, MP4/MOV/M4V, and PDF; non-empty template allowlists remain strict.
- Permanent COS credentials never enter the mini program; temporary credentials authorize exactly one generated object key and expire after 15 minutes.
- User content, file names, object keys, account identifiers, and credentials never enter logs or project memory.
- Existing `project.config.json` and `outputs/deploy/` remain untouched and uncommitted.

---

### Task 1: Expand and harden the evidence policy

**Files:**
- Modify: `cloudfunctions/businessApi/lib/evidence-policy.js`
- Modify: `cloudfunctions/businessApi/test/evidence-policy.test.js`
- Modify: `cloudfunctions/businessApi/lib/template-domain.js`
- Modify: `cloudfunctions/businessApi/test/template-domain.test.js`

**Interfaces:**
- Produces: `FEEDBACK_TOTAL_LIMIT = 120 * 1024 * 1024`, `SUPPORTED_EVIDENCE_EXTENSIONS`, `classifyHeader({ fileName, declaredSize, bytes, allowedTypes })`, and `validateFeedbackTotalSize(sizes)`.
- Consumes: existing template `requiresEvidence` and `allowedEvidenceTypes` semantics.

- [ ] **Step 1: Write failing boundary and signature tests**

Add tests proving 120 MiB passes, 120 MiB + 1 byte fails, WebP uses `RIFF....WEBP`, HEIC/HEIF uses approved `ftyp` brands, ISO-BMFF video brands remain video, PDF/JPEG/PNG still pass, and mismatched or unknown brands fail with `UNSUPPORTED_FILE_TYPE`.

- [ ] **Step 2: Run RED**

Run: `node --test cloudfunctions/businessApi/test/evidence-policy.test.js cloudfunctions/businessApi/test/template-domain.test.js`
Expected: failures showing the old 20 MiB constants and missing extensions/header classifier.

- [ ] **Step 3: Implement the minimal policy**

Replace full-buffer hashing classification with bounded-header classification, export the supported extension set, update template validation to accept the new extensions, and retain strict own-data-property/duplicate validation.

- [ ] **Step 4: Run GREEN**

Run the Task 1 command and expect 0 failures.

- [ ] **Step 5: Commit**

Stage only the four Task 1 files and commit `feat: expand evidence compatibility and total limit`.

### Task 2: Create server-side upload reservations and scoped STS

**Files:**
- Create: `cloudfunctions/businessApi/lib/evidence-upload-service.js`
- Create: `cloudfunctions/businessApi/lib/cloud-evidence-upload-repository.js`
- Create: `cloudfunctions/businessApi/test/evidence-upload-service.test.js`
- Create: `cloudfunctions/businessApi/test/cloud-evidence-upload-repository.test.js`
- Modify: `cloudfunctions/businessApi/index.js`
- Modify: `cloudfunctions/businessApi/test/account-routes.test.js`
- Modify: `cloudfunctions/businessApi/package.json`
- Modify: `cloudfunctions/businessApi/package-lock.json`

**Interfaces:**
- Produces: `beginEvidenceUpload({ actor, input }) -> { evidenceId, uploadSessionToken, bucket, region, objectKey, credentials, expiresAt }`.
- Produces: `finalizeEvidenceUpload({ actor, input }) -> { evidenceId, fileName, category, size, storageStatus: 'available' }`.
- Repository methods: `reserveUpload`, `getUploadReservation`, `headObject`, `readObjectHeader`, `publishUpload`, `abortExpiredUpload`.

- [ ] **Step 1: Write failing service tests**

Cover active processor authorization, current node/version validation, exact path policy, 15-minute expiry, token hashing, no permanent secret in output, account/node/version replay rejection, authoritative object size, header classification, and idempotent finalization.

- [ ] **Step 2: Run RED**

Run: `node --test cloudfunctions/businessApi/test/evidence-upload-service.test.js cloudfunctions/businessApi/test/cloud-evidence-upload-repository.test.js`
Expected: module-not-found or missing-interface failures only.

- [ ] **Step 3: Install pinned runtime dependencies**

Run `npm.cmd install --save-exact cos-nodejs-sdk-v5@3.0.0 qcloud-cos-sts@3.1.3 --prefix cloudfunctions/businessApi`, inspect the resolved production dependency tree, and reject any critical audit finding before continuing.

- [ ] **Step 4: Implement reservation and finalize flows**

Use `evidences` documents with `storageStatus: 'uploading'`, a random evidence ID, exact generated object key, token hash, declaration metadata, `uploadSessionExpiresAt`, and `orphanExpiresAt`. Use `qcloud-cos-sts` with a single-object resource policy. Finalization uses COS `headObject` and ranged `getObject`, stores integrity algorithm/value from server metadata, clears session secrets, and CAS-publishes `available`.

- [ ] **Step 5: Add protected routes**

Register `beginEvidenceUpload` and `finalizeEvidenceUpload` in `createBusinessApi`; route payloads through the account boundary and return only the service safe projection.

- [ ] **Step 6: Run GREEN**

Run Task 2 tests plus `npm.cmd test --prefix cloudfunctions/businessApi`; expect 0 failures.

- [ ] **Step 7: Commit**

Stage only Task 2 files and commit `feat: add scoped evidence upload sessions`.

### Task 3: Add the mini-program COS upload adapter

**Files:**
- Create: `miniprogram/utils/evidence-upload.js`
- Create: `miniprogram/test/evidence-upload.test.js`
- Add: `miniprogram/vendor/cos-wx-sdk-v5.js`
- Modify: `miniprogram/app.json`
- Modify: `miniprogram/services/business.js`

**Interfaces:**
- Produces: `createEvidenceUploader({ cosFactory, beginUpload, finalizeUpload, clock, delay })`.
- Produces: `upload({ businessLineId, nodeId, expectedNodeVersion, file, onProgress, signal })` returning the safe available evidence projection.

- [ ] **Step 1: Write failing adapter tests**

Test authorization-before-upload, exact returned key use, SDK progress forwarding, bounded exponential retry for retryable network failures, cancellation, expired-session reauthorization, finalize idempotency, and absence of permanent credentials in client state.

- [ ] **Step 2: Run RED**

Run: `node --test miniprogram/test/evidence-upload.test.js`
Expected: missing module/interface failure.

- [ ] **Step 3: Add the pinned official SDK build**

Run `npm.cmd pack cos-wx-sdk-v5@1.8.0` in a temporary directory, extract the published mini-program distribution to `miniprogram/vendor/cos-wx-sdk-v5.js`, retain its license header, record the package tarball integrity in the dependency review, and expose it only through the new adapter.

- [ ] **Step 4: Implement the adapter and service methods**

Wire `beginEvidenceUpload` and `finalizeEvidenceUpload`; cap file-level concurrency at 3 in the caller, use the advanced `uploadFile`, and preserve retry state without storing credentials persistently.

- [ ] **Step 5: Declare private API use**

Add `"requiredPrivateInfos": ["chooseMedia"]` to `miniprogram/app.json` without changing unrelated project configuration.

- [ ] **Step 6: Run GREEN**

Run the Task 3 test and `node tools/test-wxml-structure.mjs`; expect 0 failures.

- [ ] **Step 7: Commit**

Stage only Task 3 files and commit `feat: add resumable cos evidence uploader`.

### Task 4: Replace node-page selection and upload behavior

**Files:**
- Modify: `miniprogram/pages/node-feedback/index.js`
- Modify: `miniprogram/pages/node-feedback/index.wxml`
- Modify: `miniprogram/pages/node-feedback/index.wxss`
- Modify: `miniprogram/test/node-feedback-v2.test.js`
- Modify: `miniprogram/test/global-form-style.test.js`

**Interfaces:**
- Consumes: `createEvidenceUploader` and expanded policy constants mirrored in the client.
- Produces: per-file `status`, `progressPercent`, `errorCode`, `canRetry`, and stable `evidenceId` after finalization.

- [ ] **Step 1: Write failing UI tests**

Prove desktop media selection uses `type: 'all'` without an extension filter, mobile uses `chooseMedia`, supported formats normalize correctly, selection total is 120 MiB, repeated selections are unlimited by app count, upload concurrency never exceeds 3, retry preserves fields, and exact safe errors are rendered.

- [ ] **Step 2: Run RED**

Run: `node --test miniprogram/test/node-feedback-v2.test.js miniprogram/test/global-form-style.test.js`
Expected: old `type: 'file'`, 20 MiB labels, and one-shot upload assertions fail.

- [ ] **Step 3: Implement selection and progress UI**

Replace direct `wx.cloud.uploadFile` and `registerEvidenceUpload` with the adapter, display per-file and aggregate progress, retain completed files across retry, and keep field/draft updates atomic.

- [ ] **Step 4: Implement safe preview fallback**

Use existing protected access for supported previews; HEIC/HEIF or unsupported codecs show a download card when no compatible preview URL is returned.

- [ ] **Step 5: Run GREEN**

Run Task 4 tests and the full mini-program suite `node --test miniprogram/test/*.test.js`; expect 0 failures.

- [ ] **Step 6: Commit**

Stage only Task 4 files and commit `feat: support large cross-device evidence uploads`.

### Task 5: Recover abandoned upload reservations

**Files:**
- Modify: `cloudfunctions/evidenceRetention/lib/retention-service.js`
- Modify: `cloudfunctions/evidenceRetention/lib/cloud-retention-repository.js`
- Modify: `cloudfunctions/evidenceRetention/test/retention-service.test.js`
- Modify: `cloudfunctions/evidenceRetention/test/cloud-retention-repository.test.js`
- Modify: `cloudfunctions/evidenceRetention/index.js`

**Interfaces:**
- Produces: one bounded cleanup phase for expired `storageStatus: 'uploading'` evidence ordered by expiry and `_id`.
- Preserves: existing total raw scan budget and lease/idempotency rules.

- [ ] **Step 1: Write failing cleanup tests**

Cover expired upload deletion, live session protection, already-missing object success, failure retry metadata, cursor progress on invalid candidates, and non-interference with `available` evidence.

- [ ] **Step 2: Run RED**

Run the two focused evidenceRetention test files and expect failures because `uploading` reservations are not scanned.

- [ ] **Step 3: Implement bounded cleanup**

Add the new phase without increasing the global 40-record raw scan budget, reuse the existing storage deletion adapter, and clear session credential fields when terminal.

- [ ] **Step 4: Run GREEN**

Run `npm.cmd test --prefix cloudfunctions/evidenceRetention`; expect 0 failures.

- [ ] **Step 5: Commit**

Stage only Task 5 files and commit `feat: clean abandoned evidence uploads`.

### Task 6: Deployment documentation and full verification

**Files:**
- Modify: `docs/deployment/template-node-fields-setup.md`
- Modify: `docs/memory/PROJECT.md`
- Modify: `docs/memory/STATUS.md`
- Create: `docs/memory/decisions/ADR-0014-large-evidence-upload-and-workspace-performance.md`

**Interfaces:**
- Documents COS/STS environment names, exact permissions, domain allowlist, memory A/B procedure, rollout, rollback, and cross-device acceptance.

- [ ] **Step 1: Document deployment and ADR**

Record the accepted architecture, required secrets without values, CloudBase/COS permissions, evidence schema compatibility, upload cleanup index, privacy declaration, and manual acceptance matrix.

- [ ] **Step 2: Run full gates**

Run all cloud-function suites, `node --test miniprogram/test/*.test.js`, `node tools/test-wxml-structure.mjs`, production JavaScript syntax checks, `git diff --check`, and the project-memory validator.

- [ ] **Step 3: Inspect dependency risk and diff**

Run production `npm audit` for changed cloud functions, record unresolved noncritical upstream findings as unverified, and verify `project.config.json`/`outputs/deploy/` are absent from the staged diff.

- [ ] **Step 4: Commit**

Stage only Task 6 documentation and commit `docs: record large evidence deployment contract`.
