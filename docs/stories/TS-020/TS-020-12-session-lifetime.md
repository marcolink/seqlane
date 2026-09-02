# TS-020-12 — Hold Session Admission for Full Activity

**Status:** completed

## User outcome

As a workflow author, session admission covers all activity from an invocation.

## Scope

- Track requests, tools, retries, child work, cancellation, and stream end.
- Release the session only when all tracked activity terminates.

## Out of scope

- Workspace lock implementation.

## Implementation notes

Use one invocation activity counter or equivalent state. Do not release a
session when only the initial response has completed.

## Acceptance criteria

**Scenario:** *A task starts a tracked child action*

- **Given:** A response is complete while child activity continues
- **When:** Another invocation requests the session
- **Then:** The second invocation remains waiting

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
