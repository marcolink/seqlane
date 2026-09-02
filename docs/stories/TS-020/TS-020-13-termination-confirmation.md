# TS-020-13 — Confirm Termination Before Session Release

**Status:** completed

## User outcome

As a workflow author, cancellation does not make a session reusable too early.

## Scope

- Add executor termination confirmation.
- Retain session admission after cancel, timeout, or disconnect.

## Out of scope

- Session quarantine when confirmation fails.

## Implementation notes

Model a pending termination state. Do not use the completion of an abort request
as proof that executor work stopped.

## Acceptance criteria

**Scenario:** *Cancellation requests executor stop*

- **Given:** A session with active work
- **When:** The invocation is cancelled
- **Then:** The session remains unavailable until termination is confirmed

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
