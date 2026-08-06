# ADR-0002: Account transaction invariants

## Status

Accepted on 2026-08-06.

## Context

CloudBase transactions use snapshot isolation and support fixed-document operations inside a transaction. Predicate counts do not provide a safe last-administrator invariant, CloudBase unique indexes do not provide sparse semantics for missing OpenID fields, and password reset can race with an already-started login.

## Decision

- Store active-super-administrator count and revision in the singleton `system_settings/account_admin_state` document. Every create, promotion, enable, demotion, disable, initialization, and recovery transition reads and writes that document in the same transaction as user and audit changes.
- Reserve WeChat identities in `wechat_bindings/<sha256(openid)>`. Binding, unbinding, recovery cleanup, and initial-administrator binding update the reservation and denormalized `users.openid` atomically.
- Increment a nonnegative safe-integer `credentialVersion` on every credential mutation. Password verification occurs inside the credential transaction; later challenge creation and binding require the exact verified version.
- Invalidate all outstanding challenges in O(1) by incrementing a nonnegative safe-integer `challengeEpoch` on the credential. Challenges capture and must match both epoch and credential version.
- Missing legacy counter fields are interpreted as zero; malformed, negative, fractional, or overflowing values fail closed with `ACCOUNT_STATE_INVALID`.

## Consequences

- Deployment must create/backfill the singleton guard and deterministic binding records, then remove the legacy unique `users.openid` index.
- All repository implementations and migrations must preserve these invariants; bypassing the repository can corrupt authentication or remove the final administrator.
- Old challenges remain stored but become logically invalid, avoiding the transaction operation limit.
- The denormalized OpenID remains available for legacy business records, while the binding collection is the uniqueness authority.
