# TS-020-52 — Preserve Consistent Workspace State After Failure

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
