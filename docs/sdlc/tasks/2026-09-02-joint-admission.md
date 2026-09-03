---
id: task.joint-admission
title: Require Joint Session and Workspace Admission
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Require Joint Session and Workspace Admission

> Migrated from implementation story `TS-020-35`.

## User outcome

As a workflow author, a task starts only after both session and workspace
admission succeed.

## Scope

- Add one joint admission gate before execution.
- Keep dependency readiness separate from resource admission.

## Out of scope

- Fair lock queue ordering.

## Implementation notes

Do not acquire the session before the workspace. Release every acquired lock if
the second acquisition fails.

## Acceptance criteria

**Scenario:** *Session is free but workspace is busy*

- **Given:** A ready invocation with an available session and blocked workspace
- **When:** The scheduler evaluates admission
- **Then:** The executor request does not start

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
