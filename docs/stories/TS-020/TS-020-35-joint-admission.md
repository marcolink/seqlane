# TS-020-35 — Require Joint Session and Workspace Admission

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
