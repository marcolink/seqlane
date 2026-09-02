# TS-020-50 — Hide Partial Workspace Mutations

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
