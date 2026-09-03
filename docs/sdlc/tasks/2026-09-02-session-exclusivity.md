---
id: task.session-exclusivity
title: Exclusively Admit a Session
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Exclusively Admit a Session

> Migrated from implementation story `TS-020-10`.

## User outcome

As a workflow author, two active invocations never share one executor session.

## Scope

- Add a private exclusive session lock.
- Mark an invocation active only after that lock is acquired.

## Out of scope

- Workspace locks and retry policy.

## Implementation notes

The session lock has invocation lifetime, not request lifetime. The adapter
queue remains a defensive boundary, not the admission policy.

## Acceptance criteria

**Scenario:** *Two ready tasks use one session*

- **Given:** Two admitted invocations with the same session
- **When:** The first task starts
- **Then:** The second task waits until the first invocation terminates

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
