---
id: task.consistent-workspace-state
title: Preserve Consistent Workspace State After Failure
status: completed
owners:
  - core
created: 2026-09-02
updated: 2026-09-03
upstream:
  - spec.invocation-admission-and-workspace-coordination
supersedes: []
---

# Preserve Consistent Workspace State After Failure

> Migrated from implementation story `TS-020-52`.

## User outcome

As a workflow author, later tasks observe one completed workspace state after a
failed exclusive invocation.

## Scope

- Release workspace access only after failed activity terminates.
- Document that Seqlane does not roll back filesystem mutations.

## Out of scope

- Transactional filesystem rollback.

## Implementation notes

The later task sees the resulting files after exclusive work stops. It must not
start between an error and activity cleanup.

## Acceptance criteria

**Scenario:** *A failed exclusive invocation leaves a file change*

- **Given:** An exclusive invocation that changes a file and then fails
- **When:** A later reader starts after lock release
- **Then:** The reader observes the final resulting workspace state

## Source

- [adr.invocation-admission-and-workspace-coordination](../adrs/2026-09-02-invocation-admission-and-workspace-coordination.md)
- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)

## Traceability

- [spec.invocation-admission-and-workspace-coordination](../specs/2026-09-02-invocation-admission-and-workspace-coordination.md)
