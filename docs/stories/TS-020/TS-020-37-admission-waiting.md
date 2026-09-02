# TS-020-37 — Report Admission Waiting Without an Attempt

**Status:** completed

## User outcome

As a Seqlane observer, queued admission is visible without appearing as active
execution or a retry attempt.

## Scope

- Add waiting-for-admission event state.
- Preserve invocation identity and attempt accounting while queued.

## Out of scope

- User-interface presentation changes beyond event consumption.

## Implementation notes

Use a distinct waiting reason from dependency waiting. Emit active state only
after both locks are acquired.

## Acceptance criteria

**Scenario:** *A workspace request waits*

- **Given:** A dependency-ready invocation blocked by a lock
- **When:** The runtime emits progress
- **Then:** The invocation is waiting and its attempt count remains unchanged

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
