# Super-administrator recovery page design

Date: 2026-08-07
Status: Approved

## Problem

The backend already provides the public, recovery-code-protected `recoverSuperAdmin` route, but the Mini Program has no safe client entry for it. Entering real recovery material in a CloudBase test event would risk retaining secrets in invocation history, while directly editing credentials would bypass audit, credential-version, challenge-invalidation, binding, and administrator-guard invariants.

Manual acceptance of persistent logout also revealed that the only super administrator's structurally valid scrypt credential does not match the operator-held permanent password. The credential cannot be reversed. A controlled recovery path is required before password-login acceptance can continue.

## Decision

Add an explicit secondary action, `超级管理员紧急恢复`, to the normal login page. It opens a dedicated Mini Program recovery page that invokes the existing `recoverSuperAdmin` route and then hands the recovered account to the existing temporary-password and forced-password-change flow.

The entry is visible rather than hidden behind an undocumented gesture. Possession of the single-use, high-entropy recovery code is the authorization factor; obscuring navigation is not a security boundary.

No backend route, database collection, index, dependency, or CloudBase environment identifier changes are required.

## Recovery-code rotation prerequisite

Initialization consumed the previous recovery state. Before the recovery form is submitted, an authorized operator must use the existing local, offline recovery helper to generate a new plaintext recovery code and its lowercase hexadecimal SHA-256 digest. The plaintext code must be stored only in the approved offline password manager.

During a maintenance window, update the two digest locations in this order:

1. Set the `businessApi` environment variable `ADMIN_RECOVERY_CODE_SHA256` to the new digest.
2. Set `system_settings/account_admin_state.recoveryCodeHash` to the same digest.
3. Set `system_settings/account_admin_state.recoveryConsumedAt` to `null`.

Do not change `activeSuperAdminCount`, `revision`, account identifiers, credential fields, binding records, or audit records during rotation. Never paste the plaintext recovery code or its digest into Git, terminal history, logs, chat, screenshots, or test fixtures.

If the two digest locations are not known to match, the operator must stop before submitting recovery. Mismatched or consumed state must fail closed with `INVALID_RECOVERY_CODE`.

## Components

### Account service

Add `recoverSuperAdmin(username, temporaryPassword, recoveryCode)` to the Mini Program account service. It calls `businessApi` with action `recoverSuperAdmin`, the three exact payload fields, and silent client error handling. It does not send OpenID; the cloud-function route intentionally ignores payload identity for recovery.

### Login page

Add a secondary `超级管理员紧急恢复` action below the ordinary account/password form. It navigates to the recovery page only when initialization is not required. Ordinary session restoration, explicit-logout behavior, credential login, and the initialization entry remain unchanged.

### Recovery page

Register a dedicated page that owns these fields only:

- administrator username;
- temporary password;
- temporary-password confirmation;
- one-time recovery code;
- submitting and error UI state.

The page validates that all fields are present, that both temporary-password values match, and that the temporary password is 8–64 characters with at least one ASCII letter and one digit. Password and recovery-code inputs are masked.

The page never calls `getSession` and does not require an authenticated account. It is intentionally a public recovery-code-gated operation.

### Successful recovery handoff

On submit:

1. Normalize the username by trimming it for the client request; the backend remains authoritative and normalizes case.
2. Copy the normalized username and temporary password only into function-scoped local variables, then call `recoverSuperAdmin` once.
3. Mark the one-time recovery operation as completed in page memory and immediately clear all page-bound password and recovery-code fields.
4. Without persisting secrets, use the function-scoped username and temporary password for one immediate call to the existing `login` action.
5. Require `passwordChangeRequired` and a nonempty challenge token.
6. Put only the challenge token in the existing in-memory `loginChallenge` slot.
7. Clear the temporary password, confirmation, and recovery code before navigating to `pages/change-password/index?mode=first`.

Successful forced password change uses the existing flow to bind the current trusted WeChat identity, clear the explicit-logout preference, and open the dashboard.

### Recovery succeeded but automatic login failed

Once `recoverSuperAdmin` succeeds, the recovery code is consumed and the page must never automatically retry recovery. If the temporary-password login or challenge handoff fails:

- clear the temporary password, confirmation, and recovery code;
- show a non-secret modal stating that recovery completed and the operator must return to login with the newly selected temporary password;
- relaunch the ordinary login page;
- leave the username out of navigation parameters and global state.

The operator may then use the temporary password through ordinary login and complete forced password change. A new recovery rotation is necessary only if the temporary password itself is lost.

## Backend effects retained

The existing backend transaction remains authoritative. A successful recovery:

- promotes and activates the target account as `super_admin`;
- removes its old WeChat binding reservation and denormalized OpenID;
- replaces the credential with the new temporary-password record;
- clears failed attempts and lock time;
- sets `mustChangePassword` to `true`;
- advances credential version and challenge epoch;
- preserves the active-super-administrator guard invariant;
- writes a high-priority `RECOVER_SUPER_ADMIN` audit record;
- consumes the rotated recovery state.

The client must not duplicate or bypass any of these mutations.

## Sensitive-data handling

- Username, temporary passwords, recovery code, digest, OpenID, user identifiers, and user records must not enter local storage, route parameters, datasets, console output, telemetry, or project memory.
- Only the first-login challenge token may enter application memory, following the existing forced-password-change design.
- Page-bound temporary-password, confirmation, and recovery-code fields are cleared immediately after the recovery call settles. After recovery succeeds, the temporary password may remain only in a function-scoped local variable until the single immediate login call settles; it then becomes unreachable. All sensitive fields are cleared before navigation.
- `clearAllFields()` runs on page unload.
- Backend errors are displayed through existing sanitized error handling; payloads and error messages containing secret material are never logged.

## Verification

Automated tests must prove:

- the account service forwards the exact recovery action and payload through a silent call;
- the page is registered and every password/recovery input is masked;
- the login entry navigates only when initialization is not required;
- incomplete, weak, and mismatched inputs are rejected before any cloud call;
- recovery submits exactly once;
- successful recovery automatically obtains a password-change challenge, clears sensitive fields, and opens forced password change;
- recovery success followed by login failure never retries recovery, clears secrets, shows the recovery-completed fallback, and returns to login;
- a recovery failure clears sensitive fields but keeps the page available for an operator-controlled retry;
- unloading clears every field;
- source and WXML contain no secret-bearing storage, logs, datasets, or route parameters;
- existing persistent-logout, account, backend, WXML, syntax, diff, and project-memory checks remain green.

Manual acceptance must confirm, without screenshots or copied secrets:

1. Rotate a new recovery code digest in both approved locations and clear only `recoveryConsumedAt`.
2. Open the recovery page from login and enter the values locally.
3. Confirm automatic handoff to forced password change.
4. Set a new permanent password and confirm dashboard entry.
5. Confirm the guard count remains one, the recovery state is consumed, the credential is unlocked with `mustChangePassword=false`, the current WeChat binding is restored, and both recovery and password-change audit records exist.
6. Resume persistent-logout acceptance by restarting after password login and confirming ordinary automatic restoration.

## Out of scope

- Revealing, testing, or reversing the existing password.
- Direct credential or binding edits.
- CloudBase console invocation with real recovery material.
- Multi-account recovery, recovery-code distribution, or organization-wide secret management.
- Backend session-token redesign.
