# Project Memory

Last stable-fact review: 2026-08-06 (Asia/Shanghai)

## Product

This is an internal business-progress management WeChat Mini Program. Super administrators control accounts, templates, node ownership, and system rules. Authorized users create business lines from enabled templates, responsible users submit node progress and evidence, and associated users inspect progress and evidence history.

Approved V1 rules include:

- Account/password login with first-login password change, one-to-one WeChat identity binding, lockout, administrator reset, and at least one active super administrator.
- Template snapshots, sequential nodes, multiple responsible accounts with first-completion-wins (`OR` signing), logical deletion, audit history, and optimistic/concurrent flow protection.
- China workday calculations from a locally cached holiday adapter; default working hours are 09:00–20:00 without lunch break. Default node SLA is two workdays (22 work hours), and template nodes may override it.
- In-app notifications as the fallback channel and a future Enterprise WeChat self-built application as the strong-reminder channel. Unfinished nodes are reminded every accumulated work hour during working time.
- Evidence supports JPG/JPEG/PNG up to 5 MB each, PDF up to 20 MB each, and MP4/MOV/M4V up to 20 MB each. A feedback may contain multiple files but no more than 20 MB in total.

The complete approved requirements are in `docs/superpowers/specs/2026-08-05-business-progress-v1-design.md`. Account-administration execution steps are in `docs/superpowers/plans/2026-08-05-account-admin.md`.

## Architecture

- Client: native WeChat Mini Program using JavaScript, WXML, and WXSS under `miniprogram/`.
- Client authentication starts at `pages/login/index`; `miniprogram/app.js` owns the in-memory current-user state and the reset helper. First-login challenges remain memory-only until password change completes.
- Backend: Tencent CloudBase Node.js cloud functions, cloud database, and cloud storage.
- Current entry point: `cloudfunctions/businessApi/index.js`, with pure domain helpers under `cloudfunctions/businessApi/lib/`.
- Target modular shape: retain a unified API entry for ordinary domain calls, extract account/template/business/evidence/notification modules, and use separate scheduled functions for calendar synchronization, hourly reminders, and orphan-file cleanup.
- External holiday source is isolated behind an adapter. The approved endpoint is `https://holiday.ailcc.com/api/holiday/allyear/{year}`; production use requires renewed terms and availability verification.
- Enterprise WeChat sending must remain behind an adapter and disabled until approved secure configuration is supplied.

Primary collections include `users`, `user_credentials`, `auth_challenges`, `wechat_bindings`, `system_settings`, `templates`, `template_nodes`, `business_lines`, `business_nodes`, `node_feedback`, `evidences`, `work_calendar`, `notifications`, notification-delivery records, and `audit_logs`.

Account transaction invariants are recorded in `docs/memory/decisions/ADR-0002-account-transaction-invariants.md`.

Account deployment requires the `system_settings/account_admin_state` guard, deterministic `wechat_bindings/<sha256(openid)>` backfill, and removal of the legacy `users.openid` unique index only after a verified migration. The security-redacted operator procedure is `docs/deployment/account-admin-setup.md`.

## Environment

- WeChat Mini Program AppID identifier: `wx6dcce945f944e52f`.
- CloudBase environment identifier: `cloud1-d5gxt99rh492670d9`.
- Mini Program root: `miniprogram/`.
- Cloud-function root: `cloudfunctions/`.
- Cloud function name: `businessApi`.
- Default Git integration branch: `main`; remote tracking branch: `origin/main`.

These identifiers are not credentials. Secret values, administrator passwords, recovery codes, account identity values, and customer records must be supplied through approved secure channels and never stored here.

## Verification commands

Run from the repository root:

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node tools/test-wxml-structure.mjs
git diff --check
git status --short --branch
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```

Cloud deployment and simulator acceptance are manual WeChat DevTools checks and must be recorded as `unverified` until rerun for the exact current code.
