# Persistent logout design

Date: 2026-08-07
Status: Approved

## Problem

The account profile page currently clears only the Mini Program's in-memory authentication state. The login page then calls `getSession`, which resolves the permanent one-to-one WeChat binding and immediately restores the same account. As a result, an explicit logout appears to do nothing.

The approved account model keeps one WeChat identity bound to at most one account. Logging out must not remove that binding, and switching to another account still requires an administrator to unbind the current account first.

## Decision

Persist a single non-sensitive client preference indicating that password login is required after an explicit logout. The preference contains only a boolean value. It must never contain a username, password, OpenID, challenge token, recovery material, user record, or other identity data.

This client preference is intentionally separate from server authentication state:

- the binding remains authoritative for identity uniqueness;
- `getSession` remains available for initialization checks and ordinary automatic session restoration;
- the preference suppresses automatic restoration only after the user explicitly logs out;
- successful password authentication clears the preference.

No backend route, database collection, or CloudBase configuration changes are required.

## Components

### Logout-preference helper

A focused Mini Program helper owns the storage key and exposes operations to:

- require manual login;
- test whether manual login is required;
- clear the requirement.

Storage failures must fail safely. If the client cannot persist the logout preference, the current process must still remain logged out instead of immediately restoring the account. The in-memory application state therefore mirrors the requirement for the current process, while successful persistent storage extends it across restarts.

### Application authentication state

The application continues to own `currentUser` and `loginChallenge` in memory. Explicit logout clears both and enables the manual-login requirement before relaunching the login page.

The helper stores no credential or identity material. Existing guarantees that passwords and first-login challenges remain memory-only are unchanged.

### Login page

On load, the login page still calls `getSession` so it can detect whether first-super-administrator initialization is required.

The page applies these outcomes in order:

1. If initialization is required, show the guarded initialization entry regardless of the logout preference.
2. If the server reports an authenticated bound account and manual login is not required, restore the account and open the dashboard.
3. If manual login is required, ignore the authenticated account payload for navigation and global state, and show the username/password form.
4. If the server reports no authenticated account, show the normal login form.

Successful username/password authentication clears the manual-login requirement before opening the dashboard. Successful first-login password completion also clears it before entering the dashboard.

### Account switching and messaging

Logout does not unbind WeChat. The confirmation copy must state that the user will need to enter account credentials again and that switching accounts requires an administrator to unbind the current WeChat identity first.

An attempt to authenticate another account while the current WeChat identity remains bound continues to be rejected by the existing backend binding invariant.

## Error handling

- A storage read failure is treated as manual login required for the current process when logout has just occurred; it must not cause an immediate automatic-login loop.
- A storage write failure does not restore cleared in-memory authentication state. The user remains on the login page for the current process, while persistence across a later process restart is unverified.
- A storage-clear failure after successful password authentication must not discard the authenticated backend result. The in-memory requirement is cleared and navigation may proceed; a later restart may conservatively request credentials again.
- Existing backend errors, account lockout, disabled-account handling, initialization errors, and binding-conflict errors remain unchanged.

## Verification

Automated client tests must prove:

- confirmed logout sets the manual-login requirement, clears in-memory authentication state, and relaunches the login page;
- cancelled logout changes nothing;
- an authenticated `getSession` result does not restore global state or navigate when the requirement is active;
- the requirement survives a simulated application restart through the non-sensitive boolean preference;
- a successful password login clears the requirement and opens the dashboard;
- successful first-login password completion clears the requirement;
- initialization-required state still exposes the guarded initialization entry;
- storage never receives credentials, OpenID values, challenge tokens, user objects, or recovery material;
- existing account, WXML, backend, syntax, diff, and project-memory checks remain green.

Manual WeChat DevTools acceptance must confirm:

1. Log out from the profile page.
2. Confirm the normal login form remains visible without automatic dashboard navigation.
3. Close and reopen the Mini Program and confirm it still remains logged out.
4. Log in with the bound account's password and confirm the dashboard opens.
5. Close and reopen again and confirm ordinary automatic restoration resumes after successful password authentication.

## Out of scope

- Server-issued session tokens or a backend logout endpoint.
- Automatic unbinding during logout.
- Allowing one WeChat identity to switch between multiple accounts without administrator unbinding.
- Storing any credential or identity value on the client.
