# TS-020-39 — Permit Ordered Exclusive Work in One Session

**Status:** completed

## User outcome

As a workflow author, explicitly ordered exclusive tasks can share one session.

## Scope

- Accept a shared session when each exclusive task pair has DAG order.
- Retain exclusive session and workspace admission.

## Out of scope

- Runtime permission diagnostics.

## Implementation notes

The DAG path defines the context order. Do not use prompt queue order as the
reason that preflight accepts the workflow.

## Acceptance criteria

**Scenario:** *Ordered exclusive tasks share a session*

- **Given:** Two exclusive tasks with an explicit dependency and one session
- **When:** Preflight validates the workflow
- **Then:** Preflight accepts the session assignment

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
