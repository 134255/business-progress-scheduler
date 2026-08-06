# ADR-0001: Evidence-backed project memory system

## Status

Accepted on 2026-08-06.

## Context

This project spans many development tasks and includes durable product rules, CloudBase configuration, deployment steps, and partially implemented work. Chat history alone is not a reliable or reviewable long-term source of truth. The repository also commonly has user-owned uncommitted changes, so automatic broad staging would be unsafe.

## Decision

Use a hybrid project-memory system:

- Install the personal Codex skill `maintaining-project-memory` on the development host.
- Keep portable memory in Git through root `AGENTS.md`, stable facts in `docs/memory/PROJECT.md`, current evidence and next work in `docs/memory/STATUS.md`, and durable decisions in numbered ADRs.
- Read the bounded memory set before project actions, including urgent fixes.
- Resolve conflicts by reproducible evidence first, followed by current code/configuration, Git state, memory files, then conversation or inference.
- Update memory only when durable facts, verified status, blockers, or decisions change.
- Validate structure, unfinished markers, conflict markers, and common sensitive-value patterns before claiming completion.
- Never store secrets, identity values, personal data, unredacted business records, or raw chat/log dumps.
- Preserve dirty working trees and stage explicit paths only.

## Consequences

- A new task can recover project intent and current status from versioned files without relying on the previous chat.
- Completion claims must be tied to current reproducible verification; skipped or blocked checks stay `unverified`.
- Memory maintenance adds a small mandatory preflight and closeout cost.
- The global skill is host-local because the user Codex directory is not a Git repository. Other hosts must install the skill separately, while `AGENTS.md` still provides a manual fallback.
- Stale memory is corrected rather than trusted when stronger repository evidence disagrees.
