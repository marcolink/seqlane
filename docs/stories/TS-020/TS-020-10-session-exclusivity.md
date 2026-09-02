# TS-020-10 — Exclusively Admit a Session

**Status:** completed

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

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
