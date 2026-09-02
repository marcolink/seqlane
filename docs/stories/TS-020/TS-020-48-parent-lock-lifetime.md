# TS-020-48 — Retain Parent Locks for Child Sessions

**Status:** completed

## User outcome

As a workflow author, a parent invocation retains its workspace lock while any
child session is active.

## Scope

- Join child session lifetime to parent workspace admission.
- Release the lock only after parent and children terminate.

## Out of scope

- Unmanaged child sessions that the adapter cannot report.

## Implementation notes

Child completion updates the parent activity counter. Do not transfer the
workspace lock to a child as a separate resource owner.

## Acceptance criteria

**Scenario:** *A parent response ends before its child*

- **Given:** A parent exclusive invocation with an active child session
- **When:** The parent response completes
- **Then:** A competing workspace request remains waiting

## Source

- [ADR-020](../../ADR-020-invocation-admission-and-workspace-coordination.md)
- [TS-020](../../TS-020-invocation-admission-and-workspace-coordination.md)
