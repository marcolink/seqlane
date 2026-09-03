---
id: task.no-partial-mutations
title: Hide Partial Workspace Mutations
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Hide Partial Workspace Mutations

> Migrated from implementation story `TS-020-50`.

## User outcome

As a workflow author, no task observes a partial mutation from another
invocation.

## Scope

- Hold incompatible workspace admission until exclusive activity terminates.
- Prove a waiting shared invocation cannot start during controlled exclusive work.

## Out of scope

- Filesystem rollback.

## Implementation notes

This scheduling property follows from exclusive admission lifetime. Tests use observable
task ordering and workspace values, not lock implementation details.

## Acceptance criteria

**Scenario:** *A shared invocation follows exclusive work*

- **Given:** An exclusive invocation that pauses before completing
- **When:** A reader becomes ready
- **Then:** The shared invocation starts after exclusive admission releases

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
