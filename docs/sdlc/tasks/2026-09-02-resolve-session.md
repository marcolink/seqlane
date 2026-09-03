---
id: task.resolve-session
title: Resolve One Session per Invocation
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Resolve One Session per Invocation

> Migrated from implementation story `TS-020-08`.

## User outcome

As a runtime maintainer, every invocation resolves one executor session before
execution.

## Scope

- Add private per-invocation session resolution.
- Attach the resolved session to admission state.

## Out of scope

- Session sharing policy and lock behavior.

## Implementation notes

Keep session contracts private and executor-neutral. A profile can resolve a
shared, isolated, or forked session in later stories.

## Acceptance criteria

**Scenario:** *A task becomes runnable*

- **Given:** A valid invocation
- **When:** Runtime setup completes
- **Then:** The invocation has exactly one resolved session before execution

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
