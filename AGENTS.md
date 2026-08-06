# Repository Instructions

This repository uses durable, evidence-backed project memory.

## Before every project task

1. Use `$maintaining-project-memory` when it is available.
2. Before changing code, read `docs/memory/PROJECT.md`, `docs/memory/STATUS.md`, and ADRs relevant to the task under `docs/memory/decisions`.
3. Reconcile those files with current tests, code/configuration, and Git state. Stronger evidence overrides stale memory.
4. Inspect the dirty working tree and preserve all pre-existing user changes.

If the global skill is unavailable, follow these instructions manually and report that the host-level skill needs installation; do not skip the memory preflight.

## Evidence order

1. Reproducible test, build, or run results.
2. Current code and configuration.
3. Git history and diff.
4. Project memory files.
5. Conversation or inference.

## Before finishing a change

1. Run verification proportional to the change and inspect the diff.
2. Update `docs/memory/STATUS.md` with exact evidence, failures or blockers, and the next action.
3. Update `docs/memory/PROJECT.md` only when a stable fact changes.
4. Add or supersede an ADR only for a durable decision with meaningful consequences.
5. Run the project-memory validator from the installed skill.
6. Stage explicit paths only; never mix unrelated working-tree changes into a commit.

Skipped or blocked verification is `unverified`, never complete. Never store passwords, tokens, cookies, private keys, recovery codes, OpenID values, personal information, raw customer records, or raw chat/log dumps in project memory or Git.

## Core verification commands

```powershell
npm.cmd test --prefix cloudfunctions/businessApi
node tools/test-wxml-structure.mjs
git diff --check
python "C:\Users\87579\.codex\skills\maintaining-project-memory\scripts\validate_memory.py" .
```
